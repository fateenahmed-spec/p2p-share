const MAGIC = new TextEncoder().encode('P2PSHARE');
const MAX_NAME_BYTES = 4096;
const MAX_CHUNKS = 65536;

export function encodeManifest({ name, size, chunkSize, chunkHashes, protocolVersion = 1 }) {
  const nameBytes = new TextEncoder().encode(name);
  if (nameBytes.length > MAX_NAME_BYTES) throw new RangeError('File name exceeds 4096 UTF-8 bytes');
  if (!Number.isSafeInteger(size) || size <= 0 || size > 256 * 1024 ** 3) throw new RangeError('Invalid file size');
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new RangeError('Invalid chunk size');
  const count = Math.ceil(size / chunkSize);
  if (count > MAX_CHUNKS || chunkHashes.length !== count) throw new RangeError('Invalid chunk hash count');
  const out = new Uint8Array(8 + 2 + 4 + nameBytes.length + 8 + 4 + 4 + count * 32);
  const view = new DataView(out.buffer);
  out.set(MAGIC, 0); view.setUint16(8, protocolVersion, false); view.setUint32(10, nameBytes.length, false);
  out.set(nameBytes, 14); let p = 14 + nameBytes.length;
  const hi = Math.floor(size / 4294967296); const lo = size - hi * 4294967296;
  view.setUint32(p, hi, false); view.setUint32(p + 4, lo, false); p += 8;
  view.setUint32(p, chunkSize, false); p += 4; view.setUint32(p, count, false); p += 4;
  for (const h of chunkHashes) { if (!(h instanceof Uint8Array) || h.length !== 32) throw new TypeError('Chunk hashes must be 32-byte Uint8Arrays'); out.set(h, p); p += 32; }
  return out;
}

export async function fileId(bytes, cryptoApi = globalThis.crypto) {
  const digest = new Uint8Array(await cryptoApi.subtle.digest('SHA-256', bytes));
  return Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
}

export function parseManifest(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 30) throw new TypeError('Truncated manifest');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < 8; i++) if (bytes[i] !== MAGIC[i]) throw new TypeError('Bad manifest magic');
  const protocolVersion = v.getUint16(8, false); const nameLength = v.getUint32(10, false);
  if (nameLength > MAX_NAME_BYTES || 14 + nameLength + 20 > bytes.length) throw new RangeError('Invalid manifest name length');
  const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(14, 14 + nameLength));
  let p = 14 + nameLength; const hi = v.getUint32(p, false); const lo = v.getUint32(p + 4, false);
  const size = hi * 4294967296 + lo; p += 8;
  const chunkSize = v.getUint32(p, false); p += 4; const chunkCount = v.getUint32(p, false); p += 4;
  if (!Number.isSafeInteger(size) || size <= 0 || size > 256 * 1024 ** 3 || !chunkSize || chunkCount !== Math.ceil(size / chunkSize) || chunkCount > MAX_CHUNKS || bytes.length !== p + chunkCount * 32) throw new RangeError('Invalid manifest bounds');
  const chunkHashes = [];
  for (let i = 0; i < chunkCount; i++) chunkHashes.push(bytes.slice(p + i * 32, p + (i + 1) * 32));
  return { protocolVersion, name, size, chunkSize, chunkCount, chunkHashes };
}
