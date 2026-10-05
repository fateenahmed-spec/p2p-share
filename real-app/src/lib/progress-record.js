const MAGIC = new TextEncoder().encode('P2PPRG01');
export const PROGRESS_VERSION = 1;
export const PROGRESS_HEADER_BYTES = 24;
export const PROGRESS_CHECKSUM_BYTES = 32;

export function progressRecordSize(chunkCount) {
  if (!Number.isSafeInteger(chunkCount) || chunkCount < 1 || chunkCount > 65536) throw new RangeError('Invalid progress chunk count');
  return PROGRESS_HEADER_BYTES + Math.ceil(chunkCount / 8) + PROGRESS_CHECKSUM_BYTES;
}

export async function encodeProgressRecord({ generation, chunkCount, bitmap }, digest = defaultDigest) {
  const size = progressRecordSize(chunkCount);
  if (!Number.isSafeInteger(generation) || generation < 0 || generation > 0xffffffff || !(bitmap instanceof Uint8Array) || bitmap.byteLength !== Math.ceil(chunkCount / 8)) throw new RangeError('Invalid progress record fields');
  validatePadding(chunkCount, bitmap);
  const body = new Uint8Array(size - PROGRESS_CHECKSUM_BYTES);
  const view = new DataView(body.buffer);
  body.set(MAGIC, 0); view.setUint32(8, PROGRESS_VERSION, false); view.setUint32(12, generation, false);
  view.setUint32(16, chunkCount, false); view.setUint32(20, bitmap.byteLength, false); body.set(bitmap, PROGRESS_HEADER_BYTES);
  const checksum = await digest(body);
  if (!(checksum instanceof Uint8Array) || checksum.byteLength !== PROGRESS_CHECKSUM_BYTES) throw new TypeError('Progress digest must be 32 bytes');
  const record = new Uint8Array(size); record.set(body); record.set(checksum, body.byteLength);
  return record;
}

export async function decodeProgressRecord(input, digest = defaultDigest) {
  if (!(input instanceof Uint8Array) || input.byteLength < PROGRESS_HEADER_BYTES + PROGRESS_CHECKSUM_BYTES) return null;
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  for (let i = 0; i < MAGIC.length; i++) if (input[i] !== MAGIC[i]) return null;
  const version = view.getUint32(8, false), generation = view.getUint32(12, false);
  const chunkCount = view.getUint32(16, false), bitmapBytes = view.getUint32(20, false);
  if (version !== PROGRESS_VERSION || chunkCount < 1 || chunkCount > 65536 || bitmapBytes !== Math.ceil(chunkCount / 8) || input.byteLength !== PROGRESS_HEADER_BYTES + bitmapBytes + PROGRESS_CHECKSUM_BYTES) return null;
  const bodyLength = input.byteLength - PROGRESS_CHECKSUM_BYTES;
  const body = input.subarray(0, bodyLength), expected = input.subarray(bodyLength);
  const actual = await digest(body);
  if (!(actual instanceof Uint8Array) || actual.byteLength !== PROGRESS_CHECKSUM_BYTES || !equalBytes(actual, expected)) return null;
  const bitmap = input.slice(PROGRESS_HEADER_BYTES, bodyLength);
  try { validatePadding(chunkCount, bitmap); } catch { return null; }
  return { version, generation, chunkCount, bitmap };
}

export async function selectProgressRecord(slots, expectedChunkCount, digest = defaultDigest) {
  if (!Array.isArray(slots) || slots.length !== 2) throw new TypeError('Exactly two progress slots are required');
  const decoded = await Promise.all(slots.map(slot => decodeProgressRecord(slot, digest)));
  if (decoded.some(record => record && record.chunkCount !== expectedChunkCount)) return { status: 'mismatch', record: null, slot: -1 };
  let chosen = -1;
  for (let i = 0; i < decoded.length; i++) if (decoded[i] && decoded[i].chunkCount === expectedChunkCount && (chosen < 0 || decoded[i].generation > decoded[chosen].generation)) chosen = i;
  return chosen < 0 ? { status: 'empty', record: null, slot: -1 } : { status: 'ok', record: decoded[chosen], slot: chosen };
}

export function missingChunkIndices(chunkCount, bitmap) {
  progressRecordSize(chunkCount);
  if (!(bitmap instanceof Uint8Array) || bitmap.byteLength !== Math.ceil(chunkCount / 8)) throw new RangeError('Invalid progress bitmap');
  validatePadding(chunkCount, bitmap);
  const missing = [];
  for (let index = 0; index < chunkCount; index++) {
    const byte = bitmap[Math.floor(index / 8)], set = Math.floor(byte / (2 ** (index % 8))) % 2 === 1;
    if (!set) missing.push(index);
  }
  return missing;
}

function validatePadding(chunkCount, bitmap) {
  const used = chunkCount % 8;
  if (used && Math.floor(bitmap[bitmap.length - 1] / (2 ** used)) !== 0) throw new RangeError('Progress bitmap padding bits must be zero');
}
function equalBytes(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let i = 0; i < left.byteLength; i++) if (left[i] !== right[i]) difference++;
  return difference === 0;
}
async function defaultDigest(bytes) { return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)); }
