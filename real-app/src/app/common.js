import { makePeerOptions } from '../lib/rtc-config.js';
import { random } from '../lib/random.js';
import { encodeControlMessage, parseControlMessage } from '../lib/validators.js';

export async function loadConfig() {
  const base = await (await fetch('./config.example.json', { cache: 'no-store' })).json();
  try { const local = await (await fetch('./config.local.json', { cache: 'no-store' })).json(); Object.assign(base, local); } catch { /* local overrides are optional */ }
  let saved = {};
  try { saved = JSON.parse(sessionStorage.getItem('p2p-ice-settings') || '{}'); } catch { /* use default ICE settings */ }
  const iceServers = saved.iceServers || base.iceServers;
  return { signaling: base.signaling, options: makePeerOptions({ iceServers, forceRelay: !!saved.forceRelay }) };
}
export function peerOptions(signaling, config) {
  return { host: signaling.host, port: signaling.port, path: signaling.path, key: signaling.key,
    secure: signaling.secure, debug: 0, ...config };
}
export function setupSettings(onReconnect) {
  const form = document.querySelector('#ice-settings');
  form.addEventListener('submit', e => {
    e.preventDefault();
    const urls = document.querySelector('#ice-urls').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const username = document.querySelector('#ice-username').value;
    const credential = document.querySelector('#ice-credential').value;
    const forceRelay = document.querySelector('#force-relay').checked;
    const iceServers = urls.map(url => ({ urls: url, ...(username ? { username } : {}), ...(credential ? { credential } : {}) }));
    try { sessionStorage.setItem('p2p-ice-settings', JSON.stringify({ iceServers, forceRelay })); onReconnect(); }
    catch { document.querySelector('#status').textContent = 'ICE settings are unavailable in this browser tab.'; }
  });
  try {
    const saved = JSON.parse(sessionStorage.getItem('p2p-ice-settings') || '{}');
    document.querySelector('#ice-urls').value = (saved.iceServers || []).map(s => s.urls).join('\n');
    document.querySelector('#ice-username').value = saved.iceServers?.[0]?.username || '';
    document.querySelector('#ice-credential').value = saved.iceServers?.[0]?.credential || '';
    document.querySelector('#force-relay').checked = !!saved.forceRelay;
  } catch { /* storage may be unavailable */ }
  document.querySelector('#clear-settings').addEventListener('click', () => {
    try { sessionStorage.removeItem('p2p-ice-settings'); onReconnect(); }
    catch { document.querySelector('#status').textContent = 'ICE settings are unavailable in this browser tab.'; }
  });
}
export async function senderId() {
  const key = 'p2p-sender-id'; let id = localStorage.getItem(key);
  if (!/^[a-f0-9]{32}$/.test(id || '')) { id = random.hex128(); localStorage.setItem(key, id); }
  return id;
}
export function updateFeatures() {
  const has = (name, test) => { try { return !!test(); } catch { return false; } };
  const required = [
    ['secure context (HTTPS or localhost)', () => globalThis.isSecureContext],
    ['SubtleCrypto', () => !!globalThis.crypto?.subtle],
    ['secure random numbers', () => typeof globalThis.crypto?.getRandomValues === 'function'],
    ['Worker', () => typeof Worker === 'function'],
    ['TextEncoder and TextDecoder', () => typeof TextEncoder === 'function' && typeof TextDecoder === 'function'],
    ['WebRTC data channels', () => typeof RTCPeerConnection === 'function' && typeof RTCDataChannel === 'function'],
    ['data-channel backpressure events', () => typeof RTCDataChannel === 'function' && 'bufferedAmountLowThreshold' in RTCDataChannel.prototype],
    ['File.slice', () => typeof File !== 'undefined' && typeof File.prototype.slice === 'function'],
    ['Web Locks', () => !!navigator.locks],
  ];
  const missing = required.filter(([name, test]) => !has(name, test)).map(([name]) => name);
  const optional = [];
  if (!has('Wake Lock', () => !!navigator.wakeLock)) optional.push('Wake Lock (transfer will continue without a screen lock)');
  if (!has('storage estimate/persist', () => !!navigator.storage?.estimate && !!navigator.storage?.persist)) optional.push('storage estimate/persist');
  if (!has('sessionStorage', () => { sessionStorage.setItem('__p2p_check', '1'); sessionStorage.removeItem('__p2p_check'); return true; })) optional.push('sessionStorage ICE settings');
  document.querySelector('#feature-status').textContent = [
    missing.length ? `Unsupported browser; required features missing: ${missing.join(', ')}` : 'Required browser features are available.',
    optional.length ? `Optional features unavailable: ${optional.join(', ')}.` : ''
  ].filter(Boolean).join(' ');
  if (missing.length && document.querySelector('#choose')) document.querySelector('#choose').disabled = true;
  return missing.length === 0;
}
export function safeError(error) { return String(error?.message || error).replace(/[\r\n\0]/g, ' ').slice(0, 240); }
export function startPings(conn, showRtt) {
  const pending = new Map(); let seq = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    for (const [n, sentAt] of pending) if (now - sentAt > 15000) pending.delete(n);
    if (conn.open) { const n = ++seq; pending.set(n, now); conn.send(encodeControlMessage({ type: 'PING', seq: n })); }
  }, 5000);
  conn.on('data', data => {
    try { const message = parseControlMessage(data); if (message.type === 'PONG' && pending.has(message.seq)) { showRtt(Math.round(performance.now() - pending.get(message.seq))); pending.delete(message.seq); } }
    catch { /* page protocol handler reports malformed control traffic */ }
  });
  conn.on('close', () => clearInterval(timer));
}
