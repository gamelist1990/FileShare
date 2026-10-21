import { openAsset } from "@pexserver/secure-envelope/asset";
import { secureApi } from "./secure-api";

async function start() {
  const metadata = await secureApi("/api/bootstrap");
  if (
    typeof metadata?.key !== "string" ||
    typeof metadata?.context !== "string"
  )
    throw new Error("起動情報が不正です");
  const response = await fetch("/app.bin", {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) throw new Error("アプリを取得できませんでした");
  const source = await openAsset(
    await response.text(),
    metadata.key,
    metadata.context,
  );
  const url = URL.createObjectURL(
    new Blob([source], { type: "application/javascript" }),
  );
  try {
    await import(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

start().catch((error) => {
  const root = document.getElementById("root");
  if (root)
    root.textContent =
      error instanceof Error
        ? error.message
        : "FileShareを起動できませんでした";
});
