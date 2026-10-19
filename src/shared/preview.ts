export function previewKind(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (/^(png|jpe?g|gif|webp|avif|bmp|ico)$/.test(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (/^(mp4|webm|mov|mkv|avi|m4v)$/.test(ext)) return "video";
  if (/^(mp3|ogg|wav|m4a|flac)$/.test(ext)) return "audio";
  if (/^(md|markdown|mdown)$/.test(ext)) return "markdown";
  if (
    /^(txt|log|csv|tsv|json|jsonl|yaml|yml|toml|ini|conf|cfg|xml|html?|svg|css|scss|less|js|jsx|mjs|cjs|ts|tsx|py|rb|rs|go|java|kt|kts|c|h|cpp|hpp|cs|sh|bash|ps1|sql|vue|svelte|lua|r|tex|diff|patch|properties|env)$/.test(
      ext,
    ) ||
    /^(dockerfile|makefile|license|readme|gitignore)$/i.test(name)
  )
    return "text";
  return "unsupported";
}
