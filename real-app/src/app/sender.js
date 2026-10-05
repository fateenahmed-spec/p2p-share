import Peer from '../../vendor/peerjs/peerjs-1.5.5.mjs';
import { loadConfig, peerOptions, senderId, setupSettings, updateFeatures, safeError, startPings } from './common.js';
import { random } from '../lib/random.js';
const status = document.querySelector('#status'); const fileInput = document.querySelector('#file');
let peer, currentFile, manifest, fileId, lockStarted = false, lockAcquired = false;
function stopPeer() { try { peer?.destroy(); } catch {} peer = undefined; }
async function createPeer() {
  stopPeer(); const cfg = await loadConfig(); const id = await senderId();
  peer = new Peer(id, peerOptions(cfg.signaling, cfg.options));
  peer.on('open', () => { status.textContent = 'Ready. Select a file to share.'; });
  peer.on('error', err => { status.textContent = safeError(err); if (err.type === 'network' || err.type === 'server-error') status.textContent += ' Check the signaling host and CSP allow-list.'; });
  peer.on('connection', c => acceptControl(c));
}
function startPeer() {
  if (lockAcquired) { createPeer().catch(e => status.textContent = safeError(e)); return; }
  if (lockStarted) return;
  lockStarted = true;
  senderId().then(id => navigator.locks.request(`p2p-send:${id}`, { ifAvailable: true }, async lock => {
    if (!lock) throw new Error('This sender ID is already in use in another tab.');
    lockAcquired = true; await createPeer(); await new Promise(() => {});
  })).catch(e => { lockStarted = false; status.textContent = safeError(e); });
}
function acceptControl(control) {
  if (control.metadata?.kind !== 'control') { control.close(); return; }
  let bulk;
  const pairing = setTimeout(() => { if (!bulk) control.close(); }, 10000);
  control.on('open', () => startPings(control, ms => document.querySelector('#rtt').textContent = `${ms} ms`));
  control.on('data', msg => {
    if (msg?.type === 'HELLO') {
      if (msg.role !== 'receiver' || msg.protocolVersion !== 1) { control.send({ type: 'ERROR', code: 'BAD_ROLE' }); control.close(); return; }
      const sessionId = random.hex128(); control.metadata = { sessionId };
      control.send({ type: 'HELLO', role: 'sender', protocolVersion: 1, sessionId });
      bulk = peer.connect(control.peer, { reliable: true, serialization: 'binary', metadata: { kind: 'bulk', sessionId } });
      bulk.on('open', () => { clearTimeout(pairing); if (manifest) sendManifest(control); });
      bulk.on('error', e => status.textContent = safeError(e));
    } else if (msg?.type === 'PING') control.send({ type: 'PONG', seq: msg.seq });
    else if (msg?.type === 'BITFIELD') status.textContent = `Receiver bitmap received (${String(msg.hex).length / 2} bytes).`;
  });
  control.on('close', () => { clearTimeout(pairing); bulk?.close(); });
}
function sendManifest(control) {
  if (!control.open || !manifest) return;
  const bytes = new Uint8Array(manifest);
  control.send({ type: 'MANIFEST_START', name: currentFile.name, size: currentFile.size, chunkSize: JSON.parse(fileId.dataset.meta).chunkSize, chunkCount: JSON.parse(fileId.dataset.meta).chunkCount, fileId: fileId.textContent, manifestBytes: bytes.length });
  const bytesPerPart = 16384; let seq = 0;
  for (let offset = 0; offset < bytes.length; offset += bytesPerPart) {
    let hex = ''; const end = Math.min(bytes.length, offset + bytesPerPart);
    for (let i = offset; i < end; i++) hex += bytes[i].toString(16).padStart(2, '0');
    control.send({ type: 'MANIFEST_DATA', seq: seq++, data: hex });
  }
  control.send({ type: 'MANIFEST_END', parts: seq });
}
document.querySelector('#choose').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  currentFile = fileInput.files?.[0];
  if (!currentFile || currentFile.size === 0) { status.textContent = 'Choose a non-empty file.'; return; }
  status.textContent = 'Hashing file in worker…'; document.querySelector('#share-link').hidden = true;
  const worker = new Worker('./src/workers/hash-worker.js', { type: 'module' }); const requestId = random.hex128();
  worker.onmessage = e => {
    const m = e.data; if (m.requestId !== requestId) return;
    if (m.type === 'progress') { status.textContent = `Hashing chunk ${m.done}/${m.total}…`; return; }
    worker.terminate();
    if (m.type === 'error') { status.textContent = safeError(m.message); return; }
    manifest = m.manifest; fileId.textContent = m.fileId; fileId.dataset.meta = JSON.stringify({ chunkSize: m.chunkSize, chunkCount: m.chunkCount });
    const url = new URL('./receiver.html', location.href); url.searchParams.set('room', peer.id); url.searchParams.set('fid', m.fileId);
    document.querySelector('#share-url').value = url.href; document.querySelector('#share-link').hidden = false;
    status.textContent = 'File ready to share.';
  };
  worker.postMessage({ type: 'HASH_FILE', requestId, file: currentFile });
});
if (updateFeatures()) startPeer();
setupSettings(startPeer);
