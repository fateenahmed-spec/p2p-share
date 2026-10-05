import Peer from '../../vendor/peerjs/peerjs-1.5.5.mjs';
import { loadConfig, peerOptions, setupSettings, updateFeatures, safeError, startPings } from './common.js';
import { parseShareLink, parseControlMessage } from '../lib/validators.js';
import { fileId, parseManifest } from '../lib/manifest.js';
const status = document.querySelector('#status'); let peer, control, bulk, start, nextSeq = 0, pieces = [], byteLength = 0, expectedSession;
const link = parseShareLink(location.href); document.querySelector('#room').textContent = link.room;
async function startPeer() {
  try {
    peer?.destroy(); const cfg = await loadConfig(); peer = new Peer(undefined, peerOptions(cfg.signaling, cfg.options));
    peer.on('open', () => {
      control = peer.connect(link.room, { reliable: true, serialization: 'json', metadata: { kind: 'control' } });
      control.on('open', () => { control.send({ type: 'HELLO', role: 'receiver', protocolVersion: 1 }); startPings(control, ms => document.querySelector('#rtt').textContent = `${ms} ms`); status.textContent = 'Connected; waiting for manifest.'; });
      control.on('data', msg => onControl(msg)); control.on('error', e => status.textContent = safeError(e));
    });
    peer.on('connection', c => {
      if (c.metadata?.kind !== 'bulk' || !expectedSession || c.metadata?.sessionId !== expectedSession) { c.close(); return; }
      bulk = c; bulk.on('open', () => status.textContent = 'Bulk channel paired.'); bulk.on('data', () => {});
    });
    peer.on('error', e => { status.textContent = safeError(e); if (e.type === 'network' || e.type === 'server-error') status.textContent += ' Check the signaling host and CSP allow-list.'; });
  } catch (e) { status.textContent = safeError(e); }
}
async function onControl(raw) {
  let m; try { m = parseControlMessage(JSON.stringify(raw)); } catch (e) { status.textContent = safeError(e); return; }
  if (m.type === 'HELLO') {
    if (m.role !== 'sender' || m.protocolVersion !== 1 || !/^[a-f0-9]{32}$/.test(m.sessionId || '')) { status.textContent = 'Sender role/protocol mismatch.'; control.close(); return; }
    expectedSession = m.sessionId; status.textContent = 'Sender verified; pairing bulk channel…'; return;
  }
  if (m.type === 'MANIFEST_START') { start = m; nextSeq = 0; pieces = []; byteLength = 0; return; }
  if (m.type === 'MANIFEST_DATA') {
    if (!start || m.seq !== nextSeq || typeof m.data !== 'string' || m.data.length > 32768 || m.data.length % 2 || !/^[a-f0-9]*$/.test(m.data)) { status.textContent = 'Invalid manifest sequence or data.'; control.close(); return; }
    nextSeq++; byteLength += m.data.length / 2; pieces.push(m.data); return;
  }
  if (m.type === 'MANIFEST_END') {
    if (!start || m.parts !== nextSeq || byteLength !== start.manifestBytes || byteLength > 2_200_000) { status.textContent = 'Manifest size/sequence mismatch.'; return; }
    const bytes = new Uint8Array(byteLength); let p = 0;
    for (const hex of pieces) for (let i = 0; i < hex.length; i += 2) bytes[p++] = Number.parseInt(hex.slice(i, i + 2), 16);
    if (await fileId(bytes) !== link.fid || start.fileId !== link.fid) { status.textContent = 'Manifest file ID does not match the link.'; return; }
    const parsed = parseManifest(bytes);
    if (parsed.name !== start.name || parsed.size !== start.size || parsed.chunkSize !== start.chunkSize || parsed.chunkCount !== start.chunkCount) { status.textContent = 'Manifest outer fields do not match canonical bytes.'; return; }
    document.querySelector('#file-name').textContent = parsed.name.replace(/[\0-\x1f\x7f]/g, '�');
    document.querySelector('#file-size').textContent = `${parsed.size} bytes`;
    status.textContent = 'Manifest verified.'; control.send({ type: 'BITFIELD', hex: '00'.repeat(Math.ceil(parsed.chunkCount / 8)) }); return;
  }
  if (m.type === 'PING') control.send({ type: 'PONG', seq: m.seq });
  if (m.type === 'ERROR') status.textContent = `Sender error: ${m.code}`;
}
if (updateFeatures()) startPeer();
setupSettings(startPeer);
