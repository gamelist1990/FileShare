import { ProfilePage } from "./ProfilePage";
import { UserDirectory } from "./UserDirectory";
import React, { useEffect, useState } from "react";
import { FileIcon } from "./FileIcon";
import { PreviewContent } from "./PreviewContent";
export const compactCount = (count: number) =>
  count >= 1e6
    ? `${+(count / 1e6).toFixed(1)}m`
    : count >= 1e3
      ? `${+(count / 1e3).toFixed(1)}k`
      : String(count);
async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "処理できませんでした");
  return data;
}
function FileList({ items }: { items: any[] }) {
  return (
    <ul className="community-files">
      {items.map((item) => (
        <li key={item.id}>
          <a className="filename" href={`/files/${item.id}/preview`}>
            <FileIcon name={item.name} />
            <span>{item.name}</span>
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
      if (path === "/users") result = {};
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
      <header className="site-nav">
        <a className="brand" href="/">
          PEXserver <small>FileShare</small>
        </a>
        <nav>
          <a href="https://pexserver.com">Home</a>
          <a href="/">FileShare</a>
          <a
            href="/rankings"
            aria-current={path === "/rankings" ? "page" : undefined}
          >
            Ranking
          </a>
          <a
            href="/users"
            aria-current={path.startsWith("/users") ? "page" : undefined}
          >
            User
          </a>
        </nav>
      </header>
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
          <>
            <section className="panel">
              <h1>ダウンロードランキング</h1>
              <FileList items={data.items} />
              {!data.items.length && <p>公開されたファイルはありません。</p>}
            </section>
            <section className="panel">
              <h2>投稿者別ランキング</h2>
              <ol className="uploader-ranking">
                {users.map((user) => (
                  <li key={user.id}>
                    <a href={`/users/${encodeURIComponent(user.id)}`}>
                      {user.name}
                    </a>
                    <span>
                      {user.downloads != null &&
                        `${compactCount(user.downloads)} DL · `}
                      {user.files}ファイル
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          </>
        )}
        {(author || path === "/profile") && <ProfilePage id={author?.[1]} />}
      </main>
    </>
  );
}
