export const CHUNK_START = 1;
export const CHUNK_DATA = 2;
export const CHUNK_END = 3;
export const FRAME_HEADER_BYTES = 10;
export const MAX_FRAME_PAYLOAD_BYTES = 16384;
export const MAX_FRAME_BYTES = FRAME_HEADER_BYTES + MAX_FRAME_PAYLOAD_BYTES;

function fail(message) { throw new TypeError(message); }

export function validateFrameFields({ type, attempt, index, offset, payload }) {
  if (![CHUNK_START, CHUNK_DATA, CHUNK_END].includes(type)) fail('Unknown bulk frame type');
  if (!Number.isInteger(attempt) || attempt < 0 || attempt > 63) fail('Invalid frame attempt');
  if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) fail('Invalid frame chunk index');
  if (!Number.isInteger(offset) || offset < 0 || offset > 0xffffffff) fail('Invalid frame offset');
  if (!(payload instanceof Uint8Array)) fail('Frame payload must be a Uint8Array');
  if (payload.byteLength > MAX_FRAME_PAYLOAD_BYTES) fail('Bulk frame payload is too large');
  if (type === CHUNK_START && (offset !== 0 || payload.byteLength !== 4)) fail('Invalid CHUNK_START');
  if (type === CHUNK_DATA && (payload.byteLength < 1 || payload.byteLength > MAX_FRAME_PAYLOAD_BYTES)) fail('Invalid CHUNK_DATA');
  if (type === CHUNK_END && payload.byteLength !== 0) fail('Invalid CHUNK_END');
  return true;
}

export function encodeFrame({ type, attempt, index, offset, payload }) {
  validateFrameFields({ type, attempt, index, offset, payload });
  const frame = new Uint8Array(FRAME_HEADER_BYTES + payload.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint8(0, type);
  view.setUint8(1, attempt);
  view.setUint32(2, index, false);
  view.setUint32(6, offset, false);
  frame.set(payload, FRAME_HEADER_BYTES);
  return frame.buffer;
}

export function validateFrame(input) {
  let bytes;
  if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
  else if (ArrayBuffer.isView(input)) bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  else fail('Bulk frame must be binary');
  if (bytes.byteLength < FRAME_HEADER_BYTES || bytes.byteLength > MAX_FRAME_BYTES) fail('Invalid bulk frame length');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = view.getUint8(0), attempt = view.getUint8(1), index = view.getUint32(2, false), offset = view.getUint32(6, false);
  const payload = bytes.subarray(FRAME_HEADER_BYTES);
  validateFrameFields({ type, attempt, index, offset, payload });
  return { type, attempt, index, offset, payload };
}

export function decodeFrame(input) {
  try { return { ok: true, frame: validateFrame(input) }; }
  catch (error) { return { ok: false, error: String(error?.message || error).slice(0, 200) }; }
}

export class FrameReassembler {
  constructor({ maxInFlight = 8 } = {}) {
    this.maxInFlight = maxInFlight;
    this.requests = new Map();
  }
  request(index, attempt, length) {
    if (!Number.isInteger(index) || index < 0 || index > 0xffffffff || !Number.isInteger(attempt) || attempt < 0 || attempt > 63 || !Number.isSafeInteger(length) || length <= 0 || length > 0xffffffff) throw new RangeError('Invalid reassembly request');
    const previous = this.requests.get(index);
    if (previous && attempt <= previous.attempt) return false;
    if (!previous && this.requests.size >= this.maxInFlight) return false;
    this.requests.set(index, { attempt, length, buffer: null, received: 0 });
    return true;
  }
  cancel(index, attempt) {
    const request = this.requests.get(index);
    if (request?.attempt === attempt) return this.requests.delete(index);
    return false;
  }
  accept(input) {
    const decoded = decodeFrame(input);
    if (!decoded.ok) return { status: 'invalid', error: decoded.error };
    const frame = decoded.frame, request = this.requests.get(frame.index);
    if (!request || request.attempt !== frame.attempt) return { status: 'stale' };
    if (frame.type === CHUNK_START) {
      if (request.buffer) return { status: 'invalid', error: 'Duplicate CHUNK_START' };
      const declaredLength = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength).getUint32(0, false);
      if (declaredLength !== request.length) return { status: 'invalid', error: 'CHUNK_START length mismatch' };
      request.buffer = new Uint8Array(request.length);
      request.received = 0;
      return { status: 'started', index: frame.index, attempt: frame.attempt, length: request.length };
    }
    if (!request.buffer) return { status: 'invalid', error: 'Chunk data arrived before CHUNK_START' };
    if (frame.type === CHUNK_DATA) {
      if (frame.offset !== request.received || frame.offset + frame.payload.byteLength > request.length) return { status: 'invalid', error: 'CHUNK_DATA offset or length mismatch' };
      request.buffer.set(frame.payload, frame.offset);
      request.received += frame.payload.byteLength;
      return { status: 'progress', index: frame.index, attempt: frame.attempt, received: request.received, length: request.length };
    }
    if (frame.type === CHUNK_END) {
      if (frame.offset !== request.length || request.received !== request.length) return { status: 'invalid', error: 'CHUNK_END offset mismatch' };
      this.requests.delete(frame.index);
      return { status: 'complete', index: frame.index, attempt: frame.attempt, buffer: request.buffer };
    }
    return { status: 'invalid', error: 'Unexpected bulk frame' };
  }
}
