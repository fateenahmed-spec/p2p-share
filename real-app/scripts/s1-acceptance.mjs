import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { createServer, createConnection } from 'node:net';
import { chromium } from 'playwright';
import { makeTestFile } from './make-test-file.js';

const root = new URL('../', import.meta.url);
const cwd = decodeURIComponent(root.pathname.replace(/^\//, '').replaceAll('/', '\\'));
const scratch = `${cwd}scratch`;
const testFile = `${scratch}\\test-5mb.bin`;
let browser, appServer, signalServer;
const logs = { app: [], signal: [] };
const browserErrors = [];
let pages;
let appPort, signalPort;

function start(command, args, bucket, env = process.env) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.on('data', data => logs[bucket].push(data.toString()));
  child.stderr.on('data', data => logs[bucket].push(data.toString()));
  return child;
}
async function waitFor(url) {
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    try { const response = await fetch(url); if (response.ok) return; } catch { /* retry startup */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out starting ${url}`);
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
async function waitForPort(host, port) {
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    const connected = await new Promise(resolve => {
      const connection = createConnection({ host, port });
      connection.once('connect', () => { connection.destroy(); resolve(true); });
      connection.once('error', () => resolve(false));
    });
    if (connected) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${host}:${port}`);
}
try {
  await mkdir(scratch, { recursive: true });
  const generatedInfo = await makeTestFile(testFile, 5 * 1024 * 1024);
  appPort = await freePort();
  do { signalPort = await freePort(); } while (signalPort === appPort);
  signalServer = start(process.execPath, ['scripts/local-signaling.mjs'], 'signal', { ...process.env, P2P_SIGNAL_PORT: String(signalPort) });
  appServer = start(process.execPath, ['scripts/dev-server.mjs'], 'app', { ...process.env, P2P_S1_ACCEPTANCE: '1', P2P_DEV_PORT: String(appPort), P2P_SIGNAL_PORT: String(signalPort) });
  const appUrl = `http://127.0.0.1:${appPort}`;
  await waitFor(`${appUrl}/sender.html`);
  await waitForPort('localhost', signalPort);
  const localConfigResponse = await fetch(`${appUrl}/config.local.json`);
  if (!localConfigResponse.ok) throw new Error(`Temporary local signaling config returned HTTP ${localConfigResponse.status}.`);
  const effectiveConfig = await localConfigResponse.json();
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const context = await browser.newContext();
  const sender = await context.newPage();
  const receiver = await context.newPage();
  pages = [sender, receiver];
  for (const page of [sender, receiver]) {
    page.on('pageerror', error => browserErrors.push(`${page.url()} pageerror: ${error.message}`));
    page.on('console', message => { if (message.type() === 'error') browserErrors.push(`${page.url()} console: ${message.text()}`); });
    page.on('requestfailed', request => browserErrors.push(`${request.url()} requestfailed: ${request.failure()?.errorText}`));
    page.on('response', response => { if (response.status() >= 400) browserErrors.push(`${response.status()} ${response.url()}`); });
  }
  await sender.goto(`${appUrl}/sender.html`, { waitUntil: 'domcontentloaded' });
  await sender.waitForTimeout(1000);
  console.log(JSON.stringify({ senderPage: await sender.evaluate(() => ({ status: document.querySelector('#status')?.textContent, features: document.querySelector('#feature-status')?.textContent, href: location.href })), signalingConfig: effectiveConfig.signaling, initialErrors: [...browserErrors] }));
  await sender.waitForFunction(() => document.querySelector('#status')?.textContent === 'Ready. Select a file to share.', null, { timeout: 10000 });
  await sender.locator('#file').setInputFiles(testFile);
  await sender.locator('#share-link').waitFor({ state: 'visible', timeout: 30000 });
  const link = await sender.locator('#share-url').inputValue();
  const fileId = await sender.locator('#file-id').textContent();
  await receiver.goto(link);
  await receiver.waitForFunction(() => document.querySelector('#status')?.textContent === 'Manifest verified; control and bulk channels paired.', null, { timeout: 30000 });
  await sender.waitForFunction(() => /control \+ bulk paired; BITFIELD/.test(document.querySelector('#peers')?.textContent || ''), null, { timeout: 15000 });
  await receiver.waitForFunction(() => document.querySelector('#rtt')?.textContent !== '—', null, { timeout: 15000 });
  if (browserErrors.length) throw new Error(`Browser errors: ${browserErrors.join(' | ')}`);
  const report = {
    result: 'PASS', file: generatedInfo.file, sizeBytes: generatedInfo.size, expectedSha256: generatedInfo.sha256,
    senderFileId: fileId, receiverRoom: new URL(link).searchParams.get('room'),
    receiverName: await receiver.locator('#file-name').textContent(),
    receiverSize: await receiver.locator('#file-size').textContent(),
    receiverStatus: await receiver.locator('#status').textContent(),
    manifestParts: await receiver.locator('#status').getAttribute('data-manifest-parts'),
    manifestBytes: await receiver.locator('#status').getAttribute('data-manifest-bytes'),
    senderPeerStatus: await sender.locator('#peers').textContent(),
    controlRtt: await receiver.locator('#rtt').textContent(),
    browser: await browser.version(), signaling: `local PeerServer on localhost:${signalPort}`,
  };
  console.log(JSON.stringify(report, null, 2));
  await context.close();
} catch (error) {
  console.error(error.stack || error);
  if (pages) for (const page of pages) console.error(`Page ${page.url()} snapshot=${JSON.stringify(await page.evaluate(() => ({ status: document.querySelector('#status')?.textContent, features: document.querySelector('#feature-status')?.textContent })).catch(() => '(unavailable)'))}`);
  if (browserErrors.length) console.error(`Browser errors: ${browserErrors.join(' | ')}`);
  if (logs.signal.length) console.error(`PeerServer log:\n${logs.signal.join('')}`);
  if (logs.app.length) console.error(`App server log:\n${logs.app.join('')}`);
  process.exitCode = 1;
} finally {
  if (browser) await Promise.race([browser.close(), new Promise(resolve => setTimeout(resolve, 2000))]);
  appServer?.kill(); signalServer?.kill();
  await rm(scratch, { recursive: true, force: true });
}
