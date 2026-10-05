export class RequestLedger {
  constructor(maxAttempts = 64) { this.maxAttempts = maxAttempts; this.latest = new Map(); }
  observe(index, attempt) {
    if (!Number.isSafeInteger(index) || index < 0 || !Number.isSafeInteger(attempt) || attempt < 0) return 'invalid';
    if (attempt >= this.maxAttempts) return 'exhausted';
    const previous = this.latest.get(index);
    if (previous === undefined) { this.latest.set(index, attempt); return 'new'; }
    if (attempt === previous) return 'duplicate';
    if (attempt < previous) return 'stale';
    this.latest.set(index, attempt);
    return 'superseded';
  }
  current(index, attempt) { return this.latest.get(index) === attempt; }
  delete(index) { this.latest.delete(index); }
}

export class RequestScheduler {
  constructor({ chunkCount, maxInFlight = 8, rng, clock = () => performance.now() }) {
    if (!Number.isSafeInteger(chunkCount) || chunkCount < 1 || chunkCount > 65536 || !Number.isSafeInteger(maxInFlight) || maxInFlight < 1) throw new RangeError('Invalid scheduler settings');
    this.chunkCount = chunkCount; this.maxInFlight = maxInFlight; this.rng = rng; this.clock = clock;
    this.order = Array.from({ length: chunkCount }, (_, index) => index);
    for (let i = this.order.length - 1; i > 0; i--) { const j = rng.integer(i + 1); [this.order[i], this.order[j]] = [this.order[j], this.order[i]]; }
    this.holders = new Set(); this.verified = new Set(); this.failed = new Set();
    this.attempts = new Map(); this.inFlight = new Map(); this.failures = new Map();
    this.cursor = 0;
  }
  replaceHolders(indices) { this.holders = new Set(indices); }
  addHolder(index) { this.holders.add(index); }
  removeHolder(index) { this.holders.delete(index); }
  next() {
    if (this.inFlight.size >= this.maxInFlight || this.cursor >= this.order.length) return null;
    while (this.cursor < this.order.length) {
      const index = this.order[this.cursor++];
      if (this.verified.has(index) || this.failed.has(index) || this.inFlight.has(index) || !this.holders.has(index)) continue;
      const attempt = this.attempts.get(index) || 0;
      if (attempt >= 64) { this.failed.add(index); continue; }
      this.inFlight.set(index, { attempt, sentAt: this.clock() });
      return { index, attempt };
    }
    return null;
  }
  complete(index, attempt) {
    const current = this.inFlight.get(index);
    if (!current || current.attempt !== attempt) return { status: 'stale' };
    this.inFlight.delete(index); this.verified.add(index);
    return { status: 'verified' };
  }
  fail(index, attempt) {
    const current = this.inFlight.get(index);
    if (!current || current.attempt !== attempt) return { status: 'stale' };
    this.inFlight.delete(index);
    const failures = (this.failures.get(index) || 0) + 1;
    this.failures.set(index, failures);
    if (failures >= 3 || attempt >= 63) { this.failed.add(index); return { status: 'failed', failures }; }
    this.attempts.set(index, attempt + 1);
    this.order.push(index); // Retry at the tail to preserve random order for other chunks.
    return { status: 'retry', attempt: attempt + 1, failures };
  }
  markUnavailable(index, attempt) {
    const current = this.inFlight.get(index);
    if (!current || current.attempt !== attempt) return { status: 'stale' };
    this.inFlight.delete(index); this.failed.add(index);
    return { status: 'failed', reason: 'NOT_HAVE' };
  }
  expire(timeoutMs) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new RangeError('Invalid timeout');
    const now = this.clock(), expired = [];
    for (const [index, current] of this.inFlight) if (now - current.sentAt >= timeoutMs) {
      const result = this.fail(index, current.attempt); expired.push({ index, attempt: current.attempt, ...result });
    }
    return expired;
  }
  get isComplete() { return this.verified.size === this.chunkCount; }
}
