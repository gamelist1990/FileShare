# Single-socket upload pipeline (FileShare 2.5)

## Behavior

Files at least 2MiB use a single authenticated WebSocket per upload when the backend advertises `fileshare-upload-v1`. Smaller files retain the HTTP path. The sender prepares and sends blocks while earlier blocks await durable receipts. Gzip remains optional per block. On transient failure, the browser reconciles the authoritative server offset and reconnects up to three times, then uses the existing resumable HTTP transport. Authentication, integrity, size and permission failures stop the transfer. Downloads retain native streaming/Range support; their existing stream does not wait for an application acknowledgment for every block.

Accepted blocks are 256KiB except the final remainder. At most 16 blocks / 4MiB of original payload may be outstanding. The application window starts with two 256KiB wire credits. Compressed blocks consume actual wire credits but remain subject to the 16-block original-data cap. Browser `bufferedAmount` adds a send-queue bound. TCP/TLS still implements packet loss recovery and transport congestion control; the application window is an additional bounded controller, not a replacement.

The controller observes baseline round-trip delay, acknowledgment spacing and server processing time. It accounts for block serialization, then reduces the window when unexplained delay rises; stable delivery grows it toward the observed bandwidth-delay product. It cannot measure the exact spare bandwidth of unrelated applications. Existing global bandwidth and shared HTTP/WebSocket per-IP/concurrent-transfer limits remain. Upgrade admission is additionally bounded to at most 120 per IP per minute, scaled down with the configured request limit. Control frames are rate limited. Data-idle and peer liveness checks close stalled sessions.

## Durable receipt and resumption

A single writer lease is shared by HTTP writes, WebSocket sessions, cancellation, completion and cleanup. Each block is validated, bounded-decompressed, hashed with SHA-256 and written to its offset. After file fsync, a SQLite transaction inserts `(upload_id,start,length,hash)` into `upload_blocks` and advances the contiguous committed offset. ACKs are sent only after this transaction. Out-of-order offsets, invalid hashes and false lengths never advance the offset.

On reconnect, the server reports its committed offset and last block receipt. The browser verifies that receipt against the selected local file before sending any remaining data. ACKs lost during a disconnection therefore do not cause already committed blocks to be uploaded again. Uncommitted file tails are truncated on the next write. Existing pre-2.5 uploads with no receipt row retain offset-based compatibility. Receipt rows are removed by foreign-key cascade on completion, cancellation or expiry.

The final block automatically produces `done` after its durable ACK and lease release, removing another round trip. A separate same-origin authenticated stop request, scoped to the upload owner and exact connection identifier, can terminate queued socket data during pause/error handling. A different tab's connection cannot be stopped using an obsolete identifier.

## Wire format and security

The socket URL is `/api/uploads/<UUID>/stream` and the negotiated subprotocol is `fileshare-upload-v1`. Every upgrade requires the expected Host, exact configured Origin, approved session, upload ownership and quota/permission checks. Original client identity comes from the same trusted PROXY v2 socket as HTTP; forwarding headers are not used. Session and permissions are rechecked for each committed block, including after disk I/O. CSP permits the exact service WebSocket origin. TLS protects production transport; no custom cryptography is introduced.

Binary frames have a 56-byte header: big-endian magic `FSU1` (bytes 0–3), gzip flag (4), reserved zeros (5–7), safe integer offset (8–15), original length (16–19), encoded length (20–23), SHA-256 of original bytes (24–55), followed by encoded payload. Encoded and original block lengths are bounded to 256KiB. Per-message WebSocket compression is disabled; gzip is explicitly validated inside each data block. JSON controls and responses are `ready`, `ping`/`pong`, `ack`, `done`, `error` and the zero-remaining-data `finish` compatibility control.

The runtime uses the pinned npm alias `ws-node` for ws 8.22.0. Bun's built-in `ws` shim requires a native Bun HTTP listener and is unsuitable for this application's trusted-PROXY raw TCP listener. The alias bundles the standard socket implementation into the executable. CI tests the actual compiled binary, not only the source server.

## Measurements

`scripts/benchmark-pipeline.ts` runs both transports through the same bounded raw TCP relay. It independently models serialization and one-way propagation, including HTTP headers, WebSocket handshake and frames. Run `bun run benchmark:pipeline`; `--pipeline-only` reruns the candidate path, and `--congestion-only` tests a changing link. Test credentials/data are temporary and never contact production. Each result is a single engineering sample on Bun 1.4.3, with no artificial packet loss; it is not an end-user WAN speed guarantee. Upload times include initialization and completion. All saved bytes are compared with the original. Text repeats one source-like line and compresses particularly well.

| Link | 4MiB data | Existing HTTP | Pipeline | Time reduction |
| --- | --- | --- | --- | --- |
| 1Mbps, 600ms RTT | Random binary | 37.950s | 36.702s | 3.3% |
| 1Mbps, 600ms RTT | Repeated text | 3.358s | 2.708s | 19.4% |
| 5Mbps, 300ms RTT | Random binary | 8.294s | 7.945s | 4.2% |
| 5Mbps, 300ms RTT | Repeated text | 1.661s | 1.283s | 22.8% |

The 8MiB changing-link case (5→1→5Mbps, 300ms RTT) completed in 30.507s with matching bytes, a maximum of two outstanding binary blocks, one window backoff, and a minimum window of one. Compressed fixed-link cases reached 16 outstanding logical blocks while respecting the wire budget. Raw samples: [comparison](benchmarks/2026-10-19-pipeline.json), [congestion](benchmarks/2026-10-19-pipeline-congestion.json).

Tests cover pipelining before ACK, durable receipt hashes/cascade, lost ACKs and reconnection, malformed frames/lengths/bombs/hashes, origin and ownership checks, in-session revocation, simultaneous-writer exclusion, queued-data bounds, pause ownership/connection identifiers, shared HTTP/WS limits and trusted PROXY v2 identity across upgrade. Browser CI injects a real connection close after the first ACK, requires a second socket, and checks final downloaded bytes. Native-binary CI checks authenticated pipeline writes and saved-file integrity.
