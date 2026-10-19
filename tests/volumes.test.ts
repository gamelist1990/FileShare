import { test, expect } from "bun:test";
import {
  mkdtemp,
  mkdir,
  rename,
  rm,
  readFile,
  writeFile,
  symlink,
  unlink,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { randomToken, digestToken } from "@pexserver/secure-envelope";
import { defaults } from "../src/server/config";
import { createApp } from "../src/server/app";
import { cleanup } from "../src/server/storage";
import { Store } from "../src/server/store";
import { additionalCapacity } from "../src/server/volumes";
import { authorizeContent, signContent } from "../src/server/edge-files";

test("mapped drives preserve folders, reject replacement mounts and cached access, and persist offline deletion until the original returns", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fs-volumes-")),
    cfg = structuredClone(defaults);
  cfg.port = 44000 + Math.floor(Math.random() * 10000);
  cfg.origin = `http://127.0.0.1:${cfg.port}`;
  cfg.dataDir = join(dir, "data");
  cfg.capacityBytes = 100e6;
  cfg.preview.cacheBytes = 1e6;
  const app = await createApp(cfg),
    token = randomToken();
  app.store.db.run("INSERT INTO users VALUES (?,?,?,?,?,?,?)", [
    "admin",
    "admin",
    4,
    "approved",
    5e6,
    "127.0.0.1",
    Date.now(),
  ]);
  app.store.db.run("INSERT INTO sessions VALUES (?,?,?)", [
    digestToken(token),
    "admin",
    Date.now() + 3600000,
  ]);
  const request = (p: string, m = "GET", body?: any, auth = true) =>
    fetch(cfg.origin + p, {
      method: m,
      headers: {
        Origin: cfg.origin,
        ...(auth ? { Cookie: "fs_session=" + token } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  const json = async (p: string, m = "GET", body?: any) => {
    const r = await request(p, m, body),
      d = await r.json();
    if (!r.ok) throw Error(r.status + JSON.stringify(d));
    return d;
  };
  async function upload(name: string, parent?: string) {
    const data = Buffer.from("original-content:" + name),
      r = await json("/api/uploads", "POST", {
        name,
        size: data.length,
        space: "private",
        parent,
      });
    const p = await fetch(cfg.origin + "/api/uploads/" + r.id, {
      method: "PATCH",
      headers: {
        Origin: cfg.origin,
        Cookie: "fs_session=" + token,
        "Upload-Offset": "0",
        "Upload-Checksum": createHash("sha256").update(data).digest("hex"),
      },
      body: data,
    });
    expect(p.status).toBe(200);
    await json("/api/uploads/" + r.id + "/complete", "POST", {});
    return { id: r.id, data };
  }
  try {
    const detected = await json("/api/admin/storage/volumes");
    expect(detected.candidates.length).toBeGreaterThan(0);
    expect(
      detected.candidates.every(
        (c: any) => c.availableBytes <= c.freeBytes && c.availableBytes > 0,
      ),
    ).toBe(true);
    expect(
      (await request("/api/admin/storage/volumes", "GET", undefined, false))
        .status,
    ).toBe(401);
    const root = join(dir, "drive"),
      off = root + "-detached";
    await mkdir(root);
    const volume = await json("/api/admin/storage/volumes", "POST", {
      path: root,
      label: "SSD",
      capacityBytes: 10e6,
    });
    expect((await json("/api/admin/storage/volumes")).capacity).toBe(110e6);
    expect((await json("/api/items?space=private")).capacity).toBe(5e6);
    expect((await json("/api/items?space=shared")).capacity).toBe(110e6);
    const alias = join(dir, "alias");
    await symlink(root, alias);
    expect(
      (
        await request("/api/admin/storage/volumes", "POST", {
          path: alias,
          label: "duplicate",
          capacityBytes: 1e6,
        })
      ).status,
    ).toBe(409);
    const folder = await json("/api/folders", "POST", {
      name: "same-folder",
      space: "private",
    });
    const keep = await upload("keep.txt", folder.id),
      deleted = await upload("delete.txt", folder.id),
      expired = await upload("expired.txt", folder.id);
    expect(app.store.item(keep.id)?.parent).toBe(folder.id);
    expect(
      (await json(`/api/items?parent=${folder.id}&space=private`)).items.length,
    ).toBe(3);
    const sign = () =>
      signContent("fixture-secret", {
        id: keep.id,
        ip: "127.0.0.1",
        session: digestToken(token),
        user: "admin",
        expires: Date.now() + 60000,
        download: false,
        receipt: null,
      });
    expect(
      authorizeContent(app.store, "fixture-secret", {
        ticket: sign(),
        ip: "127.0.0.1",
      }).id,
    ).toBe(keep.id);
    await rename(root, off);
    // Another drive/directory at exactly the same path must not be trusted.
    await mkdir(join(root, "pex-fileshare-blobs"), { recursive: true });
    await writeFile(
      join(root, "pex-fileshare-blobs", ".fileshare-volume-id"),
      "wrong-drive",
    );
    await writeFile(
      join(root, "pex-fileshare-blobs", deleted.id),
      "replacement must survive",
    );
    const listing = await json(`/api/items?parent=${folder.id}&space=private`);
    expect(
      listing.items.every((i: any) => i.storageState === "unavailable"),
    ).toBe(true);
    expect((await json("/api/admin/storage/volumes")).volumes[0].online).toBe(
      false,
    );
    for (const p of [
      `/api/content/${keep.id}`,
      `/api/items/${keep.id}/text`,
      `/api/content/${keep.id}/preview`,
      `/files/${keep.id}/preview`,
    ])
      expect((await request(p)).status).toBe(404);
    expect(
      (await request(`/api/items/${keep.id}/ticket`, "POST", {})).status,
    ).toBe(404);
    expect(() =>
      authorizeContent(app.store, "fixture-secret", {
        ticket: sign(),
        ip: "127.0.0.1",
      }),
    ).toThrow("破損・接続不可");
    const fallback = await upload("fallback.txt");
    expect(app.store.blobPath(fallback.id)).toBe(
      join(app.store.blobDir, fallback.id),
    );
    await json("/api/trash", "POST", { ids: [deleted.id] });
    expect(
      (
        await request("/api/admin/maintenance", "POST", {
          action: "restore",
          ids: [deleted.id],
        })
      ).status,
    ).toBe(409);
    await json("/api/admin/maintenance", "POST", {
      action: "purge",
      ids: [deleted.id],
    });
    app.store.db.run("UPDATE item_meta SET expires_at=? WHERE item_id=?", [
      Date.now() - 1,
      expired.id,
    ]);
    await cleanup(app.store);
    expect(
      await readFile(join(root, "pex-fileshare-blobs", deleted.id), "utf8"),
    ).toBe("replacement must survive");
    expect(
      (
        app.store.db
          .query("SELECT count(*) AS n FROM volume_deletions")
          .get() as any
      ).n,
    ).toBe(2);
    const reopenedCfg = structuredClone(cfg);
    reopenedCfg.capacityBytes = 100e6;
    const reopened = new Store(reopenedCfg);
    try {
      await rm(root, { recursive: true, force: true });
      await rename(off, root);
      await cleanup(reopened, false);
      expect(existsSync(join(root, "pex-fileshare-blobs", deleted.id))).toBe(
        false,
      );
      expect(existsSync(join(root, "pex-fileshare-blobs", expired.id))).toBe(
        false,
      );
      expect(
        (
          reopened.db
            .query("SELECT count(*) AS n FROM volume_deletions")
            .get() as any
        ).n,
      ).toBe(0);
    } finally {
      reopened.db.close();
    }
    expect((await json(`/api/items/${keep.id}`)).storageState).toBe("stored");
    expect(
      Buffer.from(
        await (await request(`/api/content/${keep.id}`)).arrayBuffer(),
      ).equals(keep.data),
    ).toBe(true);
    expect(
      (await request(`/api/content/${keep.id}`, "GET", undefined, false))
        .status,
    ).toBe(404);
    expect((await request(`/api/items/${deleted.id}`)).status).toBe(404);
    expect((await json("/api/admin/storage/volumes")).volumes[0].online).toBe(
      true,
    );
    // Restoring the mount with a truncated/corrupt file also returns 404.
    await writeFile(app.store.blobPath(keep.id), "broken");
    expect((await request(`/api/content/${keep.id}`)).status).toBe(404);
    await writeFile(app.store.blobPath(keep.id), keep.data);
    expect((await request(`/api/content/${keep.id}`)).status).toBe(200);
    // Upgrade old mappings once, then never recreate a removed identity marker.
    const marker = join(root, "pex-fileshare-blobs", ".fileshare-volume-id");
    await unlink(marker);
    app.store.db.run("DELETE FROM storage_volume_checks WHERE volume_id=?", [
      volume.id,
    ]);
    await cleanup(app.store, false);
    expect(await readFile(marker, "utf8")).toBe(volume.id);
    await unlink(marker);
    await cleanup(app.store, false);
    expect(existsSync(marker)).toBe(false);
    expect((await request(`/api/content/${keep.id}`)).status).toBe(404);
    await writeFile(marker, volume.id);
    await unlink(app.store.blobPath(fallback.id));
    expect((await request(`/api/content/${fallback.id}`)).status).toBe(404);
    const second = join(dir, "second");
    await mkdir(second);
    const tooMuch = additionalCapacity(app.store, second) + 1;
    expect(
      (
        await request("/api/admin/storage/volumes", "POST", {
          path: second,
          label: "excess",
          capacityBytes: tooMuch,
        })
      ).status,
    ).toBe(400);
    expect(
      existsSync(join(second, "pex-fileshare-blobs", ".fileshare-volume-id")),
    ).toBe(false);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
