import React, { useEffect, useRef } from "react";
import { Icon } from "./Icon";
import { formatSize, fileUrl, isVideo, isAudio, isImage, isPreviewable, getExt } from "../helpers/fileHelpers";
import { modalStyles } from "./modalStyles";
import type { FileEntry } from "../types";

function getVideoMimeByExt(ext: string): string {
  const map: Record<string, string> = {
    mp4: "video/mp4",
    m4v: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm",
    ogv: "video/ogg",
    mkv: "video/x-matroska",
    avi: "video/x-msvideo",
  };
  return map[ext] ?? "video/mp4";
}

// ── Preview Modal Component ────────────────────────────
export function PreviewModal({
  entry,
  entries,
  onClose,
  onNavigate,
}: {
  entry: FileEntry;
  entries: FileEntry[];
  onClose: () => void;
  onNavigate: (entry: FileEntry) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); return; }
      const previewableFiles = entries.filter(isPreviewable);
      const idx = previewableFiles.findIndex((f) => f.path === entry.path);
      if (e.key === "ArrowLeft" && idx > 0) onNavigate(previewableFiles[idx - 1]);
      else if (e.key === "ArrowRight" && idx < previewableFiles.length - 1) onNavigate(previewableFiles[idx + 1]);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [entry, entries, onClose, onNavigate]);

  const previewableFiles = entries.filter(isPreviewable);
  const currentIdx = previewableFiles.findIndex((f) => f.path === entry.path);
  const hasPrev = currentIdx > 0;
  const hasNext = currentIdx < previewableFiles.length - 1;
  const ext = getExt(entry.name);

  return (
    <div style={modalStyles.overlay} onClick={onClose}>
      <div className="fs-modal-container" style={modalStyles.container} onClick={(e) => e.stopPropagation()}>
        <div style={modalStyles.header}>
          <span style={modalStyles.filename}>{entry.name}</span>
          <span style={modalStyles.fileinfo}>{formatSize(entry.size)}</span>
          <button style={modalStyles.closeBtn} onClick={onClose} title="閉じる (Esc)">
            <Icon name="fa-solid fa-xmark" />
          </button>
        </div>
        <div style={modalStyles.content}>
          {hasPrev && (
            <button style={{ ...modalStyles.navArrow, left: 8 }} onClick={() => onNavigate(previewableFiles[currentIdx - 1])} title="前のファイル (←)">
              <Icon name="fa-solid fa-chevron-left" />
            </button>
          )}
          {isVideo(entry) && (
            <video
              ref={videoRef}
              key={entry.path}
              className="fs-modal-video"
              style={modalStyles.video}
              controls
              preload="metadata"
              playsInline
            >
              <source src={fileUrl(entry)} type={getVideoMimeByExt(ext)} />
            </video>
          )}
          {isAudio(entry) && (
            <div className="fs-modal-audio-wrapper" style={modalStyles.audioWrapper}>
              <Icon name="fa-solid fa-music" style={{ fontSize: 72, color: "#9b59b6" }} />
              <audio key={entry.path} style={modalStyles.audio} controls autoPlay preload="metadata">
                <source src={fileUrl(entry)} />
              </audio>
            </div>
          )}
          {isImage(entry) && (
            <img key={entry.path} src={fileUrl(entry)} alt={entry.name} className="fs-modal-image" style={modalStyles.image} />
          )}
          {hasNext && (
            <button style={{ ...modalStyles.navArrow, right: 8 }} onClick={() => onNavigate(previewableFiles[currentIdx + 1])} title="次のファイル (→)">
              <Icon name="fa-solid fa-chevron-right" />
            </button>
          )}
        </div>
        <div style={modalStyles.footer}>
          <span style={modalStyles.counter}>{currentIdx + 1} / {previewableFiles.length}</span>
          <a href={fileUrl(entry)} download={entry.name} style={modalStyles.downloadLink}>
            <Icon name="fa-solid fa-download" style={{ marginRight: 6 }} />
            ダウンロード
          </a>
        </div>
      </div>
    </div>
  );
}
