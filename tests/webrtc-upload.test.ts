import { test, expect } from "bun:test";
import { RTCUploadSocket } from "../src/React/webrtc-upload";

class FakeChannel {
  readyState: RTCDataChannelState = "connecting";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  frames: (string | Uint8Array)[] = [];
  private listeners: Array<() => void> = [];
  addEventListener(kind: string, cb: () => void) { if (kind === "bufferedamountlow") this.listeners.push(cb); }
  removeEventListener(kind: string, cb: () => void) { this.listeners = this.listeners.filter(x => x !== cb); }
  send(frame: string | ArrayBuffer | ArrayBufferView) {
    this.frames.push(typeof frame === "string" ? frame : new Uint8Array(frame instanceof ArrayBuffer ? frame : frame.buffer));
  }
  open() {this.readyState = "open"; this.onopen?.();}
  close() {this.readyState = "closed"; this.onclose?.();}
}
test("RTC upload fragments large original WebSocket frames into ordered 16KB messages", async () => {
  const dc = new FakeChannel();
  const pc = {close(){}} as unknown as RTCPeerConnection;
  const transport = new RTCUploadSocket(dc as unknown as RTCDataChannel, pc);
  dc.open();
  const source = new Uint8Array(1024*1024+56);
  for(let i=0;i<source.length;i++)source[i]=i%251;
  transport.send(source.buffer);
  for(let t=0;t<200;t++){
    if(transport.bufferedAmount===0)break;
    await Bun.sleep(1);
  }
  expect(transport.bufferedAmount).toBe(0);
  expect(dc.frames.length).toBeGreaterThan(60);
  const restored = new Uint8Array(source.length);
  let expectedOffset=0;
  let frameId=0;
  for(const msg of dc.frames){
    if(typeof msg==="string")throw new Error("Unexpected control");
    expect(msg.length).toBeLessThanOrEqual(16012);
    const view=new DataView(msg.buffer,msg.byteOffset,msg.byteLength);
    if(!frameId)frameId=view.getUint32(0);
    expect(view.getUint32(0)).toBe(frameId);
    expect(view.getUint32(4)).toBe(source.length);
    expect(view.getUint32(8)).toBe(expectedOffset);
    restored.set(msg.subarray(12),expectedOffset);
    expectedOffset+=msg.length-12;
  }
  expect(expectedOffset).toBe(source.length);
  expect(restored).toEqual(source);
  transport.close();
});
