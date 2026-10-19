import { beforeAll, afterAll, test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { digestToken, randomToken } from "@pexserver/secure-envelope";
import { createApp } from "../src/server/app";
import { defaults } from "../src/server/config";
import { previewKind } from "../src/shared/preview";
let app: Awaited<ReturnType<typeof createApp>>, dir: string, origin: string;
const cookies: Record<string, string> = {};
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "fileshare-community-"));
  const config = structuredClone(defaults);
  config.port = 35000 + Math.floor(Math.random() * 10000);
  config.origin = `http://127.0.0.1:${config.port}`;
  config.dataDir = dir;
  origin = config.origin;
  app = await createApp(config);
  for (const [id, level] of [
    ["admin", 4],
    ["staff", 3],
    ["vip", 1],
    ["invited", 2],
    ["general", 0],
  ] as const) {
    app.store.db.run("INSERT INTO users VALUES (?,?,?,?,?,?,?)", [
      id,
      id,
      level,
      "approved",
      5e9,
      "192.0.2.1",
      Date.now(),
    ]);
    const token = randomToken();
    cookies[id] = "fs_session=" + token;
    app.store.db.run("INSERT INTO sessions VALUES (?,?,?)", [
      digestToken(token),
      id,
      Date.now() + 60000,
    ]);
  }
});
afterAll(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});
function request(
  path: string,
  user = "",
  method = "GET",
  body?: unknown,
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
async function item(
  name: string,
  visibility = "public",
  owner: string | null = null,
  parent: string | null = null,
) {
  const id = randomUUID(),
    text = "# Test\n<script>alert(1)</script>\n";
  app.store.db.run(
    "INSERT INTO items(id,parent,owner,name,folder,size,mime,visibility,created) VALUES (?,?,?,?,0,?,?,?,?)",
    [
      id,
      parent,
      owner,
      name,
      Buffer.byteLength(text),
      "text/html",
      visibility,
      Date.now(),
    ],
  );
  app.store.db.run(
    "INSERT INTO item_meta(item_id,uploaded_by,downloads) VALUES (?,?,?)",
    [id, "vip", visibility === "public" ? 1234 : 999999],
  );
  await writeFile(join(app.store.blobDir, id), text);
  return id;
}
test("profiles require the specified membership, validate links and raster icons, and never return account secrets", async () => {
  const body = {
    bio: "About me",
    links: [{ label: "SNS", url: "https://example.com/me" }],
  };
  for (const user of ["general", "invited", ""])
    expect((await request("/api/profile", user, "PATCH", body)).status).toBe(
      user ? 403 : 401,
    );
  for (const user of ["vip", "staff", "admin"])
    expect((await request("/api/profile", user, "PATCH", body)).status).toBe(
      200,
    );
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,x",
    "http://example.com",
    "https://name:password@example.com",
  ])
    expect(
      (
        await request("/api/profile", "vip", "PATCH", {
          ...body,
          links: [{ label: "Bad", url }],
        })
      ).status,
    ).toBe(400);
  expect(
    (
      await request("/api/profile", "vip", "PATCH", {
        ...body,
        avatar: "data:image/svg+xml;base64,PHN2Zy8+",
      })
    ).status,
  ).toBe(400);
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cLz8AAAAASUVORK5CYII=";
  expect(
    (
      await request("/api/profile", "vip", "PATCH", {
        ...body,
        avatar: "data:image/png;base64," + png,
      })
    ).status,
  ).toBe(200);
  const publicProfile = await (await request("/api/users/vip")).json();
  expect(publicProfile.bio).toBe(body.bio);
  expect(publicProfile.ip).toBeUndefined();
  expect(publicProfile.quota).toBeUndefined();
  const avatar = await request(publicProfile.avatar);
  expect(avatar.headers.get("content-type")).toBe("image/png");
  expect(Buffer.from(await avatar.arrayBuffer()).toString("base64")).toBe(png);
  app.store.db.run("UPDATE users SET level=0 WHERE id='vip'");
  expect((await request("/api/users/vip/avatar")).status).toBe(404);
  app.store.db.run("UPDATE users SET level=1 WHERE id='vip'");
});
test("uploader pages, rankings, preview documents and direct content consistently enforce ancestors, expiry and visibility", async () => {
  const visible = await item("public.md"),
    hidden = await item("secret.md", "private", "vip");
  const folder = randomUUID();
  app.store.db.run(
    "INSERT INTO items(id,name,folder,visibility,created) VALUES (?,?,1,?,?)",
    [folder, "hidden-folder", "private", Date.now()],
  );
  const child = await item("child.md", "public", null, folder);
  const expired = await item("expired.txt");
  app.store.db.run("UPDATE item_meta SET expires_at=? WHERE item_id=?", [
    Date.now() - 1,
    expired,
  ]);
  const files = await (await request("/api/users/vip/files")).json();
  expect(files.items.map((i: any) => i.id)).toEqual([visible]);
  const ranking = await (await request("/api/rankings/uploaders")).json();
  expect(ranking.users).toEqual([
    { id: "vip", name: "vip", downloads: 1234, files: 1 },
  ]);
  for (const id of [hidden, child, expired])
    for (const path of [
      `/api/items/${id}/text`,
      `/api/content/${id}`,
      `/files/${id}/preview`,
    ])
      expect((await request(path)).status).toBe(404);
  expect((await request(`/files/${hidden}/preview`, "vip")).status).toBe(200);
  expect((await request(`/api/items/${visible}/text`)).status).toBe(200);
  const direct = await request(`/api/content/${visible}`);
  expect(direct.headers.get("content-type")).toBe("application/octet-stream");
  expect(direct.headers.get("content-disposition")).toContain("attachment");
  expect(direct.headers.get("content-security-policy")).toContain("sandbox");
  app.store.filePolicy.showUploaders = false;
  expect((await request("/api/users/vip/files")).status).toBe(404);
  expect(
    (await (await request("/api/rankings/uploaders")).json()).users,
  ).toEqual([]);
  app.store.filePolicy.showUploaders = true;
  app.store.filePolicy.showDownloadCounts = false;
  expect(
    (await (await request("/api/rankings/uploaders")).json()).users[0]
      .downloads,
  ).toBeNull();
  app.store.filePolicy.showDownloadCounts = true;
});
test("preview classification keeps executable formats as escaped text and bounds text reads", async () => {
  for (const ext of ["html", "svg", "ts", "json"])
    expect(previewKind("file." + ext)).toBe("text");
  expect(previewKind("file.md")).toBe("markdown");
  expect(previewKind("file.pdf")).toBe("pdf");
  expect(previewKind("file.exe")).toBe("unsupported");
  const id = await item("large.txt");
  const text = "x".repeat(600000);
  await writeFile(join(app.store.blobDir, id), text);
  app.store.db.run("UPDATE items SET size=? WHERE id=?", [text.length, id]);
  const result = await (await request(`/api/items/${id}/text`)).json();
  expect(result.text.length).toBe(512 * 1024);
  expect(result.truncated).toBe(true);
  const pdf = await item("document.pdf");
  const res = await request(`/api/content/${pdf}`);
  expect(res.headers.get("content-type")).toBe("application/pdf");
  expect(res.headers.get("content-disposition")).toContain("inline");
});

test("author search only discovers readable uploaders and preserves hidden identities, pagination and administrator controls", async () => {
  const hiddenUsers = [
    "only-private",
    "only-expired",
    "only-parent-private",
    "only-vip",
    "blocked-author",
  ];
  for (const name of hiddenUsers)
    app.store.db.run("INSERT INTO users VALUES (?,?,?,?,?,?,?)", [
      name,
      name,
      1,
      name === "blocked-author" ? "denied" : "approved",
      5e9,
      "192.0.2.99",
      Date.now(),
    ]);
  const privateParent = randomUUID();
  app.store.db.run(
    "INSERT INTO items(id,name,folder,visibility,created) VALUES (?,?,1,?,?)",
    [privateParent, "secret-directory", "private", Date.now()],
  );
  for (const name of hiddenUsers) {
    const id = await item(
      name + ".txt",
      name === "only-private" ? "private" : "public",
      name === "only-private" ? name : null,
      name === "only-parent-private" ? privateParent : null,
    );
    app.store.db.run("UPDATE item_meta SET uploaded_by=? WHERE item_id=?", [
      name,
      id,
    ]);
    if (name === "only-expired")
      app.store.db.run("UPDATE item_meta SET expires_at=? WHERE item_id=?", [
        Date.now() - 1,
        id,
      ]);
    if (name === "only-vip")
      app.store.db.run("UPDATE items SET min_level=1 WHERE id=?", [id]);
  }
  for (const name of hiddenUsers) {
    const result = await (await request("/api/users?q=" + name)).json();
    expect(result.users).toEqual([]);
    expect(result.next).toBeNull();
  }
  const found = await (await request("/api/users?q=VIP")).json();
  expect(found.users.some((u: any) => u.id === "vip")).toBe(true);
  expect(
    found.users.every(
      (u: any) =>
        u.ip === undefined && u.status === undefined && u.quota === undefined,
    ),
  ).toBe(true);
  expect(
    (await (await request("/api/users?q=only-private", "admin")).json())
      .users[0].id,
  ).toBe("only-private");
  expect(
    (await (await request("/api/users?q=only-vip", "vip")).json()).users[0].id,
  ).toBe("only-vip");
  expect((await (await request("/api/users?q=%25")).json()).users).toEqual([]);
  expect((await request("/api/users?q=" + "a".repeat(65))).status).toBe(400);
  for (let n = 0; n < 27; n++) {
    const name = "creator-" + String(n).padStart(2, "0");
    app.store.db.run("INSERT INTO users VALUES (?,?,?,?,?,?,?)", [
      name,
      name,
      0,
      "approved",
      5e9,
      "192.0.2.99",
      Date.now(),
    ]);
    const id = await item(name + ".txt");
    app.store.db.run("UPDATE item_meta SET uploaded_by=? WHERE item_id=?", [
      name,
      id,
    ]);
  }
  const first = await (await request("/api/users?q=creator-")).json();
  expect(first.users.length).toBe(24);
  expect(first.next).toBe("creator-23");
  const second = await (
    await request("/api/users?q=creator-&after=" + first.next)
  ).json();
  expect(second.users.map((u: any) => u.name)).toEqual([
    "creator-24",
    "creator-25",
    "creator-26",
  ]);
  expect(second.next).toBeNull();
  app.store.filePolicy.showUploaders = false;
  expect(await (await request("/api/users?q=creator-")).json()).toEqual({
    users: [],
    next: null,
    enabled: false,
  });
  app.store.filePolicy.showUploaders = true;
});
