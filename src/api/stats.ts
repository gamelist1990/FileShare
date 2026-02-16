/**
 * Server statistics tracking module
 *
 * Tracks:
 *  - Server uptime
 *  - Total file downloads (count + bytes)
 *  - Total uploads (count + bytes)
 *  - Active connections / requests
 *  - Bandwidth (bytes per interval)
 */

// ── Server start time ──────────────────────────────────
const serverStartTime = Date.now();

// ── Counters ───────────────────────────────────────────
let totalDownloads = 0;
let totalDownloadBytes = 0;
let totalUploads = 0;
let totalUploadBytes = 0;
let activeConnections = 0;

// Recent active clients (IP -> last seen timestamp)
const ACTIVE_CLIENT_WINDOW_MS = 60_000;
const activeClientLastSeen = new Map<string, number>();

function pruneActiveClients() {
  const cutoff = Date.now() - ACTIVE_CLIENT_WINDOW_MS;
  for (const [ip, ts] of activeClientLastSeen.entries()) {
    if (ts < cutoff) activeClientLastSeen.delete(ip);
  }
}

// Per-file download count (keyed by normalized relative path)
const perFileDownloads = new Map<string, number>();

function normalizeFileKey(relPath: string): string {
  return relPath.replace(/\\/g, "/").replace(/^\/+/, "").trim().toLowerCase();
}

// ── Bandwidth tracking (sliding window) ────────────────
const BANDWIDTH_WINDOW_MS = 60_000; // 1 minute window
const BANDWIDTH_BUCKET_MS = 1_000;  // 1 second buckets

interface BandwidthSample {
  timestamp: number;
  downloadBytes: number;
  uploadBytes: number;
}

const bandwidthSamples: BandwidthSample[] = [];

function pruneSamples() {
  const cutoff = Date.now() - BANDWIDTH_WINDOW_MS;
  while (bandwidthSamples.length > 0 && bandwidthSamples[0].timestamp < cutoff) {
    bandwidthSamples.shift();
  }
}

function addBandwidthSample(downloadBytes: number, uploadBytes: number) {
  bandwidthSamples.push({
    timestamp: Date.now(),
    downloadBytes,
    uploadBytes,
  });
  pruneSamples();
}

// ── Public API ─────────────────────────────────────────

/** Record a file download */
export function recordDownload(bytes: number) {
  totalDownloads++;
  totalDownloadBytes += bytes;
  addBandwidthSample(bytes, 0);
}

/** Record a download count for a specific relative file path */
export function recordFileDownload(relPath: string) {
  const key = normalizeFileKey(relPath);
  if (!key) return;
  perFileDownloads.set(key, (perFileDownloads.get(key) ?? 0) + 1);
}

/** Get download count for a specific relative file path */
export function getFileDownloadCount(relPath: string): number {
  const key = normalizeFileKey(relPath);
  if (!key) return 0;
  return perFileDownloads.get(key) ?? 0;
}

/** Record a file upload */
export function recordUpload(bytes: number) {
  totalUploads++;
  totalUploadBytes += bytes;
  addBandwidthSample(0, bytes);
}

/** Increment active connections */
export function connectionStart() {
  activeConnections++;
}

/** Mark a client as recently active */
export function markClientActive(clientIp: string) {
  if (!clientIp) return;
  activeClientLastSeen.set(clientIp, Date.now());
}

/** Decrement active connections */
export function connectionEnd() {
  activeConnections = Math.max(0, activeConnections - 1);
}

/** Get current bandwidth (bytes/sec averaged over last minute) */
function getBandwidth(): { downloadBytesPerSec: number; uploadBytesPerSec: number } {
  pruneSamples();
  if (bandwidthSamples.length === 0) {
    return { downloadBytesPerSec: 0, uploadBytesPerSec: 0 };
  }

  let totalDl = 0;
  let totalUl = 0;
  for (const s of bandwidthSamples) {
    totalDl += s.downloadBytes;
    totalUl += s.uploadBytes;
  }

  // Average over the actual time span (or 1 second minimum)
  const span = Math.max(1000, Date.now() - bandwidthSamples[0].timestamp);
  return {
    downloadBytesPerSec: Math.round((totalDl / span) * 1000),
    uploadBytesPerSec: Math.round((totalUl / span) * 1000),
  };
}

/** Format bytes to human readable */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Format duration to human readable */
function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}日`);
  if (hours > 0) parts.push(`${hours}時間`);
  if (minutes > 0) parts.push(`${minutes}分`);
  parts.push(`${secs}秒`);
  return parts.join("");
}

export interface ServerStatus {
  uptime: number;         // ms
  uptimeFormatted: string;
  totalDownloads: number;
  totalDownloadBytes: number;
  totalDownloadFormatted: string;
  totalUploads: number;
  totalUploadBytes: number;
  totalUploadFormatted: string;
  activeConnections: number;
  activeRequests: number;
  downloadBytesPerSec: number;
  downloadSpeedFormatted: string;
  uploadBytesPerSec: number;
  uploadSpeedFormatted: string;
  timestamp: number;
}

/** Get full server status snapshot */
export function getServerStatus(): ServerStatus {
  const uptime = Date.now() - serverStartTime;
  const bw = getBandwidth();
  pruneActiveClients();
  const activeClientCount = activeClientLastSeen.size;

  return {
    uptime,
    uptimeFormatted: formatUptime(uptime),
    totalDownloads,
    totalDownloadBytes,
    totalDownloadFormatted: formatBytes(totalDownloadBytes),
    totalUploads,
    totalUploadBytes,
    totalUploadFormatted: formatBytes(totalUploadBytes),
    activeConnections: activeClientCount,
    activeRequests: activeConnections,
    downloadBytesPerSec: bw.downloadBytesPerSec,
    downloadSpeedFormatted: formatBytes(bw.downloadBytesPerSec) + "/s",
    uploadBytesPerSec: bw.uploadBytesPerSec,
    uploadSpeedFormatted: formatBytes(bw.uploadBytesPerSec) + "/s",
    timestamp: Date.now(),
  };
}

/** Print status to console */
export function printStatus(port: number, sharePath: string) {
  const s = getServerStatus();
  console.log("\n📊 ─── サーバーステータス ───────────────");
  console.log(`  ⏱️  稼働時間:           ${s.uptimeFormatted}`);
  console.log(`  🌐  待機アドレス:       0.0.0.0:${port}`);
  console.log(`  📂  共有パス:           ${sharePath}`);
  console.log(`  🔗  アクティブ接続:     ${s.activeConnections} クライアント`);
  console.log(`  📶  同時リクエスト:     ${s.activeRequests}`);
  console.log(`  📥  総ダウンロード:     ${s.totalDownloads} 件 (${s.totalDownloadFormatted})`);
  console.log(`  📤  総アップロード:     ${s.totalUploads} 件 (${s.totalUploadFormatted})`);
  console.log(`  ⬇️  DL速度 (直近1分):   ${s.downloadSpeedFormatted}`);
  console.log(`  ⬆️  UL速度 (直近1分):   ${s.uploadSpeedFormatted}`);
  console.log("────────────────────────────────────────\n");
}
