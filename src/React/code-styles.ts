import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import darkPlus from "@shikijs/themes/dark-plus";

// TextMate grammars preserve language-specific scopes (types, calls, attributes, etc.).
const grammars = {
  csharp: () => import("@shikijs/langs/csharp"),
  javascript: () => import("@shikijs/langs/javascript"),
  typescript: () => import("@shikijs/langs/typescript"),
  tsx: () => import("@shikijs/langs/tsx"),
  jsx: () => import("@shikijs/langs/jsx"),
  python: () => import("@shikijs/langs/python"),
  java: () => import("@shikijs/langs/java"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  rust: () => import("@shikijs/langs/rust"),
  go: () => import("@shikijs/langs/go"),
  html: () => import("@shikijs/langs/html"),
  css: () => import("@shikijs/langs/css"),
  json: () => import("@shikijs/langs/json"),
  yaml: () => import("@shikijs/langs/yaml"),
  sql: () => import("@shikijs/langs/sql"),
  bash: () => import("@shikijs/langs/bash"),
};
const aliases: Record<string, string> = {
  cs: "csharp",
  "c#": "csharp",
  js: "javascript",
  ts: "typescript",
  py: "python",
  kt: "kotlin",
  rs: "rust",
  sh: "bash",
  yml: "yaml",
};
let highlighter: ReturnType<typeof createHighlighterCore> | undefined;
const loaded = new Map<string, Promise<void>>();
export async function styledTokens(text: string, language: string) {
  const lang = aliases[language.toLowerCase()] || language.toLowerCase();
  if (!(lang in grammars)) return null;
  const instance = await (highlighter ??= createHighlighterCore({
    themes: [darkPlus],
    langs: [],
    engine: createJavaScriptRegexEngine(),
  }));
  let loading = loaded.get(lang);
  if (!loading) {
    loading = grammars[lang as keyof typeof grammars]().then((module) =>
      instance.loadLanguage(module.default),
    );
    loaded.set(lang, loading);
    loading.catch(() => loaded.delete(lang));
  }
  await loading;
  return instance.codeToTokens(text, { lang, theme: "dark-plus" }).tokens;
}
