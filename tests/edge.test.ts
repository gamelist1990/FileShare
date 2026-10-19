import { test, expect } from "bun:test";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { readDurablePrefix } from "../src/server/edge-files";
import { Database } from "bun:sqlite";
import { createApp } from "../src/server/app";
import { defaults } from "../src/server/config";
import { createEdgeUploadTicket } from "../src/server/edge-auth";
import { digestToken, randomToken } from "@pexserver/secure-envelope";
function preface(ip: string, port: number) {
  const b = Buffer.alloc(28);
  Buffer.from("\r\n\r\n\0\r\nQUIT\n", "binary").copy(b);
  b[12] = 0x21;
  b[13] = 0x11;
  b.writeUInt16BE(12, 14);
  ip.split(".").forEach((n, i) => (b[16 + i] = Number(n)));
  b[20] = 127;
  b[23] = 1;
  b.writeUInt16BE(50000, 24);
  b.writeUInt16BE(port, 26);
  return b;
}
function request(
  port: number,
  path: string,
  method = "GET",
  body = Buffer.alloc(0),
  headers: Record<string, string> = {},
  ip = "192.0.2.42",
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  json: () => any;
}> {
  return new Promise((resolve, reject) => {
    const agent = new http.Agent({ keepAlive: false });
    agent.createConnection = ((_opts: any, callback: any) => {
      const s = net.connect(port, "127.0.0.1", () => {
        s.write(preface(ip, port));
        callback(null, s);
      });
      s.on("error", reject);
      return undefined;
    }) as any;
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        agent,
        headers: {
          Host: "share.pexserver.com",
          Origin: "https://share.pexserver.com",
          "Content-Length": String(body.length),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (b) => chunks.push(b));
        res.on("end", () => {
          const bytes = Buffer.concat(chunks);
          resolve({
            status: res.statusCode!,
            headers: res.headers,
            body: bytes,
            json: () => JSON.parse(bytes.toString()),
          });
          agent.destroy();
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
test("A1 durable publication is readable before replication, survives restart, reclaims acknowledged blocks, then completes on A8 with live ACL and streamed Range downloads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fs-edge-e2e-")),
    secret = randomToken(32)
      .replace(/[^a-f0-9]/g, "a")
      .padEnd(64, "b")
      .slice(0, 64),
    secretFile = join(dir, "edge-secret");
  await writeFile(secretFile, secret);
  const oldSecret = process.env.FILESHARE_EDGE_SECRET_FILE;
  process.env.FILESHARE_EDGE_SECRET_FILE = secretFile;
  const port = 32000 + Math.floor(Math.random() * 2000),
    edgePort = 35000 + Math.floor(Math.random() * 2000),
    config = structuredClone(defaults);
  Object.assign(config, {
    port,
    origin: "https://share.pexserver.com",
    dataDir: join(dir, "a8"),
  });
  config.proxy = { enabled: true, trustedPeers: ["127.0.0.1"] };
  config.edgeSpool = {
    enabled: true,
    trustedIp: "127.0.0.1",
    path: "/edge-upload",
  };
  const app = await createApp(config);
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let lines: ReadableStreamDefaultReader<string> | null = null;
  const session = randomToken(),
    uid = randomUUID();
  async function spawn() {
    child = Bun.spawn(["python3", "tests/edge-runner.py"], {
      env: {
        ...process.env,
        FILESHARE_EDGE_SECRET_FILE: secretFile,
        FILESHARE_EDGE_DATA_DIR: join(dir, "a1"),
        FILESHARE_EDGE_PORT: String(edgePort),
        FILESHARE_EDGE_A8_HOST: "127.0.0.1",
        FILESHARE_EDGE_A1_IP: "127.0.0.1",
        FILESHARE_EDGE_A8_IP: "127.0.0.1",
        FILESHARE_EDGE_A8_PORT: String(port),
        FILESHARE_EDGE_MAX_RESERVED: "100000000",
        FILESHARE_EDGE_MIN_FREE: "0",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    lines = (child.stdout as ReadableStream<Uint8Array>)
      .pipeThrough(new TextDecoderStream())
      .getReader();
    await until("READY");
  }
  async function until(word: string) {
    for (let n = 0; n < 200; n++) {
      const next = await lines!.read();
      if (next.done) throw Error("edge runner ended");
      if (next.value.includes(word)) return;
    }
    throw Error("runner did not become ready");
  }
  const cookie = { Cookie: "fs_session=" + session };
  try {
    app.store.db.run("INSERT INTO users VALUES (?,?,?,?,?,?,?)", [
      uid,
      "edge-vip",
      1,
      "approved",
      5e9,
      "192.0.2.42",
      Date.now(),
    ]);
    app.store.db.run("INSERT INTO sessions VALUES (?,?,?)", [
      digestToken(session),
      uid,
      Date.now() + 3600000,
    ]);
    await spawn();
    const bytes = Buffer.from("durable file edge ".repeat(45000));
    const reservation = await request(
      port,
      "/api/uploads",
      "POST",
      Buffer.from(
        JSON.stringify({
          name: "edge.txt",
          size: bytes.length,
          space: "private",
          tags: ["edge"],
        }),
      ),
      { ...cookie, "Content-Type": "application/json" },
    );
    expect(reservation.status).toBe(201);
    const { id, edge } = reservation.json();
    expect(edge).toBeDefined();
    const start = await request(
      edgePort,
      edge.path + "/start",
      "POST",
      Buffer.from("{}"),
      { Authorization: "Bearer " + edge.ticket },
    );
    expect(start.status).toBe(200);
    let released = 0;
    for (let offset = 0; offset < bytes.length; offset += edge.blockBytes) {
      const chunk = bytes.subarray(
        offset,
        Math.min(bytes.length, offset + edge.blockBytes),
      );
      const r = await request(edgePort, edge.path + "/chunk", "PATCH", chunk, {
        Authorization: "Bearer " + edge.ticket,
        "Upload-Offset": String(offset),
        "Upload-Checksum": createHash("sha256").update(chunk).digest("hex"),
      });
      expect(r.status).toBe(200);
      if (offset === 0) {
        expect(
          (await readFile(join(dir, "a1", id + ".part"))).equals(chunk),
        ).toBe(true);
        (child!.stdin as any).write("step\n");
        await (child!.stdin as any).flush();
        await until("STEPPED");
        const db = new Database(join(dir, "a1", "spool.sqlite"), {
          readonly: true,
        });
        const receipt = db
          .query(
            "SELECT released_offset,reclaimed_bytes FROM edge_uploads WHERE id=?",
          )
          .get(id) as any;
        db.close();
        released = receipt.released_offset;
        expect(released).toBe(chunk.length);
        expect(receipt.reclaimed_bytes).toBeGreaterThan(0);
        expect(
          (await stat(join(dir, "a1", id + ".part"))).blocks * 512,
        ).toBeLessThan(chunk.length);
        expect(
          (await readFile(join(dir, "a1", id + ".part"))).equals(
            Buffer.alloc(chunk.length),
          ),
        ).toBe(true);
        await expect(readDurablePrefix(app.store, id, 0, 1)).rejects.toThrow(); // unpublished data has no public identity
      }
    }
    const finish = await request(
      edgePort,
      edge.path + "/finish",
      "POST",
      Buffer.from("{}"),
      { Authorization: "Bearer " + edge.ticket },
    );
    expect(finish.status).toBe(200);
    expect(app.store.item(id)?.expires_at).toBeNull();
    expect(
      (
        app.store.db
          .query("SELECT offset FROM uploads WHERE id=?")
          .get(id) as any
      ).offset,
    ).toBe(released);
    expect(app.store.usage(uid)).toEqual({ used: bytes.length, reserved: 0 });
    const redirect = await request(
      port,
      "/api/content/" + id,
      "GET",
      Buffer.alloc(0),
      cookie,
    );
    expect(redirect.status).toBe(307);
    expect(redirect.headers.connection).toBe("close");
    const location = String(redirect.headers.location);
    await expect(
      readDurablePrefix(app.store, id, released, 1),
    ).rejects.toThrow();
    expect(
      (await readDurablePrefix(app.store, id, 0, 128)).equals(
        bytes.subarray(0, 128),
      ),
    ).toBe(true);
    const crossing = await request(edgePort, location, "GET", Buffer.alloc(0), {
      Range: `bytes=${released - 32}-${released + 32}`,
    });
    expect(crossing.status).toBe(206);
    expect(
      crossing.body.equals(bytes.subarray(released - 32, released + 33)),
    ).toBe(true);
    const served = await request(edgePort, location);
    expect(served.status).toBe(200);
    expect(served.headers.connection).toBe("close");
    expect(served.body.equals(bytes)).toBe(true);
    const textRedirect = await request(
      port,
      "/api/items/" + id + "/text",
      "GET",
      Buffer.alloc(0),
      cookie,
    );
    const text = await request(edgePort, String(textRedirect.headers.location));
    expect(text.status).toBe(200);
    expect(text.json().truncated).toBe(true);
    expect(text.json().text).toBe(bytes.subarray(0, 512 * 1024).toString());
    (child!.stdin as any).write("stop\n");
    await (child!.stdin as any).flush();
    await child!.exited;
    await spawn();
    expect(
      (
        await request(edgePort, location, "GET", Buffer.alloc(0), {
          Range: "bytes=9-109",
        })
      ).body.equals(bytes.subarray(9, 110)),
    ).toBe(true);
    (child!.stdin as any).write("replicate\n");
    await (child!.stdin as any).flush();
    await until("REPLICATED");
    expect(
      app.store.db.query("SELECT 1 FROM uploads WHERE id=?").get(id),
    ).toBeNull();
    expect((await readFile(app.store.blobPath(id))).equals(bytes)).toBe(true);
    expect((await request(edgePort, location)).body.equals(bytes)).toBe(true);
    const download = await request(
      port,
      "/api/items/" + id + "/ticket",
      "POST",
      Buffer.from("{}"),
      cookie,
    );
    const downloadRedirect = await request(
      port,
      download.json().url,
      "GET",
      Buffer.alloc(0),
      cookie,
    );
    const direct = String(downloadRedirect.headers.location);
    expect((await request(edgePort, direct)).status).toBe(200);
    expect((await request(edgePort, direct)).status).toBe(200);
    // Counting is acknowledged by A8 after A1 has finished the response body.
    for (
      let attempt = 0;
      attempt < 200 && app.store.item(id)?.downloads === 0;
      attempt++
    )
      await Bun.sleep(10);
    expect(app.store.item(id)?.downloads).toBe(1);
    expect((await request(edgePort, direct, "HEAD")).body.length).toBe(0);
    expect(app.store.item(id)?.downloads).toBe(1);
    const coldBytes = Buffer.from("cold cache data ".repeat(45000));
    const coldReservation = await request(
      port,
      "/api/uploads",
      "POST",
      Buffer.from(
        JSON.stringify({
          name: "cold.txt",
          size: coldBytes.length,
          space: "private",
        }),
      ),
      { ...cookie, "Content-Type": "application/json" },
    );
    const coldId = coldReservation.json().id;
    expect(
      (
        await request(port, "/api/uploads/" + coldId, "PATCH", coldBytes, {
          ...cookie,
          "Upload-Offset": "0",
          "Upload-Checksum": createHash("sha256")
            .update(coldBytes)
            .digest("hex"),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          port,
          "/api/uploads/" + coldId + "/complete",
          "POST",
          Buffer.from("{}"),
          cookie,
        )
      ).status,
    ).toBe(200);
    const coldRedirect = await request(
        port,
        "/api/content/" + coldId,
        "GET",
        Buffer.alloc(0),
        cookie,
      ),
      coldLocation = String(coldRedirect.headers.location);
    const partial = await request(
      edgePort,
      coldLocation,
      "GET",
      Buffer.alloc(0),
      { Range: "bytes=2-1025" },
    );
    expect(partial.status).toBe(206);
    expect(partial.body.equals(coldBytes.subarray(2, 1026))).toBe(true);
    expect((await request(edgePort, coldLocation)).body.equals(coldBytes)).toBe(
      true,
    );
    // Delivery intentionally finishes before the optional cache fsync/rename.
    // Wait for cache publication rather than assuming the HTTP body is its ACK.
    let cached: Buffer | null = null;
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        cached = await readFile(join(dir, "a1", coldId + ".cache"));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await Bun.sleep(10);
    }
    expect(cached?.equals(coldBytes)).toBe(true);
    app.store.maintenanceUntil = Date.now() + 60000;
    expect((await request(edgePort, coldLocation)).status).toBe(503);
    app.store.maintenanceUntil = null;
    const empty = await request(
      port,
      "/api/uploads",
      "POST",
      Buffer.from(
        JSON.stringify({ name: "empty.txt", size: 0, space: "private" }),
      ),
      cookie,
    );
    const emptyEdge = empty.json().edge;
    expect(emptyEdge).toBeDefined();
    expect(
      (
        await request(
          edgePort,
          emptyEdge.path + "/start",
          "POST",
          Buffer.from("{}"),
          { Authorization: "Bearer " + emptyEdge.ticket },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          edgePort,
          emptyEdge.path + "/finish",
          "POST",
          Buffer.from("{}"),
          { Authorization: "Bearer " + emptyEdge.ticket },
        )
      ).status,
    ).toBe(200);
    const emptyRedirect = await request(
      port,
      "/api/content/" + empty.json().id,
      "GET",
      Buffer.alloc(0),
      cookie,
    );
    expect(
      (await request(edgePort, String(emptyRedirect.headers.location))).body
        .length,
    ).toBe(0);
    app.store.db.run("DELETE FROM sessions WHERE user_id=?", [uid]);
    expect((await request(edgePort, location)).status).toBe(403);
    expect(
      (
        await request(
          edgePort,
          location,
          "GET",
          Buffer.alloc(0),
          {},
          "192.0.2.99",
        )
      ).status,
    ).toBe(401);
  } finally {
    if (child) {
      try {
        (child.stdin as any).write("stop\n");
      } catch {}
      child.kill();
      await child.exited;
    }
    await app.close();
    if (oldSecret === undefined) delete process.env.FILESHARE_EDGE_SECRET_FILE;
    else process.env.FILESHARE_EDGE_SECRET_FILE = oldSecret;
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
