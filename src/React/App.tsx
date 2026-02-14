import React, { useState, useEffect, useCallback, useRef } from "react";
import { CURRENT_FILESHARE_VERSION } from "../version";

// -- Types
import type { FileEntry, DiskInfo } from "./types";

// -- Helpers
import {
  formatSize, formatDate, getFileIconClass, getFileIconColor,
  fileUrl, isPreviewable, isMarkdown,
} from "./helpers/fileHelpers";
import { getToken, clearToken, authHeaders } from "./helpers/auth";

// -- Components
import { Icon } from "./components/Icon";
import { AuthPanel } from "./components/AuthPanel";
import { DiskQuotaBar } from "./components/DiskQuotaBar";
import { UploadPanel } from "./components/UploadPanel";
import { PreviewModal } from "./components/PreviewModal";
import { MarkdownPreviewModal } from "./components/MarkdownPreviewModal";
import { StatusModal } from "./components/StatusModal";
import { ContextMenu } from "./components/ContextMenu";
import { modalStyles } from "./components/modalStyles";

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function App() {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [currentPath, setCurrentPath] = useState("");
  const [pathHistory, setPathHistory] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [previewEntry, setPreviewEntry] = useState<FileEntry | null>(null);

  // Auth state
  const [authChecked, setAuthChecked] = useState(false);
  const [loggedInUser, setLoggedInUser] = useState<string | null>(null);
  const [showAuthPanel, setShowAuthPanel] = useState(false);

  // Status modal
  const [showStatusModal, setShowStatusModal] = useState(false);

  // Context menu
  const [contextMenu, setContextMenu] = useState<{ entry: FileEntry; x: number; y: number } | null>(null);

  // Drag & move (oplevel 2)
  const [draggedEntry, setDraggedEntry] = useState<FileEntry | null>(null);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const [touchDragPoint, setTouchDragPoint] = useState<{ x: number; y: number } | null>(null);
  const [isTouchDragging, setIsTouchDragging] = useState(false);
  const [isTouchDevice, setIsTouchDevice] = useState(false);
  const [moveModalSource, setMoveModalSource] = useState<FileEntry | null>(null);
  const [moveModalPath, setMoveModalPath] = useState("");
  const [moveModalEntries, setMoveModalEntries] = useState<FileEntry[]>([]);
  const [moveModalLoading, setMoveModalLoading] = useState(false);
  const [moveModalError, setMoveModalError] = useState<string | null>(null);
  const [moveBusy, setMoveBusy] = useState(false);
  const [moveMsg, setMoveMsg] = useState<{ text: string; ok: boolean } | null>(null);

  // Long-press refs
  const longPressTimer = useRef<NodeJS.Timeout | null>(null);
  const touchStartPos = useRef<{ x: number; y: number } | null>(null);
  const touchStartAt = useRef(0);

  // User op level
  const [oplevel, setOplevel] = useState(0);

  // Disk info
  const [disk, setDisk] = useState<DiskInfo | null>(null);

  // Check auth status on mount
  useEffect(() => {
    (async () => {
      const t = getToken();
      if (t) {
        try {
          const res = await fetch("/api/auth/status", { headers: { Authorization: `Bearer ${t}` } });
          const data = await res.json();
          if (data.authenticated) {
            setLoggedInUser(data.username);
            setOplevel(data.oplevel ?? 1);
          }
          else clearToken();
        } catch { clearToken(); }
      }
      setAuthChecked(true);
    })();
  }, []);

  // Fetch disk info periodically
  const fetchDisk = useCallback(async () => {
    try {
      const res = await fetch("/api/disk");
      if (res.ok) setDisk(await res.json());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchDisk();
    const iv = setInterval(fetchDisk, 30000);
    return () => clearInterval(iv);
  }, [fetchDisk]);

  useEffect(() => {
    if (loggedInUser) fetchDisk();
  }, [loggedInUser, fetchDisk]);

  useEffect(() => {
    const query = "(pointer: coarse)";
    const media = window.matchMedia(query);
    const update = () => {
      setIsTouchDevice(("ontouchstart" in window) || navigator.maxTouchPoints > 0 || media.matches);
    };
    update();
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", update);
      return () => media.removeEventListener("change", update);
    }
    media.addListener(update);
    return () => media.removeListener(update);
  }, []);

  const updateUrlPath = (path: string) => {
    try {
      const url = new URL(window.location.href);
      if (path) url.searchParams.set("path", path);
      else url.searchParams.delete("path");
      window.history.replaceState({}, "", url.toString());
    } catch {
      // ignore (e.g. non-browser env)
    }
  };

  const fetchEntries = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/list?path=${encodeURIComponent(path)}`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to fetch");
      }
      const data: FileEntry[] = await res.json();
      setEntries(data);
      setCurrentPath(path);
      updateUrlPath(path);
    } catch (e: unknown) {
      setError(getErrorMessage(e));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // On mount: respect ?path=... URL so shared folder links open correctly
  useEffect(() => {
    const params = new URL(window.location.href).searchParams;
    const startPath = params.get("path") ?? "";
    fetchEntries(startPath);
    // keep auth check independent
  }, [fetchEntries]);

  const navigateTo = (entry: FileEntry) => {
    if (entry.isDir) {
      setPathHistory((prev) => [...prev, currentPath]);
      fetchEntries(entry.path);
    }
  };

  const goBack = () => {
    const prev = pathHistory[pathHistory.length - 1] ?? "";
    setPathHistory((h) => h.slice(0, -1));
    fetchEntries(prev);
  };

  const goHome = () => {
    setPathHistory([]);
    fetchEntries("");
  };

  const downloadFile = (entry: FileEntry) => {
    const a = document.createElement("a");
    a.href = fileUrl(entry);
    a.download = entry.name;
    a.click();
  };

  const handleLogout = async () => {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        headers: authHeaders(),
      });
    } catch { /* ignore */ }
    clearToken();
    setLoggedInUser(null);
    setOplevel(0);
  };

  const handleContextMenu = (e: React.MouseEvent, entry: FileEntry) => {
    if (!loggedInUser) return; // Only for logged-in users
    e.preventDefault();
    setContextMenu({ entry, x: e.clientX, y: e.clientY });
  };

  const handleLongPress = (entry: FileEntry, x: number, y: number) => {
    if (!loggedInUser) return; // Only for logged-in users
    setContextMenu({ entry, x, y });
  };

  const canDragMove = Boolean(loggedInUser) && oplevel >= 2;
  const canDesktopDragMove = canDragMove && !isTouchDevice;
  const canMoveModal = canDragMove;

  const getParentPath = (path: string): string => {
    const idx = path.lastIndexOf("/");
    return idx >= 0 ? path.slice(0, idx) : "";
  };

  const canDropToFolder = (source: FileEntry | null, target: FileEntry): boolean => {
    if (!source || !target.isDir) return false;
    if (source.path === target.path) return false;
    if (getParentPath(source.path) === target.path) return false;
    if (source.isDir && (target.path === source.path || target.path.startsWith(`${source.path}/`))) {
      return false;
    }
    return true;
  };

  const canMoveToPath = (source: FileEntry | null, targetPath: string): boolean => {
    if (!source) return false;
    if (source.path === targetPath) return false;
    if (getParentPath(source.path) === targetPath) return false;
    if (source.isDir && (targetPath === source.path || targetPath.startsWith(`${source.path}/`))) {
      return false;
    }
    return true;
  };

  const moveEntryToFolder = useCallback(async (source: FileEntry, targetDirPath: string) => {
    if (!canDragMove || moveBusy) return;
    setMoveBusy(true);
    setMoveMsg(null);
    try {
      const res = await fetch("/api/move", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ sourcePath: source.path, targetDirPath }),
      });
      const data = await res.json();
      if (data.ok) {
        setMoveMsg({ text: data.message || `「${source.name}」を移動しました`, ok: true });
        await fetchEntries(currentPath);
      } else {
        setMoveMsg({ text: data.error || data.message || "移動に失敗しました", ok: false });
      }
    } catch {
      setMoveMsg({ text: "通信エラーで移動できませんでした", ok: false });
    } finally {
      setMoveBusy(false);
    }
  }, [canDragMove, moveBusy, fetchEntries, currentPath]);

  const detectTouchDropFolder = useCallback((x: number, y: number, source: FileEntry | null): string | null => {
    const hit = document.elementFromPoint(x, y) as HTMLElement | null;
    const row = hit?.closest("tr[data-entry-path]") as HTMLElement | null;
    if (!row) return null;
    const path = row.dataset.entryPath ?? "";
    const isDir = row.dataset.isDir === "true";
    if (!path || !isDir || !source) return null;
    const target = entries.find((e) => e.path === path);
    if (!target || !canDropToFolder(source, target)) return null;
    return path;
  }, [entries]);

  const loadMoveModalEntries = useCallback(async (path: string) => {
    setMoveModalLoading(true);
    setMoveModalError(null);
    try {
      const res = await fetch(`/api/list?path=${encodeURIComponent(path)}`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "移動先フォルダの取得に失敗しました");
      }
      const data: FileEntry[] = await res.json();
      setMoveModalEntries(data.filter((e) => e.isDir));
      setMoveModalPath(path);
    } catch (err: unknown) {
      setMoveModalEntries([]);
      setMoveModalError(getErrorMessage(err));
    } finally {
      setMoveModalLoading(false);
    }
  }, []);

  const openMoveModal = useCallback((entry: FileEntry) => {
    setContextMenu(null);
    setMoveModalSource(entry);
    void loadMoveModalEntries(currentPath);
  }, [currentPath, loadMoveModalEntries]);

  const closeMoveModal = () => {
    setMoveModalSource(null);
    setMoveModalPath("");
    setMoveModalEntries([]);
    setMoveModalError(null);
    setMoveModalLoading(false);
  };

  useEffect(() => {
    const lock = canDesktopDragMove && isTouchDragging;
    if (!lock) return;

    const prevOverflow = document.body.style.overflow;
    const prevTouchAction = document.body.style.touchAction;
    const prevOverscroll = document.body.style.overscrollBehavior;

    document.body.style.overflow = "hidden";
    document.body.style.touchAction = "none";
    document.body.style.overscrollBehavior = "none";

    return () => {
      document.body.style.overflow = prevOverflow;
      document.body.style.touchAction = prevTouchAction;
      document.body.style.overscrollBehavior = prevOverscroll;
    };
  }, [canDesktopDragMove, isTouchDragging]);

  const breadcrumbs = currentPath ? currentPath.split("/") : [];
  const moveModalOverlayStyle: React.CSSProperties = isTouchDevice
    ? styles.moveModalOverlay
    : {
      ...styles.moveModalOverlay,
      alignItems: "center",
      justifyContent: "center",
      padding: 20,
    };
  const moveModalPanelStyle: React.CSSProperties = isTouchDevice
    ? styles.moveModalPanel
    : {
      ...styles.moveModalPanel,
      width: "min(860px, 94vw)",
      height: "min(82vh, 760px)",
      borderRadius: 14,
      boxShadow: "0 18px 48px rgba(0,0,0,0.28)",
      padding: "14px 14px 16px",
    };

  return (
    <div style={{ ...styles.container, touchAction: canDesktopDragMove && isTouchDragging ? "none" : "auto" }}>
      {/* Header */}
      <header style={styles.header}>
        <div className="fs-header-inner" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h1 className="fs-title" style={styles.title}>
              <Icon name="fa-solid fa-folder-open" style={{ marginRight: 10, color: "#3366cc" }} />
              FileShare
            </h1>
            <p style={styles.subtitle}>ファイル共有サービス</p>
          </div>
          <div className="fs-header-right" style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
            {/* Status button */}
            <button style={styles.navBtn} onClick={() => setShowStatusModal(true)} title="サーバーステータス">
              <Icon name="fa-solid fa-chart-line" style={{ marginRight: 6 }} />
              Status
            </button>
            {authChecked && loggedInUser ? (
              <>
                <span style={{ fontSize: 14, color: "#333", display: "inline-flex", alignItems: "center" }}>
                  <Icon name="fa-solid fa-user" style={{ marginRight: 6, color: "#3366cc" }} />
                  {loggedInUser}
                </span>
                <button style={styles.navBtn} onClick={handleLogout}>
                  <Icon name="fa-solid fa-right-from-bracket" style={{ marginRight: 6 }} />
                  ログアウト
                </button>
              </>
            ) : authChecked ? (
              <button style={styles.navBtn} onClick={() => setShowAuthPanel(true)}>
                <Icon name="fa-solid fa-key" style={{ marginRight: 6 }} />
                ログイン
              </button>
            ) : null}
          </div>
        </div>
      </header>

      {/* Disk quota */}
      <DiskQuotaBar disk={disk} onRetry={fetchDisk} />

      {/* Auth modal */}
      {showAuthPanel && !loggedInUser && (
        <div style={modalStyles.overlay} onClick={() => setShowAuthPanel(false)}>
          <div onClick={(e) => e.stopPropagation()}>
            <AuthPanel onLogin={(u) => {
              setLoggedInUser(u);
              setShowAuthPanel(false);
              // Fetch oplevel after login
              const t = getToken();
              if (t) {
                fetch("/api/auth/status", { headers: { Authorization: `Bearer ${t}` } })
                  .then(r => r.json())
                  .then(d => { if (d.oplevel) setOplevel(d.oplevel); })
                  .catch(() => {});
              }
            }} />
          </div>
        </div>
      )}

      {/* Status modal */}
      {showStatusModal && (
        <StatusModal onClose={() => setShowStatusModal(false)} />
      )}

      {/* Breadcrumb / Navigation */}
      <nav className="fs-nav" style={styles.nav}>
        <button onClick={goHome} style={styles.navBtn} title="ルートへ">
          <Icon name="fa-solid fa-house" style={{ marginRight: 6 }} />
          ルート
        </button>
        {currentPath && (
          <button onClick={goBack} style={styles.navBtn} title="戻る">
            <Icon name="fa-solid fa-arrow-left" style={{ marginRight: 6 }} />
            戻る
          </button>
        )}
        <span className="fs-breadcrumb" style={styles.breadcrumb}>
          <span style={styles.breadcrumbItem} onClick={goHome}>/</span>
          {breadcrumbs.map((segment, i) => {
            const path = breadcrumbs.slice(0, i + 1).join("/");
            return (
              <span key={path}>
                <span
                  style={styles.breadcrumbItem}
                  onClick={() => { setPathHistory((prev) => [...prev, currentPath]); fetchEntries(path); }}
                >
                  {segment}
                </span>
                {i < breadcrumbs.length - 1 && " / "}
              </span>
            );
          })}
        </span>
      </nav>

      {/* Upload area (logged-in only) */}
      {loggedInUser && (
        <UploadPanel
          currentPath={currentPath}
          disk={disk}
          onUploaded={() => { fetchEntries(currentPath); fetchDisk(); }}
        />
      )}

      {/* Content */}
      <main style={styles.main}>
        {moveMsg && (
          <div style={moveMsg.ok ? styles.moveMsgOk : styles.moveMsgErr}>
            <Icon name={moveMsg.ok ? "fa-solid fa-circle-check" : "fa-solid fa-triangle-exclamation"} style={{ marginRight: 8 }} />
            {moveMsg.text}
          </div>
        )}
        {loading && (
          <div style={styles.loading}>
            <Icon name="fa-solid fa-spinner fa-spin" style={{ marginRight: 8 }} />
            読み込み中...
          </div>
        )}
        {error && (
          <div style={styles.error}>
            <Icon name="fa-solid fa-circle-exclamation" style={{ marginRight: 8 }} />
            {error}
          </div>
        )}
        {!loading && !error && entries.length === 0 && (
          <div style={styles.empty}>
            <Icon name="fa-regular fa-folder-open" style={{ marginRight: 8, fontSize: 20 }} />
            このフォルダは空です
          </div>
        )}
        {!loading && !error && entries.length > 0 && (
          <table className="fs-file-table" style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}></th>
                <th style={{ ...styles.th, textAlign: "left" as const }}>名前</th>
                <th style={styles.th}>サイズ</th>
                <th style={styles.th}>更新日時</th>
                <th style={styles.th}></th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr
                  key={entry.path || entry.name}
                  data-entry-path={entry.path}
                  data-is-dir={entry.isDir ? "true" : "false"}
                  style={{ ...styles.row, ...(dropTargetPath === entry.path ? styles.dropTargetRow : {}) }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = "#f0f4ff"; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = ""; }}
                  draggable={canDesktopDragMove}
                  onDragStart={(e) => {
                    if (!canDesktopDragMove) {
                      e.preventDefault();
                      return;
                    }
                    setContextMenu(null);
                    setDraggedEntry(entry);
                    setDropTargetPath(null);
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", entry.path);
                  }}
                  onDragOver={(e) => {
                    if (!canDropToFolder(draggedEntry, entry)) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    setDropTargetPath(entry.path);
                  }}
                  onDragLeave={() => {
                    if (dropTargetPath === entry.path) {
                      setDropTargetPath(null);
                    }
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (!draggedEntry || !canDropToFolder(draggedEntry, entry)) return;
                    void moveEntryToFolder(draggedEntry, entry.path);
                    setDraggedEntry(null);
                    setDropTargetPath(null);
                  }}
                  onDragEnd={() => {
                    setDraggedEntry(null);
                    setDropTargetPath(null);
                  }}
                  onContextMenu={(e) => handleContextMenu(e, entry)}
                  onTouchStart={(e) => {
                    if (!loggedInUser) return;
                    const touch = e.touches[0];
                    touchStartPos.current = { x: touch.clientX, y: touch.clientY };
                    touchStartAt.current = Date.now();
                    if (canDesktopDragMove) {
                      setTouchDragPoint(null);
                      setIsTouchDragging(false);
                      setDropTargetPath(null);
                      setDraggedEntry(null);
                    }
                    longPressTimer.current = setTimeout(() => {
                      handleLongPress(entry, touch.clientX, touch.clientY);
                    }, 420);
                  }}
                  onTouchEnd={() => {
                    if (longPressTimer.current) {
                      clearTimeout(longPressTimer.current);
                      longPressTimer.current = null;
                    }

                    if (canDesktopDragMove && draggedEntry && isTouchDragging && dropTargetPath) {
                      void moveEntryToFolder(draggedEntry, dropTargetPath);
                    }

                    if (canDesktopDragMove) {
                      setDraggedEntry(null);
                      setDropTargetPath(null);
                      setTouchDragPoint(null);
                      setIsTouchDragging(false);
                    }
                    touchStartPos.current = null;
                    touchStartAt.current = 0;
                  }}
                  onTouchMove={(e) => {
                    if (!canDesktopDragMove) return;
                    const touch = e.touches[0];
                    let movedEnough = false;
                    if (touchStartPos.current) {
                      const dx = touch.clientX - touchStartPos.current.x;
                      const dy = touch.clientY - touchStartPos.current.y;
                      movedEnough = Math.hypot(dx, dy) > 12;
                      if (movedEnough && longPressTimer.current) {
                        clearTimeout(longPressTimer.current);
                        longPressTimer.current = null;
                      }
                    }

                    if (!isTouchDragging && movedEnough) {
                      const heldMs = Date.now() - touchStartAt.current;
                      if (heldMs >= 140) {
                        setDraggedEntry(entry);
                        setIsTouchDragging(true);
                      }
                    }

                    if (draggedEntry && isTouchDragging) {
                      setTouchDragPoint({ x: touch.clientX, y: touch.clientY });
                      setDropTargetPath(detectTouchDropFolder(touch.clientX, touch.clientY, draggedEntry));
                    }

                    if (longPressTimer.current) {
                      clearTimeout(longPressTimer.current);
                      longPressTimer.current = null;
                    }
                  }}
                  onTouchCancel={() => {
                    if (longPressTimer.current) {
                      clearTimeout(longPressTimer.current);
                      longPressTimer.current = null;
                    }
                    if (canDesktopDragMove) {
                      setDraggedEntry(null);
                      setDropTargetPath(null);
                      setTouchDragPoint(null);
                      setIsTouchDragging(false);
                    }
                    touchStartPos.current = null;
                    touchStartAt.current = 0;
                  }}
                >
                  <td className="fs-icon-cell" style={styles.iconCell}>
                    <Icon name={getFileIconClass(entry)} style={{ color: getFileIconColor(entry), fontSize: 18 }} />
                  </td>
                  <td className="fs-name-cell" style={styles.nameCell}>
                    {entry.isDir ? (
                      <span style={styles.dirLink} onClick={() => navigateTo(entry)}>{entry.name}</span>
                    ) : isMarkdown(entry) ? (
                      <span style={styles.previewLink} onClick={() => setPreviewEntry(entry)} title="クリックでプレビュー">
                        <Icon name="fa-brands fa-markdown" style={{ marginRight: 6, fontSize: 12, color: "#6cb4ee" }} />
                        {entry.name}
                      </span>
                    ) : isPreviewable(entry) ? (
                      <span style={styles.previewLink} onClick={() => setPreviewEntry(entry)} title="クリックでプレビュー">
                        <Icon name="fa-solid fa-play" style={{ marginRight: 6, fontSize: 10 }} />
                        {entry.name}
                      </span>
                    ) : (
                      <span style={styles.fileName}>{entry.name}</span>
                    )}
                  </td>
                  <td className="fs-size-cell" style={styles.sizeCell}>{formatSize(entry.size)}</td>
                  <td className="fs-date-cell" style={styles.dateCell}>{formatDate(entry.mtime)}</td>
                  <td className="fs-action-cell" style={styles.actionCell}>
                    <div className="fs-action-buttons" style={styles.actionButtons}>
                      {canMoveModal && (
                        <button style={styles.moveBtn} onClick={() => openMoveModal(entry)} title="移動先を選択">
                          <Icon name="fa-solid fa-right-left" />
                        </button>
                      )}
                      {!entry.isDir && (
                        <button style={styles.downloadBtn} onClick={() => downloadFile(entry)} title="ダウンロード">
                          <Icon name="fa-solid fa-download" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>

      {canDesktopDragMove && draggedEntry && isTouchDragging && touchDragPoint && (
        <div
          style={{
            ...styles.touchDragBadge,
            left: touchDragPoint.x + 10,
            top: touchDragPoint.y + 10,
          }}
        >
          <Icon name={draggedEntry.isDir ? "fa-solid fa-folder" : "fa-solid fa-file"} style={{ marginRight: 6 }} />
          {draggedEntry.name}
        </div>
      )}

      {/* Move modal */}
      {canMoveModal && moveModalSource && (
        <div style={moveModalOverlayStyle} onClick={closeMoveModal}>
          <div style={moveModalPanelStyle} onClick={(e) => e.stopPropagation()}>
            <div style={styles.moveModalHeader}>
              <div style={styles.moveModalTitleWrap}>
                <div style={styles.moveModalTitle}>移動先フォルダを選択</div>
                <div style={styles.moveModalSub}>対象: {moveModalSource.name}</div>
              </div>
              <button style={styles.moveModalClose} onClick={closeMoveModal}>
                <Icon name="fa-solid fa-xmark" />
              </button>
            </div>

            <div style={styles.moveModalPath}>/{moveModalPath || ""}</div>

            <button
              style={{ ...styles.moveModalSubmit, ...(canMoveToPath(moveModalSource, moveModalPath) ? {} : styles.moveModalSubmitDisabled) }}
              disabled={moveBusy || !canMoveToPath(moveModalSource, moveModalPath)}
              onClick={async () => {
                if (!moveModalSource) return;
                await moveEntryToFolder(moveModalSource, moveModalPath);
                closeMoveModal();
              }}
            >
              {moveBusy ? "移動中..." : "このフォルダへ移動"}
            </button>

            {moveModalPath && (
              <button style={styles.moveModalNavBtn} onClick={() => void loadMoveModalEntries(getParentPath(moveModalPath))}>
                <Icon name="fa-solid fa-arrow-up" style={{ marginRight: 8 }} />
                1つ上へ
              </button>
            )}

            <div style={styles.moveModalList}>
              {moveModalLoading && <div style={styles.moveModalInfo}>読み込み中...</div>}
              {!moveModalLoading && moveModalError && <div style={styles.moveModalErr}>{moveModalError}</div>}
              {!moveModalLoading && !moveModalError && moveModalEntries.length === 0 && (
                <div style={styles.moveModalInfo}>サブフォルダがありません</div>
              )}
              {!moveModalLoading && !moveModalError && moveModalEntries.map((folder) => {
                const disabled = moveModalSource.isDir && (folder.path === moveModalSource.path || folder.path.startsWith(`${moveModalSource.path}/`));
                return (
                  <button
                    key={folder.path}
                    style={{ ...styles.moveModalFolderBtn, ...(disabled ? styles.moveModalFolderBtnDisabled : {}) }}
                    disabled={disabled}
                    onClick={() => void loadMoveModalEntries(folder.path)}
                    title={disabled ? "このフォルダには移動できません" : folder.name}
                  >
                    <Icon name="fa-solid fa-folder" style={{ marginRight: 8, color: disabled ? "#999" : "#f0b429" }} />
                    {folder.name}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu
          entry={contextMenu.entry}
          x={contextMenu.x}
          y={contextMenu.y}
          oplevel={oplevel}
          onClose={() => setContextMenu(null)}
          onRefresh={() => fetchEntries(currentPath)}
        />
      )}

      {/* Preview Modal */}
      {previewEntry && !isMarkdown(previewEntry) && (
        <PreviewModal
          entry={previewEntry}
          entries={entries}
          onClose={() => setPreviewEntry(null)}
          onNavigate={(e) => setPreviewEntry(e)}
        />
      )}

      {/* Markdown Preview Modal */}
      {previewEntry && isMarkdown(previewEntry) && (
        <MarkdownPreviewModal
          entry={previewEntry}
          onClose={() => setPreviewEntry(null)}
        />
      )}

      {/* Footer */}
      <footer style={styles.footer}>
        <span>
          <Icon name="fa-solid fa-server" style={{ marginRight: 6 }} />
          FileShare v{CURRENT_FILESHARE_VERSION} — {entries.length} 項目
        </span>
      </footer>
    </div>
  );
}

// -- Inline Styles
const styles: Record<string, React.CSSProperties> = {
  container: {
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif",
    maxWidth: 960,
    margin: "0 auto",
    padding: "0 16px",
    color: "#1a1a2e",
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column",
  },
  header: {
    padding: "24px 0 8px",
    borderBottom: "2px solid #e0e0e0",
  },
  title: { margin: 0, fontSize: 28, fontWeight: 700, display: "flex", alignItems: "center" },
  subtitle: { margin: "4px 0 0", fontSize: 14, color: "#666" },
  nav: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "12px 0",
    flexWrap: "wrap",
  },
  navBtn: {
    padding: "6px 14px",
    border: "1px solid #ccc",
    borderRadius: 6,
    background: "#fff",
    cursor: "pointer",
    fontSize: 14,
    transition: "background 150ms",
    display: "inline-flex",
    alignItems: "center",
    fontFamily: "inherit",
  },
  breadcrumb: { fontSize: 14, color: "#555", marginLeft: 8 },
  breadcrumbItem: { cursor: "pointer", color: "#3366cc", textDecoration: "underline" },
  main: { flex: 1 },
  loading: { textAlign: "center", padding: 48, fontSize: 18, color: "#888", display: "flex", alignItems: "center", justifyContent: "center" },
  error: { textAlign: "center", padding: 48, fontSize: 16, color: "#c00", display: "flex", alignItems: "center", justifyContent: "center" },
  empty: { textAlign: "center", padding: 48, fontSize: 16, color: "#888", display: "flex", alignItems: "center", justifyContent: "center" },
  moveMsgOk: {
    marginBottom: 10,
    padding: "8px 10px",
    border: "1px solid #d2f2df",
    borderRadius: 8,
    background: "#f3fcf7",
    color: "#1f7a45",
    fontSize: 13,
    display: "flex",
    alignItems: "center",
  },
  moveMsgErr: {
    marginBottom: 10,
    padding: "8px 10px",
    border: "1px solid #f5d5d5",
    borderRadius: 8,
    background: "#fff6f6",
    color: "#b53a3a",
    fontSize: 13,
    display: "flex",
    alignItems: "center",
  },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 14 },
  th: {
    padding: "10px 8px",
    borderBottom: "2px solid #ddd",
    textAlign: "center",
    fontWeight: 600,
    color: "#555",
    whiteSpace: "nowrap",
  },
  row: { borderBottom: "1px solid #eee", transition: "background 100ms" },
  dropTargetRow: { backgroundColor: "#e8f2ff" },
  iconCell: { padding: "10px 8px", textAlign: "center", width: 40, fontSize: 18 },
  nameCell: { padding: "10px 8px", wordBreak: "break-all" },
  dirLink: { cursor: "pointer", color: "#3366cc", fontWeight: 500, textDecoration: "none" },
  previewLink: { cursor: "pointer", color: "#2255aa", fontWeight: 500, textDecoration: "none", display: "inline-flex", alignItems: "center" },
  fileName: { color: "#1a1a2e" },
  sizeCell: { padding: "10px 8px", textAlign: "right", whiteSpace: "nowrap", color: "#666", width: 100 },
  dateCell: { padding: "10px 8px", textAlign: "center", whiteSpace: "nowrap", color: "#666", width: 160 },
  actionCell: { padding: "10px 8px", textAlign: "center", width: 108, whiteSpace: "nowrap" },
  actionButtons: {
    display: "inline-flex",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexWrap: "nowrap",
    whiteSpace: "nowrap",
  },
  moveBtn: {
    padding: "4px 10px",
    border: "1px solid #ccc",
    borderRadius: 6,
    background: "#fff",
    cursor: "pointer",
    fontSize: 14,
    transition: "background 150ms",
    color: "#5a67d8",
  },
  downloadBtn: {
    padding: "4px 10px",
    border: "1px solid #ccc",
    borderRadius: 6,
    background: "#fff",
    cursor: "pointer",
    fontSize: 16,
    transition: "background 150ms",
    color: "#3366cc",
  },
  touchDragBadge: {
    position: "fixed",
    zIndex: 12000,
    pointerEvents: "none",
    background: "rgba(51, 102, 204, 0.92)",
    color: "#fff",
    borderRadius: 8,
    padding: "6px 10px",
    fontSize: 12,
    maxWidth: 220,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    boxShadow: "0 6px 20px rgba(0,0,0,0.25)",
  },
  moveModalOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.55)",
    zIndex: 12000,
    display: "flex",
    alignItems: "stretch",
    justifyContent: "stretch",
  },
  moveModalPanel: {
    background: "#fff",
    width: "100%",
    height: "100%",
    display: "flex",
    flexDirection: "column",
    padding: "12px 12px 16px",
    boxSizing: "border-box",
  },
  moveModalHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  moveModalTitleWrap: {
    minWidth: 0,
  },
  moveModalTitle: {
    fontSize: 16,
    fontWeight: 700,
    color: "#1a1a2e",
  },
  moveModalSub: {
    marginTop: 2,
    fontSize: 12,
    color: "#666",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: "80vw",
  },
  moveModalClose: {
    border: "1px solid #ddd",
    background: "#fff",
    borderRadius: 8,
    padding: "8px 10px",
    fontSize: 16,
    color: "#666",
    cursor: "pointer",
  },
  moveModalPath: {
    fontSize: 12,
    color: "#334",
    background: "#f4f6fb",
    border: "1px solid #e0e5f0",
    borderRadius: 8,
    padding: "8px 10px",
    marginBottom: 10,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  moveModalSubmit: {
    border: "none",
    background: "#3366cc",
    color: "#fff",
    borderRadius: 8,
    padding: "10px 12px",
    fontSize: 14,
    cursor: "pointer",
    marginBottom: 8,
  },
  moveModalSubmitDisabled: {
    background: "#9aa9d1",
    cursor: "not-allowed",
  },
  moveModalNavBtn: {
    border: "1px solid #ddd",
    background: "#fff",
    color: "#334",
    borderRadius: 8,
    padding: "10px 12px",
    fontSize: 14,
    cursor: "pointer",
    textAlign: "left",
    marginBottom: 8,
  },
  moveModalList: {
    flex: 1,
    overflowY: "auto",
    border: "1px solid #e5e7ef",
    borderRadius: 10,
    background: "#fafbff",
    padding: 8,
  },
  moveModalInfo: {
    color: "#667",
    fontSize: 13,
    textAlign: "center",
    padding: "16px 8px",
  },
  moveModalErr: {
    color: "#b53a3a",
    fontSize: 13,
    textAlign: "center",
    padding: "16px 8px",
  },
  moveModalFolderBtn: {
    width: "100%",
    border: "1px solid #dde3f2",
    background: "#fff",
    color: "#1a1a2e",
    borderRadius: 8,
    padding: "10px 12px",
    fontSize: 14,
    cursor: "pointer",
    textAlign: "left",
    display: "flex",
    alignItems: "center",
    marginBottom: 8,
  },
  moveModalFolderBtnDisabled: {
    color: "#999",
    background: "#f4f4f4",
    cursor: "not-allowed",
  },
  footer: {
    textAlign: "center",
    padding: "16px 0",
    borderTop: "1px solid #e0e0e0",
    fontSize: 12,
    color: "#999",
  },
};
