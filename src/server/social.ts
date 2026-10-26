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
    canonical =
      origin +
      (/^\/(?:rankings|users(?:\/[^/]+)?)$/.test(url.pathname)
        ? url.pathname
        : "/"),
    image = origin + "/server.png",
    imageAlt = "PEXserver FileShare";
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
      : `${origin}/?item=${item.id}${url.searchParams.get("og") === "2" ? "&og=2" : ""}`;
    // OG media must be anonymous, fast and fetched without redirecting through
    // the signed edge-download URL. Non-images receive a branded PNG fallback.
    if (!item.folder) {
      image = `${origin}/og/image/${item.id}`;
      imageAlt = item.name;
    }
    // No MIME hint: a pending replica may return a branded PNG fallback.
  }
  const properties: Record<string, string> = {
    "og:site_name": "PEXserver FileShare",
    "og:locale": "ja_JP",
    "og:type": "website",
    "og:title": title,
    "og:description": description,
    "og:url": canonical,
    "og:image": image,
    "og:image:secure_url": image,
    "og:image:alt": imageAlt,
  };
  const names: Record<string, string> = {
    description,
    "twitter:card": item && canRead(store, null, item)
      ? "summary_large_image"
      : "summary",
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
