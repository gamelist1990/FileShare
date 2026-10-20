import React, { useState, type ReactNode } from "react";

export const adminSections = [
  ["overview", "ダッシュボード", "状況を確認して、必要な作業へ。"],
  [
    "users",
    "ユーザー",
    "ユーザーを検索し、権限・承認状態・個人容量を管理します。",
  ],
  ["files", "ファイル", "投稿者、ダウンロード数、保存期限を確認・調整します。"],
  ["storage", "ストレージ", "接続中のドライブと割当容量を管理します。"],
  [
    "access",
    "申請・招待",
    "登録申請を審査し、VIP・スタッフの招待を発行します。",
  ],
  [
    "settings",
    "利用・保存設定",
    "登録方法、投稿権限、保存期間と容量のルールを設定します。",
  ],
  ["ai", "AI監視", "監視サービスの接続先とモデル、実行間隔を設定します。"],
  ["audit", "審査・ログ", "日付別に登録審査とサービスの操作記録を確認します。"],
  ["trash", "ごみ箱", "削除した項目を確認し、復元または完全削除します。"],
  ["system", "メンテナンス", "公開の一時停止と、進行中の転送を確認します。"],
  ["all", "全体", "すべての管理項目をまとめて表示します。"],
] as const;
export function initialAdminTab() {
  const value = new URLSearchParams(location.search).get("view");
  return adminSections.some(([id]) => id === value) ? value! : "overview";
}
export function AdminIcon({ kind }: { kind: string }) {
  const paths: Record<string, string> = {
    overview: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
    users:
      "M15 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M17 4a4 4 0 0 1 0 8 M21 21v-2a4 4 0 0 0-3-3.87",
    files:
      "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M8 13h8 M8 17h5",
    storage: "M4 3h16v7H4z M4 14h16v7H4z M7 6h.01 M7 17h.01 M11 6h6 M11 17h6",
    access: "M3 5h18v14H3z M3 5l9 8 9-8",
    settings: "M4 5h16 M4 12h16 M4 19h16 M8 2v6 M16 9v6 M10 16v6",
    ai: "M5 5h14v14H5z M9 9h6v6H9z M9 2v3 M15 2v3 M9 19v3 M15 19v3 M2 9h3 M2 15h3 M19 9h3 M19 15h3",
    audit: "M4 3h7v18H4z M14 3h6v18h-6z M7 7h1 M7 11h1 M17 7h.01 M17 11h.01",
    trash: "M3 6h18 M8 6V3h8v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7",
    system:
      "M14.7 6.3a5 5 0 0 0-6.4 6.4L3 18l3 3 5.3-5.3a5 5 0 0 0 6.4-6.4l-3 3-3-3z",
    all: "M4 5h16 M4 12h16 M4 19h16",
  };
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[kind] ?? paths.overview} />
    </svg>
  );
}
export function AdminWorkspace({
  tab,
  onTab,
  overview,
  refresh,
  children,
}: {
  tab: string;
  onTab: (tab: string) => void;
  overview: any;
  refresh: () => Promise<unknown>;
  children: ReactNode;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const section = adminSections.find(([id]) => id === tab) ?? adminSections[0];
  const pending =
    overview.metrics?.pending ??
    overview.users.filter((u: any) => u.status === "pending").length;
  const used = overview.usage.used,
    capacity = overview.capacity;
  const size = (n: number) =>
    n >= 1e9
      ? `${(n / 1e9).toLocaleString("ja-JP", { maximumFractionDigits: 1 })} GB`
      : `${(n / 1e6).toLocaleString("ja-JP", { maximumFractionDigits: 1 })} MB`;
  return (
    <div className="admin-workspace">
      <aside className="admin-sidebar">
        <div className="admin-sidebar-title">
          <span className="admin-logo">
            <AdminIcon kind="storage" />
          </span>
          <div>
            <strong>FileShare</strong>
            <small>管理コンソール</small>
          </div>
        </div>
        <nav aria-label="管理メニュー" className="admin-section-nav">
          {adminSections.map(([id, label], n) => (
            <React.Fragment key={id}>
              {n === 5 && <p className="admin-nav-group">設定・運用</p>}
              <button
                aria-pressed={tab === id}
                aria-current={tab === id ? "page" : undefined}
                onClick={() => onTab(id)}
              >
                <AdminIcon kind={id} />
                <span>{label}</span>
                {id === "access" && pending > 0 && <b>{pending}</b>}
              </button>
            </React.Fragment>
          ))}
        </nav>
        <div className="admin-sidebar-usage">
          <small>ストレージ使用量</small>
          <strong>
            {size(used)} <span>/ {size(capacity)}</span>
          </strong>
          <progress
            aria-label="管理ストレージ使用量"
            max={capacity || 1}
            value={used}
          />
          <button onClick={() => onTab("storage")}>
            ドライブを管理 <span aria-hidden="true">↗</span>
          </button>
        </div>
      </aside>
      <div className="admin-body">
        <label className="admin-mobile-navigation">
          管理項目を選択
          <select
            aria-label="管理項目を選択"
            value={tab}
            onChange={(e) => onTab(e.target.value)}
          >
            {adminSections.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <header className="admin-page-header">
          <div>
            <p className="eyebrow">FILESHARE / ADMIN</p>
            <h1>{section[1]}</h1>
            <p>{section[2]}</p>
          </div>
          <button
            disabled={refreshing}
            onClick={async () => {
              setRefreshing(true);
              try {
                await refresh();
              } finally {
                setRefreshing(false);
              }
            }}
          >
            {refreshing ? "更新中…" : "最新の状態に更新"}
          </button>
        </header>
        {(tab === "overview" || tab === "all") && (
          <section className="admin-dashboard" aria-label="管理の概要">
            <div className="admin-metrics">
              <button onClick={() => onTab("users")}>
                <span>
                  <AdminIcon kind="users" />
                  登録ユーザー
                </span>
                <strong>
                  {overview.metrics?.users ?? overview.users.length}
                  <small>人</small>
                </strong>
                <em>ユーザーを管理 →</em>
              </button>
              <button
                className={pending ? "needs-attention" : ""}
                onClick={() => onTab("access")}
              >
                <span>
                  <AdminIcon kind="access" />
                  承認待ち
                </span>
                <strong>
                  {pending}
                  <small>件</small>
                </strong>
                <em>{pending ? "申請を確認 →" : "申請・招待を開く →"}</em>
              </button>
              <button onClick={() => onTab("storage")}>
                <span>
                  <AdminIcon kind="storage" />
                  使用容量
                </span>
                <strong>{size(used)}</strong>
                <em>割当 {size(capacity)} →</em>
              </button>
              <button onClick={() => onTab("system")}>
                <span>
                  <AdminIcon kind="system" />
                  A8への保存待ち
                </span>
                <strong>
                  {overview.metrics?.replicas ?? 0}
                  <small>件</small>
                </strong>
                <em>転送を確認 →</em>
              </button>
            </div>
            <div className="admin-dashboard-grid">
              <article className="admin-card">
                <div className="admin-card-heading">
                  <h2>よく使う操作</h2>
                  <span>QUICK ACCESS</span>
                </div>
                <div className="admin-quick-actions">
                  {[
                    ["files", "ファイルを探す", "投稿者や保存期限を確認"],
                    ["access", "招待を発行する", "VIP・スタッフを追加"],
                    ["storage", "容量を追加する", "ドライブと接続状態を確認"],
                    ["audit", "操作ログを確認", "日付別に履歴を開く"],
                  ].map(([id, title, desc]) => (
                    <button key={id} onClick={() => onTab(id)}>
                      <AdminIcon kind={id} />
                      <span>
                        <strong>{title}</strong>
                        <small>{desc}</small>
                      </span>
                      <span aria-hidden="true">↗</span>
                    </button>
                  ))}
                </div>
              </article>
              <article className="admin-card">
                <div className="admin-card-heading">
                  <h2>ストレージの状況</h2>
                  <button onClick={() => onTab("storage")}>詳細</button>
                </div>
                <div className="admin-capacity-reading">
                  <strong>
                    {Math.min(
                      100,
                      capacity ? (used / capacity) * 100 : 0,
                    ).toFixed(1)}
                    <small>% 使用中</small>
                  </strong>
                  <progress
                    aria-label="ダッシュボード使用率"
                    max={capacity || 1}
                    value={used}
                  />
                </div>
                <dl className="admin-capacity-list">
                  <div>
                    <dt>使用中</dt>
                    <dd>{size(used)}</dd>
                  </div>
                  <div>
                    <dt>アップロード予約</dt>
                    <dd>{size(overview.usage.reserved)}</dd>
                  </div>
                  <div>
                    <dt>動画プレビューのキャッシュ</dt>
                    <dd>{size(overview.cacheBytes ?? 0)}</dd>
                  </div>
                  <div>
                    <dt>ごみ箱の項目</dt>
                    <dd>{overview.trash.length} 件</dd>
                  </div>
                </dl>
              </article>
              <article className="admin-card admin-recent">
                <div className="admin-card-heading">
                  <h2>最近の操作</h2>
                  <button onClick={() => onTab("audit")}>すべての記録</button>
                </div>
                {overview.audit?.length ? (
                  <ul>
                    {overview.audit.slice(0, 5).map((a: any) => (
                      <li key={a.id}>
                        <span className="admin-event-dot" />
                        <span>
                          <strong>
                            {overview.users.find((u: any) => u.id === a.user_id)
                              ?.name ?? "システム"}
                          </strong>
                          <small>
                            {(
                              {
                                login: "ログイン",
                                upload: "ファイルをアップロード",
                                trash: "ファイルを削除",
                                "user.update": "ユーザー設定を変更",
                                "file.settings": "保存設定を更新",
                                "storage.map": "ドライブを追加",
                              } as Record<string, string>
                            )[a.action] ?? "管理操作を記録"}
                          </small>
                        </span>
                        <time>
                          {new Date(a.time).toLocaleString("ja-JP", {
                            month: "numeric",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                            timeZone: "Asia/Tokyo",
                          })}
                        </time>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="empty">まだ操作記録はありません</p>
                )}
              </article>
            </div>
          </section>
        )}
        <div className="admin-panels">{children}</div>
      </div>
    </div>
  );
}
