# A1 reception, background replication, and download cache

A8 owns authentication, permissions, storage allocations and file metadata. A1 owns a bounded durable receive spool and an expendable download cache. FerrumProxy routes `/edge-upload` to the existing loopback receiver on A1 (`127.0.0.1:8124`), and `/` to A8. Existing HTTP/3, HTTPS/TCP, PROXY v2 and wget clients are retained.

## Upload lifecycle

1. A8 reserves capacity and issues a signed upload ticket, scoped to the upload, size, account, login session, client IP and expiry.
2. The browser sends multiple checksummed blocks to A1. A1 validates hashes, uses positional writes and fsync, and records durable receipts in SQLite. Receiving and A8 replication run concurrently. Disconnects can resume from the confirmed prefix.
3. After **all** blocks have durable receipts on A1 or A8, `/finish` asks A8 to publish the file metadata. A8 rechecks the session, current role and permissions. Users can now use the file; the browser does not wait for the bulk A8 transfer. Published bytes count once toward quota, even while the replication reservation exists.
4. The worker continues in the background, including after the browser closes. A8 checks every replicated block and atomically installs the completed blob, including across mapped drives. Metadata changes made during replication are retained. A8 fsyncs the file and its initial directory entry and commits its FULL-synchronous SQLite receipt before acknowledging a block. A1 persists a remote-read boundary before punching holes in acknowledged ranges (`FALLOC_FL_PUNCH_HOLE | KEEP_SIZE` on Linux). Physical block savings, rather than the logical sparse-file length, reduce spool reservations. Completion removes the remaining upload spool; it does not retain the upload as a full download cache.
5. The UI marks files still being replicated. A1 failure before A8 completes affects the unreplicated suffix. After reclamation, the durable file is split between A8's acknowledged prefix and A1's remaining suffix. This is not a second full replica; recover both hosts and their receipts consistently.

Small files also use A1. Multiple selected/dropped files use the same bounded queue. If A1 refuses a new reservation for capacity reasons, the existing direct A8 path remains available. Unavailable or unknown A1 receipt state is never silently replaced with a second upload.

## Downloads and previews

After validating the normal FileShare session/ticket, A8 redirects content requests to a signed A1 URL. **A1 calls A8 to recheck live authorization on every request**, including session revocation, private ancestors, minimum levels, invitation grants, expiry and lockdown. Cached bytes are never public just because they exist on A1. If A8 cannot authorize, delivery fails closed.

While replication is pending, content is assembled in order: released prefix chunks come from A8's durable temporary file via a signed, bounded internal endpoint; the remaining suffix comes from A1. The same lock protects local reads and hole punching, and a completed rename falls back to the final blob. Afterwards, A1 serves its cache or streams the missing content from A8; full reads can populate the bounded LRU cache while delivering data to the user. Cold partial reads stream the requested range without caching an incomplete file as complete. HEAD, byte Range, inline/attachment disposition, MIME allowlisting, sandboxing and download receipt deduplication are maintained. Text/Markdown previews read at most 512KiB and return escaped JSON text. Original video playback works immediately; CPU transcoding becomes available after A8 replication.

## Limits and recovery

The default spool/cache budget is 24GB with an 8GB minimum free-space reserve on A1. Pending durable uploads are not evicted to make room for download caches. Four download streams and eight upload requests are admitted concurrently; buffering uses bounded blocks. A1 cannot turn its 48GB system disk into an unlimited queue. A1 never reclaims unacknowledged bytes. On filesystems without hole punching it safely retains bytes until completion; reclaimed-byte accounting remains zero for those ranges. A8 receipt rollback behind an already released boundary stops replication with an error instead of reading holes as zeros. Orphan temporary cache files are aged out.

Interrupted blocks are acknowledged only after fsync. Workers reconcile A8 receipts before advancing, verify hashes and retry after failures. Published pending reservations are protected from the ordinary incomplete-upload timeout. Expired or purged files lose access immediately and their pending reservations can be removed. Incomplete unpublished transfers remain cancelable; already published files are removed through the regular file list/trash.

## Deployment

Use the supplied service and environment examples under `deploy/`. Both machines read the same random 32-byte hexadecimal secret from a protected file named by `FILESHARE_EDGE_SECRET_FILE`; it is never committed or embedded in the browser. The receiver binds to loopback, parses PROXY v2 only from its local proxy, and checks the signed ticket against the forwarded client IP. A8 only accepts signed internal requests from A1's configured Tailscale address. Internal signatures cover method, path, timestamp and SHA-256 of the body. Logs omit authorization headers, content tokens and query strings.

Configure `edgeSpool.enabled`, its trusted A1 IP and `/edge-upload` path on A8. Preserve the existing FerrumProxy hostname/path mappings and TLS settings. Updating this release does not require changing the existing route allocation. Deploy A8 before the A1 receiver so new publication and authorization endpoints exist first. The old browser can continue its existing replication-wait flow during deployment; refresh to load the new immediate-publication flow.

The integration test runs the real Python receiver against the real A8 application with PROXY v2/HMAC, pauses replication, confirms one block and checks actual physical disk reclamation, publishes and reads across the released/local boundary, restarts A1, resumes replication, then checks streamed/cached Range/HEAD, download counting and logout/IP revocation.

Downloads are forwarded as 256KiB chunks as they arrive from A8, rather than waiting for the whole file. Socket backpressure bounds memory and slows the origin read when the client is slow. Ordinary HTTPS and wget Range resumption continue to work. This cannot exceed the slowest network segment; it reduces buffering delay and A1 disk usage.

## HTTP/1 origin switching

The deployed FerrumProxy HTTP/1 router chooses its origin once per TCP connection. An HTTP/1 client reusing the original A8 connection for an A1 redirect would otherwise receive 404. With edge spooling enabled, FileShare and the A1 receiver send `Connection: close` after each HTTP/1 response so the next request selects the correct mapping. File bodies still stream on one connection for their full duration. FerrumProxy strips hop-by-hop headers on its HTTP/3 bridge, so QUIC connections and independent streams remain reusable; WebSocket uploads are unchanged. This compatibility choice adds HTTP/1 connection setup between requests until the router gains routing per request. Verify unmodified wget and curl redirect following, without requiring custom connection headers.
