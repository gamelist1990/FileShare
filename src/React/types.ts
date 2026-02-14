// ── Shared Types ───────────────────────────────────────

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtime: string;
}

export interface DiskInfo {
  total: number;
  free: number;
  used: number;
  usedPercent: number;
  maxUpload: number;
}

export interface ServerStatusData {
  uptime: number;
  uptimeFormatted: string;
  totalDownloads: number;
  totalDownloadBytes: number;
  totalDownloadFormatted: string;
  totalUploads: number;
  totalUploadBytes: number;
  totalUploadFormatted: string;
  activeConnections: number;
  downloadBytesPerSec: number;
  downloadSpeedFormatted: string;
  uploadBytesPerSec: number;
  uploadSpeedFormatted: string;
  timestamp: number;
  disk: DiskInfo;
  port: number;
  sharePath: string;
}
