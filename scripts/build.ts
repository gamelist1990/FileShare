/**
 * Build script for FileShare.
 * Run with: bun scripts/build.ts
 *
 * Steps:
 *   1. Bundle React SPA → in-memory JS string
 *   2. Generate src/generated/assets.ts (embedded HTML + JS)
 *   3. (Optional) Compile server to standalone exe
 *
 * Usage:
 *   bun scripts/build.ts          → build UI only (dev)
 *   bun scripts/build.ts --exe    → build UI + compile exe
 */

import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const doExe = process.argv.includes("--exe");

console.log("📦 Step 1: Building React SPA...");

const uiResult = await Bun.build({
  entrypoints: ["src/React/index.tsx"],
  minify: true,
  target: "browser",
  define: {
    "process.env.NODE_ENV": '"production"',
  },
});

if (!uiResult.success) {
  console.error("❌ React build failed:");
  for (const log of uiResult.logs) console.error(log);
  process.exit(1);
}

// Get the bundled JS as a string
const bundledJs = await uiResult.outputs[0].text();
console.log(`   ✅ React bundle: ${(bundledJs.length / 1024).toFixed(1)} KB`);

console.log("📝 Step 2: Generating embedded assets...");

// Read and embed favicon SVG
const faviconSvg = await readFile(resolve("src", "favicon.svg"), "utf-8");
const faviconDataUri = `data:image/svg+xml,${encodeURIComponent(faviconSvg.trim())}`;

const indexHtml = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <title>FileShare</title>
  <link rel="icon" type="image/svg+xml" href="${faviconDataUri}" />
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css" integrity="sha512-DTOQO9RWCH3ppGqcWaEA1BIZOC6xxalwEsw9c2QQeAIftl+Vegovlnee1c9QX4TctnWMn13TZye+giMm8e2LwA==" crossorigin="anonymous" referrerpolicy="no-referrer" />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; padding: 0; background: #fafbfc; font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
    #root { min-height: 100vh; }
    @media (max-width: 768px) {
      .fs-desktop-only { display: none !important; }
      .fs-mobile-only { display: flex !important; }
      .fs-header-inner { flex-direction: column !important; align-items: flex-start !important; gap: 8px !important; }
      .fs-header-right { width: 100% !important; justify-content: flex-end !important; }
      .fs-nav { flex-wrap: wrap !important; gap: 6px !important; }
      .fs-breadcrumb { width: 100% !important; margin-left: 0 !important; overflow-x: auto !important; white-space: nowrap !important; padding: 4px 0 !important; }
      .fs-file-table { display: block !important; }
      .fs-file-table thead { display: none !important; }
      .fs-file-table tbody { display: flex !important; flex-direction: column !important; gap: 6px !important; }
      .fs-file-table tr { display: grid !important; grid-template-columns: 40px 1fr auto !important; grid-template-rows: auto auto !important; gap: 2px 8px !important; padding: 10px 12px !important; border: 1px solid #e8e8e8 !important; border-radius: 10px !important; background: #fff !important; align-items: center !important; border-bottom: none !important; }
      .fs-file-table tr:hover { background: #f0f4ff !important; }
      .fs-icon-cell { grid-row: 1 / 3 !important; display: flex !important; align-items: center !important; justify-content: center !important; padding: 0 !important; }
      .fs-name-cell { grid-column: 2 !important; grid-row: 1 !important; padding: 0 !important; font-size: 14px !important; }
      .fs-size-cell { grid-column: 2 !important; grid-row: 2 !important; padding: 0 !important; text-align: left !important; font-size: 12px !important; }
      .fs-date-cell { display: none !important; }
      .fs-dl-cell { display: none !important; }
      .fs-action-cell { grid-column: 3 !important; grid-row: 1 / 3 !important; display: flex !important; align-items: center !important; padding: 0 !important; }
      .fs-drop-zone { padding: 16px 12px !important; }
      .fs-drop-icon { font-size: 24px !important; }
      .fs-modal-container { max-width: 98vw !important; max-height: 96vh !important; border-radius: 8px !important; }
      .fs-modal-video { max-width: 96vw !important; max-height: 70vh !important; }
      .fs-modal-image { max-width: 96vw !important; max-height: 70vh !important; }
      .fs-modal-audio-wrapper { padding: 32px 24px !important; }
      .fs-disk-free-label { display: none !important; }
      .fs-title { font-size: 22px !important; }
      .fs-md-modal-container { width: 100vw !important; max-width: 100vw !important; height: 100vh !important; height: 100dvh !important; max-height: 100vh !important; max-height: 100dvh !important; border-radius: 0 !important; }
      .fs-md-modal-container > div:first-child { padding-top: env(safe-area-inset-top, 0px) !important; }
      .fs-md-modal-container > div:nth-child(2) { padding: 16px !important; }
      .fs-md-modal-container > div:last-child { padding-bottom: env(safe-area-inset-bottom, 0px) !important; }
      .fs-modal-container > div:first-child { padding-top: env(safe-area-inset-top, 0px) !important; }
    }
    @media (min-width: 769px) {
      .fs-mobile-only { display: none !important; }
    }
  </style>
</head>
<body>
  <div id="root"></div>
  <script src="/index.js"></script>
</body>
</html>`;

// Escape backticks and $ in the JS for template literal embedding
const escapedJs = bundledJs.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$");

const assetsModule = `// ⚠️ AUTO-GENERATED — do not edit manually.
// Generated by scripts/build.ts at ${new Date().toISOString()}

/** The HTML shell (index.html) for the SPA */
export const INDEX_HTML = \`${indexHtml.replace(/`/g, "\\`").replace(/\$/g, "\\$")}\`;

/** The bundled React app JS */
export const INDEX_JS = \`${escapedJs}\`;
`;

const generatedDir = resolve("src", "generated");
await mkdir(generatedDir, { recursive: true });
await Bun.write(resolve(generatedDir, "assets.ts"), assetsModule);
console.log("   ✅ src/generated/assets.ts written");

// Also write to public/ for dev-mode filesystem fallback
await mkdir("public", { recursive: true });
await Bun.write("public/index.html", indexHtml);
await Bun.write("public/index.js", bundledJs);
console.log("   ✅ public/ updated (dev fallback)");

if (doExe) {
  console.log("🔨 Step 3: Compiling standalone exe...");

  const exeResult = await Bun.build({
    entrypoints: ["src/index.ts"],
    target: "bun",
    minify: true,
  });

  if (!exeResult.success) {
    console.error("❌ Exe compile failed:");
    for (const log of exeResult.logs) console.error(log);
    process.exit(1);
  }

  // Write the bundled server JS, then compile with bun
  await Bun.write("dist/server.js", exeResult.outputs[0]);
  console.log("   ✅ dist/server.js written");
  console.log("   📌 Now run: bun build --compile dist/server.js --outfile FileShare.exe");
} else {
  console.log("\n✅ Build complete! Run server with:");
  console.log('   bun src/index.ts --path "共有ディレクトリ"');
  console.log("\n   To also compile exe, run:");
  console.log("   bun scripts/build.ts --exe");
}
export { };

