/** Single-stream adaptive chunking: target ~2s per chunk, bounded memory, resumable offsets. */
export function nextChunk(
  current: number,
  bytes: number,
  elapsedMs: number,
  failed = false,
) {
  if (failed) return Math.max(256 * 1024, Math.floor(current * 0.5));
  const target = (bytes / Math.max(1, elapsedMs)) * 2000;
  return Math.max(
    256 * 1024,
    Math.min(
      8 * 1024 * 1024,
      Math.floor(Math.min(current * 1.25, current * 0.7 + target * 0.3)),
    ),
  );
}
