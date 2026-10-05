import { makePeerOptions } from '../lib/rtc-config.js';
import { random } from '../lib/random.js';

export async function loadConfig() {
  const base = await (await fetch('./config.example.json', { cache: 'no-store' })).json();
  try { const local = await (await fetch('./config.local.json', { cache: 'no-store' })).json(); Object.assign(base, local); } catch { /* local overrides are optional */ }
  let saved = {};
  try { saved = JSON.parse(sessionStorage.getItem('p2p-ice-settings') || '{}'); } catch { /* panel reports defaults */ }
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
    sessionStorage.setItem('p2p-ice-settings', JSON.stringify({ iceServers, forceRelay }));
    onReconnect();
  });
  try {
    const saved = JSON.parse(sessionStorage.getItem('p2p-ice-settings') || '{}');
    document.querySelector('#ice-urls').value = (saved.iceServers || []).map(s => s.urls).join('\n');
    document.querySelector('#ice-username').value = saved.iceServers?.[0]?.username || '';
    document.querySelector('#ice-credential').value = saved.iceServers?.[0]?.credential || '';
    document.querySelector('#force-relay').checked = !!saved.forceRelay;
  } catch { /* storage may be unavailable */ }
  document.querySelector('#clear-settings').addEventListener('click', () => {
    sessionStorage.removeItem('p2p-ice-settings'); onReconnect();
  });
}
export async function senderId() {
  const key = 'p2p-sender-id'; let id = localStorage.getItem(key);
  if (!/^[a-f0-9]{32}$/.test(id || '')) { id = random.hex128(); localStorage.setItem(key, id); }
  return id;
}
export function updateFeatures() {
  const required = [
    ['secure context', globalThis.isSecureContext], ['Web Crypto', !!globalThis.crypto?.getRandomValues && !!globalThis.crypto?.subtle],
    ['Worker', typeof Worker !== 'undefined'], ['WebRTC data channels', typeof RTCPeerConnection !== 'undefined'],
    ['Web Locks', !!navigator.locks], ['TextEncoder', typeof TextEncoder !== 'undefined'], ['sessionStorage', (() => { try { sessionStorage.setItem('__check','1'); sessionStorage.removeItem('__check'); return true; } catch { return false; } })()]
  ];
  const missing = required.filter(([, ok]) => !ok).map(([name]) => name);
  document.querySelector('#feature-status').textContent = missing.length ? `Unsupported browser; required features missing: ${missing.join(', ')}` : 'Required browser features are available.';
  return missing.length === 0;
}
export function safeError(error) { return String(error?.message || error).replace(/[\r\n\0]/g, ' ').slice(0, 240); }
export function startPings(conn, showRtt) {
  const pending = new Map(); let seq = 0;
  const timer = setInterval(() => { if (conn.open) { const n = ++seq; pending.set(n, performance.now()); conn.send({ type: 'PING', seq: n }); } }, 5000);
  conn.on('data', data => { if (data?.type === 'PONG' && pending.has(data.seq)) { showRtt(Math.round(performance.now() - pending.get(data.seq))); pending.delete(data.seq); } });
  conn.on('close', () => clearInterval(timer));
}
