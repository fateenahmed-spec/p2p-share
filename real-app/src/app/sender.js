import Peer from '../../vendor/peerjs/peerjs-1.5.5.mjs';
import { loadConfig, peerOptions, senderId, setupSettings, updateFeatures, safeError, startPings } from './common.js';
import { random } from '../lib/random.js';
import { encodeControlMessage, parseControlMessage } from '../lib/validators.js';

const status = document.querySelector('#status');
const fileInput = document.querySelector('#file');
const shareSection = document.querySelector('#share-link');
const shareUrl = document.querySelector('#share-url');
const fidLabel = document.querySelector('#file-id');
const peersLabel = document.querySelector('#peers');
let peer, currentFile, manifest, fileId, metadata, lockStarted = false, lockAcquired = false;
let unavailableRetries = 0, retryTimer;
const sessions = new Map();
const pendingBulk = new Map();

function send(control, message) { if (control.open) control.send(encodeControlMessage(message)); }
function setStatus(message) { status.textContent = message; }
function stopPeer() {
  clearTimeout(retryTimer);
  for (const session of sessions.values()) { session.control.close(); session.bulk?.close(); }
  sessions.clear(); pendingBulk.clear();
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
  peersLabel.textContent = [...sessions.values()].map(s => `${s.control.peer}: ${s.bulk?.open ? 'control + bulk paired' : 'waiting for bulk'}`).join('\n') || 'No receivers connected.';
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
      const delays = [1000, 3000, 9000];
      const delay = delays[Math.min(unavailableRetries++, delays.length - 1)];
      clearTimeout(retryTimer);
      setStatus(`The persisted sender ID is unavailable; retrying the same ID in ${delay / 1000}s.`);
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
  lockStarted = true;
  setStatus('Acquiring sender ID lock…');
  Promise.resolve().then(senderId).then(id => navigator.locks.request(`p2p-send:${id}`, { ifAvailable: true }, async lock => {
    if (!lock) throw new Error('This sender ID is already in use in another tab.');
    lockAcquired = true;
    await createPeer();
    await new Promise(() => {});
  })).catch(e => { lockStarted = false; setStatus(safeError(e)); });
}
function acceptControl(control) {
  if (control.metadata?.kind !== 'control' || sessions.has(control.peer)) { control.close(); return; }
  let session, timer;
  control.on('open', () => {
    timer = setTimeout(() => { if (!session?.bulk) { control.close(); session?.bulk?.close(); } }, 10000);
    startPings(control, ms => document.querySelector('#rtt').textContent = `${ms} ms`);
  });
  control.on('data', raw => {
    let message;
    try { message = parseControlMessage(raw); }
    catch { control.close(); return; }
    if (!session) {
      if (message.type !== 'HELLO' || message.role !== 'receiver' || message.protocolVersion !== 1) {
        send(control, { type: 'ERROR', code: 'PROTOCOL', message: 'Expected receiver HELLO for protocol version 1.' }); control.close(); return;
      }
      session = { control, peerId: control.peer, sessionId: random.hex128(), bulk: null, manifestSent: false };
      sessions.set(control.peer, session);
      send(control, { type: 'HELLO', role: 'sender', protocolVersion: 1, sessionId: session.sessionId });
      const waiting = pendingBulk.get(control.peer);
      if (waiting) { pendingBulk.delete(control.peer); pairBulk(session, waiting); }
      renderPeers();
      return;
    }
    if (message.type === 'PING') { send(control, { type: 'PONG', seq: message.seq }); return; }
    if (message.type === 'BITFIELD') {
      // Validate exact byte length and padding bits based on the current manifest.
      const expectedBytes = Math.ceil(metadata?.chunkCount / 8);
      if (!metadata || message.hex.length !== expectedBytes * 2) { control.close(); return; }
      const remainder = metadata.chunkCount % 8;
      if (remainder && Number.parseInt(message.hex.slice(-2), 16) % (2 ** (8 - remainder)) !== 0) { control.close(); return; }
      let verified = 0;
      for (let i = 0; i < metadata.chunkCount; i++) {
        const byte = Number.parseInt(message.hex.slice(Math.floor(i / 8) * 2, Math.floor(i / 8) * 2 + 2), 16);
        if (Math.floor(byte / (2 ** (i % 8))) % 2 === 1) verified++;
      }
      const percent = (verified * 100 / metadata.chunkCount).toFixed(1);
      peersLabel.textContent = `${session.peerId}: control + bulk paired; BITFIELD ${message.hex.length / 2} bytes; ${percent}% complete`;
      return;
    }
    if (message.type === 'HELLO' || !['PING', 'PONG', 'BITFIELD'].includes(message.type)) control.close();
  });
  control.on('close', () => { clearTimeout(timer); if (session) { sessions.delete(session.peerId); session.bulk?.close(); renderPeers(); } });
  control.on('error', e => setStatus(safeError(e)));
}
function acceptBulk(bulk) {
  const sessionId = bulk.metadata?.sessionId;
  if (typeof sessionId !== 'string' || !/^[a-f0-9]{32}$/.test(sessionId)) { bulk.close(); return; }
  const session = sessions.get(bulk.peer);
  if (session) {
    if (session.sessionId !== sessionId || session.bulk) { bulk.close(); return; }
    pairBulk(session, bulk); return;
  }
  if (pendingBulk.has(bulk.peer)) { bulk.close(); return; }
  pendingBulk.set(bulk.peer, bulk);
  const timer = setTimeout(() => { if (pendingBulk.get(bulk.peer) === bulk) { pendingBulk.delete(bulk.peer); bulk.close(); } }, 10000);
  bulk.on('open', () => { bulk.__pairTimer = timer; });
  bulk.on('close', () => { clearTimeout(timer); if (pendingBulk.get(bulk.peer) === bulk) pendingBulk.delete(bulk.peer); });
}
function pairBulk(session, bulk) {
  if (bulk.peer !== session.peerId || bulk.metadata?.sessionId !== session.sessionId || session.bulk) { bulk.close(); return; }
  session.bulk = bulk;
  clearTimeout(bulk.__pairTimer);
  bulk.on('data', () => { session.control.close(); bulk.close(); }); // S1 is sender-to-receiver only.
  bulk.on('open', () => { renderPeers(); sendManifest(session); });
  bulk.on('close', renderPeers);
  bulk.on('error', e => setStatus(safeError(e)));
  if (bulk.open) { renderPeers(); sendManifest(session); }
}
function sendManifest(session) {
  if (!manifest || session.manifestSent || !session.control.open || !session.bulk?.open) return;
  session.manifestSent = true;
  const bytes = new Uint8Array(manifest);
  send(session.control, {
    type: 'MANIFEST_START', name: currentFile.name, size: currentFile.size,
    chunkSize: metadata.chunkSize, chunkCount: metadata.chunkCount,
    fileId, manifestBytes: bytes.byteLength,
  });
  let seq = 0;
  for (let offset = 0; offset < bytes.length; offset += 16384) {
    let hex = '';
    for (let i = offset, end = Math.min(bytes.length, offset + 16384); i < end; i++) hex += bytes[i].toString(16).padStart(2, '0');
    send(session.control, { type: 'MANIFEST_DATA', seq: seq++, data: hex });
  }
  send(session.control, { type: 'MANIFEST_END', parts: seq });
}

document.querySelector('#choose').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  currentFile = fileInput.files?.[0];
  if (!currentFile || currentFile.size === 0) { setStatus('Choose a non-empty file.'); return; }
  if (currentFile.size > 256 * 1024 ** 3) { setStatus('File exceeds the 256 GiB limit.'); return; }
  shareSection.hidden = true; manifest = fileId = undefined; metadata = undefined;
  setStatus('Hashing file in worker…');
  const worker = new Worker('./src/workers/hash-worker.js', { type: 'module' });
  const requestId = random.hex128();
  worker.onmessage = e => {
    const m = e.data; if (m.requestId !== requestId) return;
    if (m.type === 'progress') { setStatus(`Hashing chunk ${m.done}/${m.total}…`); return; }
    worker.terminate();
    if (m.type === 'error') { setStatus(safeError(m.message)); return; }
    manifest = m.manifest; fileId = m.fileId; metadata = { chunkSize: m.chunkSize, chunkCount: m.chunkCount };
    fidLabel.textContent = fileId; publishLink();
    setStatus('File hashed and ready to share.');
    for (const session of sessions.values()) sendManifest(session);
  };
  worker.onerror = e => { worker.terminate(); setStatus(`Hash worker failed: ${safeError(e.message)}`); };
  worker.postMessage({ type: 'HASH_FILE', requestId, file: currentFile });
});

if (updateFeatures()) startPeer();
setupSettings(startPeer);
