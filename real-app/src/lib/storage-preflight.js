export async function checkAvailableStorage(size, { estimate, persist, formatBytes }) {
  if (!Number.isSafeInteger(size) || size < 1 || typeof estimate !== 'function' || typeof persist !== 'function' || typeof formatBytes !== 'function') throw new TypeError('Invalid storage preflight arguments');
  const required = Math.ceil(size * 1.10 + 128 * 1024 ** 2);
  let warning = '';
  try {
    if (!await persist()) warning = 'Browser did not grant persistent-storage status; saved data may be evicted under storage pressure.';
  } catch (error) { warning = `Could not request persistent storage: ${String(error?.message || error)}`; }
  try {
    const { quota, usage } = await estimate();
    if (!Number.isFinite(quota) || !Number.isFinite(usage)) throw new Error('Storage estimate did not return quota and usage');
    const available = Math.max(0, quota - usage);
    return {
      ok: available >= required, required, available, quota, usage, warning,
      message: available < required ? `Insufficient origin storage: ${formatBytes(required)} required; ${formatBytes(available)} available. Existing saved data is retained. Clear saved data to free this file's storage.` : '',
    };
  } catch (error) {
    return { ok: true, required, available: null, quota: null, usage: null, warning: `Could not verify available storage: ${String(error?.message || error)}. Transfer may fail if the disk fills.` };
  }
}
