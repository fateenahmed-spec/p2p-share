export function chunkFileOffset(index, chunkSize) {
  if (!Number.isSafeInteger(index) || index < 0 || !Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new RangeError('Invalid chunk offset inputs');
  const offset = index * chunkSize;
  if (!Number.isSafeInteger(offset)) throw new RangeError('Chunk offset exceeds safe integer range');
  return offset;
}

export function chunkLength(size, chunkSize, index) {
  if (!Number.isSafeInteger(size) || size <= 0 || !Number.isSafeInteger(chunkSize) || chunkSize <= 0 ||
      !Number.isSafeInteger(index) || index < 0 || index >= Math.ceil(size / chunkSize)) throw new RangeError('Invalid chunk length inputs');
  const offset = chunkFileOffset(index, chunkSize);
  return Math.min(chunkSize, size - offset);
}
