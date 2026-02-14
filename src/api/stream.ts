import { mkdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { safePath, getMime } from "./files";

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
  if (existsSync(source.playlistAbsPath)) return;

  const lockKey = source.cacheDir;
  const pending = inflight.get(lockKey);
  if (pending) {
    await pending;
    return;
  }

  const job = (async () => {
    await mkdir(source.cacheDir, { recursive: true });

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
      "veryfast",
      "-crf",
      "24",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      "-f",
      "hls",
      "-hls_time",
      "6",
      "-hls_playlist_type",
      "vod",
      "-hls_segment_filename",
      join(source.cacheDir, "seg_%05d.ts"),
      source.playlistAbsPath,
    ];

    const proc = Bun.spawn(["ffmpeg", ...ffmpegArgs], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(stderr || `ffmpeg failed with exit code ${exitCode}`);
    }

    if (!existsSync(source.playlistAbsPath)) {
      throw new Error("HLS playlist was not generated");
    }
  })();

  inflight.set(lockKey, job);
  try {
    await job;
  } finally {
    inflight.delete(lockKey);
  }
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
