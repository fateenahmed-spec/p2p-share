export class SpeedWindow {
  constructor({ windowMs = 1000, now = () => performance.now() } = {}) {
    if (!Number.isFinite(windowMs) || windowMs < 1 || typeof now !== 'function') throw new RangeError('Invalid speed window');
    this.windowMs = windowMs; this.now = now; this.samples = [];
  }
  add(bytes, at = this.now()) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isFinite(at)) throw new RangeError('Invalid speed sample');
    this.samples.push({ bytes, at }); this.expire(at);
  }
  expire(at = this.now()) { this.samples = this.samples.filter(sample => at - sample.at <= this.windowMs && at >= sample.at); }
  bytes(at = this.now()) { this.expire(at); return this.samples.reduce((sum, sample) => sum + sample.bytes, 0); }
  bytesPerSecond(at = this.now()) { return this.bytes(at) * 1000 / this.windowMs; }
}
