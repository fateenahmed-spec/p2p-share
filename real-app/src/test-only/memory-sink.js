export const MEMORY_SINK_LIMIT = 64 * 1024 ** 2;

export function createMemorySink(size, allocate = length => new Uint8Array(length)) {
  if (!Number.isSafeInteger(size) || size <= 0) throw new RangeError('Memory sink size must be a positive safe integer');
  if (size > MEMORY_SINK_LIMIT) throw new RangeError(`Memory sink is limited to ${MEMORY_SINK_LIMIT} bytes`);
  const bytes = allocate(size);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== size) throw new TypeError('Memory sink allocator returned the wrong buffer');
  const verified = new Set();
  return {
    size,
    write(index, offset, chunk) {
      if (!Number.isSafeInteger(index) || index < 0 || !Number.isSafeInteger(offset) || offset < 0 ||
          !(chunk instanceof Uint8Array) || offset + chunk.byteLength > size || verified.has(index)) throw new RangeError('Invalid memory sink write');
      bytes.set(chunk, offset); verified.add(index);
    },
    has(index) { return verified.has(index); },
    verifiedCount() { return verified.size; },
    view() { return bytes; },
  };
}
