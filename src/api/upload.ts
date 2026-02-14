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
import { mkdir, stat, realpath } from "node:fs/promises";
import { execSync } from "node:child_process";
import { safePath } from "./files";

// Max upload size: 100 GB
const MAX_UPLOAD_SIZE = 100 * 1024 * 1024 * 1024;

// ── Disk capacity ──────────────────────────────────────

export interface DiskInfo {
  total: number;       // bytes
  free: number;        // bytes
  used: number;        // bytes
  usedPercent: number; // 0-100
  maxUpload: number;   // effective max upload size (min of free, MAX_UPLOAD_SIZE)
}

const DISK_CACHE_TTL_MS = 30_000;
let diskInfoCache: DiskInfo | null = null;
let diskInfoCacheAt = 0;

function cacheAndReturn(info: DiskInfo): DiskInfo {
  diskInfoCache = info;
  diskInfoCacheAt = Date.now();
  return info;
}

/** Get disk space for the drive containing rootPath (Windows & Unix) */
export function getDiskInfo(rootPath: string): DiskInfo {
  const now = Date.now();
  if (diskInfoCache && now - diskInfoCacheAt < DISK_CACHE_TTL_MS) {
    return diskInfoCache;
  }

  try {
    if (process.platform === "win32") {
      // Windows: try multiple PowerShell strategies for robust detection
      const driveLetter = rootPath.charAt(0).toUpperCase();
      // 1) Prefer CIM/Win32_LogicalDisk (reliable)
      try {
        // Use CIM but suppress PowerShell errors to avoid noisy stderr output
        const cmd = `powershell -NoProfile -Command "Get-CimInstance -ClassName Win32_LogicalDisk -Filter \"DeviceID='${driveLetter}:'\" -ErrorAction SilentlyContinue | Select-Object -Property Size,FreeSpace | ConvertTo-Json 2>$null"`;
        const output = execSync(cmd, { encoding: "utf-8", timeout: 1500 }).trim();
        if (output) {
          const info = JSON.parse(output);
          const total = Number(info.Size) || 0;
          const free = Number(info.FreeSpace) || 0;
          const used = total > 0 ? total - free : 0;
          if (total > 0) {
            return cacheAndReturn({
              total,
              free,
              used,
              usedPercent: total > 0 ? Math.round((used / total) * 100) : 0,
              maxUpload: Math.min(free, MAX_UPLOAD_SIZE),
            });
          }
        }
      } catch (e) {
        // try fallback
      }

      // 2) Fallback to Get-Volume (PowerShell 3.0+)
      try {
        const cmdVol = `powershell -NoProfile -Command "Get-Volume -DriveLetter ${driveLetter} -ErrorAction SilentlyContinue | Select-Object -Property SizeRemaining,Size | ConvertTo-Json 2>$null"`;
        const outVol = execSync(cmdVol, { encoding: "utf-8", timeout: 1500 }).trim();
        if (outVol) {
          const infoV = JSON.parse(outVol);
          const total = Number(infoV.Size) || 0;
          const free = Number(infoV.SizeRemaining) || 0;
          const used = total > 0 ? total - free : 0;
          if (total > 0) {
            return cacheAndReturn({
              total,
              free,
              used,
              usedPercent: total > 0 ? Math.round((used / total) * 100) : 0,
              maxUpload: Math.min(free, MAX_UPLOAD_SIZE),
            });
          }
        }
      } catch (eVol) {
        // fallback to Get-PSDrive next
      }

      // 3) Fallback to Get-PSDrive
      try {
        const cmd2 = `powershell -NoProfile -Command "(Get-PSDrive -Name ${driveLetter} | Select-Object Used,Free | ConvertTo-Json) 2>$null"`;
        const output2 = execSync(cmd2, { encoding: "utf-8", timeout: 1500 }).trim();
        if (output2) {
          const info2 = JSON.parse(output2);
          const used = Number(info2.Used) || 0;
          const free = Number(info2.Free) || 0;
          const total = used + free;
          if (total > 0) {
            return cacheAndReturn({
              total,
              free,
              used,
              usedPercent: total > 0 ? Math.round((used / total) * 100) : 0,
              maxUpload: Math.min(free, MAX_UPLOAD_SIZE),
            });
          }
        }
      } catch (e2) {
        console.warn("Disk detection (PowerShell) failed:", e2);
        // fall through to generic fallback
      }

      // If we reach here, fall back to generic response
      return cacheAndReturn({
        total: 0,
        free: 0,
        used: 0,
        usedPercent: 0,
        maxUpload: MAX_UPLOAD_SIZE,
      });
    } else {
      // Unix: use df
      const output = execSync(`df -B1 "${rootPath}" | tail -1`, {
        encoding: "utf-8",
        timeout: 1500,
      }).trim();
      const parts = output.split(/\s+/);
      const total = parseInt(parts[1], 10) || 0;
      const used = parseInt(parts[2], 10) || 0;
      const free = parseInt(parts[3], 10) || 0;
      return cacheAndReturn({
        total,
        free,
        used,
        usedPercent: total > 0 ? Math.round((used / total) * 100) : 0,
        maxUpload: Math.min(free, MAX_UPLOAD_SIZE),
      });
    }
  } catch (err) {
    // Fallback: can't detect
    console.warn("Disk detection failed:", err);
    return diskInfoCache ?? {
      total: 0,
      free: 0,
      used: 0,
      usedPercent: 0,
      maxUpload: MAX_UPLOAD_SIZE,
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
    // Check content length
    const contentLength = parseInt(request.headers.get("content-length") ?? "0", 10);
    if (contentLength > MAX_UPLOAD_SIZE) {
      return jsonResponse(413, { error: "ファイルサイズが大きすぎます (最大 100 GB)" });
    }

    const formData = await request.formData();
    const file = formData.get("file");
    const targetDir = (formData.get("path") as string) ?? "";

    if (!file || !(file instanceof File)) {
      return jsonResponse(400, { error: "ファイルが指定されていません" });
    }

    // Sanitise filename: remove path separators, null bytes
    let fileName = basename(file.name)
      .replace(/[\x00-\x1f]/g, "")
      .replace(/[/\\:*?"<>|]/g, "_")
      .trim();

    if (!fileName || fileName === "." || fileName === "..") {
      return jsonResponse(400, { error: "無効なファイル名です" });
    }

    // Resolve target directory
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

    // Ensure directory exists
    try {
      const dirStat = await stat(destDir);
      if (!dirStat.isDirectory()) {
        return jsonResponse(400, { error: "アップロード先がディレクトリではありません" });
      }
    } catch {
      return jsonResponse(400, { error: "アップロード先ディレクトリが存在しません" });
    }

    // Avoid overwriting existing files: append number if needed
    const destPath = await getUniqueFilePath(destDir, fileName);

    // Write file using Bun's efficient API
    const arrayBuffer = await file.arrayBuffer();
    await Bun.write(destPath, arrayBuffer);

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
  } catch (err: any) {
    console.error("Upload error:", err);
    return jsonResponse(500, { error: "アップロードに失敗しました: " + err.message });
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

    // Sanitise
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

    // Verify stays inside root
    const newDirNorm = newDir.replace(/\\/g, "/").toLowerCase();
    const rootNorm = rootReal.replace(/\\/g, "/").toLowerCase();
    if (!newDirNorm.startsWith(rootNorm)) {
      return jsonResponse(403, { error: "アクセスが拒否されました" });
    }

    await mkdir(newDir, { recursive: true });

    console.log(`📁 Mkdir: "${safeName}" by ${username}`);

    return jsonResponse(200, {
      ok: true,
      message: `フォルダ「${safeName}」を作成しました`,
    });
  } catch (err: any) {
    return jsonResponse(500, { error: "フォルダ作成に失敗しました: " + err.message });
  }
}

// ── Helpers ────────────────────────────────────────────

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
