export class TokenBucket {
  constructor({ rateBytesPerSecond, burstBytes, now = () => performance.now() }) {
    if (!(rateBytesPerSecond > 0) || !Number.isFinite(rateBytesPerSecond) || !Number.isSafeInteger(burstBytes) || burstBytes < 1 || typeof now !== 'function') throw new RangeError('Invalid token bucket settings');
    this.rate = rateBytesPerSecond;
    this.burst = burstBytes;
    this.now = now;
    this.tokens = burstBytes;
    this.last = now();
  }
  refill() {
    const current = this.now();
    if (!Number.isFinite(current) || current < this.last) throw new RangeError('Clock must be monotonic');
    this.tokens = Math.min(this.burst, this.tokens + (current - this.last) * this.rate / 1000);
    this.last = current;
  }
  take(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('Invalid token request');
    this.refill();
    if (bytes > this.tokens) return false;
    this.tokens -= bytes;
    return true;
  }
  delayFor(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('Invalid token request');
    this.refill();
    return Math.max(0, (bytes - this.tokens) * 1000 / this.rate);
  }
}
