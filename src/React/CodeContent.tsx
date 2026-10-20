import React, { useMemo, useState, useEffect } from "react";
import { styledTokens } from "./code-styles";
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
  tsx: "tsx",
  jsx: "jsx",
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
  return language === "tsx" || language === "jsx" || hljs.getLanguage(language)
    ? language
    : undefined;
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
  const [styled, setStyled] = useState<{
    text: string;
    language: string;
    tokens: NonNullable<Awaited<ReturnType<typeof styledTokens>>>;
  } | null>(null);
  useEffect(() => {
    let active = true;
    if (language)
      styledTokens(text, language)
        .then((tokens) => {
          if (active && tokens) setStyled({ text, language, tokens });
        })
        .catch(() => {
          /* The synchronous highlighter remains available. */
        });
    return () => {
      active = false;
    };
  }, [text, language]);
  const html = useMemo(() => {
    if (!language || !hljs.getLanguage(language)) return null;
    try {
      return hljs.highlight(text, { language, ignoreIllegals: true }).value;
    } catch {
      return null;
    }
  }, [text, language]);
  if (styled && styled.text === text && styled.language === language) {
    return (
      <code
        className={`syntax-code language-${language} ${className || ""}`}
        data-language={language}
      >
        {styled.tokens.map((line, row) => (
          <React.Fragment key={row}>
            {row > 0 && "\n"}
            {line.map((token, column) => (
              <span
                key={column}
                style={{
                  color: token.color,
                  fontStyle:
                    token.fontStyle && token.fontStyle & 1
                      ? "italic"
                      : undefined,
                  fontWeight:
                    token.fontStyle && token.fontStyle & 2 ? "bold" : undefined,
                  textDecoration:
                    token.fontStyle && token.fontStyle & 4
                      ? "underline"
                      : undefined,
                }}
              >
                {token.content}
              </span>
            ))}
          </React.Fragment>
        ))}
      </code>
    );
  }
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
