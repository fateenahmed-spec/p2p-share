export class RoundRobinCursor {
  constructor() { this.nextKey = undefined; }
  next(items, keyOf = value => value) {
    if (!items.length) return undefined;
    let index = this.nextKey === undefined ? 0 : items.findIndex(item => keyOf(item) === this.nextKey);
    if (index < 0) index = 0;
    const item = items[index];
    this.nextKey = keyOf(items[(index + 1) % items.length]);
    return item;
  }
}
