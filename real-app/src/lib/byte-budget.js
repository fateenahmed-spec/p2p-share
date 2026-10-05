export class ByteBudget {
  constructor({ globalLimit = 64 * 1024 ** 2, peerLimit = 16 * 1024 ** 2 } = {}) {
    if (!Number.isSafeInteger(globalLimit) || globalLimit < 1 || !Number.isSafeInteger(peerLimit) || peerLimit < 1 || peerLimit > globalLimit) throw new RangeError('Invalid byte budget limits');
    this.globalLimit = globalLimit; this.peerLimit = peerLimit;
    this.queues = new Map(); this.order = []; this.cursor = 0; this.reservations = new Map();
  }
  enqueue(peerId, key, bytes) {
    if (typeof peerId !== 'string' || !peerId || typeof key !== 'string' || !key || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > this.peerLimit || this.reservations.has(key)) return false;
    let queue = this.queues.get(peerId);
    if (!queue) { queue = []; this.queues.set(peerId, queue); this.order.push(peerId); }
    if (queue.some(item => item.key === key)) return false;
    queue.push({ peerId, key, bytes });
    return true;
  }
  grantNext({ bufferedGlobal = 0, bufferedByPeer = new Map(), canGrant = () => true } = {}) {
    if (!Number.isSafeInteger(bufferedGlobal) || bufferedGlobal < 0) throw new RangeError('Invalid global buffered bytes');
    if (!this.order.length) return null;
    for (let visited = 0; visited < this.order.length; visited++) {
      const slot = (this.cursor + visited) % this.order.length;
      const peerId = this.order[slot], queue = this.queues.get(peerId);
      if (!queue?.length || !canGrant(peerId)) continue;
      const item = queue[0], peerBuffered = bufferedByPeer.get(peerId) || 0;
      if (!Number.isSafeInteger(peerBuffered) || peerBuffered < 0) throw new RangeError('Invalid per-peer buffered bytes');
      const globalReserved = this.reservedBytes();
      const peerReserved = this.reservedBytes(peerId);
      if (globalReserved + bufferedGlobal + item.bytes > this.globalLimit || peerReserved + peerBuffered + item.bytes > this.peerLimit) continue;
      queue.shift(); this.reservations.set(item.key, item);
      this.cursor = (slot + 1) % this.order.length;
      this.clean(peerId);
      return item;
    }
    return null;
  }
  canQueue(peerId, frameBytes, { bufferedGlobal = 0, bufferedByPeer = new Map() } = {}) {
    if (!Number.isSafeInteger(frameBytes) || frameBytes < 0) return false;
    return this.reservedBytes() + bufferedGlobal + frameBytes <= this.globalLimit &&
      this.reservedBytes(peerId) + (bufferedByPeer.get(peerId) || 0) + frameBytes <= this.peerLimit;
  }
  release(key) { return this.reservations.delete(key); }
  cancel(peerId, key) {
    const queue = this.queues.get(peerId);
    if (queue) { const index = queue.findIndex(item => item.key === key); if (index !== -1) queue.splice(index, 1); this.clean(peerId); }
    return this.release(key);
  }
  disconnect(peerId) {
    this.queues.delete(peerId); this.order = this.order.filter(id => id !== peerId);
    for (const [key, item] of this.reservations) if (item.peerId === peerId) this.reservations.delete(key);
    this.cursor = this.order.length ? this.cursor % this.order.length : 0;
  }
  reservedBytes(peerId) {
    let total = 0;
    for (const item of this.reservations.values()) if (peerId === undefined || item.peerId === peerId) total += item.bytes;
    return total;
  }
  countedBytes(bufferedGlobal = 0) { return this.reservedBytes() + bufferedGlobal; }
  clean(peerId) {
    if (this.queues.get(peerId)?.length) return;
    this.queues.delete(peerId); this.order = this.order.filter(id => id !== peerId);
    this.cursor = this.order.length ? this.cursor % this.order.length : 0;
  }
}
