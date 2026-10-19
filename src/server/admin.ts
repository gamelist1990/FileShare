import { randomUUID } from "node:crypto";
import { randomToken, digestToken } from "@pexserver/secure-envelope";
import type { Store, User } from "./store";
import { HttpError } from "./policy";
import { validateAISettings, validateFilePolicy } from "./settings";
import { fileAdminAction } from "./files";

export function staffInvitation(store: Store, hash: string) {
  return store.db
    .query(
      `SELECT i.id FROM staff_invites i JOIN users u ON u.id=i.created_by
    WHERE i.hash=? AND i.revoked=0 AND i.expires>? AND i.uses<i.max_uses AND u.level=4 AND u.status='approved'`,
    )
    .get(hash, Date.now()) as { id: string } | null;
}
export function jstDay() {
  return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
}
function dayStart(day: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day))
    throw new HttpError(400, "日付が不正です");
  const utc = Date.parse(day + "T00:00:00Z");
  if (!Number.isFinite(utc) || new Date(utc).toISOString().slice(0, 10) !== day)
    throw new HttpError(400, "日付が不正です");
  return utc - 9 * 3600000;
}
const reviewActions =
  "('register','staff.register','user.update','application.deny','staff-invite.create','staff-invite.revoke','ai.settings','file.metadata','file.settings')";
export async function adminAction(
  store: Store,
  admin: User,
  ip: string,
  path: string,
  method: string,
  url: URL,
  read: () => Promise<any>,
) {
  const objectBody = async () => {
    const body = await read();
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new HttpError(400, "入力形式が不正です");
    return body;
  };
  if (path === "/api/admin/settings" && method === "GET")
    return { ai: store.config.ai, files: store.filePolicy };
  if (path === "/api/admin/settings" && method === "PATCH") {
    const body = await objectBody();
    if (body.ai === undefined && body.files === undefined)
      throw new HttpError(400, "設定を指定してください");
    const ai = body.ai === undefined ? null : validateAISettings(body.ai);
    const files =
      body.files === undefined
        ? null
        : validateFilePolicy(body.files, store.config.capacityBytes);
    store.db.transaction(() => {
      if (ai) {
        store.db.run(
          "INSERT INTO admin_settings VALUES ('ai',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          [JSON.stringify(ai)],
        );
        store.audit(ip, admin, "ai.settings", JSON.stringify(ai));
      }
      if (files) {
        store.db.run(
          "INSERT INTO admin_settings VALUES ('files',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          [JSON.stringify(files)],
        );
        store.audit(ip, admin, "file.settings", JSON.stringify(files));
      }
    })();
    if (ai) Object.assign(store.config.ai, ai);
    if (files) store.filePolicy = files;
    return { ai: store.config.ai, files: store.filePolicy };
  }
  if (path === "/api/admin/applications/deny" && method === "POST") {
    const { ids } = await objectBody();
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 1000 ||
      ids.some((id) => typeof id !== "string") ||
      new Set(ids).size !== ids.length
    )
      throw new HttpError(400, "無効化する申請を1〜1000件選択してください");
    store.db.transaction(() => {
      for (const id of ids) {
        const u = store.user(id);
        if (!u || u.status !== "pending" || u.level === 4)
          throw new HttpError(
            409,
            "承認待ち以外のユーザーが含まれています。一覧を更新してください",
          );
      }
      for (const id of ids) {
        store.db.run("UPDATE users SET status='denied' WHERE id=?", [id]);
        store.db.run("DELETE FROM sessions WHERE user_id=?", [id]);
        store.audit(ip, admin, "application.deny", id);
      }
    })();
    return { ok: true, count: ids.length };
  }
  if (path === "/api/admin/staff-invites" && method === "GET") {
    return {
      invites: store.db
        .query(
          "SELECT id,label,expires,max_uses,uses,created,created_by,revoked FROM staff_invites ORDER BY created DESC,id DESC LIMIT 200",
        )
        .all(),
    };
  }
  if (path === "/api/admin/staff-invites" && method === "POST") {
    const body = await objectBody(),
      label = String(body.label ?? "スタッフ招待").trim();
    const hours = body.hours ?? 168,
      maxUses = body.maxUses ?? 1;
    if (
      !label ||
      label.length > 80 ||
      /[\x00-\x1f\x7f]/.test(label) ||
      !Number.isInteger(hours) ||
      hours < 1 ||
      hours > 720 ||
      !Number.isInteger(maxUses) ||
      maxUses < 1 ||
      maxUses > 100
    )
      throw new HttpError(
        400,
        "招待名・有効期限（1〜720時間）・利用回数（1〜100回）を確認してください",
      );
    const id = randomUUID(),
      token = randomToken(),
      expires = Date.now() + hours * 3600000;
    store.db.transaction(() => {
      store.db.run(
        "INSERT INTO staff_invites (id,hash,label,expires,max_uses,created,created_by) VALUES (?,?,?,?,?,?,?)",
        [id, digestToken(token), label, expires, maxUses, Date.now(), admin.id],
      );
      store.audit(ip, admin, "staff-invite.create", id);
    })();
    return {
      id,
      url: store.config.origin + "/#staff-invite=" + encodeURIComponent(token),
      expires,
      maxUses,
    };
  }
  if (path === "/api/admin/staff-invites/revoke" && method === "POST") {
    const { id } = await objectBody();
    store.db.transaction(() => {
      const row = store.db
        .query(
          "UPDATE staff_invites SET revoked=1 WHERE id=? AND revoked=0 RETURNING id",
        )
        .get(String(id ?? ""));
      if (!row) throw new HttpError(404, "有効な招待が見つかりません");
      store.audit(ip, admin, "staff-invite.revoke", String(id));
    })();
    return { ok: true };
  }
  if (path === "/api/admin/audit/dates" && method === "GET") {
    const month = url.searchParams.get("month") ?? jstDay().slice(0, 7);
    const start = dayStart(month + "-01"),
      endDate = new Date(start + 9 * 3600000);
    endDate.setUTCMonth(endDate.getUTCMonth() + 1);
    const end = endDate.getTime() - 9 * 3600000;
    const scope =
      url.searchParams.get("scope") === "review"
        ? ` AND action IN ${reviewActions}`
        : "";
    return {
      month,
      days: store.db
        .query(
          `SELECT strftime('%Y-%m-%d',time/1000,'unixepoch','+9 hours') AS day,count(*) AS count FROM audit WHERE time>=? AND time<?${scope} GROUP BY day ORDER BY day DESC`,
        )
        .all(start, end),
    };
  }
  if (path === "/api/admin/audit" && method === "GET") {
    const day = url.searchParams.get("date") ?? jstDay(),
      start = dayStart(day);
    const before = url.searchParams.has("before")
      ? Number(url.searchParams.get("before"))
      : Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(before) || before < 1)
      throw new HttpError(400, "ページ指定が不正です");
    const scope =
      url.searchParams.get("scope") === "review"
        ? ` AND action IN ${reviewActions}`
        : "";
    const rows = store.db
      .query(
        `SELECT a.*,u.name AS actor FROM audit a LEFT JOIN users u ON u.id=a.user_id WHERE a.time>=? AND a.time<? AND a.id<?${scope} ORDER BY a.id DESC LIMIT 101`,
      )
      .all(start, start + 86400000, before) as any[];
    return {
      day,
      entries: rows.slice(0, 100),
      next: rows.length > 100 ? rows[99].id : null,
    };
  }
  return fileAdminAction(store, admin, ip, path, method, url, objectBody);
}
