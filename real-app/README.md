# P2P Share — Sub-step 1

Sub-step 1 implements sender identity and signaling, browser feature checks, strict share-link/control-message validation, worker-based file hashing, manifest exchange, paired control and bulk channels, and control-channel PING/PONG diagnostics. Bulk file transfer and receiver persistence are later sub-steps.

## Requirements and support

- Node.js 24.21.0 (`.nvmrc`) and npm.
- PeerJS 1.5.5 and Playwright 1.63.0 are pinned. PeerJS and its browser dependencies are served from `vendor/`; no CDN scripts are used.
- A current Chromium based browser on HTTPS or localhost. The page checks secure context, Web Crypto/RNG, workers, text codecs, WebRTC data channels and backpressure events, `File.slice`, and Web Locks. The receiver also checks OPFS sync access handles in a worker, then runs a lock-held read/write probe before accepting a manifest.
- Missing required features are listed on the page and block the relevant action. Missing Wake Lock, quota estimate/persist, or session storage is reported as an optional limitation.

## Run locally

From this directory:

```powershell
npm ci
npm test
npm run dev
```

To use local signaling, copy `config.example.json` to ignored `config.local.json` and set its signaling fields to `{"host":"localhost","port":9001,"path":"/","key":"peerjs","secure":false}`. Keep the Google STUN entry. In another terminal run:

```powershell
npm run signal
```

Open `http://localhost:9000/sender.html`. Choose a non-empty file. The sender hashes one chunk at a time in a worker; it reveals the link only after the canonical manifest and `fileId` are ready. Open the link in a second tab. S1 reports the verified file name/size, exchanged manifest, paired control and bulk channels, receiver BITFIELD, and control RTT. No file bytes are transferred in S1.

Generate the deterministic 5 MiB acceptance file and its streaming SHA-256 with:

```powershell
node scripts/make-test-file.js
```

Run the complete local browser acceptance check with:

```powershell
npm run acceptance:s1
```

It starts the local app and signaling servers on temporary ports, uses the installed Chrome channel, creates a 5 MiB test file, prints the acceptance result, and removes its `scratch/` file afterward. It serves a temporary local signaling override in memory and does not overwrite `config.local.json`.

## Identity, link, and file ID

The sender persists a 128-bit lowercase hexadecimal PeerJS ID in local storage and holds the exclusive Web Lock `p2p-send:<id>` before creating its Peer. Refreshing retains the same ID and link. A share URL contains exactly one `room` (the raw PeerJS sender ID) and one lowercase 64-character `fid`; duplicate, extra, or malformed parameters are rejected.

`fid` is SHA-256 of the canonical manifest. It binds the file's original UTF-8 name bytes and size as well as its chunk hashes; names are not Unicode-normalized. Display text is sanitized and written with `textContent`. S1 rejects empty files and enforces the design's 256 GiB, 65,536 chunk, and 4096 UTF-8-byte name limits.

## ICE and privacy

The application always supplies explicit WebRTC configuration: Google STUN only by default, `sdpSemantics: "unified-plan"`, and no TURN. User-entered ICE URLs and credentials are stored in per-tab `sessionStorage`; settings apply after reconnect. Credentials are not written into the URL, config example, logs, or diagnostics. Same-origin scripts can read session storage, so the pages load no third-party scripts. Peers expose their IP addresses to one another; a TURN server can see relayed traffic metadata and bytes.

PeerJS 1.5.5's default configuration includes public static-credential TURN servers. The explicit app configuration replaces those defaults, so those servers are not used unless the user supplies them.

## Measured S1 acceptance

One run on 2026-10-05 used headless Chrome 154.0.8037.97 and the local PeerServer. The sender hashed a 5,242,880-byte file; its streaming SHA-256 was `315cf4e39ff22057829a9d8ad75c469968ea6fbb0a51bfd8be38fc4493ebd28c`. The receiver verified `fileId` `69eb881304f76593ed41f9fa6733efc9b7843afdc73499e2d9c80dc8f401b46a`, reconstructed the 2,602-byte manifest from 1 part, displayed `test-5mb.bin` / `5242880 bytes`, paired both channels, and exchanged a 10-byte BITFIELD. Measured control RTT was 4 ms. This run did not transfer the 5 MiB file payload or measure transfer throughput.

## Known S1 limits

- File bytes, chunk framing, retry/resume, quota checks, and durable OPFS transfer storage are not implemented yet.
- Sender PING/PONG RTT is diagnostic only; S1 does not yet implement D14 dead-peer recovery.
- Custom signaling hosts must be added to both pages' CSP `connect-src` allow-list.
- Browser resource usage, multi-gigabyte files, relay behavior, and real-device transfers have not been measured.
