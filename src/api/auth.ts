/**
 * Authentication module
 *
 * Design:
 *  - Each user gets a UUID4 account ID for tracking.
 *  - Users register with username + password.
 *  - Registration is IP-locked: one pending/approved account per IP.
 *  - New registrations enter "pending" state and need admin approval
 *    via the server console (allow/deny/clear commands).
 *  - On login, a session token (HMAC-SHA256 signed) is issued.
 *  - Tokens are verified on every protected request.
 *  - Read operations (list, download, preview) are PUBLIC.
 *  - Write operations (upload) require a valid session.
 *  - Admin console supports:
 *      reset              → clear all users, sessions, IP locks
 *      user reset password <username> <newpassword>
 *      user reset username <oldname> <newname>
 */

import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { resolveClientIpFromHAProxy } from "./haproxy";

// ── Types ──────────────────────────────────────────────
export type UserStatus = "pending" | "approved" | "denied";

export interface User {
  id: string;        // UUID4 — immutable account identifier
  username: string;
  passwordHash: string;
  salt: string;
  ip: string;
  status: UserStatus;
  oplevel: number;   // 1 = normal, 2 = advanced (delete files etc.)
  createdAt: string;
}

export interface Session {
  userId: string;    // links to User.id (stable across renames)
  username: string;
  token: string;
  ip: string;
  expiresAt: number; // epoch ms
}

// ── In-memory stores ───────────────────────────────────
const usersById = new Map<string, User>();      // id → User
const usernameIndex = new Map<string, string>(); // username → id
const sessions = new Map<string, Session>();     // token → Session
const ipToUserId = new Map<string, string>();    // ip → id

// Secret for HMAC token signing (random each server start)
const TOKEN_SECRET = randomBytes(32).toString("hex");
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours

// ── Block list (blocked paths) ─────────────────────────
let BLOCK_FILE = ""; // set by initAuth()
const blockedPaths: string[] = [];

// ── JSON Persistence ───────────────────────────────────
let DATA_FILE = ""; // set by initAuth()

/** Save all users to JSON file (debounced internally) */
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave() {
  if (!DATA_FILE) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const users = [...usersById.values()];
      const dir = dirname(DATA_FILE);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(DATA_FILE, JSON.stringify(users, null, 2), "utf-8");
    } catch (err) {
      console.error("⚠️  ユーザーデータの保存に失敗:", err);
    }
  }, 200);
}

/** Force an immediate synchronous save (for shutdown etc.) */
export function flushSave() {
  if (!DATA_FILE) return;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    const users = [...usersById.values()];
    const dir = dirname(DATA_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(DATA_FILE, JSON.stringify(users, null, 2), "utf-8");
  } catch (err) {
    console.error("⚠️  ユーザーデータの保存に失敗:", err);
  }
}

/** Save block list to JSON */
function saveBlockList() {
  if (!BLOCK_FILE) return;
  try {
    const dir = dirname(BLOCK_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(BLOCK_FILE, JSON.stringify(blockedPaths, null, 2), "utf-8");
  } catch (err) {
    console.error("⚠️  ブロックリストの保存に失敗:", err);
  }
}

/** Load block list from JSON */
function loadBlockList() {
  if (!BLOCK_FILE) return;
  if (existsSync(BLOCK_FILE)) {
    try {
      const raw = readFileSync(BLOCK_FILE, "utf-8");
      const list: string[] = JSON.parse(raw);
      blockedPaths.length = 0;
      blockedPaths.push(...list);
      console.log(`🚫 ブロックリストを読み込みました (${list.length} 件): ${BLOCK_FILE}`);
    } catch (err) {
      console.error(`⚠️  ブロックリストの読み込みに失敗: ${BLOCK_FILE}`, err);
    }
  }
}

/**
 * Initialize auth module — call once at startup.
 * Loads persisted user data from `<sharePath>/.fileshare/users.json`.
 */
export function initAuth(sharePath: string): void {
  const dataDir = join(sharePath, ".fileshare");
  DATA_FILE = join(dataDir, "users.json");

  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  if (existsSync(DATA_FILE)) {
    try {
      const raw = readFileSync(DATA_FILE, "utf-8");
      const users: User[] = JSON.parse(raw);
      for (const u of users) {
        // Migration: add oplevel if missing
        if (u.oplevel === undefined) u.oplevel = 1;
        usersById.set(u.id, u);
        usernameIndex.set(u.username, u.id);
        ipToUserId.set(u.ip, u.id);
      }
      console.log(`👥 ユーザーデータを読み込みました (${users.length} 件): ${DATA_FILE}`);
    } catch (err) {
      console.error(`⚠️  ユーザーデータの読み込みに失敗: ${DATA_FILE}`, err);
    }
  } else {
    console.log(`📝 ユーザーデータファイルを新規作成します: ${DATA_FILE}`);
  }

  // Load block list
  BLOCK_FILE = join(dataDir, "block.json");
  loadBlockList();
}

// ── Crypto helpers ─────────────────────────────────────
function hashPassword(password: string, salt: string): string {
  return createHmac("sha256", salt).update(password).digest("hex");
}

function generateToken(userId: string): string {
  const payload = `${userId}:${Date.now()}:${randomBytes(16).toString("hex")}`;
  const sig = createHmac("sha256", TOKEN_SECRET).update(payload).digest("hex");
  return `${Buffer.from(payload).toString("base64url")}.${sig}`;
}

function getUserByName(username: string): User | undefined {
  const id = usernameIndex.get(username.trim().toLowerCase());
  return id ? usersById.get(id) : undefined;
}

// ── Public API ─────────────────────────────────────────

/** Extract client IP from request */
export function getClientIp(request: Request, server?: any): string {
  const haproxyIp = resolveClientIpFromHAProxy(request);
  if (haproxyIp) return haproxyIp;

  if (server?.requestIP) {
    try {
      const info = server.requestIP(request);
      if (info?.address) return info.address;
    } catch { /* fallback */ }
  }
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp;
  return "unknown";
}

/**
 * Register a new user (returns UUID in message).
 */
export function register(
  username: string,
  password: string,
  ip: string
): { ok: boolean; message: string } {
  username = username.trim().toLowerCase();
  if (!username || username.length < 2 || username.length > 32) {
    return { ok: false, message: "ユーザー名は2〜32文字で入力してください" };
  }
  if (/[^a-z0-9_\-]/.test(username)) {
    return { ok: false, message: "ユーザー名は英数字・アンダースコア・ハイフンのみ使用可能です" };
  }
  if (!password || password.length < 4) {
    return { ok: false, message: "パスワードは4文字以上で入力してください" };
  }
  if (usernameIndex.has(username)) {
    return { ok: false, message: "このユーザー名は既に使用されています" };
  }

  const id = randomUUID();
  const salt = randomBytes(16).toString("hex");
  const user: User = {
    id,
    username,
    passwordHash: hashPassword(password, salt),
    salt,
    ip,
    status: "pending",
    oplevel: 1,
    createdAt: new Date().toISOString(),
  };

  usersById.set(id, user);
  usernameIndex.set(username, id);
  ipToUserId.set(ip, id);
  scheduleSave();

  console.log(`\n🔔 新規ユーザー登録リクエスト: "${username}" [${id}] (IP: ${ip})`);
  console.log(`   → 許可: allow ${username}`);
  console.log(`   → 拒否: deny ${username}\n`);

  return { ok: true, message: "登録リクエストを送信しました。管理者の承認をお待ちください。" };
}

/**
 * Login: returns session token if credentials valid and user approved.
 */
export function login(
  username: string,
  password: string,
  ip: string
): { ok: boolean; message: string; token?: string; username?: string } {
  username = username.trim().toLowerCase();
  const user = getUserByName(username);
  if (!user) {
    return { ok: false, message: "ユーザー名またはパスワードが正しくありません" };
  }
  const hash = hashPassword(password, user.salt);
  if (hash !== user.passwordHash) {
    return { ok: false, message: "ユーザー名またはパスワードが正しくありません" };
  }
  if (user.status === "pending") {
    return { ok: false, message: "アカウントは承認待ちです。管理者の承認をお待ちください。" };
  }
  if (user.status === "denied") {
    return { ok: false, message: "アカウントは拒否されました。" };
  }

  // Keep latest observed client IP on successful login
  if (user.ip !== ip) {
    const oldIp = user.ip;
    user.ip = ip;
    const owner = ipToUserId.get(oldIp);
    if (owner === user.id) {
      ipToUserId.delete(oldIp);
    }
    ipToUserId.set(ip, user.id);
    scheduleSave();
  }

  const token = generateToken(user.id);
  const session: Session = {
    userId: user.id,
    username: user.username,
    token,
    ip,
    expiresAt: Date.now() + SESSION_TTL,
  };
  sessions.set(token, session);

  return { ok: true, message: "ログイン成功", token, username: user.username };
}

/**
 * Verify a session token. Returns username if valid, null otherwise.
 */
export function verifyToken(token: string | null): string | null {
  if (!token) return null;
  const raw = token.startsWith("Bearer ") ? token.slice(7) : token;
  const session = sessions.get(raw);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(raw);
    return null;
  }
  const user = usersById.get(session.userId);
  if (!user || user.status !== "approved") return null;
  // Return current username (may have changed via rename)
  return user.username;
}

/**
 * Get current auth status for a token (for frontend).
 */
export function getAuthStatus(token: string | null): {
  authenticated: boolean;
  username?: string;
} {
  const username = verifyToken(token);
  if (username) return { authenticated: true, username };
  return { authenticated: false };
}

/**
 * Logout: invalidate session.
 */
export function logout(token: string | null): void {
  if (!token) return;
  const raw = token.startsWith("Bearer ") ? token.slice(7) : token;
  sessions.delete(raw);
}

// ── Admin console commands ─────────────────────────────

export function listPendingUsers(): User[] {
  return [...usersById.values()].filter((u) => u.status === "pending");
}

export function listAllUsers(): User[] {
  return [...usersById.values()];
}

export function approveUser(username: string): boolean {
  const user = getUserByName(username);
  if (!user) return false;
  user.status = "approved";
  scheduleSave();
  return true;
}

export function denyUser(username: string): boolean {
  const user = getUserByName(username);
  if (!user) return false;
  user.status = "denied";
  for (const [token, session] of sessions) {
    if (session.userId === user.id) sessions.delete(token);
  }
  scheduleSave();
  return true;
}

export function clearPending(): number {
  const pending = listPendingUsers();
  for (const user of pending) {
    ipToUserId.delete(user.ip);
    usernameIndex.delete(user.username);
    usersById.delete(user.id);
    for (const [token, session] of sessions) {
      if (session.userId === user.id) sessions.delete(token);
    }
  }
  if (pending.length > 0) scheduleSave();
  return pending.length;
}

/** Reset ALL users and sessions */
export function resetAll(): number {
  const count = usersById.size;
  usersById.clear();
  usernameIndex.clear();
  sessions.clear();
  ipToUserId.clear();
  scheduleSave();
  return count;
}

/** Reset a user's password */
export function resetPassword(username: string, newPassword: string): boolean {
  const user = getUserByName(username);
  if (!user) return false;
  if (!newPassword || newPassword.length < 4) return false;
  const salt = randomBytes(16).toString("hex");
  user.salt = salt;
  user.passwordHash = hashPassword(newPassword, salt);
  // Invalidate existing sessions (force re-login)
  for (const [token, session] of sessions) {
    if (session.userId === user.id) sessions.delete(token);
  }
  scheduleSave();
  return true;
}

/** Delete a user entirely */
export function deleteUser(username: string): boolean {
  const user = getUserByName(username);
  if (!user) return false;
  // Remove all sessions
  for (const [token, session] of sessions) {
    if (session.userId === user.id) sessions.delete(token);
  }
  // Remove from stores
  ipToUserId.delete(user.ip);
  usernameIndex.delete(user.username);
  usersById.delete(user.id);
  scheduleSave();
  return true;
}

/** Set op level for a user (1=normal, 2=advanced) */
export function setOpLevel(username: string, level: number): boolean {
  if (level < 1 || level > 2) return false;
  const user = getUserByName(username);
  if (!user) return false;
  user.oplevel = level;
  scheduleSave();
  return true;
}

/** Get user's op level from token */
export function getOpLevel(token: string | null): number {
  if (!token) return 0;
  const raw = token.startsWith("Bearer ") ? token.slice(7) : token;
  const session = sessions.get(raw);
  if (!session) return 0;
  if (Date.now() > session.expiresAt) {
    sessions.delete(raw);
    return 0;
  }
  const user = usersById.get(session.userId);
  if (!user || user.status !== "approved") return 0;
  return user.oplevel ?? 1;
}

// ── Block path management ──────────────────────────────

/** Normalise a path for comparison */
function normalisePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** Add a path to the block list */
export function addBlockPath(rawPath: string): boolean {
  const norm = normalisePath(rawPath);
  if (!norm) return false;
  if (blockedPaths.some((p) => normalisePath(p) === norm)) return false;
  blockedPaths.push(rawPath);
  saveBlockList();
  return true;
}

/** Remove a path from the block list */
export function removeBlockPath(rawPath: string): boolean {
  const norm = normalisePath(rawPath);
  const idx = blockedPaths.findIndex((p) => normalisePath(p) === norm);
  if (idx < 0) return false;
  blockedPaths.splice(idx, 1);
  saveBlockList();
  return true;
}

/** List all blocked paths */
export function listBlockedPaths(): string[] {
  return [...blockedPaths];
}

/**
 * Check if an absolute path is blocked.
 * Returns true if the path is within any blocked path.
 */
export function isPathBlocked(absolutePath: string): boolean {
  if (blockedPaths.length === 0) return false;
  const normTarget = normalisePath(absolutePath);
  for (const bp of blockedPaths) {
    const normBlocked = normalisePath(bp);
    // Exact match or target is inside blocked path
    if (normTarget === normBlocked || normTarget.startsWith(normBlocked + "/")) {
      return true;
    }
    // Target is a parent of blocked path (block listing that would show blocked items)
    // Not blocking parents — only the blocked path and children
  }
  return false;
}

/** Rename a user */
export function resetUsername(oldName: string, newName: string): boolean {
  newName = newName.trim().toLowerCase();
  if (!newName || newName.length < 2 || newName.length > 32) return false;
  if (/[^a-z0-9_\-]/.test(newName)) return false;
  if (usernameIndex.has(newName)) return false; // new name already taken

  const user = getUserByName(oldName);
  if (!user) return false;

  usernameIndex.delete(user.username);
  user.username = newName;
  usernameIndex.set(newName, user.id);

  // Update session display names
  for (const session of sessions.values()) {
    if (session.userId === user.id) session.username = newName;
  }
  scheduleSave();
  return true;
}
