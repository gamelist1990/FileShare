import { CopyButton } from "./CopyButton";
import React, { useEffect, useState } from "react";
import { FileAdminTools } from "./FileAdminTools";

type Props = {
  users: { id: string; name: string; status: string }[];
  reports: { id: number; time: number; report: string }[];
  refresh: () => Promise<void>;
  request: (path: string, method?: string, body?: unknown) => Promise<any>;
  run: (fn: () => Promise<unknown>) => Promise<void>;
};
const today = () =>
  new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const dateTime = (time: number) =>
  new Date(time).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
const actionNames: Record<string, string> = {
  register: "登録申請",
  "vip.register": "VIP招待で登録",
  "registration.settings": "登録・投稿設定を変更",
  "staff.register": "スタッフ招待で登録",
  "user.update": "ユーザーの審査・権限変更",
  "application.deny": "申請を無効化",
  "staff-invite.create": "スタッフ招待を発行",
  "staff-invite.revoke": "スタッフ招待を失効",
  "ai.settings": "AI監視設定を変更",
  login: "ログイン",
  "ai.error": "AI監視エラー",
};
export function AdminTools({ users, reports, refresh, request, run }: Props) {
  const [selected, setSelected] = useState<string[]>([]),
    [busy, setBusy] = useState(false);
  const [registration, setRegistration] = useState<any>(null);
  const [ai, setAI] = useState<any>(null),
    [invites, setInvites] = useState<any[]>([]);
  const [inviteURL, setInviteURL] = useState(""),
    [notice, setNotice] = useState("");
  const [month, setMonth] = useState(today().slice(0, 7)),
    [scope, setScope] = useState("review");
  const [days, setDays] = useState<{ day: string; count: number }[]>([]),
    [day, setDay] = useState(today());
  const [entries, setEntries] = useState<any[]>([]),
    [next, setNext] = useState<number | null>(null);
  const pending = users.filter((u) => u.status === "pending");
  const loadInvites = async () =>
    setInvites((await request("/api/admin/staff-invites")).invites);
  const act = (fn: () => Promise<unknown>) =>
    run(async () => {
      setBusy(true);
      setNotice("");
      try {
        await fn();
      } finally {
        setBusy(false);
      }
    });
  const loadDates = async () => {
    const result = await request(
      `/api/admin/audit/dates?month=${month}&scope=${scope}`,
    );
    setDays(result.days);
    setDay((current) =>
      result.days.some((d: any) => d.day === current)
        ? current
        : (result.days[0]?.day ?? month + "-01"),
    );
  };
  const loadEntries = async (before?: number) => {
    const result = await request(
      `/api/admin/audit?date=${day}&scope=${scope}${before ? "&before=" + before : ""}`,
    );
    setEntries((current) =>
      before ? [...current, ...result.entries] : result.entries,
    );
    setNext(result.next);
  };
  useEffect(() => {
    void run(async () => {
      const settings = await request("/api/admin/settings");
      setAI(settings.ai);
      setRegistration(settings.registration);
      await loadInvites();
    });
  }, []);
  useEffect(() => {
    let cancelled = false;
    void run(async () => {
      const result = await request(
        `/api/admin/audit/dates?month=${month}&scope=${scope}`,
      );
      if (cancelled) return;
      setDays(result.days);
      setDay(result.days[0]?.day ?? month + "-01");
    });
    return () => {
      cancelled = true;
    };
  }, [month, scope]);
  useEffect(() => {
    let cancelled = false;
    setEntries([]);
    setNext(null);
    void run(async () => {
      const result = await request(
        `/api/admin/audit?date=${day}&scope=${scope}`,
      );
      if (!cancelled) {
        setEntries(result.entries);
        setNext(result.next);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [day, scope]);
  useEffect(() => {
    setSelected((current) =>
      current.filter((id) =>
        users.some((u) => u.id === id && u.status === "pending"),
      ),
    );
  }, [users]);
  return (
    <>
      <FileAdminTools
        users={users}
        request={request}
        run={run}
        refresh={refresh}
      />
      {registration && (
        <section className="panel" id="admin-registration">
          <h2>登録・共有への投稿・パスキー</h2>
          <p className="muted">
            標準は招待限定です。登録済みアカウントは常にパスキーでログインできます。自動承認でもパスキー登録とIP別の登録制限は必要です。
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                const result = await request("/api/admin/settings", "PATCH", {
                  registration,
                });
                setRegistration(result.registration);
                setNotice("登録・投稿設定を保存しました");
              });
            }}
          >
            {(
              [
                ["publicRegistration", "招待URLのない一般ユーザーの登録を許可"],
                ["autoApprove", "一般ユーザーを登録時に自動承認"],
                ["vipSharedUploads", "VIPの共有ストレージへの投稿を許可"],
                [
                  "vipSharedEditing",
                  "VIPの共有ストレージの編集・削除・フォルダ作成を許可",
                ],
                [
                  "generalUploads",
                  "承認済み一般ユーザーの共有ストレージへの投稿を許可",
                ],
              ] as const
            ).map(([key, label]) => (
              <label key={key}>
                <input
                  type="checkbox"
                  checked={registration[key]}
                  onChange={(e) =>
                    setRegistration({
                      ...registration,
                      [key]: e.target.checked,
                    })
                  }
                />
                {label}
              </label>
            ))}
            <label>
              登録パスキー数の上限
              <input
                type="number"
                min="1"
                max="100"
                value={registration.maxPasskeys}
                onChange={(e) =>
                  setRegistration({
                    ...registration,
                    maxPasskeys: Number(e.target.value),
                  })
                }
              />
            </label>
            <p className="muted">
              既定は3件です。上限を下げても登録済みパスキーは削除しません。VIPは共有への投稿・編集が標準で無効で、一般ユーザーの投稿設定から独立しています。
            </p>
            <p className="muted">
              一般ユーザーは投稿のみ可能です。フォルダの作成、公開範囲の変更、既存ファイルの編集・削除、管理設定はできません。
            </p>
            <button className="primary" disabled={busy}>
              登録・投稿設定を保存
            </button>
          </form>
        </section>
      )}
      <section className="panel" id="admin-applications">
        <div className="section-title">
          <div>
            <p className="eyebrow">APPLICATIONS</p>
            <h2>登録申請の一括審査</h2>
          </div>
          <span className="badge">承認待ち {pending.length}件</span>
        </div>
        <p className="muted">
          無効化した申請はログインできなくなります。ユーザーと権限の一覧から再度承認できます。
        </p>
        <div className="actions">
          <button
            disabled={busy || !pending.length}
            onClick={() => setSelected(pending.map((u) => u.id))}
          >
            承認待ちをすべて選択
          </button>
          <button
            disabled={busy || !selected.length}
            onClick={() => setSelected([])}
          >
            選択を解除
          </button>
          <button
            className="danger"
            disabled={busy || !selected.length}
            onClick={() =>
              act(async () => {
                const result = await request(
                  "/api/admin/applications/deny",
                  "POST",
                  { ids: selected },
                );
                setSelected([]);
                await refresh();
                await loadDates();
                await loadEntries();
                setNotice(`${result.count}件の申請を無効化しました`);
              })
            }
          >
            選択した申請を無効化（{selected.length}）
          </button>
        </div>
        {pending.length ? (
          <ul className="application-list">
            {pending.map((u) => (
              <li key={u.id}>
                <label className="inline">
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={selected.includes(u.id)}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? [...selected, u.id]
                          : selected.filter((id) => id !== u.id),
                      )
                    }
                  />
                  {u.name}
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">承認待ちの申請はありません</p>
        )}
      </section>
      <section className="panel" id="admin-invites">
        <div className="section-title">
          <div>
            <p className="eyebrow">INVITATIONS</p>
            <h2>VIP・スタッフ招待URL</h2>
          </div>
        </div>
        <p className="muted">
          招待URLからパスキーを登録した人を、選択したVIPまたはスタッフとして自動承認します。URLは渡した相手が使えるため、信頼できる人にだけ共有してください。
        </p>
        <form
          className="admin-form-grid"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void act(async () => {
              const result = await request("/api/admin/staff-invites", "POST", {
                level: Number(f.get("level")),
                label: f.get("label"),
                hours: Number(f.get("hours")),
                maxUses: Number(f.get("maxUses")),
              });
              setInviteURL(result.url);
              await loadInvites();
              setNotice("招待URLを発行しました");
            });
          }}
        >
          <label>
            招待する権限
            <select name="level" defaultValue="3">
              <option value="1">VIP（Level 1・個人領域あり）</option>
              <option value="3">スタッフ（Level 3）</option>
            </select>
          </label>
          <label>
            招待名
            <input
              name="label"
              defaultValue="スタッフ招待"
              maxLength={80}
              required
            />
          </label>
          <label>
            有効期限（時間）
            <input
              name="hours"
              type="number"
              defaultValue="168"
              min="1"
              max="720"
              required
            />
          </label>
          <label>
            利用できる人数
            <input
              name="maxUses"
              type="number"
              defaultValue="1"
              min="1"
              max="100"
              required
            />
          </label>
          <button className="primary" disabled={busy} type="submit">
            招待URLを発行
          </button>
        </form>
        {inviteURL && (
          <div className="invite-result">
            <label>
              発行した招待URL
              <input
                aria-label="発行した招待URL"
                readOnly
                value={inviteURL}
                onFocus={(e) => e.target.select()}
              />
            </label>
            <CopyButton key={inviteURL} text={inviteURL}>
              URLをコピー
            </CopyButton>
            <p className="muted">
              このURLは今回だけ表示します。控えを失った場合は失効して再発行してください。
            </p>
          </div>
        )}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>招待名</th>
                <th>権限</th>
                <th>期限（日本時間）</th>
                <th>利用人数</th>
                <th>状態</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {invites.map((i) => {
                const active =
                  !i.revoked && i.expires > Date.now() && i.uses < i.max_uses;
                return (
                  <tr key={i.id}>
                    <td data-label="招待名">{i.label}</td>
                    <td data-label="権限">
                      {i.level === 1 ? "VIP" : "スタッフ"}
                    </td>
                    <td data-label="期限（日本時間）">{dateTime(i.expires)}</td>
                    <td data-label="利用人数">
                      {i.uses} / {i.max_uses}
                    </td>
                    <td data-label="状態">
                      {i.revoked
                        ? "失効"
                        : i.expires <= Date.now()
                          ? "期限切れ"
                          : i.uses >= i.max_uses
                            ? "利用済み"
                            : "有効"}
                    </td>
                    <td data-label="操作">
                      <button
                        disabled={busy || !active}
                        onClick={() =>
                          act(async () => {
                            await request(
                              "/api/admin/staff-invites/revoke",
                              "POST",
                              { id: i.id },
                            );
                            await loadInvites();
                            setInviteURL("");
                            setNotice("招待URLを失効しました");
                          })
                        }
                      >
                        失効する
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!invites.length && <p className="empty">発行した招待はありません</p>}
      </section>
      <section className="panel" id="admin-ai">
        <div className="section-title">
          <div>
            <p className="eyebrow">AI MONITORING</p>
            <h2>AI監視の設定</h2>
          </div>
        </div>
        <p className="muted">
          操作件数の集計をAIに送り、参考となる所見を作成します。ファイル本文やIPは送信しません。AIが権限変更や削除を行うことはありません。
        </p>
        {ai && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                setAI(
                  (await request("/api/admin/settings", "PATCH", { ai })).ai,
                );
                await refresh();
                setNotice("AI監視の設定を保存しました");
              });
            }}
          >
            <label className="inline">
              <input
                type="checkbox"
                checked={ai.enabled}
                onChange={(e) => setAI({ ...ai, enabled: e.target.checked })}
              />
              AI監視を使う
            </label>
            <div className="admin-form-grid">
              <label>
                モデル名
                <input
                  value={ai.model}
                  maxLength={120}
                  required
                  onChange={(e) => setAI({ ...ai, model: e.target.value })}
                />
              </label>
              <label>
                監視間隔（秒）
                <input
                  type="number"
                  min="60"
                  max="3600"
                  value={ai.intervalSeconds}
                  required
                  onChange={(e) =>
                    setAI({ ...ai, intervalSeconds: Number(e.target.value) })
                  }
                />
              </label>
              <button className="primary" disabled={busy} type="submit">
                AI設定を保存
              </button>
            </div>
            <p className="muted">
              設定は再起動後も保持されます。接続先:{" "}
              <span className="mono">{ai.endpoint}</span>
            </p>
          </form>
        )}
        <h3>AI監視レポート</h3>
        {reports.map((r) => (
          <article key={r.id}>
            <small>{dateTime(r.time)}</small>
            <p className="pre-wrap">{r.report}</p>
          </article>
        ))}
        {!reports.length && <p className="empty">レポートはまだありません</p>}
      </section>
      <section className="panel audit-library" id="admin-review">
        <div className="section-title">
          <div>
            <p className="eyebrow">REVIEW ARCHIVE / JST</p>
            <h2>審査・監査ログの本棚</h2>
          </div>
          <button
            disabled={busy}
            onClick={() =>
              act(async () => {
                await loadDates();
                await loadEntries();
              })
            }
          >
            ログを更新
          </button>
        </div>
        <div className="audit-controls">
          <label>
            年月
            <input
              type="month"
              value={month}
              onChange={(e) => {
                if (e.target.value) setMonth(e.target.value);
              }}
            />
          </label>
          <label>
            表示する記録
            <select value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="review">審査・管理操作のみ</option>
              <option value="all">すべての監査ログ</option>
            </select>
          </label>
        </div>
        <p className="muted">
          日本時間の日付ごとに、一冊の本として整理しています。本を選ぶと、その日の記録を開きます。
        </p>
        <div className="audit-bookshelf" aria-label="日付別のログ">
          {days.map((d) => (
            <button
              key={d.day}
              className={`audit-book${day === d.day ? " is-open" : ""}`}
              aria-pressed={day === d.day}
              aria-label={`${d.day}のログ ${d.count}件`}
              onClick={() => setDay(d.day)}
            >
              <span>{d.day.slice(0, 7).replace("-", " / ")}</span>
              <strong>{d.day.slice(8)}</strong>
              <span>{d.count}件の記録</span>
            </button>
          ))}
        </div>
        {!days.length && <p className="empty">この月の記録はありません</p>}
        <div className="audit-open-book">
          <h3>{day} の記録</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>時刻（日本時間）</th>
                  <th>操作</th>
                  <th>実行者 / IP</th>
                  <th>対象・詳細</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((a) => (
                  <tr key={a.id}>
                    <td data-label="時刻（日本時間）">{dateTime(a.time)}</td>
                    <td data-label="操作">
                      {actionNames[a.action] ?? a.action}
                    </td>
                    <td data-label="実行者 / IP">
                      <div>
                        {a.actor ?? "未ログイン / システム"}
                        <br />
                        <small>{a.ip}</small>
                      </div>
                    </td>
                    <td data-label="対象・詳細" className="mono">
                      {a.detail}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!entries.length && <p className="empty">この日の記録はありません</p>}
          {next && (
            <button
              onClick={() => act(() => loadEntries(next))}
              disabled={busy}
            >
              次の100件を読む
            </button>
          )}
        </div>
      </section>
      {notice && (
        <div role="status" className="notice">
          {notice}
        </div>
      )}
    </>
  );
}
