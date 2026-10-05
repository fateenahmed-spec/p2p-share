import { PeerServer } from 'peer';
const port = Number(process.env.P2P_SIGNAL_PORT || 9001);
const server = PeerServer({ port, path: '/', proxied: false, allow_discovery: false });
server.on('connection', client => console.log(`PeerJS client connected: ${client.getId()}`));
server.on('disconnect', client => console.log(`PeerJS client disconnected: ${client.getId()}`));
console.log(`Local PeerServer listening at http://localhost:${port}`);
