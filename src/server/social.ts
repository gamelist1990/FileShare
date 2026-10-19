import type { Store } from "./store";
import { canRead } from "./policy";

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const size = (bytes: number) =>
  bytes >= 1e9
    ? `${+(bytes / 1e9).toFixed(2)} GB`
    : bytes >= 1e6
      ? `${+(bytes / 1e6).toFixed(2)} MB`
      : bytes >= 1e3
        ? `${+(bytes / 1e3).toFixed(2)} KB`
        : `${bytes} B`;
/** SSR metadata must use anonymous permissions, even when the visitor is signed in.
 * Do not cache file metadata: expiry, parents and visibility can change immediately. */
export function socialHtml(store: Store, url: URL, template: string) {
  const origin = new URL(store.config.origin).origin;
  let title = "FileShare | PEXserver",
    description =
      "PEXserverの共有ストレージ。ファイルのプレビューとダウンロード。",
    canonical = origin + "/",
    image = origin + "/server.png",
    imageAlt = "PEXserver FileShare",
    imageType = "image/png",
    type = "website",
    video: { url: string; type: string } | null = null;
  const preview = /^\/files\/([a-f0-9-]{36})\/preview$/.exec(url.pathname);
  const id =
    preview?.[1] ??
    (["/", "/index.html"].includes(url.pathname)
      ? url.searchParams.get("item")
      : null);
  const item = id && /^[a-f0-9-]{36}$/.test(id) ? store.item(id) : null;
  if (item && canRead(store, null, item)) {
    title = `${item.name} | FileShare`;
    const author =
      store.filePolicy.showUploaders &&
      item.uploaded_by &&
      store.user(item.uploaded_by)?.status === "approved"
        ? item.uploader_name
        : null;
    description = item.folder
      ? `${item.name} — 共有フォルダ`
      : `${item.name}（${size(item.size)}）をプレビュー・ダウンロードできます。`;
    if (author) description += ` 投稿者: ${author}`;
    canonical = preview
      ? `${origin}/files/${item.id}/preview`
      : `${origin}/?item=${item.id}`;
    const ext = item.name.split(".").pop()?.toLowerCase() ?? "";
    const imageTypes: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      gif: "image/gif",
      avif: "image/avif",
    };
    if (!item.folder && imageTypes[ext] && item.size <= 8 * 1024 * 1024) {
      image = `${origin}/api/content/${item.id}`;
      imageAlt = item.name;
      imageType = imageTypes[ext];
    }
    if (!item.folder && ["mp4", "webm"].includes(ext)) {
      type = "video.other";
      video = {
        url: `${origin}/api/content/${item.id}`,
        type: ext === "mp4" ? "video/mp4" : "video/webm",
      };
    }
  }
  const properties: Record<string, string> = {
    "og:site_name": "PEXserver FileShare",
    "og:locale": "ja_JP",
    "og:type": type,
    "og:title": title,
    "og:description": description,
    "og:url": canonical,
    "og:image": image,
    "og:image:alt": imageAlt,
    "og:image:type": imageType,
  };
  if (video) {
    properties["og:video"] = video.url;
    properties["og:video:secure_url"] = video.url;
    properties["og:video:type"] = video.type;
  }
  const names: Record<string, string> = {
    description,
    "twitter:card": image.endsWith("/server.png")
      ? "summary"
      : "summary_large_image",
    "twitter:title": title,
    "twitter:description": description,
    "twitter:image": image,
    "twitter:image:alt": imageAlt,
  };
  const tags =
    Object.entries(properties)
      .map(([k, v]) => `<meta property="${k}" content="${escape(v)}">`)
      .join("") +
    Object.entries(names)
      .map(([k, v]) => `<meta name="${k}" content="${escape(v)}">`)
      .join("") +
    `<link rel="canonical" href="${escape(canonical)}">`;
  return template
    .replace(/<title>[^]*?<\/title>/i, () => `<title>${escape(title)}</title>`)
    .replace(/<meta\s+name="description"[^>]*>/i, "")
    .replace("</head>", () => tags + "</head>");
}
