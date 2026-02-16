import { readdir, stat, realpath } from "node:fs/promises";
import { join, relative, extname, basename, dirname } from "node:path";
import { getFileDownloadCount } from "./stats";

// ── Types ──────────────────────────────────────────────
export interface FileEntry {
  name: string;
  path: string; // relative to root
  isDir: boolean;
  size: number;
  mtime: string; // ISO string
  downloadCount?: number;
}

// ── MIME map (common types) ────────────────────────────
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".mov": "video/quicktime",
  ".m3u8": "application/vnd.apple.mpegurl",
  ".m3u": "application/x-mpegurl",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".7z": "application/x-7z-compressed",
  ".rar": "application/vnd.rar",
  ".exe": "application/octet-stream",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".ts": "video/mp2t",
};

export function getMime(filePath: string): string {
  return MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function shouldForceDownload(request: Request): boolean {
  try {
    const url = new URL(request.url);
    const v = (url.searchParams.get("download") ?? "").toLowerCase();
    return v === "1" || v === "true" || v === "yes";
  } catch {
    return false;
  }
}

function encodeDispositionFilename(name: string): string {
  return encodeURIComponent(name)
    .replace(/['()]/g, escape)
    .replace(/\*/g, "%2A");
}

function buildContentDisposition(filePath: string): string {
  const fileName = basename(filePath);
  const encoded = encodeDispositionFilename(fileName);
  return `attachment; filename*=UTF-8''${encoded}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isSocialPreviewRequest(request: Request): boolean {
  const ua = (request.headers.get("user-agent") ?? "").toLowerCase();
  if (!ua) return false;

  const bots = [
    "discordbot",
    "slackbot",
    "twitterbot",
    "facebookexternalhit",
    "linkedinbot",
    "whatsapp",
    "telegrambot",
    "line",
    "skypeuripreview",
  ];

  return bots.some((keyword) => ua.includes(keyword));
}

function buildDownloadPreviewHtml(request: Request, relPath: string, filePath: string): string {
  const url = new URL(request.url);
  const fileName = basename(filePath);
  const normalizedRelPath = relPath.replace(/\\/g, "/");
  const downloadCount = getFileDownloadCount(normalizedRelPath);
  const title = `${fileName} | FileShare`;
  const description = `ダウンロード共有ファイル: ${normalizedRelPath}（ダウンロード: ${downloadCount}回）`;
  const canonicalUrl = `${url.origin}${url.pathname}${url.search}`;

  const escapedTitle = escapeHtml(title);
  const escapedDescription = escapeHtml(description);
  const escapedCanonicalUrl = escapeHtml(canonicalUrl);

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapedTitle}</title>
  <meta name="description" content="${escapedDescription}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="FileShare" />
  <meta property="og:title" content="${escapedTitle}" />
  <meta property="og:description" content="${escapedDescription}" />
  <meta property="og:url" content="${escapedCanonicalUrl}" />
  <meta name="twitter:card" content="summary" />
  <meta name="twitter:title" content="${escapedTitle}" />
  <meta name="twitter:description" content="${escapedDescription}" />
  <link rel="canonical" href="${escapedCanonicalUrl}" />
</head>
<body>
  <h1>${escapedTitle}</h1>
  <p>${escapedDescription}</p>
  <p><a href="${escapedCanonicalUrl}">ダウンロード</a></p>
</body>
</html>`;
}

function isExternalUri(uri: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(uri) || /^data:|^blob:/i.test(uri);
}

function normalizeRelPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function toApiFileUrlFromPlaylist(playlistRelPath: string, rawUri: string): string {
  const uri = rawUri.trim();
  if (!uri || isExternalUri(uri)) return uri;

  const targetRel = uri.startsWith("/")
    ? uri.replace(/^\/+/, "")
    : normalizeRelPath(join(dirname(playlistRelPath), uri));

  return `/api/file?path=${encodeURIComponent(targetRel)}`;
}

function rewriteHlsPlaylist(content: string, playlistRelPath: string): string {
  const lines = content.split(/\r?\n/);

  return lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    // URI attribute lines (e.g. EXT-X-KEY, EXT-X-MAP, EXT-X-I-FRAME-STREAM-INF)
    if (trimmed.startsWith("#") && /URI="([^"]+)"/i.test(line)) {
      return line.replace(/URI="([^"]+)"/i, (_m, uri: string) => {
        const rewritten = toApiFileUrlFromPlaylist(playlistRelPath, uri);
        return `URI="${rewritten}"`;
      });
    }

    // Media / playlist segment URI lines
    if (!trimmed.startsWith("#")) {
      return toApiFileUrlFromPlaylist(playlistRelPath, trimmed);
    }

    return line;
  }).join("\n");
}

// ── Security: validate path stays inside root ──────────
export async function safePath(
  rootReal: string,
  relPath: string
): Promise<string | null> {
  try {
    // Normalise: replace backslashes, strip leading slashes/dots
    const cleaned = relPath
      .replace(/\\/g, "/")
      .replace(/^[./\\]+/, "")
      .replace(/\.\./g, "");

    const target = join(rootReal, cleaned);
    const resolved = await realpath(target);

    // Normalise both to forward-slash lowercase for Windows
    const normRoot = rootReal.replace(/\\/g, "/").toLowerCase();
    const normResolved = resolved.replace(/\\/g, "/").toLowerCase();

    if (!normResolved.startsWith(normRoot)) {
      return null; // path traversal attempt
    }
    return resolved;
  } catch {
    return null; // path doesn't exist
  }
}

// ── Calculate total size of a directory (recursive) ───
async function calcDirSize(dirPath: string): Promise<number> {
  let total = 0;
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const promises = entries.map(async (entry) => {
      const fullPath = join(dirPath, entry.name);
      try {
        if (entry.isDirectory()) {
          return await calcDirSize(fullPath);
        } else {
          const st = await stat(fullPath);
          return st.size;
        }
      } catch {
        return 0;
      }
    });
    const sizes = await Promise.all(promises);
    total = sizes.reduce((a, b) => a + b, 0);
  } catch {
    // inaccessible directory
  }
  return total;
}

// ── List directory ─────────────────────────────────────
export async function listDirectory(
  rootReal: string,
  relPath: string
): Promise<FileEntry[] | null> {
  const dirPath = relPath ? await safePath(rootReal, relPath) : rootReal;
  if (!dirPath) return null;

  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const result: FileEntry[] = [];

    const entryPromises = entries.map(async (entry) => {
      const fullPath = join(dirPath, entry.name);
      try {
        const st = await stat(fullPath);
        const rel = relative(rootReal, fullPath).replace(/\\/g, "/");
        const isDir = entry.isDirectory();
        const size = isDir ? await calcDirSize(fullPath) : st.size;
        return {
          name: entry.name,
          path: rel,
          isDir,
          size,
          mtime: st.mtime.toISOString(),
        };
      } catch {
        return null; // skip inaccessible entries
      }
    });

    const resolved = await Promise.all(entryPromises);
    for (const item of resolved) {
      if (item) result.push(item);
    }

    // Sort: directories first, then alphabetical
    result.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });

    return result;
  } catch {
    return null;
  }
}

// ── Serve file with Range support ──────────────────────
export async function serveFile(
  rootReal: string,
  relPath: string,
  request: Request
): Promise<Response> {
  const filePath = await safePath(rootReal, relPath);
  if (!filePath) {
    return new Response(JSON.stringify({ error: "Not found or access denied" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const st = await stat(filePath);
    if (st.isDirectory()) {
      return new Response(JSON.stringify({ error: "Is a directory" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const fileSize = st.size;
    const mime = getMime(filePath);
    const forceDownload = shouldForceDownload(request);
    const disposition = buildContentDisposition(filePath);
    const fileExt = extname(filePath).toLowerCase();

    // Social preview bots (Discord / Slack / X etc.) should receive HTML metadata
    // for download URLs so link unfurl works, while normal users still get binary.
    if (
      forceDownload &&
      request.method === "GET" &&
      !request.headers.get("Range") &&
      isSocialPreviewRequest(request)
    ) {
      const html = buildDownloadPreviewHtml(request, relPath, filePath);
      return new Response(html, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    // HLS playlist: rewrite relative URIs so Safari can fetch segments via /api/file
    if (fileExt === ".m3u8" || fileExt === ".m3u") {
      const playlist = await Bun.file(filePath).text();
      const rewritten = rewriteHlsPlaylist(playlist, relPath.replace(/\\/g, "/"));
      return new Response(rewritten, {
        status: 200,
        headers: {
          "Content-Type": mime,
          "Cache-Control": "no-store",
          "Content-Length": String(new TextEncoder().encode(rewritten).byteLength),
          "Accept-Ranges": "bytes",
        },
      });
    }

    // HEAD request
    if (request.method === "HEAD") {
      const headers: Record<string, string> = {
        "Content-Type": mime,
        "Content-Length": String(fileSize),
        "Accept-Ranges": "bytes",
      };
      if (forceDownload) {
        headers["Content-Disposition"] = disposition;
      }
      return new Response(null, {
        status: 200,
        headers,
      });
    }

    const rangeHeader = request.headers.get("Range");

    const parseRange = (header: string, totalSize: number): { start: number; end: number } | null => {
      // supports: bytes=START-END, bytes=START-, bytes=-SUFFIX
      const single = header.split(",")[0]?.trim() ?? header.trim();
      const m = single.match(/^bytes=(\d*)-(\d*)$/i);
      if (!m) return null;
      const rawStart = m[1];
      const rawEnd = m[2];

      if (!rawStart && !rawEnd) return null;

      if (!rawStart && rawEnd) {
        const suffixLen = parseInt(rawEnd, 10);
        if (!Number.isFinite(suffixLen) || suffixLen <= 0) return null;
        const end = totalSize - 1;
        const start = Math.max(0, totalSize - suffixLen);
        if (start > end) return null;
        return { start, end };
      }

      const start = parseInt(rawStart, 10);
      if (!Number.isFinite(start) || start < 0 || start >= totalSize) return null;

      const end = rawEnd ? parseInt(rawEnd, 10) : (totalSize - 1);
      if (!Number.isFinite(end) || end < start) return null;

      return { start, end: Math.min(end, totalSize - 1) };
    };

    // ── Range request (partial content) ──
    if (rangeHeader) {
      const parsed = parseRange(rangeHeader, fileSize);
      if (!parsed) {
        return new Response("Invalid Range", { status: 416 });
      }

      const { start, end } = parsed;

      if (start >= fileSize || end >= fileSize || start > end) {
        return new Response("Range Not Satisfiable", {
          status: 416,
          headers: { "Content-Range": `bytes */${fileSize}` },
        });
      }

      const chunkSize = end - start + 1;
      const file = Bun.file(filePath);
      const slice = file.slice(start, end + 1);

      return new Response(slice, {
        status: 206,
        headers: {
          "Content-Type": mime,
          "Content-Range": `bytes ${start}-${end}/${fileSize}`,
          "Content-Length": String(chunkSize),
          "Accept-Ranges": "bytes",
          ...(forceDownload ? { "Content-Disposition": disposition } : {}),
        },
      });
    }

    // ── Full file ──
    const file = Bun.file(filePath);
    return new Response(file, {
      status: 200,
      headers: {
        "Content-Type": mime,
        "Content-Length": String(fileSize),
        "Accept-Ranges": "bytes",
        ...(forceDownload ? { "Content-Disposition": disposition } : {}),
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Failed to read file" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
