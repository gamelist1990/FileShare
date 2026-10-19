import type { Store, User, Item } from "./store";
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function requireUser(user: User | null): User {
  if (!user || user.status !== "approved")
    throw new HttpError(401, "ログインと管理者の承認が必要です");
  return user;
}
export function requireAdmin(user: User | null): User {
  const u = requireUser(user);
  if (u.level !== 4) throw new HttpError(403, "管理者のみアクセスできます");
  return u;
}
export function canRead(
  store: Store,
  user: User | null,
  item: Item,
  seen = new Set<string>(),
): boolean {
  if (
    item.deleted ||
    item.purged ||
    (item.expires_at != null && item.expires_at <= Date.now()) ||
    seen.has(item.id) ||
    seen.size >= 64
  )
    return false;
  if (user?.level === 4) return true;
  seen.add(item.id);
  if (item.parent) {
    const parent = store.item(item.parent);
    if (!parent || !canRead(store, user, parent, seen)) return false;
  }
  if (user && item.owner === user.id) return true;
  // Staff manage shared space, never another user's private space.
  if (!item.owner && user && user.level >= 3) return true;
  if (item.visibility === "private") return false;
  if (item.visibility === "invite") {
    if (!user || user.level < Math.max(2, item.min_level)) return false;
    return !!store.db
      .query("SELECT 1 FROM grants WHERE user_id=? AND item_id=? AND expires>?")
      .get(user.id, item.id, Date.now());
  }
  return item.visibility === "public" && (user?.level ?? 0) >= item.min_level;
}
export function canWrite(
  user: User | null,
  owner: string | null,
  store: Store,
): boolean {
  return (
    !!user &&
    user.status === "approved" &&
    (user.level === 4 ||
      (owner === user.id && user.level >= 1) ||
      (!owner &&
        (user.level >= 3 ||
          (user.level === 1 && store.registrationPolicy.vipSharedEditing))))
  );
}
export function canUpload(
  store: Store,
  user: User | null,
  owner: string | null,
): boolean {
  return (
    canWrite(user, owner, store) ||
    (!!user &&
      user.status === "approved" &&
      owner === null &&
      ((user.level === 0 && store.registrationPolicy.generalUploads) ||
        (user.level === 1 && store.registrationPolicy.vipSharedUploads)))
  );
}
export function readItem(store: Store, user: User | null, id: string): Item {
  const i = store.item(id);
  if (!i || !canRead(store, user, i))
    throw new HttpError(404, "ファイルが見つかりません");
  return i;
}
export function writeItem(store: Store, user: User | null, id: string): Item {
  const i = readItem(store, user, id);
  if (!canWrite(user, i.owner, store))
    throw new HttpError(403, "編集権限がありません");
  return i;
}
export function validName(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "名前が必要です");
  const name = value.normalize("NFC").trim();
  if (
    !name ||
    name.length > 180 ||
    /[\x00-\x1f\x7f/\\\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u.test(name) ||
    name === "." ||
    name === ".."
  )
    throw new HttpError(400, "使用できない名前です");
  return name;
}
export function destination(
  store: Store,
  user: User | null,
  parent: unknown,
  space: unknown,
  uploadOnly = false,
) {
  const u = requireUser(user);
  let owner: string | null = space === "private" ? u.id : null;
  let parentId: string | null = null;
  if (parent) {
    if (typeof parent !== "string")
      throw new HttpError(400, "親フォルダが不正です");
    const item = uploadOnly
      ? readItem(store, u, parent)
      : writeItem(store, u, parent);
    if (!item.folder) throw new HttpError(400, "フォルダを指定してください");
    owner = item.owner;
    parentId = item.id;
  }
  if (!(uploadOnly ? canUpload(store, u, owner) : canWrite(u, owner, store)))
    throw new HttpError(403, "この領域には書き込めません");
  return { owner, parent: parentId };
}
