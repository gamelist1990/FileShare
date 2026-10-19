import type { Store } from "./store";
import { HttpError } from "./policy";
export function validateTags(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 10 ||
    value.some(
      (t) =>
        typeof t !== "string" ||
        t.trim().length < 1 ||
        t.length > 32 ||
        /[\x00-\x1f\x7f]/.test(t),
    )
  )
    throw new HttpError(400, "タグは1〜32文字で10個まで指定してください");
  return [
    ...new Set(value.map((t) => t.normalize("NFC").trim().toLocaleLowerCase())),
  ];
}
export const itemTags = (store: Store, id: string) =>
  (
    store.db
      .query("SELECT tag FROM item_tags WHERE item_id=? ORDER BY tag")
      .all(id) as { tag: string }[]
  ).map((r) => r.tag);
export function setItemTags(store: Store, id: string, tags: string[]) {
  store.db.run("DELETE FROM item_tags WHERE item_id=?", [id]);
  for (const tag of tags)
    store.db.run("INSERT INTO item_tags VALUES (?,?)", [id, tag]);
}
