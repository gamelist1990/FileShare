import {
  realpath,
  stat,
  access,
  mkdir,
  open,
  unlink,
  copyFile,
  rename,
  statfs,
  readFile,
  readdir,
} from "node:fs/promises";
import {
  constants,
  existsSync,
  statfsSync,
  statSync,
  lstatSync,
  readFileSync,
  accessSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, isAbsolute, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import type { Store } from "./store";
import { HttpError } from "./policy";
export async function registerVolume(store: Store, body: any) {
  if (
    typeof body.path !== "string" ||
    !isAbsolute(body.path) ||
    typeof body.label !== "string" ||
    !body.label.trim() ||
    body.label.length > 80 ||
    !Number.isSafeInteger(body.capacityBytes) ||
    body.capacityBytes < 1
  )
    throw new HttpError(
      400,
      "ドライブ名・絶対パス・割当容量を確認してください",
    );
  let root: string;
  try {
    root = await realpath(normalize(body.path));
    if (!(await stat(root)).isDirectory()) throw Error();
    await access(root, constants.W_OK);
  } catch {
    throw new HttpError(
      400,
      "存在し、書き込み可能なディレクトリを指定してください",
    );
  }
  if (root === "/" || /^\/(proc|sys|dev|etc|boot)(\/|$)/.test(root))
    throw new HttpError(400, "データ保存用のディレクトリを指定してください");
  const path = join(root, "pex-fileshare-blobs");
  if (store.db.query("SELECT 1 FROM storage_volumes WHERE path=?").get(path))
    throw new HttpError(409, "この保存先は登録済みです");
  await mkdir(path, { mode: 0o700, recursive: true });
  if ((await realpath(path)) !== path || (await readdir(path)).length)
    throw new HttpError(
      409,
      "専用の空の保存先が必要です。別のディレクトリを指定してください",
    );
  const id = randomUUID();
  const marker = join(path, MARKER);
  let f;
  try {
    f = await open(marker, "wx", 0o600);
  } catch {
    throw new HttpError(
      409,
      "保存先に既存の識別情報があります。登録済みドライブをご確認ください",
    );
  }
  try {
    await f.writeFile(id);
    await f.sync();
    await f.close();
    f = undefined;
    const directory = await open(path, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    store.db.transaction(() => {
      if (body.capacityBytes > additionalCapacity(store, root))
        throw new HttpError(
          400,
          "既存の割当を除いた空き容量を超えています。再検出してください",
        );
      store.db.run(
        "INSERT INTO storage_volumes(id,label,path,capacity,enabled) VALUES (?,?,?,?,1)",
        [id, body.label.trim(), path, body.capacityBytes],
      );
      store.db.run("INSERT INTO storage_volume_checks VALUES (?)", [id]);
    })();
  } catch (error) {
    if (f) await f.close();
    await unlink(marker).catch(() => {});
    throw error;
  }
  store.config.capacityBytes += body.capacityBytes;
  return { id };
}
export async function moveDurable(source: string, target: string) {
  try {
    await rename(source, target);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    const staging = target + ".copying";
    await unlink(staging).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
    try {
      await copyFile(source, staging, constants.COPYFILE_EXCL);
      const f = await open(staging, "r+");
      try {
        await f.sync();
      } finally {
        await f.close();
      }
      await rename(staging, target);
      await unlink(source);
    } catch (e) {
      await unlink(staging).catch(() => {});
      throw e;
    }
  }
  const d = await open(join(target, ".."), "r");
  try {
    await d.sync();
  } finally {
    await d.close();
  }
}
export function assignVolume(store: Store, id: string, size: number) {
  const volumes = store.db
    .query("SELECT * FROM storage_volumes WHERE enabled=1 ORDER BY label")
    .all() as any[];
  for (const v of volumes) {
    if (!volumeOnline(v)) continue;
    try {
      accessSync(v.path, constants.W_OK);
      statfsSync(v.path);
    } catch {
      continue;
    }
    const used = (
      store.db
        .query(
          "SELECT COALESCE(SUM(i.size),0) AS n FROM file_locations l JOIN items i ON i.id=l.item_id WHERE l.volume_id=? AND NOT EXISTS(SELECT 1 FROM item_meta m WHERE m.item_id=i.id AND m.purged=1)",
        )
        .get(v.id) as any
    ).n;
    const reserved = (
      store.db
        .query(
          "SELECT COALESCE(SUM(u.size),0) AS n FROM upload_volumes v JOIN uploads u ON u.id=v.upload_id WHERE v.volume_id=?",
        )
        .get(v.id) as any
    ).n;
    const disk = statfsSync(v.path);
    if (
      used + reserved + size <= v.capacity &&
      Number(disk.bavail) * Number(disk.bsize) - reserved >= size
    ) {
      store.db.run("INSERT INTO upload_volumes VALUES (?,?)", [id, v.id]);
      return;
    }
  }
  const base =
    store.config.capacityBytes -
    (
      store.db
        .query("SELECT COALESCE(SUM(capacity),0) AS n FROM storage_volumes")
        .get() as any
    ).n;
  const baseUsed = (
    store.db
      .query(
        "SELECT COALESCE(SUM(i.size),0) AS n FROM items i WHERE NOT EXISTS(SELECT 1 FROM file_locations l WHERE l.item_id=i.id) AND NOT EXISTS(SELECT 1 FROM upload_volumes v WHERE v.upload_id=i.id) AND NOT EXISTS(SELECT 1 FROM item_meta m WHERE m.item_id=i.id AND m.purged=1)",
      )
      .get() as any
  ).n;
  const baseReserved = (
    store.db
      .query(
        "SELECT COALESCE(SUM(u.size),0) AS n FROM uploads u WHERE u.id<>? AND NOT EXISTS(SELECT 1 FROM upload_volumes v WHERE v.upload_id=u.id) AND NOT EXISTS(SELECT 1 FROM items i WHERE i.id=u.id)",
      )
      .get(id) as any
  ).n;
  const disk = statfsSync(store.blobDir);
  if (
    baseUsed + baseReserved + size > base ||
    Number(disk.bavail) * Number(disk.bsize) - baseReserved < size
  )
    throw new HttpError(507, "書き込み可能な保存先の空き容量が不足しています");
}

const MARKER = ".fileshare-volume-id";
type Volume = {
  id: string;
  path: string;
  capacity: number;
  enabled: number;
  label: string;
};
export function volumeOnline(v: Pick<Volume, "id" | "path">): boolean {
  try {
    const p = join(v.path, MARKER);
    return (
      lstatSync(v.path).isDirectory() &&
      !lstatSync(p).isSymbolicLink() &&
      readFileSync(p, "utf8") === v.id
    );
  } catch {
    return false;
  }
}
function volumeUsed(store: Store, id: string) {
  return (
    store.db
      .query(
        "SELECT COALESCE(SUM(i.size),0) AS n FROM file_locations l JOIN items i ON i.id=l.item_id WHERE l.volume_id=? AND NOT EXISTS(SELECT 1 FROM item_meta m WHERE m.item_id=i.id AND m.purged=1)",
      )
      .get(id) as any
  ).n as number;
}
export function additionalCapacity(store: Store, path: string): number {
  const disk = statfsSync(path),
    dev = statSync(path).dev;
  const volumes = store.db
    .query("SELECT * FROM storage_volumes")
    .all() as Volume[];
  const base =
    store.config.capacityBytes - volumes.reduce((a, v) => a + v.capacity, 0);
  let reserved = 0;
  if (statSync(store.blobDir).dev === dev) {
    const used = (
      store.db
        .query(
          "SELECT COALESCE(SUM(i.size),0) AS n FROM items i WHERE NOT EXISTS(SELECT 1 FROM file_locations l WHERE l.item_id=i.id) AND NOT EXISTS(SELECT 1 FROM upload_volumes u WHERE u.upload_id=i.id) AND NOT EXISTS(SELECT 1 FROM edge_files e WHERE e.item_id=i.id AND e.pending=1) AND NOT EXISTS(SELECT 1 FROM item_meta m WHERE m.item_id=i.id AND m.purged=1)",
        )
        .get() as any
    ).n;
    reserved += Math.max(0, base - used);
  }
  for (const v of volumes)
    if (volumeOnline(v) && statSync(v.path).dev === dev)
      reserved += Math.max(0, v.capacity - volumeUsed(store, v.id));
  return Math.max(
    0,
    Math.floor(Number(disk.bavail) * Number(disk.bsize) - reserved),
  );
}
export function storageUnavailable(
  store: Store,
  id: string,
  size?: number,
): boolean {
  const v = store.db
    .query(
      "SELECT v.* FROM storage_volumes v JOIN file_locations l ON l.volume_id=v.id WHERE l.item_id=?",
    )
    .get(id) as Volume | null;
  if (!v) return false;
  if (!volumeOnline(v)) return true;
  try {
    const f = lstatSync(join(v.path, id));
    return !f.isFile() || (size !== undefined && f.size !== size);
  } catch {
    return true;
  }
}
export function assertStorageAvailable(
  store: Store,
  item: { id: string; size: number; folder: number },
) {
  if (!item.folder && storageUnavailable(store, item.id, item.size))
    throw new HttpError(
      404,
      "破損・接続不可：保存先ドライブまたはファイルを確認できません。再接続後に再試行してください",
    );
}
export function queueVolumeDelete(store: Store, id: string): boolean {
  const row = store.db
    .query(
      "SELECT volume_id FROM file_locations WHERE item_id=? UNION SELECT volume_id FROM upload_volumes WHERE upload_id=?",
    )
    .get(id, id) as any;
  if (!row) return false;
  store.db.run(
    "INSERT OR IGNORE INTO volume_deletions(volume_id,item_id,created) VALUES (?,?,?)",
    [row.volume_id, id, Date.now()],
  );
  return true;
}
export async function reconcileVolumeDeletes(store: Store) {
  await initializeLegacyVolumes(store);
  const rows = store.db
    .query(
      "SELECT d.*,v.path FROM volume_deletions d JOIN storage_volumes v ON v.id=d.volume_id",
    )
    .all() as any[];
  for (const row of rows) {
    if (!volumeOnline({ id: row.volume_id, path: row.path })) continue;
    // Only UUID blobs inside this verified managed directory can be removed.
    if (!/^[a-f0-9-]{36}$/.test(row.item_id)) continue;
    let directory: Awaited<ReturnType<typeof verifiedDirectory>> | undefined;
    try {
      directory = await verifiedDirectory({
        id: row.volume_id,
        path: row.path,
      });
      for (const name of [row.item_id, row.item_id + ".copying"])
        await unlink(join(directory.path, name)).catch((e) => {
          if (e.code !== "ENOENT") throw e;
        });
      await directory.sync();
      store.db.run(
        "DELETE FROM volume_deletions WHERE volume_id=? AND item_id=?",
        [row.volume_id, row.item_id],
      );
    } catch {
      /* Keep the durable deletion receipt and retry after reconnection. */
    } finally {
      await directory?.close();
    }
  }
}
function decodeMount(value: string) {
  return value.replace(/\\([0-7]{3})/g, (_, v) =>
    String.fromCharCode(parseInt(v, 8)),
  );
}
export function discoverVolumes(store: Store) {
  const candidates = new Map<
    string,
    { mountPoint: string; filesystem: string; source: string }
  >();
  if (process.platform === "linux") {
    try {
      for (const line of readFileSync("/proc/self/mountinfo", "utf8").split(
        "\n",
      )) {
        const [left, right] = line.split(" - ");
        if (!right) continue;
        const fields = left.split(" "),
          [filesystem, source] = right.split(" ");
        if (!fields[2] || fields[5]?.split(",").includes("ro")) continue;
        if (
          !source.startsWith("/dev/") &&
          ![
            "btrfs",
            "zfs",
            "nfs",
            "nfs4",
            "cifs",
            "fuseblk",
            "fuse.sshfs",
          ].includes(filesystem)
        )
          continue;
        const mountPoint = decodeMount(fields[4]);
        if (mountPoint === "/") continue;
        if (/^\/(proc|sys|dev|etc|boot)(\/|$)/.test(mountPoint)) continue;
        candidates.set(mountPoint, {
          mountPoint,
          filesystem,
          source: decodeMount(source),
        });
      }
    } catch {}
  }
  // Also provide the writable existing drive without requiring an absolute path.
  candidates.set(homedir(), {
    mountPoint: homedir(),
    filesystem: "既存ドライブ",
    source: "ホーム領域",
  });
  const volumes = store.db
    .query("SELECT * FROM storage_volumes")
    .all() as Volume[];
  return [...candidates.values()].flatMap((c) => {
    try {
      const target =
        c.mountPoint === homedir()
          ? join(c.mountPoint, "FileShareStorage")
          : c.mountPoint;
      accessSync(c.mountPoint, constants.W_OK);
      const disk = statfsSync(c.mountPoint),
        available = additionalCapacity(store, c.mountPoint);
      if (available < 1e6) return [];
      return [
        {
          ...c,
          path: target,
          totalBytes: Number(disk.blocks) * Number(disk.bsize),
          freeBytes: Number(disk.bavail) * Number(disk.bsize),
          availableBytes: available,
          registered: volumes.some(
            (v) => v.path === join(target, "pex-fileshare-blobs"),
          ),
        },
      ];
    } catch {
      return [];
    }
  });
}
export async function registerDetectedVolume(store: Store, body: any) {
  const candidate = discoverVolumes(store).find(
    (c) => c.path === body.path && !c.registered,
  );
  if (!candidate)
    throw new HttpError(400, "保存先を再検出して選び直してください");
  await mkdir(candidate.path, { mode: 0o700, recursive: true });
  return registerVolume(store, {
    ...body,
    capacityBytes:
      body.capacityBytes ?? Math.floor(candidate.availableBytes / 1e6) * 1e6,
  });
}
export async function volumeOverview(store: Store) {
  await reconcileVolumeDeletes(store);
  const volumes = (
    store.db
      .query("SELECT * FROM storage_volumes ORDER BY label")
      .all() as Volume[]
  ).map((v) => ({
    ...v,
    used: volumeUsed(store, v.id),
    online: volumeOnline(v),
    pendingDeletes: (
      store.db
        .query("SELECT COUNT(*) AS n FROM volume_deletions WHERE volume_id=?")
        .get(v.id) as any
    ).n,
  }));
  return {
    volumes,
    capacity: store.config.capacityBytes,
    onlineCapacity:
      store.config.capacityBytes -
      volumes.filter((v) => !v.online).reduce((a, v) => a + v.capacity, 0),
    candidates: discoverVolumes(store),
  };
}

async function verifiedDirectory(v: Pick<Volume, "id" | "path">) {
  if (!volumeOnline(v))
    throw new HttpError(507, "保存先ドライブが接続されていません");
  const file = await open(v.path, "r");
  const path =
    process.platform === "linux" ? `/proc/self/fd/${file.fd}` : v.path;
  try {
    if ((await readFile(join(path, MARKER), "utf8")) !== v.id)
      throw new Error("Wrong drive identity");
    return { path, close: () => file.close(), sync: () => file.sync() };
  } catch (error) {
    await file.close();
    throw new HttpError(507, "保存先ドライブが切断されました");
  }
}
export async function openUploadTarget(store: Store, id: string) {
  const v = store.db
    .query(
      "SELECT v.* FROM storage_volumes v JOIN upload_volumes u ON u.volume_id=v.id WHERE u.upload_id=?",
    )
    .get(id) as Volume | null;
  if (!v) return { path: store.blobPath(id), close: async () => {} };
  const directory = await verifiedDirectory(v);
  return { path: join(directory.path, id), close: directory.close };
}

// Existing 2.16 volumes have no marker yet. Adopt them once, only when their
// registered blobs can actually be verified. Verified drives are never re-adopted.
async function initializeLegacyVolumes(store: Store) {
  const rows = store.db
    .query(
      "SELECT v.* FROM storage_volumes v WHERE NOT EXISTS(SELECT 1 FROM storage_volume_checks c WHERE c.volume_id=v.id)",
    )
    .all() as Volume[];
  for (const v of rows) {
    try {
      if (volumeOnline(v)) {
        store.db.run("INSERT OR IGNORE INTO storage_volume_checks VALUES (?)", [
          v.id,
        ]);
        continue;
      }
      if (
        !lstatSync(v.path).isDirectory() ||
        (await realpath(v.path)) !== v.path ||
        existsSync(join(v.path, MARKER))
      )
        continue;
      const files = store.db
        .query(
          "SELECT i.id,i.size FROM file_locations l JOIN items i ON i.id=l.item_id WHERE l.volume_id=? AND NOT EXISTS(SELECT 1 FROM item_meta m WHERE m.item_id=i.id AND m.purged=1)",
        )
        .all(v.id) as { id: string; size: number }[];
      if (
        !files.every((i) => {
          try {
            const s = lstatSync(join(v.path, i.id));
            return s.isFile() && s.size === i.size;
          } catch {
            return false;
          }
        })
      )
        continue;
      // An empty disconnected path cannot identify a legacy drive. Wait for data.
      if (
        !files.length &&
        !(await readdir(v.path)).some((n) => /^[a-f0-9-]{36}$/.test(n))
      )
        continue;
      const f = await open(join(v.path, MARKER), "wx", 0o600);
      try {
        await f.writeFile(v.id);
        await f.sync();
      } finally {
        await f.close();
      }
      const d = await open(v.path, "r");
      try {
        await d.sync();
      } finally {
        await d.close();
      }
      store.db.run("INSERT OR IGNORE INTO storage_volume_checks VALUES (?)", [
        v.id,
      ]);
    } catch {
      /* Retry after the original legacy drive is reattached. */
    }
  }
}
