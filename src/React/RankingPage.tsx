import React, { useState } from "react";
import { FileIcon } from "./FileIcon";
const count = (n: number) =>
  new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
export function RankingPage({ items, users }: { items: any[]; users: any[] }) {
  const [tab, setTab] = useState("files");
  return (
    <section className="panel ranking-page">
      <p className="eyebrow">COMMUNITY / RANKING</p>
      <h1>ダウンロードランキング</h1>
      <p className="muted">人気のファイルと、作品を届ける投稿者たち。</p>
      <div className="social-tabs">
        <button aria-pressed={tab === "files"} onClick={() => setTab("files")}>
          ファイル
        </button>
        <button aria-pressed={tab === "users"} onClick={() => setTab("users")}>
          投稿者
        </button>
      </div>
      {tab === "files" ? (
        <ol className="ranking-list">
          {items.map((i, n) => (
            <li key={i.id}>
              <span className={"rank-number rank-" + (n + 1)}>
                {String(n + 1).padStart(2, "0")}
              </span>
              <FileIcon name={i.name} />
              <div>
                <a href={"/files/" + i.id + "/preview"}>
                  <strong>{i.name}</strong>
                </a>
                {i.uploaded_by && (
                  <a className="rank-author" href={"/users/" + i.uploaded_by}>
                    <img
                      src={"/api/users/" + i.uploaded_by + "/avatar"}
                      alt=""
                      onError={(e) => {
                        e.currentTarget.hidden = true;
                      }}
                    />
                    {i.uploader_name}
                  </a>
                )}
                <div className="tag-list">
                  {i.tags?.map((t: string) => (
                    <a key={t} href={"/search?tag=" + encodeURIComponent(t)}>
                      #{t}
                    </a>
                  ))}
                </div>
              </div>
              <strong className="rank-total">
                {i.downloads != null ? count(i.downloads) : "—"}
                <small>DOWNLOADS</small>
              </strong>
            </li>
          ))}
        </ol>
      ) : (
        <>
          <h2>投稿者別ランキング</h2>
          <ol className="ranking-list">
            {users.map((u, n) => (
              <li key={u.id}>
                <span className={"rank-number rank-" + (n + 1)}>
                  {String(n + 1).padStart(2, "0")}
                </span>
                <span className="rank-avatar">
                  {u.name.slice(0, 1).toUpperCase()}
                  <img
                    src={u.avatar ?? "/api/users/" + u.id + "/avatar"}
                    alt=""
                    onError={(e) => {
                      e.currentTarget.hidden = true;
                    }}
                  />
                </span>
                <div>
                  <a href={"/users/" + u.id}>
                    <strong>{u.displayName || u.name}</strong>
                  </a>
                  <small>
                    @{u.name} · {u.files} ファイル
                  </small>
                </div>
                <strong className="rank-total">
                  {u.downloads != null ? count(u.downloads) : "—"}
                  <small>DOWNLOADS</small>
                </strong>
              </li>
            ))}
          </ol>
        </>
      )}
      {!(tab === "files" ? items : users).length && (
        <p className="empty">まだランキングに表示できる投稿はありません。</p>
      )}
    </section>
  );
}
