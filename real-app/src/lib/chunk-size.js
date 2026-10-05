export function chunkSizeFor(size) {
  if (!Number.isSafeInteger(size) || size <= 0 || size > 256 * 1024 ** 3) throw new RangeError('File size must be 1 byte through 256 GiB');
  if (size <= 256 * 1024 ** 2) return 64 * 1024;
  if (size <= 1024 ** 3) return 256 * 1024;
  if (size <= 4 * 1024 ** 3) return 1024 ** 2;
  return 4 * 1024 ** 2;
}
