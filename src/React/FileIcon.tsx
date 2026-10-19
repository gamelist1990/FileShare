import React from "react";
const code: Record<string, string> = {
  ts: "TS",
  tsx: "TSX",
  js: "JS",
  jsx: "JSX",
  py: "PY",
  rs: "RS",
  go: "GO",
  java: "JAVA",
  c: "C",
  cpp: "C++",
  h: "H",
  cs: "C#",
  json: "JSON",
  yml: "YML",
  yaml: "YAML",
  html: "HTML",
  css: "CSS",
  sh: "SH",
  sql: "SQL",
  md: "MD",
};
export function FileIcon({
  name = "",
  folder = false,
}: {
  name?: string;
  folder?: boolean;
}) {
  const ext = name.split(".").at(-1)?.toLowerCase() ?? "";
  const kind = folder
    ? "folder"
    : code[ext]
      ? "code"
      : /^(mp4|webm|mov|mkv|avi|m4v)$/.test(ext)
        ? "video"
        : /^(mp3|wav|ogg|flac|m4a)$/.test(ext)
          ? "audio"
          : /^(png|jpe?g|webp|gif|svg|avif)$/.test(ext)
            ? "image"
            : /^(zip|rar|7z|gz|tar|bz2)$/.test(ext)
              ? "archive"
              : ext === "pdf"
                ? "pdf"
                : "document";
  return (
    <span aria-hidden="true" className={`file-icon kind-${kind} ext-${ext}`}>
      <svg viewBox="0 0 32 36" fill="none">
        {folder ? (
          <>
            <path
              d="M2 9a3 3 0 0 1 3-3h8l3 4h11a3 3 0 0 1 3 3v16H2V9Z"
              fill="currentColor"
              opacity=".3"
            />
            <path d="M2 15h28l-3 15H3L2 15Z" fill="currentColor" />
            <path d="M6 20h17" stroke="white" strokeWidth="1.5" opacity=".6" />
          </>
        ) : (
          <>
            <path
              d="M6 2h13l7 7v24H6V2Z"
              fill="currentColor"
              opacity=".12"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <path d="M19 2v8h7" stroke="currentColor" strokeWidth="1.5" />
            {kind === "video" ? (
              <>
                <rect
                  x="9"
                  y="15"
                  width="14"
                  height="11"
                  rx="2"
                  fill="currentColor"
                />
                <path d="m14 18 5 3-5 3v-6Z" fill="white" />
              </>
            ) : kind === "audio" ? (
              <>
                <path
                  d="M13 25V15l9-2v10M13 18l9-2"
                  stroke="currentColor"
                  strokeWidth="2"
                />
                <ellipse cx="10" cy="26" rx="3" ry="2" fill="currentColor" />
                <ellipse cx="19" cy="24" rx="3" ry="2" fill="currentColor" />
              </>
            ) : kind === "image" ? (
              <>
                <rect
                  x="9"
                  y="15"
                  width="14"
                  height="12"
                  rx="1"
                  stroke="currentColor"
                />
                <circle cx="19" cy="18" r="2" fill="currentColor" />
                <path
                  d="m10 25 5-5 7 6"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
              </>
            ) : kind === "archive" ? (
              <path
                d="M15 11h4v3h-4v3h4v3h-4v6h5v-4h-5"
                stroke="currentColor"
                strokeWidth="1.5"
              />
            ) : (
              <>
                <rect
                  x="3"
                  y="17"
                  width="26"
                  height="13"
                  rx="2"
                  fill="currentColor"
                />
                <text
                  x="16"
                  y="26"
                  textAnchor="middle"
                  fill="white"
                  fontSize={(code[ext] ?? ext).length > 3 ? 6 : 8}
                  fontWeight="700"
                  fontFamily="system-ui,sans-serif"
                >
                  {code[ext] ??
                    (kind === "pdf"
                      ? "PDF"
                      : ext.slice(0, 4).toUpperCase() || "FILE")}
                </text>
              </>
            )}
          </>
        )}
      </svg>
    </span>
  );
}
