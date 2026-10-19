/** Only likely-compressible formats; video/images/archives remain byte-for-byte on the wire. */
export function compressibleName(name: string) {
  return /\.(?:txt|log|csv|tsv|json|jsonl|ndjson|xml|html?|svg|css|[cm]?js|jsx|tsx?|md|markdown|ya?ml|toml|ini|conf|sql|py|sh|tex|rst|map)$/i.test(
    name,
  );
}
export function acceptsGzip(header: string | undefined) {
  if (!header) return false;
  let wildcard = 0;
  for (const entry of header.toLowerCase().split(",")) {
    const [name, ...parameters] = entry.trim().split(";");
    const q = parameters.find((p) => p.trim().startsWith("q="));
    const quality = q ? Number(q.trim().slice(2)) : 1;
    const accepted = Number.isFinite(quality) && quality > 0 && quality <= 1;
    if (name.trim() === "gzip") return accepted;
    if (name.trim() === "*") wildcard = accepted ? 1 : 0;
  }
  return wildcard > 0;
}
