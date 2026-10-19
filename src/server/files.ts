import { digestToken } from "@pexserver/secure-envelope";
import { ITEM_SELECT, type Store, type User, type Item } from "./store";
import { canRead, HttpError } from "./policy";
import { safeItem } from "./storage";
import { retentionSeconds } from "./settings";
export function ranking(store: Store, user: User | null, admin = false) {
  if (!admin && !store.filePolicy.rankingEnabled) return { items: [] };
  const rows = store.db
    .query(
      ITEM_SELECT +
        ` WHERE i.folder=0 AND i.deleted IS NULL AND COALESCE(m.purged,0)=0 AND (m.expires_at IS NULL OR m.expires_at>?) ${admin ? "" : "AND i.visibility='public'"} ORDER BY COALESCE(m.downloads,0) DESC,i.created DESC LIMIT 1000`,
    )
    .all(Date.now()) as Item[];
  return {
    items: rows
      .filter((i) => admin || canRead(store, user, i))
      .slice(0, 20)
      .map((i) => (admin ? i : safeItem(store, i))),
  };
}
export function recordDownload(
  store: Store,
  id: string,
  ticket: string,
  ttl = 600000,
) {
  if (!store.filePolicy.trackDownloads) return;
  store.db.transaction(() => {
    if (
      !store.db
        .query(
          "INSERT OR IGNORE INTO download_receipts VALUES (?,?,?) RETURNING hash",
        )
        .get(digestToken(ticket), id, Date.now() + ttl)
    )
      return;
    store.db.run("UPDATE item_meta SET downloads=downloads+1 WHERE item_id=?", [
      id,
    ]);
  })();
}
export async function fileAdminAction(
  store: Store,
  admin: User,
  ip: string,
  path: string,
  method: string,
  url: URL,
  read: () => Promise<any>,
) {
  if (path === "/api/admin/rankings" && method === "GET")
    return ranking(store, admin, true);
  if (path === "/api/admin/files" && method === "GET") {
    const offset = Number(url.searchParams.get("offset") ?? 0),
      query = (url.searchParams.get("q") ?? "").slice(0, 80);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000)
      throw new HttpError(400, "ページ指定が不正です");
    const rows = store.db
      .query(
        ITEM_SELECT +
          " WHERE i.folder=0 AND i.deleted IS NULL AND COALESCE(m.purged,0)=0 AND i.name LIKE ? ORDER BY i.created DESC,i.id DESC LIMIT 101 OFFSET ?",
      )
      .all("%" + query + "%", offset) as Item[];
    return {
      items: rows.slice(0, 100),
      next: rows.length > 100 ? offset + 100 : null,
    };
  }
  const match = /^\/api\/admin\/files\/([a-f0-9-]{36})$/.exec(path);
  if (match && method === "PATCH") {
    const item = store.item(match[1]),
      body = await read();
    if (
      !item ||
      item.folder ||
      item.purged ||
      (item.expires_at != null && item.expires_at <= Date.now())
    )
      throw new HttpError(404, "有効なファイルが見つかりません");
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new HttpError(400, "設定が不正です");
    const downloads = body.downloads ?? item.downloads ?? 0,
      uploader =
        body.uploadedBy === undefined
          ? (item.uploaded_by ?? null)
          : body.uploadedBy;
    if (
      !Number.isSafeInteger(downloads) ||
      downloads < 0 ||
      downloads > 1e12 ||
      (uploader !== null &&
        (typeof uploader !== "string" || !store.user(uploader)))
    )
      throw new HttpError(400, "ダウンロード数または投稿者が不正です");
    let expiry = item.expires_at ?? null;
    if (body.retentionSeconds === 0) expiry = null;
    else if (body.retentionSeconds !== undefined) {
      expiry =
        item.created +
        retentionSeconds(
          body.retentionSeconds,
          store.filePolicy.maxRetentionSeconds,
        ) *
          1000;
      if (expiry <= Date.now())
        throw new HttpError(
          400,
          "指定した保存期間は投稿から既に経過しています",
        );
    }
    store.db.transaction(() => {
      store.db.run(
        "INSERT INTO item_meta(item_id,uploaded_by,expires_at,downloads) VALUES (?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET uploaded_by=excluded.uploaded_by,expires_at=excluded.expires_at,downloads=excluded.downloads",
        [item.id, uploader, expiry, downloads],
      );
      store.audit(
        ip,
        admin,
        "file.metadata",
        JSON.stringify({
          id: item.id,
          name: item.name,
          downloads,
          uploadedBy: uploader,
          expiresAt: expiry,
        }),
      );
    })();
    return { ok: true };
  }
  return undefined;
}
