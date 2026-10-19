import React, { useEffect, useState, useRef } from "react";
export function UserDirectory() {
  const moreAbort = useRef<AbortController | null>(null);
  const [query, setQuery] = useState(
      () => new URLSearchParams(location.search).get("q") ?? "",
    ),
    [search, setSearch] = useState(query),
    [users, setUsers] = useState<any[]>([]),
    [next, setNext] = useState<string | null>(null),
    [enabled, setEnabled] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError("");
    setUsers([]);
    setNext(null);
    const params = new URLSearchParams();
    if (search) params.set("q", search);
    history.replaceState(
      history.state,
      "",
      "/users" + (params.size ? "?" + params.toString() : ""),
    );
    fetch("/api/users?" + params, { signal: controller.signal })
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error);
        setUsers(data.users);
        setNext(data.next);
        setEnabled(data.enabled);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => {
      controller.abort();
      moreAbort.current?.abort();
    };
  }, [search]);
  const more = async () => {
    if (!next || busy) return;
    const controller = new AbortController();
    moreAbort.current = controller;
    setBusy(true);
    setError("");
    try {
      const params = new URLSearchParams({ q: search, after: next });
      const r = await fetch("/api/users?" + params, {
        signal: controller.signal,
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      setUsers((current) => [...current, ...data.users]);
      setNext(data.next);
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : "検索できませんでした");
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return (
    <section className="panel user-directory">
      <p className="eyebrow">CREATORS</p>
      <h1>投稿者を探す</h1>
      <p className="muted">
        名前から投稿者を検索して、投稿したファイルをまとめて見られます。閲覧できるファイルのある投稿者を表示します。
      </p>
      <form
        className="user-search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(query.trim());
        }}
      >
        <label>
          投稿者名を検索
          <input
            type="search"
            value={query}
            maxLength={64}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ユーザー名で検索…"
            autoComplete="off"
          />
        </label>
        <button className="primary" type="submit">
          検索
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      {!enabled && <p>投稿者情報の表示は管理者によって無効になっています。</p>}
      <div className="creator-grid" aria-busy={busy}>
        {users.map((user) => (
          <a
            className="creator-card"
            key={user.id}
            href={`/users/${encodeURIComponent(user.id)}`}
          >
            {user.avatar ? (
              <img
                className="profile-avatar"
                src={user.avatar}
                alt=""
                loading="lazy"
              />
            ) : (
              <span className="creator-monogram" aria-hidden="true">
                {user.name.slice(0, 1).toUpperCase()}
              </span>
            )}
            <div>
              <h2>{user.name}</h2>
              <p>{user.bio || "投稿したファイルを見てみましょう。"}</p>
              <span className="creator-open">投稿ファイルを見る ↗</span>
            </div>
          </a>
        ))}
      </div>
      {busy && <p role="status">投稿者を検索中…</p>}
      {!busy && enabled && !users.length && !error && (
        <p className="empty">
          {search
            ? "一致する投稿者が見つかりません。"
            : "閲覧できる投稿ファイルはまだありません。"}
        </p>
      )}
      {next && (
        <button disabled={busy} onClick={more}>
          投稿者をさらに表示
        </button>
      )}
    </section>
  );
}
