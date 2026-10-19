import { AvatarCrop } from "./AvatarCrop";
import React, { useEffect, useRef, useState } from "react";
import { FileIcon } from "./FileIcon";
import { CopyButton } from "./CopyButton";
import { useNotify } from "./Toast";

type Profile = {
  id: string;
  name: string;
  displayName: string;
  bio: string;
  location: string;
  links: { label: string; url: string }[];
  avatar: string | null;
  cover: string | null;
  coverPosition: number;
};
async function api(path: string, method = "GET", body?: unknown) {
  const r = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "処理できませんでした");
  return data;
}
const count = (n: number) =>
  new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
const size = (n: number) =>
  n >= 1048576
    ? `${+(n / 1048576).toFixed(1)} MB`
    : `${Math.max(1, Math.ceil(n / 1024))} KB`;
export function ProfileIdentity({
  profile,
  children,
}: {
  profile: Profile;
  children?: React.ReactNode;
}) {
  return (
    <section className="social-identity">
      <div
        className={`social-cover ${profile.cover ? "" : "social-cover-default"}`}
      >
        {profile.cover ? (
          <img
            src={profile.cover}
            alt="カバー画像"
            style={{ objectPosition: `center ${profile.coverPosition}%` }}
          />
        ) : (
          <span aria-hidden="true">PEX / FILESHARE</span>
        )}
      </div>
      <div className="social-identity-body">
        <div className="social-avatar-row">
          {profile.avatar ? (
            <img
              className="social-avatar"
              src={profile.avatar}
              alt="プロフィールアイコン"
            />
          ) : (
            <span className="social-avatar social-monogram" aria-hidden="true">
              {(profile.displayName || profile.name).slice(0, 1).toUpperCase()}
            </span>
          )}
          <div className="social-profile-actions">{children}</div>
        </div>
        <h1>{profile.displayName || profile.name}</h1>
        <p className="social-handle">@{profile.name}</p>
        {profile.bio && <p className="profile-bio">{profile.bio}</p>}
        {profile.location && (
          <p className="social-location">
            <span aria-hidden="true">⌖</span> {profile.location}
          </p>
        )}
        <nav className="profile-links" aria-label="SNSリンク">
          {profile.links.map((link, i) => (
            <a
              key={i}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {link.label} <span aria-hidden="true">↗</span>
            </a>
          ))}
        </nav>
      </div>
    </section>
  );
}
// Decode and resize locally; no full-resolution original is uploaded.
async function prepareImage(file: File, kind: "cover" | "avatar") {
  if (
    !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
    file.size > 12 * 1024 * 1024
  )
    throw new Error("画像は12MB以内のPNG・JPEG・WebPを選んでください");
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(
      1,
      (kind === "cover" ? 1500 : 400) / Math.max(bitmap.width, bitmap.height),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("画像を読み込めませんでした");
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const max = kind === "cover" ? 768 * 1024 : 256 * 1024;
    for (const quality of [0.86, 0.7, 0.5]) {
      const result = canvas.toDataURL("image/webp", quality);
      if (atob(result.split(",")[1]).length <= max) return result;
    }
    throw new Error("画像を小さくしてから選び直してください");
  } finally {
    bitmap.close();
  }
}
export function ProfilePage({ id }: { id?: string }) {
  const editing = !id,
    notify = useNotify();
  const [profile, setProfile] = useState<Profile | null>(null),
    [draft, setDraft] = useState<Profile | null>(null),
    [data, setData] = useState<any>(null),
    [owner, setOwner] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [imageBusy, setImageBusy] = useState(false),
    [dirty, setDirty] = useState(false),
    [tab, setTab] = useState("files");
  const [cropFile, setCropFile] = useState<File | null>(null);
  const [imageNames, setImageNames] = useState({ avatar: "", cover: "" });
  const imageTasks = useRef(0),
    imageRevision = useRef({ cover: 0, avatar: 0 });
  useEffect(() => {
    let alive = true;
    (async () => {
      if (editing) {
        const p = await api("/api/profile");
        if (alive) {
          setProfile(p);
          setDraft(p);
        }
      } else {
        const result = await api(`/api/users/${id}/files`);
        if (alive) {
          setProfile(result.profile);
          setData(result);
        }
        const me = await api("/api/me");
        if (alive)
          setOwner(
            me.user?.id === result.profile.id &&
              [1, 3, 4].includes(me.user.level),
          );
      }
    })().catch((e) => {
      if (alive) setError(e.message);
    });
    return () => {
      alive = false;
    };
  }, [id]);
  function update(patch: Partial<Profile>) {
    setDraft((p) => (p ? { ...p, ...patch } : p));
    setDirty(true);
  }
  async function image(file: File | undefined, kind: "avatar" | "cover") {
    if (!file) return;
    const revision = ++imageRevision.current[kind];
    imageTasks.current++;
    setImageBusy(true);
    setError("");
    try {
      const value = await prepareImage(file, kind);
      if (revision === imageRevision.current[kind]) update({ [kind]: value });
    } catch (e) {
      setError(e instanceof Error ? e.message : "画像を読み込めませんでした");
    } finally {
      imageTasks.current--;
      setImageBusy(imageTasks.current > 0);
    }
  }
  if (!profile)
    return (
      <section className="panel">
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : (
          <p role="status">プロフィールを読み込み中…</p>
        )}
      </section>
    );
  const shown = editing ? draft! : profile;
  const visibleItems = (data?.items ?? []).filter(
    (item: any) =>
      tab === "files" ||
      /\.(png|jpe?g|webp|gif|avif|mp4|webm|mov|m4v|mp3|ogg|wav|m4a)$/i.test(
        item.name,
      ),
  );
  return (
    <>
      {cropFile && (
        <AvatarCrop
          file={cropFile}
          onClose={() => {
            setCropFile(null);
            setImageNames((n) => ({ ...n, avatar: "" }));
            const input = document.querySelector<HTMLInputElement>(
              'input[name="avatar-image"]',
            );
            if (input) input.value = "";
          }}
          onApply={(value) => {
            update({ avatar: value });
            setCropFile(null);
          }}
        />
      )}
      <div className={`social-layout ${editing ? "social-edit-layout" : ""}`}>
        <div className="social-main">
          <div className="social-page-title">
            <a
              href={editing ? `/users/${profile.id}` : "/users"}
              aria-label={editing ? "投稿者ページへ" : "投稿者一覧へ"}
            >
              ←
            </a>
            <div>
              <h2>
                {editing
                  ? "プロフィールを編集"
                  : profile.displayName || profile.name}
              </h2>
              <span>
                {editing
                  ? "自分らしいページに整えましょう"
                  : "PROFILE / FILESHARE"}
              </span>
            </div>
          </div>
          {editing && (
            <p className="social-preview-label">
              LIVE PREVIEW <span>変更は保存するまで公開されません</span>
            </p>
          )}
          <ProfileIdentity profile={shown}>
            {!editing && (
              <>
                {owner && (
                  <a className="social-outline" href="/profile">
                    プロフィールを編集
                  </a>
                )}
                <CopyButton text={location.origin + `/users/${profile.id}`}>
                  共有
                </CopyButton>
              </>
            )}
          </ProfileIdentity>
          {error && (
            <p className="error social-inline-message" role="alert">
              {error}
            </p>
          )}
          {!editing && (
            <>
              <div className="social-file-summary">
                <strong>{count(data.items.length)}</strong>{" "}
                件の閲覧可能なファイルを表示中
                {data.next != null && "（続きあり）"}
              </div>
              <div
                className="social-tabs"
                role="tablist"
                aria-label="投稿ファイルの表示"
              >
                {[
                  ["files", "ファイル"],
                  ["media", "メディア"],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    id={`profile-tab-${value}`}
                    role="tab"
                    aria-selected={tab === value}
                    tabIndex={tab === value ? 0 : -1}
                    onKeyDown={(e) => {
                      if (
                        ["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                          e.key,
                        )
                      ) {
                        e.preventDefault();
                        const next =
                          e.key === "Home"
                            ? "files"
                            : e.key === "End"
                              ? "media"
                              : tab === "files"
                                ? "media"
                                : "files";
                        setTab(next);
                        document.getElementById(`profile-tab-${next}`)?.focus();
                      }
                    }}
                    aria-controls="profile-file-panel"
                    onClick={() => setTab(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <section
                id="profile-file-panel"
                role="tabpanel"
                aria-labelledby={`profile-tab-${tab}`}
                className="social-feed"
              >
                <h2 className="sr-only">投稿したファイル</h2>
                {visibleItems.map((item: any) => (
                  <article className="social-post" key={item.id}>
                    <span className="social-post-icon" aria-hidden="true">
                      {profile.avatar ? (
                        <img src={profile.avatar} alt="" loading="lazy" />
                      ) : (
                        (profile.displayName || profile.name)
                          .slice(0, 1)
                          .toUpperCase()
                      )}
                    </span>
                    <div className="social-post-content">
                      <div className="social-post-author">
                        <strong>{profile.displayName || profile.name}</strong>
                        <span>@{profile.name}</span>
                        <time dateTime={new Date(item.created).toISOString()}>
                          {new Date(item.created).toLocaleDateString("ja-JP")}
                        </time>
                      </div>
                      <a
                        className="social-file-card"
                        aria-label={item.name}
                        href={`/files/${item.id}/preview`}
                      >
                        <FileIcon name={item.name} />
                        <span>
                          <strong>{item.name}</strong>
                          {item.storageState === "unavailable" && (
                            <small className="storage-unavailable">
                              404 · 破損・接続不可
                            </small>
                          )}
                          <small>{size(item.size)} · プレビューを開く</small>
                        </span>
                        <span aria-hidden="true">↗</span>
                      </a>
                      <div className="social-post-meta">
                        {item.downloads != null && (
                          <span>↓ {count(item.downloads)} ダウンロード</span>
                        )}
                        <a href={`/files/${item.id}/preview`}>ファイルを見る</a>
                      </div>
                    </div>
                  </article>
                ))}
                {!visibleItems.length && (
                  <div className="social-empty">
                    <h3>
                      {tab === "media"
                        ? "メディアはまだありません"
                        : "ファイルはまだありません"}
                    </h3>
                    <p>現在の閲覧権限で見られる投稿がここに表示されます。</p>
                  </div>
                )}
                {data.next != null && (
                  <button
                    className="social-load-more"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        const next = await api(
                          `/api/users/${id}/files?offset=${data.next}`,
                        );
                        setData({
                          ...next,
                          items: [...data.items, ...next.items],
                        });
                      } catch (e) {
                        setError((e as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    {busy ? "読み込み中…" : "続きを表示"}
                  </button>
                )}
              </section>
            </>
          )}
          {editing && (
            <div className="social-edit-note">
              <strong>あなたの公開プロフィール</strong>
              <p>
                カバー・アイコン・自己紹介・SNSリンクが投稿者ページに表示されます。ファイルの公開範囲は各ファイルの設定が適用されます。
              </p>
            </div>
          )}
        </div>
        {editing ? (
          <form
            className="social-editor"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              try {
                await api("/api/profile", "PATCH", {
                  displayName: draft!.displayName,
                  bio: draft!.bio,
                  location: draft!.location,
                  links: draft!.links,
                  avatar: draft!.avatar,
                  cover: draft!.cover,
                  coverPosition: draft!.coverPosition,
                });
                const saved = await api("/api/profile");
                setProfile(saved);
                setDraft(saved);
                setDirty(false);
                notify("プロフィールを保存しました");
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <div className="social-editor-title">
              <h2>ページをカスタマイズ</h2>
              <span>{dirty ? "未保存の変更" : "保存済み"}</span>
            </div>
            <fieldset disabled={busy}>
              <legend>画像</legend>
              {(["cover", "avatar"] as const).map((kind) => (
                <div className="social-image-setting" key={kind}>
                  <label>
                    {kind === "cover" ? "カバー画像" : "アイコン"}
                    <input
                      name={kind + "-image"}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        if (
                          !["image/png", "image/jpeg", "image/webp"].includes(
                            file.type,
                          ) ||
                          file.size > 12 * 1024 * 1024
                        ) {
                          setError("12MB以内のPNG・JPEG・WebPを選んでください");
                          return;
                        }
                        setImageNames((n) => ({ ...n, [kind]: file.name }));
                        if (kind === "avatar") setCropFile(file);
                        else void image(file, kind);
                      }}
                    />
                  </label>
                  <span className="selected-image-name">
                    {imageNames[kind] ||
                      (draft?.[kind] ? "保存済みの画像" : "未選択")}
                  </span>
                  <button
                    type="button"
                    disabled={!draft?.[kind] || imageBusy}
                    onClick={(e) => {
                      imageRevision.current[kind]++;
                      setImageNames((n) => ({ ...n, [kind]: "" }));
                      const input = e.currentTarget
                        .closest(".social-image-setting")
                        ?.querySelector<HTMLInputElement>("input[type=file]");
                      if (input) input.value = "";
                      update({ [kind]: null });
                    }}
                  >
                    削除
                  </button>
                </div>
              ))}
              <p className="muted">
                PNG・JPEG・WebP、12MBまで。選択した画像は自動で軽量化します。
              </p>
              {draft!.cover && (
                <label>
                  カバーの表示位置
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={draft!.coverPosition}
                    onChange={(e) =>
                      update({ coverPosition: Number(e.target.value) })
                    }
                  />
                </label>
              )}
            </fieldset>
            <fieldset disabled={busy}>
              <legend>基本情報</legend>
              <label>
                表示名
                <input
                  aria-label="表示名"
                  maxLength={50}
                  value={draft!.displayName}
                  onChange={(e) => update({ displayName: e.target.value })}
                  placeholder={profile.name}
                />
                <small>{draft!.displayName.length}/50</small>
              </label>
              <label>
                説明
                <textarea
                  aria-label="説明"
                  rows={5}
                  maxLength={2000}
                  value={draft!.bio}
                  onChange={(e) => update({ bio: e.target.value })}
                  placeholder="どんなファイルを公開していますか？"
                />
                <small>{draft!.bio.length}/2000</small>
              </label>
              <label>
                所在地
                <input
                  maxLength={80}
                  value={draft!.location}
                  onChange={(e) => update({ location: e.target.value })}
                  placeholder="例：東京 / オンライン"
                />
              </label>
              <p className="muted">
                ユーザー名 @{profile.name} は変わりません。所在地は任意です。
              </p>
            </fieldset>
            <fieldset disabled={busy}>
              <legend>SNS・リンク</legend>
              {draft!.links.map((link, i) => (
                <div className="social-link-edit" key={i}>
                  <label>
                    SNS名
                    <input
                      required
                      maxLength={40}
                      value={link.label}
                      onChange={(e) =>
                        update({
                          links: draft!.links.map((l, j) =>
                            i === j ? { ...l, label: e.target.value } : l,
                          ),
                        })
                      }
                    />
                  </label>
                  <label>
                    HTTPS URL
                    <input
                      type="url"
                      required
                      maxLength={2048}
                      value={link.url}
                      onChange={(e) =>
                        update({
                          links: draft!.links.map((l, j) =>
                            i === j ? { ...l, url: e.target.value } : l,
                          ),
                        })
                      }
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() =>
                      update({ links: draft!.links.filter((_, j) => j !== i) })
                    }
                  >
                    リンクを削除
                  </button>
                </div>
              ))}
              <button
                type="button"
                disabled={draft!.links.length >= 8}
                onClick={() =>
                  update({
                    links: [...draft!.links, { label: "", url: "https://" }],
                  })
                }
              >
                SNSリンクを追加
              </button>
            </fieldset>
            <div className="social-save-bar">
              <button
                type="submit"
                className="primary"
                disabled={busy || imageBusy || !dirty}
              >
                {imageBusy
                  ? "画像を準備中…"
                  : busy
                    ? "保存中…"
                    : "プロフィールを保存"}
              </button>
              <a href={`/users/${profile.id}`}>投稿者ページを見る</a>
            </div>
          </form>
        ) : (
          <aside className="social-aside">
            <p className="eyebrow">DISCOVER</p>
            <h2>ファイルから、投稿者へ。</h2>
            <p>気になる投稿者のファイルやリンクを、ひとつのページから。</p>
            <a className="social-outline" href="/users">
              ほかの投稿者を探す ↗
            </a>
            <a href="/rankings">ダウンロードランキング →</a>
            <small>閲覧できるファイルだけが表示されます。</small>
          </aside>
        )}
      </div>
    </>
  );
}
