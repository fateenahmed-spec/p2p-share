export const OPFS_WRITE_QUEUE_LIMIT = 16 * 1024 ** 2;

export class ByteQueueBudget {
  constructor(limit = OPFS_WRITE_QUEUE_LIMIT) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Invalid byte queue cap');
    this.limit = limit; this.items = new Map(); this.bytes = 0;
  }
  reserve(key, bytes) {
    if (typeof key !== 'string' || !key || !Number.isSafeInteger(bytes) || bytes < 1 || this.items.has(key) || this.bytes + bytes > this.limit) return false;
    this.items.set(key, bytes); this.bytes += bytes; return true;
  }
  release(key) {
    const bytes = this.items.get(key);
    if (bytes === undefined) return false;
    this.items.delete(key); this.bytes -= bytes; return true;
  }
  get available() { return this.limit - this.bytes; }
}
