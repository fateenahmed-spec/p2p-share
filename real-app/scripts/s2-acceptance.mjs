import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { createServer, createConnection } from 'node:net';
import { chromium } from 'playwright';
import { makeTestFile } from './make-test-file.js';

const root = new URL('../', import.meta.url);
const cwd = decodeURIComponent(root.pathname.replace(/^\//, '').replaceAll('/', '\\'));
const scratch = `${cwd}scratch`, testFile = `${scratch}\\test-s2-32m.bin`, size = 32 * 1024 ** 2;
let browser, appServer, signalServer, appPort, signalPort, pages;
const logs = { app: [], signal: [] }, browserErrors = [];
function start(args, bucket, env) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.on('data', data => logs[bucket].push(data.toString())); child.stderr.on('data', data => logs[bucket].push(data.toString()));
  return child;
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
async function waitFor(url) {
  const until = Date.now() + 20000;
  while (Date.now() < until) { try { if ((await fetch(url)).ok) return; } catch { /* wait for local server */ } await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timed out waiting for ${url}`);
}
async function waitForPort(port) {
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    const connected = await new Promise(resolve => { const c = createConnection({ host: 'localhost', port }); c.once('connect', () => { c.destroy(); resolve(true); }); c.once('error', () => resolve(false)); });
    if (connected) return; await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for local PeerServer port ${port}`);
}

try {
  await mkdir(scratch, { recursive: true });
  const generated = await makeTestFile(testFile, size);
  appPort = await freePort(); do { signalPort = await freePort(); } while (signalPort === appPort);
  const env = { ...process.env, P2P_S2_ACCEPTANCE: '1', P2P_DEV_PORT: String(appPort), P2P_SIGNAL_PORT: String(signalPort) };
  signalServer = start(['scripts/local-signaling.mjs'], 'signal', env);
  appServer = start(['scripts/dev-server.mjs'], 'app', env);
  const appUrl = `http://127.0.0.1:${appPort}`;
  await waitFor(`${appUrl}/sender.html`); await waitForPort(signalPort);
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const context = await browser.newContext(), sender = await context.newPage(), receiver = await context.newPage(); pages = [sender, receiver];
  for (const page of pages) {
    page.on('pageerror', error => browserErrors.push(`${page.url()} pageerror: ${error.message}`));
    page.on('console', msg => { if (msg.type() === 'error') browserErrors.push(`${page.url()} console: ${msg.text()}`); });
    page.on('requestfailed', req => browserErrors.push(`${req.url()} requestfailed: ${req.failure()?.errorText}`));
    page.on('response', res => { if (res.status() >= 400) browserErrors.push(`${res.status()} ${res.url()}`); });
  }
  await sender.goto(`${appUrl}/sender.html`, { waitUntil: 'domcontentloaded' });
  await sender.waitForFunction(() => document.querySelector('#status')?.textContent === 'Ready. Select a file to share.', null, { timeout: 20000 });
  await sender.locator('#file').setInputFiles(testFile);
  await sender.locator('#share-link').waitFor({ state: 'visible', timeout: 60000 });
  const link = await sender.locator('#share-url').inputValue(), senderFileId = await sender.locator('#file-id').textContent();
  const receiverUrl = new URL(link); receiverUrl.searchParams.set('debug', '1'); receiverUrl.searchParams.set('debugSha256', generated.sha256);
  await receiver.goto(receiverUrl.href, { waitUntil: 'domcontentloaded' });
  let completed = false;
  for (let attempt = 0; attempt < 12 && !completed; attempt++) {
    try { await receiver.waitForFunction(() => document.querySelector('#status')?.dataset.transferComplete === 'true', null, { timeout: 10000 }); completed = true; }
    catch {
      const snapshots = await Promise.all(pages.map(page => page.evaluate(() => ({
        status: document.querySelector('#status')?.textContent,
        failed: document.querySelector('#status')?.dataset.failed,
        peers: document.querySelector('#peers')?.textContent,
        progress: document.querySelector('#transfer-progress')?.textContent,
      }))));
      console.log(`S2_PROGRESS ${JSON.stringify(snapshots)}`);
    }
  }
  if (!completed) throw new Error('S2 acceptance exceeded 120 seconds.');
  const report = {
    result: 'PASS', sizeBytes: generated.size, expectedSha256: generated.sha256,
    senderFileId, receiverSha256: await receiver.locator('#status').getAttribute('data-sha256'),
    receiverName: await receiver.locator('#file-name').textContent(), receiverSize: await receiver.locator('#file-size').textContent(),
    receiverStatus: await receiver.locator('#status').textContent(), transferMs: Number(await receiver.locator('#status').getAttribute('data-transfer-ms')),
    throughputMiBPerSecond: Number((await receiver.locator('#transfer-stats').textContent()).match(/([0-9.]+) MiB\/s/)?.[1]),
    peakInFlight: Number(await receiver.locator('#status').getAttribute('data-peak-in-flight')),
    maxInFlight: 8, chunkSizeBytes: 65536,
    senderChannels: await sender.locator('#peers').textContent(),
    receiverRtt: await receiver.locator('#rtt').textContent(), browser: await browser.version(),
    signaling: `local PeerServer on localhost:${signalPort}`, browserErrors,
  };
  if (report.receiverSha256 !== generated.sha256 || report.peakInFlight !== 8 || browserErrors.length) throw new Error(`Acceptance assertions failed: ${JSON.stringify(report)}`);
  console.log(`S2_ACCEPTANCE ${JSON.stringify(report, null, 2)}`);
  await context.close();
} catch (error) {
  console.error(error.stack || error);
  if (pages) for (const page of pages) console.error(`PAGE ${page.url()} ${JSON.stringify(await page.evaluate(() => ({ status: document.querySelector('#status')?.textContent, data: { ...document.querySelector('#status')?.dataset }, peers: document.querySelector('#peers')?.textContent, progress: document.querySelector('#transfer-progress')?.textContent, stats: document.querySelector('#transfer-stats')?.textContent })).catch(() => '(unavailable)'))}`);
  if (browserErrors.length) console.error(`BROWSER_ERRORS ${JSON.stringify(browserErrors)}`);
  if (logs.signal.length) console.error(`PEERSERVER_LOG\n${logs.signal.join('')}`);
  if (logs.app.length) console.error(`APP_LOG\n${logs.app.join('')}`);
  process.exitCode = 1;
} finally {
  if (browser) await Promise.race([browser.close(), new Promise(resolve => setTimeout(resolve, 2000))]);
  appServer?.kill(); signalServer?.kill(); await rm(scratch, { recursive: true, force: true });
}
