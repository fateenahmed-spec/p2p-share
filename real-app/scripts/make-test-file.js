import { createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
const target = process.argv[2] || 'scratch/test-5mb.bin'; const size = Number(process.argv[3] || 5 * 1024 * 1024);
if (!Number.isSafeInteger(size) || size <= 0) throw new Error('size must be a positive safe integer');
await mkdir(dirname(target), { recursive: true });
let state = 0x12345678; const hash = createHash('sha256'); const out = createWriteStream(target);
for (let remaining = size; remaining > 0;) {
  const bytes = Buffer.allocUnsafe(Math.min(65536, remaining));
  for (let i = 0; i < bytes.length; i++) { state = (state * 1664525 + 1013904223) % 4294967296; bytes[i] = Math.floor(state / 16777216); }
  hash.update(bytes); if (!out.write(bytes)) await once(out, 'drain'); remaining -= bytes.length;
}
out.end(); await once(out, 'finish');
console.log(JSON.stringify({ file: target, size, sha256: hash.digest('hex') }, null, 2));
