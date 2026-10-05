import Peer from '../../vendor/peerjs/peerjs-1.5.5.mjs';
import { loadConfig, peerOptions, setupSettings, updateFeatures, safeError, startPings } from './common.js';
import { parseShareLink, parseControlMessage, encodeControlMessage } from '../lib/validators.js';
import { fileId, parseManifest } from '../lib/manifest.js';
import { chunkSizeFor } from '../lib/chunk-size.js';
import { chunkFileOffset, chunkLength } from '../lib/offsets.js';
import { decodeFrame, FrameReassembler } from '../lib/frames.js';
import { encodeBitfield, decodeBitfield, HolderSet } from '../lib/bitfield.js';
import { RequestScheduler } from '../lib/request-scheduler.js';
import { OPFS_WRITE_QUEUE_LIMIT } from '../lib/byte-queue.js';
import { checkAvailableStorage as runStoragePreflight } from '../lib/storage-preflight.js';
import { clearWithFileLock } from '../lib/receiver-lock.js';
import { createDebugLogRing } from '../lib/debug-log.js';

const status = document.querySelector('#status');
const rtt = document.querySelector('#rtt');
const grid = document.querySelector('#chunk-grid');
const gridContext = grid.getContext('2d');
const transferProgress = document.querySelector('#transfer-progress');
const transferStats = document.querySelector('#transfer-stats');
const downloadButton = document.querySelector('#download-file');
const saveAsButton = document.querySelector('#save-as');
const verifyButton = document.querySelector('#verify-file');
const cancelVerifyButton = document.querySelector('#cancel-verify');
const offsetProbeButton = document.querySelector('#offset-probe');
const clearButton = document.querySelector('#clear-saved-data');
let peer, control, bulk, start, nextSeq = 0, pieces = [], byteLength = 0, expectedSession;
let manifestVerified = false, bitfieldSent = false, fileLockStarted = false, fileLockHeld = false;
let storageWorker, verifyWorker, link, verifiedManifest, scheduler, reassembler, holders;
let debugExpectedHash = null, transferStartedAt = 0, verifiedBytes = 0, receivedBytes = 0, peakInFlight = 0;
let chunkStates = [], drawPending = false, redFade = false, frameViolations = 0, havePending = new Set(), haveTimer;
let queueReservedBytes = 0, queueBytes = 0, maxInFlight = 8, requestCount = 0, hashStartedAt = 0, hashElapsedMs = 0;
let verifyStartedAt = 0, activeVerifyId, workerWaiters = new Map(), pendingWrites = new Map(), rateSamples = [];
let storageNote = '';
const debugLogRing = createDebugLogRing(500);
const OPFS_KEY = 'p2p-recv:';

function send(message) { if (control?.open) control.send(encodeControlMessage(message)); }
function safeDisplayName(name) { return name.replace(/[\0-\x1f\x7f\\/]/g, '�').slice(0, 255); }
function fail(message, { retainSaved = true } = {}) {
  status.dataset.failed = 'true'; status.textContent = message;
  if (retainSaved) storageWorker?.postMessage({ type: 'CLOSE_KEEP' });
  control?.close(); bulk?.close();
}
function workerCall(message, transfer = [], timeoutMs = 0) {
  const requestId = cryptoRandomHex();
  return new Promise((resolve, reject) => {
    let timer;
    if (timeoutMs) timer = setTimeout(() => { workerWaiters.delete(requestId); reject(new Error(`${message.type} timed out`)); }, timeoutMs);
    workerWaiters.set(requestId, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    storageWorker.postMessage({ ...message, requestId }, transfer);
  });
}

function updatePairedStatus() {
  if (manifestVerified && control?.open && bulk?.open) { status.textContent = 'Manifest verified; control and bulk channels paired.'; sendBitfieldAndStart(); }
  else if (manifestVerified) status.textContent = 'Manifest verified; finishing bulk-channel pairing.';
}
function updateMetrics() {
  status.dataset.verifiedBytes = String(verifiedBytes);
  status.dataset.requestCount = String(requestCount);
  status.dataset.inFlight = String(scheduler?.inFlight.size || 0);
  status.dataset.queueBytes = String(queueBytes);
  transferProgress.textContent = `${verifiedBytes} / ${verifiedManifest?.size || 0} bytes durable (${scheduler?.verified.size || 0}/${chunkStates.length} chunks); ${queueBytes} bytes queued to OPFS.`;
}

function queueDraw() { if (drawPending) return; drawPending = true; requestAnimationFrame(drawGrid); }
function drawGrid(now) {
  drawPending = false;
  const count = chunkStates.length; if (!count) return;
  const cells = Math.min(count, 4096), columns = Math.max(1, Math.floor(grid.width / 12)), cellHeight = 12, rows = Math.ceil(cells / columns);
  if (grid.height !== rows * cellHeight) grid.height = rows * cellHeight;
  gridContext.clearRect(0, 0, grid.width, grid.height); redFade = false;
  for (let cell = 0; cell < cells; cell++) {
    const from = Math.floor(cell * count / cells), to = Math.max(from + 1, Math.floor((cell + 1) * count / cells));
    let verified = 0, arriving = 0, progress = 0, failedAt = 0, missing = 0;
    for (let i = from; i < to; i++) {
      const s = chunkStates[i];
      if (s.kind === 'verified') verified++;
      else if (s.kind === 'arriving') { arriving++; progress += s.length ? s.received / s.length : 0; }
      else if (s.kind === 'failed' && now - s.at < 500) failedAt = Math.max(failedAt, s.at);
      else missing++;
    }
    const x = (cell % columns) * 12, y = Math.floor(cell / columns) * cellHeight;
    if (verified === to - from) gridContext.fillStyle = '#218739';
    else if (failedAt) { gridContext.fillStyle = `rgba(205,45,45,${Math.max(0, 1 - (now - failedAt) / 500)})`; redFade = true; }
    else if (arriving) gridContext.fillStyle = '#2878cc';
    else gridContext.fillStyle = '#c7cbd1';
    gridContext.fillRect(x, y, 10, 10);
    if (arriving) { gridContext.fillStyle = '#77b8f0'; gridContext.fillRect(x, y + 9, 10 * Math.min(1, progress / arriving), 1); }
    else if (verified > 0 && verified < to - from) { gridContext.fillStyle = '#218739'; gridContext.fillRect(x, y + 8, 10 * verified / (to - from), 2); }
  }
  updateMetrics(); updateSpeedStats();
  if (scheduler?.isComplete && manifestVerified) markComplete();
  else if (redFade) { drawPending = true; requestAnimationFrame(drawGrid); }
}
function updateSpeedStats() {
  const now = performance.now();
  rateSamples = rateSamples.filter(sample => now - sample.at <= 1000);
  const rate = rateSamples.reduce((sum, sample) => sum + sample.bytes, 0);
  const mib = rate / 1024 ** 2;
  const remaining = Math.max(0, verifiedManifest.size - verifiedBytes);
  transferStats.textContent = `${mib.toFixed(2)} MiB/s recent durable writes; ${remaining ? `${(remaining / Math.max(1, rate) / 60).toFixed(1)} min estimated` : 'all chunks durable'}. Hashing took ${(hashElapsedMs / 1000).toFixed(1)} s. ${storageNote}`;
}
function markComplete() {
  if (status.dataset.transferComplete === 'true') return;
  status.dataset.transferComplete = 'true';
  const elapsedMs = transferStartedAt ? Math.max(1, performance.now() - transferStartedAt) : 0;
  const mibPerSecond = elapsedMs ? (verifiedManifest.size / 1024 ** 2) / (elapsedMs / 1000) : 0;
  status.dataset.transferMs = String(Math.round(elapsedMs));
  status.dataset.peakInFlight = String(peakInFlight);
  status.textContent = 'Transfer complete; all chunks are durable in OPFS.';
  transferStats.textContent = `${mibPerSecond.toFixed(2)} MiB/s; ${elapsedMs.toFixed(0)} ms first REQUEST to last durable chunk; hashing ${(hashElapsedMs / 1000).toFixed(1)} s. ${storageNote}`;
  downloadButton.disabled = false; verifyButton.disabled = false;
}

function pumpRequests() {
  if (!scheduler || !control?.open || !bulk?.open || !manifestVerified || status.dataset.failed || status.dataset.transferComplete === 'true') return;
  while (scheduler.inFlight.size < maxInFlight && queueReservedBytes + verifiedManifest.chunkSize <= OPFS_WRITE_QUEUE_LIMIT) {
    const request = scheduler.next(); if (!request) break;
    const length = chunkLength(verifiedManifest.size, verifiedManifest.chunkSize, request.index);
    if (!reassembler.request(request.index, request.attempt, length)) { scheduler.fail(request.index, request.attempt); continue; }
    queueReservedBytes += length;
    if (!transferStartedAt) transferStartedAt = performance.now();
    requestCount++; peakInFlight = Math.max(peakInFlight, scheduler.inFlight.size);
    try { send({ type: 'REQUEST', index: request.index, attempt: request.attempt }); }
    catch (error) { queueReservedBytes -= length; scheduler.fail(request.index, request.attempt); reassembler.cancel(request.index, request.attempt); fail(safeError(error)); return; }
  }
  updateMetrics();
}
function releaseRequest(index) { const length = chunkLength(verifiedManifest.size, verifiedManifest.chunkSize, index); queueReservedBytes = Math.max(0, queueReservedBytes - length); }
function sendBitfieldAndStart() {
  if (!manifestVerified || !control?.open || !bulk?.open || bitfieldSent) return;
  bitfieldSent = true;
  send({ type: 'BITFIELD', hex: encodeBitfield(verifiedManifest.chunkCount, scheduler.verified) });
  pumpRequests();
}
function queueHave(index) {
  havePending.add(index); clearTimeout(haveTimer);
  haveTimer = setTimeout(() => {
    if (!havePending.size || !control?.open) return;
    const indices = [...havePending].slice(0, 1024); indices.forEach(i => havePending.delete(i)); send({ type: 'HAVE', indices });
  }, 100);
}
function retryChunk(index, attempt) {
  releaseRequest(index);
  const result = scheduler.fail(index, attempt);
  chunkStates[index] = { kind: 'failed', at: performance.now() }; queueDraw();
  if (result.status === 'failed') { fail(`Chunk ${index} failed after ${result.failures} verification attempts.`); return; }
  pumpRequests();
}
function onBulk(raw) {
  const decoded = decodeFrame(raw);
  if (!decoded.ok) { frameViolations++; if (frameViolations >= 3) fail(`Bulk protocol failed: ${decoded.error}`); return; }
  const frame = decoded.frame;
  if (!scheduler?.inFlight.has(frame.index) || scheduler.inFlight.get(frame.index).attempt !== frame.attempt) return;
  const result = reassembler.accept(raw);
  if (result.status === 'invalid') {
    frameViolations++; reassembler.cancel(frame.index, frame.attempt);
    if (frameViolations >= 3) fail(`Bulk protocol failed: ${result.error}`); else retryChunk(frame.index, frame.attempt); return;
  }
  if (result.status === 'stale') return;
  if (result.status === 'started') chunkStates[result.index] = { kind: 'arriving', received: 0, length: result.length };
  if (result.status === 'progress') chunkStates[result.index] = { kind: 'arriving', received: result.received, length: result.length };
  queueDraw();
  if (result.status === 'complete') {
    const expectedHash = Array.from(verifiedManifest.chunkHashes[result.index], b => b.toString(16).padStart(2, '0')).join('');
    verifyWorker.postMessage({ type: 'VERIFY_CHUNK', index: result.index, attempt: result.attempt, buffer: result.buffer.buffer, expectedHash }, [result.buffer.buffer]);
  }
}

function onHashMessage(event) {
  const result = event.data;
  if (!['CHUNK_HASH_OK', 'CHUNK_HASH_MISMATCH'].includes(result?.type) || scheduler?.inFlight.get(result.index)?.attempt !== result.attempt) return;
  if (result.type === 'CHUNK_HASH_MISMATCH') {
    if (new URL(location.href).searchParams.get('debug') === '1') console.warn('Chunk hash mismatch', { index: result.index, attempt: result.attempt, actual: result.actual, expected: result.expectedHash });
    retryChunk(result.index, result.attempt); return;
  }
  const requestKey = `${result.index}:${result.attempt}`;
  pendingWrites.set(requestKey, { index: result.index, attempt: result.attempt, buffer: result.buffer });
  postWrite(requestKey);
}
function postWrite(key) {
  const item = pendingWrites.get(key); if (!item || !storageWorker) return;
  pendingWrites.delete(key);
  storageWorker.postMessage({ type: 'WRITE_CHUNK', index: item.index, attempt: item.attempt, buffer: item.buffer }, [item.buffer]);
}

function onStorageMessage(event) {
  const message = event.data || {};
  if (message.requestId && workerWaiters.has(message.requestId)) {
    const waiter = workerWaiters.get(message.requestId); workerWaiters.delete(message.requestId);
    if (message.type.endsWith('_ERROR') || message.type === 'STORAGE_ERROR' || message.type === 'VERIFY_ERROR') waiter.reject(new Error(message.message || message.type));
    else waiter.resolve(message);
  }
  if (message.type === 'FILE_OPENED') onFileOpened(message);
  if (message.type === 'QUEUE_STATE') { queueBytes = message.queueBytes; updateMetrics(); }
  if (message.type === 'QUEUE_FULL') {
    queueBytes = message.queueBytes;
    const key = `${message.index}:${message.attempt}`;
    pendingWrites.set(key, { index: message.index, attempt: message.attempt, buffer: message.buffer });
    updateMetrics();
  }
  if (message.type === 'CHUNK_DURABLE') onChunkDurable(message);
  if (message.type === 'STORAGE_ERROR') {
    queueBytes = message.queueBytes || 0;
    fail(`Storage write failed${Number.isSafeInteger(message.index) ? ` on chunk ${message.index}` : ''}: ${safeError(message.message || message.name || 'OPFS error')}. Verified data and resume progress are retained; use Clear saved data if needed.`);
  }
  if (message.type === 'VERIFY_PROGRESS') document.querySelector('#verify-status').textContent = `Verifying saved chunks ${message.done}/${message.total}…`;
  if (message.type === 'VERIFY_COMPLETE') {
    const elapsed = performance.now() - verifyStartedAt; activeVerifyId = undefined;
    document.querySelector('#verify-status').textContent = `Whole-file chunk verification passed in ${(elapsed / 1000).toFixed(2)} s.`;
    cancelVerifyButton.hidden = true; verifyButton.disabled = false;
  }
  if (message.type === 'VERIFY_MISMATCH') {
    activeVerifyId = undefined; document.querySelector('#verify-status').textContent = `Saved chunk ${message.index} does not match the manifest.`;
    cancelVerifyButton.hidden = true; verifyButton.disabled = false;
  }
  if (message.type === 'VERIFY_CANCELLED') {
    activeVerifyId = undefined; document.querySelector('#verify-status').textContent = 'Whole-file verification cancelled.';
    cancelVerifyButton.hidden = true; verifyButton.disabled = false;
  }
  if (message.type === 'CLEAR_OK') { clearButton.disabled = false; clearButton.textContent = 'Clear saved data'; status.textContent = 'Saved data cleared.'; downloadButton.disabled = true; verifyButton.disabled = true; }
  if (message.type === 'CLEAR_ERROR' || message.type === 'DOWNLOAD_ERROR') status.textContent = safeError(message.message || message.type);
  if (message.type === 'OFFSET_PROBE_RESULT') status.dataset.offsetProbe = JSON.stringify(message);
  if (message.type === 'DEBUG_LOG') {
    debugLogRing.add(message.entry);
    if (new URL(location.href).searchParams.get('debug') === '1') console.debug('OPFS debug', message.entry);
  }
}
function onChunkDurable(message) {
  queueBytes = message.queueBytes; releaseRequest(message.index);
  const completed = scheduler.complete(message.index, message.attempt);
  if (completed.status !== 'verified') { updateMetrics(); return; }
  const index = message.index, length = chunkLength(verifiedManifest.size, verifiedManifest.chunkSize, index);
  chunkStates[index] = { kind: 'verified' }; verifiedBytes += length; holders.add([index]); queueHave(index);
  rateSamples.push({ at: performance.now(), bytes: length });
  queueDraw(); flushPendingWrites(); pumpRequests(); updateMetrics();
}
function flushPendingWrites() {
  for (const key of [...pendingWrites.keys()]) {
    if (queueBytes + pendingWrites.get(key).buffer.byteLength > OPFS_WRITE_QUEUE_LIMIT) break;
    postWrite(key);
  }
}

function startPeer() { if (link) startPeerAsync().catch(error => { status.textContent = safeError(error); }); }
async function startPeerAsync() {
  try {
    peer?.destroy(); control = bulk = undefined; expectedSession = undefined;
    const config = await loadConfig(); peer = new Peer(undefined, peerOptions(config.signaling, config.options));
    peer.on('open', () => {
      status.dataset.peerId = peer.id;
      control = peer.connect(link.room, { reliable: true, serialization: 'raw', metadata: { kind: 'control' } });
      control.on('open', () => { send({ type: 'HELLO', role: 'receiver', protocolVersion: 1 }); startPings(control, ms => { rtt.textContent = `${ms} ms`; }); status.textContent = 'Connected; waiting for sender HELLO.'; });
      control.on('data', raw => onControl(raw)); control.on('error', error => { status.textContent = safeError(error); });
      control.on('close', () => { if (!status.dataset.failed && status.dataset.transferComplete !== 'true') status.textContent = 'Sender disconnected.'; });
    });
    peer.on('connection', connection => {
      if (connection.metadata?.kind !== 'bulk' || connection.peer !== link.room || !expectedSession || connection.metadata?.sessionId !== expectedSession || bulk) { connection.close(); return; }
      pairBulk(connection);
    });
    peer.on('error', error => { status.textContent = safeError(error); if (error.type === 'network' || error.type === 'server-error') status.textContent += ' Check the signaling host and CSP allow-list.'; });
  } catch (error) { status.textContent = safeError(error); }
}
function pairBulk(connection) {
  bulk = connection; bulk.on('open', updatePairedStatus); bulk.on('data', onBulk);
  bulk.on('error', error => { status.textContent = safeError(error); });
  bulk.on('close', () => { if (manifestVerified && !status.dataset.failed && status.dataset.transferComplete !== 'true') status.textContent = 'Bulk channel disconnected.'; });
  updatePairedStatus(); sendBitfieldAndStart();
}

async function onControl(raw) {
  let message;
  try { message = parseControlMessage(raw); } catch (error) { fail(`Invalid control message: ${safeError(error)}`); return; }
  if (!expectedSession) {
    if (message.type !== 'HELLO' || message.role !== 'sender' || message.protocolVersion !== 1) { fail('Expected sender HELLO for protocol version 1.'); return; }
    expectedSession = message.sessionId; status.textContent = 'Sender verified; opening bulk channel.';
    pairBulk(peer.connect(link.room, { reliable: true, serialization: 'raw', metadata: { kind: 'bulk', sessionId: expectedSession } })); return;
  }
  if (message.type === 'PING') { send({ type: 'PONG', seq: message.seq }); return; }
  if (message.type === 'PONG') return;
  if (message.type === 'ERROR') { fail(`Sender error: ${message.message}`); return; }
  if (message.type === 'HELLO') { fail('Unexpected repeated or wrong-role HELLO.'); return; }
  if (message.type === 'HAVE') { for (const index of message.indices) { holders?.add([index]); scheduler?.addHolder(index); } pumpRequests(); return; }
  if (message.type === 'REJECT') {
    if (message.reason === 'NOT_HAVE') { holders?.remove(message.index); scheduler?.removeHolder(message.index); }
    if (scheduler?.inFlight.get(message.index)?.attempt === message.attempt) {
      reassembler?.cancel(message.index, message.attempt);
      if (message.reason === 'NOT_HAVE') { scheduler.markUnavailable(message.index, message.attempt); releaseRequest(message.index); chunkStates[message.index] = { kind: 'failed', at: performance.now() }; queueDraw(); fail(`Sender no longer has chunk ${message.index}.`); }
      else retryChunk(message.index, message.attempt);
    }
    return;
  }
  if (message.type === 'MANIFEST_START') { if (start || manifestVerified) { fail('Duplicate manifest start.'); return; } start = message; nextSeq = 0; pieces = []; byteLength = 0; return; }
  if (message.type === 'MANIFEST_DATA') {
    if (!start || manifestVerified || message.seq !== nextSeq || byteLength + message.data.length / 2 > start.manifestBytes) { fail('Invalid manifest sequence or size.'); return; }
    nextSeq++; byteLength += message.data.length / 2; pieces.push(message.data); return;
  }
  if (message.type === 'MANIFEST_END') {
    if (!start || manifestVerified || message.parts !== nextSeq || byteLength !== start.manifestBytes) { fail('Manifest size/sequence mismatch.'); return; }
    const bytes = new Uint8Array(byteLength); let offset = 0;
    for (const hex of pieces) for (let i = 0; i < hex.length; i += 2) bytes[offset++] = Number.parseInt(hex.slice(i, i + 2), 16);
    if (await fileId(bytes) !== link.fid || start.fileId !== link.fid) { fail('File info does not match the link.'); return; }
    let parsed;
    try { parsed = parseManifest(bytes); } catch (error) { fail(`Invalid manifest: ${safeError(error)}`); return; }
    if (parsed.protocolVersion !== 1 || parsed.chunkSize !== chunkSizeFor(parsed.size) || parsed.name !== start.name || parsed.size !== start.size || parsed.chunkSize !== start.chunkSize || parsed.chunkCount !== start.chunkCount) { fail('Manifest outer fields do not match canonical bytes.'); return; }
    await initializeStorageAfterManifest(parsed); return;
  }
  fail(`Unexpected ${message.type} from sender.`);
}

async function initializeStorageAfterManifest(parsed) {
  if (fileLockStarted) return; fileLockStarted = true; verifiedManifest = parsed;
  document.querySelector('#file-name').textContent = safeDisplayName(parsed.name); document.querySelector('#file-size').textContent = `${parsed.size} bytes`;
  status.dataset.manifestParts = String(nextSeq); status.dataset.manifestBytes = String(byteLength);
  navigator.locks.request(`${OPFS_KEY}${link.fid}`, { ifAvailable: true }, async lock => {
    if (!lock) { fail('This file is already open in another receiver tab.'); return; }
    fileLockHeld = true;
    try {
      const probeToken = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('');
      const probe = await workerCall({ type: 'PHASE2', token: probeToken }, [], 15000);
      if (!probe.ok) { fail(`Receiver storage is unsupported: ${safeError(probe.message || 'phase 2 probe failed')}`); return; }
      await workerCall({ type: 'PREPARE_FILE', fileId: link.fid }, [], 10000);
      clearButton.hidden = false;
      if (!await checkAvailableStorage(parsed.size)) return;
      const hashes = parsed.chunkHashes.map(hash => Array.from(hash, b => b.toString(16).padStart(2, '0')).join(''));
      const opened = await workerCall({ type: 'OPEN_FILE', fileId: link.fid, size: parsed.size, chunkSize: parsed.chunkSize, chunkCount: parsed.chunkCount, hashes }, [], 0);
      onFileOpened(opened);
      await new Promise(() => {});
    } catch (error) { fail(safeError(error)); }
    finally { fileLockHeld = false; }
  }).catch(error => { fileLockHeld = false; fail(safeError(error)); });
}

async function checkAvailableStorage(size) {
  const result = await runStoragePreflight(size, {
    estimate: () => {
      if (typeof navigator.storage.estimate !== 'function') throw new Error('Storage estimate API unavailable');
      return navigator.storage.estimate();
    },
    persist: () => navigator.storage.persist(), formatBytes,
  });
  if (result.quota !== null) {
    status.dataset.quota = String(result.quota); status.dataset.usage = String(result.usage);
    status.dataset.required = String(result.required); status.dataset.available = String(result.available);
    storageNote = `Origin storage available ${formatBytes(result.available)}; this transfer requires ${formatBytes(result.required)}. ${result.warning} Download needs roughly another ${formatBytes(size)} of free disk outside origin quota.`;
  } else {
    storageNote = `${result.warning} Download needs roughly another ${formatBytes(size)} of free disk outside origin quota.`;
    if (new URL(location.href).searchParams.get('debug') === '1') console.debug('Storage preflight estimate unavailable; proceeding', result.warning);
  }
  transferStats.textContent = storageNote;
  if (!result.ok) { fail(result.message); return false; }
  return true;
}

function onFileOpened(opened) {
  if (manifestVerified) return;
  const saved = decodeBitfield(verifiedManifest.chunkCount, bitmapToHex(opened.bitmap));
  holders = new HolderSet(verifiedManifest.chunkCount);
  holders.add(Array.from({ length: verifiedManifest.chunkCount }, (_, index) => index));
  scheduler = new RequestScheduler({ chunkCount: verifiedManifest.chunkCount, maxInFlight: Math.max(1, Math.min(8, Math.floor(OPFS_WRITE_QUEUE_LIMIT / verifiedManifest.chunkSize))), rng: cryptoRandom, clock: () => performance.now() });
  scheduler.replaceHolders(Array.from({ length: verifiedManifest.chunkCount }, (_, index) => index));
  for (const index of saved) scheduler.verified.add(index);
  reassembler = new FrameReassembler({ maxInFlight: scheduler.maxInFlight }); maxInFlight = scheduler.maxInFlight;
  chunkStates = Array.from({ length: verifiedManifest.chunkCount }, (_, index) => saved.includes(index) ? { kind: 'verified' } : { kind: 'missing' });
  verifiedBytes = saved.reduce((sum, index) => sum + chunkLength(verifiedManifest.size, verifiedManifest.chunkSize, index), 0);
  queueBytes = opened.queueBytes || 0; manifestVerified = true;
  document.querySelector('#save-as').hidden = typeof showSaveFilePicker !== 'function';
  offsetProbeButton.hidden = new URL(location.href).searchParams.get('debug') !== '1';
  downloadButton.disabled = false; verifyButton.disabled = !scheduler.isComplete;
  status.dataset.resumedChunks = String(saved.length); status.dataset.missingChunks = String(verifiedManifest.chunkCount - saved.length);
  status.dataset.requestCount = '0'; status.textContent = saved.length === verifiedManifest.chunkCount ? 'Saved file is complete; all chunks revalidated from OPFS.' : `OPFS ready; resuming with ${saved.length} verified chunks.`;
  updatePairedStatus(); sendBitfieldAndStart(); queueDraw(); updateMetrics();
}
function bitmapToHex(bitmap) { return Array.from(bitmap, byte => byte.toString(16).padStart(2, '0')).join(''); }

function onWorkerError(event) { fail(`OPFS worker failed: ${safeError(event.message || event.type)}. Existing verified progress is retained.`); }
async function probeStorageFeature() {
  storageWorker = new Worker('./src/workers/opfs-worker.js', { type: 'module' }); storageWorker.addEventListener('message', onStorageMessage); storageWorker.addEventListener('error', onWorkerError);
  verifyWorker = new Worker('./src/workers/hash-worker.js', { type: 'module' }); verifyWorker.addEventListener('message', onHashMessage);
  const phase1 = await new Promise(resolve => {
    const timer = setTimeout(() => resolve({ ok: false, message: 'Storage phase 1 probe timed out.' }), 10000);
    const listener = event => { if (event.data?.type !== 'PHASE1_RESULT') return; clearTimeout(timer); storageWorker.removeEventListener('message', listener); resolve(event.data); };
    storageWorker.addEventListener('message', listener); storageWorker.postMessage({ type: 'PHASE1' });
  });
  if (!phase1.ok) { status.textContent = `Unsupported browser; OPFS sync access handles are required. ${safeError(phase1.message || '')}`; return false; }
  return true;
}

function startVerify() {
  if (!manifestVerified || activeVerifyId) return;
  activeVerifyId = cryptoRandomHex(); verifyStartedAt = performance.now(); verifyButton.disabled = true; cancelVerifyButton.hidden = false;
  document.querySelector('#verify-status').textContent = 'Verifying saved file…';
  storageWorker.postMessage({ type: 'VERIFY_ALL', requestId: activeVerifyId });
}
function cancelVerify() { if (activeVerifyId) storageWorker.postMessage({ type: 'CANCEL_VERIFY', requestId: activeVerifyId }); }
async function downloadFile() {
  try {
    const result = await workerCall({ type: 'DOWNLOAD_FILE' }, [], 30000), file = result.file;
    const url = URL.createObjectURL(file), anchor = document.createElement('a');
    anchor.href = url; anchor.download = verifiedManifest.name; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    transferStats.textContent = `Download started (${formatBytes(file.size)}); this copy needs additional free disk.`;
  } catch (error) { status.textContent = `Download failed: ${safeError(error)}`; }
}
async function saveAsFile() {
  let writable;
  try {
    const destination = await showSaveFilePicker({ suggestedName: verifiedManifest.name });
    writable = await destination.createWritable();
    const result = await workerCall({ type: 'DOWNLOAD_FILE' }, [], 30000), file = result.file;
    let written = 0;
    const progress = new TransformStream({ transform(chunk, controller) { written += chunk.byteLength; transferStats.textContent = `Saving ${written} / ${file.size} bytes…`; controller.enqueue(chunk); } });
    await file.stream().pipeThrough(progress).pipeTo(writable);
    transferStats.textContent = `Saved ${formatBytes(written)} to the selected file.`;
  } catch (error) {
    try { await writable?.abort(); } catch { /* preserve original error */ }
    if (error?.name !== 'AbortError') status.textContent = `Save As failed: ${safeError(error)}`;
  }
}
async function runOffsetProbe() {
  offsetProbeButton.disabled = true;
  try {
    const result = await workerCall({ type: 'DEBUG_OFFSET_PROBE' }, [], 120000);
    status.dataset.offsetProbe = JSON.stringify(result);
    document.querySelector('#verify-status').textContent = result.ok ? `OPFS offset probe passed at ${result.offset} bytes.` : `OPFS offset probe failed: ${safeError(result.error || 'readback mismatch')}`;
  } catch (error) { document.querySelector('#verify-status').textContent = `OPFS offset probe failed: ${safeError(error)}`; }
  finally { offsetProbeButton.disabled = false; }
}
async function clearSavedData() {
  if (!confirm('Delete this file and its resume progress from this browser?')) return;
  clearButton.disabled = true; clearButton.textContent = 'Clearing…';
  try {
    const cleared = await clearWithFileLock({
      lockHeld: fileLockHeld,
      requestLock: callback => navigator.locks.request(`${OPFS_KEY}${link.fid}`, { ifAvailable: true }, callback),
      clear: () => workerCall({ type: 'CLEAR' }, [], 30000),
    });
    if (!cleared) { clearButton.disabled = false; clearButton.textContent = 'Clear saved data'; status.textContent = 'Could not acquire the file lock; saved data was not cleared.'; }
  } catch (error) { clearButton.disabled = false; clearButton.textContent = 'Clear saved data'; status.textContent = safeError(error); }
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return 'unknown';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']; let amount = value, unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++; }
  return `${amount.toFixed(1)} ${units[unit]}`;
}
function cryptoRandomHex() { return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''); }
function createCryptoRandom() {
  return { integer(n) { const range = 4294967296, limit = range - (range % n), words = new Uint32Array(1); do { crypto.getRandomValues(words); } while (words[0] >= limit); return words[0] % n; } };
}
const cryptoRandom = createCryptoRandom();

downloadButton.addEventListener('click', downloadFile); saveAsButton.addEventListener('click', saveAsFile); offsetProbeButton.addEventListener('click', runOffsetProbe);
clearButton.addEventListener('click', clearSavedData);
verifyButton.addEventListener('click', startVerify); cancelVerifyButton.addEventListener('click', cancelVerify); clearButton.addEventListener('click', clearSavedData);
try {
  const url = new URL(location.href);
  if ((url.hostname === 'localhost' || url.hostname === '127.0.0.1') && url.searchParams.get('debug') === '1') {
    const expected = url.searchParams.get('debugSha256'); if (expected && /^[a-f0-9]{64}$/.test(expected)) debugExpectedHash = expected;
    url.searchParams.delete('debug'); url.searchParams.delete('debugSha256'); link = parseShareLink(url.href);
  } else link = parseShareLink(location.href);
  document.querySelector('#room').textContent = link.room;
  if (updateFeatures()) probeStorageFeature().then(ok => { if (ok) { status.textContent = 'Storage features available; connecting…'; startPeer(); } });
} catch (error) { status.textContent = `Invalid share link: ${safeError(error)}`; }
setupSettings(startPeer);
