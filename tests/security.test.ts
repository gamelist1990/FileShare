import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { defaults } from "../src/server/config";
import { createApp } from "../src/server/app";
import { digestToken, randomToken } from "@pexserver/secure-envelope";
import { canRead, canWrite, validName } from "../src/server/policy";
import { byteRange } from "../src/server/storage";
import { nextChunk } from "../src/React/transfer";
let app: Awaited<ReturnType<typeof createApp>>, dir: string, origin: string;
const cookies: Record<string, string> = {},
  ids: Record<string, string> = {};
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "fileshare-test-"));
  const port = 23000 + Math.floor(Math.random() * 10000);
  origin = "http://127.0.0.1:" + port;
  app = await createApp({
    ...structuredClone(defaults),
    port,
    origin,
    dataDir: dir,
    capacityBytes: 100_000_000,
    vipQuotaBytes: 10_000_000,
    preview: { ...defaults.preview, cacheBytes: 1_000_000 },
  });
  for (const [name, level] of Object.entries({
    general: 0,
    vip: 1,
    invite: 2,
    staff: 3,
    admin: 4,
    other: 1,
  })) {
    const id = randomUUID(),
      token = randomToken();
    ids[name] = id;
    cookies[name] = "fs_session=" + token;
    app.store.db.run("INSERT INTO users VALUES (?,?,?,?,?,?,?)", [
      id,
      name,
      level,
      "approved",
      10_000_000,
      "192.0.2." + level,
      Date.now(),
    ]);
    app.store.db.run("INSERT INTO sessions VALUES (?,?,?)", [
      digestToken(token),
      id,
      Date.now() + 3600000,
    ]);
  }
});
afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});
async function request(
  path: string,
  user = "",
  method = "GET",
  body?: unknown,
  extra: Record<string, string> = {},
) {
  return fetch(origin + path, {
    method,
    headers: {
      Origin: origin,
      ...(user ? { Cookie: cookies[user] } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...extra,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
async function json(path: string, user = "", method = "GET", body?: unknown) {
  const r = await request(path, user, method, body);
  const data = (await r.json()) as any;
  if (!r.ok) throw new Error(r.status + ":" + JSON.stringify(data));
  return data;
}
let privateId = "",
  publicId = "",
  sharedId = "";
test("admin pages and endpoints require Level 4; forged forwarding headers do not grant access", async () => {
  for (const user of ["", "general", "vip", "invite", "staff"]) {
    expect((await request("/api/admin/overview", user)).status).toBe(
      user ? 403 : 401,
    );
    expect((await request("/admin", user)).status).toBe(user ? 403 : 401);
  }
  expect((await request("/api/admin/overview", "admin")).status).toBe(200);
  expect(
    (
      await request("/api/admin/overview", "", "GET", undefined, {
        "X-Forwarded-For": "127.0.0.1",
        "X-Proxy-Protocol-V2": "anything",
      })
    ).status,
  ).toBe(401);
});
test("origin and host restrictions, and no legacy password routes", async () => {
  expect(
    (
      await request(
        "/api/auth/login/options",
        "",
        "POST",
        {},
        { Origin: "https://evil.example" },
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await request(
        "/api/auth/login/options",
        "",
        "POST",
        {},
        { Host: "evil.example" },
      )
    ).status,
  ).toBe(421);
  expect(
    (
      await request("/api/auth/login", "", "POST", {
        username: "admin",
        password: "password",
      })
    ).status,
  ).toBe(404);
});
test("private spaces are isolated including from staff; shared mutations require staff", async () => {
  privateId = (
    await json("/api/folders", "vip", "POST", {
      name: "Private",
      space: "private",
    })
  ).id;
  sharedId = (await json("/api/folders", "staff", "POST", { name: "Shared" }))
    .id;
  expect(
    (await request("/api/folders", "general", "POST", { name: "bad" })).status,
  ).toBe(403);
  expect(
    (await request("/api/folders", "vip", "POST", { name: "bad" })).status,
  ).toBe(403);
  for (const u of ["", "other", "staff"])
    expect((await request("/api/items/" + privateId, u)).status).toBe(404);
  expect((await request("/api/items/" + privateId, "admin")).status).toBe(200);
  expect((await request("/api/items?space=private", "other")).status).toBe(200);
});
test("public children cannot bypass a private parent; invite requires key and Level 2", async () => {
  const child = await json("/api/folders", "vip", "POST", {
    name: "Child",
    parent: privateId,
  });
  publicId = child.id;
  await json("/api/items/" + child.id, "vip", "PATCH", {
    visibility: "public",
  });
  expect((await request("/api/items/" + child.id)).status).toBe(404);
  await json("/api/items/" + privateId, "vip", "PATCH", {
    visibility: "public",
  });
  expect((await request("/api/items/" + child.id)).status).toBe(200);
  const result = await json("/api/items/" + child.id, "vip", "PATCH", {
    visibility: "invite",
  });
  expect(result.key.length).toBe(43);
  expect(
    (
      await request("/api/items/" + child.id + "/unlock", "vip", "POST", {
        key: result.key,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await request("/api/items/" + child.id + "/unlock", "invite", "POST", {
        key: "bad",
      })
    ).status,
  ).toBe(403);
  await json("/api/items/" + child.id + "/unlock", "invite", "POST", {
    key: result.key,
  });
  expect((await request("/api/items/" + child.id, "invite")).status).toBe(200);
  const rotated = await json("/api/items/" + child.id, "vip", "PATCH", {
    rotateKey: true,
  });
  expect(rotated.key).not.toBe(result.key);
  expect((await request("/api/items/" + child.id, "invite")).status).toBe(404);
  const list = await json("/api/items?space=private", "vip");
  expect(JSON.stringify(list)).not.toContain("key_hash");
});
test("quota reservations remain atomic under parallel requests", async () => {
  const results = await Promise.all(
    [1, 2].map((n) =>
      request("/api/uploads", "other", "POST", {
        name: "large" + n,
        size: 6_000_000,
        space: "private",
      }),
    ),
  );
  expect(results.map((r) => r.status).sort()).toEqual([201, 507]);
  const row = app.store.db
    .query("SELECT id FROM uploads WHERE user_id=?")
    .get(ids.other) as any;
  expect(app.store.usage(ids.other).reserved).toBe(6_000_000);
  await json("/api/uploads/" + row.id, "other", "DELETE");
  expect(app.store.usage(ids.other).reserved).toBe(0);
});
test("checksummed resumable chunks, cross-user denial, ranged download, encrypted ticket", async () => {
  const u = await json("/api/uploads", "vip", "POST", {
    name: "example.txt",
    size: 11,
    space: "private",
  });
  expect((await request("/api/uploads/" + u.id, "other")).status).toBe(404);
  const chunk = async (offset: number, text: string, checksum?: string) =>
    fetch(origin + "/api/uploads/" + u.id, {
      method: "PATCH",
      headers: {
        Origin: origin,
        Cookie: cookies.vip,
        "Upload-Offset": String(offset),
        "Upload-Checksum":
          checksum ?? createHash("sha256").update(text).digest("hex"),
      },
      body: text,
    });
  expect((await chunk(0, "hello ", "bad")).status).toBe(400);
  expect((await json("/api/uploads/" + u.id, "vip")).offset).toBe(0);
  expect((await chunk(0, "hello ")).status).toBe(200);
  expect((await chunk(0, "hello ")).status).toBe(409);
  expect((await json("/api/uploads/" + u.id, "vip")).offset).toBe(6);
  expect((await chunk(6, "world")).status).toBe(200);
  await json("/api/uploads/" + u.id + "/complete", "vip", "POST", {});
  expect(await readFile(join(dir, "blobs", u.id), "utf8")).toBe("hello world");
  expect((await request("/api/content/" + u.id, "staff")).status).toBe(404);
  const range = await request("/api/content/" + u.id, "vip", "GET", undefined, {
    Range: "bytes=6-",
  });
  expect(range.status).toBe(206);
  expect(await range.text()).toBe("world");
  expect(
    (
      await request("/api/content/" + u.id, "vip", "GET", undefined, {
        Range: "bytes=200-",
      })
    ).status,
  ).toBe(416);
  const ticket = await json(
    "/api/items/" + u.id + "/ticket",
    "vip",
    "POST",
    {},
  );
  expect(ticket.url).not.toContain(u.id);
  expect((await request(ticket.url, "other")).status).toBe(403);
  expect(await (await request(ticket.url, "vip")).text()).toBe("hello world");
  await json("/api/trash", "vip", "POST", { ids: [u.id] });
  expect((await request(ticket.url, "vip")).status).toBe(404);
  expect(app.store.usage(ids.vip).used).toBe(11);
  await json("/api/admin/maintenance", "admin", "POST", {
    action: "restore",
    ids: [u.id],
  });
  expect((await request("/api/content/" + u.id, "vip")).status).toBe(200);
  await json("/api/trash", "vip", "POST", { ids: [u.id] });
  await json("/api/admin/maintenance", "admin", "POST", {
    action: "purge",
    ids: [u.id],
  });
  expect(app.store.usage(ids.vip).used).toBe(0);
});
test("bulk changes are all-or-nothing and cycles are rejected", async () => {
  expect(
    (await request("/api/trash", "vip", "POST", { ids: [privateId, sharedId] }))
      .status,
  ).toBe(403);
  expect(app.store.item(privateId)).not.toBeNull();
  expect(
    (
      await request("/api/items/" + privateId, "vip", "PATCH", {
        parent: publicId,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await request("/api/admin/maintenance", "admin", "POST", {
        action: "purge",
        ids: [privateId],
      })
    ).status,
  ).toBe(409);
});
test("path traversal, zero-width names, byte range validation, transfer adaptation", () => {
  for (const name of ["../a", "a/b", "a\\b", "\u200bsecret", ".."])
    expect(() => validName(name)).toThrow();
  expect(byteRange("bytes=-3", 10)).toEqual({
    start: 7,
    end: 9,
    partial: true,
  });
  expect(byteRange("bytes=-0", 10)).toBeNull();
  expect(byteRange("bytes=0-1,3-4", 10)).toBeNull();
  expect(nextChunk(1048576, 1048576, 1000)).toBeGreaterThan(1048576);
  expect(nextChunk(1048576, 1048576, 10000)).toBeLessThan(1048576);
  expect(nextChunk(1048576, 0, 0, true)).toBe(524288);
  expect(nextChunk(8 * 1024 * 1024, 10000000, 1)).toBe(8 * 1024 * 1024);
});
test("registration is IP-limited even with forged forwarding headers", async () => {
  app.store.db.run("INSERT INTO users VALUES (?,?,?,?,?,?,?)", [
    randomUUID(),
    "iplocked",
    0,
    "pending",
    5e6,
    "127.0.0.1",
    Date.now(),
  ]);
  const response = await request(
    "/api/auth/register/options",
    "",
    "POST",
    { name: "newperson" },
    { "X-Forwarded-For": "198.51.100.1" },
  );
  expect(response.status).toBe(403);
});
test("downgrade/denial immediately invalidates access and last admin is protected", async () => {
  expect(
    (
      await request("/api/admin/users", "admin", "PATCH", {
        id: ids.admin,
        level: 0,
      })
    ).status,
  ).toBe(409);
  await json("/api/admin/users", "admin", "PATCH", {
    id: ids.other,
    status: "denied",
  });
  expect((await json("/api/me", "other")).user).toBeNull();
});
test("global quota includes reservations across users; admin has no separate 5GB ceiling", async () => {
  const shared = await json("/api/uploads", "staff", "POST", {
    name: "global-reservation",
    size: 60_000_000,
  });
  expect(
    (
      await request("/api/uploads", "admin", "POST", {
        name: "global-overflow",
        size: 40_000_000,
        space: "private",
      })
    ).status,
  ).toBe(507);
  const admin = await json("/api/uploads", "admin", "POST", {
    name: "admin-capacity",
    size: 20_000_000,
    space: "private",
  });
  await json("/api/uploads/" + shared.id, "staff", "DELETE");
  await json("/api/uploads/" + admin.id, "admin", "DELETE");
});
test("external share navigation is allowed but cross-site API fetching and source disclosure are blocked", async () => {
  expect(
    (
      await request("/", "", "GET", undefined, {
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Mode": "navigate",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await request("/api/me", "", "GET", undefined, {
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Mode": "cors",
      })
    ).status,
  ).toBe(403);
  for (const path of [
    "/src/index.ts",
    "/data/envelope.key",
    "/.fileshare/users.json",
    "/api/ftp",
  ])
    expect((await request(path)).status).toBe(404);
});
