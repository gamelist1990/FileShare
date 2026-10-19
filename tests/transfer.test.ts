import { test, expect } from "bun:test";
import { prepareChunk, nextChunk } from "../src/React/transfer";
import { acceptsGzip, compressibleName } from "../src/shared/compression";
import { gzipSync, gunzipSync } from "node:zlib";
import { randomBytes, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { defaults } from "../src/server/config";
import { UPLOAD_RESERVATION_MS } from "../src/server/storage";
import { digestToken, randomToken } from "@pexserver/secure-envelope";

test("adaptive chunks account for latency without unbounded buffers or growth on failure", () => {
  const current = 1048576;
  expect(nextChunk(current, current, 3000, false, 600)).toBeGreaterThan(
    nextChunk(current, current, 3000),
  );
  expect(nextChunk(current, current, 10, false, 600)).toBeLessThanOrEqual(
    current * 2,
  );
  expect(nextChunk(8 * current, 8 * current, 10, false, 600)).toBe(8 * current);
  expect(nextChunk(current, current, 10, true, 600)).toBe(current / 2);
  expect(nextChunk(256 * 1024, 0, 0, true)).toBe(256 * 1024);
  expect(acceptsGzip("br, gzip;q=0, *;q=1")).toBe(false);
  expect(acceptsGzip("gzip;q=0.8")).toBe(true);
  expect(acceptsGzip("gzip;q=garbage")).toBe(false);
  for (const name of ["video.mp4", "data.zip", "photo.jpg"])
    expect(compressibleName(name)).toBe(false);
});

test("upload preparation compresses text, preserves original checksum and skips random bytes", async () => {
  const original = Buffer.from(
    "FileShare transfer verification\n".repeat(10000),
  );
  const prepared = await prepareChunk(new Blob([original]), true);
  expect(prepared.compressed).toBe(true);
  expect(gunzipSync(Buffer.from(prepared.body))).toEqual(original);
  expect(prepared.checksum).toBe(
    createHash("sha256").update(original).digest("hex"),
  );
  expect(prepared.body.byteLength).toBeLessThan(original.length / 10);
  const random = randomBytes(65536),
    uncompressed = await prepareChunk(new Blob([random]), true);
  expect(uncompressed.compressed).toBe(false);
  expect(Buffer.from(uncompressed.body)).toEqual(random);
});

test("compressed uploads, ACLs, bombs, integrity, resumable offsets and encoded downloads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fileshare-compression-")),
    config = structuredClone(defaults);
  config.port = 48000 + Math.floor(Math.random() * 3000);
  config.origin = `http://127.0.0.1:${config.port}`;
  config.dataDir = dir;
  const app = await createApp(config),
    token = randomToken();
  app.store.db.run("INSERT INTO users VALUES (?,?,?,?,?,?,?)", [
    "compression-admin",
    "compression-admin",
    4,
    "approved",
    5e9,
    "192.0.2.1",
    Date.now(),
  ]);
  app.store.db.run("INSERT INTO sessions VALUES (?,?,?)", [
    digestToken(token),
    "compression-admin",
    Date.now() + 3600000,
  ]);
  const headers = { Origin: config.origin, Cookie: `fs_session=${token}` };
  async function call(
    path: string,
    method = "GET",
    body?: unknown,
    extra = {},
  ) {
    return fetch(config.origin + path, {
      method,
      headers: {
        ...headers,
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...extra,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }
  const content = Buffer.from(
    "const message = 'FileShare compression and download verification';\n".repeat(
      10000,
    ),
  );
  try {
    const { id } = (await (
      await call("/api/uploads", "POST", {
        name: "proof.ts",
        size: content.length,
        space: "private",
      })
    ).json()) as any;
    const uploadExpiry = app.store.db
      .query("SELECT expires FROM uploads WHERE id=?")
      .get(id) as { expires: number };
    expect(uploadExpiry.expires - Date.now()).toBeGreaterThan(
      UPLOAD_RESERVATION_MS - 5000,
    );
    expect(uploadExpiry.expires - Date.now()).toBeLessThanOrEqual(
      UPLOAD_RESERVATION_MS,
    );
    const chunk = (
      body: Buffer,
      offset = 0,
      checksum = createHash("sha256").update(content).digest("hex"),
      auth = headers,
      encoding = "gzip",
    ) =>
      fetch(config.origin + "/api/uploads/" + id, {
        method: "PATCH",
        headers: {
          ...auth,
          "Content-Type": "application/octet-stream",
          "Upload-Offset": String(offset),
          "Upload-Checksum": checksum,
          "Upload-Encoding": encoding,
        },
        body,
      });
    expect(
      (
        await chunk(gzipSync(content), 0, undefined, {
          Origin: config.origin,
        } as any)
      ).status,
    ).toBe(401);
    expect((await chunk(Buffer.from("invalid gzip"))).status).toBe(400);
    expect(
      (await chunk(gzipSync(Buffer.alloc(8 * 1024 * 1024 + 1)))).status,
    ).toBe(413);
    expect((await chunk(gzipSync(content), 0, "0".repeat(64))).status).toBe(
      400,
    );
    expect(
      (await chunk(gzipSync(content), 0, undefined, headers, "br")).status,
    ).toBe(400);
    expect(
      ((await (await call("/api/uploads/" + id)).json()) as any).offset,
    ).toBe(0);
    const middle = Math.floor(content.length / 2);
    const first = content.subarray(0, middle),
      last = content.subarray(middle);
    expect(
      (
        await chunk(
          gzipSync(first),
          0,
          createHash("sha256").update(first).digest("hex"),
        )
      ).status,
    ).toBe(200);
    expect(
      ((await (await call("/api/uploads/" + id)).json()) as any).offset,
    ).toBe(middle);
    expect(
      (
        await chunk(
          gzipSync(last),
          middle,
          createHash("sha256").update(last).digest("hex"),
        )
      ).status,
    ).toBe(200);
    expect(
      (await call("/api/uploads/" + id + "/complete", "POST", {})).status,
    ).toBe(200);
    const item = app.store.db
      .query("SELECT id FROM items WHERE name='proof.ts'")
      .get() as { id: string };
    const ticket = (await (
      await call("/api/items/" + item.id + "/ticket", "POST", {})
    ).json()) as any;
    const full = await call(ticket.url, "GET", undefined, {
      "Accept-Encoding": "gzip",
    });
    expect(full.headers.get("Content-Encoding")).toBe("gzip");
    expect(Buffer.from(await full.arrayBuffer())).toEqual(content);
    const range = await call(ticket.url, "GET", undefined, {
      "Accept-Encoding": "gzip",
      Range: "bytes=50-299",
    });
    expect(range.status).toBe(206);
    expect(range.headers.get("Content-Encoding")).toBeNull();
    expect(Buffer.from(await range.arrayBuffer())).toEqual(
      content.subarray(50, 300),
    );
    const identity = await call(ticket.url, "GET", undefined, {
      "Accept-Encoding": "gzip;q=0",
    });
    expect(identity.headers.get("Content-Encoding")).toBeNull();
    expect(Buffer.from(await identity.arrayBuffer())).toEqual(content);
    const large = Buffer.alloc(9 * 1024 * 1024, 65);
    const big = (await (
      await call("/api/uploads", "POST", {
        name: "large.log",
        size: large.length,
        space: "private",
      })
    ).json()) as any;
    for (let offset = 0; offset < large.length; offset += 8 * 1024 * 1024) {
      const part = large.subarray(offset, offset + 8 * 1024 * 1024);
      const response = await fetch(config.origin + "/api/uploads/" + big.id, {
        method: "PATCH",
        headers: {
          ...headers,
          "Upload-Offset": String(offset),
          "Upload-Checksum": createHash("sha256").update(part).digest("hex"),
          "Upload-Encoding": "gzip",
        },
        body: gzipSync(part),
      });
      expect(response.status).toBe(200);
    }
    expect(
      (await call("/api/uploads/" + big.id + "/complete", "POST", {})).status,
    ).toBe(200);
    const bigItem = app.store.db
      .query("SELECT id FROM items WHERE name='large.log'")
      .get() as { id: string };
    const bigTicket = (await (
      await call("/api/items/" + bigItem.id + "/ticket", "POST", {})
    ).json()) as any;
    const bigHead = await call(bigTicket.url, "HEAD", undefined, {
      "Accept-Encoding": "gzip",
    });
    expect(bigHead.headers.get("Content-Encoding")).toBeNull();
    expect(bigHead.headers.get("Accept-Ranges")).toBe("bytes");
    expect(bigHead.headers.get("Content-Length")).toBe(String(large.length));
    const bigRange = await call(bigTicket.url, "GET", undefined, {
      "Accept-Encoding": "gzip",
      Range: "bytes=-1024",
    });
    expect(bigRange.status).toBe(206);
    expect(Buffer.from(await bigRange.arrayBuffer())).toEqual(
      large.subarray(-1024),
    );
    const unauthorized = await fetch(config.origin + ticket.url, {
      headers: { "Accept-Encoding": "gzip" },
    });
    expect(unauthorized.status).toBe(403);
    const asset = await call("/index.js", "GET", undefined, {
      "Accept-Encoding": "gzip",
    });
    expect(asset.headers.get("Content-Encoding")).toBe("gzip");
    expect((await asset.text()).length).toBeGreaterThan(1000);
  } finally {
    app.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 15000);
