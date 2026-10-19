import { open } from "node:fs/promises";
import { join } from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import { digestToken } from "@pexserver/secure-envelope";
import type { Store, User, Item } from "./store";
import { HttpError, readItem } from "./policy";
import { getUpload, safeItem } from "./storage";
import { retentionSeconds } from "./settings";
import { setItemTags } from "./tags";
import { recordDownload } from "./files";
export function pendingEdge(store: Store, id: string) {
  return !!store.db
    .query("SELECT 1 FROM edge_files WHERE item_id=? AND pending=1")
    .get(id);
}
export function publishEdge(
  store: Store,
  user: User | null,
  id: string,
  ip: string,
) {
  const old = store.item(id);
  if (old) {
    if (old.uploaded_by !== user?.id)
      throw new HttpError(403, "転送の所有者を確認できません");
    return safeItem(store, old);
  }
  const row = getUpload(store, user, id),
    policy = store.db
      .query("SELECT retention_seconds FROM upload_policies WHERE upload_id=?")
      .get(id) as any;
  const duration = retentionSeconds(
    Math.min(
      policy?.retention_seconds ?? store.filePolicy.maxRetentionSeconds,
      store.filePolicy.maxRetentionSeconds,
    ),
    store.filePolicy.maxRetentionSeconds,
    !!user && [1, 3, 4].includes(user.level),
  );
  store.db.transaction(() => {
    const now = Date.now();
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
        now,
      ],
    );
    store.db.run(
      "INSERT INTO item_meta(item_id,uploaded_by,expires_at) VALUES (?,?,?)",
      [id, row.user_id, duration === 0 ? null : now + duration * 1000],
    );
    store.db.run("INSERT INTO edge_files VALUES (?,1)", [id]);
    const tags = store.db
      .query("SELECT tags FROM upload_tags WHERE upload_id=?")
      .get(id) as any;
    if (tags) setItemTags(store, id, JSON.parse(tags.tags));
    store.db.run("UPDATE uploads SET expires=? WHERE id=?", [
      Date.now() + 86400000,
      id,
    ]);
    store.audit(ip, user, "upload", id);
  })();
  return safeItem(store, store.item(id)!);
}
export type ContentTicket = {
  id: string;
  ip: string;
  session: string | null;
  user: string | null;
  expires: number;
  download: boolean;
  receipt: string | null;
};
export function signContent(secret: string, ticket: ContentTicket) {
  const payload = Buffer.from(JSON.stringify(ticket)).toString("base64url");
  return (
    payload +
    "." +
    createHmac("sha256", secret)
      .update("edge-content-v1." + payload)
      .digest("base64url")
  );
}
export function verifyContent(
  secret: string,
  value: string,
  ip: string,
  commit = false,
) {
  if (typeof value !== "string" || value.length > 4096)
    throw new HttpError(401, "配信認証を確認できません");
  const [p, s, x] = value.split(".");
  if (!p || !s || x !== undefined)
    throw new HttpError(401, "配信認証を確認できません");
  const expected = createHmac("sha256", secret)
      .update("edge-content-v1." + p)
      .digest(),
    actual = Buffer.from(s, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new HttpError(401, "配信認証を確認できません");
  let ticket: ContentTicket;
  try {
    ticket = JSON.parse(Buffer.from(p, "base64url").toString());
  } catch {
    throw new HttpError(401, "配信認証を確認できません");
  }
  if (
    !/^[a-f0-9-]{36}$/.test(ticket.id) ||
    ticket.ip !== ip ||
    !Number.isSafeInteger(ticket.expires) ||
    ticket.expires + (commit ? 86400000 : 0) < Date.now() ||
    typeof ticket.download !== "boolean"
  )
    throw new HttpError(401, "配信認証が期限切れです");
  return ticket;
}
export function authorizeContent(store: Store, secret: string, body: any) {
  const ticket = verifyContent(
    secret,
    body.ticket,
    body.ip,
    body.commit === true,
  );
  let user: User | null = null;
  if (ticket.user) {
    if (!ticket.session) throw new HttpError(403, "ログイン状態が変わりました");
    const session = store.db
      .query(
        "SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.hash=? AND u.id=? AND s.expires>? AND u.status='approved'",
      )
      .get(ticket.session, ticket.user, Date.now()) as User | null;
    if (!session) throw new HttpError(403, "ログイン状態が変わりました");
    user = session;
  }
  const item = readItem(store, user, ticket.id);
  if (item.folder) throw new HttpError(400, "ファイルを選択してください");
  if (body.commit === true && ticket.download && ticket.receipt)
    recordDownload(store, item.id, "edge:" + ticket.receipt, 86400000);
  return {
    id: item.id,
    name: item.name,
    size: item.size,
    mime: item.mime,
    pending: pendingEdge(store, item.id),
    download: ticket.download,
  };
}
export function contentLocation(
  store: Store,
  secret: string,
  item: Item,
  ip: string,
  user: User | null,
  sessionToken: string,
  download: boolean,
  receipt: string | null,
) {
  const token = signContent(secret, {
    id: item.id,
    ip,
    user: user?.id ?? null,
    session: user ? digestToken(sessionToken) : null,
    expires: Date.now() + 24 * 3600_000,
    download,
    receipt: receipt ? digestToken(receipt) : null,
  });
  return `${store.config.edgeSpool.path}/${item.id}/content?token=${encodeURIComponent(token)}`;
}

// Only the already-fsynced, committed prefix may be read while replication runs.
// Bound each request so the edge can forward bytes without buffering a whole file.
export async function readDurablePrefix(
  store: Store,
  id: string,
  offset: number,
  length: number,
) {
  const item = store.item(id);
  if (!item) throw new HttpError(404, "ファイルが見つかりません");
  const upload = store.db
    .query("SELECT offset FROM uploads WHERE id=?")
    .get(id) as { offset: number } | null;
  const available = pendingEdge(store, id) ? (upload?.offset ?? 0) : item.size;
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 1 ||
    length > 256 * 1024 ||
    offset + length > available
  )
    throw new HttpError(409, "A8の保存が確定していない範囲です");
  let file;
  try {
    file = await open(
      upload ? join(store.tempDir, id) : store.blobPath(id),
      "r",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !upload)
      throw error;
    // Completion may atomically rename the temporary file after the snapshot.
    file = await open(store.uploadPath(id), "r");
  }
  try {
    const bytes = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
      const result = await file.read(bytes, done, length - done, offset + done);
      if (!result.bytesRead)
        throw new HttpError(503, "A8の保存データが途中で切れています");
      done += result.bytesRead;
    }
    return bytes;
  } finally {
    await file.close();
  }
}
