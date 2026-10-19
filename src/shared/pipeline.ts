export const PIPELINE_PROTOCOL = "fileshare-upload-v1";
export const BLOCK_BYTES = 256 * 1024;
export const MAX_IN_FLIGHT = 16;
export const FRAME_HEADER = 56;
const MAGIC = 0x46535531;
export function packBlock(
  offset: number,
  bytes: ArrayBuffer,
  logicalBytes: number,
  checksum: string,
  compressed: boolean,
) {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    logicalBytes < 1 ||
    logicalBytes > BLOCK_BYTES ||
    bytes.byteLength < 1 ||
    bytes.byteLength > BLOCK_BYTES ||
    !/^[a-f0-9]{64}$/.test(checksum)
  )
    throw new Error("Invalid upload block");
  const frame = new Uint8Array(FRAME_HEADER + bytes.byteLength),
    header = new DataView(frame.buffer);
  header.setUint32(0, MAGIC);
  header.setUint8(4, compressed ? 1 : 0);
  header.setBigUint64(8, BigInt(offset));
  header.setUint32(16, logicalBytes);
  header.setUint32(20, bytes.byteLength);
  for (let i = 0; i < 32; i++)
    frame[24 + i] = parseInt(checksum.slice(i * 2, i * 2 + 2), 16);
  frame.set(new Uint8Array(bytes), FRAME_HEADER);
  return frame.buffer;
}
export function unpackBlock(frame: Uint8Array) {
  if (
    frame.byteLength < FRAME_HEADER ||
    frame.byteLength > FRAME_HEADER + BLOCK_BYTES
  )
    throw new Error("Invalid upload frame length");
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength),
    offset = Number(view.getBigUint64(8)),
    logicalBytes = view.getUint32(16),
    length = view.getUint32(20),
    flag = view.getUint8(4);
  if (
    view.getUint32(0) !== MAGIC ||
    flag > 1 ||
    frame[5] ||
    frame[6] ||
    frame[7] ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    logicalBytes < 1 ||
    logicalBytes > BLOCK_BYTES ||
    length < 1 ||
    length > BLOCK_BYTES ||
    frame.length !== FRAME_HEADER + length ||
    (!flag && length !== logicalBytes)
  )
    throw new Error("Invalid upload frame");
  return {
    offset,
    logicalBytes,
    compressed: flag === 1,
    checksum: Array.from(frame.subarray(24, 56), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join(""),
    bytes: frame.subarray(FRAME_HEADER),
  };
}
/** Delay-sensitive application window; transport congestion control still belongs to TCP/TLS. */
export class PipelineWindow {
  window = 2;
  baseRtt = Infinity;
  smoothedRtt = 0;
  rate = 0;
  private previousAck = 0;
  constructor(rttMs = 0) {
    if (rttMs > 0) this.baseRtt = rttMs;
  }
  observeRtt(ms: number) {
    if (ms > 0) this.baseRtt = Math.min(this.baseRtt, ms);
  }
  acknowledge(
    sentAt: number,
    now: number,
    wireBytes: number,
    processingMs = 0,
    inFlightAtSend = 1,
  ) {
    const rtt = Math.max(1, now - sentAt),
      processing = Math.max(0, Math.min(processingMs, rtt * 0.9));
    if (!Number.isFinite(this.baseRtt))
      this.baseRtt = Math.max(1, rtt - processing);
    if (!this.rate)
      this.rate =
        (wireBytes / Math.max(50, rtt - this.baseRtt - processing)) * 1000;
    if (this.previousAck && now - this.previousAck >= 10) {
      const sample = (wireBytes / (now - this.previousAck)) * 1000;
      this.rate = this.rate * 0.8 + Math.min(sample, this.rate * 2) * 0.2;
    }
    this.previousAck = now;
    const service = (wireBytes / Math.max(1, this.rate)) * 1000;
    // Serialization of our bounded in-flight blocks is not mistaken for unrelated congestion.
    const excess = Math.max(
      0,
      rtt - processing - this.baseRtt - service * Math.max(1, inFlightAtSend),
    );
    this.smoothedRtt = this.smoothedRtt
      ? this.smoothedRtt * 0.75 + excess * 0.25
      : excess;
    const desired = Math.max(
      2,
      Math.min(
        MAX_IN_FLIGHT,
        Math.ceil((this.rate * this.baseRtt) / 1000 / Math.max(1, wireBytes)) +
          1,
      ),
    );
    if (this.smoothedRtt > Math.max(50, this.baseRtt * 0.25))
      this.window = Math.max(1, Math.floor(this.window * 0.7));
    else this.window = Math.min(desired, this.window + 1);
    return { window: this.window, bytesPerSecond: this.rate };
  }
  backoff() {
    this.window = Math.max(1, Math.floor(this.window / 2));
  }
}
