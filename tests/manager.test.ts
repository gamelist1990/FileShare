import { test, expect } from "bun:test";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { randomToken, digestToken } from "@pexserver/secure-envelope";
import { createApp } from "../src/server/app";
import { defaults } from "../src/server/config";
import { Store } from "../src/server/store";
test("personal quotas, unlimited membership, public tags, atomic moves, drive mapping and encrypted compatible AI settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fs-manager-")),
    cfg = structuredClone(defaults);
  cfg.port = 40000 + Math.floor(Math.random() * 10000);
  cfg.origin = `http://127.0.0.1:${cfg.port}`;
  cfg.dataDir = join(dir, "data");
  cfg.capacityBytes = 100e6;
  cfg.vipQuotaBytes = 5e6;
  cfg.preview.cacheBytes = 1e6;
  const app = await createApp(cfg),
    cookies: Record<string, string> = {};
  let modelServer: ReturnType<typeof Bun.serve> | null = null;
  const req = (path: string, user = "admin", method = "GET", body?: any) =>
    fetch(cfg.origin + path, {
      method,
      headers: {
        Origin: cfg.origin,
        ...(cookies[user] ? { Cookie: cookies[user] } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  async function json(p: string, u = "admin", m = "GET", b?: any) {
    const r = await req(p, u, m, b);
    const d = await r.json();
    if (!r.ok) throw Error(r.status + ":" + JSON.stringify(d));
    return d;
  }
  async function upload(name: string, user = "admin", data: any = {}) {
    const content = Buffer.from("test file " + name);
    const r = await json("/api/uploads", user, "POST", {
      name,
      size: content.length,
      space: "private",
      ...data,
    });
    const patched = await fetch(cfg.origin + "/api/uploads/" + r.id, {
      method: "PATCH",
      headers: {
        Origin: cfg.origin,
        Cookie: cookies[user],
        "Upload-Offset": "0",
        "Upload-Checksum": createHash("sha256").update(content).digest("hex"),
      },
      body: content,
    });
    expect(patched.status).toBe(200);
    await json("/api/uploads/" + r.id + "/complete", user, "POST", {});
    return r.id;
  }
  try {
    for (const [name, level] of [
      ["admin", 4],
      ["vip", 1],
      ["staff", 3],
      ["general", 0],
      ["other", 1],
    ] as const) {
      const token = randomToken();
      app.store.db.run("INSERT INTO users VALUES (?,?,?,?,?,?,?)", [
        name,
        name,
        level,
        "approved",
        5e6,
        "192.0.2.1",
        Date.now(),
      ]);
      app.store.db.run("INSERT INTO sessions VALUES (?,?,?)", [
        digestToken(token),
        name,
        Date.now() + 3600000,
      ]);
      cookies[name] = "fs_session=" + token;
    }
    app.store.registrationPolicy.generalUploads = true;
    app.store.registrationPolicy.vipSharedUploads = true;
    expect((await json("/api/items?space=private")).capacity).toBe(5e6);
    expect(
      (
        await req("/api/uploads", "admin", "POST", {
          name: "too big",
          size: 6e6,
          space: "private",
        })
      ).status,
    ).toBe(507);
    for (const user of ["admin", "vip", "staff"]) {
      const id = await upload(user + ".txt", user);
      expect(app.store.item(id)?.expires_at).toBeNull();
    }
    expect(
      (
        await req("/api/uploads", "general", "POST", {
          name: "bad",
          size: 1,
          retentionSeconds: 0,
        })
      ).status,
    ).toBe(400);
    const publicId = await upload("resourcepack.txt", "staff", {
      space: "shared",
      retentionSeconds: 0,
      tags: ["Minecraft", "pack"],
    });
    expect(app.store.item(publicId)?.expires_at).toBeNull();
    expect(
      (await json("/api/search?tag=minecraft", "")).items.map((i: any) => i.id),
    ).toEqual([publicId]);
    const privateId = await upload("private.txt", "vip", {
      tags: ["Minecraft"],
    });
    expect(
      (await json("/api/search?tag=minecraft", "admin")).items.map(
        (i: any) => i.id,
      ),
    ).not.toContain(privateId);
    const folder = await json("/api/folders", "staff", "POST", {
      name: "destination",
      space: "shared",
    });
    expect(
      (
        await req("/api/items/move", "staff", "POST", {
          ids: [publicId, privateId],
          parent: folder.id,
        })
      ).status,
    ).toBe(404);
    expect(app.store.item(publicId)?.parent).toBeNull();
    expect(
      (
        await req("/api/items/move", "staff", "POST", {
          ids: [publicId],
          parent: folder.id,
        })
      ).status,
    ).toBe(200);
    expect(app.store.item(publicId)?.parent).toBe(folder.id);
    expect(
      (
        await req("/api/items/move", "staff", "POST", {
          ids: [folder.id],
          parent: folder.id,
        })
      ).status,
    ).toBe(400);
    const volumeRoot = join(dir, "drive");
    await mkdir(volumeRoot);
    expect((await req("/api/admin/storage/volumes", "staff")).status).toBe(403);
    const vol = await json("/api/admin/storage/volumes", "admin", "POST", {
      label: "External drive",
      path: volumeRoot,
      capacityBytes: 10e6,
    });
    const mapped = await upload("mapped.txt");
    expect(app.store.blobPath(mapped)).toBe(
      join(volumeRoot, "pex-fileshare-blobs", mapped),
    );
    expect(await readFile(app.store.blobPath(mapped), "utf8")).toBe(
      "test file mapped.txt",
    );
    expect(existsSync(join(app.store.blobDir, mapped))).toBe(false);
    await json("/api/admin/storage/volumes", "admin", "PATCH", {
      id: vol.id,
      enabled: false,
    });
    const fallback = await upload("default.txt");
    expect(app.store.blobPath(fallback)).toBe(
      join(app.store.blobDir, fallback),
    );
    expect(
      (await json("/api/admin/users?q=vip&level=1")).users.map(
        (u: any) => u.name,
      ),
    ).toEqual(["vip"]);
    expect((await req("/api/admin/users?level=9")).status).toBe(400);
    let authorization = "";
    modelServer = Bun.serve({
      port: 0,
      fetch(r) {
        authorization = r.headers.get("authorization") ?? "";
        return Response.json({
          data: [{ id: "test-model" }, { id: "second-model" }],
        });
      },
    });
    const endpoint = `http://127.0.0.1:${modelServer.port}/v1`,
      apiKey = "fixture-api-key-keep-private";
    const modelResult = await json("/api/admin/ai/models", "admin", "POST", {
      endpoint,
      apiKey,
    });
    expect(modelResult.models).toEqual(["test-model", "second-model"]);
    expect(authorization).toBe("Bearer " + apiKey);
    await json("/api/admin/settings", "admin", "PATCH", {
      ai: {
        enabled: false,
        endpoint,
        model: "test-model",
        intervalSeconds: 60,
        apiKey,
      },
    });
    expect(app.store.aiKey).toBe(apiKey);
    expect(
      (
        app.store.db
          .query("SELECT value FROM admin_settings WHERE key='ai-key'")
          .get() as any
      ).value,
    ).not.toContain(apiKey);
    const settings = await json("/api/admin/settings");
    expect(settings.ai.keyConfigured).toBe(true);
    expect(JSON.stringify(settings)).not.toContain(apiKey);
    expect(
      (await req("/api/admin/ai/models", "staff", "POST", { endpoint })).status,
    ).toBe(403);
    expect(
      (
        await req("/api/admin/settings", "admin", "PATCH", {
          ai: {
            enabled: false,
            endpoint: "http://169.254.169.254",
            model: "x",
            intervalSeconds: 60,
          },
        })
      ).status,
    ).toBe(400);
    const reopenCfg = structuredClone(defaults);
    reopenCfg.dataDir = cfg.dataDir;
    reopenCfg.capacityBytes = 100e6;
    const reopened = new Store(reopenCfg);
    expect(reopened.aiKey).toBe(apiKey);
    expect(reopenCfg.capacityBytes).toBe(110e6);
    expect(reopened.blobPath(mapped)).toBe(app.store.blobPath(mapped));
    reopened.db.close();
  } finally {
    modelServer?.stop(true);
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
