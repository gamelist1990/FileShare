import React from "react";
import { Icon } from "./Icon";
import { formatSize } from "../helpers/fileHelpers";
import type { DiskInfo } from "../types";

// ── Disk Quota Bar ─────────────────────────────────────
export function DiskQuotaBar({ disk, onRetry }: { disk: DiskInfo | null; onRetry?: () => void }) {
  if (!disk) {
    return (
      <div style={diskStyles.container}>
        <div style={diskStyles.label}>
          <Icon name="fa-solid fa-hard-drive" style={{ marginRight: 6, color: "#888" }} />
          ディスク情報を読み込み中...
        </div>
        <div style={diskStyles.barOuter}>
          <div style={{ ...diskStyles.barInner, width: "0%", background: "#ccc" }} />
        </div>
      </div>
    );
  }
  if (disk.total === 0) {
    return (
      <div style={diskStyles.container}>
        <div style={diskStyles.label}>
          <Icon name="fa-solid fa-hard-drive" style={{ marginRight: 6, color: "#888" }} />
          ディスク情報を取得できませんでした
        </div>
        <div style={{ marginTop: 8 }}>
          <button style={diskStyles.retryBtn} onClick={onRetry}>
            <Icon name="fa-solid fa-rotate-right" style={{ marginRight: 4 }} />
            再取得
          </button>
        </div>
      </div>
    );
  }
  const pct = disk.usedPercent;
  const barColor = pct > 90 ? "#e74c3c" : pct > 70 ? "#f39c12" : "#2ecc71";
  return (
    <div style={diskStyles.container}>
      <div style={diskStyles.label}>
        <Icon name="fa-solid fa-hard-drive" style={{ marginRight: 6, color: "#888" }} />
        ディスク: {formatSize(disk.used)} / {formatSize(disk.total)} 使用中
        <span style={diskStyles.freeLabel} className="fs-disk-free-label">
          （空き {formatSize(disk.free)}・最大 {formatSize(disk.maxUpload)} アップロード可）
        </span>
      </div>
      <div style={diskStyles.barOuter}>
        <div style={{ ...diskStyles.barInner, width: `${Math.min(pct, 100)}%`, background: barColor }} />
      </div>
    </div>
  );
}

const diskStyles: Record<string, React.CSSProperties> = {
  container: { padding: "8px 0", marginBottom: 4 },
  label: { fontSize: 13, color: "#555", marginBottom: 4, display: "flex", alignItems: "center", flexWrap: "wrap" },
  freeLabel: { fontSize: 11, color: "#999", marginLeft: 8 },
  barOuter: { height: 8, background: "#e0e0e0", borderRadius: 4, overflow: "hidden" },
  barInner: { height: "100%", borderRadius: 4, transition: "width 300ms" },
  retryBtn: {
    padding: "6px 14px", border: "1px solid #ccc", borderRadius: 6,
    background: "#fff", cursor: "pointer", fontSize: 13, display: "inline-flex",
    alignItems: "center",
  },
};
