import { mkdir, readFile, stat, readdir, rm, utimes } from "node:fs/promises";
import { existsSync, rmSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { safePath, getMime } from "./files";
import { getModuleSettings, registerSettingsModule } from "./settings";

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function jsonResponse(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const SUPPORTED_SOURCE_EXTS = new Set([".mp4", ".m4v", ".mov"]);
const HLS_ROOT = join(tmpdir(), "fileshare-hls-cache");
const inflight = new Map<string, Promise<void>>();
const STREAM_SETTINGS_KEY = "stream";
// Keep generated HLS cache for 30m (user request)
const HLS_CACHE_TTL_MS = 30 * 60 * 1000;
const HLS_CACHE_TTL_SECONDS = Math.floor(HLS_CACHE_TTL_MS / 1000);
const HLS_CACHE_JANITOR_INTERVAL_MS = 60 * 1000;

let janitorTimer: ReturnType<typeof setInterval> | null = null;
let shutdownHookInstalled = false;

interface StreamSettings {
  alwaysAnalyze: boolean;
  useFastCopyFirst: boolean;
  ffmpegPreset: "ultrafast" | "superfast" | "veryfast" | "faster";
  hlsSegmentSeconds: number;
}

const DEFAULT_STREAM_SETTINGS: StreamSettings = {
  alwaysAnalyze: false,
  useFastCopyFirst: true,
  ffmpegPreset: "ultrafast",
  hlsSegmentSeconds: 6,
};

export function registerStreamSettings(): void {
  registerSettingsModule<StreamSettings>(STREAM_SETTINGS_KEY, DEFAULT_STREAM_SETTINGS);
}

export function getStreamCacheTtlSeconds(): number {
  return HLS_CACHE_TTL_SECONDS;
}

export function getStreamSettings(): StreamSettings {
  const raw = getModuleSettings<StreamSettings>(STREAM_SETTINGS_KEY);
  const allowedPresets = new Set(["ultrafast", "superfast", "veryfast", "faster"]);
  const preset = typeof raw?.ffmpegPreset === "string" && allowedPresets.has(raw.ffmpegPreset)
    ? raw.ffmpegPreset
    : DEFAULT_STREAM_SETTINGS.ffmpegPreset;
  const hlsSegmentSeconds = Math.max(2, Math.min(12, Number(raw?.hlsSegmentSeconds ?? DEFAULT_STREAM_SETTINGS.hlsSegmentSeconds) || DEFAULT_STREAM_SETTINGS.hlsSegmentSeconds));

  return {
    alwaysAnalyze: Boolean(raw?.alwaysAnalyze),
    useFastCopyFirst: raw?.useFastCopyFirst !== false,
    ffmpegPreset: preset,
    hlsSegmentSeconds,
  };
}

async function runFfmpeg(args: string[]): Promise<void> {
  const proc = Bun.spawn(["ffmpeg", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(stderr || `ffmpeg failed with exit code ${exitCode}`);
  }
}

interface ResolvedSource {
  sourceAbsPath: string;
  sourceRelPath: string;
  cacheDir: string;
  playlistAbsPath: string;
}

async function resolveSource(rootReal: string, relPath: string): Promise<ResolvedSource | null> {
  const sourceAbsPath = await safePath(rootReal, relPath);
  if (!sourceAbsPath) return null;

  const st = await stat(sourceAbsPath);
  if (!st.isFile()) return null;

  const ext = extname(sourceAbsPath).toLowerCase();
  if (!SUPPORTED_SOURCE_EXTS.has(ext)) return null;

  const sourceKey = createHash("sha1")
    .update(`${sourceAbsPath}:${st.size}:${st.mtimeMs}`)
    .digest("hex");

  const rootKey = createHash("sha1").update(rootReal).digest("hex");
  const cacheDir = join(HLS_ROOT, rootKey, sourceKey);
  const playlistAbsPath = join(cacheDir, "index.m3u8");

  return {
    sourceAbsPath,
    sourceRelPath: relPath.replace(/\\/g, "/"),
    cacheDir,
    playlistAbsPath,
  };
}

async function ensureHlsGenerated(source: ResolvedSource): Promise<void> {
  if (existsSync(source.playlistAbsPath)) {
    await markCacheAccessed(source.cacheDir);
    return;
  }

  const lockKey = source.cacheDir;
  const pending = inflight.get(lockKey);
  if (pending) {
    await pending;
    return;
  }

  const job = (async () => {
    await mkdir(source.cacheDir, { recursive: true });
    const settings = getStreamSettings();
    const hlsTime = String(settings.hlsSegmentSeconds);

    // 1) Fast path: remux/copy first (very fast, minimal CPU)
    if (settings.useFastCopyFirst) {
      const copyArgs = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        source.sourceAbsPath,
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-c:v",
        "copy",
        "-c:a",
        "copy",
        "-f",
        "hls",
        "-hls_time",
        hlsTime,
        "-hls_playlist_type",
        "vod",
        "-hls_flags",
        "independent_segments",
        "-hls_segment_filename",
        join(source.cacheDir, "seg_%05d.ts"),
        source.playlistAbsPath,
      ];

      try {
        await runFfmpeg(copyArgs);
        if (existsSync(source.playlistAbsPath)) {
          return;
        }
      } catch {
        // fall through to transcode path
      }
    }

    const ffmpegArgs = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      source.sourceAbsPath,
      "-c:v",
      "libx264",
      "-preset",
      settings.ffmpegPreset,
      "-crf",
      "26",
      "-profile:v",
      "main",
      "-level",
      "4.0",
      "-x264-params",
      "scenecut=0:open_gop=0",
      "-g",
      "60",
      "-keyint_min",
      "60",
      "-c:a",
      "aac",
      "-ac",
      "2",
      "-b:a",
      "96k",
      "-movflags",
      "+faststart",
      "-threads",
      "0",
      "-f",
      "hls",
      "-hls_time",
      hlsTime,
      "-hls_playlist_type",
      "vod",
      "-hls_flags",
      "independent_segments",
      "-hls_segment_filename",
      join(source.cacheDir, "seg_%05d.ts"),
      source.playlistAbsPath,
    ];

    await runFfmpeg(ffmpegArgs);

    if (!existsSync(source.playlistAbsPath)) {
      throw new Error("HLS playlist was not generated");
    }

    await markCacheAccessed(source.cacheDir);
  })();

  inflight.set(lockKey, job);
  try {
    await job;
  } finally {
    inflight.delete(lockKey);
  }
}

async function markCacheAccessed(cacheDir: string): Promise<void> {
  const now = new Date();
  try {
    await utimes(cacheDir, now, now);
  } catch {
    // ignore touch errors; cache can still be used
  }
}

async function removeExpiredCacheDirs(baseDir: string, nowMs: number): Promise<number> {
  let removed = 0;
  const entries = await readdir(baseDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sourceDir = join(baseDir, entry.name);
    try {
      const st = await stat(sourceDir);
      if ((nowMs - st.mtimeMs) >= HLS_CACHE_TTL_MS) {
        await rm(sourceDir, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      // ignore per-dir errors
    }
  }
  return removed;
}

export async function cleanupExpiredStreamCache(): Promise<number> {
  if (!existsSync(HLS_ROOT)) return 0;

  const nowMs = Date.now();
  let removed = 0;
  const roots = await readdir(HLS_ROOT, { withFileTypes: true });

  for (const rootEntry of roots) {
    if (!rootEntry.isDirectory()) continue;
    const rootDir = join(HLS_ROOT, rootEntry.name);
    try {
      removed += await removeExpiredCacheDirs(rootDir, nowMs);
      const rest = await readdir(rootDir, { withFileTypes: true });
      if (rest.length === 0) {
        await rm(rootDir, { recursive: true, force: true });
      }
    } catch {
      // ignore per-root errors
    }
  }

  return removed;
}

export async function clearAllStreamCache(): Promise<void> {
  await rm(HLS_ROOT, { recursive: true, force: true });
}

export function startStreamCacheJanitor(): void {
  if (janitorTimer) return;

  void cleanupExpiredStreamCache();
  janitorTimer = setInterval(() => {
    void cleanupExpiredStreamCache();
  }, HLS_CACHE_JANITOR_INTERVAL_MS);
  janitorTimer.unref?.();
}

export function stopStreamCacheJanitor(): void {
  if (!janitorTimer) return;
  clearInterval(janitorTimer);
  janitorTimer = null;
}

export function setupStreamCacheShutdownCleanup(): void {
  if (shutdownHookInstalled) return;
  shutdownHookInstalled = true;

  const cleanupSync = () => {
    stopStreamCacheJanitor();
    try {
      rmSync(HLS_ROOT, { recursive: true, force: true });
    } catch {
      // ignore shutdown cleanup errors
    }
  };

  process.once("SIGINT", cleanupSync);
  process.once("SIGTERM", cleanupSync);
  process.once("exit", cleanupSync);
}

function rewritePlaylist(playlistText: string, sourceRelPath: string): string {
  const lines = playlistText.split(/\r?\n/);
  return lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;
    return `/api/stream/file?path=${encodeURIComponent(sourceRelPath)}&file=${encodeURIComponent(trimmed)}`;
  }).join("\n");
}

export async function handleHlsPlaylist(rootReal: string, relPath: string): Promise<Response> {
  try {
    const source = await resolveSource(rootReal, relPath);
    if (!source) {
      return jsonResponse(400, { error: "HLS変換対象の動画が見つかりません（mp4/m4v/movのみ対応）" });
    }

    await ensureHlsGenerated(source);
    const raw = await readFile(source.playlistAbsPath, "utf-8");
    const rewritten = rewritePlaylist(raw, source.sourceRelPath);

    return new Response(rewritten, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "no-store",
      },
    });
  } catch (err: unknown) {
    const msg = getErrorMessage(err);
    if (/ffmpeg/i.test(msg)) {
      return jsonResponse(501, { error: "ストリーミング変換にはffmpegが必要です" });
    }
    return jsonResponse(500, { error: "HLSプレイリスト生成に失敗しました", detail: msg });
  }
}

export async function handleHlsFile(rootReal: string, relPath: string, file: string): Promise<Response> {
  try {
    const source = await resolveSource(rootReal, relPath);
    if (!source) {
      return jsonResponse(400, { error: "動画ソースが見つかりません" });
    }

    await ensureHlsGenerated(source);

    const safeFile = basename(file);
    if (safeFile !== file || !safeFile) {
      return jsonResponse(400, { error: "無効なセグメント名です" });
    }

    const abs = join(source.cacheDir, safeFile);
    const st = await stat(abs);
    if (!st.isFile()) {
      return jsonResponse(404, { error: "セグメントが見つかりません" });
    }

    return new Response(Bun.file(abs), {
      status: 200,
      headers: {
        "Content-Type": getMime(abs),
        "Content-Length": String(st.size),
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (err: unknown) {
    return jsonResponse(500, { error: "HLSセグメント配信に失敗しました", detail: getErrorMessage(err) });
  }
}
