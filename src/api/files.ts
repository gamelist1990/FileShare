import { readdir, stat, realpath } from "node:fs/promises";
import { join, relative, extname, basename, dirname } from "node:path";

// ── Types ──────────────────────────────────────────────
export interface FileEntry {
  name: string;
  path: string; // relative to root
  isDir: boolean;
  size: number;
  mtime: string; // ISO string
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

function encodeRFC5987(value: string): string {
  return encodeURIComponent(value)
    .replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%(7C|60|5E)/g, "%25$1");
}

function isInlineSafeMime(mime: string): boolean {
  return (
    mime.startsWith("image/") ||
    mime.startsWith("video/") ||
    mime.startsWith("audio/") ||
    mime === "application/pdf" ||
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "application/javascript; charset=utf-8"
  );
}

function buildContentDisposition(filename: string, mode: "inline" | "attachment"): string {
  const safeAscii = filename.replace(/[\r\n"]/g, "_");
  const utf8 = encodeRFC5987(filename);
  return `${mode}; filename="${safeAscii}"; filename*=UTF-8''${utf8}`;
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
    const fileExt = extname(filePath).toLowerCase();
    const filename = basename(filePath);
    const reqUrl = new URL(request.url);
    const forceDownload = reqUrl.searchParams.get("download") === "1";
    const dispositionMode: "inline" | "attachment" = forceDownload
      ? "attachment"
      : (isInlineSafeMime(mime) ? "inline" : "attachment");
    const contentDisposition = buildContentDisposition(filename, dispositionMode);

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
          "Content-Disposition": contentDisposition,
        },
      });
    }

    // HEAD request
    if (request.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: {
          "Content-Type": mime,
          "Content-Length": String(fileSize),
          "Accept-Ranges": "bytes",
          "Content-Disposition": contentDisposition,
        },
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
          "Content-Disposition": contentDisposition,
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
        "Content-Disposition": contentDisposition,
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Failed to read file" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
