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
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [bio, setBio] = useState(""),
    [links, setLinks] = useState<{ label: string; url: string }[]>([]),
    [avatar, setAvatar] = useState<string | null | undefined>();
  const preview = /^\/files\/([a-f0-9-]{36})\/preview$/.exec(path);
  const author = /^\/users\/([^/]+)$/.exec(path);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let result: any;
      if (preview) result = await api(`/api/items/${preview[1]}`);
      else if (author) result = await api(`/api/users/${author[1]}/files`);
      else if (path === "/profile") {
        const { user } = await api("/api/me");
        if (!user || ![1, 3, 4].includes(user.level))
          throw new Error(
            "プロフィールの編集はVIP・スタッフ・管理者のみ利用できます。ログインしてから開いてください。",
          );
        const resultProfile = await api(`/api/users/${user.id}`);
        result = { profile: resultProfile };
        setBio(resultProfile.bio);
        setLinks(resultProfile.links);
      } else {
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
          <a href="/rankings">Ranking</a>
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
        {notice && <p role="status">{notice}</p>}
        {!data && !error && <p role="status">読み込み中…</p>}
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
        {data && author && (
          <>
            <section className="panel">
              <div className="profile-heading">
                {data.profile.avatar && (
                  <img
                    className="profile-avatar"
                    src={data.profile.avatar}
                    alt=""
                  />
                )}
                <h1>{data.profile.name}</h1>
              </div>
              <p className="profile-bio">{data.profile.bio}</p>
              <nav className="profile-links">
                {data.profile.links.map((link: any, i: number) => (
                  <a
                    key={i}
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {link.label} ↗
                  </a>
                ))}
              </nav>
            </section>
            <section className="panel">
              <h2>投稿したファイル</h2>
              <p className="muted">
                現在のあなたの閲覧権限で見られるファイルを表示します。
              </p>
              <FileList items={data.items} />
              {data.next != null && (
                <button
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void api(
                      `/api/users/${author[1]}/files?offset=${data.next}`,
                    )
                      .then((next) =>
                        setData({
                          ...next,
                          items: [...data.items, ...next.items],
                        }),
                      )
                      .catch((e) => setError(e.message))
                      .finally(() => setBusy(false));
                  }}
                >
                  続きを表示
                </button>
              )}
            </section>
          </>
        )}
        {data && path === "/profile" && (
          <section className="panel">
            <h1>プロフィール設定</h1>
            <p className="muted">
              説明とSNSリンク、アイコンは投稿者ページで公開されます。
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setBusy(true);
                setError("");
                void api("/api/profile", "PATCH", { bio, links, avatar })
                  .then(() => setNotice("プロフィールを保存しました"))
                  .catch((e) => setError(e.message))
                  .finally(() => setBusy(false));
              }}
            >
              <label>
                説明
                <textarea
                  value={bio}
                  maxLength={2000}
                  onChange={(e) => setBio(e.target.value)}
                  rows={6}
                />
              </label>
              <label>
                アイコン（PNG・JPEG・WebP、256KB以内）
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    if (file.size > 256 * 1024) {
                      setError("アイコンは256KB以内にしてください");
                      return;
                    }
                    const reader = new FileReader();
                    reader.onload = () => setAvatar(String(reader.result));
                    reader.readAsDataURL(file);
                  }}
                />
              </label>
              <button type="button" onClick={() => setAvatar(null)}>
                アイコンを削除
              </button>
              {links.map((link, i) => (
                <div className="profile-link-edit" key={i}>
                  <label>
                    SNS名
                    <input
                      value={link.label}
                      required
                      maxLength={40}
                      onChange={(e) =>
                        setLinks(
                          links.map((v, j) =>
                            j === i ? { ...v, label: e.target.value } : v,
                          ),
                        )
                      }
                    />
                  </label>
                  <label>
                    HTTPS URL
                    <input
                      type="url"
                      value={link.url}
                      required
                      maxLength={2048}
                      onChange={(e) =>
                        setLinks(
                          links.map((v, j) =>
                            j === i ? { ...v, url: e.target.value } : v,
                          ),
                        )
                      }
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => setLinks(links.filter((_, j) => j !== i))}
                  >
                    リンクを削除
                  </button>
                </div>
              ))}
              <div className="actions">
                <button
                  type="button"
                  disabled={links.length >= 8}
                  onClick={() =>
                    setLinks([...links, { label: "", url: "https://" }])
                  }
                >
                  SNSリンクを追加
                </button>
                <button className="primary" disabled={busy}>
                  プロフィールを保存
                </button>
                <a href={`/users/${data.profile.id}`}>投稿者ページを見る</a>
              </div>
            </form>
          </section>
        )}
      </main>
    </>
  );
}
