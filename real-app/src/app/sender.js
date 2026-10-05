import Peer from '../../vendor/peerjs/peerjs-1.5.5.mjs';
import { loadConfig, peerOptions, senderId, setupSettings, updateFeatures, safeError, startPings } from './common.js';
import { random } from '../lib/random.js';
import { encodeControlMessage, parseControlMessage } from '../lib/validators.js';
import { encodeFrame, CHUNK_START, CHUNK_DATA, CHUNK_END, FRAME_HEADER_BYTES, MAX_FRAME_PAYLOAD_BYTES } from '../lib/frames.js';
import { chunkFileOffset, chunkLength } from '../lib/offsets.js';
import { ByteBudget } from '../lib/byte-budget.js';
import { RequestLedger } from '../lib/request-scheduler.js';
import { TokenBucket } from '../lib/token-bucket.js';
import { admitReceiver, MAX_RECEIVERS } from '../lib/receiver-admission.js';
import { RoundRobinCursor } from '../lib/round-robin.js';
import { SpeedWindow } from '../lib/speed-window.js';

const status = document.querySelector('#status');
const fileInput = document.querySelector('#file');
const shareSection = document.querySelector('#share-link');
const shareUrl = document.querySelector('#share-url');
const fidLabel = document.querySelector('#file-id');
const peersLabel = document.querySelector('#peers');
let peer, currentFile, manifest, fileId, metadata, lockStarted = false, lockAcquired = false;
let unavailableRetries = 0, retryTimer;
const sessions = new Map(), pendingBulk = new Map();
const receiverRows = new Map(), frameCursor = new RoundRobinCursor();
const budget = new ByteBudget();
const requestStates = new Map();
let pumping = false, debug = new URL(location.href).searchParams.has('debug');
let uploadBucket, tokenWakeTimer;
let drawReceiversPending = false;

function send(control, message) { if (control.open) control.send(encodeControlMessage(message)); }
function setStatus(message) { status.textContent = message; }
function sendError(session, code, message) { send(session.control, { type: 'ERROR', code, message }); }
function stopPeer() {
  clearTimeout(retryTimer);
  for (const session of sessions.values()) { session.control.close(); session.bulk?.close(); budget.disconnect(session.peerId); }
  sessions.clear(); pendingBulk.clear(); requestStates.clear();
  try { peer?.destroy(); } catch { /* already destroyed */ }
  peer = undefined;
}
function publishLink() {
  if (!manifest || !fileId || !peer?.id) return;
  const url = new URL('./receiver.html', location.href);
  url.searchParams.set('room', peer.id); url.searchParams.set('fid', fileId);
  shareUrl.value = url.href; shareSection.hidden = false;
}
function renderPeers() {
  document.querySelector('#byte-counts').textContent = String(countedBytes());
  if (!receiverRows.size) { peersLabel.textContent = 'No receivers connected.'; return; }
  for (const session of sessions.values()) {
    const row = receiverRows.get(session.peerId); if (!row) continue;
    const have = session.receiverHave || new Set(), completed = have.size;
    const percent = metadata?.chunkCount ? completed * 100 / metadata.chunkCount : 0;
    row.percent.textContent = `${percent.toFixed(1)}% (${completed}/${metadata?.chunkCount || 0} chunks)`;
    row.speed.textContent = `${(session.speed.bytesPerSecond() / 1024 ** 2).toFixed(2)} MiB/s`;
    row.paths.textContent = `control ${session.controlPath || 'unknown'}; bulk ${session.bulkPath || 'waiting'}`;
    row.activity.textContent = `${session.bulk?.open ? 'paired' : 'waiting for bulk'}; ${session.activeSends.size} active sends; ${session.requestCount} REQUESTs served`;
    row.error.textContent = session.error || '';
    row.root.classList.remove('disconnected');
  }
  queueReceiverDraw();
}
function ensureReceiverRow(peerId) {
  let row = receiverRows.get(peerId); if (row) return row;
  const root = document.createElement('article'); root.className = 'receiver-row';
  const title = document.createElement('h3'), id = document.createElement('code'), meta = document.createElement('div'); meta.className = 'receiver-meta';
  const percent = document.createElement('output'), speed = document.createElement('output'), paths = document.createElement('span'), activity = document.createElement('span'), error = document.createElement('span'); error.className = 'receiver-error';
  const canvas = document.createElement('canvas'); canvas.className = 'receiver-grid'; canvas.width = 1000; canvas.height = 12;
  title.textContent = 'Receiver '; id.textContent = peerId; title.append(id);
  for (const el of [percent, speed, paths, activity]) meta.append(el);
  root.append(title, meta, canvas, error); if (!receiverRows.size) peersLabel.replaceChildren(); peersLabel.append(root);
  row = { root, canvas, context: canvas.getContext('2d'), percent, speed, paths, activity, error };
  receiverRows.set(peerId, row); return row;
}
function queueReceiverDraw() {
  if (drawReceiversPending) return; drawReceiversPending = true;
  requestAnimationFrame(() => { drawReceiversPending = false; for (const session of sessions.values()) drawReceiverGrid(session); });
}
function drawReceiverGrid(session) {
  const row = receiverRows.get(session.peerId), count = metadata?.chunkCount || 0; if (!row || !count) return;
  const cells = Math.min(count, row.canvas.width), have = session.receiverHave || new Set(), width = row.canvas.width / cells;
  row.context.clearRect(0, 0, row.canvas.width, row.canvas.height);
  for (let cell = 0; cell < cells; cell++) {
    const from = Math.floor(cell * count / cells), to = Math.max(from + 1, Math.floor((cell + 1) * count / cells));
    let verified = 0; for (let index = from; index < to; index++) if (have.has(index)) verified++;
    row.context.fillStyle = verified === to - from ? '#218739' : verified ? '#6eaa7a' : '#c7cbd1';
    row.context.fillRect(cell * width, 0, Math.max(1, width - .5), row.canvas.height);
  }
}
function updatePath(session, kind, connection) {
  const pc = connection?.peerConnection; if (!pc) return;
  const assign = async () => {
    try {
      const stats = await pc.getStats(); let pair;
      for (const stat of stats.values()) {
        if (stat.type === 'candidate-pair' && (stat.selected || stat.nominated && stat.state === 'succeeded')) { pair = stat; break; }
        if (stat.type === 'transport' && stat.selectedCandidatePairId) pair = stats.get(stat.selectedCandidatePairId);
      }
      if (!pair) return;
      const local = stats.get(pair.localCandidateId), remote = stats.get(pair.remoteCandidateId);
      session[`${kind}Path`] = local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'relayed' : 'direct'; renderPeers();
    } catch { /* diagnostic only */ }
  };
  pc.addEventListener('iceconnectionstatechange', assign); pc.addEventListener('connectionstatechange', assign); void assign();
}
function countedBytes() { const m = bufferedMetrics(); return budget.countedBytes(m.global); }
function bufferedMetrics() {
  const byPeer = new Map(); let global = 0;
  for (const session of sessions.values()) {
    const amount = session.bulk?.dataChannel?.bufferedAmount || 0;
    global += amount; byPeer.set(session.peerId, amount);
  }
  return { global, byPeer };
}
async function createPeer() {
  stopPeer();
  setStatus('Connecting to signaling server…');
  const cfg = await loadConfig();
  const id = await senderId();
  peer = new Peer(id, peerOptions(cfg.signaling, cfg.options));
  peer.on('open', () => { unavailableRetries = 0; setStatus(currentFile ? 'Sender ready; file is available.' : 'Ready. Select a file to share.'); publishLink(); });
  peer.on('error', err => {
    setStatus(safeError(err));
    if (err.type === 'network' || err.type === 'server-error') setStatus(`${safeError(err)} Check the signaling host and CSP allow-list.`);
    if (err.type === 'unavailable-id' && lockAcquired) {
      const delays = [1000, 3000, 9000]; const delay = delays[Math.min(unavailableRetries++, delays.length - 1)];
      clearTimeout(retryTimer); setStatus(`The persisted sender ID is unavailable; retrying the same ID in ${delay / 1000}s.`);
      retryTimer = setTimeout(() => createPeer().catch(e => setStatus(safeError(e))), delay);
    }
  });
  peer.on('connection', c => {
    if (c.metadata?.kind === 'control') acceptControl(c);
    else if (c.metadata?.kind === 'bulk') acceptBulk(c);
    else c.close();
  });
}
function startPeer() {
  if (lockAcquired) { createPeer().catch(e => setStatus(safeError(e))); return; }
  if (lockStarted) return;
  lockStarted = true; setStatus('Acquiring sender ID lock…');
  Promise.resolve().then(senderId).then(id => navigator.locks.request(`p2p-send:${id}`, { ifAvailable: true }, async lock => {
    if (!lock) throw new Error('This sender ID is already in use in another tab.');
    lockAcquired = true; await createPeer(); await new Promise(() => {});
  })).catch(e => { lockStarted = false; setStatus(safeError(e)); });
}
function acceptControl(control) {
  if (control.metadata?.kind !== 'control' || sessions.has(control.peer)) { control.close(); return; }
  let session, timer;
  control.on('open', () => { timer = setTimeout(() => { if (!session?.bulk) { control.close(); session?.bulk?.close(); } }, 10000); startPings(control, ms => document.querySelector('#rtt').textContent = `${ms} ms`); if (session) updatePath(session, 'control', control); });
  control.on('data', raw => {
    let message;
    try { message = parseControlMessage(raw); } catch { control.close(); return; }
    if (!session) {
      if (message.type !== 'HELLO' || message.role !== 'receiver' || message.protocolVersion !== 1) {
        control.send(encodeControlMessage({ type: 'ERROR', code: 'PROTOCOL', message: 'Expected receiver HELLO for protocol version 1.' })); control.close(); return;
      }
      if (!admitReceiver(sessions.size, { sendError: message => control.send(encodeControlMessage(message)), close: () => control.close() })) return;
      ensureReceiverRow(control.peer);
      session = { control, peerId: control.peer, sessionId: random.hex128(), bulk: null, manifestSent: false, activeSends: new Map(), ledger: new RequestLedger(), requestCount: 0, speed: new SpeedWindow(), controlPath: 'unknown', bulkPath: 'waiting' };
      sessions.set(control.peer, session);
      updatePath(session, 'control', control);
      send(control, { type: 'HELLO', role: 'sender', protocolVersion: 1, sessionId: session.sessionId });
      const waiting = pendingBulk.get(control.peer);
      if (waiting) { pendingBulk.delete(control.peer); pairBulk(session, waiting); }
      renderPeers(); return;
    }
    if (message.type === 'PING') { send(control, { type: 'PONG', seq: message.seq }); return; }
    if (message.type === 'BITFIELD') {
      const expectedBytes = Math.ceil(metadata?.chunkCount / 8);
      if (!metadata || message.hex.length !== expectedBytes * 2) { control.close(); return; }
      const remainder = metadata.chunkCount % 8;
      if (remainder && Number.parseInt(message.hex.slice(-2), 16) % (2 ** (8 - remainder)) !== 0) { control.close(); return; }
      session.receiverHave = new Set();
      for (let i = 0; i < metadata.chunkCount; i++) {
        const byte = Number.parseInt(message.hex.slice(Math.floor(i / 8) * 2, Math.floor(i / 8) * 2 + 2), 16);
        if (Math.floor(byte / (2 ** (i % 8))) % 2 === 1) session.receiverHave.add(i);
      }
      renderPeers();
      return;
    }
    if (message.type === 'HAVE') { message.indices.forEach(i => session.receiverHave?.add(i)); renderPeers(); return; }
    if (message.type === 'REJECT') { cancelRequest(session, message.index, message.attempt); return; }
    if (message.type === 'REQUEST') { session.requestCount++; onRequest(session, message); renderPeers(); return; }
    if (message.type === 'CANCEL') { cancelRequest(session, message.index, message.attempt); return; }
    if (message.type === 'HELLO' || message.type === 'PONG') { if (message.type === 'HELLO') control.close(); return; }
    control.close();
  });
  control.on('close', () => { clearTimeout(timer); if (session) disconnectSession(session); });
  control.on('error', e => { if (session) session.error = safeError(e); setStatus(safeError(e)); renderPeers(); });
}
function acceptBulk(bulk) {
  const sessionId = bulk.metadata?.sessionId;
  if (typeof sessionId !== 'string' || !/^[a-f0-9]{32}$/.test(sessionId)) { bulk.close(); return; }
  const session = sessions.get(bulk.peer);
  if (session) { if (session.sessionId !== sessionId || session.bulk) { bulk.close(); return; } pairBulk(session, bulk); return; }
  if (pendingBulk.has(bulk.peer)) { bulk.close(); return; }
  pendingBulk.set(bulk.peer, bulk);
  const timer = setTimeout(() => { if (pendingBulk.get(bulk.peer) === bulk) { pendingBulk.delete(bulk.peer); bulk.close(); } }, 10000);
  bulk.on('close', () => { clearTimeout(timer); if (pendingBulk.get(bulk.peer) === bulk) pendingBulk.delete(bulk.peer); });
}
function pairBulk(session, bulk) {
  if (bulk.peer !== session.peerId || bulk.metadata?.sessionId !== session.sessionId || session.bulk) { bulk.close(); return; }
  session.bulk = bulk; clearTimeout(bulk.__pairTimer);
  updatePath(session, 'bulk', bulk);
  bulk.on('data', () => { session.control.close(); bulk.close(); });
  bulk.on('open', () => { updatePath(session, 'bulk', bulk); configureBackpressure(session); renderPeers(); sendManifest(session); pumpTransfers(); });
  bulk.on('close', renderPeers); bulk.on('error', e => { session.error = safeError(e); setStatus(safeError(e)); renderPeers(); });
  if (bulk.open) { configureBackpressure(session); renderPeers(); sendManifest(session); pumpTransfers(); }
}
function configureBackpressure(session) {
  const channel = session.bulk?.dataChannel;
  if (!channel || session.backpressureConfigured) return;
  session.backpressureConfigured = true;
  channel.bufferedAmountLowThreshold = 256 * 1024;
  channel.addEventListener('bufferedamountlow', () => { session.peerBufferHigh = false; pumpTransfers(); pumpFrames(); renderPeers(); });
}
function sendManifest(session) {
  if (!manifest || session.manifestSent || !session.control.open || !session.bulk?.open) return;
  session.manifestSent = true;
  const bytes = new Uint8Array(manifest);
  send(session.control, { type: 'MANIFEST_START', name: currentFile.name, size: currentFile.size, chunkSize: metadata.chunkSize, chunkCount: metadata.chunkCount, fileId, manifestBytes: bytes.byteLength });
  let seq = 0;
  for (let offset = 0; offset < bytes.length; offset += 16384) {
    let hex = '';
    for (let i = offset, end = Math.min(bytes.length, offset + 16384); i < end; i++) hex += bytes[i].toString(16).padStart(2, '0');
    send(session.control, { type: 'MANIFEST_DATA', seq: seq++, data: hex });
  }
  send(session.control, { type: 'MANIFEST_END', parts: seq });
}
function requestKey(session, index, attempt) { return `${session.peerId}:${index}:${attempt}`; }
function onRequest(session, message) {
  if (!metadata || !currentFile || !manifest || message.index >= metadata.chunkCount) {
    send(session.control, { type: 'REJECT', index: message.index, attempt: message.attempt, reason: 'RANGE' }); return;
  }
  const observed = session.ledger.observe(message.index, message.attempt);
  if (observed === 'duplicate' || observed === 'stale') return;
  if (observed === 'exhausted' || observed === 'invalid') { send(session.control, { type: 'REJECT', index: message.index, attempt: message.attempt, reason: 'RANGE' }); return; }
  if (observed === 'superseded') cancelLowerAttempts(session, message.index, message.attempt);
  const existing = [...requestStates.values()].filter(state => state.session === session).length;
  if (existing >= 12) { send(session.control, { type: 'REJECT', index: message.index, attempt: message.attempt, reason: 'BUSY' }); return; }
  const length = chunkLength(currentFile.size, metadata.chunkSize, message.index);
  const key = requestKey(session, message.index, message.attempt);
  requestStates.set(key, { session, index: message.index, attempt: message.attempt, length, key });
  budget.enqueue(session.peerId, key, length);
  renderPeers(); pumpTransfers();
}
function cancelLowerAttempts(session, index, attempt) {
  for (const [key, state] of requestStates) if (state.session === session && state.index === index && state.attempt < attempt) cancelRequest(session, index, state.attempt);
}
function cancelRequest(session, index, attempt) {
  const key = requestKey(session, index, attempt), state = requestStates.get(key);
  if (!state) return;
  budget.cancel(session.peerId, key);
  session.activeSends.delete(key); requestStates.delete(key); pumpTransfers(); renderPeers();
}
function disconnectSession(session) {
  for (const [key, state] of requestStates) if (state.session === session) requestStates.delete(key);
  budget.disconnect(session.peerId); session.activeSends.clear(); sessions.delete(session.peerId); session.error ||= 'Disconnected';
  const row = receiverRows.get(session.peerId); if (row) { row.root.classList.add('disconnected'); row.activity.textContent = 'Disconnected; reservations released.'; }
  session.bulk?.close(); renderPeers(); pumpTransfers();
}
function pumpTransfers() {
  if (pumping || !currentFile || !metadata) return;
  pumping = true;
  try {
    while (true) {
      const metrics = bufferedMetrics();
      const item = budget.grantNext({ bufferedGlobal: metrics.global, bufferedByPeer: metrics.byPeer,
        canGrant: peerId => { const s = sessions.get(peerId); return !!(s?.control.open && s.bulk?.open && s.activeSends.size < 4 && s.bulk.dataChannel?.bufferedAmount <= 1024 * 1024); } });
      if (!item) break;
      const state = requestStates.get(item.key), session = sessions.get(item.peerId);
      if (!state || !session) { budget.release(item.key); continue; }
      session.activeSends.set(item.key, state);
      readRequestedChunk(state).then(buffer => {
        if (!requestStates.has(item.key) || session.activeSends.get(item.key) !== state) { budget.release(item.key); pumpTransfers(); return; }
        state.buffer = buffer; state.stage = 'start'; state.offset = 0; pumpFrames();
      }).catch(error => {
        budget.release(item.key); session.activeSends.delete(item.key); requestStates.delete(item.key);
        const code = error?.name === 'NotReadableError' || error?.name === 'NotFoundError' ? 'FILE_CHANGED' : null;
        if (code) { sendError(session, code, 'The selected source file is no longer readable.'); setStatus('Source file changed or became unreadable; transfer stopped.'); }
        else send(session.control, { type: 'REJECT', index: state.index, attempt: state.attempt, reason: 'READ_ERROR' });
        pumpTransfers(); renderPeers();
      });
    }
  } finally { pumping = false; }
}
async function readRequestedChunk(state) {
  const start = chunkFileOffset(state.index, metadata.chunkSize);
  return currentFile.slice(start, start + state.length).arrayBuffer();
}
function pumpFrames() {
  let progressed;
  do {
    progressed = false; let tokenBlocked = false;
    const candidates = [...sessions.values()];
    for (let visit = 0; visit < candidates.length; visit++) {
      const session = frameCursor.next(candidates, value => value.peerId);
      const channel = session.bulk?.dataChannel;
      if (!channel || channel.readyState !== 'open' || channel.bufferedAmount > 1024 * 1024) continue;
      for (const state of session.activeSends.values()) {
        if (!state.buffer) continue;
        const metrics = bufferedMetrics();
        if (!budget.canQueue(session.peerId, FRAME_HEADER_BYTES + MAX_FRAME_PAYLOAD_BYTES, { bufferedGlobal: metrics.global, bufferedByPeer: metrics.byPeer })) continue;
        const frameSize = nextFrameSize(state);
        if (uploadBucket && !uploadBucket.take(frameSize)) { scheduleTokenWake(uploadBucket.delayFor(frameSize)); tokenBlocked = true; break; }
        const payloadBytes = state.stage === 'data' ? Math.min(MAX_FRAME_PAYLOAD_BYTES, state.length - state.offset) : 0;
        const next = nextFrame(state);
        if (!next) continue;
        try { channel.send(next); }
        catch (error) { if (debug) console.debug('Direct PeerJS dataChannel.send failed', safeError(error)); session.control.close(); break; }
        progressed = true;
        if (payloadBytes) {
          session.speed.add(payloadBytes);
          const row = receiverRows.get(session.peerId);
          if (row) row.speed.textContent = `${(session.speed.bytesPerSecond() / 1024 ** 2).toFixed(2)} MiB/s`;
        }
        if (channel.bufferedAmount > 8 * 1024 * 1024 && debug) console.debug('PeerJS 8 MiB queue threshold crossed on direct dataChannel.send', channel.bufferedAmount);
        if (state.stage === 'done') {
          session.activeSends.delete(state.key); requestStates.delete(state.key); budget.release(state.key);
          renderPeers(); pumpTransfers();
        }
        break;
      }
      if (progressed || tokenBlocked) break;
    }
  } while (progressed && !tokenBlocked);
}
function nextFrameSize(state) {
  if (state.stage === 'start') return FRAME_HEADER_BYTES + 4;
  if (state.stage === 'data' && state.offset < state.length) return FRAME_HEADER_BYTES + Math.min(MAX_FRAME_PAYLOAD_BYTES, state.length - state.offset);
  return FRAME_HEADER_BYTES;
}
function scheduleTokenWake(delayMs) {
  if (tokenWakeTimer) return;
  tokenWakeTimer = setTimeout(() => { tokenWakeTimer = undefined; pumpTransfers(); pumpFrames(); }, Math.max(1, Math.ceil(delayMs)));
}
function nextFrame(state) {
  if (state.stage === 'start') {
    const payload = new Uint8Array(4); new DataView(payload.buffer).setUint32(0, state.length, false);
    state.stage = 'data'; return encodeFrame({ type: CHUNK_START, attempt: state.attempt, index: state.index, offset: 0, payload });
  }
  if (state.stage === 'data') {
    if (state.offset < state.length) {
      const length = Math.min(16384, state.length - state.offset);
      const payload = new Uint8Array(state.buffer, state.offset, length);
      const frame = encodeFrame({ type: CHUNK_DATA, attempt: state.attempt, index: state.index, offset: state.offset, payload });
      state.offset += length; return frame;
    }
    state.stage = 'end';
  }
  if (state.stage === 'end') { state.stage = 'done'; return encodeFrame({ type: CHUNK_END, attempt: state.attempt, index: state.index, offset: state.length, payload: new Uint8Array(0) }); }
  if (state.stage === 'done') return null;
  return null;
}

document.querySelector('#choose').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  currentFile = fileInput.files?.[0];
  if (!currentFile || currentFile.size === 0) { setStatus('Choose a non-empty file.'); return; }
  if (currentFile.size > 256 * 1024 ** 3) { setStatus('File exceeds the 256 GiB limit.'); return; }
  for (const session of [...sessions.values()]) { budget.disconnect(session.peerId); session.control.close(); session.bulk?.close(); }
  sessions.clear(); requestStates.clear(); renderPeers();
  shareSection.hidden = true; manifest = fileId = undefined; metadata = undefined;
  setStatus('Hashing file in worker…');
  const worker = new Worker('./src/workers/hash-worker.js', { type: 'module' }); const requestId = random.hex128();
  worker.onmessage = e => {
    const m = e.data; if (m.requestId !== requestId) return;
    if (m.type === 'progress') { setStatus(`Hashing chunk ${m.done}/${m.total}…`); return; }
    worker.terminate();
    if (m.type === 'error') { setStatus(safeError(m.message)); return; }
    manifest = m.manifest; fileId = m.fileId; metadata = { chunkSize: m.chunkSize, chunkCount: m.chunkCount };
    fidLabel.textContent = fileId; publishLink(); setStatus('File hashed and ready to share.');
    for (const session of sessions.values()) sendManifest(session); pumpTransfers();
  };
  worker.onerror = e => { worker.terminate(); setStatus(`Hash worker failed: ${safeError(e.message)}`); };
  worker.postMessage({ type: 'HASH_FILE', requestId, file: currentFile });
});

if (updateFeatures()) startPeer();
document.querySelector('#upload-limit').addEventListener('change', event => {
  const kib = Number(event.currentTarget.value);
  if (!Number.isFinite(kib) || kib < 0 || kib > 102400) { event.currentTarget.value = '0'; uploadBucket = undefined; return; }
  clearTimeout(tokenWakeTimer); tokenWakeTimer = undefined;
  uploadBucket = kib === 0 ? undefined : new TokenBucket({ rateBytesPerSecond: kib * 1024, burstBytes: Math.max(2 * (FRAME_HEADER_BYTES + MAX_FRAME_PAYLOAD_BYTES), Math.ceil(kib * 1024 / 10)) });
  pumpFrames();
});
setupSettings(startPeer);
