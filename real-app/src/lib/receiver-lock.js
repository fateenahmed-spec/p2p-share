export async function clearWithFileLock({ lockHeld, requestLock, clear }) {
  if (typeof requestLock !== 'function' || typeof clear !== 'function') throw new TypeError('Invalid clear-lock callbacks');
  if (lockHeld) { await clear(); return true; }
  let cleared = false;
  await requestLock(async lock => {
    if (!lock) return;
    await clear();
    cleared = true;
  });
  return cleared;
}
