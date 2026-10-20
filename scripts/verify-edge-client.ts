/** Real Chromium XHR progress, retry and timeout checks against a loopback fixture. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { unpackBlock, PIPELINE_PROTOCOL } from "../src/shared/pipeline";
import { chromium } from "@playwright/test";
const bundle = await Bun.build({
  entrypoints: ["src/React/edge-upload.ts"],
  target: "browser",
});
if (!bundle.success) throw new Error("edge client build failed");
const js = await bundle.outputs[0]!.text();
const block = 1024 * 1024,
  receipts = new Map<number, string>();
let fallbackMode = false,
  patches = 0;
let size = 4 * block,
  pipelineMode = false,
  pendingAcks = 0,
  peakAcks = 0;
let lostAck = false,
  duplicate = false;
function status() {
  let offset = 0;
  while (receipts.has(offset)) offset += block;
  return {
    size,
    ...(pipelineMode ? { pipeline: PIPELINE_PROTOCOL } : {}),
    blockBytes: block,
    offset,
    receivedBytes: receipts.size * block,
    replicatedOffset: 0,
    state: "receiving",
  };
}
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request, instance) {
    const path = new URL(request.url).pathname;
    if (path === "/")
      return new Response(
        "<!doctype html><title>Edge transport verification</title>",
        { headers: { "Content-Type": "text/html" } },
      );
    if (path === "/client.js")
      return new Response(js, {
        headers: { "Content-Type": "text/javascript" },
      });
    if (path === "/edge/stream") {
      assert.equal(
        request.headers.get("sec-websocket-protocol"),
        PIPELINE_PROTOCOL + ", fixture",
      );
      if (
        instance.upgrade(request, {
          headers: { "Sec-WebSocket-Protocol": PIPELINE_PROTOCOL },
        })
      )
        return;
      return new Response(null, { status: 400 });
    }
    if (request.headers.get("authorization") !== "Bearer fixture")
      return new Response(null, { status: 401 });
    if (path === "/stall") {
      await request.arrayBuffer();
      await Bun.sleep(500);
      return Response.json({});
    }
    if (request.method === "PATCH") {
      patches++;
      const offset = Number(request.headers.get("upload-offset")),
        bytes = await request.arrayBuffer();
      const hash = createHash("sha256")
        .update(new Uint8Array(bytes))
        .digest("hex");
      assert.equal(hash, request.headers.get("upload-checksum"));
      assert.equal(bytes.byteLength, block);
      if (receipts.has(offset)) {
        assert.equal(receipts.get(offset), hash);
        duplicate = true;
      }
      receipts.set(offset, hash);
      if (offset === 0 && !lostAck) {
        lostAck = true;
        return Response.json({ error: "lost ACK fixture" }, { status: 503 });
      }
    }
    return Response.json(status());
  },
  websocket: {
    open(ws) {
      ws.send(
        JSON.stringify({
          type: "ready",
          protocol: PIPELINE_PROTOCOL,
          maxInFlight: 16,
          connectionId: "",
          ...status(),
        }),
      );
    },
    async message(ws, message) {
      if (typeof message === "string") {
        const command = JSON.parse(message);
        if (command.type === "ping")
          ws.send(JSON.stringify({ type: "pong", nonce: command.nonce }));
        return;
      }
      const frame = unpackBlock(new Uint8Array(message));
      assert.equal(
        frame.checksum,
        createHash("sha256").update(frame.bytes).digest("hex"),
      );
      receipts.set(frame.offset, frame.checksum);
      if (fallbackMode) {
        ws.close(1011, "interrupted fixture");
        return;
      }
      pendingAcks++;
      peakAcks = Math.max(peakAcks, pendingAcks);
      await Bun.sleep(100); // delayed receipts must not serialize client block sends
      pendingAcks--;
      ws.send(
        JSON.stringify({
          type: "ack",
          offset: frame.offset + frame.logicalBytes,
          bytes: frame.logicalBytes,
          processingMs: 100,
        }),
      );
      if (frame.offset + frame.logicalBytes === size)
        ws.send(JSON.stringify({ type: "done", offset: size }));
    },
  },
});
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {}),
});
try {
  const context = await browser.newContext(),
    page = await context.newPage();
  await page.goto(String(server.url));
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 10,
    downloadThroughput: -1,
    uploadThroughput: 512 * 1024,
  });
  const result = await page.evaluate(
    async ({ block, size }) => {
      const modulePath = "/client.js";
      const { uploadEdge, sendEdgeBlock } = await import(modulePath);
      let activeBeforeReceipt = false,
        samples = 0;
      const result = await uploadEdge({
        path: "/edge",
        ticket: "fixture",
        file: new Blob([new Uint8Array(size).fill(0x39)]),
        authoritativeOffset: 0,
        blockBytes: block,
        compress: false,
        stopped: () => false,
        progress: (bytes: number, speed: number) => {
          samples++;
          if (bytes === 0 && speed > 0) activeBeforeReceipt = true;
        },
      });
      let timedOut = false;
      try {
        await sendEdgeBlock({
          path: "/stall",
          ticket: "fixture",
          body: new ArrayBuffer(8),
          headers: {},
          sent: () => {},
          idleMs: 300,
          receiptMs: 100,
        });
      } catch {
        timedOut = true;
      }
      return { result, activeBeforeReceipt, samples, timedOut };
    },
    { block, size },
  );
  assert.equal(result.result.offset, size);
  assert.equal(result.result.complete, false); // A8 has not replicated any bytes.
  assert.equal(result.activeBeforeReceipt, true);
  assert.equal(result.timedOut, true);
  assert.equal(lostAck, true);
  assert.equal(duplicate, true);
  assert.equal(receipts.size, 4);
  console.log(
    "Chromium edge upload: throttled progress before ACK, identical retry after lost ACK, full ingress with A8 offset 0, stalled response deadline: PASS",
  );
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  receipts.clear();
  pipelineMode = true;
  size = 16 * block;
  const pipelined = await page.evaluate(
    async ({ size, block }) => {
      const modulePath = "/client.js";
      const { uploadEdge } = await import(modulePath);
      return uploadEdge({
        path: "/edge",
        ticket: "fixture",
        file: new Blob([new Uint8Array(size).fill(0x27)]),
        authoritativeOffset: 0,
        blockBytes: block,
        compress: false,
        stopped: () => false,
        progress: () => {},
      });
    },
    { size, block },
  );
  assert.equal(pipelined.offset, size);
  assert.equal(pipelined.complete, false);
  assert.equal(receipts.size, 16);
  assert.ok(peakAcks >= 4);
  assert.ok(peakAcks <= 16);
  console.log(
    "Chromium A1 pipelined socket: multiple blocks in flight before ACK, SHA-256 verified, full ingress with A8 offset 0: PASS; peak",
    peakAcks,
  );
  receipts.clear();
  fallbackMode = true;
  const beforePatches = patches;
  const recovered = await page.evaluate(
    async ({ size, block }) => {
      const modulePath = "/client.js";
      const { uploadEdge } = await import(modulePath);
      return uploadEdge({
        path: "/edge",
        ticket: "fixture",
        file: new Blob([new Uint8Array(size).fill(0x42)]),
        authoritativeOffset: 0,
        blockBytes: block,
        compress: false,
        stopped: () => false,
        progress: () => {},
      });
    },
    { size, block },
  );
  assert.equal(recovered.offset, size);
  assert.equal(recovered.complete, false);
  assert.equal(receipts.size, 16);
  assert.ok(patches > beforePatches);
  console.log(
    "Chromium interrupted A1 socket: HTTP fallback resumes durable blocks and completes: PASS",
  );
} finally {
  await browser.close();
  server.stop(true);
}
