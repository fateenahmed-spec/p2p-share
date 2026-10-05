# P2P Share — Stage 1

Requires Node 24.21.0 and npm. PeerJS 1.5.5 is pinned in `package.json`; the browser uses the matching vendored ESM, with its package SHA-256 recorded in `DESIGN.md`.

## Run locally

```powershell
npm ci
Copy-Item config.example.json config.local.json
```

For local signaling, edit `config.local.json` to use `{"signaling":{"host":"localhost","port":9001,"path":"/","key":"peerjs","secure":false}}` and keep the Google STUN entry. Then use two terminals:

```powershell
npm run signal
npm run dev
```

Open `http://localhost:9000/sender.html`. Generate the requested non-zero 5 MiB sample and its Node streaming SHA-256 with:

```powershell
node scripts/make-test-file.js
```

Choose `scratch/test-5mb.bin`, wait for the hash worker, then open the shown link in a second tab. S1 confirms the HELLO, two-channel pairing, canonical manifest/file-ID check, BITFIELD, and PING/PONG. File data transfer is added in a later sub-step.

Run the pure Node tests with `npm test`.

## Privacy and relay settings

ICE URLs and credentials are stored per tab in `sessionStorage`; each tab/device that needs TURN must enter its own credentials. Any script running on this origin can read `sessionStorage`, so this app loads no third-party scripts. Credentials are not put in logs, diagnostics, or links. The deployed build contains no TURN credentials. If a direct connection works, TURN is not needed.
