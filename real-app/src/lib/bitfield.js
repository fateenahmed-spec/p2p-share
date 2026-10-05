function validCount(count) { return Number.isSafeInteger(count) && count >= 1 && count <= 65536; }

export function encodeBitfield(chunkCount, indices) {
  if (!validCount(chunkCount) || !indices || typeof indices[Symbol.iterator] !== 'function') throw new RangeError('Invalid BITFIELD inputs');
  const bytes = new Uint8Array(Math.ceil(chunkCount / 8));
  const seen = new Set();
  for (const index of indices) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= chunkCount || seen.has(index)) throw new RangeError('Invalid or duplicate BITFIELD index');
    seen.add(index);
    const byteIndex = Math.floor(index / 8), bitIndex = index % 8;
    bytes[byteIndex] += 2 ** bitIndex;
  }
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function decodeBitfield(chunkCount, hex) {
  if (!validCount(chunkCount) || typeof hex !== 'string' || hex.length !== Math.ceil(chunkCount / 8) * 2 || !/^[a-f0-9]*$/.test(hex)) throw new TypeError('Invalid BITFIELD length or encoding');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  const remainder = chunkCount % 8;
  if (remainder && Math.floor(bytes[bytes.length - 1] / (2 ** remainder)) !== 0) throw new TypeError('BITFIELD padding bits must be zero');
  const indices = [];
  for (let i = 0; i < chunkCount; i++) if (Math.floor(bytes[Math.floor(i / 8)] / (2 ** (i % 8))) % 2 === 1) indices.push(i);
  return indices;
}

export class HolderSet {
  constructor(chunkCount) { if (!validCount(chunkCount)) throw new RangeError('Invalid chunk count'); this.chunkCount = chunkCount; this.indices = new Set(); }
  replaceFromBitfield(hex) { this.indices = new Set(decodeBitfield(this.chunkCount, hex)); }
  add(indices) { for (const index of indices) { if (!Number.isSafeInteger(index) || index < 0 || index >= this.chunkCount) throw new RangeError('Invalid HAVE index'); this.indices.add(index); } }
  remove(index) { if (!Number.isSafeInteger(index) || index < 0 || index >= this.chunkCount) throw new RangeError('Invalid NOT_HAVE index'); this.indices.delete(index); }
  has(index) { return this.indices.has(index); }
}
