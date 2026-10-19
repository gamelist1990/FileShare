/** Isolated real-HTTP benchmark with a paced relay; never uses production accounts/data. */
import http from "node:http";
import { once } from "node:events";
import { Transform } from "node:stream";
import { randomBytes, createHash } from "node:crypto";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { defaults } from "../src/server/config";
import * as transfer from "../src/React/transfer";
import { randomToken, digestToken } from "@pexserver/secure-envelope";
const label = process.argv[2] ?? "current";
const root = await mkdtemp(join(tmpdir(), "fileshare-speed-"));
const port = 30000 + Math.floor(Math.random() * 15000),
  edge = port + 1;
const origin = `http://127.0.0.1:${edge}`;
const config = structuredClone(defaults);
Object.assign(config, { host: "127.0.0.1", port, origin, dataDir: root });
const app = await createApp(config),
  id = crypto.randomUUID(),
  token = randomToken();
app.store.db.run("INSERT INTO users VALUES (?,?,?,?,?,?,?)", [
  id,
  "benchmark",
  4,
  "approved",
  5e9,
  "192.0.2.1",
  Date.now(),
]);
app.store.db.run("INSERT INTO sessions VALUES (?,?,?)", [
  digestToken(token),
  id,
  Date.now() + 3600000,
]);
let bytesPerSecond = 125000,
  rtt = 600,
  wireUp = 0,
  wireDown = 0;
class Pace extends Transform {
  constructor(private direction: "up" | "down") {
    super({ highWaterMark: 16384 });
  }
  _transform(
    chunk: Buffer,
    _encoding: string,
    done: (e?: Error | null, data?: Buffer) => void,
  ) {
    if (this.direction === "up") wireUp += chunk.length;
    else wireDown += chunk.length;
    setTimeout(() => done(null, chunk), (chunk.length / bytesPerSecond) * 1000);
  }
}
const proxy = http.createServer(async (req, res) => {
  await Bun.sleep(rtt / 2);
  const upstream = http.request(
    {
      hostname: "127.0.0.1",
      port,
      path: req.url,
      method: req.method,
      headers: req.headers,
    },
    async (reply) => {
      await Bun.sleep(rtt / 2);
      res.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(new Pace("down")).pipe(res);
    },
  );
  upstream.on("error", () => {
    res.destroy();
  });
  req.pipe(new Pace("up")).pipe(upstream);
});
await new Promise<void>((resolve) => proxy.listen(edge, "127.0.0.1", resolve));
const headers = { Origin: origin, Cookie: `fs_session=${token}` };
async function request(path: string, method = "GET", body?: unknown) {
  const response = await fetch(origin + path, {
    method,
    headers: {
      ...headers,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await response.json()) as any;
  if (!response.ok)
    throw new Error(`${response.status} ${JSON.stringify(json)}`);
  return json;
}
const rows: any[] = [];
try {
  for (const [kbps, latency, length] of [
    [256, 200, 512 * 1024],
    [1000, 600, 4 * 1024 * 1024],
  ]) {
    bytesPerSecond = (kbps * 1000) / 8;
    rtt = latency;
    for (const text of [false, true]) {
      const name = `${label}-${kbps}-${text ? "text.txt" : "binary.bin"}`;
      const data = text
        ? Buffer.from(
            "const example = { name: 'FileShare', value: 12345 };\n".repeat(
              Math.ceil(length / 50),
            ),
          ).subarray(0, length)
        : randomBytes(length);
      wireUp = wireDown = 0;
      const start = performance.now(),
        initStart = start;
      const upload = await request("/api/uploads", "POST", {
        name,
        size: data.length,
        mime: text ? "text/plain" : "application/octet-stream",
      });
      const roundTripMs = performance.now() - initStart;
      let offset = 0,
        chunk = 1048576;
      while (offset < data.length) {
        const bytes = data.subarray(offset, offset + chunk);
        const prep = (transfer as any).prepareChunk;
        const prepared = prep
          ? await prep(new Blob([bytes]), text)
          : {
              body: bytes,
              checksum: createHash("sha256").update(bytes).digest("hex"),
              compressed: false,
            };
        const t = performance.now();
        const response = await fetch(origin + "/api/uploads/" + upload.id, {
          method: "PATCH",
          headers: {
            ...headers,
            "Content-Type": "application/octet-stream",
            "Upload-Offset": String(offset),
            "Upload-Checksum": prepared.checksum,
            ...(prepared.compressed ? { "Upload-Encoding": "gzip" } : {}),
          },
          body: prepared.body,
        });
        const ack = (await response.json()) as any;
        if (!response.ok) throw new Error(JSON.stringify(ack));
        offset = ack.offset;
        chunk = (transfer.nextChunk as any)(
          chunk,
          bytes.length,
          performance.now() - t,
          false,
          roundTripMs,
        );
      }
      await request("/api/uploads/" + upload.id + "/complete", "POST", {});
      const uploadMs = performance.now() - start;
      const stored = app.store.db
        .query("SELECT id FROM items WHERE name=?")
        .get(name) as { id: string };
      const ticket = await request(
        "/api/items/" + stored.id + "/ticket",
        "POST",
        {},
      );
      wireDown = 0;
      const t = performance.now();
      const downloaded = await fetch(origin + ticket.url, {
        headers: { ...headers, "Accept-Encoding": "gzip" },
      });
      const received = Buffer.from(await downloaded.arrayBuffer());
      if (!received.equals(data)) throw new Error("Download integrity failed");
      const row = {
        label,
        kbps,
        rttMs: latency,
        type: text ? "text" : "binary",
        bytes: data.length,
        uploadMs: Math.round(uploadMs),
        downloadMs: Math.round(performance.now() - t),
        wireUp,
        wireDown,
      };
      rows.push(row);
      console.log(JSON.stringify(row));
    }
  }
  await mkdir(".artifacts", { recursive: true });
  await writeFile(
    `.artifacts/transfer-${label}.json`,
    JSON.stringify(rows, null, 2),
  );
} finally {
  proxy.closeAllConnections();
  proxy.close();
  app.close();
  await rm(root, { recursive: true, force: true });
}
