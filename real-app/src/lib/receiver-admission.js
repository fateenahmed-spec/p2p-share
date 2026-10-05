export const MAX_RECEIVERS = 10;

export function admitReceiver(activeCount, { sendError, close, maxReceivers = MAX_RECEIVERS }) {
  if (!Number.isSafeInteger(activeCount) || activeCount < 0 || !Number.isSafeInteger(maxReceivers) || maxReceivers < 1 ||
      typeof sendError !== 'function' || typeof close !== 'function') throw new TypeError('Invalid receiver admission arguments');
  if (activeCount < maxReceivers) return true;
  try { sendError({ type: 'ERROR', code: 'ROOM_FULL', message: 'This sender already has the maximum number of receivers.' }); }
  finally { close(); }
  return false;
}
