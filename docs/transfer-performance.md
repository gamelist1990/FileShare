# Transfer performance, FileShare 2.4

## Changes

- Upload chunks account for the latency observed during initialization/resume. Growth is bounded to 2x per successful sample and 8MiB maximum; errors halve the chunk size. Uploads retain a single connection/request at a time and the existing bandwidth/concurrency limits.
- Text-like files can use gzip per upload chunk, negotiated with the backend. SHA-256, quotas, offsets and stored bytes always refer to the original data. Both encoded and decoded chunks are limited to 8MiB. Browsers without compression support use identity transfers. Compressed/unsuitable file types retain identity transfer.
- Full text downloads from 32KiB through 8MiB can use gzip when accepted by the client. Compressed full responses advertise `Accept-Ranges: none`. Explicit Range requests use identity bytes; larger files retain native Range downloads to support browser resumption and bound CPU work. Images, videos and archives remain unchanged.
- Download reads use 256KiB bounded buffers and honor receiver backpressure. Existing global bandwidth and per-IP concurrency limits remain in force; this does not detect the spare capacity of other applications on a user's connection.
- Embedded public JS/CSS/HTML/SVG assets are gzip-encoded once at startup, with `Vary: Accept-Encoding`. The local JS bundle is 271,138 bytes uncompressed / 85,085 bytes gzip, and CSS is 31,500 / 6,610 bytes.

## Reproducible measurements

`scripts/benchmark-transfer.ts` starts an isolated application with temporary data and a synthetic test session, plus a real HTTP relay that paces request/response bodies and injects round-trip delay. It does not use production accounts or storage. Run `bun run benchmark:transfer after`; results are written under `.artifacts/transfer-after.json` and test data is removed at exit. For a comparison, copy the same script into an isolated checkout of baseline commit `2babe69`, then run it with label `before`.

The baseline was measured before edits, then the optimized implementation was measured on the same machine with Bun 1.4.3. Upload time includes initialization, preparation, all payload requests and completion. Download time excludes ticket issuance. Wire counters measure HTTP body bytes, excluding headers, framing, TLS and IP overhead. Upload counters include small control-request bodies. All returned download bytes were checked for exact equality. Each case was measured once; these are reproducible engineering samples, not statistical confidence intervals or public WAN/mobile-device measurements. No loss/jitter was injected. The text sample deliberately repeats a source-code-like line and compresses unusually well; the binary sample uses random bytes.

| Bandwidth / RTT | Data | Upload before → after | Download before → after |
| --- | --- | --- | --- |
| 256kbps / 200ms | 512KiB random binary | 17.087s → 17.089s | 16.604s → 16.603s |
| 256kbps / 200ms | 512KiB repeated text | 17.030s → 0.762s | 16.597s → 0.412s |
| 1Mbps / 600ms | 4MiB random binary | 39.711s → 37.900s | 34.177s → 34.171s |
| 1Mbps / 600ms | 4MiB repeated text | 39.715s → 3.344s | 34.168s → 1.019s |

Raw results: [baseline](benchmarks/2026-10-19-before.json), [optimized](benchmarks/2026-10-19-after.json).

Compression is responsible for the large text gains. For incompressible data at 1Mbps/600ms, latency-aware chunking saves about 4.6% of upload time; download throughput is already near the simulated link limit. Nothing here increases the physical connection bandwidth or guarantees the same gains for MP4/ZIP/JPEG, different file contents, actual mobile CPUs, or the production proxy/VPN path.

## Verification

Tests cover gzip negotiation including q=0, client compression/incompressible fallback, malformed/bomb uploads, original checksums, rejection before offset changes, resumed compressed uploads, ACLs, gzip/identity downloads, byte ranges and large-download resumption headers. Browser CI checks a compressed WebAuthn-authenticated upload and verifies the bytes saved by Chromium after a gzip download. Existing permission, quota, download-count, staff-invitation and CPU-preview checks also run.
