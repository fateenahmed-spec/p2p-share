import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const types = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json','.map':'application/json' };
createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (path === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    const acceptance = process.env.P2P_S1_ACCEPTANCE === '1' || process.env.P2P_S2_ACCEPTANCE === '1';
    if (path === '/config.local.json' && acceptance) {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control':'no-store' });
      res.end(JSON.stringify({ signaling: { host: 'localhost', port: Number(process.env.P2P_SIGNAL_PORT || 9001), path: '/', key: 'peerjs', secure: false }, iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }));
      return;
    }
    const file = resolve(root, '.' + path);
    if (file !== root && !file.startsWith(root + sep)) throw new Error('forbidden');
    let body = await readFile(file);
    if (acceptance && (path === '/sender.html' || path === '/receiver.html')) {
      const signalPort = Number(process.env.P2P_SIGNAL_PORT);
      body = Buffer.from(body.toString('utf8').replace('http://localhost:9001 ws://localhost:9001', `http://localhost:${signalPort} ws://localhost:${signalPort}`));
    }
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control':'no-store' }); res.end(body);
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(Number(process.env.P2P_DEV_PORT || 9000), '127.0.0.1', () => console.log(`App at http://127.0.0.1:${process.env.P2P_DEV_PORT || 9000}/sender.html`));
