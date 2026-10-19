import { ITEM_SELECT, type Store, type User, type Item } from "./store";
import { HttpError, canRead, requireUser } from "./policy";
import { safeItem } from "./storage";
export const profileAllowed = (user: User) =>
  [1, 3, 4].includes(user.level) && user.status === "approved";
export function profile(store: Store, id: string, own = false) {
  const user = store.user(id);
  if (
    (!own && !store.filePolicy.showUploaders) ||
    !user ||
    user.status !== "approved"
  )
    throw new HttpError(404, "ユーザーが見つかりません");
  const row = profileAllowed(user)
    ? (store.db.query("SELECT * FROM profiles WHERE user_id=?").get(id) as any)
    : null;
  return {
    id: user.id,
    name: user.name,
    displayName: row?.display_name || user.name,
    location: row?.location ?? "",
    coverPosition: row?.cover_position ?? 50,
    cover: row?.cover_type
      ? own
        ? `data:${row.cover_type};base64,${Buffer.from(row.cover).toString("base64")}`
        : `/api/users/${encodeURIComponent(id)}/cover`
      : null,
    bio: row?.bio ?? "",
    links: row ? JSON.parse(row.links) : [],
    avatar: row?.avatar_type
      ? own
        ? `data:${row.avatar_type};base64,${Buffer.from(row.avatar).toString("base64")}`
        : `/api/users/${encodeURIComponent(id)}/avatar`
      : null,
  };
}
export function saveProfile(
  store: Store,
  current: User | null,
  body: any,
  ip: string,
) {
  const user = requireUser(current);
  if (!profileAllowed(user))
    throw new HttpError(
      403,
      "プロフィールの編集はVIP・スタッフ・管理者のみ利用できます",
    );
  if (
    !body ||
    typeof body.bio !== "string" ||
    body.bio.length > 2000 ||
    !Array.isArray(body.links) ||
    body.links.length > 8
  )
    throw new HttpError(400, "説明は2000文字、リンクは8件までです");
  const links = body.links.map((link: any) => {
    if (
      typeof link?.label !== "string" ||
      !link.label.trim() ||
      link.label.length > 40 ||
      typeof link.url !== "string" ||
      link.url.length > 2048
    )
      throw new HttpError(400, "SNSリンクを確認してください");
    let url: URL;
    try {
      url = new URL(link.url);
    } catch {
      throw new HttpError(400, "リンクはHTTPSのURLを指定してください");
    }
    if (url.protocol !== "https:" || url.username || url.password)
      throw new HttpError(400, "リンクはHTTPSのURLを指定してください");
    return { label: link.label.trim(), url: url.href };
  });
  const old = store.db
    .query("SELECT * FROM profiles WHERE user_id=?")
    .get(user.id) as any;
  const displayName =
    body.displayName === undefined
      ? (old?.display_name ?? "")
      : body.displayName;
  const location =
    body.location === undefined ? (old?.location ?? "") : body.location;
  const coverPosition =
    body.coverPosition === undefined
      ? (old?.cover_position ?? 50)
      : body.coverPosition;
  if (
    typeof displayName !== "string" ||
    displayName.length > 50 ||
    typeof location !== "string" ||
    location.length > 80 ||
    /[\u0000-\u001f\u007f]/.test(displayName + location) ||
    !Number.isInteger(coverPosition) ||
    coverPosition < 0 ||
    coverPosition > 100
  )
    throw new HttpError(
      400,
      "表示名は50文字、所在地は80文字以内で指定してください",
    );
  const decodeImage = (
    value: unknown,
    kind: "avatar" | "cover",
    max: number,
  ) => {
    if (value === undefined)
      return [old?.[kind] ?? null, old?.[kind + "_type"] ?? null];
    if (value === null) return [null, null];
    if (typeof value !== "string" || value.length > Math.ceil(max / 3) * 4 + 64)
      throw new HttpError(400, "画像のサイズが上限を超えています");
    const match =
      /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(
        value,
      );
    if (!match)
      throw new HttpError(400, "画像はPNG・JPEG・WebPを指定してください");
    const bytes = Buffer.from(match[2], "base64");
    const valid =
      match[1] === "image/png"
        ? bytes
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : match[1] === "image/jpeg"
          ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          : bytes.toString("ascii", 0, 4) === "RIFF" &&
            bytes.toString("ascii", 8, 12) === "WEBP";
    if (!valid || bytes.length > max)
      throw new HttpError(400, "画像の形式またはサイズを確認してください");
    return [bytes, match[1]];
  };
  const [avatar, avatarType] = decodeImage(body.avatar, "avatar", 256 * 1024);
  const [cover, coverType] = decodeImage(body.cover, "cover", 768 * 1024);
  store.db.run(
    "INSERT INTO profiles(user_id,bio,links,avatar,avatar_type,display_name,location,cover,cover_type,cover_position) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET bio=excluded.bio,links=excluded.links,avatar=excluded.avatar,avatar_type=excluded.avatar_type,display_name=excluded.display_name,location=excluded.location,cover=excluded.cover,cover_type=excluded.cover_type,cover_position=excluded.cover_position",
    [
      user.id,
      body.bio,
      JSON.stringify(links),
      avatar,
      avatarType,
      displayName.trim(),
      location.trim(),
      cover,
      coverType,
      coverPosition,
    ],
  );
  store.audit(ip, user, "profile.update");
  return { ok: true };
}
export function userFiles(
  store: Store,
  user: User | null,
  id: string,
  offset: number,
) {
  const author = profile(store, id);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000)
    throw new HttpError(400, "ページ指定が不正です");
  const rows = store.db
    .query(
      ITEM_SELECT +
        " WHERE m.uploaded_by=? AND i.folder=0 AND i.deleted IS NULL ORDER BY i.created DESC,i.id DESC LIMIT 201 OFFSET ?",
    )
    .all(id, offset) as Item[];
  return {
    profile: author,
    items: rows
      .slice(0, 200)
      .filter((i) => canRead(store, user, i))
      .map((i) => safeItem(store, i)),
    next: rows.length > 200 ? offset + 200 : null,
  };
}
export function uploaderRanking(store: Store, user: User | null) {
  if (!store.filePolicy.rankingEnabled || !store.filePolicy.showUploaders)
    return { users: [] };
  const rows = store.db
    .query(
      ITEM_SELECT +
        " WHERE i.folder=0 AND i.visibility='public' AND i.deleted IS NULL AND m.uploaded_by IS NOT NULL ORDER BY COALESCE(m.downloads,0) DESC LIMIT 10000",
    )
    .all() as Item[];
  const totals = new Map<
    string,
    { id: string; name: string; downloads: number | null; files: number }
  >();
  for (const item of rows) {
    if (
      !canRead(store, user, item) ||
      !item.uploaded_by ||
      !item.uploader_name ||
      store.user(item.uploaded_by)?.status !== "approved"
    )
      continue;
    let row = totals.get(item.uploaded_by);
    if (!row) {
      row = {
        id: item.uploaded_by,
        name: item.uploader_name,
        downloads: store.filePolicy.showDownloadCounts ? 0 : null,
        files: 0,
      };
      totals.set(row.id, row);
    }
    row.files++;
    if (row.downloads !== null) row.downloads += item.downloads ?? 0;
  }
  return {
    users: [...totals.values()]
      .sort((a, b) => (b.downloads ?? b.files) - (a.downloads ?? a.files))
      .slice(0, 50),
  };
}

/** Only discover authors with at least one file this viewer can actually read. */
export function searchUploaders(
  store: Store,
  user: User | null,
  query: string,
  after: string,
) {
  if (
    query.length > 64 ||
    after.length > 32 ||
    (after && !/^[a-z0-9_-]{2,32}$/i.test(after))
  )
    throw new HttpError(400, "検索条件が不正です");
  if (!store.filePolicy.showUploaders)
    return { users: [], next: null, enabled: false };
  const pattern =
    "%" +
    query
      .normalize("NFC")
      .trim()
      .replace(/[\\%_]/g, "\\$&") +
    "%";
  const candidates = store.db.prepare(
    `SELECT u.id,u.name FROM users u LEFT JOIN profiles p ON p.user_id=u.id WHERE u.status='approved' AND (u.name LIKE ? ESCAPE '\\' OR (u.level IN (1,3,4) AND p.display_name LIKE ? ESCAPE '\\')) AND u.name>? COLLATE NOCASE AND EXISTS (SELECT 1 FROM item_meta m JOIN items i ON i.id=m.item_id WHERE m.uploaded_by=u.id AND i.folder=0 AND i.deleted IS NULL AND m.purged=0 AND (m.expires_at IS NULL OR m.expires_at>?) ${user ? "" : "AND i.visibility='public' AND i.min_level=0"}) ORDER BY u.name COLLATE NOCASE,u.id`,
  );
  const users: ReturnType<typeof profile>[] = [];
  try {
    for (const author of candidates.iterate(
      pattern,
      pattern,
      after,
      Date.now(),
    ) as Iterable<{ id: string; name: string }>) {
      const files = store.db.prepare(
        ITEM_SELECT +
          " WHERE m.uploaded_by=? AND i.folder=0 AND i.deleted IS NULL AND m.purged=0 AND (m.expires_at IS NULL OR m.expires_at>?)",
      );
      try {
        for (const item of files.iterate(
          author.id,
          Date.now(),
        ) as Iterable<Item>) {
          if (canRead(store, user, item)) {
            users.push(profile(store, author.id));
            break;
          }
        }
      } finally {
        files.finalize();
      }
      if (users.length === 25) break;
    }
  } finally {
    candidates.finalize();
  }
  return {
    users: users.slice(0, 24),
    next: users.length > 24 ? users[23].name : null,
    enabled: true,
  };
}
