import React, { useState, useEffect, useRef } from "react";
import {
  startRegistration,
  startAuthentication,
} from "@simplewebauthn/browser";
import { nextChunk } from "./transfer";
import { AdminTools } from "./AdminTools";
import { Modal } from "./Modal";
import { FileIcon } from "./FileIcon";
type User = {
  id: string;
  name: string;
  level: number;
  quota: number;
  status: string;
};
type Item = {
  id: string;
  parent: string | null;
  owner: string | null;
  name: string;
  folder: number;
  size: number;
  mime: string;
  visibility: string;
  min_level: number;
  created: number;
  downloads?: number | null;
  uploader_name?: string | null;
  expires_at?: number | null;
};
const levels = ["一般", "VIP", "招待", "スタッフ", "管理者"];
const size = (n: number) =>
  n >= 1e9
    ? (n / 1e9).toFixed(2) + " GB"
    : n >= 1e6
      ? (n / 1e6).toFixed(1) + " MB"
      : n >= 1e3
        ? (n / 1e3).toFixed(1) + " KB"
        : n + " B";
async function api(path: string, method = "GET", body?: unknown) {
  const r = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error ?? "処理できませんでした");
  return d;
}
export function App() {
  const [user, setUser] = useState<User | null>(null),
    [ready, setReady] = useState(false),
    [items, setItems] = useState<Item[]>([]),
    [parent, setParent] = useState<string | null>(null),
    [crumbs, setCrumbs] = useState<{ id: string; name: string }[]>([]),
    [space, setSpace] = useState("shared"),
    [writable, setWritable] = useState(false),
    [usage, setUsage] = useState({ used: 0, reserved: 0 }),
    [capacity, setCapacity] = useState(200e9),
    [filePolicy, setFilePolicy] = useState<any>(null),
    [retentionMinutes, setRetentionMinutes] = useState(43200),
    [rankings, setRankings] = useState<Item[]>([]),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [authOpen, setAuthOpen] = useState(false),
    [registration, setRegistration] = useState(true),
    [setupRequired, setSetupRequired] = useState(false),
    [name, setName] = useState(""),
    [bootstrap, setBootstrap] = useState(""),
    [staffToken, setStaffToken] = useState(
      () =>
        new URLSearchParams(location.hash.slice(1)).get("staff-invite") ?? "",
    ),
    [staffInvitation, setStaffInvitation] = useState<{
      label: string;
      expires: number;
    } | null>(null),
    [staffInviteError, setStaffInviteError] = useState(""),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState<{
      name: string;
      percent: number;
      speed: number;
    } | null>(null),
    [selected, setSelected] = useState<string[]>([]),
    [query, setQuery] = useState(""),
    [preview, setPreview] = useState<Item | null>(null),
    [previewUrl, setPreviewUrl] = useState(""),
    [settings, setSettings] = useState<Item | null>(null),
    [invite, setInvite] = useState({ id: "", key: "" }),
    [admin, setAdmin] = useState(location.pathname === "/admin"),
    [overview, setOverview] = useState<any>(null),
    [trashSelection, setTrashSelection] = useState<string[]>([]),
    [cancelled, setCancelled] = useState(false);
  const stop = useRef(false),
    fileInput = useRef<HTMLInputElement>(null);
  const refreshMe = async () => {
    const d = await api("/api/me");
    setUser(d.user);
    setRegistration(d.registration);
    setFilePolicy(d.filePolicy);
    if (d.filePolicy)
      setRetentionMinutes((value) =>
        Math.min(value, Math.floor(d.filePolicy.maxRetentionSeconds / 60)),
      );
    setSetupRequired(d.setupRequired === true);
    if (!d.setupRequired) setBootstrap("");
    setReady(true);
    return d.user;
  };
  const refresh = async () => {
    const d = await api(
      "/api/items?space=" + space + (parent ? "&parent=" + parent : ""),
    );
    setItems(d.items);
    setWritable(d.writable);
    setUsage(d.usage);
    setCapacity(d.capacity);
    setSelected([]);
    setRankings((await api("/api/rankings")).items);
  };
  const loadAdmin = async () => {
    setOverview(await api("/api/admin/overview"));
  };
  const run = async (fn: () => Promise<unknown>) => {
    setError("");
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理できませんでした");
    }
  };
  useEffect(() => {
    run(refreshMe);
  }, []);
  useEffect(() => {
    if (authOpen) run(refreshMe);
  }, [authOpen]);
  useEffect(() => {
    const syncInvitation = () => {
      const token =
        new URLSearchParams(location.hash.slice(1)).get("staff-invite") ?? "";
      setStaffToken(token);
      if (!token) {
        setStaffInvitation(null);
        setStaffInviteError("");
      }
    };
    addEventListener("hashchange", syncInvitation);
    addEventListener("popstate", syncInvitation);
    return () => {
      removeEventListener("hashchange", syncInvitation);
      removeEventListener("popstate", syncInvitation);
    };
  }, []);
  useEffect(() => {
    if (!ready || !staffToken) return;
    let cancelled = false;
    setAuthOpen(true);
    setStaffInvitation(null);
    setStaffInviteError("");
    api("/api/auth/staff-invite", "POST", { token: staffToken })
      .then((value) => {
        if (!cancelled) setStaffInvitation(value);
      })
      .catch((e) => {
        if (!cancelled) setStaffInviteError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [ready, staffToken]);
  const clearStaffInvitation = () => {
    setStaffToken("");
    setStaffInvitation(null);
    setStaffInviteError("");
    history.replaceState({}, "", location.pathname + location.search);
  };
  useEffect(() => {
    const id = new URLSearchParams(location.search).get("item");
    if (!ready || !id || admin) return;
    run(async () => {
      setInvite((value) => ({ ...value, id }));
      const item: Item = await api("/api/items/" + encodeURIComponent(id));
      if (item.folder) {
        setParent(item.id);
        setCrumbs([{ id: item.id, name: item.name }]);
      } else {
        setPreview(item);
        setPreviewUrl("/api/content/" + item.id);
      }
    });
  }, [ready, user?.id]);
  useEffect(() => {
    if (ready) run(admin ? loadAdmin : refresh);
  }, [ready, parent, space, admin, user?.id]);
  useEffect(() => {
    const pop = () => {
      setAdmin(location.pathname === "/admin");
      setParent(null);
      setCrumbs([]);
    };
    addEventListener("popstate", pop);
    return () => removeEventListener("popstate", pop);
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPreview(null);
        setSettings(null);
        setAuthOpen(false);
      }
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, []);
  const navigateAdmin = (on: boolean) => {
    history.pushState({}, "", on ? "/admin" : "/");
    setAdmin(on);
  };
  const login = () =>
    run(async () => {
      setBusy(true);
      try {
        const opts = await api("/api/auth/login/options", "POST", {});
        const response = await startAuthentication({ optionsJSON: opts });
        await api("/api/auth/login/verify", "POST", response);
        await refreshMe();
        setAuthOpen(false);
      } finally {
        setBusy(false);
      }
    });
  const register = (enroll = false) =>
    run(async () => {
      setBusy(true);
      try {
        const route = enroll ? "enroll" : "register";
        const opts = await api("/api/auth/" + route + "/options", "POST", {
          name,
          bootstrap: staffToken ? undefined : bootstrap,
          staffInvite: !enroll && staffToken ? staffToken : undefined,
        });
        const response = await startRegistration({ optionsJSON: opts });
        const d = await api("/api/auth/" + route + "/verify", "POST", response);
        setBootstrap("");
        if (!enroll && staffToken) clearStaffInvitation();
        await refreshMe();
        setMessage(d.message);
        setAuthOpen(false);
      } finally {
        setBusy(false);
      }
    });
  const switchSpace = (value: string) => {
    setSpace(value);
    setParent(null);
    setCrumbs([]);
  };
  const enter = (i: Item) => {
    setParent(i.id);
    setCrumbs([...crumbs, { id: i.id, name: i.name }]);
  };
  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setCancelled(false);
    stop.current = false;
    try {
      for (const file of Array.from(files)) {
        if (filePolicy && file.size > filePolicy.maxFileBytes)
          throw new Error(
            "1ファイルの上限は" + size(filePolicy.maxFileBytes) + "です",
          );
        const fingerprint = JSON.stringify([
          file.name,
          file.size,
          file.lastModified,
          parent,
          space,
          user?.id,
        ]);
        const resumeKey = "fs-upload:" + fingerprint;
        let id = sessionStorage.getItem(resumeKey),
          offset = 0;
        if (id) {
          try {
            offset = (await api("/api/uploads/" + id)).offset;
          } catch {
            id = null;
          }
        }
        if (!id) {
          const d = await api("/api/uploads", "POST", {
            name: file.name,
            size: file.size,
            mime: file.type,
            retentionSeconds: retentionMinutes * 60,
            parent,
            space,
          });
          id = d.id;
          sessionStorage.setItem(resumeKey, id!);
        }
        let chunkSize = 1024 * 1024,
          retries = 0;
        while (offset < file.size) {
          if (stop.current) {
            setCancelled(true);
            setMessage(
              "転送を中断しました。同じファイルを選ぶと続きから再開できます。",
            );
            return;
          }
          const chunk = file.slice(offset, offset + chunkSize),
            bytes = await chunk.arrayBuffer();
          const checksum = Array.from(
            new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
            (b) => b.toString(16).padStart(2, "0"),
          ).join("");
          const start = performance.now();
          try {
            const r = await fetch("/api/uploads/" + id, {
              method: "PATCH",
              headers: {
                "Content-Type": "application/octet-stream",
                "Upload-Offset": String(offset),
                "Upload-Checksum": checksum,
              },
              body: bytes,
            });
            const d = await r.json();
            if (!r.ok) {
              if (
                r.status === 403 ||
                r.status === 401 ||
                r.status === 507 ||
                r.status === 413
              )
                throw Object.assign(new Error(d.error), { fatal: true });
              throw new Error(d.error);
            }
            offset = d.offset;
            const elapsed = performance.now() - start;
            chunkSize = nextChunk(chunkSize, bytes.byteLength, elapsed);
            retries = 0;
            setProgress({
              name: file.name,
              percent: (offset / file.size) * 100,
              speed: (bytes.byteLength / elapsed) * 1000,
            });
          } catch (e) {
            if ((e as any).fatal || ++retries > 6) throw e;
            chunkSize = nextChunk(chunkSize, 0, 0, true);
            await new Promise((resolve) =>
              setTimeout(resolve, Math.min(10_000, 500 * 2 ** retries)),
            );
            offset = (await api("/api/uploads/" + id)).offset;
          }
        }
        if (stop.current) {
          setMessage("中断しました。同じファイルを選択すると再開できます。");
          return;
        }
        await api("/api/uploads/" + id + "/complete", "POST", {});
        sessionStorage.removeItem(resumeKey);
        setProgress({ name: file.name, percent: 100, speed: 0 });
      }
      await refresh();
      setMessage("アップロードしました。");
    } finally {
      setBusy(false);
      setProgress(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  }
  const download = (i: Item) =>
    run(async () => {
      const d = await api("/api/items/" + i.id + "/ticket", "POST", {});
      const a = document.createElement("a");
      a.href = d.url;
      a.download = i.name;
      document.body.append(a);
      a.click();
      a.remove();
    });
  const showPreview = (i: Item) =>
    run(async () => {
      setPreview(i);
      setPreviewUrl("/api/content/" + i.id);
    });
  const transcode = () =>
    run(async () => {
      if (!preview) return;
      const id = preview.id;
      setPreviewUrl("");
      for (let attempt = 0; attempt < 65; attempt++) {
        const d = await api("/api/items/" + id + "/preview", "POST", {});
        if (d.state === "ready") {
          setPreviewUrl("/api/content/" + id + "/preview");
          return;
        }
        if (d.state === "failed") throw new Error(d.error);
        await new Promise((r) => setTimeout(r, 3000));
      }
      throw new Error("変換中です。しばらくして再度開いてください");
    });
  const mkdirAction = () =>
    run(async () => {
      const folderName = prompt("フォルダ名");
      if (!folderName) return;
      await api("/api/folders", "POST", { name: folderName, parent, space });
      await refresh();
    });
  const trash = () =>
    run(async () => {
      if (
        !selected.length ||
        !confirm(selected.length + "件をごみ箱へ移動しますか？")
      )
        return;
      await api("/api/trash", "POST", { ids: selected });
      await refresh();
    });
  const update = (data: any) =>
    run(async () => {
      if (!settings) return;
      const d = await api("/api/items/" + settings.id, "PATCH", data);
      if (d.key)
        setMessage(
          "招待キー（この一度だけ表示）: " +
            d.key +
            " ／ ファイルID: " +
            settings.id,
        );
      else setMessage("設定を保存しました");
      setSettings(null);
      await refresh();
    });
  const maintenance = (action: string) =>
    run(async () => {
      if (
        action === "purge" &&
        !confirm(
          "選択したごみ箱のファイルを完全削除します。元に戻せません。続けますか？",
        )
      )
        return;
      await api("/api/admin/maintenance", "POST", {
        action,
        ids: trashSelection,
      });
      setTrashSelection([]);
      await loadAdmin();
      setMessage("処理が完了しました");
    });
  return (
    <>
      <header className="site-nav">
        <a className="brand" href="https://pexserver.com">
          <img src="/server.png" alt="" />
          <span>
            <strong>PEXserver</strong>
            <small>FileShare</small>
          </span>
        </a>
        <nav aria-label="メインナビゲーション">
          <a href="https://pexserver.com">Home</a>
          <button
            className={!admin ? "active" : ""}
            onClick={() => navigateAdmin(false)}
          >
            FileShare
          </button>
          {user?.level === 4 && (
            <button
              className={admin ? "active" : ""}
              onClick={() => navigateAdmin(true)}
            >
              Admin
            </button>
          )}
        </nav>
        <div className="account">
          {user ? (
            <>
              <span>
                {user.name}
                <small>
                  Level {user.level} · {levels[user.level]}
                </small>
              </span>
              <button onClick={() => register(true)}>パスキー追加</button>
              <button
                onClick={() =>
                  run(async () => {
                    await api("/api/auth/logout", "POST", {});
                    await refreshMe();
                    navigateAdmin(false);
                    switchSpace("shared");
                  })
                }
              >
                ログアウト
              </button>
            </>
          ) : (
            <button className="primary" onClick={() => setAuthOpen(true)}>
              パスキーでログイン
            </button>
          )}
        </div>
      </header>
      <main>
        <section className="hero">
          <div>
            <p className="eyebrow">
              PEXSERVER / {admin ? "ADMINISTRATION" : "SHARED STORAGE"}
            </p>
            <h1>{admin ? "ストレージ管理" : "ファイルを、つなぐ。"}</h1>
            <p className="sub">
              {admin
                ? "ユーザーと容量、共有ファイルをひとつの場所で管理。"
                : "みんなで使う共有フォルダと、あなただけのプライベート空間。"}
            </p>
          </div>
          <div className="hero-note">
            <strong>{admin ? "管理者専用" : "200 GB"}</strong>
            <span>{admin ? "Level 4" : "共有ストレージ"}</span>
          </div>
        </section>
        {error && (
          <div role="alert" className="notice error">
            {error}
            <button aria-label="閉じる" onClick={() => setError("")}>
              ×
            </button>
          </div>
        )}
        {message && (
          <div role="status" className="notice">
            {message}
            <button aria-label="閉じる" onClick={() => setMessage("")}>
              ×
            </button>
          </div>
        )}
        {admin ? (
          user?.level === 4 && overview ? (
            <>
              <section className="metrics">
                <article>
                  <span>使用容量（ごみ箱を含む）</span>
                  <strong>
                    {size(overview.usage.used)} / {size(overview.capacity)}
                  </strong>
                </article>
                <article>
                  <span>転送予約 / プレビュー</span>
                  <strong>
                    {size(overview.usage.reserved)} /{" "}
                    {size(overview.cacheBytes)}
                  </strong>
                </article>
                <article>
                  <span>AI監視</span>
                  <strong>
                    {overview.aiEnabled ? "有効" : "オプション・無効"}
                  </strong>
                </article>
              </section>
              <section className="panel">
                <div className="section-title">
                  <h2>ユーザーと権限</h2>
                  <button onClick={() => run(loadAdmin)}>更新</button>
                </div>
                <p className="muted">
                  0 一般 · 1 VIP · 2 招待 · 3 スタッフ · 4
                  管理者。招待ファイルには対象キーも必要です。
                </p>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>ユーザー</th>
                        <th>登録IP</th>
                        <th>権限</th>
                        <th>容量 (GB)</th>
                        <th>承認</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {overview.users.map((u: User & { ip: string }) => (
                        <UserRow
                          key={u.id}
                          u={u}
                          save={async (data: any) => {
                            await api("/api/admin/users", "PATCH", data);
                            await loadAdmin();
                            if (u.id === user.id) await refreshMe();
                          }}
                          run={run}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
              <AdminTools
                users={overview.users}
                reports={overview.reports}
                refresh={async () => {
                  await loadAdmin();
                  await refreshMe();
                }}
                request={api}
                run={run}
              />
              <section className="panel">
                <div className="section-title">
                  <h2>ごみ箱とストレージ整理</h2>
                  <div className="actions">
                    <button onClick={() => maintenance("cleanup")}>
                      期限切れ転送・不要データを整理
                    </button>
                    <button
                      disabled={!trashSelection.length}
                      onClick={() => maintenance("restore")}
                    >
                      復元
                    </button>
                    <button
                      className="danger"
                      disabled={!trashSelection.length}
                      onClick={() => maintenance("purge")}
                    >
                      完全削除
                    </button>
                  </div>
                </div>
                <p className="muted">
                  自動整理は期限切れの転送と未登録データが対象です。ごみ箱のファイルは完全削除するまで容量に含まれます。フォルダは親から順に復元してください。
                </p>
                {overview.trash.length ? (
                  <ul className="trash-list">
                    {overview.trash.map((i: any) => (
                      <li key={i.id}>
                        <label>
                          <input
                            type="checkbox"
                            checked={trashSelection.includes(i.id)}
                            onChange={(e) =>
                              setTrashSelection(
                                e.target.checked
                                  ? [...trashSelection, i.id]
                                  : trashSelection.filter((id) => id !== i.id),
                              )
                            }
                          />
                          {i.folder ? "▱" : "▤"} {i.name}{" "}
                          <small>{size(i.size)}</small>
                        </label>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="empty">ごみ箱は空です</p>
                )}
              </section>
              <section className="panel">
                <h2>未完了の転送</h2>
                {overview.uploads.map((u: any) => (
                  <p key={u.id}>
                    {u.name} · {size(u.offset)} / {size(u.size)}
                  </p>
                ))}
                {!overview.uploads.length && (
                  <p className="muted">未完了の転送はありません</p>
                )}
              </section>
            </>
          ) : (
            <section className="panel">
              <h2>管理者のみアクセスできます</h2>
              <p>Level 4のアカウントでログインしてください。</p>
              <button className="primary" onClick={() => setAuthOpen(true)}>
                ログイン
              </button>
            </section>
          )
        ) : (
          <div className="workspace">
            <aside>
              <p className="eyebrow">YOUR WORKSPACE</p>
              <button
                className={space === "shared" ? "space active" : "space"}
                onClick={() => switchSpace("shared")}
              >
                <span>▱</span>メイン共有フォルダ
              </button>
              {user && user.level >= 1 && (
                <button
                  className={space === "private" ? "space active" : "space"}
                  onClick={() => switchSpace("private")}
                >
                  <span>⌑</span>プライベートフォルダ
                </button>
              )}
              <div className="quota">
                <span>
                  {space === "private" ? "個人ストレージ" : "共有ストレージ"}
                </span>
                <strong>
                  {size(usage.used)} <small>/ {size(capacity)}</small>
                </strong>
                <progress value={usage.used + usage.reserved} max={capacity} />
                <small>転送予約: {size(usage.reserved)}</small>
              </div>
              <details className="invite-box">
                <summary>招待ファイルを開く</summary>
                <label>
                  ファイルID
                  <input
                    value={invite.id}
                    onChange={(e) =>
                      setInvite({ ...invite, id: e.target.value })
                    }
                  />
                </label>
                <label>
                  招待キー
                  <input
                    type="password"
                    value={invite.key}
                    onChange={(e) =>
                      setInvite({ ...invite, key: e.target.value })
                    }
                  />
                </label>
                <button
                  onClick={() =>
                    run(async () => {
                      await api("/api/items/" + invite.id + "/unlock", "POST", {
                        key: invite.key,
                      });
                      const i = await api("/api/items/" + invite.id);
                      setInvite({ id: "", key: "" });
                      if (i.folder) {
                        setParent(i.id);
                        setCrumbs([{ id: i.id, name: i.name }]);
                      } else await showPreview(i);
                    })
                  }
                >
                  閲覧権を取得
                </button>
              </details>
              <p className="aside-note">
                パスキーで安全にログイン。
                <br />
                転送は中断した位置から再開できます。
              </p>
            </aside>
            <section className="panel browser">
              <div className="section-title">
                <div>
                  <p className="eyebrow">
                    {space === "private" ? "PRIVATE SPACE" : "SHARED SPACE"}
                  </p>
                  <h2>
                    {space === "private"
                      ? "プライベートフォルダ"
                      : "メイン共有フォルダ"}
                  </h2>
                </div>
                <button
                  onClick={() => run(refresh)}
                  aria-label="ファイル一覧を更新"
                >
                  ↻ 更新
                </button>
              </div>
              {writable && filePolicy && (
                <div className="upload-policy">
                  <label>
                    投稿からの保存期間（分）
                    <input
                      type="number"
                      min="1"
                      max={Math.floor(filePolicy.maxRetentionSeconds / 60)}
                      value={retentionMinutes}
                      onChange={(e) =>
                        setRetentionMinutes(Number(e.target.value))
                      }
                    />
                  </label>
                  <span>
                    1分〜{Math.floor(filePolicy.maxRetentionSeconds / 60)}分 ·
                    1ファイル上限 {size(filePolicy.maxFileBytes)}
                    <br />
                    期限後はファイルを完全削除します。
                  </span>
                </div>
              )}
              <div className="toolbar">
                <label className="search">
                  <span>⌕</span>
                  <input
                    aria-label="ファイルを検索"
                    placeholder="ファイルを検索…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
                {writable && (
                  <div className="actions">
                    <button disabled={busy} onClick={mkdirAction}>
                      ＋ フォルダ
                    </button>
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() => fileInput.current?.click()}
                    >
                      ↑ アップロード
                    </button>
                  </div>
                )}
                <input
                  hidden
                  ref={fileInput}
                  type="file"
                  multiple
                  onChange={(e) => run(() => upload(e.target.files))}
                />
              </div>
              <nav className="breadcrumb" aria-label="現在のフォルダ">
                <button
                  onClick={() => {
                    setParent(null);
                    setCrumbs([]);
                  }}
                >
                  ホーム
                </button>
                {crumbs.map((c, n) => (
                  <React.Fragment key={c.id}>
                    <span>/</span>
                    <button
                      onClick={() => {
                        setParent(c.id);
                        setCrumbs(crumbs.slice(0, n + 1));
                      }}
                    >
                      {c.name}
                    </button>
                  </React.Fragment>
                ))}
              </nav>
              {progress && (
                <div role="status" className="transfer">
                  <strong>{progress.name}</strong>
                  <span>
                    {progress.percent.toFixed(1)}% · {size(progress.speed)}/秒
                  </span>
                  <progress value={progress.percent} max={100} />
                  <button
                    onClick={() => {
                      stop.current = true;
                    }}
                  >
                    一時停止
                  </button>
                </div>
              )}
              {selected.length > 0 && (
                <div className="selection-bar">
                  <span>{selected.length}件を選択</span>
                  <button className="danger" onClick={trash}>
                    ごみ箱へ移動
                  </button>
                </div>
              )}
              <div className="table-wrap">
                <table className="file-table">
                  <thead>
                    <tr>
                      <th className="check">
                        {writable && (
                          <input
                            type="checkbox"
                            aria-label="すべて選択"
                            checked={
                              items.length > 0 &&
                              selected.length === items.length
                            }
                            onChange={(e) =>
                              setSelected(
                                e.target.checked ? items.map((i) => i.id) : [],
                              )
                            }
                          />
                        )}
                      </th>
                      <th>名前</th>
                      <th>サイズ</th>
                      <th>公開範囲</th>
                      <th>更新日</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items
                      .filter((i) =>
                        i.name.toLowerCase().includes(query.toLowerCase()),
                      )
                      .map((i) => (
                        <tr key={i.id}>
                          <td>
                            {writable && (
                              <input
                                type="checkbox"
                                aria-label={i.name + "を選択"}
                                checked={selected.includes(i.id)}
                                onChange={(e) =>
                                  setSelected(
                                    e.target.checked
                                      ? [...selected, i.id]
                                      : selected.filter((id) => id !== i.id),
                                  )
                                }
                              />
                            )}
                          </td>
                          <td>
                            <button
                              className="filename"
                              aria-label={i.name}
                              onClick={() =>
                                i.folder ? enter(i) : showPreview(i)
                              }
                            >
                              <FileIcon name={i.name} folder={!!i.folder} />
                              <span className="filename-copy">
                                <span>{i.name}</span>
                                {!i.folder && (
                                  <small>
                                    {i.uploader_name && `${i.uploader_name} · `}
                                    {i.downloads != null && `${i.downloads} DL`}
                                    {i.expires_at &&
                                      ` · 期限 ${new Date(i.expires_at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}`}
                                  </small>
                                )}
                              </span>
                            </button>
                          </td>
                          <td className="muted">
                            {i.folder ? "—" : size(i.size)}
                          </td>
                          <td>
                            <span className={"badge " + i.visibility}>
                              {i.visibility === "private"
                                ? "非公開"
                                : i.visibility === "invite"
                                  ? "招待"
                                  : "公開"}
                              {i.min_level > 0
                                ? " · " + levels[i.min_level]
                                : ""}
                            </span>
                          </td>
                          <td className="muted date">
                            {new Date(i.created).toLocaleDateString("ja-JP")}
                          </td>
                          <td>
                            <div className="row-actions">
                              {!i.folder && (
                                <button
                                  aria-label={i.name + "をダウンロード"}
                                  onClick={() => download(i)}
                                >
                                  ↓
                                </button>
                              )}
                              {writable && (
                                <button
                                  aria-label={i.name + "の設定"}
                                  onClick={() => setSettings(i)}
                                >
                                  設定
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              {!items.length && (
                <div className="empty">
                  <div className="empty-icon">▱</div>
                  <h3>まだファイルがありません</h3>
                  <p>
                    {writable
                      ? "最初のファイルをアップロードしましょう。"
                      : "公開されたファイルがここに表示されます。"}
                  </p>
                </div>
              )}
              {!user && (
                <div className="login-note">
                  共有ファイルを閲覧できます。個人領域の利用にはログインと権限の承認が必要です。
                </div>
              )}
            </section>
          </div>
        )}
        {!admin && filePolicy?.rankingEnabled && rankings.length > 0 && (
          <section className="panel file-ranking">
            <p className="eyebrow">DOWNLOAD RANKING</p>
            <h2>人気のファイル</h2>
            <ol>
              {rankings.map((i) => (
                <li key={i.id}>
                  <button className="filename" onClick={() => showPreview(i)}>
                    <FileIcon name={i.name} />
                    <span>{i.name}</span>
                  </button>
                  <span>
                    {i.downloads != null && `${i.downloads} DL`}
                    {i.uploader_name && ` · ${i.uploader_name}`}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )}
        <footer>
          <span>PEXserver FileShare</span>
          <a href="https://pexserver.com">PEXserverについて ↗</a>
          <span>安全につながる、みんなのストレージ。</span>
        </footer>
      </main>
      {authOpen && (
        <Modal onClose={() => setAuthOpen(false)}>
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="auth-title"
          >
            <button
              className="close"
              aria-label="閉じる"
              onClick={() => setAuthOpen(false)}
            >
              ×
            </button>
            <p className="eyebrow">YOUR ACCOUNT</p>
            <h2 id="auth-title">パスキーで、つながる。</h2>
            <p className="muted">
              指紋・顔認証・セキュリティキーを使ってログインします。
            </p>
            <button className="primary full" disabled={busy} onClick={login}>
              パスキーでログイン
            </button>
            <hr />
            {staffToken && (
              <div className="staff-invite-welcome">
                <h3>スタッフとして参加</h3>
                {staffInvitation ? (
                  <p>
                    {staffInvitation.label}
                    への招待です。パスキー登録後、承認済みスタッフ（Level
                    3）として利用できます。
                  </p>
                ) : (
                  <p role={staffInviteError ? "alert" : "status"}>
                    {staffInviteError || "招待URLを確認しています…"}
                  </p>
                )}
                {staffInvitation && (
                  <>
                    <label>
                      スタッフのユーザー名
                      <input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        autoComplete="username webauthn"
                        placeholder="英数字・_・-、2〜32文字"
                      />
                    </label>
                    <button
                      className="primary full"
                      disabled={busy || !name}
                      onClick={() => register()}
                    >
                      パスキーを登録してスタッフになる
                    </button>
                  </>
                )}
                <button
                  className="full"
                  disabled={busy}
                  onClick={clearStaffInvitation}
                >
                  通常のログイン・登録へ戻る
                </button>
              </div>
            )}
            {!staffToken && registration && (
              <>
                <h3>はじめての方</h3>
                <label>
                  ユーザー名
                  <input
                    autoComplete="username webauthn"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="英数字・_・-、2〜32文字"
                  />
                </label>
                <button
                  className="full"
                  disabled={busy || !name}
                  onClick={() => register()}
                >
                  パスキーを登録して承認を申請
                </button>
              </>
            )}
            {!staffToken && setupRequired && (
              <details>
                <summary>管理者の初期設定</summary>
                <label>
                  ユーザー名
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <label>
                  初期設定キー
                  <input
                    type="password"
                    autoComplete="off"
                    value={bootstrap}
                    onChange={(e) => setBootstrap(e.target.value)}
                  />
                </label>
                <button
                  disabled={busy || !bootstrap || !name}
                  onClick={() => register()}
                >
                  管理者を作成
                </button>
              </details>
            )}
          </section>
        </Modal>
      )}
      {settings && (
        <Modal onClose={() => setSettings(null)}>
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
          >
            <button
              className="close"
              aria-label="閉じる"
              onClick={() => setSettings(null)}
            >
              ×
            </button>
            <p className="eyebrow">FILE SETTINGS</p>
            <h2 id="settings-title">公開範囲と整理</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const d = new FormData(e.currentTarget);
                update({
                  name: d.get("name"),
                  visibility: d.get("visibility"),
                  min_level: Number(d.get("min_level")),
                  ...(d.get("retentionMinutes")
                    ? {
                        retentionSeconds:
                          Number(d.get("retentionMinutes")) * 60,
                      }
                    : {}),
                  rotateKey: d.get("rotateKey") === "on",
                });
              }}
            >
              <label>
                名前
                <input
                  name="name"
                  defaultValue={settings.name}
                  required
                  maxLength={180}
                />
              </label>
              <label>
                公開範囲
                <select name="visibility" defaultValue={settings.visibility}>
                  <option value="private">非公開</option>
                  <option value="public">公開</option>
                  <option value="invite">招待キーが必要</option>
                </select>
              </label>
              <label>
                閲覧に必要な階級
                <select name="min_level" defaultValue={settings.min_level}>
                  {levels.map((l, n) => (
                    <option key={n} value={n}>
                      Level {n} · {l}
                    </option>
                  ))}
                </select>
              </label>
              <label className="inline">
                <input type="checkbox" name="rotateKey" />
                招待キーを更新（既存の閲覧許可を失効）
              </label>
              {!settings.folder && filePolicy && (
                <label>
                  投稿からの保存期間（分）
                  <input
                    name="retentionMinutes"
                    type="number"
                    min="1"
                    max={Math.floor(filePolicy.maxRetentionSeconds / 60)}
                    defaultValue=""
                    placeholder="空欄で現在の設定を維持"
                  />
                  <small>
                    {settings.expires_at
                      ? `現在の期限: ${new Date(settings.expires_at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}。`
                      : "現在は期限未設定です。"}
                    期限後は完全削除します。期限は投稿時刻から計算します。
                  </small>
                </label>
              )}
              <button className="primary full" type="submit">
                設定を保存
              </button>
            </form>
            <hr />
            <label>
              移動先フォルダID
              <input id="move-parent" placeholder="空欄でこの領域のホームへ" />
            </label>
            <button
              onClick={() =>
                update({
                  parent:
                    (document.getElementById("move-parent") as HTMLInputElement)
                      .value || null,
                })
              }
            >
              移動する
            </button>
            <p className="muted mono">ID: {settings.id}</p>
            <label>
              共有リンク
              <input
                readOnly
                value={location.origin + "/?item=" + settings.id}
                onFocus={(e) => e.target.select()}
              />
            </label>
            <button
              onClick={() =>
                run(async () => {
                  await navigator.clipboard.writeText(
                    location.origin + "/?item=" + settings.id,
                  );
                  setMessage("共有リンクをコピーしました");
                })
              }
            >
              共有リンクをコピー
            </button>
          </section>
        </Modal>
      )}
      {preview && (
        <Modal
          onClose={() => {
            setPreview(null);
            setPreviewUrl("");
          }}
        >
          <section
            className="modal preview-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="preview-title"
          >
            <button
              className="close"
              aria-label="閉じる"
              onClick={() => {
                setPreview(null);
                setPreviewUrl("");
              }}
            >
              ×
            </button>
            <h2 id="preview-title">{preview.name}</h2>
            {/\.(mp4|webm|mov|mkv|avi|m4v)$/i.test(preview.name) ? (
              <>
                {previewUrl ? (
                  <video controls src={previewUrl} preload="metadata" />
                ) : (
                  <p role="status">CPUでプレビューを準備しています…</p>
                )}
                {user && (
                  <button onClick={transcode}>
                    軽量プレビューを作る（先頭120秒）
                  </button>
                )}
              </>
            ) : /\.(png|jpe?g|gif|webp)$/i.test(preview.name) ? (
              <img
                className="preview-image"
                src={previewUrl}
                alt={preview.name}
              />
            ) : /\.(mp3|ogg|wav)$/i.test(preview.name) ? (
              <audio controls src={previewUrl} />
            ) : (
              <p className="muted">
                この形式はダウンロードして開いてください。
              </p>
            )}
            <button className="primary" onClick={() => download(preview)}>
              ダウンロード · {size(preview.size)}
            </button>
          </section>
        </Modal>
      )}
    </>
  );
}
function UserRow({
  u,
  save,
  run,
}: {
  u: User & { ip: string };
  save: (data: any) => Promise<void>;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [level, setLevel] = useState(u.level),
    [status, setStatus] = useState(u.status),
    [quota, setQuota] = useState(String(u.quota / 1e9));
  useEffect(() => {
    setLevel(u.level);
    setStatus(u.status);
    setQuota(String(u.quota / 1e9));
  }, [u.id, u.level, u.status, u.quota]);
  return (
    <tr>
      <td>{u.name}</td>
      <td className="mono">{u.ip}</td>
      <td>
        <select
          aria-label={u.name + "の権限"}
          value={level}
          onChange={(e) => setLevel(Number(e.target.value))}
        >
          {levels.map((l, n) => (
            <option key={n} value={n}>
              {n} · {l}
            </option>
          ))}
        </select>
      </td>
      <td>
        <input
          className="quota-input"
          aria-label={u.name + "の容量GB"}
          type="number"
          min="0"
          max="200"
          step="0.1"
          value={quota}
          onChange={(e) => setQuota(e.target.value)}
        />
      </td>
      <td>
        <select
          aria-label={u.name + "の承認状態"}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="pending">承認待ち</option>
          <option value="approved">承認</option>
          <option value="denied">拒否</option>
        </select>
      </td>
      <td>
        <button
          onClick={() =>
            run(() =>
              save({
                id: u.id,
                level,
                status,
                quota: Math.round(Number(quota) * 1e9),
              }),
            )
          }
        >
          保存
        </button>
      </td>
    </tr>
  );
}
