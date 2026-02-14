import React, { useState, useRef } from "react";
import { Icon } from "./Icon";
import { authHeaders } from "../helpers/auth";
import { formatSize } from "../helpers/fileHelpers";
import type { DiskInfo } from "../types";

// ── Upload Panel Component ─────────────────────────────
export function UploadPanel({
  currentPath,
  disk,
  onUploaded,
}: {
  currentPath: string;
  disk: DiskInfo | null;
  onUploaded: () => void;
}) {
  const UPLOAD_CONCURRENCY = 3;
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // New folder state
  const [showMkdir, setShowMkdir] = useState(false);
  const [folderName, setFolderName] = useState("");

  const uploadFiles = async (files: FileList | File[]) => {
    const fileArray = Array.from(files as ArrayLike<File>).filter((f): f is File => f instanceof File);
    if (fileArray.length === 0) return;

    setUploading(true);
    setMsg(null);
    const total = fileArray.length;
    let successCount = 0;
    let failCount = 0;
    let completed = 0;
    let inFlight = 0;
    let cursor = 0;
    const failedNames: string[] = [];

    const updateProgress = () => {
      setProgress(`アップロード中 ${completed}/${total}（同時 ${inFlight}）`);
    };

    const worker = async () => {
      while (true) {
        const idx = cursor;
        cursor++;
        if (idx >= total) break;

        const file = fileArray[idx];
        inFlight++;
        updateProgress();

        const form = new FormData();
        form.append("file", file);
        if (currentPath) form.append("path", currentPath);

        try {
          const res = await fetch("/api/upload", {
            method: "POST",
            headers: authHeaders(),
            body: form,
          });
          const data = await res.json();
          if (data.ok) {
            successCount++;
          } else {
            failCount++;
            failedNames.push(file.name);
          }
        } catch {
          failCount++;
          failedNames.push(file.name);
        } finally {
          completed++;
          inFlight = Math.max(0, inFlight - 1);
          updateProgress();
        }
      }
    };

    const workers = Array.from({ length: Math.min(UPLOAD_CONCURRENCY, total) }, () => worker());
    await Promise.all(workers);

    setProgress(null);
    setUploading(false);

    if (successCount > 0 && failCount === 0) {
      setMsg({ text: `${successCount} 件アップロード完了`, ok: true });
      onUploaded();
      return;
    }

    if (successCount > 0 && failCount > 0) {
      const preview = failedNames.slice(0, 2).join("、");
      const tail = failedNames.length > 2 ? ` ほか${failedNames.length - 2}件` : "";
      setMsg({
        text: `${successCount} 件成功 / ${failCount} 件失敗${preview ? `（失敗: ${preview}${tail}）` : ""}`,
        ok: false,
      });
      onUploaded();
      return;
    }

    setMsg({ text: "アップロードに失敗しました", ok: false });
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
  };

  const createFolder = async () => {
    if (!folderName.trim()) return;
    try {
      const res = await fetch("/api/mkdir", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ path: currentPath, name: folderName }),
      });
      const data = await res.json();
      setMsg({ text: data.message || data.error, ok: !!data.ok });
      if (data.ok) {
        setFolderName("");
        setShowMkdir(false);
        onUploaded();
      }
    } catch {
      setMsg({ text: "通信エラー", ok: false });
    }
  };

  return (
    <div style={uploadStyles.wrapper}>
      {/* Drop zone */}
      <div
        className="fs-drop-zone"
        style={{
          ...uploadStyles.dropZone,
          borderColor: dragging ? "#3366cc" : "#ccc",
          background: dragging ? "#eef3ff" : "#fafafa",
        }}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            if (e.target.files?.length) uploadFiles(e.target.files);
            e.target.value = "";
          }}
        />
        {uploading ? (
          <span style={uploadStyles.progressText}>
            <Icon name="fa-solid fa-spinner fa-spin" style={{ marginRight: 8 }} />
            {progress}
          </span>
        ) : (
          <>
            <Icon name="fa-solid fa-cloud-arrow-up fs-drop-icon" style={{ fontSize: 32, color: "#3366cc" }} />
            <span style={uploadStyles.dropText}>
              ファイルをドラッグ＆ドロップ、またはクリックして選択
            </span>
            {disk && disk.maxFileSize > 0 && (
              <span style={uploadStyles.limitText}>
                1ファイル最大 {formatSize(disk.maxFileSize)}
                {disk.maxUpload > 0 && ` / 現在アップロード可能 ${formatSize(disk.maxUpload)}`}
              </span>
            )}
          </>
        )}
      </div>

      {/* Actions */}
      <div style={uploadStyles.actions}>
        <button
          style={uploadStyles.mkdirBtn}
          onClick={() => setShowMkdir((v) => !v)}
        >
          <Icon name="fa-solid fa-folder-plus" style={{ marginRight: 6, color: "#f0b429" }} />
          新規フォルダ
        </button>
      </div>

      {showMkdir && (
        <div style={uploadStyles.mkdirRow}>
          <input
            style={uploadStyles.mkdirInput}
            placeholder="フォルダ名"
            value={folderName}
            onChange={(e) => setFolderName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && createFolder()}
            autoFocus
          />
          <button style={uploadStyles.mkdirSubmit} onClick={createFolder}>
            <Icon name="fa-solid fa-check" style={{ marginRight: 4 }} />
            作成
          </button>
        </div>
      )}

      {msg && (
        <div style={{ ...uploadStyles.msg, color: msg.ok ? "#27ae60" : "#c0392b" }}>
          <Icon name={msg.ok ? "fa-solid fa-circle-check" : "fa-solid fa-circle-xmark"} style={{ marginRight: 6 }} />
          {msg.text}
        </div>
      )}
    </div>
  );
}

const uploadStyles: Record<string, React.CSSProperties> = {
  wrapper: { marginBottom: 8 },
  dropZone: {
    border: "2px dashed #ccc",
    borderRadius: 10,
    padding: "24px 16px",
    textAlign: "center",
    cursor: "pointer",
    transition: "border-color 150ms, background 150ms",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 6,
  },
  dropText: { fontSize: 14, color: "#555" },
  limitText: { fontSize: 11, color: "#999" },
  progressText: { fontSize: 14, color: "#3366cc", display: "flex", alignItems: "center" },
  actions: { display: "flex", gap: 8, marginTop: 8 },
  mkdirBtn: {
    padding: "6px 14px",
    border: "1px solid #ccc",
    borderRadius: 6,
    background: "#fff",
    cursor: "pointer",
    fontSize: 13,
    display: "inline-flex",
    alignItems: "center",
    fontFamily: "inherit",
  },
  mkdirRow: { display: "flex", gap: 6, marginTop: 8 },
  mkdirInput: {
    flex: 1,
    padding: "8px 10px",
    border: "1px solid #ccc",
    borderRadius: 6,
    fontSize: 13,
    fontFamily: "inherit",
  },
  mkdirSubmit: {
    padding: "8px 16px",
    border: "none",
    borderRadius: 6,
    background: "#3366cc",
    color: "#fff",
    fontSize: 13,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    fontFamily: "inherit",
  },
  msg: { marginTop: 8, fontSize: 13, textAlign: "center", display: "flex", alignItems: "center", justifyContent: "center" },
};
