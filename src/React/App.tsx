import { PasskeyPage } from "./PasskeyPage";
import { PreviewContent } from "./PreviewContent";
import { compactCount } from "./CommunityPages";
import { uploadPipeline, PipelineError } from "./upload-pipeline";
import { CopyButton } from "./CopyButton";
import { PresetField, durationLabel } from "./PresetField";
import { useNotice } from "./Toast";
import React, { useState, useEffect, useRef } from "react";
import {
  startRegistration,
  startAuthentication,
} from "@simplewebauthn/browser";
import { nextChunk, prepareChunk, compressibleName } from "./transfer";
import { AdminTools } from "./AdminTools";
import { FullScreenPage } from "./FullScreenPage";
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
  uploaded_by?: string | null;
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
  const [keyResult, setKeyResult] = useState<{
    id: string;
    key: string;
  } | null>(null);
  const [passkeyOpen, setPasskeyOpen] = useState(false);
  const [deviceToken, setDeviceToken] = useState(
    () =>
      new URLSearchParams(location.hash.slice(1)).get("device-enroll") ?? "",
  );
  const [user, setUser] = useState<User | null>(null),
    [ready, setReady] = useState(false),
    [items, setItems] = useState<Item[]>([]),
    [parent, setParent] = useState<string | null>(null),
    [crumbs, setCrumbs] = useState<{ id: string; name: string }[]>([]),
    [space, setSpace] = useState("shared"),
    [writable, setWritable] = useState(false),
    [uploadable, setUploadable] = useState(false),
    [usage, setUsage] = useState({ used: 0, reserved: 0 }),
    [capacity, setCapacity] = useState<number | null>(null),
    [filePolicy, setFilePolicy] = useState<any>(null),
    [maintenanceUntil, setMaintenanceUntil] = useState<number | null>(null),
    [retentionMinutes, setRetentionMinutes] = useState(43200),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [authOpen, setAuthOpen] = useState(false),
    [task, setTask] = useState<"folder" | "trash" | "purge" | null>(null),
    [folderName, setFolderName] = useState(""),
    [registration, setRegistration] = useState(false),
    [autoApprove, setAutoApprove] = useState(false),
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
      level: number;
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
    [transferPhase, setTransferPhase] = useState<"uploading" | "paused" | "cancelling" | null>(null);
  const routePath = useRef(location.pathname);
  // Keep File objects while this tab is open: pausing must never require a second picker.
  const uploadQueue = useRef<{
    files: File[];
    index: number;
    parent: string | null;
    space: string;
    userId: string | undefined;
    retentionSeconds: number;
  } | null>(null);
  const activeUpload = useRef<{ id: string; key: string } | null>(null);
  const activeRequest = useRef<AbortController | null>(null);
  const stop = useRef<"pause" | "cancel" | null>(null),
    fileInput = useRef<HTMLInputElement>(null);
  const refreshMe = async () => {
    const d = await api("/api/me");
    setUser(d.user);
    setRegistration(d.registration);
    setAutoApprove(d.autoApprove);
    setFilePolicy(d.filePolicy);
    setMaintenanceUntil(d.maintenanceUntil ?? null);
    if (d.filePolicy)
      setRetentionMinutes((value) =>
        Math.min(value, Math.floor(d.filePolicy.maxRetentionSeconds / 60)),
      );
    setSetupRequired(d.setupRequired === true);
    if (!d.setupRequired) setBootstrap("");
    setReady(true);
    return d.user;
  };
  const listingRequest = useRef(0);
  const listingScope = useRef("");
  listingScope.current = `${space}:${parent ?? ""}:${user?.id ?? ""}`;
  const refresh = async () => {
    const scope = `${space}:${parent ?? ""}:${user?.id ?? ""}`;
    if (scope !== listingScope.current) return;
    const request = ++listingRequest.current;
    const d = await api(
      "/api/items?space=" + space + (parent ? "&parent=" + parent : ""),
    );
    if (request !== listingRequest.current || scope !== listingScope.current)
      return;
    setItems(d.items);
    setWritable(d.writable);
    setUploadable(d.uploadable);
    setUsage(d.usage);
    setCapacity(d.capacity);
    setSelected([]);
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
      setDeviceToken(
        new URLSearchParams(location.hash.slice(1)).get("device-enroll") ?? "",
      );
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
    if (ready && (admin || !maintenanceUntil || user?.level === 4))
      run(admin ? loadAdmin : refresh);
  }, [ready, parent, space, admin, user?.id, user?.level, maintenanceUntil]);
  useEffect(() => {
    const pop = () => {
      // Closing a task must keep the current folder and breadcrumb intact.
      if (routePath.current === location.pathname) return;
      routePath.current = location.pathname;
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
    routePath.current = location.pathname;
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
    if (value !== space || parent) {
      setCapacity(null);
      setUsage({ used: 0, reserved: 0 });
      setItems([]);
      setWritable(false);
      setUploadable(false);
    }
    setSpace(value);
    setParent(null);
    setCrumbs([]);
  };
  const enter = (i: Item) => {
    setParent(i.id);
    setCrumbs([...crumbs, { id: i.id, name: i.name }]);
  };
  async function cancelActiveUpload() {
    const session = activeUpload.current;
    if (!session) return;
    // A just-aborted request may still be releasing its server-side exclusive lease.
    for (let attempt = 0; attempt < 12; attempt++) {
      const response = await fetch("/api/uploads/" + session.id, {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (response.ok || response.status === 404) {
        sessionStorage.removeItem(session.key);
        activeUpload.current = null;
        return;
      }
      const data = await response.json().catch(() => ({}));
      if (response.status !== 409)
        throw new Error(data.error ?? "転送をキャンセルできませんでした");
      await new Promise((resolve) => setTimeout(resolve, 250 + attempt * 150));
    }
    throw new Error("転送終了処理が完了していません。もう一度キャンセルしてください");
  }
  const cancelTransfer = () => {
    stop.current = "cancel";
    activeRequest.current?.abort();
    if (transferPhase !== "paused") {
      setTransferPhase("cancelling");
      return;
    }
    void run(async () => {
      setBusy(true);
      setTransferPhase("cancelling");
      try {
        await cancelActiveUpload();
        uploadQueue.current = null;
        setProgress(null);
        setTransferPhase(null);
        await refresh();
        setMessage("転送をキャンセルしました。予約容量と途中データを解放しました。");
      } catch (error) {
        setTransferPhase("paused");
        throw error;
      } finally {
        setBusy(false);
      }
    });
  };
  async function upload(files: FileList | File[] | null, resume = false) {
    if (transferPhase === "uploading" || transferPhase === "cancelling") return;
    if (!resume) {
      if (!files?.length) return;
      if (uploadQueue.current)
        throw new Error("一時停止中の転送を再開するかキャンセルしてください");
      uploadQueue.current = {
        files: Array.from(files),
        index: 0,
        parent,
        space,
        userId: user?.id,
        retentionSeconds: retentionMinutes * 60,
      };
    }
    const queue = uploadQueue.current;
    if (!queue) return;
    if (queue.userId !== user?.id)
      throw new Error("転送開始時のアカウントで再開してください");
    setBusy(true);
    setTransferPhase("uploading");
    stop.current = null;
    let completed = false, cancelledTransfer = false;
    const interrupted = async () => {
      if (stop.current === "cancel") {
        setTransferPhase("cancelling");
        await cancelActiveUpload();
        uploadQueue.current = null;
        setProgress(null);
        cancelledTransfer = true;
        await refresh();
        setMessage("転送をキャンセルしました。予約容量と途中データを解放しました。");
      } else {
        setMessage("一時停止しました。ファイルを選び直さず再開できます。");
      }
    };
    try {
      while (queue.index < queue.files.length) {
        if (stop.current) { await interrupted(); return; }
        const file = queue.files[queue.index];
        if (filePolicy && file.size > filePolicy.maxFileBytes)
          throw new Error("1ファイルの上限は" + size(filePolicy.maxFileBytes) + "です");
        const fingerprint = JSON.stringify([
          file.name, file.size, file.lastModified,
          queue.parent, queue.space, queue.userId,
        ]);
        const resumeKey = "fs-upload:" + fingerprint;
        let compressionAllowed = false, pipelineAllowed = false;
        const probeStart = performance.now();
        let id = sessionStorage.getItem(resumeKey), offset = 0;
        if (id) {
          try {
            const resumed = await api("/api/uploads/" + id);
            if (resumed.size !== file.size) throw new Error("サイズが一致しません");
            offset = resumed.offset;
            compressionAllowed = resumed.encodings?.includes("gzip") === true;
            pipelineAllowed = resumed.pipeline === "fileshare-upload-v2";
          } catch {
            id = null;
            sessionStorage.removeItem(resumeKey);
          }
        }
        if (!id) {
          const d = await api("/api/uploads", "POST", {
            name: file.name,
            size: file.size,
            mime: file.type,
            retentionSeconds: queue.retentionSeconds,
            parent: queue.parent,
            space: queue.space,
          });
          id = d.id;
          compressionAllowed = d.encodings?.includes("gzip") === true;
          pipelineAllowed = d.pipeline === "fileshare-upload-v2";
          sessionStorage.setItem(resumeKey, id!);
        }
        activeUpload.current = { id: id!, key: resumeKey };
        setProgress({ name: file.name, percent: file.size ? offset / file.size * 100 : 100, speed: 0 });
        if (stop.current) { await interrupted(); return; }
        const roundTripMs = Math.max(0, performance.now() - probeStart);
        let tryCompression = compressionAllowed && compressibleName(file.name);
        if (
          pipelineAllowed && typeof WebSocket !== "undefined" &&
          file.size >= 2 * 1024 * 1024
        ) {
          for (let attempt = 0; attempt < 3 && offset < file.size; attempt++) {
            try {
              const url = new URL("/api/uploads/" + id + "/stream", location.origin);
              url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
              const result = await uploadPipeline({
                url: url.href,
                file,
                offset,
                roundTripMs,
                compress: tryCompression,
                stopped: () => stop.current !== null,
                progress: (received, speed) =>
                  setProgress({
                    name: file.name,
                    percent: file.size ? (received / file.size) * 100 : 100,
                    speed,
                  }),
              });
              offset = result.offset;
              if (result.stopped || stop.current) { await interrupted(); return; }
              break;
            } catch (error) {
              if (stop.current) { await interrupted(); return; }
              if (error instanceof PipelineError && error.fatal) throw error;
              await new Promise((resolve) =>
                setTimeout(resolve, Math.min(4000, 500 * 2 ** attempt)),
              );
              const resumed = await api("/api/uploads/" + id);
              offset = resumed.offset;
              if (resumed.pipeline !== "fileshare-upload-v2") break;
            }
          }
        }
        let chunkSize = 1024 * 1024, retries = 0;
        while (offset < file.size) {
          if (stop.current) { await interrupted(); return; }
          const prepared = await prepareChunk(
            file.slice(offset, offset + chunkSize),
            tryCompression,
          );
          if (stop.current) { await interrupted(); return; }
          if (tryCompression && prepared.logicalBytes >= 32768 && !prepared.compressed)
            tryCompression = false;
          const start = performance.now();
          const controller = new AbortController();
          activeRequest.current = controller;
          try {
            const r = await fetch("/api/uploads/" + id, {
              method: "PATCH",
              credentials: "same-origin",
              headers: {
                "Content-Type": "application/octet-stream",
                "Upload-Offset": String(offset),
                "Upload-Checksum": prepared.checksum,
                ...(prepared.compressed ? { "Upload-Encoding": "gzip" } : {}),
              },
              body: prepared.body,
              signal: controller.signal,
            });
            const d = await r.json();
            if (!r.ok) {
              if ([403, 401, 507, 413].includes(r.status))
                throw Object.assign(new Error(d.error), { fatal: true });
              throw new Error(d.error);
            }
            offset = d.offset;
            const elapsed = performance.now() - start;
            chunkSize = nextChunk(
              chunkSize, prepared.logicalBytes, elapsed, false, roundTripMs,
            );
            retries = 0;
            setProgress({
              name: file.name,
              percent: (offset / file.size) * 100,
              speed: (prepared.logicalBytes / Math.max(1, elapsed)) * 1000,
            });
          } catch (error) {
            if (stop.current) { await interrupted(); return; }
            if ((error as any).fatal || ++retries > 6) throw error;
            chunkSize = nextChunk(chunkSize, 0, 0, true);
            await new Promise((resolve) =>
              setTimeout(resolve, Math.min(10_000, 500 * 2 ** retries)),
            );
            offset = (await api("/api/uploads/" + id)).offset;
          } finally {
            if (activeRequest.current === controller) activeRequest.current = null;
          }
        }
        if (stop.current) { await interrupted(); return; }
        await api("/api/uploads/" + id + "/complete", "POST", {});
        sessionStorage.removeItem(resumeKey);
        activeUpload.current = null;
        queue.index++;
        setProgress({ name: file.name, percent: 100, speed: 0 });
      }
      completed = true;
      await refresh();
      setMessage("アップロードしました。");
    } finally {
      setBusy(false);
      activeRequest.current = null;
      if (completed || cancelledTransfer) {
        uploadQueue.current = null;
        setProgress(null);
        setTransferPhase(null);
      } else {
        // Failed uploads remain retryable; never throw away the File reference.
        setTransferPhase("paused");
      }
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
  const mkdirAction = () => {
    setFolderName("");
    setTask("folder");
  };
  const trash = () => {
    if (selected.length) setTask("trash");
  };
  const performTask = () =>
    run(async () => {
      setBusy(true);
      try {
        if (task === "folder") {
          if (!folderName.trim()) return;
          await api("/api/folders", "POST", {
            name: folderName.trim(),
            parent,
            space,
          });
          await refresh();
        } else if (task === "trash") {
          await api("/api/trash", "POST", { ids: selected });
          await refresh();
        } else if (task === "purge") {
          await api("/api/admin/maintenance", "POST", {
            action: "purge",
            ids: trashSelection,
          });
          setTrashSelection([]);
          await loadAdmin();
          setMessage("完全削除が完了しました");
        }
        setTask(null);
      } finally {
        setBusy(false);
      }
    });
  const update = (data: any) =>
    run(async () => {
      if (!settings) return;
      const d = await api("/api/items/" + settings.id, "PATCH", data);
      if (d.key) {
        setKeyResult({ id: settings.id, key: d.key });
        setMessage("招待キーを発行しました");
      } else setMessage("設定を保存しました");
      setSettings(null);
      await refresh();
    });
  const maintenance = (action: string) => {
    if (action === "purge") {
      setTask("purge");
      return;
    }
    return run(async () => {
      await api("/api/admin/maintenance", "POST", {
        action,
        ids: trashSelection,
      });
      setTrashSelection([]);
      await loadAdmin();
      setMessage("処理が完了しました");
    });
  };
  useNotice(message, setMessage);
  useNotice(error, setError, "error");
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
          <a href="/rankings">Ranking</a>
          <a href="/users">User</a>
          {user && [1, 3, 4].includes(user.level) && (
            <a href="/profile">Profile</a>
          )}
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
              <button onClick={() => setPasskeyOpen(true)}>パスキー追加</button>
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
            <h1>{admin ? "ストレージ管理" : "共有ストレージ"}</h1>
            <p className="sub">
              {admin
                ? "ユーザーと容量、共有ファイルをひとつの場所で管理。"
                : "みんなで使う共有フォルダと、あなただけのプライベート空間。"}
            </p>
          </div>
          <div className="hero-note">
            <strong>
              {admin
                ? "管理者専用"
                : capacity === null
                  ? "読み込み中…"
                  : size(capacity)}
            </strong>
            <span>
              {admin
                ? "Level 4"
                : space === "private"
                  ? "個人ストレージ"
                  : "共有ストレージ"}
            </span>
          </div>
        </section>
        {admin ? (
          user?.level === 4 && overview ? (
            <>
              <nav className="admin-jumps" aria-label="管理メニュー">
                <a href="#admin-users">ユーザー</a>
                <a href="#admin-policy">容量・期限</a>
                <a href="#admin-records">ファイル</a>
                <a href="#admin-applications">申請</a>
                <a href="#admin-invites">スタッフ招待</a>
                <a href="#admin-ai">AI監視</a>
                <a href="#admin-review">審査ログ</a>
                <a href="#admin-cleanup">整理</a>
              </nav>
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
              <section className="panel" id="admin-users">
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
              <section className="panel" id="admin-cleanup">
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
        ) : maintenanceUntil && maintenanceUntil > Date.now() && user?.level !== 4 ? (
          <section className="panel maintenance-view" role="status">
            <p className="eyebrow">SYSTEM MAINTENANCE</p>
            <h2>ただいまメンテナンス中です</h2>
            <p>サービスの更新作業のため、ファイルの閲覧・転送を一時停止しています。</p>
            <p className="muted">
              再開予定: {new Date(maintenanceUntil).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}
            </p>
            <p className="muted">保存済みファイルや途中まで転送されたデータは保持され、解除後に再開できます。</p>
            <div className="actions">
              <button onClick={() => void run(refreshMe)}>状態を再確認</button>
              <button onClick={() => setAuthOpen(true)}>管理者としてログイン</button>
            </div>
          </section>
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
                  {capacity === null ? (
                    "読み込み中…"
                  ) : (
                    <>
                      {size(usage.used)} <small>/ {size(capacity)}</small>
                    </>
                  )}
                </strong>
                <progress
                  aria-label="ストレージ使用量"
                  value={
                    capacity === null ? undefined : usage.used + usage.reserved
                  }
                  max={Math.max(1, capacity ?? 1)}
                />
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
                  <PresetField
                    label="投稿からの保存期間"
                    value={retentionMinutes}
                    onChange={setRetentionMinutes}
                    max={Math.floor(filePolicy.maxRetentionSeconds / 60)}
                  />
                  <span>
                    1分〜
                    {durationLabel(
                      Math.floor(filePolicy.maxRetentionSeconds / 60),
                    )}{" "}
                    · 1ファイル上限 {size(filePolicy.maxFileBytes)}
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
                {uploadable && (
                  <div className="actions">
                    {writable && (
                      <button disabled={busy} onClick={mkdirAction}>
                        ＋ フォルダ
                      </button>
                    )}
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
                  {transferPhase === "paused" ? (
                    <button className="primary" onClick={() => run(() => upload(null, true))}>
                      ▶ 再開
                    </button>
                  ) : transferPhase === "uploading" ? (
                    <button onClick={() => { stop.current = "pause"; activeRequest.current?.abort(); }}>
                      Ⅱ 一時停止
                    </button>
                  ) : <span>転送を終了中…</span>}
                  <button className="danger" disabled={transferPhase === "cancelling"} onClick={cancelTransfer}>
                    キャンセル
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
                          <td data-label="選択">
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
                          <td data-label="名前">
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
                                    {i.downloads != null &&
                                      `${compactCount(i.downloads)} DL`}
                                    {i.expires_at &&
                                      ` · 期限 ${new Date(i.expires_at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}`}
                                  </small>
                                )}
                              </span>
                            </button>
                            {i.uploaded_by && (
                              <a
                                className="uploader-link"
                                href={`/users/${encodeURIComponent(i.uploaded_by)}`}
                              >
                                投稿者のファイルを見る
                              </a>
                            )}
                          </td>
                          <td data-label="サイズ" className="muted">
                            {i.folder ? "—" : size(i.size)}
                          </td>
                          <td data-label="公開範囲">
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
                          <td data-label="更新日" className="muted date">
                            {new Date(i.created).toLocaleDateString("ja-JP")}
                          </td>
                          <td data-label="操作">
                            <div className="row-actions">
                              {!i.folder && (
                                <button
                                  aria-label={i.name + "をダウンロード"}
                                  onClick={() => download(i)}
                                >
                                  ダウンロード
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
        <footer>
          <span>PEXserver FileShare</span>
          <a href="https://pexserver.com">PEXserverについて ↗</a>
          <span>安全につながる、みんなのストレージ。</span>
        </footer>
      </main>
      {task && (
        <FullScreenPage
          onClose={() => {
            if (!busy) setTask(null);
          }}
        >
          <section
            className="screen-content"
            role="region"
            aria-labelledby="task-title"
          >
            <p className="eyebrow">FILE OPERATIONS</p>
            <h2 id="task-title">
              {task === "folder"
                ? "フォルダを作成"
                : task === "trash"
                  ? "ごみ箱へ移動"
                  : "ファイルを完全削除"}
            </h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                performTask();
              }}
            >
              {task === "folder" ? (
                <label>
                  フォルダ名
                  <input
                    required
                    maxLength={240}
                    value={folderName}
                    onChange={(e) => setFolderName(e.target.value)}
                  />
                </label>
              ) : (
                <p>
                  {task === "trash"
                    ? `${selected.length}件をごみ箱へ移動します。管理者はごみ箱から復元できます。`
                    : `${trashSelection.length}件を完全に削除します。この操作は元に戻せません。`}
                </p>
              )}
              <button
                type="submit"
                className={task === "purge" ? "danger full" : "primary full"}
                disabled={busy || (task === "folder" && !folderName.trim())}
              >
                {task === "folder"
                  ? "作成する"
                  : task === "trash"
                    ? "ごみ箱へ移動する"
                    : "完全削除する"}
              </button>
              <button
                type="button"
                className="full"
                disabled={busy}
                onClick={() => setTask(null)}
              >
                キャンセルして戻る
              </button>
            </form>
          </section>
        </FullScreenPage>
      )}
      {keyResult && (
        <FullScreenPage onClose={() => setKeyResult(null)}>
          <section className="screen-content">
            <h2>招待キーを保存してください</h2>
            <p>
              このキーは今回だけ表示します。閲覧を許可する相手にファイルIDと一緒に渡してください。
            </p>
            <label>
              招待キー
              <input
                readOnly
                value={keyResult.key}
                onFocus={(e) => e.target.select()}
              />
            </label>
            <CopyButton text={keyResult.key}>招待キーをコピー</CopyButton>
            <label>
              ファイルID
              <input readOnly value={keyResult.id} />
            </label>
            <CopyButton text={keyResult.id}>ファイルIDをコピー</CopyButton>
            <button onClick={() => setKeyResult(null)}>保存して閉じる</button>
          </section>
        </FullScreenPage>
      )}
      {(passkeyOpen || deviceToken) && (
        <PasskeyPage
          token={deviceToken}
          onClose={() => {
            setPasskeyOpen(false);
            if (deviceToken) {
              setDeviceToken("");
              history.replaceState({}, "", location.pathname + location.search);
            }
          }}
        />
      )}
      {authOpen && (
        <FullScreenPage onClose={() => setAuthOpen(false)}>
          <section
            className="screen-content"
            role="region"
            aria-labelledby="auth-title"
          >
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
                <h3>
                  {staffInvitation?.level === 1 ? "VIP" : "スタッフ"}として参加
                </h3>
                {staffInvitation ? (
                  <p>
                    {staffInvitation.label}
                    への招待です。パスキー登録後、承認済みの
                    {staffInvitation.level === 1
                      ? "VIP（Level 1）"
                      : "スタッフ（Level 3）"}
                    として利用できます。
                  </p>
                ) : (
                  <p role={staffInviteError ? "alert" : "status"}>
                    {staffInviteError || "招待URLを確認しています…"}
                  </p>
                )}
                {staffInvitation && (
                  <>
                    <label>
                      招待されたユーザー名
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
                      パスキーを登録して
                      {staffInvitation.level === 1 ? "VIP" : "スタッフ"}になる
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
                  {autoApprove
                    ? "パスキーを登録して利用を開始"
                    : "パスキーを登録して承認を申請"}
                </button>
              </>
            )}
            {!staffToken && !registration && (
              <p className="muted">
                新規登録には有効なVIP・スタッフ招待URLが必要です。登録済みの方はパスキーでログインできます。
              </p>
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
        </FullScreenPage>
      )}
      {settings && (
        <FullScreenPage variant="modal" onClose={() => setSettings(null)}>
          <section
            className="screen-content"
            role="region"
            aria-labelledby="settings-title"
          >
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
                <div>
                  <PresetField
                    key={settings.id}
                    label="投稿からの保存期間"
                    name="retentionMinutes"
                    keepCurrent
                    max={Math.floor(filePolicy.maxRetentionSeconds / 60)}
                  />
                  <small>
                    {settings.expires_at
                      ? `現在の期限: ${new Date(settings.expires_at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}。`
                      : "現在は期限未設定です。"}
                    期限後は完全削除します。期限は投稿時刻から計算します。
                  </small>
                </div>
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
            <CopyButton text={location.origin + "/?item=" + settings.id}>
              共有リンクをコピー
            </CopyButton>
          </section>
        </FullScreenPage>
      )}
      {preview && (
        <FullScreenPage
          onClose={() => {
            setPreview(null);
            setPreviewUrl("");
          }}
        >
          <section
            className="screen-content preview-page"
            role="region"
            aria-labelledby="preview-title"
          >
            <h2 id="preview-title">{preview.name}</h2>
            <PreviewContent item={preview} source={previewUrl} />
            <button className="primary" onClick={() => download(preview)}>
              ダウンロード · {size(preview.size)}
            </button>
          </section>
        </FullScreenPage>
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
      <td data-label="ユーザー">{u.name}</td>
      <td data-label="登録IP" className="mono">
        {u.ip}
      </td>
      <td data-label="権限">
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
      <td data-label="容量 (GB)">
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
      <td data-label="承認">
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
      <td data-label="操作">
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
