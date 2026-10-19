import { beforeEach, afterEach, test, expect } from "bun:test";
import WS from "ws-node";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { createApp } from "../src/server/app";
import { defaults } from "../src/server/config";
import { randomToken, digestToken } from "@pexserver/secure-envelope";
import {
  packBlock,
  unpackBlock,
  PipelineWindow,
  BLOCK_BYTES,
  MIN_BLOCK_BYTES,
  MAX_BLOCK_BYTES,
  blockBytesForSize,
  PIPELINE_PROTOCOL,
} from "../src/shared/pipeline";
let app: Awaited<ReturnType<typeof createApp>>, dir: string, origin: string;

test("pipeline block sizing stays within the negotiated 256KiB-8MiB range", () => {
  expect(blockBytesForSize(128 * 1024)).toBe(MIN_BLOCK_BYTES);
  expect(blockBytesForSize(8 * 1024 * 1024)).toBe(BLOCK_BYTES);
  expect(blockBytesForSize(64 * 1024 * 1024)).toBe(2 * 1024 * 1024);
  expect(blockBytesForSize(1024 * 1024 * 1024)).toBe(MAX_BLOCK_BYTES);
});
let cookies: Record<string, string>;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fileshare-pipeline-"));
  const config = structuredClone(defaults);
  config.port = 30000 + Math.floor(Math.random() * 20000);
  config.origin = `http://127.0.0.1:${config.port}`;
  config.dataDir = dir;
  config.rate.authPerMinute = 100;
  origin = config.origin;
  app = await createApp(config);
  cookies = {};
  for (const user of ["owner", "other"]) {
    const token = randomToken();
    cookies[user] = `fs_session=${token}`;
    app.store.db.run("INSERT INTO users VALUES (?,?,?,?,?,?,?)", [
      user,
      user,
      1,
      "approved",
      5e9,
      "192.0.2.1",
      Date.now(),
    ]);
    app.store.db.run("INSERT INTO sessions VALUES (?,?,?)", [
      digestToken(token),
      user,
      Date.now() + 3600000,
    ]);
  }
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});
function headers(user = "owner") {
  return { Origin: origin, Cookie: cookies[user] ?? "" };
}
async function api(
  path: string,
  method = "GET",
  body?: unknown,
  user = "owner",
) {
  const r = await fetch(origin + path, {
    method,
    headers: { ...headers(user), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: (await r.json()) as any };
}
async function init(size: number) {
  return (
    await api("/api/uploads", "POST", {
      name: crypto.randomUUID() + ".bin",
      size,
      space: "private",
    })
  ).data.id as string;
}
function block(
  offset: number,
  data: Buffer,
  compress = false,
  logical = data.length,
  hash = createHash("sha256").update(data).digest("hex"),
) {
  const encoded = compress ? gzipSync(data) : data;
  return packBlock(
    offset,
    Uint8Array.from(encoded).buffer,
    logical,
    hash,
    compress,
  );
}
function connect(id: string, extra: Record<string, string> = {}) {
  const ws = new WS(
    origin.replace("http:", "ws:") + `/api/uploads/${id}/stream`,
    PIPELINE_PROTOCOL,
    { headers: { ...headers(), ...extra } },
  );
  const backlog: any[] = [],
    pending: {
      type: string;
      resolve: (m: any) => void;
      reject: (e: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
    }[] = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    const n = pending.findIndex((p) => p.type === m.type);
    if (n >= 0) {
      const p = pending.splice(n, 1)[0];
      clearTimeout(p.timer);
      p.resolve(m);
    } else backlog.push(m);
  });
  ws.on("error", () => {});
  const next = (type: string) => {
    const n = backlog.findIndex((m) => m.type === type);
    if (n >= 0) return Promise.resolve(backlog.splice(n, 1)[0]);
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Missing ${type}: ${JSON.stringify(backlog)}`)),
        4000,
      );
      timer.unref();
      pending.push({ type, resolve, reject, timer });
    });
  };
  return { ws, next };
}
async function ready(id: string) {
  const peer = connect(id);
  const hello = await peer.next("ready");
  return { ...peer, hello };
}
async function rejection(id: string, extra: Record<string, string>) {
  return new Promise<number>((resolve, reject) => {
    const peer = connect(id, extra);
    peer.ws.once("unexpected-response", (_req, res) => {
      resolve(res.statusCode!);
      res.resume();
      peer.ws.terminate();
    });
    peer.ws.once("open", () => {
      peer.ws.terminate();
      reject(new Error("Unauthorized upgrade accepted"));
    });
  });
}
async function idle(id: string) {
  for (let n = 0; n < 50; n++) {
    const peer = connect(id);
    const value = await Promise.race([
      peer.next("ready"),
      new Promise<null>((resolve) =>
        peer.ws.once("unexpected-response", (_req, res) => {
          res.resume();
          peer.ws.terminate();
          resolve(null);
        }),
      ),
    ]);
    if (value) return { ...peer, hello: value };
    await Bun.sleep(10);
  }
  throw new Error("Lease was not released");
}

test("bounded window reacts to excess delay, grows on stable delivery and validates frames", () => {
  const window = new PipelineWindow(100);
  for (let i = 1; i <= 5; i++)
    window.acknowledge(i * 100, i * 100 + 200, 65536, 0, 2);
  expect(window.window).toBeGreaterThan(1);
  const grown = window.window;
  for (let i = 1; i <= 4; i++)
    window.acknowledge(2000 + i * 10, 5000 + i * 10, 65536, 0, 1);
  expect(window.window).toBeLessThan(grown);
  expect(window.window).toBeGreaterThanOrEqual(1);
  expect(window.window).toBeLessThanOrEqual(16);
  const encoded = block(0, Buffer.from("proof"));
  expect(unpackBlock(new Uint8Array(encoded)).logicalBytes).toBe(5);
  const invalid = new Uint8Array(encoded);
  invalid[5] = 1;
  expect(() => unpackBlock(invalid)).toThrow();
});

test("multiple blocks sent before ACK commit durable receipts and complete with original bytes", async () => {
  const data = randomBytes(BLOCK_BYTES * 4),
    id = await init(data.length),
    peer = await ready(id);
  for (let offset = 0; offset < data.length; offset += BLOCK_BYTES)
    peer.ws.send(block(offset, data.subarray(offset, offset + BLOCK_BYTES)));
  for (let n = 1; n <= 4; n++) {
    const ack = await peer.next("ack");
    expect(ack.offset).toBe(n * BLOCK_BYTES);
    expect(
      (await api("/api/uploads/" + id)).data.offset,
    ).toBeGreaterThanOrEqual(ack.offset);
  }
  expect(
    (
      app.store.db
        .query("SELECT COUNT(*) AS n FROM upload_blocks WHERE upload_id=?")
        .get(id) as any
    ).n,
  ).toBe(4);
  expect((await api("/api/uploads/" + id)).data.receipt.hash).toBe(
    createHash("sha256")
      .update(data.subarray(3 * BLOCK_BYTES))
      .digest("hex"),
  );
  peer.ws.send(JSON.stringify({ type: "finish" }));
  expect((await peer.next("done")).offset).toBe(data.length);
  expect(
    (await api("/api/uploads/" + id + "/complete", "POST", {})).status,
  ).toBe(200);
  expect(await readFile(join(app.store.blobDir, id))).toEqual(data);
  expect(
    (
      app.store.db
        .query("SELECT COUNT(*) AS n FROM upload_blocks WHERE upload_id=?")
        .get(id) as any
    ).n,
  ).toBe(0);
});

test("lost ACKs and reconnection resume only the server's committed prefix", async () => {
  const data = randomBytes(BLOCK_BYTES * 6),
    id = await init(data.length),
    first = await ready(id);
  for (let offset = 0; offset < 3 * BLOCK_BYTES; offset += BLOCK_BYTES)
    first.ws.send(block(offset, data.subarray(offset, offset + BLOCK_BYTES)));
  await first.next("ack");
  first.ws.terminate();
  const resumed = await idle(id);
  expect(resumed.hello.offset).toBeGreaterThanOrEqual(BLOCK_BYTES);
  expect(resumed.hello.offset).toBeLessThanOrEqual(3 * BLOCK_BYTES);
  expect(resumed.hello.receipt.start + resumed.hello.receipt.length).toBe(
    resumed.hello.offset,
  );
  const start = resumed.hello.offset;
  for (let offset = start; offset < data.length; offset += BLOCK_BYTES)
    resumed.ws.send(block(offset, data.subarray(offset, offset + BLOCK_BYTES)));
  for (let offset = start; offset < data.length; offset += BLOCK_BYTES)
    await resumed.next("ack");
  resumed.ws.send(JSON.stringify({ type: "finish" }));
  await resumed.next("done");
  expect(
    (await api("/api/uploads/" + id + "/complete", "POST", {})).status,
  ).toBe(200);
  expect(await readFile(join(app.store.blobDir, id))).toEqual(data);
});

test("origin, identity, session revocation and concurrent writers cannot bypass upload policy", async () => {
  const id = await init(BLOCK_BYTES);
  expect(await rejection(id, { Cookie: "" })).toBe(401);
  expect(await rejection(id, headers("other"))).toBe(404);
  expect(await rejection(id, { Origin: "https://attacker.invalid" })).toBe(403);
  expect(await rejection(id, { Host: "attacker.invalid" })).toBe(403);
  const peer = await ready(id);
  expect(await rejection(id, {})).toBe(409);
  const rest = await fetch(origin + "/api/uploads/" + id, {
    method: "PATCH",
    headers: {
      ...headers(),
      "Upload-Offset": "0",
      "Upload-Checksum": "0".repeat(64),
    },
    body: "x",
  });
  expect(rest.status).toBe(409);
  app.store.db.run("UPDATE users SET status='denied' WHERE id='owner'");
  peer.ws.send(block(0, Buffer.alloc(BLOCK_BYTES)));
  expect((await peer.next("error")).status).toBe(401);
  expect(
    (app.store.db.query("SELECT offset FROM uploads WHERE id=?").get(id) as any)
      .offset,
  ).toBe(0);
});

test("corrupt hashes, gaps, decompression bombs and false lengths never advance receipts", async () => {
  for (const kind of ["hash", "gap", "bomb", "length"]) {
    const id = await init(BLOCK_BYTES * 2),
      peer = await ready(id),
      data = Buffer.alloc(BLOCK_BYTES, 65);
    const bad =
      kind === "hash"
        ? block(0, data, false, data.length, "0".repeat(64))
        : kind === "gap"
          ? block(1, data)
          : kind === "bomb"
            ? block(0, Buffer.alloc(BLOCK_BYTES + 1, 65), true, BLOCK_BYTES)
            : block(0, data, true, 123);
    peer.ws.send(bad);
    expect([400, 409, 413]).toContain((await peer.next("error")).status);
    expect((await api("/api/uploads/" + id)).data.offset).toBe(0);
    expect(
      (
        app.store.db
          .query("SELECT COUNT(*) AS n FROM upload_blocks WHERE upload_id=?")
          .get(id) as any
      ).n,
    ).toBe(0);
  }
});

test("pause requires the owning session and exact connection identifier", async () => {
  const id = await init(BLOCK_BYTES * 2),
    peer = await ready(id);
  expect(
    (
      await api(
        `/api/uploads/${id}/stream/stop`,
        "POST",
        { connectionId: peer.hello.connectionId },
        "other",
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await api(`/api/uploads/${id}/stream/stop`, "POST", {
        connectionId: "different-tab",
      })
    ).status,
  ).toBe(200);
  peer.ws.send(block(0, Buffer.alloc(BLOCK_BYTES, 65), true));
  await peer.next("ack");
  expect(
    (
      await api(`/api/uploads/${id}/stream/stop`, "POST", {
        connectionId: peer.hello.connectionId,
      })
    ).data.offset,
  ).toBe(BLOCK_BYTES);
  const resumed = await idle(id);
  expect(resumed.hello.offset).toBe(BLOCK_BYTES);
  resumed.ws.terminate();
});

test("excessive queued blocks are rejected without unbounded buffering", async () => {
  app.store.config.rate.maxBytesPerSecond = 65536;
  const id = await init(BLOCK_BYTES * 32),
    peer = await ready(id),
    data = Buffer.alloc(BLOCK_BYTES, 65);
  for (let n = 0; n < 32; n++) peer.ws.send(block(n * BLOCK_BYTES, data, true));
  expect((await peer.next("error")).status).toBe(429);
});

test("HTTP and WebSocket share transfer limits and upgrades have per-IP admission limits", async () => {
  const ids = await Promise.all([
    init(BLOCK_BYTES),
    init(BLOCK_BYTES),
    init(BLOCK_BYTES),
    init(BLOCK_BYTES),
  ]);
  const peers = [];
  for (const id of ids.slice(0, 3)) peers.push(await ready(id));
  expect(await rejection(ids[3], {})).toBe(429);
  const rest = await fetch(origin + "/api/uploads/" + ids[3], {
    method: "PATCH",
    headers: {
      ...headers(),
      "Upload-Offset": "0",
      "Upload-Checksum": "0".repeat(64),
    },
    body: "x",
  });
  expect(rest.status).toBe(429);
  await api(`/api/uploads/${ids[0]}/stream/stop`, "POST", {
    connectionId: peers[0].hello.connectionId,
  });
  const fourth = await ready(ids[3]);
  fourth.ws.terminate();
  for (const peer of peers.slice(1)) peer.ws.terminate();
});

test("PROXY v2 identity survives the WebSocket upgrade and direct handshakes are rejected", async () => {
  const { default: net } = await import("node:net");
  const id = await init(BLOCK_BYTES),
    port = Number(new URL(origin).port);
  app.store.config.proxy.enabled = true;
  app.store.config.proxy.trustedPeers = ["127.0.0.1"];
  expect(await rejection(id, {})).toBe(400);
  const prefix = Buffer.alloc(28);
  Buffer.from([13, 10, 13, 10, 0, 13, 10, 81, 85, 73, 84, 10]).copy(prefix);
  prefix[12] = 0x21;
  prefix[13] = 0x11;
  prefix.writeUInt16BE(12, 14);
  Buffer.from([203, 0, 113, 9, 127, 0, 0, 1]).copy(prefix, 16);
  prefix.writeUInt16BE(12345, 24);
  prefix.writeUInt16BE(port, 26);
  const sockets = new Set<import("node:net").Socket>();
  const bridge = net.createServer({ pauseOnConnect: true }, (client) => {
    const upstream = net.connect(port, "127.0.0.1");
    sockets.add(client);
    sockets.add(upstream);
    upstream.once("connect", () => {
      upstream.write(prefix);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", close);
    upstream.on("error", close);
  });
  await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  const bridgePort = (bridge.address() as import("node:net").AddressInfo).port;
  const ws = new WS(
    `ws://127.0.0.1:${bridgePort}/api/uploads/${id}/stream`,
    PIPELINE_PROTOCOL,
    { headers: { ...headers(), Host: new URL(origin).host } },
  );
  const hello = await new Promise<any>((resolve, reject) => {
    ws.once("message", (raw) => resolve(JSON.parse(raw.toString())));
    ws.once("error", reject);
  });
  expect(hello.type).toBe("ready");
  expect(
    (
      app.store.db
        .query("SELECT count FROM limits WHERE key=?")
        .get("pipeline-connect:203.0.113.9") as any
    ).count,
  ).toBe(1);
  ws.terminate();
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => bridge.close(() => resolve()));
});
