import { ITEM_SELECT, type Store } from "./store";
import { canRead, HttpError } from "./policy";
import { safeItem } from "./storage";
export function searchPublic(store: Store, url: URL) {
  const q = (url.searchParams.get("q") ?? "").trim(),
    tag = (url.searchParams.get("tag") ?? "")
      .normalize("NFC")
      .trim()
      .toLocaleLowerCase(),
    offset = Number(url.searchParams.get("offset") ?? 0);
  if (
    q.length > 120 ||
    tag.length > 32 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 1000000
  )
    throw new HttpError(400, "検索条件を確認してください");
  const pattern = "%" + q.replace(/[\\%_]/g, "\\$&") + "%";
  const rows = store.db.prepare(
    ITEM_SELECT +
      ` WHERE i.folder=0 AND i.visibility='public' AND i.min_level=0 AND i.deleted IS NULL AND COALESCE(m.purged,0)=0 AND (m.expires_at IS NULL OR m.expires_at>?) AND (i.name LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM item_tags t WHERE t.item_id=i.id AND t.tag LIKE ? ESCAPE '\\')) AND (?='' OR EXISTS(SELECT 1 FROM item_tags t WHERE t.item_id=i.id AND t.tag=?)) ORDER BY i.created DESC,i.id DESC LIMIT 201 OFFSET ?`,
  );
  try {
    const items = [];
    let scanned = 0;
    for (const item of rows.iterate(
      Date.now(),
      pattern,
      pattern,
      tag,
      tag,
      offset,
    ) as Iterable<any>) {
      scanned++;
      if (canRead(store, null, item)) {
        if (items.length === 24) return { items, next: offset + scanned - 1 };
        items.push(safeItem(store, item));
      }
    }
    return { items, next: scanned === 201 ? offset + scanned : null };
  } finally {
    rows.finalize();
  }
}
