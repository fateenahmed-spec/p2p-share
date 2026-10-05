import Peer from '../../vendor/peerjs/peerjs-1.5.5.mjs';
import { loadConfig, peerOptions, setupSettings, updateFeatures, safeError, startPings } from './common.js';
import { parseShareLink, parseControlMessage, encodeControlMessage } from '../lib/validators.js';
import { fileId, parseManifest } from '../lib/manifest.js';
import { chunkSizeFor } from '../lib/chunk-size.js';

const status = document.querySelector('#status');
const rtt = document.querySelector('#rtt');
let peer, control, bulk, start, nextSeq = 0, pieces = [], byteLength = 0, expectedSession;
let manifestVerified = false, bitfieldSent = false;
let storageWorker, fileLockStarted = false;
let link;

function send(message) { if (control?.open) control.send(encodeControlMessage(message)); }
function safeDisplayName(name) { return name.replace(/[\0-\x1f\x7f\\/]/g, '�').slice(0, 255); }
function updatePairedStatus() {
  if (manifestVerified && control?.open && bulk?.open) status.textContent = 'Manifest verified; control and bulk channels paired.';
  else if (manifestVerified) status.textContent = 'Manifest verified; finishing bulk-channel pairing.';
}
function fail(message) { status.textContent = message; control?.close(); bulk?.close(); }

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
      control.on('close', () => { if (status.textContent !== 'Manifest verified; control and bulk channels paired.') status.textContent = 'Sender disconnected.'; });
    });
    peer.on('connection', c => {
      if (c.metadata?.kind !== 'bulk' || c.peer !== link.room || !expectedSession ||
          c.metadata?.sessionId !== expectedSession || bulk) { c.close(); return; }
      bulk = c;
      bulk.on('open', updatePairedStatus);
      bulk.on('data', () => fail('Unexpected sender bulk data during S1.'));
      bulk.on('error', e => { status.textContent = safeError(e); });
      bulk.on('close', () => { if (manifestVerified) status.textContent = 'Bulk channel disconnected.'; });
      updatePairedStatus(); sendBitfieldWhenReady();
    });
    peer.on('error', e => {
      status.textContent = safeError(e);
      if (e.type === 'network' || e.type === 'server-error') status.textContent += ' Check the signaling host and CSP allow-list.';
    });
  } catch (e) { status.textContent = safeError(e); }
}

async function onControl(raw) {
  let message;
  try { message = parseControlMessage(raw); }
  catch (e) { fail(`Invalid control message: ${safeError(e)}`); return; }

  if (!expectedSession) {
    if (message.type !== 'HELLO' || message.role !== 'sender' || message.protocolVersion !== 1) { fail('Expected sender HELLO for protocol version 1.'); return; }
    expectedSession = message.sessionId;
    status.textContent = 'Sender verified; opening bulk channel.';
    bulk = peer.connect(link.room, { reliable: true, serialization: 'raw', metadata: { kind: 'bulk', sessionId: expectedSession } });
    bulk.on('open', updatePairedStatus);
    bulk.on('data', () => fail('Unexpected sender bulk data during S1.'));
    bulk.on('error', e => { status.textContent = safeError(e); });
    bulk.on('close', () => { if (manifestVerified) status.textContent = 'Bulk channel disconnected.'; });
    return;
  }

  if (message.type === 'PING') { send({ type: 'PONG', seq: message.seq }); return; }
  if (message.type === 'PONG') return; // RTT is measured by startPings' strict control listener.
  if (message.type === 'ERROR') { fail(`Sender error: ${message.message}`); return; }
  if (message.type === 'HELLO') { fail('Unexpected repeated or wrong-role HELLO.'); return; }
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
    if (parsed.protocolVersion !== 1 || parsed.chunkSize !== chunkSizeFor(parsed.size) ||
        parsed.name !== start.name || parsed.size !== start.size || parsed.chunkSize !== start.chunkSize ||
        parsed.chunkCount !== start.chunkCount) { fail('Manifest outer fields do not match canonical bytes.'); return; }
    await initializeStorageAfterManifest(parsed);
    return;
  }
  fail(`Unexpected ${message.type} from sender.`);
}

function sendBitfieldWhenReady() {
  if (!manifestVerified || !control?.open || !bulk?.open || bitfieldSent) return;
  bitfieldSent = true;
  const count = Math.ceil(start.size / start.chunkSize);
  send({ type: 'BITFIELD', hex: '00'.repeat(Math.ceil(count / 8)) });
}

function initializeStorageAfterManifest(parsed) {
  if (fileLockStarted) return;
  fileLockStarted = true;
  navigator.locks.request(`p2p-file:${link.fid}`, { ifAvailable: true }, async lock => {
    if (!lock) { fail('This file is already open in another receiver tab.'); return; }
    const result = await new Promise(resolve => {
      const timer = setTimeout(() => resolve({ ok: false, error: 'Storage feature probe timed out.' }), 10000);
      const listener = event => {
        if (event.data?.type !== 'PHASE2_RESULT') return;
        clearTimeout(timer); storageWorker.removeEventListener('message', listener); resolve(event.data);
      };
      storageWorker.addEventListener('message', listener);
      storageWorker.postMessage({ type: 'PHASE2', token: crypto.getRandomValues(new Uint8Array(8)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '') });
    });
    if (!result.ok) { fail(`Receiver storage is unsupported: ${safeError(result.error || 'probe failed')}`); return; }
    document.querySelector('#file-name').textContent = safeDisplayName(parsed.name);
    document.querySelector('#file-size').textContent = `${parsed.size} bytes`;
    status.dataset.manifestParts = String(nextSeq);
    status.dataset.manifestBytes = String(byteLength);
    manifestVerified = true;
    updatePairedStatus(); sendBitfieldWhenReady();
    await new Promise(() => {}); // Hold the per-file lock for this receiver tab.
  }).catch(e => fail(safeError(e)));
}

async function probeStorageFeature() {
  storageWorker = new Worker('./src/workers/opfs-worker.js', { type: 'module' });
  const phase1 = await new Promise(resolve => {
    const timer = setTimeout(() => resolve({ ok: false, error: 'Storage feature probe timed out.' }), 10000);
    const listener = event => {
      if (event.data?.type !== 'PHASE1_RESULT') return;
      clearTimeout(timer); storageWorker.removeEventListener('message', listener); resolve(event.data);
    };
    storageWorker.addEventListener('message', listener); storageWorker.postMessage({ type: 'PHASE1' });
  });
  if (!phase1.ok) { status.textContent = `Unsupported browser; OPFS sync access handles are required. ${safeError(phase1.error || '')}`; return false; }
  return true;
}

try {
  link = parseShareLink(location.href);
  document.querySelector('#room').textContent = link.room;
  if (updateFeatures()) probeStorageFeature().then(ok => { if (ok) { status.textContent = 'Storage features available; connecting…'; startPeer(); } });
} catch (e) { status.textContent = `Invalid share link: ${safeError(e)}`; }
setupSettings(startPeer);
