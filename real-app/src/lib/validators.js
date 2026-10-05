const LIMIT = 65536;
const PEER_ID = /^[A-Za-z0-9]+(?:[ _-][A-Za-z0-9]+)*$/;
const HEX32 = /^[a-f0-9]{32}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const REJECT_REASONS = new Set(['BUSY', 'RANGE', 'RATE', 'NOT_HAVE', 'SHUTDOWN', 'READ_ERROR']);
const ERROR_CODES = new Set(['VERSION', 'FILE_CHANGED', 'ROOM_FULL', 'PROTOCOL', 'SHUTDOWN']);

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function safeInt(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}
function fail(message) { throw new TypeError(message); }

export function parseControlMessage(value) {
  if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > LIMIT) fail('Control message must be a string no larger than 64 KiB');
  let m;
  try { m = JSON.parse(value); } catch { fail('Malformed control JSON'); }
  if (!record(m) || typeof m.type !== 'string') fail('Control message needs a type');
  switch (m.type) {
    case 'HELLO':
      if (!['sender', 'receiver'].includes(m.role) || m.protocolVersion !== 1 ||
          (m.role === 'sender' ? !HEX32.test(m.sessionId || '') : m.sessionId !== undefined)) fail('Invalid HELLO');
      return m.role === 'sender'
        ? { type: m.type, role: m.role, protocolVersion: m.protocolVersion, sessionId: m.sessionId }
        : { type: m.type, role: m.role, protocolVersion: m.protocolVersion };
    case 'MANIFEST_START':
      if (typeof m.name !== 'string' || new TextEncoder().encode(m.name).length > 4096 ||
          !safeInt(m.size, 1, 256 * 1024 ** 3) || !safeInt(m.chunkSize, 1, 0xffffffff) ||
          !safeInt(m.chunkCount, 1, 65536) || m.chunkCount !== Math.ceil(m.size / m.chunkSize) ||
          !HEX64.test(m.fileId || '') || !safeInt(m.manifestBytes, 1, 2_101_278)) fail('Invalid MANIFEST_START');
      return { type: m.type, name: m.name, size: m.size, chunkSize: m.chunkSize, chunkCount: m.chunkCount, fileId: m.fileId, manifestBytes: m.manifestBytes };
    case 'MANIFEST_DATA':
      if (!safeInt(m.seq, 0) || typeof m.data !== 'string' || m.data.length === 0 || m.data.length > 32768 || m.data.length % 2 || !/^[a-f0-9]+$/.test(m.data)) fail('Invalid MANIFEST_DATA');
      return { type: m.type, seq: m.seq, data: m.data };
    case 'MANIFEST_END':
      if (!safeInt(m.parts, 1)) fail('Invalid MANIFEST_END');
      return { type: m.type, parts: m.parts };
    case 'REQUEST':
    case 'CANCEL':
      if (!safeInt(m.index, 0, 65535) || !safeInt(m.attempt, 0, 63)) fail(`Invalid ${m.type}`);
      return { type: m.type, index: m.index, attempt: m.attempt };
    case 'HAVE':
      if (!Array.isArray(m.indices) || m.indices.length > 1024 || m.indices.some(i => !safeInt(i, 0, 65535)) || new Set(m.indices).size !== m.indices.length) fail('Invalid HAVE');
      return { type: m.type, indices: [...m.indices] };
    case 'BITFIELD':
      if (typeof m.hex !== 'string' || m.hex.length > 16384 || m.hex.length % 2 || !/^[a-f0-9]*$/.test(m.hex)) fail('Invalid BITFIELD');
      return { type: m.type, hex: m.hex };
    case 'REJECT':
      if (!safeInt(m.index, 0, 65535) || !safeInt(m.attempt, 0, 63) || !REJECT_REASONS.has(m.reason)) fail('Invalid REJECT');
      return { type: m.type, index: m.index, attempt: m.attempt, reason: m.reason };
    case 'PING':
    case 'PONG':
      if (!safeInt(m.seq, 0)) fail(`Invalid ${m.type}`);
      return { type: m.type, seq: m.seq };
    case 'ERROR':
      if (!ERROR_CODES.has(m.code) || typeof m.message !== 'string' || m.message.length > 200) fail('Invalid ERROR');
      return { type: m.type, code: m.code, message: m.message };
    default: fail('Unknown control message type');
  }
}

export function encodeControlMessage(message) {
  // Run the same strict schema on outbound traffic; serializing before validation
  // ensures control connections only ever carry JSON strings.
  const encoded = JSON.stringify(message);
  parseControlMessage(encoded);
  return encoded;
}

export function parseShareLink(input) {
  const u = new URL(input);
  if (u.searchParams.getAll('room').length !== 1 || u.searchParams.getAll('fid').length !== 1 || [...u.searchParams.keys()].some(k => k !== 'room' && k !== 'fid')) fail('Link must contain exactly one room and fid');
  const room = u.searchParams.get('room'), fid = u.searchParams.get('fid');
  if (!PEER_ID.test(room) || !HEX64.test(fid)) fail('Invalid room or file ID');
  return { room, fid };
}
