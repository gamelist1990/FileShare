import { SiteNav } from "./SiteNav";
import { SearchPage } from "./SearchPage";
import { RankingPage } from "./RankingPage";
import { ProfilePage } from "./ProfilePage";
import { UserDirectory } from "./UserDirectory";
import React, { useEffect, useState } from "react";
import { FileIcon } from "./FileIcon";
import { PreviewContent } from "./PreviewContent";
import { secureApi as api } from "./secure-api";
export const compactCount = (count: number) =>
  count >= 1e6
    ? `${+(count / 1e6).toFixed(1)}m`
    : count >= 1e3
      ? `${+(count / 1e3).toFixed(1)}k`
      : String(count);
function FileList({ items }: { items: any[] }) {
  return (
    <ul className="community-files">
      {items.map((item) => (
        <li key={item.id}>
          <a className="filename" href={`/files/${item.id}/preview`}>
            <FileIcon name={item.name} />
            <span>{item.name}</span>
            {item.storageState === "unavailable" && (
              <small className="storage-unavailable">
                404 · 破損・接続不可
              </small>
            )}
          </a>
          <span>
            {item.downloads != null && `${compactCount(item.downloads)} DL`}
            {item.uploaded_by && (
              <a href={`/users/${encodeURIComponent(item.uploaded_by)}`}>
                {" "}
                · {item.uploader_name}
              </a>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
export function CommunityPage() {
  const path = location.pathname;
  const [data, setData] = useState<any>(null),
    [users, setUsers] = useState<any[]>([]),
    [error, setError] = useState("");
  const preview = /^\/files\/([a-f0-9-]{36})\/preview$/.exec(path);
  const author = /^\/users\/([^/]+)$/.exec(path);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let result: any;
      if (path === "/users" || path === "/search") result = {};
      else if (preview) result = await api(`/api/items/${preview[1]}`);
      else if (author || path === "/profile") result = {};
      else {
        const results = await Promise.all([
          api("/api/rankings"),
          api("/api/rankings/uploaders"),
        ]);
        result = results[0];
        if (!cancelled) setUsers(results[1].users);
      }
      if (!cancelled) setData(result);
    })().catch((e) => {
      if (!cancelled) setError(e.message);
    });
    return () => {
      cancelled = true;
    };
  }, [path]);
  const item = data?.item ?? data;
  return (
    <>
      <SiteNav />
      <main
        className={
          preview ? "community-page standalone-preview" : "community-page"
        }
      >
        {error && (
          <p className="error" role="alert">
            {error} <a href="/">FileShareへ戻る</a>
          </p>
        )}
        {path === "/users" && <UserDirectory />}
        {path === "/search" && <SearchPage />}
        {path !== "/users" &&
          !author &&
          path !== "/profile" &&
          !data &&
          !error && <p role="status">読み込み中…</p>}
        {data && preview && (
          <section className="panel preview-page">
            <h1>{item.name}</h1>
            <PreviewContent item={item} />
            <button
              className="primary"
              onClick={() => {
                void api(`/api/items/${item.id}/ticket`, "POST", {})
                  .then((d) => {
                    location.href = d.url;
                  })
                  .catch((e) => setError(e.message));
              }}
            >
              ダウンロード
            </button>
          </section>
        )}
        {data && path === "/rankings" && (
          <RankingPage items={data.items} users={users} />
        )}
        {(author || path === "/profile") && <ProfilePage id={author?.[1]} />}
      </main>
    </>
  );
}
