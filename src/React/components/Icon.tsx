import React from "react";

// ── Font Awesome Icon helper ───────────────────────────
export function Icon({ name, style, className }: { name: string; style?: React.CSSProperties; className?: string }) {
  return <i className={`${name}${className ? ` ${className}` : ""}`} style={style} aria-hidden="true" />;
}
