import { chunkSizeFor } from '../lib/chunk-size.js';
import { encodeManifest, fileId } from '../lib/manifest.js';
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'VERIFY_CHUNK') {
      const { index, attempt, buffer, expectedHash } = data;
      if (!Number.isSafeInteger(index) || index < 0 || !Number.isSafeInteger(attempt) || attempt < 0 || attempt > 63 ||
          !(buffer instanceof ArrayBuffer) || typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error('Invalid chunk verification request.');
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
      const actual = Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
      if (actual !== expectedHash) { self.postMessage({ type: 'CHUNK_HASH_MISMATCH', index, attempt, actual, expectedHash }); return; }
      self.postMessage({ type: 'CHUNK_HASH_OK', index, attempt, buffer }, [buffer]);
      return;
    }
    if (data.type !== 'HASH_FILE') throw new Error('Unknown hash-worker message.');
    const { requestId, file } = data;
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
