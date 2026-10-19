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
}: {
  request: (p: string, m?: string, b?: unknown) => Promise<any>;
  run: (f: () => Promise<unknown>) => Promise<void>;
}) {
  const [data, setData] = useState<any>({ volumes: [] });
  async function load() {
    setData(await request("/api/admin/storage/volumes"));
  }
  useEffect(() => {
    void run(load);
  }, []);
  return (
    <section className="panel" id="admin-volumes">
      <p className="eyebrow">STORAGE MAPPING</p>
      <h2>保存先ドライブ</h2>
      <p className="muted">
        A8にマウントされた既存・外部ドライブを追加できます。指定先の専用ディレクトリに新しいファイルを保存します。停止しても既存ファイルは保持されます。
      </p>
      <div className="volume-grid">
        {data.volumes.map((v: any) => (
          <article key={v.id}>
            <h3>{v.label}</h3>
            <code>{v.path}</code>
            <p>
              {(v.used / 1e9).toFixed(2)} / {(v.capacity / 1e9).toFixed(2)} GB
            </p>
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
        className="manager-filters"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          void run(async () => {
            await request("/api/admin/storage/volumes", "POST", {
              label: f.get("label"),
              path: f.get("path"),
              capacityBytes: Math.round(Number(f.get("gb")) * 1e9),
            });
            await load();
          });
        }}
      >
        <label>
          ドライブ名
          <input name="label" required maxLength={80} placeholder="外付けSSD" />
        </label>
        <label>
          マウント先の絶対パス
          <input name="path" required placeholder="/mnt/storage" />
        </label>
        <label>
          追加容量 GB
          <input name="gb" required type="number" min=".001" step=".001" />
        </label>
        <button className="primary">保存先を追加</button>
      </form>
    </section>
  );
}
