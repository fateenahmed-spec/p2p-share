import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeManifest, parseManifest, fileId } from '../src/lib/manifest.js';
import { chunkSizeFor } from '../src/lib/chunk-size.js';
import { parseControlMessage, parseShareLink, encodeControlMessage } from '../src/lib/validators.js';
import { makePeerOptions } from '../src/lib/rtc-config.js';
import { createRandom } from '../src/lib/random.js';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { CHUNK_START, CHUNK_DATA, CHUNK_END, encodeFrame, validateFrame, decodeFrame, FrameReassembler } from '../src/lib/frames.js';
import { chunkFileOffset, chunkLength } from '../src/lib/offsets.js';
import { encodeBitfield, decodeBitfield, HolderSet } from '../src/lib/bitfield.js';
import { TokenBucket } from '../src/lib/token-bucket.js';
import { RequestLedger, RequestScheduler } from '../src/lib/request-scheduler.js';
import { ByteBudget } from '../src/lib/byte-budget.js';
import { encodeProgressRecord, decodeProgressRecord, selectProgressRecord, missingChunkIndices, progressRecordSize } from '../src/lib/progress-record.js';
import { ByteQueueBudget, OPFS_WRITE_QUEUE_LIMIT } from '../src/lib/byte-queue.js';
import { fileEntryNames } from '../src/lib/storage-names.js';
import { checkAvailableStorage } from '../src/lib/storage-preflight.js';
import { clearWithFileLock } from '../src/lib/receiver-lock.js';
import { createDebugLogRing } from '../src/lib/debug-log.js';
import { admitReceiver, MAX_RECEIVERS } from '../src/lib/receiver-admission.js';
import { RoundRobinCursor } from '../src/lib/round-robin.js';
import { SpeedWindow } from '../src/lib/speed-window.js';

test('manifest encodes, parses, and hashes canonical bytes including size above 2^32', async () => {
  const h = new Uint8Array(32).fill(7), size = 4294967296 + 5, chunkSize = 4294967295;
  const bytes = encodeManifest({ name: 'x.bin', size, chunkSize, chunkHashes: [h, h] });
  const got = parseManifest(bytes);
  assert.equal(got.size, size); assert.equal(got.chunkCount, 2); assert.equal(got.name, 'x.bin');
  assert.match(await fileId(bytes), /^[a-f0-9]{64}$/);
  assert.equal(bytes.length, 8 + 2 + 4 + 5 + 8 + 4 + 4 + 64);
});
test('chunk size follows approved table and bounds', () => {
  assert.equal(chunkSizeFor(1), 65536); assert.equal(chunkSizeFor(256 * 1024 ** 2), 65536);
  assert.equal(chunkSizeFor(256 * 1024 ** 2 + 1), 262144); assert.equal(chunkSizeFor(1024 ** 3 + 1), 1048576);
  assert.equal(chunkSizeFor(4 * 1024 ** 3 + 1), 4194304); assert.throws(() => chunkSizeFor(0));
});
test('control and link validators reject malformed or ambiguous input', () => {
  assert.deepEqual(parseControlMessage('{"type":"PING","seq":1}'), { type: 'PING', seq: 1 });
  assert.throws(() => parseControlMessage('x'.repeat(65537)));
  assert.throws(() => parseControlMessage('{'));
  assert.deepEqual(parseShareLink('https://example.test/receiver.html?room=' + 'a'.repeat(32) + '&fid=' + 'b'.repeat(64)).room, 'a'.repeat(32));
  assert.throws(() => parseShareLink('https://x/?room=' + 'a'.repeat(32) + '&room=' + 'a'.repeat(32) + '&fid=' + 'b'.repeat(64)));
});
test('control schemas require JSON strings, reject role and field violations, and copy known fields only', () => {
  assert.throws(() => parseControlMessage({ type: 'PING', seq: 1 }));
  assert.deepEqual(parseControlMessage('{"type":"HELLO","role":"receiver","protocolVersion":1,"ignored":true}'),
    { type: 'HELLO', role: 'receiver', protocolVersion: 1 });
  assert.deepEqual(parseControlMessage(encodeControlMessage({ type: 'HELLO', role: 'sender', protocolVersion: 1, sessionId: 'a'.repeat(32) })),
    { type: 'HELLO', role: 'sender', protocolVersion: 1, sessionId: 'a'.repeat(32) });
  for (const value of [
    '{"type":"HELLO","role":"receiver","protocolVersion":1,"sessionId":"' + 'a'.repeat(32) + '"}',
    '{"type":"HELLO","role":"sender","protocolVersion":1,"sessionId":"bad"}',
    '{"type":"PING","seq":-1}', '{"type":"PING","seq":1.5}',
    '{"type":"MANIFEST_DATA","seq":0,"data":"GG"}', '{"type":"UNKNOWN"}',
    '{"type":"BITFIELD","hex":"AA"}',
  ]) assert.throws(() => parseControlMessage(value));
  assert.throws(() => parseControlMessage('{"type":"PING","seq":1,"note":"' + 'é'.repeat(32764) + '"}'));
  const have = parseControlMessage('{"type":"HAVE","indices":[1,2],"extra":"discarded"}');
  assert.deepEqual(have, { type: 'HAVE', indices: [1, 2] });
});
test('PeerJS config explicitly replaces defaults; no peerjs.com TURN host unless supplied', () => {
  const options = makePeerOptions();
  assert.equal(options.config.sdpSemantics, 'unified-plan');
  assert.equal(options.config.iceServers.length, 1);
  assert.match(options.config.iceServers[0].urls, /^stun:/);
  assert.equal(JSON.stringify(options).includes('peerjs.com'), false);
  assert.equal(makePeerOptions({ iceServers: [{ urls: 'turn:turn.example:3478', username: 'u', credential: 'p' }], forceRelay: true }).config.iceTransportPolicy, 'relay');
});
test('CSP covers signaling host in config.example.json on both pages', async () => {
  const cfg = JSON.parse(await readFile(new URL('../config.example.json', import.meta.url), 'utf8'));
  const host = cfg.signaling.host;
  for (const page of ['sender.html', 'receiver.html']) {
    const html = await readFile(new URL('../' + page, import.meta.url), 'utf8');
    assert.match(html, new RegExp('https://' + host.replaceAll('.', '\\.')));
    assert.match(html, new RegExp('wss://' + host.replaceAll('.', '\\.')));
    assert.match(html, /http:\/\/localhost:9000/);
    const importMap = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
    assert.ok(importMap, `${page} must retain the import map`);
    const hash = createHash('sha256').update(importMap[1]).digest('base64');
    assert.ok(html.includes(`'sha256-${hash}'`), `${page} CSP must allow only the exact inline import map`);
  }
});
test('random range reduction rejects out-of-range Uint32 values', () => {
  const values = [4294967295, 2, 3]; let i = 0;
  const rng = createRandom(words => { for (let j = 0; j < words.length; j++) words[j] = values[i++ % values.length]; });
  assert.equal(rng.integer(3), 2);
});
test('random range reduction maps exhaustive small fake-source values evenly and scans src for Math.random', async () => {
  let next = 0;
  const rng = createRandom(words => { for (let i = 0; i < words.length; i++) words[i] = next++ % 3; });
  const counts = [0, 0, 0];
  for (let i = 0; i < 9000; i++) counts[rng.integer(3)]++;
  assert.deepEqual(counts, [3000, 3000, 3000]);
  const { readdir, readFile } = await import('node:fs/promises'); const { fileURLToPath } = await import('node:url'); const { join } = await import('node:path');
  async function files(dir) { const out = []; for (const ent of await readdir(dir, { withFileTypes: true })) { const p = join(dir, ent.name); if (ent.isDirectory()) out.push(...await files(p)); else if (ent.name.endsWith('.js')) out.push(await readFile(p, 'utf8')); } return out; }
  assert.equal((await files(fileURLToPath(new URL('../src/', import.meta.url)))).some(source => /Math\s*\.\s*random\s*\(/.test(source)), false);
});

test('bulk frame header is ten-byte big-endian and reassembles a requested chunk', async () => {
  const startPayload = new Uint8Array(4); new DataView(startPayload.buffer).setUint32(0, 5, false);
  const start = validateFrame(encodeFrame({ type: CHUNK_START, attempt: 2, index: 0x10203, offset: 0, payload: startPayload }));
  assert.equal(start.type, CHUNK_START); assert.equal(start.attempt, 2); assert.equal(start.index, 0x10203); assert.equal(start.offset, 0);
  const source = new Uint8Array([1, 2, 3, 4, 5]);
  const reassembler = new FrameReassembler({ maxInFlight: 8 });
  assert.equal(reassembler.request(0, 0, source.length), true);
  assert.equal(reassembler.accept(encodeFrame({ type: CHUNK_START, attempt: 0, index: 0, offset: 0, payload: startPayload })).status, 'started');
  assert.equal(reassembler.accept(encodeFrame({ type: CHUNK_DATA, attempt: 0, index: 0, offset: 0, payload: source.subarray(0, 3) })).received, 3);
  assert.equal(reassembler.accept(encodeFrame({ type: CHUNK_DATA, attempt: 0, index: 0, offset: 3, payload: source.subarray(3) })).received, 5);
  const complete = reassembler.accept(encodeFrame({ type: CHUNK_END, attempt: 0, index: 0, offset: 5, payload: new Uint8Array() }));
  assert.equal(complete.status, 'complete'); assert.deepEqual(complete.buffer, source);
  const expectedHash = createHash('sha256').update(source).digest('hex');
  assert.equal(createHash('sha256').update(complete.buffer).digest('hex'), expectedHash);
  assert.notEqual(createHash('sha256').update(new Uint8Array([9, 2, 3, 4, 5])).digest('hex'), expectedHash);
  assert.equal(await fileId(new Uint8Array(complete.buffer)), await fileId(source));
});

test('frame validator rejects wrong lengths, types, offsets, and payloads', () => {
  const payload = new Uint8Array(4); new DataView(payload.buffer).setUint32(0, 1, false);
  assert.throws(() => encodeFrame({ type: 9, attempt: 0, index: 0, offset: 0, payload }));
  assert.throws(() => encodeFrame({ type: CHUNK_START, attempt: 64, index: 0, offset: 0, payload }));
  assert.throws(() => encodeFrame({ type: CHUNK_START, attempt: 0, index: 0, offset: 1, payload }));
  assert.throws(() => encodeFrame({ type: CHUNK_END, attempt: 0, index: 0, offset: 0, payload }));
  assert.equal(decodeFrame(new Uint8Array(9)).ok, false);
  assert.equal(decodeFrame(new Uint8Array(16395)).ok, false);
});

test('chunk offset math remains exact across u32 boundaries and near 2^53', () => {
  assert.equal(chunkFileOffset(1, 4294967295), 4294967295);
  assert.equal(chunkFileOffset(1, 4294967296), 4294967296);
  assert.equal(chunkFileOffset(1, 4294967297), 4294967297);
  assert.equal(chunkFileOffset(Number.MAX_SAFE_INTEGER, 1), Number.MAX_SAFE_INTEGER);
  assert.throws(() => chunkFileOffset(Number.MAX_SAFE_INTEGER, 2));
  assert.equal(chunkLength(4294967297, 4294967296, 1), 1);
  assert.equal(chunkLength(9007199254740991, 1, 9007199254740990), 1);
});

test('bitfields encode/decode all-ones snapshots and holder deltas', () => {
  const all = encodeBitfield(9, Array.from({ length: 9 }, (_, i) => i));
  assert.equal(all, 'ff01'); assert.deepEqual(decodeBitfield(9, all), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.throws(() => decodeBitfield(9, 'ff81'));
  assert.throws(() => decodeBitfield(9, 'FF01'));
  const holders = new HolderSet(9); holders.replaceFromBitfield('0100'); holders.add([8]); holders.remove(0);
  assert.deepEqual([...holders.indices], [8]);
});

test('control validator covers every S2 control message schema', () => {
  const messages = [
    { type: 'HELLO', role: 'receiver', protocolVersion: 1 },
    { type: 'MANIFEST_START', name: 'a', size: 1, chunkSize: 1, chunkCount: 1, fileId: 'a'.repeat(64), manifestBytes: 1 },
    { type: 'MANIFEST_DATA', seq: 0, data: '00' }, { type: 'MANIFEST_END', parts: 1 },
    { type: 'REQUEST', index: 0, attempt: 63 }, { type: 'HAVE', indices: [0] },
    { type: 'BITFIELD', hex: '01' }, { type: 'CANCEL', index: 0, attempt: 1 },
    { type: 'REJECT', index: 0, attempt: 1, reason: 'NOT_HAVE' },
    { type: 'PING', seq: 0 }, { type: 'PONG', seq: 0 },
    { type: 'ERROR', code: 'PROTOCOL', message: 'invalid' },
  ];
  for (const message of messages) assert.deepEqual(parseControlMessage(encodeControlMessage(message)), message);
  for (const message of [
    { type: 'REQUEST', index: -1, attempt: 0 }, { type: 'REQUEST', index: 0, attempt: 64 },
    { type: 'HAVE', indices: [1, 1] }, { type: 'REJECT', index: 0, attempt: 0, reason: 'NOPE' },
    { type: 'MANIFEST_END', parts: -1 }, { type: 'PING', seq: Number.MAX_SAFE_INTEGER + 1 },
  ]) assert.throws(() => encodeControlMessage(message));
});

test('request ledger handles duplicate, stale, superseded, and capped attempts', () => {
  const ledger = new RequestLedger();
  assert.equal(ledger.observe(4, 0), 'new');
  assert.equal(ledger.observe(4, 0), 'duplicate');
  assert.equal(ledger.observe(4, 2), 'superseded');
  assert.equal(ledger.observe(4, 1), 'stale');
  assert.equal(ledger.observe(4, 64), 'exhausted');
  assert.equal(ledger.current(4, 2), true);
});

test('request scheduler randomizes order, limits in-flight work, retries failures, and uses injected clock', () => {
  let now = 0;
  const rng = createRandom(words => words.fill(0));
  const scheduler = new RequestScheduler({ chunkCount: 10, maxInFlight: 8, rng, clock: () => now });
  scheduler.replaceHolders(Array.from({ length: 10 }, (_, i) => i));
  const first = Array.from({ length: 8 }, () => scheduler.next());
  assert.equal(new Set(first.map(x => x.index)).size, 8); assert.equal(scheduler.next(), null);
  now = 100;
  const expired = scheduler.expire(100);
  assert.equal(expired.length, 8); assert.ok(expired.every(x => x.status === 'retry'));
  scheduler.next(); scheduler.next(); // Two unrequested chunks remained before the retry queue.
  const retry = scheduler.next(); assert.ok(retry); assert.equal(retry.index, first[0].index); assert.equal(retry.attempt, 1);
  assert.equal(scheduler.complete(retry.index, 0).status, 'stale');
  assert.equal(scheduler.complete(retry.index, 1).status, 'verified');
  for (let failure = 0; failure < 2; failure++) {
    const request = scheduler.next(); assert.ok(request);
    const result = scheduler.fail(request.index, request.attempt);
    if (request.index === retry.index) assert.equal(result.status, 'retry');
  }
});

test('scheduler fails a chunk after three bad attempts and marks unavailable chunks failed', () => {
  const rng = createRandom(words => words.fill(0));
  const scheduler = new RequestScheduler({ chunkCount: 1, maxInFlight: 1, rng, clock: () => 0 });
  scheduler.replaceHolders([0]);
  let request = scheduler.next(); assert.deepEqual(request, { index: 0, attempt: 0 });
  assert.equal(scheduler.fail(0, 0).status, 'retry');
  request = scheduler.next(); assert.equal(request.attempt, 1);
  assert.equal(scheduler.fail(0, 1).status, 'retry');
  request = scheduler.next(); assert.equal(request.attempt, 2);
  assert.equal(scheduler.fail(0, 2).status, 'failed');
  assert.equal(scheduler.next(), null);

  const unavailable = new RequestScheduler({ chunkCount: 1, maxInFlight: 1, rng, clock: () => 0 });
  unavailable.replaceHolders([0]);
  const pending = unavailable.next();
  assert.equal(unavailable.markUnavailable(pending.index, pending.attempt).status, 'failed');
  assert.equal(unavailable.failed.has(0), true);
});

test('token bucket uses lazy refill and an injected monotonic clock', () => {
  let now = 0;
  const bucket = new TokenBucket({ rateBytesPerSecond: 1000, burstBytes: 500, now: () => now });
  assert.equal(bucket.take(500), true); assert.equal(bucket.take(1), false); assert.equal(bucket.delayFor(250), 250);
  now = 250; assert.equal(bucket.take(250), true); assert.equal(bucket.tokens, 0);
});

test('byte budget keeps ten receivers within global and per-peer caps and releases on disconnect', () => {
  const budget = new ByteBudget(); const peers = Array.from({ length: 10 }, (_, i) => `peer-${i}`);
  const remaining = new Map(peers.map(peer => [peer, 16])); const progress = new Map(peers.map(peer => [peer, 0]));
  for (const peer of peers) for (let i = 0; i < 16; i++) budget.enqueue(peer, `${peer}-${i}`, 1024 ** 2);
  while ([...remaining.values()].some(n => n > 0)) {
    const grant = budget.grantNext();
    if (grant) {
      progress.set(grant.peerId, progress.get(grant.peerId) + grant.bytes);
      remaining.set(grant.peerId, remaining.get(grant.peerId) - 1);
      assert.ok(budget.reservedBytes() <= 64 * 1024 ** 2);
      for (const peer of peers) assert.ok(budget.reservedBytes(peer) <= 16 * 1024 ** 2);
    }
    for (const key of [...budget.reservations.keys()]) budget.release(key);
  }
  assert.ok(peers.every(peer => progress.get(peer) === 16 * 1024 ** 2));
  budget.enqueue('gone', 'gone-1', 1024); budget.grantNext(); budget.disconnect('gone');
  assert.equal(budget.reservedBytes('gone'), 0);
});

test('progress records round-trip, reject checksum damage, select newest valid generation, and derive missing bits', async () => {
  const digest = bytes => new Uint8Array(createHash('sha256').update(bytes).digest());
  const older = await encodeProgressRecord({ generation: 4, chunkCount: 10, bitmap: new Uint8Array([0x03, 0]) }, digest);
  const newer = await encodeProgressRecord({ generation: 5, chunkCount: 10, bitmap: new Uint8Array([0x13, 0]) }, digest);
  assert.equal(progressRecordSize(10), 58);
  assert.deepEqual(await decodeProgressRecord(newer, digest), { version: 1, generation: 5, chunkCount: 10, bitmap: new Uint8Array([0x13, 0]) });
  const torn = newer.slice(); torn[torn.length - 1] ^= 1;
  assert.equal(await decodeProgressRecord(torn, digest), null);
  assert.deepEqual((await selectProgressRecord([older, newer], 10, digest)).record, { version: 1, generation: 5, chunkCount: 10, bitmap: new Uint8Array([0x13, 0]) });
  assert.equal((await selectProgressRecord([older, torn], 10, digest)).record.generation, 4);
  assert.equal((await selectProgressRecord([older, newer], 9, digest)).status, 'mismatch');
  assert.deepEqual(missingChunkIndices(10, new Uint8Array([0x13, 0])), [2, 3, 5, 6, 7, 8, 9]);
});

test('OPFS write queue accounts up to 16 MiB and releases bytes after acknowledgement', () => {
  const queue = new ByteQueueBudget();
  assert.equal(queue.reserve('a', 8 * 1024 ** 2), true);
  assert.equal(queue.reserve('b', 8 * 1024 ** 2), true);
  assert.equal(queue.bytes, OPFS_WRITE_QUEUE_LIMIT);
  assert.equal(queue.reserve('c', 1), false);
  assert.equal(queue.release('a'), true);
  assert.equal(queue.available, 8 * 1024 ** 2);
  assert.equal(queue.reserve('c', 4 * 1024 ** 2), true);
  assert.equal(queue.bytes, 12 * 1024 ** 2);
});

test('fileId-derived OPFS filenames are stable and reject unsafe IDs', () => {
  const fid = 'ab'.repeat(32);
  assert.deepEqual(fileEntryNames(fid), { data: `data-${fid}.bin`, progress: `progress-${fid}.bin` });
  assert.deepEqual(fileEntryNames(fid), fileEntryNames(fid));
  assert.throws(() => fileEntryNames('../' + fid));
});

test('test-only memory sink is removed and no source module imports it', async () => {
  const { readdir, access } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url'); const { join } = await import('node:path');
  const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
  await assert.rejects(access(join(sourceRoot, 'test-only', 'memory-sink.js')));
  async function visit(dir) {
    const files = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) files.push(...await visit(path)); else if (/\.js$/.test(entry.name)) files.push(path);
    }
    return files;
  }
  for (const path of await visit(sourceRoot)) assert.doesNotMatch(await readFile(path, 'utf8'), /memory-sink/);
});

test('fuzzed frame and control decoders reject arbitrary input without throwing', () => {
  let state = 0x51a2b3c4;
  function nextByte() { state = (state * 1664525 + 1013904223) % 4294967296; return Math.floor(state / 16777216); }
  for (let n = 0; n < 2000; n++) {
    const length = n % 17000, bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = nextByte();
    assert.doesNotThrow(() => decodeFrame(bytes));
    const text = n % 4 === 0 ? new TextDecoder().decode(bytes.subarray(0, Math.min(length, 65536))) : JSON.stringify({ type: 'PING', seq: nextByte() });
    assert.doesNotThrow(() => { try { parseControlMessage(text); } catch { /* Invalid input is expected. */ } });
  }
  const oversized = new Uint8Array(16395); assert.equal(decodeFrame(oversized).ok, false);
});

test('source forbids bitwise operators except in the bitfield module', async () => {
  const { readdir, readFile } = await import('node:fs/promises'); const { fileURLToPath } = await import('node:url'); const { join, relative } = await import('node:path');
  async function files(dir) { const out = []; for (const ent of await readdir(dir, { withFileTypes: true })) { const path = join(dir, ent.name); if (ent.isDirectory()) out.push(...await files(path)); else if (/\.js$/.test(ent.name)) out.push({ path, source: await readFile(path, 'utf8') }); } return out; }
  function stripNonCode(source) {
    let out = '', i = 0, previous = 'start';
    const regexBefore = new Set(['start', '(', '[', '{', ',', ':', ';', '!', '?', '=', '=>', '&&', '||', 'return', 'case', 'throw', 'yield', 'await']);
    while (i < source.length) {
      const c = source[i], n = source[i + 1];
      if (/\s/.test(c)) { out += ' '; i++; continue; }
      if (c === '"' || c === "'" || c === '`') {
        const quote = c; i++;
        while (i < source.length) { if (source[i] === '\\') { i += 2; continue; } if (source[i++] === quote) break; }
        out += ' '; previous = 'value'; continue;
      }
      if (c === '/' && n === '/') { i += 2; while (i < source.length && source[i] !== '\n') i++; out += ' '; continue; }
      if (c === '/' && n === '*') { i += 2; while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++; i = Math.min(source.length, i + 2); out += ' '; continue; }
      if (c === '/' && regexBefore.has(previous)) {
        let j = i + 1, escaped = false, inClass = false, closed = false;
        for (; j < source.length && source[j] !== '\n'; j++) {
          const ch = source[j];
          if (escaped) { escaped = false; continue; }
          if (ch === '\\') { escaped = true; continue; }
          if (ch === '[') inClass = true; else if (ch === ']') inClass = false;
          else if (ch === '/' && !inClass) { j++; while (/[a-z]/i.test(source[j] || '')) j++; closed = true; break; }
        }
        if (closed) { out += ' '; i = j; previous = 'value'; continue; }
      }
      if (/[A-Za-z_$]/.test(c)) {
        let j = i + 1; while (/[A-Za-z0-9_$]/.test(source[j] || '')) j++;
        const word = source.slice(i, j); out += word; previous = regexBefore.has(word) ? word : 'value'; i = j; continue;
      }
      if (/[0-9]/.test(c)) { let j = i + 1; while (/[A-Za-z0-9_.]/.test(source[j] || '')) j++; out += source.slice(i, j); previous = 'value'; i = j; continue; }
      const two = source.slice(i, i + 2);
      out += c;
      if (['&&', '||', '=>'].includes(two)) { out += n; previous = two; i += 2; }
      else { previous = c; i++; }
    }
    return out;
  }
  const sources = await files(fileURLToPath(new URL('../src/', import.meta.url)));
  const forbidden = /(?<!&)&(?!&)|(?<!\|)\|(?!\|)|\^|~|<<|>>/;
  for (const { path, source } of sources) if (!relative(fileURLToPath(new URL('../src/', import.meta.url)), path).replaceAll('\\', '/').endsWith('lib/bitfield.js')) {
    assert.equal(forbidden.test(stripNonCode(source)), false, `forbidden bitwise operator in ${path}`);
  }
});

test('production storage preflight rejects 64 MiB for 500 MiB and accepts 2 GiB', async () => {
  const mib = 1024 ** 2, calls = { estimate: 0, persist: 0 };
  const check = available => checkAvailableStorage(500 * mib, {
    estimate: async () => { calls.estimate++; return { quota: available, usage: 0 }; },
    persist: async () => { calls.persist++; return true; }, formatBytes: String,
  });
  const low = await check(64 * mib);
  assert.equal(low.ok, false); assert.equal(low.available, 64 * mib); assert.match(low.message, /Insufficient origin storage/);
  const enough = await check(2 * 1024 * mib);
  assert.equal(enough.ok, true); assert.equal(enough.available, 2 * 1024 * mib);
  assert.deepEqual(calls, { estimate: 2, persist: 2 });
});

test('storage preflight estimate rejection proceeds with an explicit warning', async () => {
  const result = await checkAvailableStorage(500 * 1024 ** 2, {
    estimate: async () => { throw new Error('estimate blocked'); }, persist: async () => true, formatBytes: String,
  });
  assert.equal(result.ok, true); assert.equal(result.available, null); assert.match(result.warning, /estimate blocked/);
});

test('Clear reacquires a released receiver lock and never clears without one', async () => {
  let held = false, clears = 0;
  const clear = async () => { assert.equal(held, true); clears++; };
  const requestLock = async callback => { held = true; try { await callback({}); } finally { held = false; } };
  assert.equal(await clearWithFileLock({ lockHeld: false, requestLock, clear }), true);
  assert.equal(clears, 1);
  assert.equal(await clearWithFileLock({ lockHeld: false, requestLock: callback => callback(null), clear }), false);
  assert.equal(clears, 1);
});

test('debug log ring retains only the newest entries', () => {
  const ring = createDebugLogRing(2); ring.add(1); ring.add(2); ring.add(3);
  assert.deepEqual(ring.list(), [2, 3]);
});

test('11th receiver gets ROOM_FULL and is closed', () => {
  let closed = false, sent;
  assert.equal(admitReceiver(MAX_RECEIVERS, { sendError: message => { sent = message; }, close: () => { closed = true; } }), false);
  assert.deepEqual(sent, { type: 'ERROR', code: 'ROOM_FULL', message: 'This sender already has the maximum number of receivers.' });
  assert.equal(closed, true);
  assert.equal(admitReceiver(MAX_RECEIVERS - 1, { sendError() {}, close() {} }), true);
});

test('round-robin cursor rotates deterministically across changing receiver sets', () => {
  const cursor = new RoundRobinCursor(), peers = ['a', 'b', 'c'];
  assert.deepEqual(Array.from({ length: 6 }, () => cursor.next(peers)), ['a', 'b', 'c', 'a', 'b', 'c']);
  assert.deepEqual(Array.from({ length: 4 }, () => cursor.next(['a', 'c'])), ['a', 'c', 'a', 'c']);
});

test('per-receiver one-second speed window includes bursts and expires old samples', () => {
  let now = 0; const speed = new SpeedWindow({ now: () => now });
  speed.add(100_000); now = 200; speed.add(200_000); now = 500; speed.add(700_000);
  assert.equal(speed.bytesPerSecond(), 1_000_000);
  now = 1001;
  assert.equal(speed.bytes(), 900_000);
  now = 1500;
  assert.equal(speed.bytes(), 700_000);
  assert.equal(speed.bytesPerSecond(), 700_000);
});

test('shared token bucket with three round-robin consumers respects aggregate rate', () => {
  const consumers = ['a', 'b', 'c'], totals = new Map(consumers.map(id => [id, 0]));
  const cursor = new RoundRobinCursor(); let now = 0;
  const bucket = new TokenBucket({ rateBytesPerSecond: 30_000, burstBytes: 32_788, now: () => now });
  for (let step = 0; step < 100; step++) {
    now += 550;
    const id = cursor.next(consumers);
    if (bucket.take(16_394)) totals.set(id, totals.get(id) + 16_394);
  }
  const total = [...totals.values()].reduce((a, b) => a + b, 0);
  assert.ok(total <= 32_788 + 30_000 * (now / 1000));
  assert.ok([...totals.values()].every(value => value > 0));
  assert.ok(Math.max(...totals.values()) - Math.min(...totals.values()) <= 16_394);
});

test('byte budget round-robin grants make progress for three queued receivers', () => {
  const budget = new ByteBudget({ globalLimit: 6, peerLimit: 2 });
  for (const id of ['a', 'b', 'c']) for (let n = 0; n < 2; n++) budget.enqueue(id, `${id}${n}`, 2);
  const order = [];
  for (let i = 0; i < 3; i++) { const item = budget.grantNext(); order.push(item.peerId); }
  assert.deepEqual(order, ['a', 'b', 'c']);
  for (const item of [...budget.reservations.keys()]) budget.release(item);
  assert.deepEqual(new Set(['a', 'b', 'c'].map(id => budget.grantNext()?.peerId)), new Set(['a', 'b', 'c']));
});
