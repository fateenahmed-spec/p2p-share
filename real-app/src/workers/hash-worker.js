import { chunkSizeFor } from '../lib/chunk-size.js';
import { encodeManifest, fileId } from '../lib/manifest.js';
self.onmessage = async ({ data }) => {
  const { requestId, file } = data;
  try {
    if (!file || !Number.isSafeInteger(file.size) || file.size <= 0) throw new Error('Choose a non-empty file.');
    const chunkSize = chunkSizeFor(file.size), count = Math.ceil(file.size / chunkSize), hashes = [];
    for (let i = 0; i < count; i++) {
      const part = await file.slice(i * chunkSize, Math.min(file.size, (i + 1) * chunkSize)).arrayBuffer();
      hashes.push(new Uint8Array(await crypto.subtle.digest('SHA-256', part)));
      self.postMessage({ type: 'progress', requestId, done: i + 1, total: count });
    }
    const bytes = encodeManifest({ name: file.name, size: file.size, chunkSize, chunkHashes: hashes });
    const id = await fileId(bytes);
    self.postMessage({ type: 'ready', requestId, manifest: bytes.buffer, fileId: id, chunkSize, chunkCount: count }, [bytes.buffer]);
  } catch (error) { self.postMessage({ type: 'error', requestId, message: error.message }); }
};
