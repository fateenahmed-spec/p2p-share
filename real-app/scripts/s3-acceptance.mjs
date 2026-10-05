import { spawn, execFileSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { createServer, createConnection } from 'node:net';
import { chromium } from 'playwright';
import { makeTestFile } from './make-test-file.js';

const root = new URL('../', import.meta.url);
const cwd = decodeURIComponent(root.pathname.replace(/^\//, '').replaceAll('/', '\\'));
const scratch = `${cwd}scratch`, testFile = `${scratch}\\test-s3-500m.bin`, size = Number(process.env.P2P_S3_TEST_SIZE || 500 * 1024 ** 2);
const logs = { app: [], signal: [] }, browserErrors = [], memorySamples = [];
let appServer, signalServer, browser, appPort, signalPort, contexts = [], pages = [], sampling = true;
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
    const connected = await new Promise(resolve => { const c = createConnection({ host: 'localhost', port }); c.once('connect', () => { c.destroy(); resolve(true); }); c.once('error', () => resolve(false)); });
    if (connected) return; await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for local PeerServer port ${port}`);
}
async function waitCondition(page, predicate, timeoutMs, label, progress = false, argument = undefined) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await page.waitForFunction(predicate, argument, { timeout: 15000 }); return; }
    catch (error) {
      if (error.name !== 'TimeoutError' && !String(error.message).includes('Timeout')) throw error;
      if (progress) console.log(`S3_PROGRESS ${label} ${JSON.stringify(await page.evaluate(() => ({ status: document.querySelector('#status')?.textContent, verifiedBytes: document.querySelector('#status')?.dataset.verifiedBytes, requested: document.querySelector('#status')?.dataset.requestCount, missing: document.querySelector('#status')?.dataset.missingChunks, queueBytes: document.querySelector('#status')?.dataset.queueBytes })))}`);
    }
  }
  throw new Error(`Timed out waiting for ${label}`);
}
function externalSha256(path) {
  if (process.platform === 'win32') {
    const literal = path.replaceAll("'", "''");
    return execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-FileHash -Algorithm SHA256 -LiteralPath '${literal}').Hash.ToLowerInvariant()`], { encoding: 'utf8' }).trim();
  }
  return execFileSync('sha256sum', [path], { encoding: 'utf8' }).trim().split(/\s+/)[0].toLowerCase();
}
function startMemorySampler(browserInstance) {
  return (async () => {
    let pids = [];
    try {
      const cdp = await browserInstance.newBrowserCDPSession();
      const info = await cdp.send('SystemInfo.getProcessInfo');
      pids = info.processInfo.map(item => item.id).filter(Number.isSafeInteger);
      await cdp.detach();
    } catch { /* browser build may not expose process details */ }
    while (sampling) {
      if (pids.length && process.platform === 'win32') {
        try {
          const ids = pids.join(',');
          const value = execFileSync('powershell.exe', ['-NoProfile', '-Command', `$chromeProcSet = Get-Process -Id ${ids} -ErrorAction SilentlyContinue; [math]::Round(($chromeProcSet | Measure-Object -Property WorkingSet64 -Sum).Sum / 1MB, 1)`], { encoding: 'utf8' }).trim();
          const mib = Number(value); if (Number.isFinite(mib)) memorySamples.push({ at: Date.now(), workingSetMiB: mib });
        } catch { /* best-effort process working-set sample */ }
      }
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  })();
}
function median(values) { const xs = [...values].sort((a, b) => a - b); return xs.length ? xs[Math.floor(xs.length / 2)] : null; }

try {
  if (!Number.isSafeInteger(size) || size <= 0 || size > 2 * 1024 ** 3) throw new Error('Acceptance file size must be positive and no larger than 2 GiB.');
  await mkdir(scratch, { recursive: true });
  console.log(`S3_SETUP generating ${size} byte streaming test file and SHA-256…`);
  const generated = await makeTestFile(testFile, size);
  appPort = await freePort(); do { signalPort = await freePort(); } while (signalPort === appPort);
  const env = { ...process.env, P2P_S3_ACCEPTANCE: '1', P2P_DEV_PORT: String(appPort), P2P_SIGNAL_PORT: String(signalPort) };
  signalServer = start(['scripts/local-signaling.mjs'], 'signal', env); appServer = start(['scripts/dev-server.mjs'], 'app', env);
  const appUrl = `http://127.0.0.1:${appPort}`;
  await waitFor(`${appUrl}/sender.html`); await waitForPort(signalPort);
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const context = await browser.newContext({ acceptDownloads: true }); contexts.push(context);
  const sender = await context.newPage(); pages.push(sender);
  for (const page of pages) {
    page.on('pageerror', error => browserErrors.push(`${page.url()} pageerror: ${error.message}`));
    page.on('console', msg => { if (msg.type() === 'error') browserErrors.push(`${page.url()} console: ${msg.text()}`); });
    page.on('requestfailed', req => browserErrors.push(`${req.url()} requestfailed: ${req.failure()?.errorText}`));
    page.on('response', res => { if (res.status() >= 400) browserErrors.push(`${res.status()} ${res.url()}`); });
  }
  const memoryTask = startMemorySampler(browser);
  await sender.goto(`${appUrl}/sender.html`, { waitUntil: 'domcontentloaded' });
  await sender.waitForFunction(() => document.querySelector('#status')?.textContent === 'Ready. Select a file to share.', null, { timeout: 20000 });
  const hashStarted = await sender.evaluate(() => performance.now());
  await sender.locator('#file').setInputFiles(testFile);
  await sender.locator('#share-link').waitFor({ state: 'visible', timeout: 10 * 60 * 1000 });
  const hashingMs = (await sender.evaluate(() => performance.now())) - hashStarted;
  const link = await sender.locator('#share-url').inputValue(), senderFileId = await sender.locator('#file-id').textContent();
  const linked = new URL(link); linked.searchParams.set('debug', '1'); linked.searchParams.set('debugSha256', generated.sha256);
  const receiver = await context.newPage(); pages.push(receiver);
  receiver.on('pageerror', error => browserErrors.push(`${receiver.url()} pageerror: ${error.message}`));
  receiver.on('console', msg => { if (msg.type() === 'error') browserErrors.push(`${receiver.url()} console: ${msg.text()}`); });
  receiver.on('requestfailed', req => browserErrors.push(`${req.url()} requestfailed: ${req.failure()?.errorText}`));
  receiver.on('response', res => { if (res.status() >= 400) browserErrors.push(`${res.status()} ${res.url()}`); });
  await receiver.goto(linked.href, { waitUntil: 'domcontentloaded' });
  await receiver.waitForFunction(() => document.querySelector('#status')?.dataset.missingChunks !== undefined, null, { timeout: 60000 });
  await waitCondition(receiver, fileSize => Number(document.querySelector('#status')?.dataset.verifiedBytes || 0) >= Math.floor(fileSize / 2), 15 * 60 * 1000, 'initial 50% durable resume point', true, size);
  const firstCutBytes = Number(await receiver.locator('#status').getAttribute('data-verified-bytes'));
  const firstCutChunks = Number(await receiver.locator('#status').getAttribute('data-request-count'));
  const firstRequestAt = Date.now();
  await receiver.close();
  console.log(`S3_PROGRESS receiver closed at ${firstCutBytes}/${size} durable bytes after ${firstCutChunks} requests.`);

  const resumed = await context.newPage(); pages.push(resumed);
  for (const page of [resumed]) {
    page.on('pageerror', error => browserErrors.push(`${page.url()} pageerror: ${error.message}`));
    page.on('console', msg => { if (msg.type() === 'error') browserErrors.push(`${page.url()} console: ${msg.text()}`); });
    page.on('requestfailed', req => browserErrors.push(`${req.url()} requestfailed: ${req.failure()?.errorText}`));
    page.on('response', res => { if (res.status() >= 400) browserErrors.push(`${res.status()} ${res.url()}`); });
  }
  await resumed.goto(linked.href, { waitUntil: 'domcontentloaded' });
  await resumed.waitForFunction(() => document.querySelector('#status')?.dataset.missingChunks !== undefined, null, { timeout: 10 * 60 * 1000 });
  const resumedChunks = Number(await resumed.locator('#status').getAttribute('data-resumed-chunks'));
  const missingChunks = Number(await resumed.locator('#status').getAttribute('data-missing-chunks'));
  await waitCondition(resumed, () => document.querySelector('#status')?.dataset.transferComplete === 'true', 20 * 60 * 1000, 'resumed transfer completion', true);
  const reconnectRequestCount = Number(await resumed.locator('#status').getAttribute('data-request-count'));
  const totalElapsedMs = Date.now() - firstRequestAt;
  if (reconnectRequestCount !== missingChunks) throw new Error(`Resume requested ${reconnectRequestCount} chunks; expected exactly ${missingChunks} missing chunks.`);

  const downloadPath = `${scratch}\\downloaded-s3.bin`;
  const downloadWait = resumed.waitForEvent('download', { timeout: 120000 });
  await resumed.locator('#download-file').click();
  const download = await downloadWait; await download.saveAs(downloadPath);
  const externalHash = externalSha256(downloadPath);
  if (externalHash !== generated.sha256) throw new Error(`External download hash mismatch: ${externalHash} != ${generated.sha256}`);

  const verifyStarted = Date.now();
  await resumed.locator('#verify-file').click();
  await resumed.waitForFunction(() => document.querySelector('#verify-status')?.textContent?.startsWith('Whole-file chunk verification passed'), null, { timeout: 15 * 60 * 1000 });
  const verifyDurationMs = Date.now() - verifyStarted;

  const originEstimate = await resumed.evaluate(() => navigator.storage.estimate());
  let offsetProbe;
  if (originEstimate.quota < 6 * 1024 ** 3) offsetProbe = { result: 'SKIP', reason: `origin quota ${originEstimate.quota} bytes is below 6 GiB` };
  else {
    await resumed.locator('#offset-probe').click();
    await resumed.waitForFunction(() => document.querySelector('#status')?.dataset.offsetProbe, null, { timeout: 120000 });
    offsetProbe = JSON.parse(await resumed.locator('#status').getAttribute('data-offset-probe'));
  }

  await resumed.reload({ waitUntil: 'domcontentloaded' });
  await waitCondition(resumed, () => document.querySelector('#status')?.dataset.transferComplete === 'true', 10 * 60 * 1000, 'completed receiver reopen');
  const reopened = {
    status: await resumed.locator('#status').textContent(),
    verifiedChunks: Number(await resumed.locator('#status').getAttribute('data-resumed-chunks')),
    missingChunks: Number(await resumed.locator('#status').getAttribute('data-missing-chunks')),
    requestCount: Number(await resumed.locator('#status').getAttribute('data-request-count')),
    senderShows: await sender.locator('#peers').textContent(),
  };
  if (reopened.missingChunks !== 0 || reopened.requestCount !== 0 || !/100\.0%/.test(reopened.senderShows)) throw new Error(`Completed reopen failed: ${JSON.stringify(reopened)}`);

  let diskFull;
  if (process.env.P2P_S3_SKIP_QUOTA === '1') {
    diskFull = { result: 'BLOCKED (tooling)', reason: 'CDP Storage.overrideQuotaForOrigin failed in Chrome: Protocol error (Storage.overrideQuotaForOrigin): Internal error. Page-scoped attempts left navigator.storage.estimate() at the default quota and did not trigger the preflight.' };
  } else {
    const quotaCdp = await browser.newBrowserCDPSession();
    await quotaCdp.send('Storage.overrideQuotaForOrigin', { origin: appUrl, quotaSize: 64 * 1024 ** 2 });
    const quotaCheck = await quotaCdp.send('Storage.getUsageAndQuota', { origin: appUrl });
    console.log(`S3_QUOTA_CDP ${JSON.stringify(quotaCheck)}`);
    if (!quotaCheck.overrideActive || quotaCheck.quota > 64 * 1024 ** 2) throw new Error(`CDP quota override did not take effect: ${JSON.stringify(quotaCheck)}`);
    await resumed.reload({ waitUntil: 'domcontentloaded' });
    await resumed.waitForFunction(() => document.querySelector('#status')?.textContent?.startsWith('Insufficient origin storage'), null, { timeout: 60000 });
    diskFull = {
      result: 'PASS: preflight stopped before REQUEST',
      status: await resumed.locator('#status').textContent(),
      requestCount: Number(await resumed.locator('#status').getAttribute('data-request-count') || 0),
      clearSavedDataOffered: await resumed.locator('#clear-saved-data').isVisible(),
      primaryProfileStillComplete: reopened.missingChunks === 0,
    };
    if (!diskFull.clearSavedDataOffered || diskFull.requestCount !== 0) throw new Error(`Quota test did not stop cleanly: ${JSON.stringify(diskFull)}`);
  }

  sampling = false; await memoryTask;
  const memoryValues = memorySamples.map(sample => sample.workingSetMiB);
  const steadyMemoryMiB = median(memoryValues.slice(-5));
  const report = {
    result: diskFull.result.startsWith('BLOCKED') ? 'PASS_WITH_TOOLING_BLOCK' : 'PASS', sizeBytes: generated.size, chunkCount: Math.ceil(size / 65536), chunkSizeBytes: 65536,
    senderFileId, expectedSha256: generated.sha256, downloadedExternalSha256: externalHash,
    hashMatches: externalHash === generated.sha256, senderHashingMs: Math.round(hashingMs),
    totalMsFirstRequestToLastDurableChunk: totalElapsedMs, transferThroughputMiBPerSecond: Number((size / 1024 ** 2 / (totalElapsedMs / 1000)).toFixed(2)),
    receiverReopenResume: { bytesDurableBeforeClose: firstCutBytes, chunksRequestedBeforeClose: firstCutChunks, chunksRevalidatedOnResume: resumedChunks, chunksMissingOnResume: missingChunks, chunksRequestedOnReconnect: reconnectRequestCount, result: reconnectRequestCount === missingChunks ? 'PASS' : 'FAIL' },
    completedReceiverReopen: reopened, verifyWholeFileDurationMs: verifyDurationMs,
    steadyChromeProcessWorkingSetMiB: steadyMemoryMiB, chromeProcessWorkingSetSamplesMiB: memoryValues,
    memoryMeasurement: 'sum of Chrome process WorkingSet64 sampled from Windows; headless automation has no Chrome Task Manager UI',
    diskFull, offsetProbe, browser: await browser.version(), signaling: `local PeerServer on localhost:${signalPort}`, browserErrors,
  };
  if (browserErrors.length) throw new Error(`Browser errors: ${JSON.stringify(report)}`);
  console.log(`S3_ACCEPTANCE ${JSON.stringify(report, null, 2)}`);
  await context.close();
} catch (error) {
  console.error(error.stack || error);
  if (pages.length) for (const page of pages) console.error(`PAGE ${page.url()} ${JSON.stringify(await page.evaluate(() => ({ status: document.querySelector('#status')?.textContent, data: { ...document.querySelector('#status')?.dataset }, progress: document.querySelector('#transfer-progress')?.textContent, verify: document.querySelector('#verify-status')?.textContent })).catch(() => '(unavailable)'))}`);
  if (browserErrors.length) console.error(`BROWSER_ERRORS ${JSON.stringify(browserErrors)}`);
  if (logs.signal.length) console.error(`PEERSERVER_LOG\n${logs.signal.join('')}`);
  if (logs.app.length) console.error(`APP_LOG\n${logs.app.join('')}`);
  process.exitCode = 1;
} finally {
  sampling = false;
  if (browser) await Promise.race([browser.close(), new Promise(resolve => setTimeout(resolve, 3000))]);
  appServer?.kill(); signalServer?.kill(); await rm(scratch, { recursive: true, force: true });
}
