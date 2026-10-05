import { spawn, execFileSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { createServer, createConnection } from 'node:net';
import { chromium } from 'playwright';
import { makeTestFile } from './make-test-file.js';

const root = new URL('../', import.meta.url);
const cwd = decodeURIComponent(root.pathname.replace(/^\//, '').replaceAll('/', '\\'));
const scratch = `${cwd}scratch`, size = Number(process.env.P2P_S4_TEST_SIZE || 500 * 1024 ** 2);
const receiverCount = Number(process.env.P2P_S4_RECEIVERS || 3);
const uploadLimitKiB = Number(process.env.P2P_S4_UPLOAD_LIMIT_KIB || 10240);
const isolationOnly = process.env.P2P_S4_ISOLATION === '1';
const sourcePath = `${scratch}\\test-s4-500m.bin`;
const closeTestPath = `${scratch}\\test-s4-close-500m.bin`;
const receiverPaths = [0, 1, 2].map(index => `${scratch}\\download-s4-${index}.bin`);
const logs = { app: [], signal: [] }, contexts = [], pages = [], browsers = new Set(), memorySamples = [];
let appServer, signalServer, appPort, signalPort, sampling = true, peakCountedBytes = 0, monitor;
function start(args, bucket, env) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.on('data', data => logs[bucket].push(data.toString())); child.stderr.on('data', data => logs[bucket].push(data.toString())); return child;
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port; await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); return port;
}
async function waitFor(url) {
  const until = Date.now() + 20000;
  while (Date.now() < until) { try { if ((await fetch(url)).ok) return; } catch { /* local server starting */ } await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timed out waiting for ${url}`);
}
async function waitForPort(port) {
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    const ok = await new Promise(resolve => { const socket = createConnection({ host: 'localhost', port }); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); });
    if (ok) return; await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for local PeerServer port ${port}`);
}
async function waitForPage(page, predicate, timeout = 15 * 60 * 1000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const receiver = await page.evaluate(() => ({ failed: document.querySelector('#status')?.dataset.failed === 'true', status: document.querySelector('#status')?.textContent, verifiedBytes: document.querySelector('#status')?.dataset.verifiedBytes, requestCount: document.querySelector('#status')?.dataset.requestCount, inFlight: document.querySelector('#status')?.dataset.inFlight }));
    if (receiver.failed) throw new Error(`Receiver transfer failed: ${JSON.stringify(receiver)}`);
    if (await page.evaluate(predicate)) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Timed out waiting for receiver condition.');
}
function externalSha256(path) {
  const literal = path.replaceAll("'", "''");
  return execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-FileHash -Algorithm SHA256 -LiteralPath '${literal}').Hash.ToLowerInvariant()`], { encoding: 'utf8' }).trim();
}
async function chromeWorkingSetMiB() {
  const pids = new Set();
  for (const browser of browsers) {
    try {
      const cdp = await browser.newBrowserCDPSession();
      for (const item of (await cdp.send('SystemInfo.getProcessInfo')).processInfo) if (Number.isSafeInteger(item.id)) pids.add(item.id);
      await cdp.detach();
    } catch { /* process info is diagnostic only */ }
  }
  if (!pids.size) return null;
  try {
    const ids = [...pids].join(',');
    const value = execFileSync('powershell.exe', ['-NoProfile', '-Command', `$chromeProcSet = Get-Process -Id ${ids} -ErrorAction SilentlyContinue; [math]::Round(($chromeProcSet | Measure-Object -Property WorkingSet64 -Sum).Sum / 1MB, 1)`], { encoding: 'utf8' }).trim();
    const mib = Number(value); return Number.isFinite(mib) ? mib : null;
  } catch { return null; }
}
function attachDiagnostics(page) {
  page.on('pageerror', error => logs.app.push(`pageerror ${page.url()}: ${error.message}`));
  page.on('console', message => { if (message.type() === 'warning' || message.type() === 'error') logs.app.push(`console ${message.type()} ${page.url()}: ${message.text()}`); });
  page.on('requestfailed', req => { if (!req.url().includes('localhost:9001')) logs.app.push(`requestfailed ${req.url()}: ${req.failure()?.errorText}`); });
}
try {
  await mkdir(scratch, { recursive: true });
  const generated = await makeTestFile(sourcePath, size);
  const closeTest = isolationOnly ? undefined : await makeTestFile(closeTestPath, size);
  appPort = await freePort(); do { signalPort = await freePort(); } while (signalPort === appPort);
  const env = { ...process.env, P2P_S3_ACCEPTANCE: '1', P2P_DEV_PORT: String(appPort), P2P_SIGNAL_PORT: String(signalPort) };
  signalServer = start(['scripts/local-signaling.mjs'], 'signal', env); appServer = start(['scripts/dev-server.mjs'], 'app', env);
  const origin = `http://127.0.0.1:${appPort}`; await waitFor(`${origin}/sender.html`); await waitForPort(signalPort);

  const senderBrowser = await chromium.launch({ headless: true, channel: 'chrome' }); browsers.add(senderBrowser);
  const senderContext = await senderBrowser.newContext({ acceptDownloads: true }); contexts.push(senderContext);
  const sender = await senderContext.newPage(); pages.push(sender); attachDiagnostics(sender);
  await sender.goto(`${origin}/sender.html${isolationOnly ? '?debug=1' : ''}`, { waitUntil: 'domcontentloaded' });
  await sender.waitForFunction(() => document.querySelector('#status')?.textContent === 'Ready. Select a file to share.', null, { timeout: 20000 });
  await sender.locator('#upload-limit').fill(String(uploadLimitKiB)); await sender.locator('#upload-limit').dispatchEvent('change');
  await sender.locator('#file').setInputFiles(sourcePath); await sender.locator('#share-link').waitFor({ state: 'visible', timeout: 10 * 60 * 1000 });
  const shareUrl = new URL(await sender.locator('#share-url').inputValue());
  if (isolationOnly) shareUrl.searchParams.set('debug', '1');
  const shareLink = shareUrl.href;

  const receiverLinks = [];
  for (let index = 0; index < receiverCount; index++) {
    const dataDir = `${scratch}\\chrome-profile-${index}`;
    const context = await chromium.launchPersistentContext(dataDir, {
      channel: 'chrome', headless: false, acceptDownloads: true,
      viewport: { width: 600, height: 850 },
      args: [`--window-size=620,920`, `--window-position=${index * 630},0`, '--no-first-run', '--no-default-browser-check'],
    });
    contexts.push(context); const browser = context.browser(); if (browser) browsers.add(browser);
    const page = context.pages()[0] || await context.newPage(); pages.push(page); attachDiagnostics(page);
    await page.goto(shareLink, { waitUntil: 'domcontentloaded' });
    await waitForPage(page, () => document.querySelector('#status')?.dataset.missingChunks !== undefined, 60000);
    receiverLinks.push(page);
  }
  await sender.locator('#peers .receiver-row').first().waitFor({ state: 'visible', timeout: 30000 });
  await sender.waitForFunction(count => document.querySelectorAll('#peers .receiver-row').length === count, receiverCount, { timeout: 60000, polling: 200 });

  const transferredPayloads = [];
  monitor = (async () => {
    while (sampling) {
      try {
        const count = Number(await sender.locator('#byte-counts').textContent()); peakCountedBytes = Math.max(peakCountedBytes, count || 0);
        const memory = await chromeWorkingSetMiB(); if (memory !== null) memorySamples.push(memory);
        const sent = Number(await sender.locator('#status').getAttribute('data-uploaded-payload-bytes')); if (Number.isFinite(sent)) transferredPayloads.push({ at: Date.now(), bytes: sent });
      } catch { /* page may be closing at test end */ }
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  })();

  const firstPhaseStart = Number(await sender.locator('#status').getAttribute('data-uploaded-payload-bytes')) || 0;
  await Promise.all(receiverLinks.map(page => waitForPage(page, () => document.querySelector('#status')?.dataset.transferComplete === 'true', 20 * 60 * 1000)));
  const firstPhaseEnd = Number(await sender.locator('#status').getAttribute('data-uploaded-payload-bytes'));
  const firstHashes = [];
  for (let index = 0; index < receiverCount; index++) {
    const downloadEvent = receiverLinks[index].waitForEvent('download', { timeout: 120000 });
    await receiverLinks[index].locator('#download-file').click();
    const download = await downloadEvent; await download.saveAs(receiverPaths[index]);
    firstHashes.push({ receiver: index + 1, sha256: externalSha256(receiverPaths[index]) });
  }
  const firstSamples = transferredPayloads.filter(sample => sample.bytes >= firstPhaseStart && sample.bytes <= firstPhaseEnd);
  const firstElapsedMs = firstSamples.length > 1 ? firstSamples.at(-1).at - firstSamples[0].at : 0;
  const firstPhaseRateMiBPerSecond = firstElapsedMs > 0 ? (firstPhaseEnd - firstPhaseStart) / 1024 ** 2 / (firstElapsedMs / 1000) : null;

  if (isolationOnly) {
    sampling = false; await monitor;
    const report = { result: firstHashes.every(item => item.sha256 === generated.sha256) ? 'PASS' : 'FAIL_HASH', fileBytes: size, expectedSha256: generated.sha256, receivers: receiverCount, uploadLimitKiBPerSecond: uploadLimitKiB || 'unlimited', receiverHashes: firstHashes, aggregatePayloadMiBPerSecond: firstPhaseRateMiBPerSecond, receiverStatuses: await Promise.all(receiverLinks.map(page => page.locator('#status').evaluate(element => ({ status: element.textContent, verifiedBytes: element.dataset.verifiedBytes, requestCount: element.dataset.requestCount, failed: element.dataset.failed })))) };
    if (report.result !== 'PASS') throw new Error(JSON.stringify(report));
    console.log(`S4_ISOLATION ${JSON.stringify(report, null, 2)}`);
  } else {
  const firstFileId = await sender.locator('#file-id').textContent();
  await sender.locator('#file').setInputFiles(closeTestPath);
  await sender.waitForFunction(oldId => document.querySelector('#share-link') && document.querySelector('#file-id')?.textContent !== oldId, firstFileId, { timeout: 10 * 60 * 1000 });
  const closeLink = await sender.locator('#share-url').inputValue();
  const closeFileId = await sender.locator('#file-id').textContent();
  for (const page of receiverLinks) {
    await page.goto(closeLink, { waitUntil: 'domcontentloaded' });
    await waitForPage(page, () => document.querySelector('#status')?.dataset.missingChunks !== undefined, 60000);
  }
  await waitForPage(sender, () => document.querySelectorAll('#peers .receiver-row:not(.disconnected)').length >= 3, 60000);
  await waitForPage(receiverLinks[0], () => Number(document.querySelector('#status')?.dataset.verifiedBytes || 0) >= 250 * 1024 ** 2, 15 * 60 * 1000);
  const closedBytes = Number(await receiverLinks[0].locator('#status').getAttribute('data-verified-bytes'));
  await receiverLinks[0].close();
  await waitForPage(sender, () => [...document.querySelectorAll('#peers .receiver-row')].some(row => row.classList.contains('disconnected') && row.dataset.activeSends === '0' && row.dataset.reservedBytes === '0'), 30000);
  const disconnectedRow = await sender.locator('#peers .receiver-row.disconnected').first().evaluate(row => ({ id: row.querySelector('code')?.textContent, activeSends: row.dataset.activeSends, reservedBytes: row.dataset.reservedBytes, activity: row.textContent }));

  await Promise.all([1, 2].map(index => waitForPage(receiverLinks[index], () => document.querySelector('#status')?.dataset.transferComplete === 'true', 20 * 60 * 1000)));
  const remainingHashes = [];
  for (const index of [1, 2]) {
    const downloadEvent = receiverLinks[index].waitForEvent('download', { timeout: 120000 });
    await receiverLinks[index].locator('#download-file').click();
    const download = await downloadEvent; await download.saveAs(receiverPaths[index]);
    remainingHashes.push({ receiver: index + 1, sha256: externalSha256(receiverPaths[index]) });
  }
  sampling = false; await monitor;
  const finalPayloadBytes = Number(await sender.locator('#status').getAttribute('data-uploaded-payload-bytes'));
  const secondSamples = transferredPayloads.filter(sample => sample.bytes >= firstPhaseEnd);
  const secondElapsedMs = secondSamples.length > 1 ? secondSamples.at(-1).at - secondSamples[0].at : 0;
  const secondPhaseRateMiBPerSecond = secondElapsedMs > 0 ? (finalPayloadBytes - firstPhaseEnd) / 1024 ** 2 / (secondElapsedMs / 1000) : null;
  const report = {
    result: 'PASS', fileBytes: size, expectedSha256: generated.sha256, firstRunReceiversFinished: 3,
    firstRunHashes: firstHashes, firstRunAggregatePayloadMiBPerSecond: firstPhaseRateMiBPerSecond,
    closeRunFileIdChanged: closeFileId !== firstFileId, closeRunExpectedSha256: closeTest.sha256,
    closeRunRemainingReceiverHashes: remainingHashes,
    closedReceiver: { durableBytesAtClose: closedBytes, row: disconnectedRow, remainingReceiversContinued: true },
    uploadLimitInputKiBPerSecond: 10240, intendedCapMiBPerSecond: 10,
    closeRunAggregatePayloadMiBPerSecond: secondPhaseRateMiBPerSecond, senderPayloadBytesQueued: finalPayloadBytes,
    peakCountedSenderBytes: peakCountedBytes, peakChromeWorkingSetMiB: memorySamples.length ? Math.max(...memorySamples) : null,
    measurement: 'Three headed Chrome receiver windows at x=0,630,1260; each uses an independent persistent profile. Sender is headless. Downloaded hashes use Get-FileHash.',
    chrome: await senderBrowser.version(), browserErrors: logs.app,
  };
  if (firstHashes.some(item => item.sha256 !== generated.sha256) || remainingHashes.some(item => item.sha256 !== closeTest.sha256) || closeTest.sha256 !== generated.sha256) report.result = 'FAIL_HASH';
  if (report.result !== 'PASS') throw new Error(JSON.stringify(report));
  console.log(`S4_ACCEPTANCE ${JSON.stringify(report, null, 2)}`);
  }
} catch (error) {
  console.error(`S4_ACCEPTANCE_BLOCKED_OR_FAILED ${error.stack || error}`);
  for (const page of pages) console.error(`PAGE ${page.url()} ${JSON.stringify(await page.evaluate(() => ({ status: document.querySelector('#status')?.textContent, data: { ...document.querySelector('#status')?.dataset }, progress: document.querySelector('#transfer-progress')?.textContent })).catch(() => '(unavailable)'))}`);
  if (logs.signal.length) console.error(`PEERSERVER_LOG\n${logs.signal.join('')}`);
  if (logs.app.length) console.error(`APP_LOG\n${logs.app.join('')}`);
  process.exitCode = 1;
} finally {
  sampling = false; if (monitor) await monitor.catch(() => {});
  for (const context of contexts.reverse()) await context.close().catch(() => {});
  for (const browser of browsers) await browser.close().catch(() => {});
  appServer?.kill(); signalServer?.kill(); await rm(scratch, { recursive: true, force: true });
}
