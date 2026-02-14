import React, { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { formatSize, fileUrl, isVideo, isAudio, isImage, isPreviewable, getExt } from "../helpers/fileHelpers";
import { modalStyles } from "./modalStyles";
import type { FileEntry } from "../types";

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
  const [videoError, setVideoError] = useState<string | null>(null);
  const [useDirectFallback, setUseDirectFallback] = useState(false);
  const [alwaysAnalyze, setAlwaysAnalyze] = useState(false);
  const [isMobileLikeClient, setIsMobileLikeClient] = useState(false);

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

  useEffect(() => {
    setVideoError(null);
    setUseDirectFallback(false);
  }, [entry.path]);

  useEffect(() => {
    fetch("/api/stream/config")
      .then((r) => r.ok ? r.json() : Promise.reject(new Error("config fetch failed")))
      .then((d) => setAlwaysAnalyze(Boolean(d?.alwaysAnalyze)))
      .catch(() => setAlwaysAnalyze(false));
  }, []);

  useEffect(() => {
    const ua = navigator.userAgent;
    const uaMobile = /iP(hone|ad|od)|Android|Mobile|Tablet/i.test(ua);
    const update = () => {
      const smallScreen = window.innerWidth <= 1024;
      const coarse = window.matchMedia("(pointer: coarse)").matches;
      setIsMobileLikeClient(uaMobile || smallScreen || coarse);
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  useEffect(() => {
    if (!isVideo(entry) || !videoRef.current) return;
    const v = videoRef.current;
    v.setAttribute("playsinline", "true");
    v.setAttribute("webkit-playsinline", "true");
    v.load();
  }, [entry, useDirectFallback]);

  const previewableFiles = entries.filter(isPreviewable);
  const currentIdx = previewableFiles.findIndex((f) => f.path === entry.path);
  const hasPrev = currentIdx > 0;
  const hasNext = currentIdx < previewableFiles.length - 1;
  const ext = getExt(entry.name);
  const shouldPreferServerHls = ["mp4", "m4v", "mov"].includes(ext) && (alwaysAnalyze || isMobileLikeClient);
  const hlsPlaylistUrl = `/api/stream/playlist?path=${encodeURIComponent(entry.path)}`;
  const activeVideoUrl = shouldPreferServerHls && !useDirectFallback ? hlsPlaylistUrl : fileUrl(entry);

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
            videoError ? (
              <div style={videoFallbackStyles.wrapper}>
                <Icon name="fa-solid fa-triangle-exclamation" style={videoFallbackStyles.icon} />
                <div style={videoFallbackStyles.title}>この動画はブラウザで再生できませんでした</div>
                <div style={videoFallbackStyles.desc}>{videoError}</div>
                <div style={videoFallbackStyles.actions}>
                  <a href={fileUrl(entry)} target="_blank" rel="noreferrer" style={videoFallbackStyles.linkBtn}>
                    別タブで開く
                  </a>
                  <a href={fileUrl(entry)} download={entry.name} style={videoFallbackStyles.linkBtn}>
                    ダウンロード
                  </a>
                </div>
              </div>
            ) : (
              <video
                ref={videoRef}
                key={`${entry.path}:${useDirectFallback ? "direct" : "hls"}`}
                src={activeVideoUrl}
                className="fs-modal-video"
                style={modalStyles.video}
                controls
                autoPlay
                preload="metadata"
                playsInline
                onLoadedMetadata={() => setVideoError(null)}
                onError={() => {
                  if (shouldPreferServerHls && !useDirectFallback) {
                    setUseDirectFallback(true);
                    setVideoError(null);
                    return;
                  }
                  const v = videoRef.current;
                  const code = v?.error?.code;
                  const detail =
                    code === 1 ? "再生が中止されました" :
                    code === 2 ? "ネットワークエラー" :
                    code === 3 ? "デコードエラー" :
                    code === 4 ? "非対応形式" :
                    "不明なエラー";
                  setVideoError(`再生できませんでした: ${detail}（H.264/AAC推奨）`);
                }}
              />
            )
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

const videoFallbackStyles: Record<string, React.CSSProperties> = {
  wrapper: {
    minHeight: 220,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    textAlign: "center",
    color: "#ddd",
    padding: "20px 16px",
    gap: 8,
  },
  icon: {
    color: "#ffb74d",
    fontSize: 28,
    marginBottom: 2,
  },
  title: {
    fontSize: 16,
    fontWeight: 600,
  },
  desc: {
    fontSize: 12,
    color: "#aaa",
  },
  actions: {
    marginTop: 8,
    display: "flex",
    gap: 8,
    flexWrap: "wrap",
    justifyContent: "center",
  },
  linkBtn: {
    border: "1px solid #6cb4ee",
    color: "#6cb4ee",
    borderRadius: 6,
    padding: "6px 10px",
    textDecoration: "none",
    fontSize: 12,
  },
};
