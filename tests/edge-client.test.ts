import { test, expect } from "bun:test";
import {
  uploadEdge,
  sendEdgeBlock,
  createProgressReporter,
} from "../src/React/edge-upload";

class TestXHR {
  static send: (request: TestXHR) => void;
  headers: Record<string, string> = {};
  upload: any = {};
  status = 200;
  responseText = "{}";
  onload?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  aborted = false;
  open() {}
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send() {
    TestXHR.send(this);
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  reply(data: unknown, status = 200) {
    if (this.aborted) return;
    this.status = status;
    this.responseText = JSON.stringify(data);
    this.onload?.();
  }
}

test("idle deadline recovers a stalled block, preserves user abort and allows continuously advancing slow requests", async () => {
  const original = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = TestXHR as any;
  const requests: TestXHR[] = [];
  TestXHR.send = (r) => requests.push(r);
  const params = {
    path: "/chunk",
    ticket: "fixture",
    body: new ArrayBuffer(1024),
    headers: {},
    sent: () => {},
    idleMs: 100,
    receiptMs: 100,
  };
  try {
    await expect(sendEdgeBlock(params)).rejects.toThrow("停止");
    expect(requests[0]!.aborted).toBe(true);
    let sent = 0;
    const advancing = sendEdgeBlock({ ...params, sent: (n) => (sent += n) });
    const xhr = requests[1]!;
    for (let n = 1; n <= 6; n++) {
      await Bun.sleep(30);
      xhr.upload.onprogress({ loaded: n * 100 });
    }
    expect(xhr.aborted).toBe(false); // total duration exceeds idle deadline
    xhr.upload.onload();
    xhr.reply({ offset: 1024 });
    expect((await advancing).offset).toBe(1024);
    expect(sent).toBe(600);
    const controller = new AbortController();
    const cancelled = sendEdgeBlock({ ...params, signal: controller.signal });
    controller.abort();
    await expect(cancelled).rejects.toHaveProperty("name", "AbortError");
    expect(requests[2]!.aborted).toBe(true);
  } finally {
    globalThis.XMLHttpRequest = original;
  }
});

test("progress uses wire activity while durable receipt count stays unchanged and speed decays at idle", async () => {
  const values: number[][] = [];
  const reporter = createProgressReporter(16384, (bytes, speed) =>
    values.push([bytes, speed]),
  );
  try {
    await Bun.sleep(300);
    reporter.sent(8192);
    expect(values.at(-1)![0]).toBe(16384);
    expect(values.at(-1)![1]).toBeGreaterThan(0);
    await Bun.sleep(1900);
    expect(values.at(-1)![1]).toBe(0);
  } finally {
    reporter.dispose();
  }
});

test("a missing early block bounds the receive window, retries identical bytes and completes without waiting for A8", async () => {
  const originalXHR = globalThis.XMLHttpRequest,
    originalFetch = globalThis.fetch;
  globalThis.XMLHttpRequest = TestXHR as any;
  const block = 256 * 1024,
    size = block * 24,
    received = new Set<number>();
  let attempts = 0,
    maxAhead = 0;
  const state = () => {
    let offset = 0;
    while (received.has(offset)) offset += block;
    return {
      size,
      blockBytes: block,
      offset,
      receivedBytes: received.size * block,
      replicatedOffset: 0,
      state: "receiving",
    };
  };
  globalThis.fetch = (async () => Response.json(state())) as any;
  TestXHR.send = (xhr) => {
    const offset = Number(xhr.headers["Upload-Offset"]);
    if (offset === 0 && attempts++ === 0) {
      setTimeout(() => xhr.onerror?.(), 150);
      return;
    }
    if (!received.has(0)) maxAhead = Math.max(maxAhead, offset / block);
    setTimeout(() => {
      received.add(offset);
      xhr.upload.onprogress({ loaded: block });
      xhr.reply(state());
    }, 5);
  };
  try {
    const result = await uploadEdge({
      path: "/edge",
      ticket: "fixture",
      file: new Blob([new Uint8Array(size)]),
      authoritativeOffset: 0,
      blockBytes: block,
      compress: false,
      stopped: () => false,
      progress: () => {},
    });
    expect(result.offset).toBe(size);
    expect(result.complete).toBe(false);
    expect(state().replicatedOffset).toBe(0);
    expect(attempts).toBe(2);
    expect(maxAhead).toBeLessThanOrEqual(8);
  } finally {
    globalThis.XMLHttpRequest = originalXHR;
    globalThis.fetch = originalFetch;
  }
});
