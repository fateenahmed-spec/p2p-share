# P2P Share — Sub-step 4

S4 adds sender-side per-receiver rows and grids, fair shared upload limiting, and support for up to 10 simultaneous receivers. The transfer uses two PeerJS connections per receiver: control messages on JSON strings and file frames on ArrayBuffers. The receiver verifies each chunk, writes it durably to OPFS, and resumes missing chunks after a reload.

## Requirements and support

- Node.js 24.21.0 (`.nvmrc`) and npm. PeerJS 1.5.5 and Playwright 1.63.0 are pinned and served locally from `vendor/`.
- Current Chromium-based desktop browser on HTTPS or localhost. Pages detect required APIs, including WebRTC, workers, Web Crypto, Web Locks, and receiver OPFS sync access handles.
- The 256 GiB application ceiling is a protocol/code limit, not a tested support claim. Chrome 154 on Windows completed 500 MiB transfers with up to three local receivers. OPFS behavior around 4 GB is unreliable in this Chrome build; see the measured limitation below.

| Feature | Status | Evidence |
|---|---|---|
| Chromium desktop, localhost | Measured | Chrome 154.0.8037.97, Windows; 500 MiB, one to three receivers |
| Three simultaneous receivers | Measured | All three 500 MiB downloads verified by external SHA-256 |
| Ten receiver admission limit | Unit tested | 11th receiver receives ROOM_FULL and is closed |
| Upload cap | Implemented; browser-tested below configured ceiling | 10 MiB/s setting; three-receiver aggregate observed 1.90 MiB/s |
| Resume and completed reopen | Measured | S3 500 MiB resume and all-verified reopen passed |
| Chrome OPFS writes around 4 GB | Known browser/backend failure | Partial-write return count was 4,294,967,288 for an 8-byte write at tested large offsets |
| Other browsers, mobile, physical LAN, TURN relay | Not measured | No compatibility or performance claim |

## Run locally

From this directory:

```powershell
npm ci
npm test
npm run dev
```

Copy `config.example.json` to ignored `config.local.json` and set signaling to `{"host":"localhost","port":9001,"path":"/","key":"peerjs","secure":false}`. Keep Google STUN. In another terminal run `npm run signal`, then open `http://localhost:9000/sender.html`.

Choose a file. The sender hashes chunks in a worker and only reveals the share link once the file ID is known. Open the link in receiver profiles. The sender row shows the full raw PeerJS ID, a BITFIELD/HAVE chunk grid, percent complete, recent speed, the control and bulk connection paths, and errors. Disconnected rows stay visible in grey. The global upload cap is configured in KiB/s; zero means unlimited.

Acceptance commands:

```powershell
npm run acceptance:s1
npm run acceptance:s2
npm run acceptance:s3
npm run acceptance:s4
node scripts/s3-offset-probe.mjs
```

S4 acceptance opens three visible Chrome windows in independent persistent profiles, hashes all three completed downloads, then performs a second 500 MiB run that closes one receiver around 50% while the others finish. The offset probe measures OPFS truncate/write behavior without transferring a large file. Browser automation requires permission to start local processes and Chrome.

## Identity, file ID, and privacy

The sender persists a 128-bit lowercase hexadecimal PeerJS ID in local storage and holds `p2p-send:<id>` using Web Locks. Share links contain exactly one `room` value (the raw PeerJS ID) and one lowercase 64-character `fid`.

`fid` is SHA-256 of the canonical manifest. It covers the original UTF-8 file name bytes, size, and chunk hashes; names are not Unicode-normalized. A renamed copy has a different `fileId`, even if its bytes are unchanged. Displayed names and peer IDs use text nodes, not HTML parsing.

Google STUN is the default; no TURN server is added unless a user supplies one. ICE settings stay in per-tab session storage. Peers can learn one another's network addresses through ICE. A user-supplied TURN server can observe relayed traffic metadata and bytes. The signaling service coordinates peers; it does not carry WebRTC data-channel payloads.

## Threat model and limitations

- A malicious sender can waste bandwidth or provide invalid data. Manifest and chunk hashes detect mismatch; bounded frames, queues, receiver limits, and retry caps limit resource use. The file ID does not authenticate a sender.
- Same-origin scripts can access OPFS files and session settings. The app uses a restrictive CSP and loads no third-party scripts. A local attacker with profile access can read or delete saved files; the app does not encrypt OPFS data.
- Disk-full preflight uses `navigator.storage.estimate()` and fails closed when available quota is below the computed requirement. If estimate fails, it warns and proceeds. Clear saved data reacquires the file Web Lock if the preflight released it.
- Custom signaling hosts must be added to both pages' CSP `connect-src` allow-list. PeerJS has no ICE restart; network changes require reconnect/resume.
- Very large object URL behavior, physical LAN performance, relay behavior, mobile browsers, and real-device transfers are not measured.

## Measured results

All transfer results below are single-run observations, not medians. Chrome 154.0.8037.97 and a same-host local PeerServer were used unless noted.

| Stage | File | Time / throughput | Verification and resume | Memory / other |
|---|---:|---|---|---|
| S2 | 32 MiB | 23,786 ms; 1.35 MiB/s; 8/8 request slots | Source and receiver SHA-256 matched | RTT 360 ms |
| S3 | 32 MiB | 11,310 ms; 2.83 MiB/s | SHA-256 `2192f924af776c33c016258112acca3eebecee139c534cefa8229a3e455cb972`; reconnect requested exactly 255 missing chunks; verify 1,053 ms | Chrome working set 652.4 MiB |
| S3 | 500 MiB | 191,640 ms; 2.61 MiB/s | SHA-256 `8ef7b878120c20d4feb6b8d974e408335c15e1ff6abb0f72e6e5e01bb71da24a`; revalidated 1,000 durable chunks and requested exactly 1,000 missing; completed reopen had 2,000/2,000, 100%, zero REQUESTs; verify 1,339 ms | Chrome working set 1,050.9 MiB |
| S3 OPFS offset probe | Truncate 5,000,000,000; 8-byte write at large offset | Failed on HeadlessChrome 154.0.0.0 | `getSize()` after truncate was 0; write returned 4,294,967,288 (`2^32 - 8`) with 8 bytes remaining at offset 4,500,000,000; same return at 4,000,000,000 target. Quota estimate: 10 GiB, usage 0. | JS offsets remained safe integers. This does not establish a 4 GiB-only boundary; observed OPFS backend behavior is inconsistent with the write request. |
| S4 one receiver, unlimited | 500 MiB | 4.54 MiB/s | 2,000 requests; downloaded SHA-256 matched | Single run |
| S4 one receiver, 10 MiB/s cap | 500 MiB | 4.58 MiB/s | 2,000 requests; downloaded SHA-256 matched | Below cap; sender throughput did not saturate it |
| S4 two receivers, unlimited | 500 MiB each | 3.60 MiB/s aggregate | Both downloaded SHA-256 values matched | Single run |
| S4 three receivers, 10 MiB/s cap | 500 MiB each | 1.90 MiB/s aggregate | All three hashes matched; expected and downloaded SHA-256 for each: `8ef7b878120c20d4feb6b8d974e408335c15e1ff6abb0f72e6e5e01bb71da24a` | Peak counted sender bytes 5,760,812; peak Chrome process working set 2,590.2 MiB |
| S4 close one receiver | 500 MiB each; one closed at 250 MiB | 1.93 MiB/s aggregate during close run | Remaining two completed with matching SHA-256; disconnected row returned to 0 active sends / 0 reserved bytes | Same 10 MiB/s configured cap |

The disk-full browser simulation remains blocked: Chrome CDP `Storage.overrideQuotaForOrigin` returned `Protocol error (Storage.overrideQuotaForOrigin): Internal error`. The production preflight is unit-tested with injected estimates for 64 MiB and 2 GiB available against a 500 MiB file, plus estimate rejection.

The S4 transfer bug was caused by `tokenBlocked` being declared inside `pumpFrames()`'s `do` block but read from the `do…while` condition outside it. That raised `ReferenceError` after the first queued frame and was misclassified as a chunk read failure. The flag now has function scope; the 500 MiB one-, two-, and three-receiver browser runs passed after the fix.

## Saved-file download

Download creates an object URL from the OPFS `File`; large object-URL behavior may vary and the downloaded copy needs additional disk. Where available, Save As streams the file to a user-selected destination. Neither action deletes the retained OPFS copy; use Clear saved data when it is no longer needed.
