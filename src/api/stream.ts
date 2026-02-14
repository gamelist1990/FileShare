import { mkdir, readFile, writeFile, stat, readdir, rm, utimes } from "node:fs/promises";
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
// Default to tmpdir but will be overridden at startup to <share>/.fileshare/cache/hls
let HLS_ROOT = join(tmpdir(), "fileshare-hls-cache");
const inflight = new Map<string, Promise<void>>();
const STREAM_SETTINGS_KEY = "stream";
// Keep generated HLS cache for 30m (user request)
const HLS_CACHE_TTL_MS = 30 * 60 * 1000;
const HLS_CACHE_TTL_SECONDS = Math.floor(HLS_CACHE_TTL_MS / 1000);
const HLS_CACHE_JANITOR_INTERVAL_MS = 60 * 1000;
const DYNAMIC_PLAYLIST_LOOKAHEAD = 3;
const NO_CACHE_THRESHOLD_BYTES = 1024 * 1024 * 1024; // 1GB
const MAX_FFMPEG_PROCESSES = 2;
const NO_CACHE_SEGMENT_GRACE_MS = 8000;

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

/**
 * Set the HLS cache root to reside under the share path's .fileshare/cache directory.
 * Called once at server startup with the resolved share path.
 */
export async function setHlsCacheRoot(shareRoot: string): Promise<void> {
  const dir = join(shareRoot, ".fileshare", "cache", "hls");
  HLS_ROOT = dir;
  try {
    await mkdir(HLS_ROOT, { recursive: true });
  } catch {
    // best-effort — janitor/handlers will check existence
  }
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
  await acquireFfmpegSlot();
  try {
    const proc = Bun.spawn(["ffmpeg", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(stderr || `ffmpeg failed with exit code ${exitCode}`);
    }
  } finally {
    releaseFfmpegSlot();
  }
}

async function probeDurationSec(sourceAbsPath: string): Promise<number | null> {
  const proc = Bun.spawn([
    "ffprobe",
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    sourceAbsPath,
  ], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;
  if (exitCode === 0) {
    const stdout = await new Response(proc.stdout).text();
    const value = Number(stdout.trim());
    if (Number.isFinite(value) && value > 0) return value;
  }

  // Fallback: parse duration from ffmpeg probe output.
  const ffmpegProbe = Bun.spawn([
    "ffmpeg",
    "-hide_banner",
    "-i",
    sourceAbsPath,
  ], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await ffmpegProbe.exited;
  const stderr = await new Response(ffmpegProbe.stderr).text();
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
  if (!m) return null;

  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const ss = Number(m[3]);
  const duration = (hh * 3600) + (mm * 60) + ss;
  if (!Number.isFinite(duration) || duration <= 0) return null;
  return duration;
}

async function getSourceMeta(source: ResolvedSource, segSec: number): Promise<SourceMeta | null> {
  if (source.noCache) {
    const mem = sourceMetaMemory.get(source.cacheDir);
    if (mem && mem.segSec === segSec && mem.totalSegments > 0 && mem.durationSec > 0) {
      return mem;
    }

    const durationSec = await probeDurationSec(source.sourceAbsPath);
    if (!durationSec) return null;
    const totalSegments = Math.max(1, Math.ceil(durationSec / segSec));
    const meta: SourceMeta = { durationSec, totalSegments, segSec };
    sourceMetaMemory.set(source.cacheDir, meta);
    return meta;
  }

  const metaPath = join(source.cacheDir, "meta.json");

  if (existsSync(metaPath)) {
    try {
      const raw = JSON.parse(await readFile(metaPath, "utf-8")) as Partial<SourceMeta>;
      if (
        Number.isFinite(raw.durationSec) &&
        Number.isFinite(raw.totalSegments) &&
        Number.isFinite(raw.segSec) &&
        Number(raw.durationSec) > 0 &&
        Number(raw.totalSegments) > 0 &&
        Number(raw.segSec) === segSec
      ) {
        return {
          durationSec: Number(raw.durationSec),
          totalSegments: Number(raw.totalSegments),
          segSec,
        };
      }
    } catch {
      // ignore invalid meta and regenerate
    }
  }

  const durationSec = await probeDurationSec(source.sourceAbsPath);
  if (!durationSec) return null;

  const totalSegments = Math.max(1, Math.ceil(durationSec / segSec));
  const meta: SourceMeta = { durationSec, totalSegments, segSec };

  try {
    await writeFile(metaPath, JSON.stringify(meta), "utf-8");
  } catch {
    // best-effort cache
  }

  return meta;
}

interface ResolvedSource {
  sourceAbsPath: string;
  sourceRelPath: string;
  cacheDir: string;
  playlistAbsPath: string;
  sourceSize: number;
  noCache: boolean;
}

interface SourceMeta {
  durationSec: number;
  totalSegments: number;
  segSec: number;
}

const sourceMetaMemory = new Map<string, SourceMeta>();
const noCacheSegmentCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
const noCacheDirCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

let ffmpegRunning = 0;
const ffmpegWaitQueue: Array<() => void> = [];

async function acquireFfmpegSlot(): Promise<void> {
  if (ffmpegRunning < MAX_FFMPEG_PROCESSES) {
    ffmpegRunning += 1;
    return;
  }
  await new Promise<void>((resolve) => {
    ffmpegWaitQueue.push(resolve);
  });
  ffmpegRunning += 1;
}

function releaseFfmpegSlot(): void {
  ffmpegRunning = Math.max(0, ffmpegRunning - 1);
  const next = ffmpegWaitQueue.shift();
  if (next) next();
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
  const sourceSize = st.size;
  const noCache = sourceSize > NO_CACHE_THRESHOLD_BYTES;

  return {
    sourceAbsPath,
    sourceRelPath: relPath.replace(/\\/g, "/"),
    cacheDir,
    playlistAbsPath,
    sourceSize,
    noCache,
  };
}

async function ensureHlsGenerated(source: ResolvedSource): Promise<void> {
  // If a finalized playlist already exists, update access time and return.
  if (existsSync(source.playlistAbsPath)) {
    const txt = await readFile(source.playlistAbsPath, "utf-8");
    if (txt.includes("#EXT-X-ENDLIST")) {
      await markCacheAccessed(source.cacheDir);
      return;
    }
    // playlist exists but not final — just update mtime and return
    await markCacheAccessed(source.cacheDir);
    return;
  }

  // Ensure cache directory exists but DO NOT pre-generate any media segments here.
  const lockKey = `${source.cacheDir}:init`;
  const pending = inflight.get(lockKey);
  if (pending) {
    await pending;
    return;
  }

  const job = (async () => {
    await mkdir(source.cacheDir, { recursive: true });
    // no ffmpeg work here; segments are generated on-demand per-segment
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

function scheduleNoCacheSegmentDelete(absPath: string): void {
  const old = noCacheSegmentCleanupTimers.get(absPath);
  if (old) clearTimeout(old);

  const timer = setTimeout(() => {
    noCacheSegmentCleanupTimers.delete(absPath);
    void rm(absPath, { force: true }).catch(() => undefined);
  }, NO_CACHE_SEGMENT_GRACE_MS);
  timer.unref?.();
  noCacheSegmentCleanupTimers.set(absPath, timer);
}

function scheduleNoCacheDirDelete(cacheDir: string): void {
  const old = noCacheDirCleanupTimers.get(cacheDir);
  if (old) clearTimeout(old);

  const timer = setTimeout(() => {
    noCacheDirCleanupTimers.delete(cacheDir);
    sourceMetaMemory.delete(cacheDir);
    void rm(cacheDir, { recursive: true, force: true }).catch(() => undefined);
  }, NO_CACHE_SEGMENT_GRACE_MS);
  timer.unref?.();
  noCacheDirCleanupTimers.set(cacheDir, timer);
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
  for (const timer of noCacheSegmentCleanupTimers.values()) clearTimeout(timer);
  noCacheSegmentCleanupTimers.clear();
  for (const timer of noCacheDirCleanupTimers.values()) clearTimeout(timer);
  noCacheDirCleanupTimers.clear();
  await rm(HLS_ROOT, { recursive: true, force: true });
  sourceMetaMemory.clear();
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
    try {
      stopStreamCacheJanitor();
    } catch { /* ignore */ }
    try {
      rmSync(HLS_ROOT, { recursive: true, force: true });
    } catch { /* ignore */ }
  };

  const exitWithCleanup = (code = 0) => {
    try {
      cleanupSync();
    } finally {
      // ensure process terminates after cleanup
      try { process.exit(code); } catch { /* ignore */ }
    }
  };

  // Signals: handle common termination signals (including Windows SIGBREAK)
  process.once("SIGINT", () => exitWithCleanup(130));
  process.once("SIGTERM", () => exitWithCleanup(143));
  process.once("SIGBREAK", () => exitWithCleanup(130));
  process.once("SIGHUP", () => exitWithCleanup(129));

  // Normal Node lifecycle / unexpected errors
  process.once("beforeExit", () => cleanupSync());
  process.once("exit", () => cleanupSync());

  process.once("uncaughtException", (err) => {
    console.error("Uncaught exception — cleaning HLS cache before exit:", err);
    exitWithCleanup(1);
  });

  process.once("unhandledRejection", (reason) => {
    console.error("Unhandled rejection — cleaning HLS cache before exit:", reason);
    exitWithCleanup(1);
  });
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

    // If a fully-generated playlist exists (contains ENDLIST), use it so players get VOD behavior.
    // For >1GB no-cache sources, never reuse persisted playlist cache.
    if (!source.noCache && existsSync(source.playlistAbsPath)) {
      const rawOnDisk = await readFile(source.playlistAbsPath, "utf-8");
      if (rawOnDisk.includes("#EXT-X-ENDLIST")) {
        const rewritten = rewritePlaylist(rawOnDisk, source.sourceRelPath);
        await markCacheAccessed(source.cacheDir);
        return new Response(rewritten, {
          status: 200,
          headers: {
            "Content-Type": "application/vnd.apple.mpegurl",
            "Cache-Control": "no-store",
          },
        });
      }
    }

    // Prefer VOD playlist synthesis when duration is known.
    // This avoids Safari treating playback as "LIVE" and enables rewind/seek UI.
    const settings = getStreamSettings();
    const segSec = settings.hlsSegmentSeconds;
    const meta = await getSourceMeta(source, segSec);

    if (meta) {
      const lines: string[] = [];
      lines.push("#EXTM3U");
      lines.push("#EXT-X-VERSION:3");
      lines.push("#EXT-X-PLAYLIST-TYPE:VOD");
      lines.push(`#EXT-X-TARGETDURATION:${Math.ceil(segSec)}`);
      lines.push("#EXT-X-MEDIA-SEQUENCE:0");

      for (let i = 0; i < meta.totalSegments; i++) {
        const remaining = meta.durationSec - (i * segSec);
        const duration = i === meta.totalSegments - 1
          ? Math.max(0.001, Math.min(segSec, remaining))
          : segSec;
        lines.push(`#EXTINF:${duration.toFixed(3)},`);
        lines.push(`seg_${String(i).padStart(5, "0")}.ts`);
      }

      lines.push("#EXT-X-ENDLIST");

      const raw = lines.join("\n") + "\n";
      const rewritten = rewritePlaylist(raw, source.sourceRelPath);
      await markCacheAccessed(source.cacheDir);

      return new Response(rewritten, {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.apple.mpegurl",
          "Cache-Control": "no-store",
        },
      });
    }

    // Fallback when metadata is unavailable: progressive playlist without ENDLIST.

    let filesInCache: string[] = [];
    try {
      filesInCache = (await readdir(source.cacheDir)).filter((n) => /^seg_\d{5}\.ts$/.test(n)).sort();
    } catch {
      // empty
    }

    // Build a progressive segment list so the player can keep requesting next chunks.
    // We include generated segments plus a small lookahead window (generated on-demand in /api/stream/file).
    const existingIndexes = filesInCache
      .map((name) => {
        const m = name.match(/^seg_(\d{5})\.ts$/);
        return m ? parseInt(m[1], 10) : -1;
      })
      .filter((n) => n >= 0)
      .sort((a, b) => a - b);

    const maxExisting = existingIndexes.length > 0 ? existingIndexes[existingIndexes.length - 1] : -1;
    const uptoIndex = Math.max(0, maxExisting + DYNAMIC_PLAYLIST_LOOKAHEAD);

    const playlistSegments: string[] = [];
    for (let i = 0; i <= uptoIndex; i++) {
      playlistSegments.push(`seg_${String(i).padStart(5, "0")}.ts`);
    }

    const lines: string[] = [];
    lines.push("#EXTM3U");
    lines.push("#EXT-X-VERSION:3");
    lines.push(`#EXT-X-TARGETDURATION:${Math.ceil(segSec)}`);
    lines.push(`#EXT-X-MEDIA-SEQUENCE:0`);

    for (const f of playlistSegments) {
      lines.push(`#EXTINF:${segSec.toFixed(3)},`);
      lines.push(f);
    }

    // Do NOT add EXT-X-ENDLIST for partial/ongoing playlists — player will poll for updates.
    const raw = lines.join("\n") + "\n";
    const rewritten = rewritePlaylist(raw, source.sourceRelPath);
    await markCacheAccessed(source.cacheDir);

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

async function ensureSegmentExists(source: ResolvedSource, index: number): Promise<void> {
  const fname = `seg_${String(index).padStart(5, "0")}.ts`;
  const abs = join(source.cacheDir, fname);
  if (existsSync(abs)) {
    await markCacheAccessed(source.cacheDir);
    return;
  }

  const lockKey = `${source.cacheDir}:seg:${index}`;
  const pending = inflight.get(lockKey);
  if (pending) {
    await pending;
    return;
  }

  const job = (async () => {
    const settings = getStreamSettings();
    const segSec = settings.hlsSegmentSeconds;
    const startSec = index * segSec;
    // try copy first
    const copyArgs = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-ss",
      String(startSec),
      "-i",
      source.sourceAbsPath,
      "-t",
      String(segSec + 0.5),
      "-c:v",
      "copy",
      "-c:a",
      "copy",
      "-f",
      "mpegts",
      abs,
    ];

    try {
      await runFfmpeg(copyArgs);
      if (existsSync(abs)) {
        await markCacheAccessed(source.cacheDir);
        return;
      }
    } catch {
      // fall through to transcode
    }

    const ffmpegArgs = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-ss",
      String(startSec),
      "-i",
      source.sourceAbsPath,
      "-c:v",
      "libx264",
      "-preset",
      getStreamSettings().ffmpegPreset,
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
      "-t",
      String(segSec + 0.5),
      "-f",
      "mpegts",
      abs,
    ];

    await runFfmpeg(ffmpegArgs);
    if (!existsSync(abs)) {
      throw new Error("segment generation failed");
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

    const match = safeFile.match(/^seg_(\d{5})\.ts$/);
    if (!match) {
      return jsonResponse(404, { error: "セグメントが見つかりません" });
    }
    const segmentIndex = parseInt(match[1], 10);

    const abs = join(source.cacheDir, safeFile);

    if (!existsSync(abs)) {
      // try to generate this segment on-demand (seek + copy/transcode)
      try {
        await ensureSegmentExists(source, segmentIndex);
      } catch (err) {
        return jsonResponse(404, { error: "セグメントの生成に失敗しました" });
      }
    }

    const st = await stat(abs);
    if (!st.isFile()) {
      return jsonResponse(404, { error: "セグメントが見つかりません" });
    }

    if (source.noCache) {
      const payload = await Bun.file(abs).arrayBuffer();
      const settings = getStreamSettings();
      const meta = await getSourceMeta(source, settings.hlsSegmentSeconds);
      const isLastSegment = Boolean(meta && segmentIndex >= (meta.totalSegments - 1));

      // tiny grace window for concurrent viewers, then auto-delete
      scheduleNoCacheSegmentDelete(abs);

      if (isLastSegment) {
        scheduleNoCacheDirDelete(source.cacheDir);
      }

      return new Response(payload, {
        status: 200,
        headers: {
          "Content-Type": getMime(abs),
          "Content-Length": String(payload.byteLength),
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store",
        },
      });
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
