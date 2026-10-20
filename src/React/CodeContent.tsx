import React, { useMemo } from "react";
import hljs from "highlight.js/lib/common";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import powershell from "highlight.js/lib/languages/powershell";
import latex from "highlight.js/lib/languages/latex";
hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("powershell", powershell);
hljs.registerLanguage("latex", latex);

const aliases: Record<string, string> = {
  ps1: "powershell",
  tex: "latex",
  properties: "ini",
  tsx: "typescript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  vue: "xml",
  svelte: "xml",
  svg: "xml",
  html: "xml",
  htm: "xml",
  jsonl: "json",
  yml: "yaml",
  sh: "bash",
  env: "ini",
  conf: "ini",
  cfg: "ini",
  toml: "ini",
  h: "c",
  hpp: "cpp",
  patch: "diff",
  dockerfile: "dockerfile",
  makefile: "makefile",
};

export function codeLanguage(name: string) {
  const extension = name.toLowerCase().split(".").pop() || "";
  const language = aliases[extension] || extension;
  return hljs.getLanguage(language) ? language : undefined;
}

export function CodeContent({
  text,
  language,
  className,
}: {
  text: string;
  language?: string;
  className?: string;
}) {
  const html = useMemo(() => {
    if (!language || !hljs.getLanguage(language)) return null;
    try {
      return hljs.highlight(text, { language, ignoreIllegals: true }).value;
    } catch {
      return null;
    }
  }, [text, language]);
  // Only highlight.js output is HTML; unknown languages remain escaped React text.
  return html === null ? (
    <code className={className}>{text}</code>
  ) : (
    <code
      className={`hljs ${className || ""}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
