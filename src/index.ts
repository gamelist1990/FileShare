import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { listDirectory, serveFile } from "./api/files";
import {
  register, login, logout, verifyToken, getAuthStatus, getClientIp,
  approveUser, denyUser, clearPending, listPendingUsers, listAllUsers,
  resetAll, resetPassword, resetUsername, initAuth, flushSave,
  deleteUser, setOpLevel, getOpLevel,
  addBlockPath, removeBlockPath, listBlockedPaths, isPathBlocked,
} from "./api/auth";
import { handleUpload, handleMkdir, getDiskInfo } from "./api/upload";
import { handleRename, handleDelete } from "./api/fileops";
import { INDEX_HTML, INDEX_JS } from "./generated/assets";
import {
  recordDownload, recordUpload, connectionStart, connectionEnd,
  getServerStatus, printStatus,
} from "./api/stats";
import { initSettings } from "./api/settings";
import { checkIpRateLimit, registerRateLimitSettings } from "./api/rateLimit";
import { isHAProxyProxyProtocolV2Enabled, registerHAProxySettings } from "./api/haproxy";
import { CURRENT_FILESHARE_VERSION } from "./version";
import { startHAProxyBridge } from "./api/haproxyBridge";

// ── CLI: parse --path argument ─────────────────────────
function parseArgs(): { sharePath: string; port: number } {
  const args = process.argv.slice(2);
  let sharePath = process.cwd();
  let port = 3000;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--path" && args[i + 1]) {
      sharePath = args[++i];
    } else if (args[i] === "--port" && args[i + 1]) {
      port = parseInt(args[++i], 10);
    }
  }

  return { sharePath: resolve(sharePath), port };
}

// ── CORS headers ───────────────────────────────────────
function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Range, Authorization",
    "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
  };
}

function jsonRes(status: number, data: unknown, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(), ...(extraHeaders ?? {}) },
  });
}

// ── Serve embedded SPA assets (exe-safe) ───────────────
function serveEmbeddedHtml(): Response {
  return new Response(INDEX_HTML, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function serveEmbeddedJs(): Response {
  return new Response(INDEX_JS, {
    headers: { "Content-Type": "application/javascript; charset=utf-8" },
  });
}

// ── Shared state for CLI (set in main, used by CLI) ────
let port = 3000;
let rootReal = "";

// ── Console admin CLI (stdin) ──────────────────────────
function startConsoleCLI() {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "",
  });

  console.log("─── 管理コンソール ───────────────────");
  console.log("  allow <username>                  … ユーザーを承認");
  console.log("  deny <username>                   … ユーザーを拒否");
  console.log("  clear                             … 全ての承認待ちを削除");
  console.log("  reset                             … 全ユーザー初期化");
  console.log("  user reset password <user> <pass> … パスワード変更");
  console.log("  user reset username <old> <new>   … ユーザー名変更");
  console.log("  user delete <username>            … ユーザー削除");
  console.log("  user op <username> <1|2>          … 権限レベル設定");
  console.log("  users                             … 全ユーザー一覧");
  console.log("  pending                           … 承認待ちユーザー一覧");
  console.log("  block <path>                      … パスをブロック");
  console.log("  unblock <path>                    … ブロック解除");
  console.log("  blocks                            … ブロックリスト表示");
  console.log("  status                            … サーバーステータス表示");
  console.log("  reload                            … 設定を再読み込みして最新の設定を反映");
  console.log("  help                              … コマンド一覧");
  console.log("──────────────────────────────────────\n");

  rl.on("line", (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toLowerCase();

    // ── Multi-word commands: "user reset ...", "user delete ...", "user op ..." ──
    if (cmd === "user" && parts[1]?.toLowerCase() === "reset") {
      const subCmd = parts[2]?.toLowerCase();
      if (subCmd === "password") {
        const username = parts[3] ?? "";
        const newPass = parts[4] ?? "";
        if (!username || !newPass) {
          console.log("⚠️  使い方: user reset password <username> <newpassword>");
          return;
        }
        if (resetPassword(username, newPass)) {
          console.log(`🔑 ユーザー「${username}」のパスワードを変更しました`);
        } else {
          console.log(`❌ 変更失敗: ユーザー「${username}」が見つからない、またはパスワードが4文字未満`);
        }
        return;
      }
      if (subCmd === "username") {
        const oldName = parts[3] ?? "";
        const newName = parts[4] ?? "";
        if (!oldName || !newName) {
          console.log("⚠️  使い方: user reset username <oldname> <newname>");
          return;
        }
        if (resetUsername(oldName, newName)) {
          console.log(`📝 ユーザー名を「${oldName}」→「${newName}」に変更しました`);
        } else {
          console.log(`❌ 変更失敗: ユーザーが見つからない、新名が無効、または既に使用中`);
        }
        return;
      }
      console.log("⚠️  使い方: user reset password|username <...>");
      return;
    }

    // ── user delete <username> ──
    if (cmd === "user" && parts[1]?.toLowerCase() === "delete") {
      const username = parts[2] ?? "";
      if (!username) {
        console.log("⚠️  使い方: user delete <username>");
        return;
      }
      if (deleteUser(username)) {
        console.log(`🗑️  ユーザー「${username}」を削除しました`);
      } else {
        console.log(`❌ ユーザー「${username}」が見つかりません`);
      }
      return;
    }

    // ── user op <username> <level> ──
    if (cmd === "user" && parts[1]?.toLowerCase() === "op") {
      const username = parts[2] ?? "";
      const level = parseInt(parts[3] ?? "", 10);
      if (!username || isNaN(level)) {
        console.log("⚠️  使い方: user op <username> <1|2>");
        console.log("   1 = 通常ユーザー  2 = 上級権限 (ファイル削除等)");
        return;
      }
      if (setOpLevel(username, level)) {
        console.log(`🔧 ユーザー「${username}」の権限レベルを ${level} に設定しました`);
      } else {
        console.log(`❌ 設定失敗: ユーザーが見つからない、またはレベルが無効 (1 or 2)`);
      }
      return;
    }

    const arg = parts[1] ?? "";

    switch (cmd) {
      case "allow": {
        if (!arg) {
          console.log("⚠️  使い方: allow <username>");
          break;
        }
        if (approveUser(arg)) {
          console.log(`✅ ユーザー「${arg}」を承認しました`);
        } else {
          console.log(`❌ ユーザー「${arg}」が見つかりません`);
        }
        break;
      }
      case "deny": {
        if (!arg) {
          console.log("⚠️  使い方: deny <username>");
          break;
        }
        if (denyUser(arg)) {
          console.log(`🚫 ユーザー「${arg}」を拒否しました`);
        } else {
          console.log(`❌ ユーザー「${arg}」が見つかりません`);
        }
        break;
      }
      case "clear": {
        const count = clearPending();
        console.log(`🗑️  承認待ち ${count} 件をクリアしました`);
        break;
      }
      case "reset": {
        const count = resetAll();
        console.log(`⚠️  全ユーザー ${count} 件を初期化しました（セッション・IP紐付けもクリア）`);
        break;
      }
      case "users": {
        const all = listAllUsers();
        if (all.length === 0) {
          console.log("（ユーザーなし）");
        } else {
          console.log(`\n👥 全ユーザー (${all.length} 件):`);
          for (const u of all) {
            const status =
              u.status === "approved" ? "✅" :
              u.status === "pending" ? "⏳" : "🚫";
            const opLabel = u.oplevel === 2 ? " [OP:2]" : "";
            console.log(`  ${status} ${u.username}  ID:${u.id}  IP:${u.ip}  ${u.status}${opLabel}  ${u.createdAt}`);
          }
          console.log("");
        }
        break;
      }
      case "pending": {
        const pending = listPendingUsers();
        if (pending.length === 0) {
          console.log("（承認待ちのユーザーはいません）");
        } else {
          console.log(`\n⏳ 承認待ち (${pending.length} 件):`);
          for (const u of pending) {
            console.log(`  → ${u.username}  IP:${u.ip}  ${u.createdAt}`);
            console.log(`    allow ${u.username} / deny ${u.username}`);
          }
          console.log("");
        }
        break;
      }
      case "status": {
        printStatus(port, rootReal);
        break;
      }
      case "reload": {
        // Re-read settings.json so runtime uses the latest configuration
        initSettings(rootReal);
        console.log("⚙️  設定をリロードしました");
        break;
      }
      case "block": {
        // Support paths with spaces: rejoin everything after "block"
        const blockPath = trimmed.replace(/^block\s+/i, "").replace(/^"|"$/g, "").trim();
        if (!blockPath) {
          console.log("⚠️  使い方: block <path>");
          console.log('   例: block "D:\\動画\\ミーム素材"');
          break;
        }
        if (addBlockPath(blockPath)) {
          console.log(`🚫 ブロック追加: ${blockPath}`);
        } else {
          console.log(`⚠️  既にブロック済み、またはパスが無効です`);
        }
        break;
      }
      case "unblock": {
        const unblockPath = trimmed.replace(/^unblock\s+/i, "").replace(/^"|"$/g, "").trim();
        if (!unblockPath) {
          console.log("⚠️  使い方: unblock <path>");
          break;
        }
        if (removeBlockPath(unblockPath)) {
          console.log(`✅ ブロック解除: ${unblockPath}`);
        } else {
          console.log(`❌ ブロックリストに見つかりません`);
        }
        break;
      }
      case "blocks": {
        const blist = listBlockedPaths();
        if (blist.length === 0) {
          console.log("（ブロックなし）");
        } else {
          console.log(`\n🚫 ブロックリスト (${blist.length} 件):`);
          for (const p of blist) {
            console.log(`  → ${p}`);
          }
          console.log("");
        }
        break;
      }
      case "help": {
        console.log("\n  allow <username>                  … ユーザーを承認");
        console.log("  deny <username>                   … ユーザーを拒否");
        console.log("  clear                             … 全ての承認待ちを削除");
        console.log("  reset                             … 全ユーザー初期化");
        console.log("  user reset password <user> <pass> … パスワード変更");
        console.log("  user reset username <old> <new>   … ユーザー名変更");
        console.log("  user delete <username>            … ユーザー削除");
        console.log("  user op <username> <1|2>          … 権限レベル設定");
        console.log("  users                             … 全ユーザー一覧");
        console.log("  pending                           … 承認待ちユーザー一覧");
        console.log("  block <path>                      … パスをブロック");
        console.log("  unblock <path>                    … ブロック解除");
        console.log("  blocks                            … ブロックリスト表示");
        console.log("  status                            … サーバーステータス表示");
        console.log("  reload                            … 設定を再読み込みして最新の設定を反映\n");
        break;
      }
      default:
        console.log(`⚠️  不明なコマンド: ${cmd} (helpでコマンド一覧を表示)`);
    }
  });
}

// ── Main ───────────────────────────────────────────────
async function main() {
  const args = parseArgs();
  port = args.port;

  // Validate share path exists
  if (!existsSync(args.sharePath)) {
    console.error(`Error: Path does not exist: ${args.sharePath}`);
    process.exit(1);
  }

  rootReal = await realpath(args.sharePath);
  console.log(`📂 Sharing: ${rootReal}`);

  // Load persisted user data
  initAuth(rootReal);

  // Register + load settings modules
  registerRateLimitSettings();
  registerHAProxySettings();
  initSettings(rootReal);

  const haproxyEnabled = isHAProxyProxyProtocolV2Enabled();
  const internalPort = haproxyEnabled ? (port + 1) : port;

  if (haproxyEnabled) {
    console.log(`🌐 Starting internal server on http://127.0.0.1:${internalPort} (HAProxy bridge mode)`);
  } else {
    console.log(`🌐 Starting server on http://0.0.0.0:${port}`);
  }

  // Get local IP for LAN access info
  try {
    const os = await import("node:os");
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] ?? []) {
        if (net.family === "IPv4" && !net.internal) {
          console.log(`📡 LAN access: http://${net.address}:${port}`);
        }
      }
    }
  } catch { /* ignore */ }

  let server;
  try {
    server = Bun.serve({
      port: internalPort,
      hostname: haproxyEnabled ? "127.0.0.1" : "0.0.0.0",
      idleTimeout: 120,

      async fetch(request: Request, server: any): Promise<Response> {
      let url: URL;
      try {
        url = new URL(request.url);
      } catch (err) {
        console.error("Invalid URL:", request.url, err);
        return jsonRes(400, { error: "Invalid request URL" });
      }
      const pathname = decodeURIComponent(url.pathname);
      const clientIp = getClientIp(request, server);

      connectionStart();

      try {
        // CORS preflight
        if (request.method === "OPTIONS") {
          return new Response(null, { status: 204, headers: corsHeaders() });
        }

        // ── Public API routes ──

        if (pathname === "/api/health") {
          return jsonRes(200, { status: "ok", sharing: rootReal, version: CURRENT_FILESHARE_VERSION });
        }

        // ── Speed test endpoints (client network measurement) ──
        if (pathname === "/api/speedtest/download") {
          try {
            const sizeParam = parseInt(url.searchParams.get("size") ?? "0", 10);
            const size = Number.isFinite(sizeParam) && sizeParam > 0
              ? Math.min(sizeParam, 4 * 1024 * 1024) // cap at 4MB (WAN-safe)
              : 1024 * 1024; // default 1MB

            // Fixed-length payload (no chunked transfer) for proxy compatibility.
            const payload = new Uint8Array(size);
            for (let i = 0; i < size; i++) {
              payload[i] = i % 251;
            }

            const headers = new Headers({
              "Content-Type": "application/octet-stream",
              "Content-Length": String(size),
              "Content-Encoding": "identity",
              "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
              Pragma: "no-cache",
              Expires: "0",
            });
            for (const [k, v] of Object.entries(corsHeaders())) {
              headers.set(k, v);
            }
            return new Response(payload, { status: 200, headers });
          } catch (err: any) {
            return jsonRes(500, { error: "speedtest download failed", detail: String(err?.message ?? err) });
          }
        }

        if (pathname === "/api/speedtest/upload" && request.method === "POST") {
          try {
            const start = Date.now();
            const body = await request.arrayBuffer();
            const elapsedMs = Math.max(1, Date.now() - start);
            const receivedBytes = body.byteLength;
            return jsonRes(200, {
              ok: true,
              receivedBytes,
              elapsedMs,
            });
          } catch (err: any) {
            return jsonRes(500, { error: "speedtest upload failed", detail: String(err?.message ?? err) });
          }
        }

        // ── Status API (for client Status modal) ──
        if (pathname === "/api/status") {
          const rl = checkIpRateLimit("status", clientIp);
          if (!rl.allowed) {
            return jsonRes(429, {
              error: "ステータスのレート制限に達しました",
              target: "status",
              retryAfterSec: rl.retryAfterSec ?? 1,
            }, {
              "Retry-After": String(rl.retryAfterSec ?? 1),
            });
          }

          const status = getServerStatus();
          const diskInfo = getDiskInfo(rootReal);
          return jsonRes(200, {
            ...status,
            disk: diskInfo,
            port,
            sharePath: rootReal,
          });
        }

        if (pathname === "/api/list") {
          const rl = checkIpRateLimit("list", clientIp);
          if (!rl.allowed) {
            return jsonRes(429, {
              error: "一覧取得のレート制限に達しました",
              target: "list",
              retryAfterSec: rl.retryAfterSec ?? 1,
            }, {
              "Retry-After": String(rl.retryAfterSec ?? 1),
            });
          }

          const relPath = url.searchParams.get("path") ?? "";
          // Block check: if the directory itself is blocked, deny
          if (relPath) {
            const { safePath } = await import("./api/files");
            const resolved = await safePath(rootReal, relPath);
            if (resolved && isPathBlocked(resolved)) {
              return jsonRes(403, { error: "このパスへのアクセスはブロックされています" });
            }
          }
          const entries = await listDirectory(rootReal, relPath);
          if (entries === null) {
            return jsonRes(404, { error: "Directory not found or access denied" });
          }
          // Filter out blocked entries from listing
          const filtered = entries.filter((e: any) => {
            const fullPath = (rootReal + "/" + e.path).replace(/\\/g, "/");
            return !isPathBlocked(fullPath);
          });
          return jsonRes(200, filtered);
        }

        if (pathname === "/api/file") {
          const rl = checkIpRateLimit("download", clientIp);
          if (!rl.allowed) {
            return jsonRes(429, {
              error: "ダウンロードのレート制限に達しました",
              target: "download",
              retryAfterSec: rl.retryAfterSec ?? 1,
            }, {
              "Retry-After": String(rl.retryAfterSec ?? 1),
            });
          }

          const relPath = url.searchParams.get("path");
          if (!relPath) {
            return jsonRes(400, { error: "Missing path parameter" });
          }
          // Block check for file download
          const { safePath } = await import("./api/files");
          const resolvedFile = await safePath(rootReal, relPath);
          if (resolvedFile && isPathBlocked(resolvedFile)) {
            return jsonRes(403, { error: "このファイルはブロックされています" });
          }
          const resp = await serveFile(rootReal, relPath, request);
          const headers = new Headers(resp.headers);
          for (const [k, v] of Object.entries(corsHeaders())) {
            headers.set(k, v);
          }
          // Track download stats
          const contentLen = parseInt(headers.get("Content-Length") ?? "0", 10);
          if (resp.status === 200 || resp.status === 206) {
            recordDownload(contentLen);
          }
          return new Response(resp.body, { status: resp.status, headers });
        }

        // ── Auth routes ──

        if (pathname === "/api/auth/register" && request.method === "POST") {
          const rl = checkIpRateLimit("auth", clientIp);
          if (!rl.allowed) {
            return jsonRes(429, {
              ok: false,
              error: "認証関連のレート制限に達しました",
              target: "auth",
              retryAfterSec: rl.retryAfterSec ?? 1,
            }, {
              "Retry-After": String(rl.retryAfterSec ?? 1),
            });
          }

          try {
            const body = await request.json() as { username?: string; password?: string };
            const result = register(body.username ?? "", body.password ?? "", clientIp);
            return jsonRes(result.ok ? 200 : 400, result);
          } catch {
            return jsonRes(400, { ok: false, message: "Invalid request body" });
          }
        }

        if (pathname === "/api/auth/login" && request.method === "POST") {
          const rl = checkIpRateLimit("auth", clientIp);
          if (!rl.allowed) {
            return jsonRes(429, {
              ok: false,
              error: "認証関連のレート制限に達しました",
              target: "auth",
              retryAfterSec: rl.retryAfterSec ?? 1,
            }, {
              "Retry-After": String(rl.retryAfterSec ?? 1),
            });
          }

          try {
            const body = await request.json() as { username?: string; password?: string };
            const result = login(body.username ?? "", body.password ?? "", clientIp);
            return jsonRes(result.ok ? 200 : 401, result);
          } catch {
            return jsonRes(400, { ok: false, message: "Invalid request body" });
          }
        }

        if (pathname === "/api/auth/logout" && request.method === "POST") {
          const token = request.headers.get("Authorization");
          logout(token);
          return jsonRes(200, { ok: true, message: "ログアウトしました" });
        }

        if (pathname === "/api/auth/status") {
          const token = request.headers.get("Authorization");
          const status = getAuthStatus(token);
          const oplevel = getOpLevel(token);
          return jsonRes(200, { ...status, oplevel });
        }

        // ── Disk info route ──
        if (pathname === "/api/disk") {
          const rl = checkIpRateLimit("disk", clientIp);
          if (!rl.allowed) {
            return jsonRes(429, {
              error: "ディスク情報のレート制限に達しました",
              target: "disk",
              retryAfterSec: rl.retryAfterSec ?? 1,
            }, {
              "Retry-After": String(rl.retryAfterSec ?? 1),
            });
          }
          return jsonRes(200, getDiskInfo(rootReal));
        }

        // ── Protected routes (require auth) ──

        if (pathname === "/api/upload" && request.method === "POST") {
          const rl = checkIpRateLimit("upload", clientIp);
          if (!rl.allowed) {
            return jsonRes(429, {
              error: "アップロードのレート制限に達しました",
              target: "upload",
              retryAfterSec: rl.retryAfterSec ?? 1,
            }, {
              "Retry-After": String(rl.retryAfterSec ?? 1),
            });
          }

          const token = request.headers.get("Authorization");
          const username = verifyToken(token);
          if (!username) {
            return jsonRes(401, { error: "アップロードにはログインが必要です" });
          }
          const resp = await handleUpload(rootReal, request, username);
          // Track upload stats
          const uploadLen = parseInt(request.headers.get("content-length") ?? "0", 10);
          if (resp.status === 200) {
            recordUpload(uploadLen);
          }
          const headers = new Headers(resp.headers);
          for (const [k, v] of Object.entries(corsHeaders())) {
            headers.set(k, v);
          }
          return new Response(resp.body, { status: resp.status, headers });
        }

        if (pathname === "/api/mkdir" && request.method === "POST") {
          const rl = checkIpRateLimit("fileops", clientIp);
          if (!rl.allowed) {
            return jsonRes(429, {
              error: "ファイル操作のレート制限に達しました",
              target: "fileops",
              retryAfterSec: rl.retryAfterSec ?? 1,
            }, {
              "Retry-After": String(rl.retryAfterSec ?? 1),
            });
          }

          const token = request.headers.get("Authorization");
          const username = verifyToken(token);
          if (!username) {
            return jsonRes(401, { error: "フォルダ作成にはログインが必要です" });
          }
          const resp = await handleMkdir(rootReal, request, username);
          const headers = new Headers(resp.headers);
          for (const [k, v] of Object.entries(corsHeaders())) {
            headers.set(k, v);
          }
          return new Response(resp.body, { status: resp.status, headers });
        }

        // ── Rename (requires login, oplevel 1+) ──
        if (pathname === "/api/rename" && request.method === "POST") {
          const rl = checkIpRateLimit("fileops", clientIp);
          if (!rl.allowed) {
            return jsonRes(429, {
              error: "ファイル操作のレート制限に達しました",
              target: "fileops",
              retryAfterSec: rl.retryAfterSec ?? 1,
            }, {
              "Retry-After": String(rl.retryAfterSec ?? 1),
            });
          }

          const token = request.headers.get("Authorization");
          const username = verifyToken(token);
          if (!username) {
            return jsonRes(401, { error: "名前変更にはログインが必要です" });
          }
          const resp = await handleRename(rootReal, request, username);
          const headers = new Headers(resp.headers);
          for (const [k, v] of Object.entries(corsHeaders())) {
            headers.set(k, v);
          }
          return new Response(resp.body, { status: resp.status, headers });
        }

        // ── Delete (requires login, oplevel 2) ──
        if (pathname === "/api/delete" && request.method === "POST") {
          const rl = checkIpRateLimit("fileops", clientIp);
          if (!rl.allowed) {
            return jsonRes(429, {
              error: "ファイル操作のレート制限に達しました",
              target: "fileops",
              retryAfterSec: rl.retryAfterSec ?? 1,
            }, {
              "Retry-After": String(rl.retryAfterSec ?? 1),
            });
          }

          const token = request.headers.get("Authorization");
          const username = verifyToken(token);
          if (!username) {
            return jsonRes(401, { error: "削除にはログインが必要です" });
          }
          const oplevel = getOpLevel(token);
          if (oplevel < 2) {
            return jsonRes(403, { error: "削除には権限レベル2が必要です" });
          }
          const resp = await handleDelete(rootReal, request, username);
          const headers = new Headers(resp.headers);
          for (const [k, v] of Object.entries(corsHeaders())) {
            headers.set(k, v);
          }
          return new Response(resp.body, { status: resp.status, headers });
        }

        // ── Embedded static assets (exe-safe) ──
        if (pathname === "/index.js") {
          return serveEmbeddedJs();
        }

        // Fallback: serve embedded index.html (SPA)
        return serveEmbeddedHtml();
      } finally {
        connectionEnd();
      }
    },
  });
  } catch (err: any) {
    if (err && (err.code === "EADDRINUSE" || err.errno === "EADDRINUSE" || err.syscall === "listen")) {
      console.error(`❌ ポート ${internalPort} は既に使用されています。別のポートを指定するには --port <番号> を使ってください。`);
      process.exit(1);
    }
    throw err;
  }

  if (haproxyEnabled) {
    startHAProxyBridge({
      listenHost: "0.0.0.0",
      listenPort: port,
      targetHost: "127.0.0.1",
      targetPort: internalPort,
    });
    console.log(`🔒 Public endpoint requires HAProxy protocol on :${port}`);
  }

  // Start admin console
  startConsoleCLI();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
