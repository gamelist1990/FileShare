import React, { useEffect, useState } from "react";
export function UserManager({
  request,
  run,
  onChange,
}: {
  request: (p: string, m?: string, b?: unknown) => Promise<any>;
  run: (f: () => Promise<unknown>) => Promise<void>;
  onChange: () => Promise<void>;
}) {
  const [q, setQ] = useState(""),
    [status, setStatus] = useState(""),
    [level, setLevel] = useState(""),
    [data, setData] = useState<any>({ users: [], total: 0, next: null }),
    [offset, setOffset] = useState(0),
    [busy, setBusy] = useState(false);
  async function load(start = offset) {
    setBusy(true);
    try {
      const p = new URLSearchParams({
        q,
        status,
        level,
        offset: String(start),
      });
      setData(await request("/api/admin/users?" + p));
      setOffset(start);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void run(() => load(0));
  }, []);
  return (
    <section className="panel" id="admin-users">
      <div className="section-title">
        <div>
          <p className="eyebrow">USER MANAGER</p>
          <h2>
            ユーザー管理 <small>{data.total}人</small>
          </h2>
        </div>
      </div>
      <button
        onClick={() =>
          void run(async () => {
            await load(0);
            await onChange();
          })
        }
      >
        更新
      </button>
      <form
        className="manager-filters"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => load(0));
        }}
      >
        <label>
          ユーザーを検索
          <input
            value={q}
            maxLength={100}
            onChange={(e) => setQ(e.target.value)}
            placeholder="ユーザー名"
          />
        </label>
        <label>
          状態
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">すべて</option>
            <option value="pending">承認待ち</option>
            <option value="approved">承認済み</option>
            <option value="denied">無効</option>
          </select>
        </label>
        <label>
          権限
          <select value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="">すべて</option>
            {["一般", "VIP", "招待", "スタッフ", "管理者"].map((v, n) => (
              <option key={n} value={n}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <button className="primary" disabled={busy}>
          絞り込む
        </button>
      </form>
      <div className="manager-user-list">
        {data.users.map((u: any) => (
          <form
            key={u.id}
            className="manager-user"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void run(async () => {
                await request("/api/admin/users", "PATCH", {
                  id: u.id,
                  status: f.get("status"),
                  level: Number(f.get("level")),
                  quota: Math.round(Number(f.get("quota")) * 1e9),
                });
                await load();
                await onChange();
              });
            }}
          >
            <div>
              <strong>{u.name}</strong>
              <small>
                {new Date(u.created).toLocaleDateString("ja-JP")} 登録
              </small>
            </div>
            <label>
              状態
              <select name="status" defaultValue={u.status}>
                <option value="pending">承認待ち</option>
                <option value="approved">承認済み</option>
                <option value="denied">無効</option>
              </select>
            </label>
            <label>
              権限
              <select name="level" defaultValue={u.level}>
                {["一般", "VIP", "招待", "スタッフ", "管理者"].map((v, n) => (
                  <option key={n} value={n}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label>
              個人容量 GB
              <input
                aria-label={u.name + "の容量GB"}
                name="quota"
                type="number"
                min="0"
                step=".1"
                defaultValue={u.quota / 1e9}
              />
            </label>
            <button>保存</button>
          </form>
        ))}
      </div>
      <div className="manager-pagination">
        <button
          disabled={!offset || busy}
          onClick={() => void run(() => load(Math.max(0, offset - 50)))}
        >
          前へ
        </button>
        <span>
          {data.total ? offset + 1 : 0}–{offset + data.users.length} /{" "}
          {data.total}
        </span>
        <button
          disabled={data.next === null || busy}
          onClick={() => void run(() => load(data.next))}
        >
          次へ
        </button>
      </div>
    </section>
  );
}
export function VolumeManager({
  request,
  run,
  onChange,
}: {
  request: (p: string, m?: string, b?: unknown) => Promise<any>;
  run: (f: () => Promise<unknown>) => Promise<void>;
  onChange?: () => Promise<void>;
}) {
  const [data, setData] = useState<any>({ volumes: [], candidates: [] }),
    [path, setPath] = useState(""),
    [manual, setManual] = useState(false),
    [label, setLabel] = useState(""),
    [preset, setPreset] = useState("auto"),
    [gb, setGb] = useState(""),
    [busy, setBusy] = useState(false);
  async function load() {
    setData(await request("/api/admin/storage/volumes"));
  }
  useEffect(() => {
    void run(load);
    const t = setInterval(() => {
      if (!document.hidden) void load().catch(() => {});
    }, 15000);
    return () => clearInterval(t);
  }, []);
  const candidate = data.candidates.find((c: any) => c.path === path),
    fmt = (n: number) =>
      `${(n / 1e9).toLocaleString("ja-JP", { maximumFractionDigits: 2 })} GB`;
  return (
    <section className="panel" id="admin-volumes">
      <div className="section-title">
        <div>
          <p className="eyebrow">STORAGE MAPPING</p>
          <h2>ストレージを増やす</h2>
        </div>
        <button disabled={busy} onClick={() => void run(load)}>
          ドライブを再検出
        </button>
      </div>
      <p className="muted">
        A8で接続・マウント済みのドライブを選ぶだけ。今の共有フォルダや個人フォルダの構造、URL、権限はそのままで、共有ストレージ全体の容量を増やせます。個人の割当上限は維持されます。
      </p>
      {data.capacity != null && (
        <div className="volume-capacity">
          <div>
            <small>割当済みの総容量</small>
            <strong>{fmt(data.capacity)}</strong>
          </div>
          <div>
            <small>接続中の容量</small>
            <strong>{fmt(data.onlineCapacity)}</strong>
          </div>
        </div>
      )}
      <div className="volume-grid">
        {data.volumes.map((v: any) => (
          <article key={v.id} className={!v.online ? "volume-offline" : ""}>
            <div className="volume-card-title">
              <h3>{v.label}</h3>
              <span className="badge">
                {!v.online
                  ? "接続不可"
                  : v.enabled
                    ? "接続中"
                    : "新規保存は停止中"}
              </span>
            </div>
            <code>{v.path}</code>
            <p>
              {fmt(v.used)} / {fmt(v.capacity)}
            </p>
            {!v.online && (
              <p role="status" className="storage-unavailable">
                保存先を確認できません。対象ファイルは404・破損／接続不可と表示されます。再接続すると自動的に復帰します。
              </p>
            )}
            {v.pendingDeletes > 0 && (
              <p className="muted">再接続後の削除待ち：{v.pendingDeletes}件</p>
            )}
            <button
              onClick={() =>
                void run(async () => {
                  await request("/api/admin/storage/volumes", "PATCH", {
                    id: v.id,
                    enabled: !v.enabled,
                  });
                  await load();
                })
              }
            >
              {v.enabled ? "新規保存を停止" : "新規保存を有効化"}
            </button>
          </article>
        ))}
      </div>
      <form
        className="volume-setup"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            setBusy(true);
            try {
              await request("/api/admin/storage/volumes", "POST", {
                label,
                path,
                detected: !manual,
                ...(preset !== "auto" || manual
                  ? {
                      capacityBytes: Math.round(
                        Number(preset === "custom" || manual ? gb : preset) *
                          1e9,
                      ),
                    }
                  : {}),
              });
              await load();
              await onChange?.();
              setPath("");
              setLabel("");
            } finally {
              setBusy(false);
            }
          });
        }}
      >
        <label>
          追加するドライブ
          <select
            aria-label="追加するドライブ"
            value={manual ? "manual" : path}
            onChange={(e) => {
              const value = e.target.value;
              setManual(value === "manual");
              setPath(value === "manual" ? "" : value);
              setPreset("auto");
              const c = data.candidates.find((c: any) => c.path === value);
              setLabel(c ? c.filesystem + " ストレージ" : "");
            }}
            required
          >
            <option value="">ドライブを選択</option>
            {data.candidates.map((c: any) => (
              <option key={c.path} value={c.path} disabled={c.registered}>
                {c.source} — 追加可能 {fmt(c.availableBytes)}
                {c.registered ? "（登録済み）" : ""}
              </option>
            ))}
            <option value="manual">パスを指定する（詳細設定）</option>
          </select>
        </label>
        {!manual && !data.candidates.length && (
          <p className="muted">
            書込可能なドライブが見つかりません。A8でドライブをマウントし、「再検出」を押してください。
          </p>
        )}
        {manual ? (
          <label>
            保存先ディレクトリの絶対パス
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/mnt/storage"
              required
            />
          </label>
        ) : (
          candidate && (
            <p className="volume-selected">
              <code>{candidate.path}</code>
              <span>
                空き {fmt(candidate.freeBytes)} ／
                既存の割当を除いた追加可能容量 {fmt(candidate.availableBytes)}
              </span>
            </p>
          )
        )}
        <div className="volume-options">
          <label>
            管理用の名前
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              required
              maxLength={80}
              placeholder="外付けSSD"
            />
          </label>
          {!manual && (
            <label>
              追加する容量
              <select
                aria-label="追加する容量"
                value={preset}
                onChange={(e) => setPreset(e.target.value)}
              >
                <option value="auto">空き容量から自動設定</option>
                {[10, 25, 50, 100, 250, 500]
                  .filter(
                    (n) => !candidate || n * 1e9 <= candidate.availableBytes,
                  )
                  .map((n) => (
                    <option key={n} value={n}>
                      {n} GB
                    </option>
                  ))}
                <option value="custom">容量を指定</option>
              </select>
            </label>
          )}
          {(manual || preset === "custom") && (
            <label>
              追加容量 GB
              <input
                value={gb}
                onChange={(e) => setGb(e.target.value)}
                required
                type="number"
                min=".001"
                step=".001"
                max={
                  candidate
                    ? Math.floor(candidate.availableBytes / 1e6) / 1000
                    : undefined
                }
              />
            </label>
          )}
        </div>
        {candidate && (
          <p className="muted">
            追加後の総容量：
            {fmt(
              data.capacity +
                (preset === "auto"
                  ? Math.floor(candidate.availableBytes / 1e6) * 1e6
                  : Number(preset === "custom" ? gb : preset) * 1e9),
            )}
          </p>
        )}
        <button
          className="primary"
          disabled={busy || !path || (!manual && !candidate)}
        >
          容量を追加
        </button>
        <p className="muted">
          接続不可の状態で削除したファイルは復元されません。削除予約をサーバーに保持し、ドライブが戻ったときに実データも削除します。通常の再接続確認は最大1分です。
        </p>
      </form>
    </section>
  );
}
