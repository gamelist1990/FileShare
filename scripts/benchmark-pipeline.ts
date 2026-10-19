/** Bounded TCP relay models serialization + propagation for BOTH HTTP and WebSocket. */
import net from "node:net";
import { Transform, type TransformCallback } from "node:stream";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WS from "ws-node";
import { createApp } from "../src/server/app";
import { defaults } from "../src/server/config";
import { digestToken, randomToken } from "@pexserver/secure-envelope";
import { prepareChunk, nextChunk } from "../src/React/transfer";
import { uploadPipeline } from "../src/React/upload-pipeline";
const root = await mkdtemp(join(tmpdir(), "fileshare-pipeline-benchmark-")),
  config = structuredClone(defaults);
config.port = 30000 + Math.floor(Math.random() * 15000);
const edge = config.port + 1,
  origin = `http://127.0.0.1:${edge}`;
Object.assign(config, { origin, dataDir: root });
config.rate.authPerMinute = 100;
const app = await createApp(config),
  token = randomToken(),
  cookie = `fs_session=${token}`;
app.store.db.run("INSERT INTO users VALUES (?,?,?,?,?,?,?)", [
  "benchmark",
  "benchmark",
  4,
  "approved",
  5e9,
  "192.0.2.1",
  Date.now(),
]);
app.store.db.run("INSERT INTO sessions VALUES (?,?,?)", [
  digestToken(token),
  "benchmark",
  Date.now() + 3600000,
]);
let kbps = 1000,
  rtt = 600,
  wireUp = 0,
  wireDown = 0,
  maxFlight = 0;
class Pace extends Transform {
  next = 0;
  queued = 0;
  timers = new Set<ReturnType<typeof setTimeout>>();
  pending?: TransformCallback;
  flush?: TransformCallback;
  constructor(private direction: "up" | "down") {
    super({ highWaterMark: 65536 });
  }
  _transform(chunk: Buffer, _encoding: string, done: TransformCallback) {
    const length = chunk.length;
    this.queued += length;
    if (this.direction === "up") wireUp += length;
    else wireDown += length;
    this.next =
      Math.max(performance.now(), this.next) +
      (length / ((kbps * 1000) / 8)) * 1000;
    const at = this.next + rtt / 2;
    const timer = setTimeout(
      () => {
        this.timers.delete(timer);
        this.queued -= length;
        this.push(chunk);
        if (this.pending && this.queued < 512 * 1024) {
          const next = this.pending;
          this.pending = undefined;
          next();
        }
        if (!this.queued && this.flush) {
          const finish = this.flush;
          this.flush = undefined;
          finish();
        }
      },
      Math.max(0, at - performance.now()),
    );
    this.timers.add(timer);
    if (this.queued > 1024 * 1024) this.pending = done;
    else done();
  }
  _flush(done: TransformCallback) {
    if (this.queued) this.flush = done;
    else done();
  }
  _destroy(error: Error | null, done: (error?: Error | null) => void) {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    done(error);
  }
}
const sockets = new Set<net.Socket>();
const relay = net.createServer((client) => {
  const upstream = net.connect(config.port, "127.0.0.1");
  client.setNoDelay(true);
  upstream.setNoDelay(true);
  sockets.add(client);
  sockets.add(upstream);
  const up = new Pace("up"),
    down = new Pace("down");
  const close = () => {
    sockets.delete(client);
    sockets.delete(upstream);
    client.destroy();
    upstream.destroy();
    up.destroy();
    down.destroy();
  };
  for (const socket of [client, upstream]) {
    socket.on("error", close);
    socket.on("close", close);
  }
  up.on("error", close);
  down.on("error", close);
  client.pipe(up).pipe(upstream);
  upstream.pipe(down).pipe(client);
});
await new Promise<void>((resolve) => relay.listen(edge, "127.0.0.1", resolve));
const originalWebSocket = globalThis.WebSocket;
class AuthenticatedSocket extends WS {
  constructor(url: string, protocol: string) {
    super(url, protocol, { headers: { Origin: origin, Cookie: cookie } });
    let flight = 0;
    this.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "ack") flight--;
    });
    const send = this.send.bind(this);
    this.send = ((data: any, ...args: any[]) => {
      if (typeof data !== "string") {
        flight++;
        maxFlight = Math.max(maxFlight, flight);
      }
      return send(data, ...args);
    }) as any;
  }
}
(globalThis as any).WebSocket = AuthenticatedSocket;
async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(origin + path, {
    method,
    headers: {
      Origin: origin,
      Cookie: cookie,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = (await response.json()) as any;
  if (!response.ok) throw new Error(JSON.stringify(value));
  return value;
}
const rows: any[] = [];
try {
  for (const [speed, latency] of process.argv.includes("--congestion-only")
    ? []
    : [
        [1000, 600],
        [5000, 300],
      ]) {
    kbps = speed;
    rtt = latency;
    for (const text of [false, true]) {
      const data = text
        ? Buffer.from(
            "const example = { name: 'FileShare', value: 12345 };\n".repeat(
              90000,
            ),
          ).subarray(0, 4 * 1024 * 1024)
        : randomBytes(4 * 1024 * 1024);
      for (const mode of process.argv.includes("--pipeline-only")
        ? ["pipeline"]
        : ["rest", "pipeline"]) {
        wireUp = wireDown = maxFlight = 0;
        const start = performance.now();
        const upload = await api("/api/uploads", "POST", {
            name: `${mode}-${speed}-${text ? "text.txt" : "binary.bin"}`,
            size: data.length,
            space: "private",
          }),
          probe = performance.now() - start;
        if (mode === "pipeline") {
          const result = await uploadPipeline({
            url:
              origin.replace("http:", "ws:") +
              `/api/uploads/${upload.id}/stream`,
            file: new Blob([data]),
            offset: 0,
            roundTripMs: probe,
            compress: text,
            stopped: () => false,
            progress: () => {},
          });
          if (result.offset !== data.length)
            throw new Error("Incomplete pipeline");
        } else {
          let offset = 0,
            chunk = 1048576;
          while (offset < data.length) {
            const bytes = data.subarray(offset, offset + chunk),
              prepared = await prepareChunk(new Blob([bytes]), text),
              sent = performance.now();
            const reply = await fetch(origin + "/api/uploads/" + upload.id, {
              method: "PATCH",
              headers: {
                Origin: origin,
                Cookie: cookie,
                "Upload-Offset": String(offset),
                "Upload-Checksum": prepared.checksum,
                ...(prepared.compressed ? { "Upload-Encoding": "gzip" } : {}),
              },
              body: prepared.body,
            });
            const result = (await reply.json()) as any;
            if (!reply.ok) throw new Error(JSON.stringify(result));
            offset = result.offset;
            chunk = nextChunk(
              chunk,
              bytes.length,
              performance.now() - sent,
              false,
              probe,
            );
          }
        }
        await api("/api/uploads/" + upload.id + "/complete", "POST", {});
        const ms = Math.round(performance.now() - start);
        if (!(await readFile(join(app.store.blobDir, upload.id))).equals(data))
          throw new Error("Saved bytes differ");
        const row = {
          mode,
          kbps,
          rttMs: rtt,
          type: text ? "repeated-text" : "random-binary",
          bytes: data.length,
          uploadMs: ms,
          wireUp,
          wireDown,
          maxInFlight: maxFlight,
        };
        rows.push(row);
        console.log(JSON.stringify(row));
      }
    }
  }
  if (
    process.argv.includes("--congestion") ||
    process.argv.includes("--congestion-only")
  ) {
    kbps = 5000;
    rtt = 300;
    maxFlight = 0;
    const data = randomBytes(8 * 1024 * 1024),
      start = performance.now();
    const upload = await api("/api/uploads", "POST", {
      name: "congestion.bin",
      size: data.length,
      space: "private",
    });
    let phase = 0,
      backoffs = 0,
      previous = 2,
      minWindow = 16,
      maxWindow = 1;
    const result = await uploadPipeline({
      url: origin.replace("http:", "ws:") + `/api/uploads/${upload.id}/stream`,
      file: new Blob([data]),
      offset: 0,
      roundTripMs: 300,
      compress: false,
      stopped: () => false,
      progress: (offset) => {
        if (phase === 0 && offset >= 4 * 1024 * 1024) {
          kbps = 1000;
          phase = 1;
        } else if (phase === 1 && offset >= 6 * 1024 * 1024) {
          kbps = 5000;
          phase = 2;
        }
      },
      feedback: (state) => {
        minWindow = Math.min(minWindow, state.window);
        maxWindow = Math.max(maxWindow, state.window);
        if (state.window < previous) backoffs++;
        previous = state.window;
      },
    });
    await api("/api/uploads/" + upload.id + "/complete", "POST", {});
    if (
      result.offset !== data.length ||
      !(await readFile(join(app.store.blobDir, upload.id))).equals(data) ||
      maxFlight > 16 ||
      !backoffs
    )
      throw new Error("Congestion response/integrity failed");
    const row = {
      mode: "pipeline",
      scenario: "5→1→5Mbps, 300ms RTT",
      bytes: data.length,
      uploadMs: Math.round(performance.now() - start),
      maxInFlight: maxFlight,
      minWindow,
      maxWindow,
      backoffs,
    };
    rows.push(row);
    console.log(JSON.stringify(row));
  }
  await mkdir(".artifacts", { recursive: true });
  await writeFile(
    process.argv.includes("--congestion-only")
      ? ".artifacts/pipeline-congestion.json"
      : process.argv.includes("--pipeline-only")
        ? ".artifacts/pipeline-benchmark-final.json"
        : ".artifacts/pipeline-benchmark.json",
    JSON.stringify(rows, null, 2),
  );
} finally {
  (globalThis as any).WebSocket = originalWebSocket;
  for (const socket of sockets) socket.destroy();
  relay.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
