const GOOGLE_STUN = 'stun:stun.l.google.com:19302';
export function makePeerOptions(settings = {}) {
  const iceServers = [{ urls: GOOGLE_STUN }];
  if (Array.isArray(settings.iceServers)) for (const server of settings.iceServers) {
    if (!server || typeof server.urls !== 'string' || !server.urls.trim()) continue;
    if (server.urls.trim() === GOOGLE_STUN) continue;
    const item = { urls: server.urls.trim() };
    if (server.username) item.username = server.username;
    if (server.credential) item.credential = server.credential;
    iceServers.push(item);
  }
  const config = { sdpSemantics: 'unified-plan', iceServers };
  if (settings.forceRelay) config.iceTransportPolicy = 'relay';
  return { config };
}
