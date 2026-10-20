import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { defaults } from "../src/server/config";
import { verifyDirectUploadTicket } from "../src/server/edge-auth";
import { randomToken, digestToken } from "@pexserver/secure-envelope";

test("WebRTC signaling is authenticated, scoped, localhost-only and returns no secret to browser", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fileshare-rtc-signaling-"));
  const key = "3".repeat(64);
  const file = join(dir, "secret");
  await writeFile(file, key);
  const previous = process.env.FILESHARE_EDGE_SECRET_FILE;
  process.env.FILESHARE_EDGE_SECRET_FILE = file;
  let body: any = null;
  const worker = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      body = await req.json();
      return new Response(JSON.stringify({ answer: { type: "answer", sdp: "valid-test-answer" } }), {
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const config = structuredClone(defaults);
  config.port = 36000 + Math.floor(Math.random() * 800);
  config.origin = "http://127.0.0.1:" + config.port;
  config.dataDir = join(dir, "storage");
  config.edgeSpool = { enabled: true, trustedIp: "127.0.0.1", path: "/edge-upload" };
  config.webrtc = { enabled: true, signalPort: worker.port };
  const app = await createApp(config);
  const session = randomToken();
  app.store.db.run("INSERT INTO users VALUES (?,?,?,?,?,?,?)", [
    "rtc-owner", "rtc-owner", 1, "approved", 10e9, "192.0.2.1", Date.now(),
  ]);
  app.store.db.run("INSERT INTO sessions VALUES (?,?,?)", [
    digestToken(session), "rtc-owner", Date.now() + 3600000,
  ]);
  const call = (path: string, data: any, cookie = "fs_session=" + session) =>
    fetch(config.origin + path, {
      method: "POST",
      headers: { Origin: config.origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  try {
    const created = await call("/api/uploads", { name: "rtc.bin", size: 4 * 1024 * 1024, space: "private" });
    expect(created.status).toBe(201);
    const upload = await created.json();
    expect(upload.edge.webrtc).toBe(true);
    const path = "/api/uploads/" + upload.id + "/webrtc/offer";
    const guest = await call(path, { offer: { type: "offer", sdp: "a".repeat(150) } }, "");
    expect(guest.status).toBeGreaterThanOrEqual(400);
    const signal = await call(path, { offer: { type: "offer", sdp: "a".repeat(150) } });
    expect(signal.status).toBe(200);
    const result = await signal.json();
    expect(result.answer.type).toBe("answer");
    expect(result.ticket).toBeUndefined();
    expect(body.id).toBe(upload.id);
    expect(body.clientIp).toBe("127.0.0.1");
    const token = verifyDirectUploadTicket(key, body.ticket);
    expect(token?.id).toBe(upload.id);
    expect(token?.userId).toBe("rtc-owner");
    expect(token?.session).toBe(digestToken(session));
    app.store.db.run("DELETE FROM sessions WHERE hash=?", [digestToken(session)]);
    const revoked = await call(path, { offer: { type: "offer", sdp: "a".repeat(150) } });
    expect(revoked.status).toBeGreaterThanOrEqual(400);
  } finally {
    worker.stop(true);
    await app.close();
    if (previous === undefined) delete process.env.FILESHARE_EDGE_SECRET_FILE;
    else process.env.FILESHARE_EDGE_SECRET_FILE = previous;
    await rm(dir, { recursive: true, force: true });
  }
}, 15000);
