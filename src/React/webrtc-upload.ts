import { uploadPipeline, PipelineError } from "./upload-pipeline";
import { PIPELINE_PROTOCOL, MAX_BLOCK_BYTES, FRAME_HEADER } from "../shared/pipeline";

const FRAGMENT_PAYLOAD = 16_000;
const MAX_BUFFERED = 512 * 1024;
const MAX_FRAME = MAX_BLOCK_BYTES + FRAME_HEADER;

/**
 * DataChannel is reliable and ordered, but large single messages are not
 * portable. Each old FileShare WebSocket frame is split into bounded SCTP
 * messages. The Go/Pion bridge reconstructs it before forwarding to A8.
 */
export class RTCUploadSocket {
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState: number = WebSocket.CONNECTING;
  private pending: Array<{ text?: string; binary?: Uint8Array }> = [];
  private pendingBytes = 0;
  private running = false;
  private nextId = 0;
  constructor(private dc: RTCDataChannel, private pc: RTCPeerConnection) {
    dc.onopen = () => {
      this.readyState = WebSocket.OPEN;
      void this.pump();
    };
    dc.onmessage = (event) => {
      if (typeof event.data !== "string") {
        this.onerror?.();
        return;
      }
      this.onmessage?.({ data: event.data });
    };
    dc.onerror = () => this.onerror?.();
    dc.onclose = () => {
      this.readyState = WebSocket.CLOSED;
      this.onclose?.();
    };
    pc.onconnectionstatechange = () => {
      if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
        this.onerror?.();
        this.close();
      }
    };
  }
  get bufferedAmount() {
    return this.pendingBytes + this.dc.bufferedAmount;
  }
  send(data: string | ArrayBuffer | ArrayBufferView) {
    if (this.readyState !== WebSocket.OPEN) throw new Error("WebRTC channel closed");
    if (typeof data === "string") {
      if (data.length > 256) throw new Error("RTC control message too large");
      this.pending.push({ text: data });
      this.pendingBytes += data.length;
    } else {
      const bytes = data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (!bytes.byteLength || bytes.byteLength > MAX_FRAME)
        throw new Error("RTC upload frame exceeds limit");
      this.pending.push({ binary: bytes });
      this.pendingBytes += bytes.byteLength;
    }
    void this.pump();
  }
  private async drain() {
    if (this.dc.bufferedAmount < MAX_BUFFERED) return;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.dc.removeEventListener("bufferedamountlow", finish);
        resolve();
      };
      this.dc.bufferedAmountLowThreshold = MAX_BUFFERED / 2;
      this.dc.addEventListener("bufferedamountlow", finish, { once: true });
      const timer = setTimeout(finish, 200);
    });
  }
  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length && this.dc.readyState === "open") {
        const item = this.pending.shift()!;
        if (item.text !== undefined) {
          await this.drain();
          if (this.dc.readyState !== "open") break;
          this.dc.send(item.text);
          this.pendingBytes -= item.text.length;
          continue;
        }
        const frame = item.binary!;
        const id = ++this.nextId;
        for (let offset = 0; offset < frame.length; offset += FRAGMENT_PAYLOAD) {
          await this.drain();
          if (this.dc.readyState !== "open") return;
          const amount = Math.min(FRAGMENT_PAYLOAD, frame.length - offset);
          const fragment = new Uint8Array(12 + amount);
          const header = new DataView(fragment.buffer);
          header.setUint32(0, id);
          header.setUint32(4, frame.length);
          header.setUint32(8, offset);
          fragment.set(frame.subarray(offset, offset + amount), 12);
          this.dc.send(fragment);
          this.pendingBytes -= amount;
        }
        // Yield between large frames to keep the upload controls responsive.
        await Promise.resolve();
      }
    } catch {
      this.onerror?.();
      this.close();
    } finally {
      this.running = false;
    }
  }
  close() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSING;
    this.pending.length = 0;
    this.pendingBytes = 0;
    try { this.dc.close(); } catch {}
    try { this.pc.close(); } catch {}
    this.readyState = WebSocket.CLOSED;
  }
}

function waitIceGathering(pc: RTCPeerConnection, timeoutMs = 7000) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === "complete") finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    pc.addEventListener("icegatheringstatechange", onChange);
  });
}

export async function uploadWebRTC(options: {
  id: string;
  file: Blob;
  offset: number;
  roundTripMs: number;
  compress: boolean;
  stopped: () => boolean;
  signal?: AbortSignal;
  progress: (offset: number, speed: number) => void;
}) {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    bundlePolicy: "max-bundle",
  });
  const dc = pc.createDataChannel("fileshare", { ordered: true });
  const transport = new RTCUploadSocket(dc, pc);
  let succeeded = false;
  try {
    const result = await uploadPipeline({
      url: new URL("/api/uploads/" + options.id + "/stream", location.origin)
        .href.replace(/^http/, "ws"),
      channel: transport as unknown as WebSocket,
      connectTimeoutMs: 26000,
      idleTimeoutMs: 30000,
      file: options.file,
      offset: options.offset,
      roundTripMs: options.roundTripMs,
      compress: options.compress,
      stopped: options.stopped,
      signal: options.signal,
      progress: options.progress,
      startTransport: async () => {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await waitIceGathering(pc);
        if (options.stopped() || options.signal?.aborted)
          throw new PipelineError("転送を中断しました");
        const response = await fetch(
          "/api/uploads/" + options.id + "/webrtc/offer",
          {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ offer: pc.localDescription }),
            signal: AbortSignal.timeout(16000),
          },
        );
        if (!response.ok) throw new PipelineError("P2P接続を確立できません");
        const data = await response.json();
        if (data.answer?.type !== "answer" || typeof data.answer.sdp !== "string")
          throw new PipelineError("P2P接続情報が不正です");
        await pc.setRemoteDescription(data.answer);
      },
    });
    succeeded = true;
    return result;
  } finally {
    // A completed SCTP channel is no longer needed. For failed connections,
    // closing also releases NAT mappings; the normal upload path resumes.
    transport.close();
    if (!succeeded) pc.close();
  }
}
