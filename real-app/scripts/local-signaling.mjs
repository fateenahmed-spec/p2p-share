import { PeerServer } from 'peer';
const server = PeerServer({ port: 9001, path: '/', proxied: false, allow_discovery: false });
server.on('connection', client => console.log(`PeerJS client connected: ${client.getId()}`));
server.on('disconnect', client => console.log(`PeerJS client disconnected: ${client.getId()}`));
console.log('Local PeerServer listening at http://localhost:9001');
