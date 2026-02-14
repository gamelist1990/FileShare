import React, { useState, useEffect } from "react";
import { Icon } from "./Icon";
import { formatSize, fileUrl } from "../helpers/fileHelpers";
import { simpleMarkdownToHtml } from "../helpers/markdown";
import { modalStyles } from "./modalStyles";
import type { FileEntry } from "../types";

// ── Markdown Preview Modal ─────────────────────────────
export function MarkdownPreviewModal({
  entry,
  onClose,
}: {
  entry: FileEntry;
  onClose: () => void;
}) {
  const [mdContent, setMdContent] = useState<string | null>(null);
  const [mdLoading, setMdLoading] = useState(true);
  const [mdError, setMdError] = useState<string | null>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setMdLoading(true);
    setMdError(null);
    setMdContent(null);
    fetch(fileUrl(entry))
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then(text => {
        if (!cancelled) {
          setMdContent(simpleMarkdownToHtml(text));
          setMdLoading(false);
        }
      })
      .catch(err => {
        if (!cancelled) {
          setMdError(err.message);
          setMdLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [entry]);

  return (
    <div style={modalStyles.overlay} onClick={onClose}>
      <div
        className="fs-md-modal-container"
        style={mdModalStyles.container}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={mdModalStyles.header}>
          <Icon name="fa-brands fa-markdown" style={{ fontSize: 20, color: "#6cb4ee", marginRight: 10, flexShrink: 0 }} />
          <span style={modalStyles.filename}>{entry.name}</span>
          <span style={modalStyles.fileinfo}>{formatSize(entry.size)}</span>
          <button style={modalStyles.closeBtn} onClick={onClose} title="閉じる (Esc)">
            <Icon name="fa-solid fa-xmark" />
          </button>
        </div>
        <div style={mdModalStyles.body}>
          {mdLoading && (
            <div style={{ textAlign: "center", padding: 48, color: "#888" }}>
              <Icon name="fa-solid fa-spinner fa-spin" style={{ marginRight: 8 }} />
              Markdownを読み込み中...
            </div>
          )}
          {mdError && (
            <div style={{ textAlign: "center", padding: 48, color: "#c00" }}>
              <Icon name="fa-solid fa-circle-exclamation" style={{ marginRight: 8 }} />
              読み込みエラー: {mdError}
            </div>
          )}
          {mdContent && (
            <div
              className="fs-md-rendered"
              style={mdModalStyles.rendered}
              dangerouslySetInnerHTML={{ __html: mdContent }}
            />
          )}
        </div>
        <div style={mdModalStyles.footer}>
          <span style={{ color: "#888", fontSize: 12 }}>
            <Icon name="fa-brands fa-markdown" style={{ marginRight: 4 }} />
            Markdown プレビュー
          </span>
          <a href={fileUrl(entry)} download={entry.name} style={modalStyles.downloadLink}>
            <Icon name="fa-solid fa-download" style={{ marginRight: 6 }} />
            ダウンロード
          </a>
        </div>
      </div>
    </div>
  );
}

const mdModalStyles: Record<string, React.CSSProperties> = {
  container: {
    background: "#fff",
    borderRadius: 14,
    width: "min(900px, 80vw)",
    maxHeight: "88vh",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    boxShadow: "0 12px 48px rgba(0,0,0,0.3)",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "12px 20px",
    borderBottom: "1px solid #e8e8e8",
    background: "#fafbfc",
    color: "#333",
  },
  body: {
    flex: 1,
    overflowY: "auto",
    padding: "24px 32px",
    WebkitOverflowScrolling: "touch",
  },
  rendered: {
    fontSize: 15,
    lineHeight: 1.75,
    color: "#1a1a2e",
    wordBreak: "break-word",
  },
  footer: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "10px 20px",
    borderTop: "1px solid #e8e8e8",
    background: "#fafbfc",
  },
};
