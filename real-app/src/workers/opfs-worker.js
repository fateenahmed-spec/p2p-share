self.onmessage = async ({ data }) => {
  if (data.type === 'PHASE1') {
    const ok = typeof navigator.storage?.getDirectory === 'function' &&
      typeof FileSystemFileHandle !== 'undefined' &&
      typeof FileSystemFileHandle.prototype.createSyncAccessHandle === 'function';
    self.postMessage({ type: 'PHASE1_RESULT', ok });
    return;
  }
  if (data.type !== 'PHASE2') return;
  let handle;
  try {
    const root = await navigator.storage.getDirectory();
    for await (const [name] of root.entries()) if (name.startsWith('probe-')) await root.removeEntry(name);
    const name = `probe-${data.token}`;
    const fileHandle = await root.getFileHandle(name, { create: true });
    handle = await fileHandle.createSyncAccessHandle();
    const written = handle.write(new Uint8Array([19, 47, 83, 131]), { at: 0 });
    handle.flush();
    const bytes = new Uint8Array(4);
    const read = handle.read(bytes, { at: 0 });
    handle.close(); handle = undefined;
    await root.removeEntry(name);
    self.postMessage({ type: 'PHASE2_RESULT', ok: written === 4 && read === 4 && bytes.join(',') === '19,47,83,131' });
  } catch (error) {
    try { handle?.close(); } catch { /* close best effort */ }
    self.postMessage({ type: 'PHASE2_RESULT', ok: false, error: String(error?.message || error).slice(0, 200) });
  }
};
