import { createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function makeTestFile(target = 'scratch/test-5mb.bin', size = 5 * 1024 * 1024) {
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error('size must be a positive safe integer');
  await mkdir(dirname(target), { recursive: true });
  let state = 0x12345678;
  const hash = createHash('sha256');
  const out = createWriteStream(target);
  for (let remaining = size; remaining > 0;) {
    const bytes = Buffer.allocUnsafe(Math.min(65536, remaining));
    for (let i = 0; i < bytes.length; i++) { state = (state * 1664525 + 1013904223) % 4294967296; bytes[i] = Math.floor(state / 16777216); }
    hash.update(bytes);
    if (!out.write(bytes)) await once(out, 'drain');
    remaining -= bytes.length;
  }
  out.end(); await once(out, 'finish');
  return { file: target, size, sha256: hash.digest('hex') };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await makeTestFile(process.argv[2] || 'scratch/test-5mb.bin', Number(process.argv[3] || 5 * 1024 * 1024));
  console.log(JSON.stringify(result, null, 2));
}
