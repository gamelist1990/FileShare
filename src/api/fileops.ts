/**
 * File operations: rename & delete
 *
 * - Rename: requires authenticated user (oplevel 1+)
 * - Delete: requires oplevel 2
 * - Security: path traversal prevention, block check
 */

import { join, basename, dirname } from "node:path";
import { rename, rm, stat } from "node:fs/promises";
import { safePath } from "./files";
import { isPathBlocked } from "./auth";

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function jsonResponse(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Handle file/folder rename.
 * Body: { path: string, newName: string }
 */
export async function handleRename(
  rootReal: string,
  request: Request,
  _username: string
): Promise<Response> {
  try {
    const body = await request.json() as { path?: string; newName?: string };
    const relPath = body.path ?? "";
    const newName = (body.newName ?? "").trim();

    if (!relPath || !newName) {
      return jsonResponse(400, { error: "パスと新しい名前を指定してください" });
    }

    // Sanitise new name
    const safeName = newName
      .replace(/[\x00-\x1f]/g, "")
      .replace(/[/\\:*?"<>|]/g, "_")
      .trim();

    if (!safeName || safeName === "." || safeName === "..") {
      return jsonResponse(400, { error: "無効なファイル名です" });
    }

    const resolved = await safePath(rootReal, relPath);
    if (!resolved) {
      return jsonResponse(404, { error: "ファイルが見つかりません" });
    }

    // Block check
    if (isPathBlocked(resolved)) {
      return jsonResponse(403, { error: "このパスはブロックされています" });
    }

    const parentDir = dirname(resolved);
    const newPath = join(parentDir, safeName);

    // Ensure new path stays inside root
    const newPathNorm = newPath.replace(/\\/g, "/").toLowerCase();
    const rootNorm = rootReal.replace(/\\/g, "/").toLowerCase();
    if (!newPathNorm.startsWith(rootNorm)) {
      return jsonResponse(403, { error: "アクセスが拒否されました" });
    }

    // Check new path doesn't already exist
    try {
      await stat(newPath);
      return jsonResponse(409, { error: "同名のファイル/フォルダが既に存在します" });
    } catch {
      // Good — doesn't exist
    }

    await rename(resolved, newPath);

    const oldName = basename(resolved);
    console.log(`📝 Rename: "${oldName}" → "${safeName}" by ${_username}`);

    return jsonResponse(200, {
      ok: true,
      message: `「${oldName}」を「${safeName}」に変更しました`,
    });
  } catch (err: unknown) {
    console.error("Rename error:", err);
    return jsonResponse(500, { error: "名前変更に失敗しました: " + getErrorMessage(err) });
  }
}

/**
 * Handle file/folder delete.
 * Body: { path: string }
 */
export async function handleDelete(
  rootReal: string,
  request: Request,
  _username: string
): Promise<Response> {
  try {
    const body = await request.json() as { path?: string };
    const relPath = body.path ?? "";

    if (!relPath) {
      return jsonResponse(400, { error: "パスを指定してください" });
    }

    const resolved = await safePath(rootReal, relPath);
    if (!resolved) {
      return jsonResponse(404, { error: "ファイルが見つかりません" });
    }

    // Block check
    if (isPathBlocked(resolved)) {
      return jsonResponse(403, { error: "このパスはブロックされています" });
    }

    // Don't allow deleting the root itself
    const resolvedNorm = resolved.replace(/\\/g, "/").toLowerCase();
    const rootNorm = rootReal.replace(/\\/g, "/").toLowerCase();
    if (resolvedNorm === rootNorm) {
      return jsonResponse(403, { error: "ルートディレクトリは削除できません" });
    }

    const entryName = basename(resolved);
    const st = await stat(resolved);

    await rm(resolved, { recursive: true, force: true });

    const type = st.isDirectory() ? "フォルダ" : "ファイル";
    console.log(`🗑️  Delete: "${entryName}" (${type}) by ${_username}`);

    return jsonResponse(200, {
      ok: true,
      message: `${type}「${entryName}」を削除しました`,
    });
  } catch (err: unknown) {
    console.error("Delete error:", err);
    return jsonResponse(500, { error: "削除に失敗しました: " + getErrorMessage(err) });
  }
}
