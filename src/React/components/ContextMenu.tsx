import React, { useState, useRef, useEffect } from "react";
import { Icon } from "./Icon";
import { authHeaders } from "../helpers/auth";
import type { FileEntry } from "../types";

interface ContextMenuProps {
  entry: FileEntry;
  x: number;
  y: number;
  oplevel: number;
  onClose: () => void;
  onRefresh: () => void;
}

async function copyTextWithFallback(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fallback below
  }

  try {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.setAttribute("readonly", "");
    textArea.style.position = "fixed";
    textArea.style.top = "-9999px";
    textArea.style.left = "-9999px";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    const copied = document.execCommand("copy");
    document.body.removeChild(textArea);
    return copied;
  } catch {
    return false;
  }
}

export function ContextMenu({ entry, x, y, oplevel, onClose, onRefresh }: ContextMenuProps) {
  const [mode, setMode] = useState<"menu" | "rename">("menu");
  const [newName, setNewName] = useState(entry.name);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  // Focus input when entering rename mode
  useEffect(() => {
    if (mode === "rename" && inputRef.current) {
      inputRef.current.focus();
      // Select file name without extension
      const dotIdx = newName.lastIndexOf(".");
      if (dotIdx > 0 && !entry.isDir) {
        inputRef.current.setSelectionRange(0, dotIdx);
      } else {
        inputRef.current.select();
      }
    }
  }, [mode]);

  // Adjust menu position to stay within viewport
  const adjustedStyle: React.CSSProperties = {
    position: "fixed",
    left: Math.min(x, window.innerWidth - 220),
    top: Math.min(y, window.innerHeight - 200),
    zIndex: 10000,
  };

  const handleRename = async () => {
    if (!newName.trim() || newName.trim() === entry.name) {
      onClose();
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ path: entry.path, newName: newName.trim() }),
      });
      const data = await res.json();
      if (data.ok) {
        onRefresh();
        onClose();
      } else {
        setMsg({ text: data.error || data.message, ok: false });
      }
    } catch {
      setMsg({ text: "通信エラー", ok: false });
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    const type = entry.isDir ? "フォルダ" : "ファイル";
    if (!confirm(`${type}「${entry.name}」を削除しますか？\nこの操作は元に戻せません。`)) {
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ path: entry.path }),
      });
      const data = await res.json();
      if (data.ok) {
        onRefresh();
        onClose();
      } else {
        setMsg({ text: data.error || data.message, ok: false });
      }
    } catch {
      setMsg({ text: "通信エラー", ok: false });
    } finally {
      setBusy(false);
    }
  };

  if (mode === "rename") {
    return (
      <div ref={menuRef} style={{ ...adjustedStyle, ...menuStyles.panel }}>
        <div style={menuStyles.renameHeader}>
          <Icon name="fa-solid fa-pencil" style={{ marginRight: 6, color: "#e67e22" }} />
          名前変更
        </div>
        <input
          ref={inputRef}
          style={menuStyles.renameInput}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleRename();
            if (e.key === "Escape") onClose();
          }}
          disabled={busy}
        />
        <div style={menuStyles.renameActions}>
          <button style={menuStyles.renameCancel} onClick={onClose} disabled={busy}>
            キャンセル
          </button>
          <button style={menuStyles.renameSubmit} onClick={handleRename} disabled={busy}>
            {busy ? "処理中..." : "変更"}
          </button>
        </div>
        {msg && (
          <div style={{ ...menuStyles.msg, color: msg.ok ? "#27ae60" : "#c0392b" }}>
            {msg.text}
          </div>
        )}
      </div>
    );
  }

  return (
    <div ref={menuRef} style={{ ...adjustedStyle, ...menuStyles.panel }}>
      <div style={menuStyles.header}>
        <Icon
          name={entry.isDir ? "fa-solid fa-folder" : "fa-solid fa-file"}
          style={{ marginRight: 6, color: entry.isDir ? "#f0b429" : "#95a5a6", fontSize: 13 }}
        />
        <span style={menuStyles.entryName}>{entry.name}</span>
      </div>
      <div style={menuStyles.divider} />
      {/* Copy share/download URL */}
      <button
        style={menuStyles.item}
        onClick={async () => {
          const url = entry.isDir
            ? `${location.origin}/?path=${encodeURIComponent(entry.path)}`
            : `${location.origin}/api/file?path=${encodeURIComponent(entry.path)}`;

          const copied = await copyTextWithFallback(url);
          if (copied) {
            setMsg({ text: "URLをコピーしました", ok: true });
            // Automatically close after short delay
            setTimeout(() => onClose(), 900);
          } else {
            setMsg({ text: "自動コピーに失敗しました。URLを手動でコピーしてください", ok: false });
          }
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "#f0f8ff"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
      >
        <Icon name="fa-solid fa-link" style={{ marginRight: 8, color: "#3366cc", width: 16 }} />
        {entry.isDir ? "フォルダURLをコピー" : "ダウンロードURLをコピー"}
      </button>

      {/* Rename */}
      <button
        style={menuStyles.item}
        onClick={() => setMode("rename")}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "#f0f4ff"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
      >
        <Icon name="fa-solid fa-pencil" style={{ marginRight: 8, color: "#e67e22", width: 16 }} />
        名前変更
      </button>
      {/* Delete (oplevel 2 only) */}
      {oplevel >= 2 ? (
        <button
          style={{ ...menuStyles.item, color: "#c0392b" }}
          onClick={handleDelete}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "#fff0f0"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
          disabled={busy}
        >
          <Icon name="fa-solid fa-trash" style={{ marginRight: 8, width: 16 }} />
          {busy ? "削除中..." : "削除"}
        </button>
      ) : (
        <div style={menuStyles.itemDisabled} title="削除には権限レベル2が必要です">
          <Icon name="fa-solid fa-lock" style={{ marginRight: 8, color: "#bbb", width: 16 }} />
          <span>削除 (権限不足)</span>
        </div>
      )}
      {msg && (
        <div style={{ ...menuStyles.msg, color: msg.ok ? "#27ae60" : "#c0392b" }}>
          {msg.text}
        </div>
      )}
    </div>
  );
}

const menuStyles: Record<string, React.CSSProperties> = {
  panel: {
    background: "#fff",
    border: "1px solid #ddd",
    borderRadius: 8,
    boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
    minWidth: 200,
    padding: "4px 0",
    fontFamily: "inherit",
  },
  header: {
    padding: "8px 12px",
    fontSize: 12,
    color: "#888",
    display: "flex",
    alignItems: "center",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  entryName: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    maxWidth: 160,
  },
  divider: {
    height: 1,
    background: "#eee",
    margin: "2px 8px",
  },
  item: {
    display: "flex",
    alignItems: "center",
    width: "100%",
    padding: "8px 12px",
    border: "none",
    background: "transparent",
    cursor: "pointer",
    fontSize: 13,
    color: "#333",
    textAlign: "left",
    fontFamily: "inherit",
    transition: "background 100ms",
  },
  itemDisabled: {
    display: "flex",
    alignItems: "center",
    width: "100%",
    padding: "8px 12px",
    border: "none",
    background: "transparent",
    fontSize: 13,
    color: "#bbb",
    textAlign: "left",
    fontFamily: "inherit",
    cursor: "not-allowed",
  },
  renameHeader: {
    padding: "8px 12px 4px",
    fontSize: 13,
    fontWeight: 600,
    color: "#333",
    display: "flex",
    alignItems: "center",
  },
  renameInput: {
    display: "block",
    width: "calc(100% - 24px)",
    margin: "6px 12px",
    padding: "6px 8px",
    border: "1px solid #ccc",
    borderRadius: 4,
    fontSize: 13,
    fontFamily: "inherit",
    boxSizing: "border-box",
  },
  renameActions: {
    display: "flex",
    gap: 6,
    padding: "4px 12px 8px",
    justifyContent: "flex-end",
  },
  renameCancel: {
    padding: "4px 12px",
    border: "1px solid #ccc",
    borderRadius: 4,
    background: "#fff",
    cursor: "pointer",
    fontSize: 12,
    fontFamily: "inherit",
  },
  renameSubmit: {
    padding: "4px 12px",
    border: "none",
    borderRadius: 4,
    background: "#3366cc",
    color: "#fff",
    cursor: "pointer",
    fontSize: 12,
    fontFamily: "inherit",
  },
  msg: {
    padding: "4px 12px 8px",
    fontSize: 11,
    textAlign: "center",
  },
};
