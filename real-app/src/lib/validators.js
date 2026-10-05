const LIMIT = 65536;
export function parseControlMessage(value) {
  if (typeof value !== 'string' || value.length > LIMIT) throw new TypeError('Control message must be a string no larger than 64 KiB');
  let m; try { m = JSON.parse(value); } catch { throw new TypeError('Malformed control JSON'); }
  if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.type !== 'string') throw new TypeError('Control message needs a type');
  return m;
}
export function parseShareLink(input) {
  const u = new URL(input);
  if (u.searchParams.getAll('room').length !== 1 || u.searchParams.getAll('fid').length !== 1 || [...u.searchParams.keys()].some(k => k !== 'room' && k !== 'fid')) throw new TypeError('Link must contain exactly one room and fid');
  const room = u.searchParams.get('room'), fid = u.searchParams.get('fid');
  if (!/^[a-f0-9]{32}$/.test(room) || !/^[a-f0-9]{64}$/.test(fid)) throw new TypeError('Invalid room or file ID');
  return { room, fid };
}
