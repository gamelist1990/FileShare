import { beforeAll, afterAll, test, expect } from "bun:test";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { digestToken, randomToken } from "@pexserver/secure-envelope";
import { createApp } from "../src/server/app";
import { defaults } from "../src/server/config";
import { cleanup } from "../src/server/storage";
import { Store } from "../src/server/store";
let app: Awaited<ReturnType<typeof createApp>>, dir: string, origin: string;
const cookies: Record<string, string> = {};
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "fileshare-records-"));
  const config = structuredClone(defaults);
  config.port = 54000 + Math.floor(Math.random() * 4000);
  origin = `http://127.0.0.1:${config.port}`;
  config.origin = origin;
  config.dataDir = dir;
  app = await createApp(config);
  for (const [name, level] of [
    ["admin", 4],
    ["staff", 3],
    ["vip", 1],
  ] as const) {
    app.store.db.run("INSERT INTO users VALUES (?,?,?,?,?,?,?)", [
      name,
      name,
      level,
      "approved",
      5e9,
      "192.0.2.1",
      Date.now(),
    ]);
    const token = randomToken();
    cookies[name] = "fs_session=" + token;
    app.store.db.run("INSERT INTO sessions VALUES (?,?,?)", [
      digestToken(token),
      name,
      Date.now() + 3600000,
    ]);
  }
});
afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});
function request(
  path: string,
  method = "GET",
  body?: unknown,
  user = "admin",
  headers: Record<string, string> = {},
) {
  return fetch(origin + path, {
    method,
    headers: {
      Origin: origin,
      Cookie: cookies[user] ?? "",
      "Content-Type": "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function create(name: string, user = "staff", extra = {}) {
  const bytes = Buffer.from("sample-data");
  const r = await request(
    "/api/uploads",
    "POST",
    {
      name,
      size: bytes.length,
      space: user === "vip" ? "private" : "shared",
      retentionSeconds: 60,
      ...extra,
    },
    user,
  );
  expect(r.status).toBe(201);
  const { id } = await r.json();
  expect(
    (
      await fetch(origin + "/api/uploads/" + id, {
        method: "PATCH",
        headers: {
          Origin: origin,
          Cookie: cookies[user],
          "Upload-Offset": "0",
          "Upload-Checksum": createHash("sha256").update(bytes).digest("hex"),
        },
        body: bytes,
      })
    ).status,
  ).toBe(200);
  const done = await request(`/api/uploads/${id}/complete`, "POST", {}, user);
  expect(done.status).toBe(200);
  return await done.json();
}
test("downloads count once per successful link, exclude HEAD/preview/errors, and retain the uploader", async () => {
  const item = await create("counter.ts");
  expect(item.uploader_name).toBe("staff");
  expect(item.uploaded_by).toBeUndefined();
  expect(item.expires_at - item.created).toBeGreaterThanOrEqual(59000);
  const ticket = await (
    await request(`/api/items/${item.id}/ticket`, "POST", {}, "")
  ).json();
  await (
    await request(`/api/content/${item.id}`, "GET", undefined, "")
  ).arrayBuffer();
  await (await request(ticket.url, "HEAD", undefined, "")).arrayBuffer();
  expect(app.store.item(item.id)!.downloads).toBe(0);
  expect(
    (await request(ticket.url, "GET", undefined, "", { Range: "bytes=999-" }))
      .status,
  ).toBe(416);
  expect(app.store.item(item.id)!.downloads).toBe(0);
  await (
    await request(ticket.url, "GET", undefined, "", { Range: "bytes=0-2" })
  ).arrayBuffer();
  await (await request(ticket.url, "GET", undefined, "")).arrayBuffer();
  expect(app.store.item(item.id)!.downloads).toBe(1);
  const second = await (
    await request(`/api/items/${item.id}/ticket`, "POST", {}, "")
  ).json();
  await (await request(second.url, "GET", undefined, "")).arrayBuffer();
  for (
    let attempt = 0;
    attempt < 50 && app.store.item(item.id)!.downloads !== 2;
    attempt++
  )
    await Bun.sleep(10);
  expect(app.store.item(item.id)!.downloads).toBe(2);
  const adminFiles = await (await request("/api/admin/files")).json();
  expect(adminFiles.items.find((f: any) => f.id === item.id).uploaded_by).toBe(
    "staff",
  );
  const policy = { ...app.store.filePolicy, trackDownloads: false };
  await request("/api/admin/settings", "PATCH", { files: policy });
  const disabled = await (
    await request(`/api/items/${item.id}/ticket`, "POST", {}, "")
  ).json();
  await (await request(disabled.url, "GET", undefined, "")).arrayBuffer();
  expect(app.store.item(item.id)!.downloads).toBe(2);
  await request("/api/admin/settings", "PATCH", {
    files: { ...policy, trackDownloads: true },
  });
});
test("public rankings and metadata honor ACLs and administrator visibility switches", async () => {
  const privateFile = await create("private.mp4", "vip");
  const folder = await (
    await request(
      "/api/folders",
      "POST",
      { name: "hidden parent", space: "private" },
      "vip",
    )
  ).json();
  const child = await create("hidden-child.ts", "vip", { parent: folder.id });
  await request(
    `/api/items/${child.id}`,
    "PATCH",
    { visibility: "public" },
    "vip",
  );
  const result = await (
    await request("/api/rankings", "GET", undefined, "")
  ).json();
  expect(
    result.items.some((f: any) => [privateFile.id, child.id].includes(f.id)),
  ).toBe(false);
  const admin = await (await request("/api/admin/rankings")).json();
  expect(admin.items.some((f: any) => f.id === privateFile.id)).toBe(true);
  for (const path of ["/api/admin/files", "/api/admin/rankings"]) {
    expect((await request(path, "GET", undefined, "staff")).status).toBe(403);
  }
  const policy = { ...app.store.filePolicy };
  await request("/api/admin/settings", "PATCH", {
    files: {
      ...policy,
      showDownloadCounts: false,
      showUploaders: false,
      rankingEnabled: false,
    },
  });
  expect(
    (await (await request("/api/rankings", "GET", undefined, "")).json()).items,
  ).toEqual([]);
  const visible = await (
    await request("/api/items", "GET", undefined, "")
  ).json();
  expect(
    visible.items.every(
      (f: any) => f.downloads === null && f.uploader_name === null,
    ),
  ).toBe(true);
  await request("/api/admin/settings", "PATCH", { files: policy });
});
test("file size and per-file retention are enforced at initialization, resume and metadata changes", async () => {
  const initial = { ...app.store.filePolicy };
  expect(
    (
      await request("/api/admin/settings", "PATCH", {
        files: { ...initial, maxRetentionSeconds: 59 },
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await request(
        "/api/uploads",
        "POST",
        { name: "bad.bin", size: 1, retentionSeconds: 59 },
        "staff",
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await request(
        "/api/uploads",
        "POST",
        {
          name: "long.bin",
          size: 1,
          retentionSeconds: initial.maxRetentionSeconds + 1,
        },
        "staff",
      )
    ).status,
  ).toBe(400);
  const upload = await (
    await request(
      "/api/uploads",
      "POST",
      { name: "reserved.bin", size: 20 },
      "staff",
    )
  ).json();
  expect(
    (
      await request("/api/admin/settings", "PATCH", {
        files: { ...initial, maxFileBytes: 10 },
      })
    ).status,
  ).toBe(200);
  expect(
    (await request("/api/uploads/" + upload.id, "GET", undefined, "staff"))
      .status,
  ).toBe(413);
  expect(
    (
      await request(
        "/api/uploads",
        "POST",
        { name: "too-big.bin", size: 11 },
        "admin",
      )
    ).status,
  ).toBe(413);
  await request("/api/admin/settings", "PATCH", { files: initial });
  const file = await create("retention.txt");
  expect(
    (
      await request(
        `/api/items/${file.id}`,
        "PATCH",
        { retentionSeconds: 120 },
        "staff",
      )
    ).status,
  ).toBe(200);
  expect(app.store.item(file.id)!.expires_at! - file.created).toBe(120000);
  expect(
    (
      await request(`/api/admin/files/${file.id}`, "PATCH", {
        downloads: 12,
        uploadedBy: "vip",
        retentionSeconds: 180,
      })
    ).status,
  ).toBe(200);
  expect(app.store.item(file.id)!.downloads).toBe(12);
  expect(app.store.item(file.id)!.uploader_name).toBe("vip");
  expect(
    (
      await request(
        `/api/admin/files/${file.id}`,
        "PATCH",
        { downloads: 0 },
        "staff",
      )
    ).status,
  ).toBe(403);
  const config = structuredClone(defaults);
  config.dataDir = dir;
  const reopened = new Store(config);
  try {
    expect(reopened.filePolicy.maxFileBytes).toBe(initial.maxFileBytes);
  } finally {
    reopened.db.close();
  }
});
test("expiry blocks direct access and tickets immediately, then cleanup frees storage and prevents restore", async () => {
  const file = await create("expires.txt"),
    ticket = await (
      await request(`/api/items/${file.id}/ticket`, "POST", {}, "")
    ).json();
  const before = app.store.usage().used;
  app.store.db.run("UPDATE item_meta SET expires_at=? WHERE item_id=?", [
    Date.now() - 1,
    file.id,
  ]);
  expect(
    (await request(`/api/items/${file.id}`, "GET", undefined, "")).status,
  ).toBe(404);
  expect(
    (await request(`/api/content/${file.id}`, "GET", undefined, "")).status,
  ).toBe(404);
  expect((await request(ticket.url, "GET", undefined, "")).status).toBe(404);
  expect((await cleanup(app.store)).expired).toBe(1);
  expect(app.store.usage().used).toBe(before - file.size);
  expect(
    await access(join(app.store.blobDir, file.id)).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
  expect(
    (
      await request("/api/admin/maintenance", "POST", {
        action: "restore",
        ids: [file.id],
      })
    ).status,
  ).toBe(409);
});
