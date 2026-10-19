import { gunzipSync, createGzip } from "node:zlib";
import { compressibleName, acceptsGzip } from "../shared/compression";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import { createReadStream, existsSync } from "node:fs";
import { open, rename, unlink, stat, readdir } from "node:fs/promises";
import { ITEM_SELECT, type Store, type User, type Item } from "./store";
import { retentionSeconds } from "./settings";
import {
  HttpError,
  requireUser,
  requireAdmin,
  validName,
  destination,
  readItem,
  writeItem,
  canRead,
  canWrite,
  canUpload,
} from "./policy";
import {
  randomToken,
  digestToken,
  equalDigest,
} from "@pexserver/secure-envelope";
export const MAX_CHUNK = 8 * 1024 * 1024;
export const UPLOAD_RESERVATION_MS = 30 * 60 * 1000;
export async function readBody(
  req: IncomingMessage,
  limit = 32_768,
  bandwidth?: Bandwidth,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const part of req) {
    n += part.length;
    if (n > limit) throw new HttpError(413, "リクエストが大きすぎます");
    if (bandwidth) await bandwidth.acquire(part.length);
    chunks.push(Buffer.from(part));
  }
  return Buffer.concat(chunks);
}
export const safeItem = (store: Store, i: Item) => {
  const {
    key_hash,
    deleted,
    purged,
    uploaded_by,
    uploader_name,
    downloads,
    ...rest
  } = i;
  return {
    ...rest,
    uploaded_by: store.filePolicy.showUploaders ? (uploaded_by ?? null) : null,
    uploader_name: store.filePolicy.showUploaders
      ? (uploader_name ?? null)
      : null,
    downloads: store.filePolicy.showDownloadCounts ? (downloads ?? 0) : null,
  };
};
export function listItems(
  store: Store,
  user: User | null,
  parent: string | null,
  space: string,
) {
  let owner: string | null = space === "private" ? requireUser(user).id : null;
  if (parent) {
    const folder = readItem(store, user, parent);
    if (!folder.folder) throw new HttpError(400, "フォルダを指定してください");
    owner = folder.owner;
  }
  const items = store.db
    .query(
      ITEM_SELECT +
        " WHERE i.parent IS ? AND i.owner IS ? AND i.deleted IS NULL ORDER BY i.folder DESC,i.name COLLATE NOCASE",
    )
    .all(parent, owner) as Item[];
  return {
    items: items
      .filter((i) => canRead(store, user, i))
      .map((i) => safeItem(store, i)),
    writable: canWrite(user, owner, store),
    uploadable: canUpload(store, user, owner),
    usage: store.usage(owner ?? undefined),
    capacity:
      owner && store.user(owner)!.level !== 4
        ? store.user(owner)!.quota
        : store.config.capacityBytes,
    parent: parent ? safeItem(store, readItem(store, user, parent)) : null,
  };
}
function reserve(store: Store, user: User, owner: string | null, size: number) {
  const total = store.usage();
  if (
    total.used + total.reserved + size >
    store.config.capacityBytes - store.config.preview.cacheBytes
  )
    throw new HttpError(507, "共有ストレージの容量上限です");
  if (owner) {
    const usage = store.usage(owner),
      u = store.user(owner)!;
    if (user.level !== 4 && usage.used + usage.reserved + size > u.quota)
      throw new HttpError(507, "個人ストレージの容量上限です");
  }
}
export function initUpload(store: Store, user: User | null, data: any) {
  const u = requireUser(user),
    dest = destination(store, u, data.parent, data.space, true),
    name = validName(data.name);
  const size = data.size;
  if (!Number.isSafeInteger(size) || size < 0)
    throw new HttpError(400, "サイズが不正です");
  if (size > store.filePolicy.maxFileBytes)
    throw new HttpError(413, "1ファイルのアップロード上限を超えています");
  const retention = retentionSeconds(
    data.retentionSeconds ?? store.filePolicy.maxRetentionSeconds,
    store.filePolicy.maxRetentionSeconds,
  );
  const id = randomUUID();
  store.db.transaction(() => {
    if (
      store.db
        .query(
          "SELECT 1 FROM items WHERE parent IS ? AND owner IS ? AND name=? AND deleted IS NULL",
        )
        .get(dest.parent, dest.owner, name)
    )
      throw new HttpError(409, "同じ名前が存在します");
    if (
      (
        store.db
          .query("SELECT count(*) AS n FROM uploads WHERE user_id=?")
          .get(u.id) as { n: number }
      ).n >= 5
    )
      throw new HttpError(429, "未完了の転送が多すぎます");
    reserve(store, u, dest.owner, size);
    store.db.run("INSERT INTO uploads VALUES (?,?,?,?,?,?,?,?,?)", [
      id,
      u.id,
      dest.parent,
      dest.owner,
      name,
      size,
      0,
      String(data.mime ?? "").slice(0, 120),
      Date.now() + UPLOAD_RESERVATION_MS,
    ]);
    store.db.run("INSERT INTO upload_policies VALUES (?,?)", [id, retention]);
  })();
  return {
    id,
    offset: 0,
    maxChunk: MAX_CHUNK,
    encodings: ["identity", "gzip"],
    pipeline: "fileshare-upload-v2",
  };
}
const busy = new Set<string>();
export function getUpload(store: Store, user: User | null, id: string): any {
  const u = requireUser(store.user(requireUser(user).id)),
    row = store.db
      .query("SELECT * FROM uploads WHERE id=? AND user_id=? AND expires>?")
      .get(id, u.id, Date.now()) as any;
  if (!row) throw new HttpError(404, "転送が見つかりません");
  if (row.size > store.filePolicy.maxFileBytes)
    throw new HttpError(413, "1ファイルのアップロード上限が変更されています");
  if (!canUpload(store, u, row.owner))
    throw new HttpError(403, "転送権限がありません");
  if (row.parent) {
    const parent = readItem(store, u, row.parent);
    if (!parent.folder || parent.owner !== row.owner)
      throw new HttpError(403, "転送先が変更されています");
  }
  row.receipt =
    store.db
      .query(
        "SELECT start,length,hash FROM upload_blocks WHERE upload_id=? ORDER BY start DESC LIMIT 1",
      )
      .get(id) ?? null;
  return row;
}
/** Exclusive lease shared by REST and WebSocket writers and storage maintenance. */
export function leaseUpload(id: string) {
  if (busy.has(id)) throw new HttpError(409, "この転送を処理中です");
  busy.add(id);
  let released = false;
  return () => {
    if (!released) {
      released = true;
      busy.delete(id);
    }
  };
}
/** Caller owns leaseUpload(id). The database offset is the durable contiguous receipt. */
export async function commitUploadBlock(
  store: Store,
  user: User | null,
  id: string,
  offset: number,
  encoded: Buffer,
  checksum: string,
  encoding: string | undefined,
  maximum = MAX_CHUNK,
  expectedLength?: number,
) {
  const row = getUpload(store, user, id);
  if (!Number.isSafeInteger(offset) || offset !== row.offset)
    throw new HttpError(409, "転送位置を再確認してください");
  if (encoded.length > maximum)
    throw new HttpError(413, "転送ブロックが大きすぎます");
  if (encoding && encoding !== "identity" && encoding !== "gzip")
    throw new HttpError(400, "未対応の転送圧縮形式です");
  let body = encoded;
  if (encoding === "gzip") {
    try {
      body = gunzipSync(encoded, { maxOutputLength: maximum });
    } catch (error) {
      throw new HttpError(
        (error as any).code === "ERR_BUFFER_TOO_LARGE" ? 413 : 400,
        "圧縮データが不正、または展開後の上限を超えています",
      );
    }
  }
  if (expectedLength !== undefined && body.length !== expectedLength)
    throw new HttpError(400, "展開後のサイズが一致しません");
  if (!body.length || row.offset + body.length > row.size)
    throw new HttpError(400, "転送サイズが不正です");
  if (!equalDigest(createHash("sha256").update(body).digest("hex"), checksum))
    throw new HttpError(400, "チェックサムが一致しません");
  const path = join(store.tempDir, id),
    file = await open(path, existsSync(path) ? "r+" : "wx", 0o600);
  try {
    await file.truncate(row.offset);
    let written = 0;
    while (written < body.length) {
      const r = await file.write(
        body,
        written,
        body.length - written,
        row.offset + written,
      );
      if (!r.bytesWritten) throw new Error("Short write");
      written += r.bytesWritten;
    }
    await file.sync();
    // Permission/quota changes during disk I/O cannot commit an unauthorized block.
    getUpload(store, user, id);
    store.db.transaction(() => {
      store.db.run(
        "INSERT INTO upload_blocks(upload_id,start,length,hash) VALUES (?,?,?,?)",
        [id, row.offset, body.length, checksum],
      );
      store.db.run("UPDATE uploads SET offset=?,expires=? WHERE id=?", [
        row.offset + body.length,
        Date.now() + UPLOAD_RESERVATION_MS,
        id,
      ]);
    })();
  } finally {
    await file.close();
  }
  return { offset: row.offset + body.length };
}
export async function appendChunk(
  store: Store,
  user: User | null,
  id: string,
  req: IncomingMessage,
  bandwidth?: Bandwidth,
) {
  const release = leaseUpload(id);
  try {
    const row = getUpload(store, user, id),
      offset = Number(req.headers["upload-offset"]);
    if (!Number.isSafeInteger(offset) || offset !== row.offset)
      throw new HttpError(409, "転送位置を再確認してください");
    const encoded = await readBody(req, MAX_CHUNK, bandwidth);
    return await commitUploadBlock(
      store,
      user,
      id,
      offset,
      encoded,
      String(req.headers["upload-checksum"] ?? ""),
      req.headers["upload-encoding"] as string | undefined,
    );
  } finally {
    release();
  }
}
export async function completeUpload(
  store: Store,
  user: User | null,
  id: string,
  ip: string,
) {
  if (busy.has(id)) throw new HttpError(409, "転送中です");
  const row = getUpload(store, user, id);
  if (row.offset !== row.size)
    throw new HttpError(409, "転送が完了していません");
  busy.add(id);
  const source = join(store.tempDir, id),
    target = join(store.blobDir, id);
  try {
    if (!row.size && !existsSync(source) && !existsSync(target))
      await (await open(source, "wx", 0o600)).close();
    if (existsSync(source)) await rename(source, target);
    const file = await stat(target);
    if (file.size !== row.size)
      throw new HttpError(409, "転送データのサイズが一致しません");
    try {
      store.db.transaction(() => {
        getUpload(store, user, id);
        const policy = store.db
          .query(
            "SELECT retention_seconds FROM upload_policies WHERE upload_id=?",
          )
          .get(id) as { retention_seconds: number } | null;
        const retention = retentionSeconds(
          Math.min(
            policy?.retention_seconds ?? store.filePolicy.maxRetentionSeconds,
            store.filePolicy.maxRetentionSeconds,
          ),
          store.filePolicy.maxRetentionSeconds,
        );
        const created = Date.now();
        store.db.run(
          "INSERT INTO items(id,parent,owner,name,folder,size,mime,visibility,created) VALUES (?,?,?,?,0,?,?,?,?)",
          [
            id,
            row.parent,
            row.owner,
            row.name,
            row.size,
            row.mime,
            row.owner ? "private" : "public",
            created,
          ],
        );
        store.db.run(
          "INSERT INTO item_meta(item_id,uploaded_by,expires_at) VALUES (?,?,?)",
          [id, row.user_id, created + retention * 1000],
        );
        store.db.run("DELETE FROM uploads WHERE id=?", [id]);
      })();
    } catch (e) {
      await rename(target, source);
      throw e;
    }
    store.audit(ip, user, "upload", id);
    return safeItem(store, store.item(id)!);
  } finally {
    busy.delete(id);
  }
}
export async function cancelUpload(
  store: Store,
  user: User | null,
  id: string,
) {
  if (busy.has(id)) throw new HttpError(409, "転送中です");
  getUpload(store, user, id);
  busy.add(id);
  try {
    await unlink(join(store.tempDir, id)).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
    await unlink(join(store.blobDir, id)).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
    store.db.run("DELETE FROM uploads WHERE id=?", [id]);
    return { ok: true };
  } finally {
    busy.delete(id);
  }
}
export function mkdir(store: Store, user: User | null, data: any, ip: string) {
  const dest = destination(store, user, data.parent, data.space),
    id = randomUUID();
  store.db.run(
    "INSERT INTO items(id,parent,owner,name,folder,visibility,created) VALUES (?,?,?,?,1,?,?)",
    [
      id,
      dest.parent,
      dest.owner,
      validName(data.name),
      dest.owner ? "private" : "public",
      Date.now(),
    ],
  );
  store.audit(ip, user, "mkdir", id);
  return safeItem(store, store.item(id)!);
}
export function updateItem(
  store: Store,
  user: User | null,
  id: string,
  data: any,
  ip: string,
) {
  const item = writeItem(store, user, id);
  const name = data.name === undefined ? item.name : validName(data.name);
  const visibility = data.visibility ?? item.visibility;
  const level = data.min_level ?? item.min_level;
  let expiry: number | undefined;
  if (data.retentionSeconds !== undefined) {
    if (item.folder)
      throw new HttpError(400, "ファイルの保存期間を指定してください");
    expiry =
      item.created +
      retentionSeconds(
        data.retentionSeconds,
        store.filePolicy.maxRetentionSeconds,
      ) *
        1000;
    if (expiry <= Date.now())
      throw new HttpError(400, "指定した保存期間は投稿から既に経過しています");
  }
  if (
    !["private", "public", "invite"].includes(visibility) ||
    !Number.isInteger(level) ||
    level < 0 ||
    level > 4
  )
    throw new HttpError(400, "公開設定が不正です");
  // Owners can set audience restrictions on their own space; staff control shared space.
  let parent = item.parent;
  if ("parent" in data) {
    parent = data.parent === null ? null : String(data.parent);
    if (parent) {
      const target = writeItem(store, user, parent);
      if (!target.folder || target.owner !== item.owner)
        throw new HttpError(400, "同じ領域のフォルダを選択してください");
      let p: Item | null = target;
      while (p) {
        if (p.id === item.id)
          throw new HttpError(400, "循環する移動はできません");
        p = p.parent ? store.item(p.parent) : null;
      }
    }
  }
  let key: string | undefined;
  let keyHash = item.key_hash;
  if (visibility === "invite" && (!keyHash || data.rotateKey === true)) {
    key = randomToken();
    keyHash = digestToken(key);
  }
  store.db.transaction(() => {
    store.db.run(
      "UPDATE items SET name=?,parent=?,visibility=?,min_level=?,key_hash=? WHERE id=?",
      [
        name,
        parent,
        visibility,
        level,
        visibility === "invite" ? keyHash : null,
        id,
      ],
    );
    if (key || visibility !== item.visibility)
      store.db.run("DELETE FROM grants WHERE item_id=?", [id]);
    if (expiry !== undefined)
      store.db.run(
        "INSERT INTO item_meta(item_id,uploaded_by,expires_at) VALUES (?,?,?) ON CONFLICT(item_id) DO UPDATE SET expires_at=excluded.expires_at",
        [id, item.uploaded_by ?? item.owner, expiry],
      );
  })();
  store.audit(ip, user, "item.update", id);
  return { item: safeItem(store, store.item(id)!), ...(key ? { key } : {}) };
}
export function unlock(
  store: Store,
  user: User | null,
  id: string,
  key: unknown,
  ip: string,
) {
  const u = requireUser(user),
    item = store.item(id);
  if (!store.limit("unlock:" + ip, 10, 60_000))
    throw new HttpError(429, "試行回数が多すぎます");
  if (
    !item ||
    item.visibility !== "invite" ||
    u.level < Math.max(2, item.min_level) ||
    !item.key_hash ||
    typeof key !== "string" ||
    !equalDigest(digestToken(key), item.key_hash)
  )
    throw new HttpError(403, "キーまたは閲覧権限を確認してください");
  store.db.run(
    "INSERT INTO grants VALUES (?,?,?) ON CONFLICT(user_id,item_id) DO UPDATE SET expires=excluded.expires",
    [u.id, id, Date.now() + 86_400_000],
  );
  store.audit(ip, u, "invite.unlock", id);
  return { ok: true };
}
export function trashItems(
  store: Store,
  user: User | null,
  ids: unknown,
  ip: string,
) {
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > 200 ||
    ids.some((id) => typeof id !== "string")
  )
    throw new HttpError(400, "対象は1〜200件です");
  // Validate the entire selection before changing anything.
  for (const id of ids) writeItem(store, user, id);
  const now = Date.now();
  store.db.transaction(() => {
    for (const id of ids)
      store.db.run(
        `WITH RECURSIVE subtree(id) AS (SELECT id FROM items WHERE id=? UNION ALL SELECT i.id FROM items i JOIN subtree s ON i.parent=s.id) UPDATE items SET deleted=? WHERE id IN subtree`,
        [id, now],
      );
  })();
  store.audit(ip, user, "trash", ids.join(","));
  return { ok: true };
}
let maintenanceRunning = false;
export async function maintenance(
  store: Store,
  user: User | null,
  action: string,
  ids: unknown,
  ip: string,
) {
  requireAdmin(user);
  if (maintenanceRunning) throw new HttpError(409, "別の整理処理を実行中です");
  maintenanceRunning = true;
  try {
    return await performMaintenance(store, user, action, ids, ip);
  } finally {
    maintenanceRunning = false;
  }
}
async function performMaintenance(
  store: Store,
  user: User | null,
  action: string,
  ids: unknown,
  ip: string,
) {
  requireAdmin(user);
  if (action === "cleanup") {
    const result = await cleanup(store);
    store.audit(ip, user, "cleanup", JSON.stringify(result));
    return result;
  }
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > 200 ||
    ids.some((id) => typeof id !== "string")
  )
    throw new HttpError(400, "対象は1〜200件です");
  if (action === "restore") {
    store.db.transaction(() => {
      for (const id of ids) {
        const item = store.db
          .query("SELECT * FROM items WHERE id=? AND deleted IS NOT NULL")
          .get(id) as Item | null;
        if (!item) throw new HttpError(404, "ごみ箱に見つかりません");
        const meta = store.db
          .query("SELECT expires_at,purged FROM item_meta WHERE item_id=?")
          .get(id) as any;
        if (meta?.purged || (meta?.expires_at && meta.expires_at <= Date.now()))
          throw new HttpError(409, "保存期限を過ぎたファイルは復元できません");
        if (item.parent && !store.item(item.parent))
          throw new HttpError(409, "親フォルダを先に復元してください");
        store.db.run("UPDATE items SET deleted=NULL WHERE id=?", [id]);
      }
    })();
  } else if (action === "purge") {
    // Purge only explicit trash roots; descendants must all be trash too.
    for (const id of ids) {
      const root = store.db
        .query("SELECT * FROM items WHERE id=? AND deleted IS NOT NULL")
        .get(id) as Item | null;
      if (!root) throw new HttpError(409, "完全削除はごみ箱の項目のみです");
      const tree = store.db
        .query(
          `WITH RECURSIVE t(id,depth) AS (SELECT id,0 FROM items WHERE id=? UNION ALL SELECT i.id,t.depth+1 FROM items i JOIN t ON i.parent=t.id) SELECT i.*,t.depth FROM items i JOIN t ON i.id=t.id ORDER BY depth DESC`,
        )
        .all(id) as (Item & { depth: number })[];
      for (const i of tree)
        if (!i.deleted) throw new HttpError(409, "復元済みの子項目があります");
      for (const i of tree) {
        if (!i.folder) {
          await unlink(join(store.blobDir, i.id)).catch((e) => {
            if (e.code !== "ENOENT") throw e;
          });
          await unlink(join(store.cacheDir, i.id + ".mp4")).catch(() => {});
        }
        store.db.transaction(() => {
          store.db.run("DELETE FROM grants WHERE item_id=?", [i.id]);
          store.db.run("DELETE FROM items WHERE id=?", [i.id]);
        })();
      }
    }
  } else throw new HttpError(400, "不明な操作です");
  store.audit(ip, user, action, ids.join(","));
  return { ok: true };
}
const cleaning = new WeakSet<Store>();
export async function cleanup(store: Store, full = true) {
  if (cleaning.has(store)) return { uploads: 0, orphans: 0, expired: 0 };
  cleaning.add(store);
  try {
    const now = Date.now();
    let uploads = 0,
      orphans = 0;
    let expired = 0;
    for (const row of store.db
      .query("SELECT item_id FROM item_meta WHERE expires_at<=? AND purged=0")
      .all(now) as { item_id: string }[]) {
      if (busy.has(row.item_id)) continue;
      for (const path of [
        join(store.blobDir, row.item_id),
        join(store.cacheDir, row.item_id + ".mp4"),
      ])
        await unlink(path).catch((e) => {
          if (e.code !== "ENOENT") throw e;
        });
      store.db.transaction(() => {
        store.db.run("UPDATE item_meta SET purged=1 WHERE item_id=?", [
          row.item_id,
        ]);
        store.db.run(
          "UPDATE items SET deleted=COALESCE(deleted,?) WHERE id=?",
          [now, row.item_id],
        );
        store.db.run("DELETE FROM grants WHERE item_id=?", [row.item_id]);
        store.audit("local", null, "item.expire", row.item_id);
      })();
      expired++;
    }
    for (const row of store.db
      .query("SELECT id FROM uploads WHERE expires<?")
      .all(now) as { id: string }[]) {
      if (busy.has(row.id)) continue;
      await unlink(join(store.tempDir, row.id)).catch(() => {});
      await unlink(join(store.blobDir, row.id)).catch(() => {});
      store.db.run("DELETE FROM uploads WHERE id=?", [row.id]);
      uploads++;
    }
    if (!full) return { uploads, orphans, expired };
    for (const file of await readdir(store.tempDir)) {
      if (!/^[a-f0-9-]{36}$/.test(file) || busy.has(file)) continue;
      if (!store.db.query("SELECT 1 FROM uploads WHERE id=?").get(file)) {
        await unlink(join(store.tempDir, file));
        orphans++;
      }
    }
    // Never delete registered blobs, including trash or an upload awaiting finalization.
    for (const file of await readdir(store.blobDir)) {
      if (!/^[a-f0-9-]{36}$/.test(file) || busy.has(file)) continue;
      if (
        !store.db
          .query(
            "SELECT 1 FROM items WHERE id=? UNION SELECT 1 FROM uploads WHERE id=?",
          )
          .get(file, file)
      ) {
        await unlink(join(store.blobDir, file));
        orphans++;
      }
    }
    store.db.run("DELETE FROM sessions WHERE expires<?", [now]);
    store.db.run("DELETE FROM challenges WHERE expires<?", [now]);
    store.db.run("DELETE FROM device_enrollments WHERE expires<?", [now]);
    store.db.run("DELETE FROM grants WHERE expires<?", [now]);
    store.db.run("DELETE FROM limits WHERE expires<?", [now]);
    store.db.run("DELETE FROM download_receipts WHERE expires<?", [now]);
    store.db.run("DELETE FROM audit WHERE time<?", [now - 30 * 86_400_000]);
    return { uploads, orphans, expired };
  } finally {
    cleaning.delete(store);
  }
}
export class Bandwidth {
  private next = 0;
  constructor(public bytesPerSecond: number) {}
  async acquire(bytes: number) {
    // 0 disables application throttling. TCP congestion control still applies.
    if (this.bytesPerSecond === 0) return;
    const now = performance.now(),
      slot = Math.max(now, this.next);
    this.next = slot + (bytes / this.bytesPerSecond) * 1000;
    const delay = slot - now;
    if (delay > 0) await Bun.sleep(delay);
  }
}
export function byteRange(
  value: string | undefined,
  size: number,
): { start: number; end: number; partial: boolean } | null {
  if (!value) return { start: 0, end: size - 1, partial: false };
  const m = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!m || (!m[1] && !m[2]) || size === 0) return null;
  let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2])),
    end = m[1] ? (m[2] ? Number(m[2]) : size - 1) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  )
    return null;
  return { start, end: Math.min(end, size - 1), partial: true };
}
export async function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  item: Item,
  bandwidth: Bandwidth,
  download: boolean,
) {
  const size = (await stat(path)).size,
    range = byteRange(req.headers.range, size);
  if (!range) {
    res.writeHead(416, { "Content-Range": `bytes */${size}` });
    res.end();
    return false;
  }
  const ext = item.name.split(".").pop()?.toLowerCase() ?? "";
  // Never serve uploaded executable HTML/SVG/JS from the authenticated origin.
  const types: Record<string, string> = {
    pdf: "application/pdf",
    avif: "image/avif",
    bmp: "image/bmp",
    ico: "image/x-icon",
    m4a: "audio/mp4",
    flac: "audio/flac",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    mp4: "video/mp4",
    webm: "video/webm",
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    wav: "audio/wav",
    txt: "text/plain; charset=utf-8",
  };
  const mime = types[ext] ?? "application/octet-stream";
  const headers: Record<string, string> = {
    "Content-Type": mime,
    "Accept-Ranges": "bytes",
    "Content-Length": String(size ? range.end - range.start + 1 : 0),
    "Cache-Control": "private, no-store",
    "Content-Disposition": `${download || !types[ext] ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(item.name).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16))}`,
  };
  const compress =
    !req.headers.range &&
    size >= 32768 &&
    // Large downloads retain native Range resumption and avoid repeated CPU compression.
    size <= 8 * 1024 * 1024 &&
    compressibleName(item.name) &&
    acceptsGzip(req.headers["accept-encoding"]);
  if (compressibleName(item.name)) headers.Vary = "Accept-Encoding";
  if (compress) {
    delete headers["Content-Length"];
    headers["Content-Encoding"] = "gzip";
    headers["Accept-Ranges"] = "none";
  }
  if (range.partial)
    headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;
  res.writeHead(range.partial ? 206 : 200, headers);
  if (req.method === "HEAD" || !size) {
    const sent = await finishResponse(res);
    return req.method !== "HEAD" && sent;
  }
  const stream = createReadStream(path, {
    start: range.start,
    end: range.end,
    highWaterMark: 256 * 1024,
  });
  const output = compress
    ? stream.pipe(createGzip({ level: 1, chunkSize: 64 * 1024 }))
    : stream;
  const close = () => {
    stream.destroy();
    if (output !== stream) output.destroy();
  };
  const sourceError = (error: Error) => output.destroy(error);
  if (output !== stream) stream.on("error", sourceError);
  res.once("close", close);
  try {
    for await (const chunk of output) {
      if (res.destroyed) break;
      await bandwidth.acquire(chunk.length);
      if (res.destroyed) break;
      if (!res.write(chunk))
        await new Promise<void>((resolve) => {
          const done = () => {
            res.off("drain", done);
            res.off("close", done);
            resolve();
          };
          res.once("drain", done);
          res.once("close", done);
        });
    }
    return await finishResponse(res);
  } finally {
    res.off("close", close);
    stream.off("error", sourceError);
    close();
  }
}
function finishResponse(res: ServerResponse): Promise<boolean> {
  if (res.destroyed) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = () => {
      res.off("close", close);
      resolve(true);
    };
    const close = () => {
      res.off("finish", finish);
      resolve(false);
    };
    res.once("finish", finish);
    res.once("close", close);
    res.end();
  });
}
