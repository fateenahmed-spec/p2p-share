export function createDebugLogRing(limit = 500) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Invalid debug log capacity');
  const records = [];
  return {
    add(record) { records.push(record); if (records.length > limit) records.splice(0, records.length - limit); return record; },
    list() { return records.slice(); },
    clear() { records.length = 0; },
  };
}
