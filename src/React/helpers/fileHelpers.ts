import type { FileEntry } from "../types";

// ── Extension Sets ─────────────────────────────────────
export const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "mkv", "avi", "m4v", "ogv"]);
export const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "flac", "m4a", "aac", "wma"]);
export const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico"]);
export const MD_EXTS = new Set(["md", "markdown", "mdown", "mkd"]);

// ── Helpers ────────────────────────────────────────────
export function getExt(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

export function isVideo(entry: FileEntry): boolean {
  return VIDEO_EXTS.has(getExt(entry.name));
}

export function isAudio(entry: FileEntry): boolean {
  return AUDIO_EXTS.has(getExt(entry.name));
}

export function isImage(entry: FileEntry): boolean {
  return IMAGE_EXTS.has(getExt(entry.name));
}

export function isMarkdown(entry: FileEntry): boolean {
  return MD_EXTS.has(getExt(entry.name));
}

export function isPreviewable(entry: FileEntry): boolean {
  return !entry.isDir && (isVideo(entry) || isAudio(entry) || isImage(entry) || isMarkdown(entry));
}

export function formatSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function getFileIconClass(entry: FileEntry): string {
  if (entry.isDir) return "fa-solid fa-folder";
  const ext = getExt(entry.name);
  const map: Record<string, string> = {
    mp4: "fa-solid fa-film", mkv: "fa-solid fa-film", avi: "fa-solid fa-film",
    mov: "fa-solid fa-film", webm: "fa-solid fa-film", ts: "fa-solid fa-film",
    m4v: "fa-solid fa-film", ogv: "fa-solid fa-film",
    mp3: "fa-solid fa-music", wav: "fa-solid fa-music", ogg: "fa-solid fa-music",
    flac: "fa-solid fa-music", m4a: "fa-solid fa-music", aac: "fa-solid fa-music",
    wma: "fa-solid fa-music",
    jpg: "fa-solid fa-image", jpeg: "fa-solid fa-image", png: "fa-solid fa-image",
    gif: "fa-solid fa-image", webp: "fa-solid fa-image", svg: "fa-solid fa-image",
    bmp: "fa-solid fa-image", ico: "fa-solid fa-image",
    pdf: "fa-solid fa-file-pdf", doc: "fa-solid fa-file-word", docx: "fa-solid fa-file-word",
    txt: "fa-solid fa-file-lines", md: "fa-solid fa-file-lines",
    zip: "fa-solid fa-file-zipper", rar: "fa-solid fa-file-zipper",
    "7z": "fa-solid fa-file-zipper", tar: "fa-solid fa-file-zipper",
    gz: "fa-solid fa-file-zipper",
    exe: "fa-solid fa-gear", msi: "fa-solid fa-gear",
    xls: "fa-solid fa-file-excel", xlsx: "fa-solid fa-file-excel",
    ppt: "fa-solid fa-file-powerpoint", pptx: "fa-solid fa-file-powerpoint",
    json: "fa-solid fa-file-code", js: "fa-solid fa-file-code", css: "fa-solid fa-file-code",
    html: "fa-solid fa-file-code", xml: "fa-solid fa-file-code",
  };
  return map[ext] || "fa-solid fa-file";
}

export function getFileIconColor(entry: FileEntry): string {
  if (entry.isDir) return "#f0b429";
  const ext = getExt(entry.name);
  if (VIDEO_EXTS.has(ext)) return "#e74c3c";
  if (AUDIO_EXTS.has(ext)) return "#9b59b6";
  if (IMAGE_EXTS.has(ext)) return "#27ae60";
  if (["pdf"].includes(ext)) return "#c0392b";
  if (["doc", "docx"].includes(ext)) return "#2980b9";
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return "#e67e22";
  if (["exe", "msi"].includes(ext)) return "#7f8c8d";
  return "#95a5a6";
}

export function fileUrl(entry: FileEntry): string {
  return `/api/file?path=${encodeURIComponent(entry.path)}`;
}
