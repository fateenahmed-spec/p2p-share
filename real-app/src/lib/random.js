const WORDS_PER_CALL = 16384;
export function createRandom(source = (a) => globalThis.crypto.getRandomValues(a)) {
  let pool = new Uint32Array(0), at = 0;
  function word() {
    if (at >= pool.length) { pool = new Uint32Array(WORDS_PER_CALL); source(pool); at = 0; }
    return pool[at++];
  }
  return {
    uint32: word,
    integer(n) {
      if (!Number.isSafeInteger(n) || n < 1 || n > 4294967296) throw new RangeError('Range must be 1..2^32');
      const limit = 4294967296 - (4294967296 % n);
      let x; do { x = word(); } while (x >= limit);
      return x % n;
    },
    bytes(length) {
      const out = new Uint8Array(length);
      for (let i = 0; i < length; i++) out[i] = this.integer(256);
      return out;
    },
    hex128() { return Array.from(this.bytes(16), b => b.toString(16).padStart(2, '0')).join(''); }
  };
}
export const random = createRandom();
