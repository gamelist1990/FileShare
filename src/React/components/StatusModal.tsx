import React, { useState, useEffect, useCallback, useRef } from "react";
import { Icon } from "./Icon";
import { modalStyles } from "./modalStyles";
import { formatSize } from "../helpers/fileHelpers";
import type { ServerStatusData } from "../types";

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ── Speed Test helpers ─────────────────────────────────
async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 10_000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function measurePing(): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    try {
      await fetchWithTimeout(`/api/health?t=${Date.now()}_${i}`, { cache: "no-store" }, 5000);
      samples.push(performance.now() - start);
    } catch {
      // ignore single failure
    }
  }
  if (samples.length === 0) return 0;
  samples.sort((a, b) => a - b);
  return Math.round(samples[Math.floor(samples.length / 2)]); // median
}

async function measureDownloadSpeed(): Promise<number> {
  // WAN-safe sizes to reduce reset/chunk errors on reverse proxy paths
  const testSizes = [512 * 1024, 1024 * 1024, 2 * 1024 * 1024];
  let totalBytes = 0;
  let totalSeconds = 0;

  for (let i = 0; i < testSizes.length; i++) {
    const size = testSizes[i];
    const start = performance.now();
    try {
      const res = await fetchWithTimeout(
        `/api/speedtest/download?size=${size}&t=${Date.now()}_${i}`,
        { cache: "no-store" },
        12_000
      );
      if (!res.ok) continue;
      const buf = await res.arrayBuffer();
      const seconds = Math.max(0.001, (performance.now() - start) / 1000);
      totalBytes += buf.byteLength;
      totalSeconds += seconds;
    } catch {
      // ignore iteration errors
    }
  }

  if (totalBytes === 0 || totalSeconds <= 0) return 0;
  const bytesPerSec = totalBytes / totalSeconds;
  return (bytesPerSec * 8) / 1_000_000; // Mbps (decimal)
}

async function measureUploadSpeed(): Promise<number> {
  // WAN-safe upload sizes
  const payloadSize = 512 * 1024; // 512KB
  const iterations = 2;
  const payload = new Uint8Array(payloadSize);
  // getRandomValues has a per-call limit (~65536 bytes in browsers)
  // Fill in chunks to avoid QuotaExceededError
  for (let offset = 0; offset < payload.length; offset += 65536) {
    const chunk = payload.subarray(offset, Math.min(offset + 65536, payload.length));
    crypto.getRandomValues(chunk);
  }

  let totalBytes = 0;
  let totalSeconds = 0;

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    try {
      const res = await fetchWithTimeout(
        `/api/speedtest/upload?t=${Date.now()}_${i}`,
        {
          method: "POST",
          body: payload,
          cache: "no-store",
        },
        12_000
      );
      if (!res.ok) continue;
      const json = await res.json() as { receivedBytes?: number };
      const sentBytes = json.receivedBytes ?? payloadSize;
      const seconds = Math.max(0.001, (performance.now() - start) / 1000);
      totalBytes += sentBytes;
      totalSeconds += seconds;
    } catch {
      // ignore iteration errors
    }
  }

  if (totalBytes === 0 || totalSeconds <= 0) return 0;
  const bytesPerSec = totalBytes / totalSeconds;
  return (bytesPerSec * 8) / 1_000_000; // Mbps (decimal)
}

// ── Status Modal Component ─────────────────────────────
export function StatusModal({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<ServerStatusData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Client-side measurements
  const [ping, setPing] = useState<number | null>(null);
  const [dlSpeed, setDlSpeed] = useState<number | null>(null);
  const [ulSpeed, setUlSpeed] = useState<number | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const measuringRef = useRef(false);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetchWithTimeout("/api/status", { cache: "no-store" }, 4000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: ServerStatusData = await res.json();
      setStatus(data);
      setError(null);
    } catch (e: unknown) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const runSpeedTest = useCallback(async () => {
    if (measuringRef.current) return;
    measuringRef.current = true;
    setMeasuring(true);
    setPing(null);
    setDlSpeed(null);
    setUlSpeed(null);

    try {
      const p = await measurePing();
      setPing(p);
      const dl = await measureDownloadSpeed();
      setDlSpeed(dl);
      const ul = await measureUploadSpeed();
      setUlSpeed(ul);
    } catch {
      setUlSpeed(0);
    } finally {
      measuringRef.current = false;
      setMeasuring(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    runSpeedTest();
    intervalRef.current = setInterval(() => {
      if (!measuringRef.current) fetchStatus();
    }, 10000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [fetchStatus, runSpeedTest]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const diskPct = status?.disk?.usedPercent ?? 0;
  const diskBarColor = diskPct > 90 ? "#ef4444" : diskPct > 70 ? "#f59e0b" : "#10b981";

  return (
    <div style={modalStyles.overlay} onClick={onClose}>
      <div 
        className="fs-status-modal fs-md-modal-container"
        style={statusStyles.container} 
        onClick={(e) => e.stopPropagation()}
      >
        <div style={statusStyles.header}>
          <Icon name="fa-solid fa-chart-simple" style={{ fontSize: 18, color: "#3b82f6", marginRight: 12 }} />
          <span style={{ flex: 1, fontSize: 17, fontWeight: 700, letterSpacing: "-0.01em" }}>サーバーステータス</span>
          <button style={modalStyles.closeBtn} onClick={onClose} title="閉じる (Esc)">
            <Icon name="fa-solid fa-xmark" />
          </button>
        </div>

        <div style={statusStyles.body} className="fs-status-body">
          {loading && (
            <div style={{ textAlign: "center", padding: "64px 20px", color: "#64748b" }}>
              <Icon name="fa-solid fa-spinner fa-spin" style={{ fontSize: 24, marginBottom: 16, display: "block" }} />
              <div style={{ fontSize: 14 }}>ステータスを取得中...</div>
            </div>
          )}

          {error && !status && (
            <div style={{ textAlign: "center", padding: "64px 20px", color: "#ef4444" }}>
              <Icon name="fa-solid fa-triangle-exclamation" style={{ fontSize: 24, marginBottom: 16, display: "block" }} />
              <div style={{ fontWeight: 600 }}>エラーが発生しました</div>
              <div style={{ fontSize: 13, marginTop: 4 }}>{error}</div>
            </div>
          )}

          {status && (
            <>
              {/* Server Info Section */}
              <div style={statusStyles.section}>
                <div style={statusStyles.sectionTitle}>
                  <Icon name="fa-solid fa-server" style={{ marginRight: 8, opacity: 0.7 }} />
                  サーバー基本情報
                </div>
                <div className="fs-status-grid" style={statusStyles.grid}>
                  <StatusItem icon="fa-solid fa-up-right-from-square" label="稼働時間" value={status.uptimeFormatted} />
                  <StatusItem icon="fa-solid fa-network-wired" label="ポート番号" value={String(status.port)} />
                  <StatusItem
                    icon="fa-solid fa-users"
                    label="アクティブ接続"
                    value={String(status.activeConnections)}
                    sub={`同時リクエスト: ${status.activeRequests}`}
                  />
                  <StatusItem icon="fa-solid fa-folder-tree" label="共有ディレクトリ" value={status.sharePath} isCode />
                </div>
              </div>

              {/* Transfer Stats Section */}
              <div style={statusStyles.section}>
                <div style={statusStyles.sectionTitle}>
                  <Icon name="fa-solid fa-arrow-right-arrow-left" style={{ marginRight: 8, opacity: 0.7 }} />
                  トラフィック統計
                </div>
                <div className="fs-status-grid" style={statusStyles.grid}>
                  <StatusItem
                    icon="fa-solid fa-download"
                    label="総ダウンロード"
                    value={status.totalDownloadFormatted}
                    sub={`${status.totalDownloads} ファイル`}
                  />
                  <StatusItem
                    icon="fa-solid fa-upload"
                    label="総アップロード"
                    value={status.totalUploadFormatted}
                    sub={`${status.totalUploads} ファイル`}
                  />
                  <StatusItem
                    icon="fa-solid fa-gauge-high"
                    label="DL 速度 (Avg/1m)"
                    value={status.downloadSpeedFormatted}
                    color="#3b82f6"
                  />
                  <StatusItem
                    icon="fa-solid fa-gauge"
                    label="UL 速度 (Avg/1m)"
                    value={status.uploadSpeedFormatted}
                    color="#f59e0b"
                  />
                </div>
              </div>

              {/* Client Network Section */}
              <div style={statusStyles.section}>
                <div style={statusStyles.sectionTitle}>
                  <Icon name="fa-solid fa-bolt" style={{ marginRight: 8, opacity: 0.7 }} />
                  ネットワーク・スピードテスト
                  <button
                    style={statusStyles.retestBtn}
                    onClick={runSpeedTest}
                    disabled={measuring}
                  >
                    <Icon name={measuring ? "fa-solid fa-spinner fa-spin" : "fa-solid fa-rotate"} style={{ marginRight: 6 }} />
                    {measuring ? "計測中" : "再計測"}
                  </button>
                </div>
                <div className="fs-status-grid" style={statusStyles.grid}>
                  <StatusItem
                    icon="fa-solid fa-microchip"
                    label="レイテンシ (Ping)"
                    value={ping !== null ? `${ping}ms` : "---"}
                    color={ping !== null ? (ping < 50 ? "#10b981" : ping < 150 ? "#f59e0b" : "#ef4444") : "#94a3b8"}
                  />
                  <StatusItem
                    icon="fa-solid fa-cloud-arrow-down"
                    label="ダウンロード実測"
                    value={dlSpeed !== null ? `${dlSpeed.toFixed(1)} Mbps` : "---"}
                    color="#3b82f6"
                  />
                  <StatusItem
                    icon="fa-solid fa-cloud-arrow-up"
                    label="アップロード実測"
                    value={ulSpeed !== null ? `${ulSpeed.toFixed(1)} Mbps` : "---"}
                    color="#8b5cf6"
                  />
                </div>
              </div>

              {/* Disk Section */}
              <div style={{ ...statusStyles.section, marginBottom: 0 }}>
                <div style={statusStyles.sectionTitle}>
                  <Icon name="fa-solid fa-database" style={{ marginRight: 8, opacity: 0.7 }} />
                  {status.disk.scope === "quota" ? "ストレージ（共有クォータ）" : "ストレージ"}
                </div>
                <div style={statusStyles.diskContainer}>
                  {status.disk && status.disk.total > 0 ? (
                    <>
                      <div style={statusStyles.diskInfo}>
                        <div style={{ fontWeight: 600 }}>{formatSize(status.disk.used)} / {formatSize(status.disk.total)}</div>
                        <div style={{ color: "#64748b", fontSize: 12 }}>
                          空き容量: {formatSize(status.disk.free)} / 1ファイル上限: {formatSize(status.disk.maxFileSize)}
                        </div>
                      </div>
                      <div style={statusStyles.diskBarOuter}>
                        <div style={{ ...statusStyles.diskBarInner, width: `${Math.min(diskPct, 100)}%`, background: diskBarColor }} />
                      </div>
                      <div style={{ fontSize: 12, color: "#64748b", marginTop: 8, textAlign: "right", fontWeight: 500 }}>
                        使用率: {diskPct}%
                      </div>
                    </>
                  ) : (
                    <div style={{ fontSize: 14, color: "#94a3b8", padding: "12px 0" }}>ストレージ情報を取得できませんでした</div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        <div style={statusStyles.footer}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#10b981", boxShadow: "0 0 8px rgba(16, 185, 129, 0.4)" }} />
            <span style={{ color: "#64748b", fontSize: 12, fontWeight: 500 }}>Live Update (10s)</span>
          </div>
          <span style={{ color: "#94a3b8", fontSize: 12 }}>Esc で閉じる</span>
        </div>
      </div>
    </div>
  );
}

// ── Status Item Sub-component ──────────────────────────
function StatusItem({
  icon,
  label,
  value,
  sub,
  color,
  isCode,
}: {
  icon: string;
  label: string;
  value: string;
  sub?: string;
  color?: string;
  isCode?: boolean;
}) {
  return (
    <div style={statusStyles.item} className="fs-status-item">
      <div style={{ ...statusStyles.itemIcon, color: color ?? "#64748b", background: color ? `${color}10` : "#f1f5f9" }}>
        <Icon name={icon} style={{ fontSize: 15 }} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.025em", marginBottom: 2 }}>
          {label}
        </div>
        <div style={{
          fontSize: isCode ? 13 : 15,
          fontWeight: 700,
          color: color ?? "#1e293b",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontFamily: isCode ? "'JetBrains Mono', 'Fira Code', monospace" : "inherit",
        }}>
          {value}
        </div>
        {sub && <div style={{ fontSize: 11, color: "#64748b", marginTop: 1, fontWeight: 500 }}>{sub}</div>}
      </div>
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────
const statusStyles: Record<string, React.CSSProperties> = {
  container: {
    background: "#fff",
    borderRadius: 20,
    width: "min(640px, 94vw)",
    maxHeight: "90vh",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    boxShadow: "0 25px 50px -12px rgba(0,0,0,0.25)",
    border: "1px solid #e2e8f0",
  },
  header: {
    display: "flex",
    alignItems: "center",
    padding: "20px 24px",
    borderBottom: "1px solid #f1f5f9",
    background: "#fff",
  },
  body: {
    flex: 1,
    overflowY: "auto",
    padding: "24px",
    WebkitOverflowScrolling: "touch",
    display: "flex",
    flexDirection: "column",
    gap: "32px",
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: "16px",
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: 700,
    color: "#475569",
    display: "flex",
    alignItems: "center",
    paddingBottom: "8px",
    borderBottom: "2px solid #f8fafc",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, 1fr)",
    gap: "12px",
  },
  item: {
    display: "flex",
    alignItems: "center",
    padding: "12px 16px",
    background: "#f8fafc",
    borderRadius: 12,
    border: "1px solid #f1f5f9",
    transition: "all 0.2s ease",
  },
  itemIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 14,
    flexShrink: 0,
  },
  retestBtn: {
    marginLeft: "auto",
    padding: "6px 14px",
    border: "1px solid #e2e8f0",
    borderRadius: 8,
    background: "#fff",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 600,
    display: "inline-flex",
    alignItems: "center",
    color: "#475569",
    transition: "all 0.15s ease",
    boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
  },
  diskContainer: {
    padding: "20px",
    background: "#f8fafc",
    borderRadius: 16,
    border: "1px solid #f1f5f9",
  },
  diskInfo: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-end",
    fontSize: 15,
    marginBottom: 12,
  },
  diskBarOuter: {
    height: 12,
    background: "#e2e8f0",
    borderRadius: 6,
    overflow: "hidden",
  },
  diskBarInner: {
    height: "100%",
    borderRadius: 6,
    transition: "width 1s cubic-bezier(0.4, 0, 0.2, 1)",
  },
  footer: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "16px 24px",
    borderTop: "1px solid #f1f5f9",
    background: "#f8fafc",
  },
};
