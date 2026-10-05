import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from 'playwright';

const root = new URL('../', import.meta.url);
const cwd = decodeURIComponent(root.pathname.replace(/^\//, '').replaceAll('/', '\\'));
const logs = [];
let server, browser, port;
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject).listen(0, '127.0.0.1', () => {
      const value = probe.address().port; probe.close(error => error ? reject(error) : resolve(value));
    });
  });
}
async function waitFor(url) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { try { if ((await fetch(url)).ok) return; } catch { /* server starting */ } await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timed out waiting for ${url}`);
}
try {
  port = await freePort();
  server = spawn(process.execPath, ['scripts/dev-server.mjs'], { cwd, env: { ...process.env, P2P_DEV_PORT: String(port), P2P_S3_ACCEPTANCE: '1', P2P_SIGNAL_PORT: '9001' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  server.stdout.on('data', data => logs.push(data.toString())); server.stderr.on('data', data => logs.push(data.toString()));
  const origin = `http://127.0.0.1:${port}`;
  await waitFor(`${origin}/sender.html`);
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage(); await page.goto(`${origin}/sender.html?debug=1`, { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async () => {
    const storageEstimate = await navigator.storage.estimate().catch(error => ({ error: String(error) }));
    const worker = new Worker('./src/workers/opfs-worker.js', { type: 'module' });
    const logs = [];
    const waitForType = type => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${type} timed out`)), 150000);
      const listener = event => { if (event.data?.type === 'DEBUG_LOG') logs.push(event.data.entry); if (event.data?.type !== type) return; clearTimeout(timer); worker.removeEventListener('message', listener); resolve(event.data); };
      worker.addEventListener('message', listener);
    });
    worker.postMessage({ type: 'PHASE1' }); const phase1 = await waitForType('PHASE1_RESULT');
    if (!phase1.ok) return { phase1, ok: false, blocked: 'phase 1 unavailable' };
    worker.postMessage({ type: 'PHASE2', token: crypto.randomUUID().replaceAll('-', '') }); const phase2 = await waitForType('PHASE2_RESULT');
    if (!phase2.ok) return { phase1, phase2, ok: false, blocked: 'phase 2 failed' };
    worker.postMessage({ type: 'DEBUG_OFFSET_PROBE' }); const probe = await waitForType('OFFSET_PROBE_RESULT');
    worker.postMessage({ type: 'DEBUG_OFFSET_PROBE', targetSize: 4_000_000_000, offset: 3_999_999_000 }); const under4GiB = await waitForType('OFFSET_PROBE_RESULT');
    worker.terminate(); return { userAgent: navigator.userAgent, storageEstimate, phase1, phase2, probe, under4GiB, logs };
  });
  console.log(`S3_OFFSET_PROBE ${JSON.stringify(result)}`);
} catch (error) {
  console.error(`S3_OFFSET_PROBE_BLOCKED ${error?.stack || error}`);
  if (logs.length) console.error(`DEV_SERVER_LOG ${logs.join('')}`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  if (server && !server.killed) { server.kill(); await new Promise(resolve => { server.once('exit', resolve); setTimeout(resolve, 2000).unref(); }); }
}
