import React, { useEffect, useState } from "react";
import { FileIcon } from "./FileIcon";
import { secureApi } from "./secure-api";
export function SearchPage() {
  const params = new URLSearchParams(location.search),
    [q, setQ] = useState(params.get("q") ?? ""),
    [tag, setTag] = useState(params.get("tag") ?? ""),
    [items, setItems] = useState<any[]>([]),
    [next, setNext] = useState<number | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function search(offset = 0) {
    setBusy(true);
    setError("");
    try {
      const p = new URLSearchParams({ q, tag, offset: String(offset) });
      const d = await secureApi("/api/search?" + p);
      setItems((old) => (offset ? [...old, ...d.items] : d.items));
      setNext(d.next);
      history.replaceState(
        null,
        "",
        "/search?" + new URLSearchParams({ q, tag }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void search();
  }, []);
  return (
    <section className="panel search-page">
      <p className="eyebrow">PUBLIC FILES</p>
      <h1>ファイルを探す</h1>
      <p className="muted">公開されたファイルを名前・タグから検索できます。</p>
      <form
        className="search-filters"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <label>
          ファイル名・キーワード
          <input
            value={q}
            maxLength={120}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <label>
          タグ
          <input
            value={tag}
            maxLength={32}
            onChange={(e) => setTag(e.target.value)}
            placeholder="例: minecraft"
          />
        </label>
        <button className="primary" disabled={busy}>
          検索
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      <div className="search-results">
        {items.map((i) => (
          <article key={i.id}>
            <a className="filename" href={"/files/" + i.id + "/preview"}>
              <FileIcon name={i.name} />
              <strong>{i.name}</strong>
              {i.storageState === "unavailable" && (
                <small className="storage-unavailable">
                  404 · 破損・接続不可
                </small>
              )}
            </a>
            <div className="tag-list">
              {i.tags.map((t: string) => (
                <button
                  key={t}
                  onClick={() => {
                    location.href = "/search?tag=" + encodeURIComponent(t);
                  }}
                >
                  #{t}
                </button>
              ))}
            </div>
            <small>
              {i.downloads != null
                ? i.downloads.toLocaleString() + " ダウンロード"
                : ""}
            </small>
          </article>
        ))}
      </div>
      {!busy && !items.length && (
        <p className="empty">一致する公開ファイルがありません。</p>
      )}
      {next !== null && (
        <button disabled={busy} onClick={() => void search(next)}>
          さらに表示
        </button>
      )}
    </section>
  );
}
