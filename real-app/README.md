# P2P Share — Sub-step 3

Sub-step 3 adds durable OPFS chunk storage, crash-safe resume metadata, saved-file download and verification, and clear-data controls to the S2 chunked P2P transfer.

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

Open `http://localhost:9000/sender.html`. Choose a non-empty file. The sender hashes one chunk at a time in a worker; it reveals the link only after the canonical manifest and `fileId` are ready. Open the link in a second tab. The receiver verifies and stores chunks in OPFS and resumes missing chunks on reload.

Generate the deterministic 5 MiB acceptance file and its streaming SHA-256 with:

```powershell
node scripts/make-test-file.js
```

Run the complete local browser acceptance check with:

```powershell
npm run acceptance:s1
```

It starts the local app and signaling servers on temporary ports, uses the installed Chrome channel, creates a 5 MiB test file, prints the acceptance result, and removes its `scratch/` file afterward. It serves a temporary local signaling override in memory and does not overwrite `config.local.json`.

S3 acceptance is run with `npm run acceptance:s3`. It uses local signaling and a generated 500 MiB source file; it exercises durable resume, completed-file reopen, download hash comparison, quota rejection, and (when the reported origin quota is large enough) an OPFS offset probe past 4 GiB.

## Identity, link, and file ID

The sender persists a 128-bit lowercase hexadecimal PeerJS ID in local storage and holds the exclusive Web Lock `p2p-send:<id>` before creating its Peer. Refreshing retains the same ID and link. A share URL contains exactly one `room` (the raw PeerJS sender ID) and one lowercase 64-character `fid`; duplicate, extra, or malformed parameters are rejected.

`fid` is SHA-256 of the canonical manifest. It binds the file's original UTF-8 name bytes and size as well as its chunk hashes; names are not Unicode-normalized. Display text is sanitized and written with `textContent`. S1 rejects empty files and enforces the design's 256 GiB, 65,536 chunk, and 4096 UTF-8-byte name limits.

## ICE and privacy

The application always supplies explicit WebRTC configuration: Google STUN only by default, `sdpSemantics: "unified-plan"`, and no TURN. User-entered ICE URLs and credentials are stored in per-tab `sessionStorage`; settings apply after reconnect. Credentials are not written into the URL, config example, logs, or diagnostics. Same-origin scripts can read session storage, so the pages load no third-party scripts. Peers expose their IP addresses to one another; a TURN server can see relayed traffic metadata and bytes.

PeerJS 1.5.5's default configuration includes public static-credential TURN servers. The explicit app configuration replaces those defaults, so those servers are not used unless the user supplies them.

## Measured earlier acceptance

S1 on 2026-10-05 used headless Chrome 154.0.8037.97 and local PeerServer. The sender hashed 5,242,880 bytes; the receiver verified the manifest, displayed the expected name/size, paired both channels, and exchanged BITFIELD. Measured control RTT was 4 ms; S1 did not transfer payload bytes.

S2 transferred 33,554,432 bytes in 23,786 ms after the first REQUEST, at 1.35 MiB/s, with 8/8 in-flight requests, using Chrome 154.0.8037.97 and a same-host local PeerServer. Receiver SHA-256 matched the Node streaming hash. Measured control RTT was 360 ms. A direct-PONG trial measured 325 ms RTT but 1.30 MiB/s, so it was reverted. The high localhost RTT remains a measurement quirk to revisit after S4; one hypothesis is PONG delay from bulk processing on the receiver main thread.

## Saved-file download trade-offs

The default Download action gets an OPFS `File`, creates an object URL, and clicks a temporary anchor. This is simple and avoids copying file bytes through JavaScript, but very large object-URL behavior varies by browser and may require additional disk space. Where `showSaveFilePicker` is available, Save As streams the OPFS file to a user-selected writable file and displays progress; the browser prompts for a destination and the copy still needs roughly another file size of free disk. Neither download path changes the retained OPFS copy. Use Clear saved data when that copy is no longer needed.

## Current limits

- Sender PING/PONG RTT is diagnostic only; D14 dead-peer recovery is not implemented.
- Custom signaling hosts must be added to both pages' CSP `connect-src` allow-list.
- Physical-LAN performance, multi-gigabyte transfers, relay behavior, Chrome Task Manager steady-state memory, and real-device transfers remain unmeasured.
