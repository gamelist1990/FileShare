import { openAsset } from "@pexserver/secure-envelope/asset";
import { secureApi } from "./secure-api";

async function start() {
  const metadata = await secureApi("/api/bootstrap");
  if (
    typeof metadata?.key !== "string" ||
    typeof metadata?.context !== "string"
  )
    throw new Error("起動情報が不正です");
  const [applicationResponse, styleResponse] = await Promise.all([
    fetch("/app.bin", { credentials: "same-origin", cache: "no-store" }),
    fetch("/style.bin", { credentials: "same-origin", cache: "no-store" }),
  ]);
  if (!applicationResponse.ok || !styleResponse.ok)
    throw new Error("アプリを取得できませんでした");
  const [source, style] = await Promise.all([
    openAsset(
      await applicationResponse.text(),
      metadata.key,
      metadata.context,
    ),
    openAsset(
      await styleResponse.text(),
      metadata.key,
      metadata.context + ":style",
    ),
  ]);
  const host = document.createElement("div");
  host.style.cssText = "display:block;max-width:100vw;overflow-x:clip";
  const shadow = host.attachShadow({
    mode:
      location.hostname === "localhost" || location.hostname === "127.0.0.1"
        ? "open"
        : "closed",
  });
  document.documentElement.style.background = "#f6f3ea";
  document.body.style.margin = "0";
  const styleUrl = URL.createObjectURL(new Blob([style], { type: "text/css" }));
  const sheet = document.createElement("link");
  sheet.rel = "stylesheet";
  sheet.href = styleUrl;
  const mount = document.createElement("div");
  const portal = document.createElement("div");
  shadow.append(sheet, mount, portal);
  document.body.append(host);
  await new Promise<void>((resolve, reject) => {
    sheet.addEventListener("load", () => resolve(), { once: true });
    sheet.addEventListener(
      "error",
      () => reject(new Error("表示設定を読み込めませんでした")),
      { once: true },
    );
  });
  URL.revokeObjectURL(styleUrl);
  (globalThis as any)[Symbol.for("pexserver.fileshare.dom.v1")] = {
    shadow,
    mount,
    portal,
  };
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
  document.body.textContent =
    error instanceof Error ? error.message : "FileShareを起動できませんでした";
});
