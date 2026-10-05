import { encodeProgressRecord, decodeProgressRecord, selectProgressRecord, progressRecordSize } from '../lib/progress-record.js';
import { fileEntryNames } from '../lib/storage-names.js';
import { ByteQueueBudget } from '../lib/byte-queue.js';
import { createDebugLogRing } from '../lib/debug-log.js';

const writeBudget = new ByteQueueBudget();
const debugLogRing = createDebugLogRing(500);
let root, phase2Complete = false, preparedId, names, dataFileHandle, progressFileHandle;
let dataHandle, progressHandle, fileSize, chunkSize, chunkCount, hashes, bitmap;
let activeSlot = 0, generation = 0, recordSize = 0, fileReady = false;
let queue = [], queueRunning = false, verifyRequestId;

self.onmessage = ({ data }) => {
  switch (data?.type) {
    case 'PHASE1': phase1(); break;
    case 'PHASE2': phase2(data).catch(error => replyError('PHASE2_RESULT', error, { requestId: data.requestId })); break;
    case 'PREPARE_FILE': prepareFile(data); break;
    case 'OPEN_FILE': openFile(data).catch(error => replyError('STORAGE_ERROR', error, { requestId: data.requestId })); break;
    case 'WRITE_CHUNK': enqueueWrite(data); break;
    case 'VERIFY_ALL': verifyAll(data).catch(error => replyError('VERIFY_ERROR', error)); break;
    case 'CANCEL_VERIFY': if (verifyRequestId === data.requestId) verifyRequestId = undefined; break;
    case 'DOWNLOAD_FILE': downloadFile(data); break;
    case 'CLEAR': clearFile(data).catch(error => replyError('CLEAR_ERROR', error)); break;
    case 'CLOSE_KEEP': closeHandles(); break;
    case 'DEBUG_OFFSET_PROBE': offsetProbe(data).catch(error => replyError('OFFSET_PROBE_RESULT', error, { requestId: data.requestId })); break;
    default: break;
  }
};

function phase1() {
  const ok = typeof navigator.storage?.getDirectory === 'function' && typeof FileSystemFileHandle !== 'undefined' &&
    typeof FileSystemFileHandle.prototype.createSyncAccessHandle === 'function';
  self.postMessage({ type: 'PHASE1_RESULT', ok, getDirectory: typeof navigator.storage?.getDirectory === 'function', syncAccessHandle: typeof FileSystemFileHandle !== 'undefined' && typeof FileSystemFileHandle.prototype.createSyncAccessHandle === 'function' });
}

async function phase2({ token, requestId }) {
  let handle, name;
  try {
    if (!/^[a-f0-9]{16,64}$/.test(token || '')) throw new TypeError('Invalid probe token');
    root = await navigator.storage.getDirectory();
    for await (const [entryName] of root.entries()) if (entryName.startsWith('probe-')) await root.removeEntry(entryName);
    name = `probe-${token}`;
    const fileHandle = await root.getFileHandle(name, { create: true });
    handle = await fileHandle.createSyncAccessHandle();
    const input = new Uint8Array([19, 47, 83, 131]);
    writeFully(handle, input, 0, { operation: 'phase2-probe' }); handle.flush();
    const output = readFully(handle, 4, 0);
    handle.close(); handle = undefined;
    await root.removeEntry(name);
    phase2Complete = true;
    self.postMessage({ type: 'PHASE2_RESULT', requestId, ok: output.join(',') === input.join(',') });
  } catch (error) {
    try { handle?.close(); } catch { /* best-effort handle close */ }
    if (name && root) { try { await root.removeEntry(name); } catch { /* best-effort probe cleanup */ } }
    phase2Complete = false;
    self.postMessage({ type: 'PHASE2_RESULT', requestId, ok: false, message: messageOf(error) });
  }
}

function prepareFile({ fileId, requestId }) {
  try {
    if (!phase2Complete) throw new Error('Phase 2 storage probe must pass while the file lock is held.');
    names = fileEntryNames(fileId); preparedId = fileId;
    self.postMessage({ type: 'FILE_PREPARED', requestId, fileId, names });
  } catch (error) { replyError('STORAGE_ERROR', error, { requestId }); }
}

async function openFile(message) {
  if (!preparedId || !phase2Complete || message.fileId !== preparedId) throw new Error('File was not prepared after the lock-held phase 2 probe.');
  const { size, chunkSize: incomingChunkSize, chunkCount: incomingChunkCount, hashes: incomingHashes } = message;
  if (!Number.isSafeInteger(size) || size < 1 || !Number.isSafeInteger(incomingChunkSize) || incomingChunkSize < 1 ||
      !Number.isSafeInteger(incomingChunkCount) || incomingChunkCount < 1 || incomingChunkCount > 65536 ||
      incomingChunkCount !== Math.ceil(size / incomingChunkSize) || !Array.isArray(incomingHashes) || incomingHashes.length !== incomingChunkCount || incomingHashes.some(hash => !/^[a-f0-9]{64}$/.test(hash))) throw new TypeError('Invalid OPFS manifest parameters.');
  closeHandles(); fileReady = false;
  fileSize = size; chunkSize = incomingChunkSize; chunkCount = incomingChunkCount; hashes = incomingHashes;
  recordSize = progressRecordSize(chunkCount);
  let mismatch = false;
  dataFileHandle = await root.getFileHandle(names.data, { create: true });
  progressFileHandle = await root.getFileHandle(names.progress, { create: true });
  dataHandle = await dataFileHandle.createSyncAccessHandle();
  progressHandle = await progressFileHandle.createSyncAccessHandle();
  if (dataHandle.getSize() !== fileSize) { dataHandle.truncate(fileSize); mismatch = true; }
  if (progressHandle.getSize() !== recordSize * 2) progressHandle.truncate(recordSize * 2);
  const slots = [readSlot(0), readSlot(1)];
  const selected = await selectProgressRecord(slots, chunkCount);
  if (selected.status === 'mismatch') mismatch = true;
  if (mismatch) {
    closeHandles();
    await root.removeEntry(names.data).catch(() => {}); await root.removeEntry(names.progress).catch(() => {});
    dataFileHandle = await root.getFileHandle(names.data, { create: true });
    progressFileHandle = await root.getFileHandle(names.progress, { create: true });
    dataHandle = await dataFileHandle.createSyncAccessHandle(); progressHandle = await progressFileHandle.createSyncAccessHandle();
    dataHandle.truncate(fileSize); progressHandle.truncate(recordSize * 2);
  }
  if (selected.status === 'ok' && !mismatch) {
    bitmap = selected.record.bitmap; generation = selected.record.generation; activeSlot = selected.slot;
  } else {
    bitmap = new Uint8Array(Math.ceil(chunkCount / 8)); generation = 0; activeSlot = 0;
    const initial = await encodeProgressRecord({ generation, chunkCount, bitmap });
    writeFully(progressHandle, initial, 0, { operation: 'initial-progress-record' }); progressHandle.flush();
  }
  let changed = false;
  for (let index = 0; index < chunkCount; index++) if (hasBit(index)) {
    const length = chunkLength(index), bytes = readFully(dataHandle, length, chunkOffset(index));
    if (bytes.byteLength !== length || await hashHex(bytes) !== hashes[index]) { clearBit(index); changed = true; }
  }
  if (changed) await saveProgress();
  fileReady = true;
  self.postMessage({ type: 'FILE_OPENED', requestId: message.requestId, fileId: preparedId, size: fileSize, chunkCount, generation, bitmap: bitmap.slice(), queueBytes: writeBudget.bytes });
}

function enqueueWrite({ index, attempt, buffer }) {
  try {
    if (!fileReady || !Number.isSafeInteger(index) || index < 0 || index >= chunkCount || !Number.isSafeInteger(attempt) || attempt < 0 || attempt > 63 || !(buffer instanceof ArrayBuffer)) throw new TypeError('Invalid OPFS chunk write.');
    const length = chunkLength(index);
    if (buffer.byteLength !== length || hasBit(index)) throw new RangeError('Chunk write length or state mismatch.');
    const key = `${index}:${attempt}`;
    if (!writeBudget.reserve(key, length)) {
      self.postMessage({ type: 'QUEUE_FULL', index, attempt, buffer, queueBytes: writeBudget.bytes }, [buffer]);
      return;
    }
    queue.push({ key, index, attempt, buffer });
    self.postMessage({ type: 'QUEUE_STATE', queueBytes: writeBudget.bytes, availableBytes: writeBudget.available });
    void processQueue();
  } catch (error) { replyError('STORAGE_ERROR', error, { index, attempt }); }
}

async function processQueue() {
  if (queueRunning) return;
  queueRunning = true;
  try {
    while (queue.length) {
      const item = queue.shift();
      try {
        const bytes = new Uint8Array(item.buffer);
        if (await hashHex(bytes) !== hashes[item.index]) throw new Error(`Verified chunk ${item.index} changed before durable write.`);
        writeFully(dataHandle, bytes, chunkOffset(item.index), { operation: 'chunk', chunkIndex: item.index }); dataHandle.flush();
        setBit(item.index); await saveProgress();
        writeBudget.release(item.key);
        self.postMessage({ type: 'CHUNK_DURABLE', index: item.index, attempt: item.attempt, queueBytes: writeBudget.bytes, availableBytes: writeBudget.available });
      } catch (error) {
        writeBudget.release(item.key);
        for (const queued of queue.splice(0)) writeBudget.release(queued.key);
        self.postMessage({ type: 'STORAGE_ERROR', index: item.index, attempt: item.attempt, name: error?.name || 'Error', message: messageOf(error), queueBytes: writeBudget.bytes });
        closeHandles(); fileReady = false; return;
      }
    }
  } finally { queueRunning = false; }
}

async function saveProgress() {
  generation++;
  if (generation > 0xffffffff) throw new RangeError('Progress generation exhausted.');
  const targetSlot = 1 - activeSlot;
  const record = await encodeProgressRecord({ generation, chunkCount, bitmap });
  writeFully(progressHandle, record, targetSlot * recordSize, { operation: 'progress-record', generation, slot: targetSlot }); progressHandle.flush();
  activeSlot = targetSlot;
}

function readSlot(slot) {
  const bytes = readFully(progressHandle, recordSize, slot * recordSize);
  return bytes.byteLength === recordSize ? bytes : new Uint8Array(0);
}
function chunkLength(index) { const offset = chunkOffset(index); return Math.min(chunkSize, fileSize - offset); }
function chunkOffset(index) { return index * chunkSize; }
function hasBit(index) { const value = bitmap[Math.floor(index / 8)]; return Math.floor(value / (2 ** (index % 8))) % 2 === 1; }
function setBit(index) { if (!hasBit(index)) bitmap[Math.floor(index / 8)] += 2 ** (index % 8); }
function clearBit(index) { if (hasBit(index)) bitmap[Math.floor(index / 8)] -= 2 ** (index % 8); }

async function verifyAll({ requestId }) {
  if (!fileReady) throw new Error('Saved file is not open.');
  if (!bitmap || bitmap.some((byte, index) => {
    const remaining = chunkCount - index * 8;
    const expected = remaining >= 8 ? 255 : 2 ** Math.max(0, remaining) - 1;
    return byte !== expected;
  })) throw new Error('All chunks must be durably saved before whole-file verification.');
  verifyRequestId = requestId;
  for (let index = 0; index < chunkCount; index++) {
    if (verifyRequestId !== requestId) { self.postMessage({ type: 'VERIFY_CANCELLED', requestId }); return; }
    const length = chunkLength(index), bytes = readFully(dataHandle, length, chunkOffset(index));
    const matches = bytes.byteLength === length && await hashHex(bytes) === hashes[index];
    if (!matches) { self.postMessage({ type: 'VERIFY_MISMATCH', requestId, index }); return; }
    self.postMessage({ type: 'VERIFY_PROGRESS', requestId, done: index + 1, total: chunkCount });
  }
  verifyRequestId = undefined;
  self.postMessage({ type: 'VERIFY_COMPLETE', requestId, ok: true });
}

function downloadFile({ requestId }) {
  try {
    if (!fileReady || !dataFileHandle) throw new Error('Saved file is not open.');
    dataFileHandle.getFile().then(file => self.postMessage({ type: 'DOWNLOAD_FILE_READY', requestId, file })).catch(error => replyError('DOWNLOAD_ERROR', error, { requestId }));
  } catch (error) { replyError('DOWNLOAD_ERROR', error, { requestId }); }
}

async function clearFile({ requestId }) {
  if (!preparedId || !names) throw new Error('No saved file is selected.');
  closeHandles(); fileReady = false;
  for (const name of [names.data, names.progress]) { try { await root.removeEntry(name); } catch (error) { if (error?.name !== 'NotFoundError') throw error; } }
  bitmap = new Uint8Array(Math.ceil(chunkCount / 8)); self.postMessage({ type: 'CLEAR_OK', requestId });
}

async function offsetProbe({ requestId, targetSize = 5_000_000_000, offset = 4_500_000_000 }) {
  if (!root || !phase2Complete) throw new Error('Storage probe is unavailable.');
  const name = `offset-probe-${crypto.getRandomValues(new Uint8Array(8)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '')}`;
  let handle, sizeAfterTruncate = null;
  try {
    const file = await root.getFileHandle(name, { create: true }); handle = await file.createSyncAccessHandle();
    const expected = new Uint8Array([13, 29, 47, 83, 131, 197, 211, 251]);
    handle.truncate(targetSize);
    sizeAfterTruncate = handle.getSize();
    writeFully(handle, expected, offset, { operation: 'offset-probe', targetSize, sizeAfterTruncate }); handle.flush();
    const actual = readFully(handle, expected.byteLength, offset); const ok = actual.join(',') === expected.join(',') && handle.getSize() === targetSize;
    handle.close(); handle = undefined; await root.removeEntry(name);
    self.postMessage({ type: 'OFFSET_PROBE_RESULT', requestId, ok, targetSize, offset, sizeAfterTruncate });
  } catch (error) {
    try { handle?.close(); } catch { /* best effort */ }
    try { await root.removeEntry(name); } catch { /* best effort */ }
    self.postMessage({ type: 'OFFSET_PROBE_RESULT', requestId, ok: false, targetSize, offset, sizeAfterTruncate, diagnostics: error?.diagnostics || null, error: messageOf(error) });
  }
}

function writeFully(handle, bytes, offset, context = {}) {
  let written = 0;
  while (written < bytes.byteLength) {
    const writeOffset = offset + written, remaining = bytes.byteLength - written;
    const count = handle.write(bytes.subarray(written), { at: writeOffset });
    if (!Number.isSafeInteger(count) || count <= 0 || count > remaining) {
      let handleSize = null;
      try { handleSize = handle.getSize(); } catch { /* retain the original write failure */ }
      const entry = { at: Date.now(), level: 'error', message: 'OPFS returned an invalid partial write length', count, offset: writeOffset, remaining, written, requestedBytes: bytes.byteLength, handleSize, ...context };
      debugLogRing.add(entry);
      self.postMessage({ type: 'DEBUG_LOG', entry });
      const error = new Error(`OPFS returned invalid write count ${String(count)} at offset ${writeOffset}; remaining ${remaining}; file size ${String(handleSize)}; after truncate ${String(context.sizeAfterTruncate ?? 'unknown')}.`);
      error.diagnostics = entry;
      error.name = 'InvalidPartialWriteLength'; throw error;
    }
    written += count;
  }
}
function readFully(handle, length, offset) {
  const out = new Uint8Array(length); let read = 0;
  while (read < length) {
    const count = handle.read(out.subarray(read), { at: offset + read });
    if (!Number.isSafeInteger(count) || count < 0 || count > length - read) throw new Error('OPFS returned an invalid partial read length.');
    if (count === 0) break;
    read += count;
  }
  return read === length ? out : out.subarray(0, read);
}
async function hashHex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}
function closeHandles() {
  try { dataHandle?.flush(); } catch { /* preserve best effort */ }
  try { progressHandle?.flush(); } catch { /* preserve best effort */ }
  try { dataHandle?.close(); } catch { /* best effort */ }
  try { progressHandle?.close(); } catch { /* best effort */ }
  dataHandle = progressHandle = undefined;
}
function messageOf(error) { return String(error?.message || error).replace(/[\r\n\0]/g, ' ').slice(0, 240); }
function replyError(type, error, fields = {}) { self.postMessage({ type, ...fields, name: error?.name || 'Error', message: messageOf(error) }); }
