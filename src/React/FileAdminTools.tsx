import { useNotice } from "./Toast";
import { PresetField } from "./PresetField";
import React, { useEffect, useState } from "react";
import { FullScreenPage } from "./FullScreenPage";
import { FileIcon } from "./FileIcon";
type Props = {
  users: { id: string; name: string }[];
  request: (path: string, method?: string, body?: unknown) => Promise<any>;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  refresh: () => Promise<void>;
};
export function FileAdminTools({ users, request, run, refresh }: Props) {
  const [policy, setPolicy] = useState<any>(null),
    [files, setFiles] = useState<any[]>([]),
    [ranking, setRanking] = useState<any[]>([]),
    [query, setQuery] = useState(""),
    [next, setNext] = useState<number | null>(null),
    [editing, setEditing] = useState<any>(null),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const load = async (offset = 0) => {
    const [f, r] = await Promise.all([
      request(
        `/api/admin/files?q=${encodeURIComponent(query)}&offset=${offset}`,
      ),
      request("/api/admin/rankings"),
    ]);
    setFiles((prev) => (offset ? [...prev, ...f.items] : f.items));
    setNext(f.next);
    setRanking(r.items);
  };
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
  useEffect(() => {
    void run(async () => {
      setPolicy((await request("/api/admin/settings")).files);
      await load();
    });
  }, []);
  useNotice(notice, setNotice);
  return (
    <>
      <section className="panel" id="admin-policy">
        <p className="eyebrow">FILE POLICIES</p>
        <h2>保存期間・容量と表示の設定</h2>
        {policy && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                setPolicy(
                  (
                    await request("/api/admin/settings", "PATCH", {
                      files: policy,
                    })
                  ).files,
                );
                await refresh();
                setNotice("ファイル設定を保存しました");
              });
            }}
          >
            <div className="admin-form-grid">
              <PresetField
                label="1ファイルの上限"
                kind="size"
                value={policy.maxFileBytes}
                onChange={(maxFileBytes) =>
                  setPolicy({ ...policy, maxFileBytes })
                }
                max={200e9}
              />
              <PresetField
                label="保存期間の最大"
                value={policy.maxRetentionSeconds / 60}
                onChange={(minutes) =>
                  setPolicy({ ...policy, maxRetentionSeconds: minutes * 60 })
                }
                max={3650 * 1440}
              />
            </div>
            <p className="muted">
              既定の保存期間上限は30日（43,200分）です。各投稿者は1分から上限まで設定できます。期間上限は新規投稿と期間の変更に適用し、既存ファイルの期限は維持します。容量上限は転送の開始・再開・確定時に適用します。
            </p>
            {[
              ["trackDownloads", "ダウンロード数を記録する"],
              ["showDownloadCounts", "ダウンロード数を利用者に表示する"],
              ["showUploaders", "投稿者名を利用者に表示する"],
              ["rankingEnabled", "公開ファイルのランキングを表示する"],
            ].map(([key, label]) => (
              <label className="inline" key={key}>
                <input
                  type="checkbox"
                  checked={policy[key]}
                  onChange={(e) =>
                    setPolicy({ ...policy, [key]: e.target.checked })
                  }
                />
                {label}
              </label>
            ))}
            <button className="primary" disabled={busy} type="submit">
              ファイル設定を保存
            </button>
          </form>
        )}
      </section>
      <section className="panel" id="admin-records">
        <div className="section-title">
          <div>
            <p className="eyebrow">FILE RECORDS</p>
            <h2>投稿者・ダウンロード数・期限の管理</h2>
          </div>
        </div>
        <p className="muted">
          同じダウンロードリンクの再開・Range通信は1回とし、プレビューやHEAD確認は数えません。期限後は閲覧を停止し、1分ごとの整理で完全削除します。既存の期限未設定ファイルは変更するまで維持します。
        </p>
        <form
          className="actions"
          onSubmit={(e) => {
            e.preventDefault();
            void act(() => load());
          }}
        >
          <label>
            ファイル名で検索
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              maxLength={80}
            />
          </label>
          <button type="submit" disabled={busy}>
            ファイル記録を検索
          </button>
        </form>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ファイル</th>
                <th>投稿者</th>
                <th>DL数</th>
                <th>削除期限（日本時間）</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {files.map((f) => (
                <tr key={f.id}>
                  <td data-label="ファイル">
                    <span className="file-record-name">
                      <FileIcon name={f.name} />
                      {f.name}
                    </span>
                  </td>
                  <td data-label="投稿者">{f.uploader_name ?? "記録なし"}</td>
                  <td data-label="DL数">{f.downloads ?? 0}</td>
                  <td data-label="削除期限（日本時間）">
                    {f.expires_at
                      ? new Date(f.expires_at).toLocaleString("ja-JP", {
                          timeZone: "Asia/Tokyo",
                        })
                      : "期限未設定（既存）"}
                  </td>
                  <td data-label="操作">
                    <button onClick={() => setEditing(f)}>記録を調整</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!files.length && <p className="empty">ファイルはありません</p>}
        {next !== null && (
          <button disabled={busy} onClick={() => act(() => load(next))}>
            次の100件を表示
          </button>
        )}
        <h3>管理者用ダウンロードランキング</h3>
        <p className="muted">
          このランキングは非公開ファイルも含み、管理者だけが閲覧できます。
        </p>
        <ol className="admin-ranking">
          {ranking.map((f) => (
            <li key={f.id}>
              <button className="filename" onClick={() => setEditing(f)}>
                <FileIcon name={f.name} />
                {f.name}
              </button>
              <span>
                {f.downloads ?? 0} DL · {f.uploader_name ?? "記録なし"}
              </span>
            </li>
          ))}
        </ol>
      </section>
      {editing && (
        <FullScreenPage onClose={() => setEditing(null)}>
          <section
            className="screen-content"
            role="region"
            aria-labelledby="file-record-title"
          >
            <h2 id="file-record-title">ファイル記録の調整</h2>
            <p>{editing.name}</p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const form = new FormData(e.currentTarget);
                void act(async () => {
                  await request("/api/admin/files/" + editing.id, "PATCH", {
                    downloads: Number(form.get("downloads")),
                    uploadedBy: form.get("uploader") || null,
                    ...(form.get("retention")
                      ? { retentionSeconds: Number(form.get("retention")) * 60 }
                      : {}),
                  });
                  setEditing(null);
                  await load();
                  setNotice("ファイル記録を更新しました");
                });
              }}
            >
              <label>
                ダウンロード数
                <input
                  type="number"
                  name="downloads"
                  min="0"
                  max="1000000000000"
                  defaultValue={editing.downloads ?? 0}
                  required
                />
              </label>
              <label>
                投稿者
                <select
                  name="uploader"
                  defaultValue={editing.uploaded_by ?? ""}
                >
                  <option value="">記録なし</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
              </label>
              <PresetField
                key={editing.id}
                label="投稿からの保存期間"
                name="retention"
                keepCurrent
                max={Math.floor((policy?.maxRetentionSeconds ?? 2592000) / 60)}
              />
              <p className="muted">
                {editing.expires_at
                  ? `現在の期限: ${new Date(editing.expires_at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}。`
                  : "現在は期限未設定です。"}
                保存期限は投稿時刻から計算します。期限後は完全削除します。
              </p>
              <button className="primary full" disabled={busy} type="submit">
                ファイル記録を保存
              </button>
            </form>
          </section>
        </FullScreenPage>
      )}
    </>
  );
}
