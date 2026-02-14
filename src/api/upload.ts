/**
 * File upload handler + disk capacity API
 *
 * - Requires authenticated session (token in Authorization header).
 * - Uploads go into the shared directory.
 * - Supports multipart/form-data with "file" field + optional "path" field.
 * - Security: path traversal prevention, filename sanitisation.
 * - Max upload size: 100 GB (capped by available disk space).
 */

import { join, basename } from "node:path";
import { mkdir, stat, readdir } from "node:fs/promises";
import * as diskusage from "diskusage";
import { safePath } from "./files";
import { getModuleSettings, registerSettingsModule } from "./settings";

const DEFAULT_MAX_UPLOAD_SIZE = 100 * 1024 * 1024 * 1024;
const SETTINGS_KEY = "upload";

interface UploadSettings {
  maxFileSizeBytes: number;
  directoryQuotaBytes: number;
}

const DEFAULT_UPLOAD_SETTINGS: UploadSettings = {
  maxFileSizeBytes: DEFAULT_MAX_UPLOAD_SIZE,
  directoryQuotaBytes: 0,
};

export function registerUploadSettings(): void {
  registerSettingsModule<UploadSettings>(SETTINGS_KEY, DEFAULT_UPLOAD_SETTINGS);
}

function getUploadSettings(): UploadSettings {
  const raw = getModuleSettings<UploadSettings>(SETTINGS_KEY);
  return {
    maxFileSizeBytes: Math.max(1, Math.floor(Number(raw?.maxFileSizeBytes ?? DEFAULT_MAX_UPLOAD_SIZE))),
    directoryQuotaBytes: Math.max(0, Math.floor(Number(raw?.directoryQuotaBytes ?? 0))),
  };
}

export interface DiskInfo {
  total: number;       // bytes
  free: number;        // bytes
  used: number;        // bytes
  usedPercent: number; // 0-100
  maxUpload: number;   // effective upload headroom (bytes)
  maxFileSize: number; // per-file upload limit (bytes)
  scope: "disk" | "quota";
  quotaBytes: number;
}

const DISK_CACHE_TTL_MS = 30_000;
let diskInfoCache: DiskInfo | null = null;
let diskInfoCacheAt = 0;
let dirUsageCache: number | null = null;
let dirUsageCacheAt = 0;

async function calculateDirectoryUsage(dirPath: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    try {
      if (entry.isDirectory()) {
        total += await calculateDirectoryUsage(fullPath);
      } else {
        const st = await stat(fullPath);
        total += st.size;
      }
    } catch {
      // ignore unreadable entries
    }
  }
  return total;
}

async function getDirectoryUsage(rootPath: string): Promise<number> {
  const now = Date.now();
  if (dirUsageCache !== null && now - dirUsageCacheAt < DISK_CACHE_TTL_MS) {
    return dirUsageCache;
  }
  try {
    const used = await calculateDirectoryUsage(rootPath);
    dirUsageCache = used;
    dirUsageCacheAt = now;
    return used;
  } catch {
    return dirUsageCache ?? 0;
  }
}

function invalidateUsageCache(): void {
  diskInfoCache = null;
  diskInfoCacheAt = 0;
  dirUsageCache = null;
  dirUsageCacheAt = 0;
}

function toDiskInfo(totalBytes: number, freeBytes: number, maxFileSize: number): DiskInfo {
  const total = Number.isFinite(totalBytes) && totalBytes > 0 ? Math.floor(totalBytes) : 0;
  const freeRaw = Number.isFinite(freeBytes) && freeBytes > 0 ? Math.floor(freeBytes) : 0;
  const free = total > 0 ? Math.min(freeRaw, total) : freeRaw;
  const used = total > 0 ? Math.max(0, total - free) : 0;
  return {
    total,
    free,
    used,
    usedPercent: total > 0 ? Math.round((used / total) * 100) : 0,
    maxUpload: Math.min(free, maxFileSize),
    maxFileSize,
    scope: "disk",
    quotaBytes: 0,
  };
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function cacheAndReturn(info: DiskInfo): DiskInfo {
  diskInfoCache = info;
  diskInfoCacheAt = Date.now();
  return info;
}

/** Get disk space for the drive containing rootPath (cross-platform). */
export async function getDiskInfo(rootPath: string): Promise<DiskInfo> {
  const now = Date.now();
  if (diskInfoCache && now - diskInfoCacheAt < DISK_CACHE_TTL_MS) {
    return diskInfoCache;
  }

  const uploadSettings = getUploadSettings();

  try {
    const usage = diskusage.checkSync(rootPath);
    const freeBytes = Number.isFinite(usage.available) ? usage.available : usage.free;

    if (uploadSettings.directoryQuotaBytes > 0) {
      const dirUsed = await getDirectoryUsage(rootPath);
      const quotaBytes = uploadSettings.directoryQuotaBytes;
      const quotaFree = Math.max(0, quotaBytes - dirUsed);

      return cacheAndReturn({
        total: quotaBytes,
        free: quotaFree,
        used: dirUsed,
        usedPercent: quotaBytes > 0 ? Math.round((dirUsed / quotaBytes) * 100) : 0,
        maxUpload: Math.min(quotaFree, Math.max(0, freeBytes), uploadSettings.maxFileSizeBytes),
        maxFileSize: uploadSettings.maxFileSizeBytes,
        scope: "quota",
        quotaBytes,
      });
    }

    return cacheAndReturn(toDiskInfo(usage.total, freeBytes, uploadSettings.maxFileSizeBytes));
  } catch (err: unknown) {
    console.warn("Disk detection failed:", getErrorMessage(err));
    return diskInfoCache ?? {
      total: 0,
      free: 0,
      used: 0,
      usedPercent: 0,
      maxUpload: uploadSettings.maxFileSizeBytes,
      maxFileSize: uploadSettings.maxFileSizeBytes,
      scope: "disk",
      quotaBytes: 0,
    };
  }
}

/**
 * Handle file upload.
 * Expects multipart form with:
 *   - file: the file to upload
 *   - path: (optional) relative directory path within the share
 */
export async function handleUpload(
  rootReal: string,
  request: Request,
  username: string
): Promise<Response> {
  try {
    const uploadSettings = getUploadSettings();
    const maxFileSize = uploadSettings.maxFileSizeBytes;

    const contentLength = parseInt(request.headers.get("content-length") ?? "0", 10);
    if (contentLength > maxFileSize) {
      return jsonResponse(413, { error: `ファイルサイズが大きすぎます (1ファイル最大 ${formatBytes(maxFileSize)})` });
    }

    const formData = await request.formData();
    const file = formData.get("file");
    const targetDir = (formData.get("path") as string) ?? "";

    if (!file || !(file instanceof File)) {
      return jsonResponse(400, { error: "ファイルが指定されていません" });
    }

    if (file.size > maxFileSize) {
      return jsonResponse(413, { error: `ファイルサイズが大きすぎます (1ファイル最大 ${formatBytes(maxFileSize)})` });
    }

    let fileName = basename(file.name)
      .replace(/[\x00-\x1f]/g, "")
      .replace(/[/\\:*?"<>|]/g, "_")
      .trim();

    if (!fileName || fileName === "." || fileName === "..") {
      return jsonResponse(400, { error: "無効なファイル名です" });
    }

    let destDir: string;
    if (targetDir) {
      const resolved = await safePath(rootReal, targetDir);
      if (!resolved) {
        return jsonResponse(400, { error: "指定されたディレクトリが無効です" });
      }
      destDir = resolved;
    } else {
      destDir = rootReal;
    }

    try {
      const dirStat = await stat(destDir);
      if (!dirStat.isDirectory()) {
        return jsonResponse(400, { error: "アップロード先がディレクトリではありません" });
      }
    } catch {
      return jsonResponse(400, { error: "アップロード先ディレクトリが存在しません" });
    }

    const destPath = await getUniqueFilePath(destDir, fileName);

    const currentDiskInfo = await getDiskInfo(rootReal);
    if (currentDiskInfo.maxUpload <= 0) {
      if (currentDiskInfo.scope === "quota") {
        return jsonResponse(413, { error: "ディレクトリ容量の上限に達しています。不要なファイルを削除してください" });
      }
      return jsonResponse(507, { error: "空き容量不足のためアップロードできません" });
    }

    if (file.size > currentDiskInfo.maxUpload) {
      if (currentDiskInfo.scope === "quota") {
        return jsonResponse(413, {
          error: `ディレクトリ容量の上限を超えます (残り ${formatBytes(currentDiskInfo.free)})`,
        });
      }
      return jsonResponse(507, {
        error: `空き容量不足のためアップロードできません (残り ${formatBytes(currentDiskInfo.free)})`,
      });
    }

    const arrayBuffer = await file.arrayBuffer();
    await Bun.write(destPath, arrayBuffer);
    invalidateUsageCache();

    const finalName = basename(destPath);
    const relPath = destPath
      .replace(/\\/g, "/")
      .replace(rootReal.replace(/\\/g, "/"), "")
      .replace(/^\//, "");

    console.log(`📤 Upload: "${finalName}" by ${username} (${formatBytes(file.size)})`);

    return jsonResponse(200, {
      ok: true,
      message: `「${finalName}」をアップロードしました`,
      file: {
        name: finalName,
        path: relPath,
        size: file.size,
      },
    });
  } catch (err: unknown) {
    console.error("Upload error:", err);
    return jsonResponse(500, { error: "アップロードに失敗しました: " + getErrorMessage(err) });
  }
}

/**
 * Create directories (authenticated).
 */
export async function handleMkdir(
  rootReal: string,
  request: Request,
  username: string
): Promise<Response> {
  try {
    const body = await request.json() as { path?: string; name?: string };
    const parentDir = body.path ?? "";
    const dirName = (body.name ?? "").trim();

    if (!dirName) {
      return jsonResponse(400, { error: "フォルダ名を指定してください" });
    }

    const safeName = dirName
      .replace(/[\x00-\x1f]/g, "")
      .replace(/[/\\:*?"<>|]/g, "_")
      .trim();

    if (!safeName || safeName === "." || safeName === "..") {
      return jsonResponse(400, { error: "無効なフォルダ名です" });
    }

    let baseDir: string;
    if (parentDir) {
      const resolved = await safePath(rootReal, parentDir);
      if (!resolved) {
        return jsonResponse(400, { error: "親ディレクトリが無効です" });
      }
      baseDir = resolved;
    } else {
      baseDir = rootReal;
    }

    const newDir = join(baseDir, safeName);

    const newDirNorm = newDir.replace(/\\/g, "/").toLowerCase();
    const rootNorm = rootReal.replace(/\\/g, "/").toLowerCase();
    if (!newDirNorm.startsWith(rootNorm)) {
      return jsonResponse(403, { error: "アクセスが拒否されました" });
    }

    await mkdir(newDir, { recursive: true });
    invalidateUsageCache();

    console.log(`📁 Mkdir: "${safeName}" by ${username}`);

    return jsonResponse(200, {
      ok: true,
      message: `フォルダ「${safeName}」を作成しました`,
    });
  } catch (err: unknown) {
    return jsonResponse(500, { error: "フォルダ作成に失敗しました: " + getErrorMessage(err) });
  }
}

async function getUniqueFilePath(dir: string, fileName: string): Promise<string> {
  let candidate = join(dir, fileName);
  let counter = 1;

  const dotIdx = fileName.lastIndexOf(".");
  const name = dotIdx > 0 ? fileName.slice(0, dotIdx) : fileName;
  const ext = dotIdx > 0 ? fileName.slice(dotIdx) : "";

  while (true) {
    try {
      await stat(candidate);
      // File exists, try with counter
      candidate = join(dir, `${name} (${counter})${ext}`);
      counter++;
    } catch {
      // File doesn't exist, use this path
      return candidate;
    }
  }
}

function jsonResponse(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
