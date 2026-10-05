import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeManifest, parseManifest, fileId } from '../src/lib/manifest.js';
import { chunkSizeFor } from '../src/lib/chunk-size.js';
import { parseControlMessage, parseShareLink } from '../src/lib/validators.js';
import { makePeerOptions } from '../src/lib/rtc-config.js';
import { createRandom } from '../src/lib/random.js';
import { readFile } from 'node:fs/promises';

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
