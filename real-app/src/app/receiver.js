import Peer from '../../vendor/peerjs/peerjs-1.5.5.mjs';
import { loadConfig, peerOptions, setupSettings, updateFeatures, safeError, startPings } from './common.js';
import { parseShareLink, parseControlMessage, encodeControlMessage } from '../lib/validators.js';
import { fileId, parseManifest } from '../lib/manifest.js';
import { chunkSizeFor } from '../lib/chunk-size.js';
import { chunkFileOffset, chunkLength } from '../lib/offsets.js';
import { decodeFrame, FrameReassembler } from '../lib/frames.js';
import { decodeBitfield, HolderSet } from '../lib/bitfield.js';
import { RequestScheduler } from '../lib/request-scheduler.js';
import { createMemorySink } from '../test-only/memory-sink.js';

const status = document.querySelector('#status');
const rtt = document.querySelector('#rtt');
const grid = document.querySelector('#chunk-grid');
const gridContext = grid.getContext('2d');
const transferProgress = document.querySelector('#transfer-progress');
const transferStats = document.querySelector('#transfer-stats');
let peer, control, bulk, start, nextSeq = 0, pieces = [], byteLength = 0, expectedSession;
let manifestVerified = false, bitfieldSent = false;
let storageWorker, verifyWorker, fileLockStarted = false, link, verifiedManifest, sink, scheduler, reassembler;
let debugExpectedHash = null, transferStartedAt = 0, verifiedBytes = 0, receivedBytes = 0, peakInFlight = 0;
let chunkStates = [], drawPending = false, redFade = false, frameViolations = 0, havePending = new Set(), haveTimer;
let holders;

function send(message) { if (control?.open) control.send(encodeControlMessage(message)); }
function safeDisplayName(name) { return name.replace(/[\0-\x1f\x7f\\/]/g, '�').slice(0, 255); }
function updatePairedStatus() {
  if (manifestVerified && control?.open && bulk?.open) { status.textContent = 'Manifest verified; control and bulk channels paired.'; sendBitfieldAndStart(); }
  else if (manifestVerified) status.textContent = 'Manifest verified; finishing bulk-channel pairing.';
}
function fail(message) { status.dataset.failed = 'true'; status.textContent = message; control?.close(); bulk?.close(); }

function queueDraw() {
  if (drawPending) return;
  drawPending = true;
  requestAnimationFrame(drawGrid);
}
function drawGrid(now) {
  drawPending = false;
  const count = chunkStates.length;
  if (!count) return;
  const cellWidth = 12, cellHeight = 12, columns = Math.max(1, Math.floor(grid.width / cellWidth));
  const rows = Math.ceil(count / columns);
  if (grid.height !== rows * cellHeight) grid.height = rows * cellHeight;
  gridContext.clearRect(0, 0, grid.width, grid.height);
  redFade = false;
  for (let index = 0; index < count; index++) {
    const x = (index % columns) * cellWidth, y = Math.floor(index / columns) * cellHeight;
    const state = chunkStates[index];
    if (state.kind === 'verified') gridContext.fillStyle = '#218739';
    else if (state.kind === 'arriving') gridContext.fillStyle = '#2878cc';
    else if (state.kind === 'failed' && now - state.at < 500) {
      gridContext.fillStyle = `rgba(205,45,45,${Math.max(0, 1 - (now - state.at) / 500)})`; redFade = true;
    } else gridContext.fillStyle = '#c7cbd1';
    gridContext.fillRect(x, y, cellWidth - 2, cellHeight - 2);
    if (state.kind === 'arriving') {
      gridContext.fillStyle = '#77b8f0';
      gridContext.fillRect(x, y + cellHeight - 3, (cellWidth - 2) * Math.min(1, state.received / state.length), 1);
    }
  }
  transferProgress.textContent = `${verifiedBytes} / ${verifiedManifest?.size || 0} bytes verified (${sink?.verifiedCount() || 0}/${chunkStates.length} chunks)`;
  if (sink && scheduler?.isComplete) finishTransfer().catch(e => fail(safeError(e)));
  else if (redFade) { drawPending = true; requestAnimationFrame(drawGrid); }
}

async function finishTransfer() {
  if (status.dataset.transferComplete === 'true') return;
  status.dataset.transferComplete = 'hashing';
  const actual = await fileId(sink.view());
  const elapsedMs = Math.max(1, performance.now() - transferStartedAt);
  const matches = debugExpectedHash ? actual === debugExpectedHash : true;
  const mibPerSecond = (verifiedManifest.size / 1024 ** 2) / (elapsedMs / 1000);
  transferStats.textContent = `SHA-256 ${actual}${debugExpectedHash ? (matches ? ' — expected hash matches' : ' — EXPECTED HASH MISMATCH') : ''}. ${mibPerSecond.toFixed(2)} MiB/s; ${elapsedMs.toFixed(0)} ms; peak ${peakInFlight}/8 chunks in flight.`;
  status.dataset.transferComplete = String(matches);
  status.dataset.transferMs = String(Math.round(elapsedMs));
  status.dataset.peakInFlight = String(peakInFlight);
  status.dataset.sha256 = actual;
  status.textContent = matches ? 'Transfer complete; file SHA-256 verified.' : 'Transfer failed: full-file SHA-256 did not match expected value.';
  if (!matches) status.dataset.transferComplete = 'false';
}

function sendBitfieldAndStart() {
  if (!manifestVerified || !control?.open || !bulk?.open || bitfieldSent) return;
  bitfieldSent = true;
  send({ type: 'BITFIELD', hex: '00'.repeat(Math.ceil(verifiedManifest.chunkCount / 8)) });
  pumpRequests();
}
function pumpRequests() {
  if (!scheduler || !control?.open || !bulk?.open || status.dataset.transferComplete === 'true' || status.dataset.transferComplete === 'hashing') return;
  while (scheduler.inFlight.size < 8) {
    const request = scheduler.next();
    if (!request) break;
    const length = chunkLength(verifiedManifest.size, verifiedManifest.chunkSize, request.index);
    if (!reassembler.request(request.index, request.attempt, length)) { scheduler.fail(request.index, request.attempt); continue; }
    if (!transferStartedAt) transferStartedAt = performance.now();
    peakInFlight = Math.max(peakInFlight, scheduler.inFlight.size);
    try { send({ type: 'REQUEST', index: request.index, attempt: request.attempt }); }
    catch (e) { scheduler.fail(request.index, request.attempt); reassembler.cancel(request.index, request.attempt); fail(safeError(e)); return; }
  }
}
function queueHave(index) {
  havePending.add(index);
  clearTimeout(haveTimer);
  haveTimer = setTimeout(() => {
    if (!havePending.size || !control?.open) return;
    const indices = [...havePending].slice(0, 1024); indices.forEach(i => havePending.delete(i));
    send({ type: 'HAVE', indices });
  }, 100);
}
function requestRetry(index, attempt) {
  const result = scheduler.fail(index, attempt);
  chunkStates[index] = { kind: 'failed', at: performance.now() };
  queueDraw();
  if (result.status === 'failed') { fail(`Chunk ${index} failed after ${result.failures} hash attempts.`); return; }
  pumpRequests();
}
function onBulk(raw) {
  const decoded = decodeFrame(raw);
  if (!decoded.ok) {
    frameViolations++;
    if (frameViolations >= 3) fail(`Bulk protocol failed: ${decoded.error}`);
    return;
  }
  const frame = decoded.frame;
  if (!scheduler?.inFlight.has(frame.index) || scheduler.inFlight.get(frame.index).attempt !== frame.attempt) return;
  const result = reassembler.accept(raw);
  if (result.status === 'invalid') {
    frameViolations++;
    reassembler.cancel(frame.index, frame.attempt);
    if (frameViolations >= 3) fail(`Bulk protocol failed: ${result.error}`);
    else requestRetry(frame.index, frame.attempt);
    return;
  }
  if (result.status === 'stale') return;
  if (result.status === 'started') chunkStates[result.index] = { kind: 'arriving', received: 0, length: result.length };
  if (result.status === 'progress') {
    chunkStates[result.index] = { kind: 'arriving', received: result.received, length: result.length };
    receivedBytes += result.received;
  }
  queueDraw();
  if (result.status === 'complete') {
    const expectedHash = Array.from(verifiedManifest.chunkHashes[result.index], b => b.toString(16).padStart(2, '0')).join('');
    verifyWorker.postMessage({ type: 'VERIFY_CHUNK', index: result.index, attempt: result.attempt, buffer: result.buffer.buffer, expectedHash }, [result.buffer.buffer]);
  }
}

function startPeer() {
  if (!link) return;
  startPeerAsync().catch(e => { status.textContent = safeError(e); });
}
async function startPeerAsync() {
  try {
    peer?.destroy(); control = bulk = undefined; expectedSession = undefined;
    const cfg = await loadConfig();
    peer = new Peer(undefined, peerOptions(cfg.signaling, cfg.options));
    peer.on('open', () => {
      control = peer.connect(link.room, { reliable: true, serialization: 'raw', metadata: { kind: 'control' } });
      control.on('open', () => {
        send({ type: 'HELLO', role: 'receiver', protocolVersion: 1 });
        startPings(control, ms => { rtt.textContent = `${ms} ms`; });
        status.textContent = 'Connected; waiting for sender HELLO.';
      });
      control.on('data', raw => onControl(raw));
      control.on('error', e => { status.textContent = safeError(e); });
      control.on('close', () => { if (!status.dataset.failed && status.dataset.transferComplete !== 'true') status.textContent = 'Sender disconnected.'; });
    });
    peer.on('connection', c => {
      if (c.metadata?.kind !== 'bulk' || c.peer !== link.room || !expectedSession || c.metadata?.sessionId !== expectedSession || bulk) { c.close(); return; }
      pairBulk(c);
    });
    peer.on('error', e => {
      status.textContent = safeError(e);
      if (e.type === 'network' || e.type === 'server-error') status.textContent += ' Check the signaling host and CSP allow-list.';
    });
  } catch (e) { status.textContent = safeError(e); }
}
function pairBulk(connection) {
  bulk = connection;
  bulk.on('open', updatePairedStatus);
  bulk.on('data', onBulk);
  bulk.on('error', e => { status.textContent = safeError(e); });
  bulk.on('close', () => { if (manifestVerified && status.dataset.transferComplete !== 'true') status.textContent = 'Bulk channel disconnected.'; });
  updatePairedStatus(); sendBitfieldAndStart();
}

async function onControl(raw) {
  let message;
  try { message = parseControlMessage(raw); }
  catch (e) { fail(`Invalid control message: ${safeError(e)}`); return; }
  if (!expectedSession) {
    if (message.type !== 'HELLO' || message.role !== 'sender' || message.protocolVersion !== 1) { fail('Expected sender HELLO for protocol version 1.'); return; }
    expectedSession = message.sessionId;
    status.textContent = 'Sender verified; opening bulk channel.';
    pairBulk(peer.connect(link.room, { reliable: true, serialization: 'raw', metadata: { kind: 'bulk', sessionId: expectedSession } }));
    return;
  }
  if (message.type === 'PING') { send({ type: 'PONG', seq: message.seq }); return; }
  if (message.type === 'PONG') return;
  if (message.type === 'ERROR') { fail(`Sender error: ${message.message}`); return; }
  if (message.type === 'HELLO') { fail('Unexpected repeated or wrong-role HELLO.'); return; }
  if (message.type === 'HAVE') { for (const index of message.indices) { holders.add(index); scheduler?.addHolder(index); } pumpRequests(); return; }
  if (message.type === 'REJECT') {
    if (message.reason === 'NOT_HAVE') { holders.remove(message.index); scheduler?.removeHolder(message.index); }
    if (scheduler?.inFlight.get(message.index)?.attempt === message.attempt) {
      reassembler?.cancel(message.index, message.attempt);
      if (message.reason === 'NOT_HAVE') {
        scheduler.markUnavailable(message.index, message.attempt);
        chunkStates[message.index] = { kind: 'failed', at: performance.now() }; queueDraw();
        fail(`Sender no longer has chunk ${message.index}.`);
      }
      else requestRetry(message.index, message.attempt);
    }
    return;
  }
  if (message.type === 'MANIFEST_START') {
    if (start || manifestVerified) { fail('Duplicate manifest start.'); return; }
    start = message; nextSeq = 0; pieces = []; byteLength = 0; return;
  }
  if (message.type === 'MANIFEST_DATA') {
    if (!start || manifestVerified || message.seq !== nextSeq || byteLength + message.data.length / 2 > start.manifestBytes) { fail('Invalid manifest sequence or size.'); return; }
    nextSeq++; byteLength += message.data.length / 2; pieces.push(message.data); return;
  }
  if (message.type === 'MANIFEST_END') {
    if (!start || manifestVerified || message.parts !== nextSeq || byteLength !== start.manifestBytes) { fail('Manifest size/sequence mismatch.'); return; }
    const bytes = new Uint8Array(byteLength); let p = 0;
    for (const hex of pieces) for (let i = 0; i < hex.length; i += 2) bytes[p++] = Number.parseInt(hex.slice(i, i + 2), 16);
    if (await fileId(bytes) !== link.fid || start.fileId !== link.fid) { fail('File info does not match the link.'); return; }
    let parsed;
    try { parsed = parseManifest(bytes); } catch (e) { fail(`Invalid manifest: ${safeError(e)}`); return; }
    if (parsed.protocolVersion !== 1 || parsed.chunkSize !== chunkSizeFor(parsed.size) || parsed.name !== start.name || parsed.size !== start.size || parsed.chunkSize !== start.chunkSize || parsed.chunkCount !== start.chunkCount) { fail('Manifest outer fields do not match canonical bytes.'); return; }
    await initializeStorageAfterManifest(parsed);
    return;
  }
  fail(`Unexpected ${message.type} from sender.`);
}

function sendInitialBitfieldAndRequests(parsed) {
  sink = createMemorySink(parsed.size);
  verifiedManifest = parsed;
  scheduler = new RequestScheduler({ chunkCount: parsed.chunkCount, maxInFlight: 8, rng: cryptoRandom, clock: () => performance.now() });
  scheduler.replaceHolders(Array.from({ length: parsed.chunkCount }, (_, i) => i));
  reassembler = new FrameReassembler({ maxInFlight: 8 });
  holders = new HolderSet(parsed.chunkCount);
  chunkStates = Array.from({ length: parsed.chunkCount }, () => ({ kind: 'missing' }));
  holders.add(Array.from({ length: parsed.chunkCount }, (_, i) => i));
  manifestVerified = true;
  document.querySelector('#file-name').textContent = safeDisplayName(parsed.name);
  document.querySelector('#file-size').textContent = `${parsed.size} bytes`;
  status.dataset.manifestParts = String(nextSeq); status.dataset.manifestBytes = String(byteLength);
  updatePairedStatus(); sendBitfieldAndStart(); queueDraw();
}

function onVerifiedChunk(event) {
  const result = event.data;
  if (!['CHUNK_HASH_OK', 'CHUNK_HASH_MISMATCH'].includes(result?.type) || scheduler?.inFlight.get(result.index)?.attempt !== result.attempt) return;
  if (result.type === 'CHUNK_HASH_MISMATCH') { requestRetry(result.index, result.attempt); return; }
  const bytes = new Uint8Array(result.buffer);
  sink.write(result.index, chunkFileOffset(result.index, verifiedManifest.chunkSize), bytes);
  scheduler.complete(result.index, result.attempt);
  chunkStates[result.index] = { kind: 'verified' };
  verifiedBytes += bytes.byteLength; holders.add([result.index]); queueHave(result.index); queueDraw(); pumpRequests();
}

function initializeStorageAfterManifest(parsed) {
  if (fileLockStarted) return;
  fileLockStarted = true;
  if (parsed.size > 64 * 1024 ** 2) { fail('S2 in-memory receiver sink is limited to 64 MiB.'); return; }
  navigator.locks.request(`p2p-file:${link.fid}`, { ifAvailable: true }, async lock => {
    if (!lock) { fail('This file is already open in another receiver tab.'); return; }
    const result = await new Promise(resolve => {
      const timer = setTimeout(() => resolve({ ok: false, error: 'Storage feature probe timed out.' }), 10000);
      const listener = event => { if (event.data?.type !== 'PHASE2_RESULT') return; clearTimeout(timer); storageWorker.removeEventListener('message', listener); resolve(event.data); };
      storageWorker.addEventListener('message', listener);
      storageWorker.postMessage({ type: 'PHASE2', token: crypto.getRandomValues(new Uint8Array(8)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '') });
    });
    if (!result.ok) { fail(`Receiver storage is unsupported: ${safeError(result.error || 'probe failed')}`); return; }
    try { sendInitialBitfieldAndRequests(parsed); } catch (e) { fail(`Cannot initialize receiver sink: ${safeError(e)}`); return; }
    await new Promise(() => {});
  }).catch(e => fail(safeError(e)));
}

function createCryptoRandom() {
  return { integer(n) {
    const range = 4294967296, limit = range - (range % n), words = new Uint32Array(1);
    do { crypto.getRandomValues(words); } while (words[0] >= limit);
    return words[0] % n;
  } };
}
const cryptoRandom = createCryptoRandom();

async function probeStorageFeature() {
  storageWorker = new Worker('./src/workers/opfs-worker.js', { type: 'module' });
  verifyWorker = new Worker('./src/workers/hash-worker.js', { type: 'module' });
  verifyWorker.addEventListener('message', onVerifiedChunk);
  const phase1 = await new Promise(resolve => {
    const timer = setTimeout(() => resolve({ ok: false, error: 'Storage feature probe timed out.' }), 10000);
    const listener = event => { if (event.data?.type !== 'PHASE1_RESULT') return; clearTimeout(timer); storageWorker.removeEventListener('message', listener); resolve(event.data); };
    storageWorker.addEventListener('message', listener); storageWorker.postMessage({ type: 'PHASE1' });
  });
  if (!phase1.ok) { status.textContent = `Unsupported browser; OPFS sync access handles are required. ${safeError(phase1.error || '')}`; return false; }
  return true;
}

try {
  const url = new URL(location.href);
  if ((url.hostname === 'localhost' || url.hostname === '127.0.0.1') && url.searchParams.get('debug') === '1') {
    const expected = url.searchParams.get('debugSha256');
    if (expected && /^[a-f0-9]{64}$/.test(expected)) debugExpectedHash = expected;
    url.searchParams.delete('debug'); url.searchParams.delete('debugSha256');
    link = parseShareLink(url.href);
  } else link = parseShareLink(location.href);
  document.querySelector('#room').textContent = link.room;
  if (updateFeatures()) probeStorageFeature().then(ok => { if (ok) { status.textContent = 'Storage features available; connecting…'; startPeer(); } });
} catch (e) { status.textContent = `Invalid share link: ${safeError(e)}`; }
setupSettings(startPeer);
