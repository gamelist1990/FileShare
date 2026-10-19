export { compressibleName } from "../shared/compression";
/** Keep round-trip overhead near 8% where possible, with bounded memory and no parallel sockets. */
export function nextChunk(
  current: number,
  bytes: number,
  elapsedMs: number,
  failed = false,
  roundTripMs = 0,
) {
  if (failed) return Math.max(256 * 1024, Math.floor(current * 0.5));
  const latency = Math.max(0, Math.min(roundTripMs, elapsedMs * 0.8));
  const dataTime = Math.max(50, elapsedMs - latency);
  const target =
    (bytes / dataTime) * Math.max(2000, Math.min(16000, latency * 12));
  return Math.max(
    256 * 1024,
    Math.min(
      8 * 1024 * 1024,
      Math.floor(Math.min(current * 2, current * 0.3 + target * 0.7)),
    ),
  );
}
/** SHA-256 covers original bytes. Compression is optional, bounded to one upload chunk. */
export async function prepareChunk(blob: Blob, tryCompression: boolean) {
  const bytes = await blob.arrayBuffer();
  const digest = crypto.subtle.digest("SHA-256", bytes);
  let body: ArrayBuffer = bytes;
  let compressed = false;
  if (
    tryCompression &&
    bytes.byteLength >= 32768 &&
    typeof CompressionStream !== "undefined"
  ) {
    try {
      const encoded = new Uint8Array(
        await new Response(
          new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip")),
        ).arrayBuffer(),
      );
      if (encoded.byteLength + 64 < bytes.byteLength * 0.95) {
        body = encoded.buffer;
        compressed = true;
      }
    } catch {
      /* Older browsers retain the checksummed identity transfer. */
    }
  }
  const checksum = Array.from(new Uint8Array(await digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return { body, checksum, compressed, logicalBytes: bytes.byteLength };
}
