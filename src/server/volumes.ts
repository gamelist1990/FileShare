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
} from "node:fs/promises";
import { constants, existsSync, statfsSync } from "node:fs";
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
  await mkdir(path, { mode: 0o700, recursive: true });
  const disk = await statfs(path);
  if (body.capacityBytes > Number(disk.bavail) * Number(disk.bsize))
    throw new HttpError(400, "割当容量がドライブの空き容量を超えています");
  const probe = join(path, ".probe-" + randomUUID());
  const f = await open(probe, "wx", 0o600);
  await f.close();
  await unlink(probe);
  const id = randomUUID();
  try {
    store.db.run("INSERT INTO storage_volumes VALUES (?,?,?,?,1)", [
      id,
      body.label.trim(),
      path,
      body.capacityBytes,
    ]);
  } catch {
    throw new HttpError(409, "この保存先は登録済みです");
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
    if (!existsSync(v.path)) continue;
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
