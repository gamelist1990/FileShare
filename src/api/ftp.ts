/**
 * FTP server for FileShare
 *
 * Minimal FTP server (RFC 959) using Bun's TCP socket APIs.
 * Supports passive mode, directory listing, file download/upload,
 * directory creation/deletion, rename, and file deletion.
 *
 * Usage:
 *   Windows Explorer:  ftp://host:port
 *   Ubuntu Nautilus:    ftp://host:port
 *   CLI:               ftp host port
 */

import { readdir, stat, mkdir, rename, unlink, rm } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { networkInterfaces } from "node:os";
import { safePath, getMime } from "./files";
import { getModuleSettings, registerSettingsModule, updateModuleSettings } from "./settings";
import type { Socket, TCPSocketListener } from "bun";

// ── Settings ──────────────────────────────────────────────

interface FtpSettings {
    enabled: boolean;
    port: number;
    pasvPortMin: number;
    pasvPortMax: number;
    /** Allow anonymous (no login) read-only access */
    anonymousRead: boolean;
}

const FTP_SETTINGS_KEY = "ftp";
const DEFAULT_FTP_SETTINGS: FtpSettings = {
    enabled: true,
    port: 2121,
    pasvPortMin: 50000,
    pasvPortMax: 50100,
    anonymousRead: true,
};

export function registerFtpSettings(): void {
    registerSettingsModule<FtpSettings>(FTP_SETTINGS_KEY, DEFAULT_FTP_SETTINGS);
}

export function getFtpSettings(): FtpSettings {
    return getModuleSettings<FtpSettings>(FTP_SETTINGS_KEY);
}

export function updateFtpSettings(settings: Partial<FtpSettings>): void {
    const current = getFtpSettings();
    updateModuleSettings<FtpSettings>(FTP_SETTINGS_KEY, { ...current, ...settings });
}

// ── Types ─────────────────────────────────────────────────

interface FtpSession {
    rootReal: string;
    cwd: string;
    authenticated: boolean;
    username: string;
    transferType: "A" | "I";
    serverIp: string; // dotted-quad for PASV responses
    pasvListener: TCPSocketListener | null;
    pasvDataSocket: Socket<any> | null;
    dataReady: Promise<Socket<any>> | null;
    dataReadyResolve: ((sock: Socket<any>) => void) | null;
    /** Resolves when the data connection closes (for STOR) */
    dataClose: Promise<void> | null;
    dataCloseResolve: (() => void) | null;
    /** Incoming upload data buffer */
    uploadChunks: Uint8Array[];
    renameFrom: string | null;
    utf8: boolean;
}

// ── Detect server LAN IP ──────────────────────────────────

function getLocalIp(): string {
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name] ?? []) {
            if (net.family === "IPv4" && !net.internal) {
                return net.address;
            }
        }
    }
    return "127.0.0.1";
}

let cachedServerIp = "127.0.0.1";

// ── Helpers ───────────────────────────────────────────────

function formatDate(d: Date): string {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const now = new Date();
    const sixMonthsAgo = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);

    const month = months[d.getMonth()];
    const day = String(d.getDate()).padStart(2, " ");

    if (d > sixMonthsAgo) {
        // Recent: show time
        const hours = String(d.getHours()).padStart(2, "0");
        const mins = String(d.getMinutes()).padStart(2, "0");
        return `${month} ${day} ${hours}:${mins}`;
    } else {
        // Old: show year
        return `${month} ${day}  ${d.getFullYear()}`;
    }
}

function buildListLine(name: string, isDir: boolean, size: number, mtime: Date): string {
    const permissions = isDir ? "drwxr-xr-x" : "-rw-r--r--";
    const links = isDir ? "2" : "1";
    const owner = "owner";
    const group = "group";
    const sizeStr = String(size).padStart(13, " ");
    const dateStr = formatDate(mtime);
    return `${permissions}   ${links} ${owner}  ${group} ${sizeStr} ${dateStr} ${name}`;
}

function resolveFtpPath(session: FtpSession, path: string): string {
    if (path.startsWith("/")) {
        // Absolute path from FTP root
        return path.replace(/^\/+/, "").replace(/\/+$/, "");
    }
    // Relative to cwd
    if (!session.cwd) return path.replace(/\/+$/, "");
    return `${session.cwd}/${path}`.replace(/\/+/g, "/").replace(/\/+$/, "");
}

function parentDir(path: string): string {
    const idx = path.lastIndexOf("/");
    return idx < 0 ? "" : path.substring(0, idx);
}

// ── Passive mode data connection ──────────────────────────

async function setupPasvListener(
    session: FtpSession,
    settings: FtpSettings
): Promise<{ port: number }> {
    // Close existing
    if (session.pasvListener) {
        session.pasvListener.stop(true);
        session.pasvListener = null;
    }
    if (session.pasvDataSocket) {
        session.pasvDataSocket.end();
        session.pasvDataSocket = null;
    }

    // Create a promise that resolves when data connection is established
    let resolve: (sock: Socket<any>) => void;
    const promise = new Promise<Socket<any>>((r) => { resolve = r; });
    session.dataReady = promise;
    session.dataReadyResolve = resolve!;

    // Try ports in range
    const { pasvPortMin, pasvPortMax } = settings;
    let listener: TCPSocketListener | null = null;
    let chosenPort = 0;

    for (let p = pasvPortMin; p <= pasvPortMax; p++) {
        try {
            listener = Bun.listen({
                hostname: "0.0.0.0",
                port: p,
                socket: {
                    open(socket) {
                        session.pasvDataSocket = socket;
                        session.dataReadyResolve?.(socket);
                    },
                    data(_socket, data) {
                        // Buffer incoming data for STOR uploads
                        const chunk = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
                        session.uploadChunks.push(new Uint8Array(chunk));
                    },
                    close() {
                        session.pasvDataSocket = null;
                        session.dataCloseResolve?.();
                    },
                    error() {
                        session.pasvDataSocket = null;
                        session.dataCloseResolve?.();
                    },
                },
            });
            chosenPort = p;
            break;
        } catch {
            continue;
        }
    }

    if (!listener || !chosenPort) {
        throw new Error("No passive ports available");
    }

    session.pasvListener = listener;
    return { port: chosenPort };
}

async function getDataSocket(session: FtpSession): Promise<Socket<any> | null> {
    if (!session.dataReady) return null;
    try {
        // Wait up to 10 seconds for data connection
        const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 10000));
        const socket = await Promise.race([session.dataReady, timeout]);
        return socket;
    } catch {
        return null;
    }
}

function cleanupDataConnection(session: FtpSession) {
    if (session.pasvListener) {
        session.pasvListener.stop(true);
        session.pasvListener = null;
    }
    if (session.pasvDataSocket) {
        session.pasvDataSocket.end();
        session.pasvDataSocket = null;
    }
    session.dataReady = null;
    session.dataReadyResolve = null;
    session.dataClose = null;
    session.dataCloseResolve = null;
    session.uploadChunks = [];
}

// ── Command handler ───────────────────────────────────────

async function handleFtpCommand(
    socket: Socket<FtpSession>,
    line: string,
    settings: FtpSettings
): Promise<void> {
    const session = socket.data;
    const trimmed = line.trim();
    if (!trimmed) return;

    // Parse command and argument
    const spaceIdx = trimmed.indexOf(" ");
    const cmd = (spaceIdx < 0 ? trimmed : trimmed.substring(0, spaceIdx)).toUpperCase();
    const arg = spaceIdx < 0 ? "" : trimmed.substring(spaceIdx + 1).trim();

    // Commands allowed before auth
    if (!session.authenticated) {
        switch (cmd) {
            case "USER":
                session.username = arg || "anonymous";
                if (session.username === "anonymous" && settings.anonymousRead) {
                    session.authenticated = true;
                    socket.write("230 Anonymous login OK, read-only access.\r\n");
                } else {
                    socket.write("331 Password required.\r\n");
                }
                return;
            case "PASS":
                // Accept any password for anonymous
                if (session.username === "anonymous" && settings.anonymousRead) {
                    session.authenticated = true;
                    socket.write("230 Login successful.\r\n");
                } else {
                    // TODO: integrate with FileShare auth system
                    session.authenticated = true;
                    socket.write("230 Login successful.\r\n");
                }
                return;
            case "AUTH":
                socket.write("504 Security mechanism not implemented.\r\n");
                return;
            case "QUIT":
                socket.write("221 Bye.\r\n");
                socket.end();
                return;
            case "FEAT":
                socket.write("211-Features:\r\n UTF8\r\n PASV\r\n SIZE\r\n MDTM\r\n REST STREAM\r\n211 End\r\n");
                return;
            case "OPTS":
                if (arg.toUpperCase() === "UTF8 ON") {
                    session.utf8 = true;
                    socket.write("200 UTF8 mode enabled.\r\n");
                } else {
                    socket.write("501 Unknown option.\r\n");
                }
                return;
            default:
                socket.write("530 Please login first.\r\n");
                return;
        }
    }

    // Authenticated commands
    switch (cmd) {
        case "SYST":
            socket.write("215 UNIX Type: L8\r\n");
            return;

        case "FEAT":
            socket.write("211-Features:\r\n UTF8\r\n PASV\r\n SIZE\r\n MDTM\r\n REST STREAM\r\n211 End\r\n");
            return;

        case "OPTS":
            if (arg.toUpperCase() === "UTF8 ON") {
                session.utf8 = true;
                socket.write("200 UTF8 mode enabled.\r\n");
            } else {
                socket.write("501 Unknown option.\r\n");
            }
            return;

        case "TYPE":
            if (arg.toUpperCase() === "I") {
                session.transferType = "I";
                socket.write("200 Type set to I (binary).\r\n");
            } else if (arg.toUpperCase() === "A") {
                session.transferType = "A";
                socket.write("200 Type set to A (ASCII).\r\n");
            } else {
                socket.write("504 Type not supported.\r\n");
            }
            return;

        case "PWD":
        case "XPWD":
            socket.write(`257 "/${session.cwd}" is current directory.\r\n`);
            return;

        case "CWD":
        case "XCWD": {
            const target = resolveFtpPath(session, arg);
            if (target === "" || target === ".") {
                session.cwd = "";
                socket.write(`250 Directory changed to /\r\n`);
                return;
            }
            const resolved = await safePath(session.rootReal, target);
            if (!resolved) {
                socket.write("550 Directory not found.\r\n");
                return;
            }
            try {
                const st = await stat(resolved);
                if (!st.isDirectory()) {
                    socket.write("550 Not a directory.\r\n");
                    return;
                }
                session.cwd = target;
                socket.write(`250 Directory changed to /${target}\r\n`);
            } catch {
                socket.write("550 Directory not found.\r\n");
            }
            return;
        }

        case "CDUP":
        case "XCUP":
            session.cwd = parentDir(session.cwd);
            socket.write(`250 Directory changed to /${session.cwd}\r\n`);
            return;

        case "PASV": {
            try {
                const { port: pasvPort } = await setupPasvListener(session, settings);
                // Determine correct IP: if client connected via loopback, respond with 127.0.0.1
                const remoteAddr = (socket as any).remoteAddress ?? "";
                const isLocal = remoteAddr === "127.0.0.1" || remoteAddr === "::1" || remoteAddr === "::ffff:127.0.0.1";
                const pasvIp = isLocal ? "127.0.0.1" : session.serverIp;
                const ipParts = pasvIp.split(".").map(Number);
                const p1 = (pasvPort >> 8) & 0xff;
                const p2 = pasvPort & 0xff;
                socket.write(`227 Entering Passive Mode (${ipParts[0]},${ipParts[1]},${ipParts[2]},${ipParts[3]},${p1},${p2}).\r\n`);
            } catch {
                socket.write("425 Cannot open passive connection.\r\n");
            }
            return;
        }

        case "EPSV": {
            try {
                const { port: pasvPort } = await setupPasvListener(session, settings);
                socket.write(`229 Entering Extended Passive Mode (|||${pasvPort}|).\r\n`);
            } catch {
                socket.write("425 Cannot open passive connection.\r\n");
            }
            return;
        }

        case "LIST":
        case "MLSD": {
            const targetPath = arg ? resolveFtpPath(session, arg) : session.cwd;
            const dirPath = targetPath ? await safePath(session.rootReal, targetPath) : session.rootReal;
            if (!dirPath) {
                socket.write("550 Directory not found.\r\n");
                return;
            }

            try {
                const entries = await readdir(dirPath, { withFileTypes: true });
                const lines: string[] = [];

                for (const entry of entries) {
                    if (entry.name === ".fileshare") continue;
                    try {
                        const fullPath = join(dirPath, entry.name);
                        const st = await stat(fullPath);
                        lines.push(buildListLine(entry.name, entry.isDirectory(), st.size, st.mtime));
                    } catch {
                        // Skip inaccessible
                    }
                }

                socket.write("150 Opening data connection for directory listing.\r\n");
                const dataSock = await getDataSocket(session);
                if (!dataSock) {
                    socket.write("425 No data connection.\r\n");
                    return;
                }

                const listData = lines.join("\r\n") + "\r\n";
                dataSock.write(listData);
                dataSock.end();
                cleanupDataConnection(session);
                socket.write("226 Transfer complete.\r\n");
            } catch {
                socket.write("550 Failed to list directory.\r\n");
            }
            return;
        }

        case "NLST": {
            const targetPath = arg ? resolveFtpPath(session, arg) : session.cwd;
            const dirPath = targetPath ? await safePath(session.rootReal, targetPath) : session.rootReal;
            if (!dirPath) {
                socket.write("550 Directory not found.\r\n");
                return;
            }

            try {
                const entries = await readdir(dirPath);
                socket.write("150 Opening data connection.\r\n");
                const dataSock = await getDataSocket(session);
                if (!dataSock) {
                    socket.write("425 No data connection.\r\n");
                    return;
                }
                const filtered = entries.filter((e) => e !== ".fileshare");
                dataSock.write(filtered.join("\r\n") + "\r\n");
                dataSock.end();
                cleanupDataConnection(session);
                socket.write("226 Transfer complete.\r\n");
            } catch {
                socket.write("550 Failed to list directory.\r\n");
            }
            return;
        }

        case "RETR": {
            if (!arg) {
                socket.write("501 Missing filename.\r\n");
                return;
            }
            const target = resolveFtpPath(session, arg);
            const filePath = await safePath(session.rootReal, target);
            if (!filePath) {
                socket.write("550 File not found.\r\n");
                return;
            }

            try {
                const st = await stat(filePath);
                if (st.isDirectory()) {
                    socket.write("550 Not a regular file.\r\n");
                    return;
                }

                socket.write(`150 Opening data connection for ${basename(target)} (${st.size} bytes).\r\n`);
                const dataSock = await getDataSocket(session);
                if (!dataSock) {
                    socket.write("425 No data connection.\r\n");
                    return;
                }

                const file = Bun.file(filePath);
                const buffer = await file.arrayBuffer();
                dataSock.write(new Uint8Array(buffer));
                dataSock.end();
                cleanupDataConnection(session);
                socket.write("226 Transfer complete.\r\n");
            } catch {
                socket.write("550 Failed to read file.\r\n");
            }
            return;
        }

        case "STOR": {
            if (!arg) {
                socket.write("501 Missing filename.\r\n");
                return;
            }
            if (session.username === "anonymous") {
                socket.write("550 Permission denied (read-only).\r\n");
                return;
            }

            const target = resolveFtpPath(session, arg);
            const filePath = safePathForWrite(session.rootReal, target);
            if (!filePath) {
                socket.write("550 Forbidden.\r\n");
                return;
            }

            try {
                await mkdir(dirname(filePath), { recursive: true });

                // Reset upload buffer and set up close promise
                session.uploadChunks = [];
                let closeResolve: () => void;
                session.dataClose = new Promise<void>((r) => { closeResolve = r; });
                session.dataCloseResolve = closeResolve!;

                socket.write("150 Ready to receive data.\r\n");
                const dataSock = await getDataSocket(session);
                if (!dataSock) {
                    socket.write("425 No data connection.\r\n");
                    return;
                }

                // Wait for data connection to close (client finishes sending)
                const timeout = new Promise<void>((resolve) => setTimeout(resolve, 60000));
                await Promise.race([session.dataClose, timeout]);

                // Write collected data to file
                const totalSize = session.uploadChunks.reduce((sum, c) => sum + c.length, 0);
                const buffer = new Uint8Array(totalSize);
                let offset = 0;
                for (const chunk of session.uploadChunks) {
                    buffer.set(chunk, offset);
                    offset += chunk.length;
                }

                await Bun.write(filePath, buffer);
                session.uploadChunks = [];
                cleanupDataConnection(session);
                socket.write("226 Transfer complete.\r\n");
            } catch {
                socket.write("550 Failed to store file.\r\n");
            }
            return;
        }

        case "SIZE": {
            if (!arg) {
                socket.write("501 Missing filename.\r\n");
                return;
            }
            const target = resolveFtpPath(session, arg);
            const filePath = await safePath(session.rootReal, target);
            if (!filePath) {
                socket.write("550 File not found.\r\n");
                return;
            }
            try {
                const st = await stat(filePath);
                socket.write(`213 ${st.size}\r\n`);
            } catch {
                socket.write("550 File not found.\r\n");
            }
            return;
        }

        case "MDTM": {
            if (!arg) {
                socket.write("501 Missing filename.\r\n");
                return;
            }
            const target = resolveFtpPath(session, arg);
            const filePath = await safePath(session.rootReal, target);
            if (!filePath) {
                socket.write("550 File not found.\r\n");
                return;
            }
            try {
                const st = await stat(filePath);
                // Format: YYYYMMDDHHmmss
                const d = st.mtime;
                const ts = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;
                socket.write(`213 ${ts}\r\n`);
            } catch {
                socket.write("550 File not found.\r\n");
            }
            return;
        }

        case "MKD":
        case "XMKD": {
            if (!arg) {
                socket.write("501 Missing directory name.\r\n");
                return;
            }
            if (session.username === "anonymous") {
                socket.write("550 Permission denied.\r\n");
                return;
            }
            const target = resolveFtpPath(session, arg);
            const dirPath = safePathForWrite(session.rootReal, target);
            if (!dirPath) {
                socket.write("550 Forbidden.\r\n");
                return;
            }
            try {
                await mkdir(dirPath, { recursive: false });
                socket.write(`257 "/${target}" created.\r\n`);
            } catch {
                socket.write("550 Failed to create directory.\r\n");
            }
            return;
        }

        case "RMD":
        case "XRMD": {
            if (!arg) {
                socket.write("501 Missing directory name.\r\n");
                return;
            }
            if (session.username === "anonymous") {
                socket.write("550 Permission denied.\r\n");
                return;
            }
            const target = resolveFtpPath(session, arg);
            const dirPath = await safePath(session.rootReal, target);
            if (!dirPath) {
                socket.write("550 Directory not found.\r\n");
                return;
            }
            try {
                await rm(dirPath, { recursive: true });
                socket.write("250 Directory removed.\r\n");
            } catch {
                socket.write("550 Failed to remove directory.\r\n");
            }
            return;
        }

        case "DELE": {
            if (!arg) {
                socket.write("501 Missing filename.\r\n");
                return;
            }
            if (session.username === "anonymous") {
                socket.write("550 Permission denied.\r\n");
                return;
            }
            const target = resolveFtpPath(session, arg);
            const filePath = await safePath(session.rootReal, target);
            if (!filePath) {
                socket.write("550 File not found.\r\n");
                return;
            }
            try {
                await unlink(filePath);
                socket.write("250 File deleted.\r\n");
            } catch {
                socket.write("550 Failed to delete file.\r\n");
            }
            return;
        }

        case "RNFR": {
            if (!arg) {
                socket.write("501 Missing filename.\r\n");
                return;
            }
            if (session.username === "anonymous") {
                socket.write("550 Permission denied.\r\n");
                return;
            }
            const target = resolveFtpPath(session, arg);
            const filePath = await safePath(session.rootReal, target);
            if (!filePath) {
                socket.write("550 File not found.\r\n");
                return;
            }
            session.renameFrom = filePath;
            socket.write("350 Ready for RNTO.\r\n");
            return;
        }

        case "RNTO": {
            if (!arg || !session.renameFrom) {
                socket.write("503 RNFR required first.\r\n");
                return;
            }
            const target = resolveFtpPath(session, arg);
            const destPath = safePathForWrite(session.rootReal, target);
            if (!destPath) {
                socket.write("550 Forbidden.\r\n");
                return;
            }
            try {
                await rename(session.renameFrom, destPath);
                session.renameFrom = null;
                socket.write("250 Rename successful.\r\n");
            } catch {
                socket.write("550 Failed to rename.\r\n");
            }
            return;
        }

        case "NOOP":
            socket.write("200 NOOP ok.\r\n");
            return;

        case "QUIT":
            socket.write("221 Bye.\r\n");
            cleanupDataConnection(session);
            socket.end();
            return;

        case "PORT":
            // Active mode — not supported, use PASV
            socket.write("502 Active mode not supported. Use PASV.\r\n");
            return;

        case "ABOR":
            cleanupDataConnection(session);
            socket.write("226 Abort successful.\r\n");
            return;

        case "REST":
            // We don't actually support resume, but acknowledge it
            socket.write("350 Restart position accepted.\r\n");
            return;

        case "STAT":
            if (!arg) {
                socket.write("211-FileShare FTP Server\r\n211 End\r\n");
            } else {
                socket.write("213-Status\r\n213 End\r\n");
            }
            return;

        case "HELP":
            socket.write("214-Commands supported:\r\n USER PASS SYST FEAT OPTS TYPE PWD CWD CDUP\r\n LIST NLST PASV EPSV RETR STOR SIZE MDTM\r\n MKD RMD DELE RNFR RNTO NOOP QUIT ABOR\r\n214 End\r\n");
            return;

        default:
            socket.write(`502 Command '${cmd}' not implemented.\r\n`);
            return;
    }
}

// ── Safe write path (target may not exist yet) ────────────

function safePathForWrite(rootReal: string, relPath: string): string | null {
    try {
        const cleaned = relPath
            .replace(/\\/g, "/")
            .replace(/^[./\\]+/, "")
            .replace(/\.\./g, "");

        const target = join(rootReal, cleaned);
        const normRoot = rootReal.replace(/\\/g, "/").toLowerCase();
        const normTarget = target.replace(/\\/g, "/").toLowerCase();

        if (!normTarget.startsWith(normRoot)) {
            return null;
        }
        return target;
    } catch {
        return null;
    }
}

// ── FTP Server start/stop ─────────────────────────────────

let ftpServer: TCPSocketListener | null = null;

export function startFtpServer(rootReal: string): { port: number } | null {
    const settings = getFtpSettings();
    if (!settings.enabled) {
        console.log("📁 FTP server is disabled in settings.");
        return null;
    }

    if (ftpServer) {
        console.log("📁 FTP server is already running.");
        return { port: settings.port };
    }

    try {
        cachedServerIp = getLocalIp();
        ftpServer = Bun.listen<FtpSession>({
            hostname: "0.0.0.0",
            port: settings.port,
            socket: {
                open(socket) {
                    socket.data = {
                        rootReal,
                        cwd: "",
                        authenticated: false,
                        username: "",
                        transferType: "I",
                        serverIp: cachedServerIp,
                        pasvListener: null,
                        pasvDataSocket: null,
                        dataReady: null,
                        dataReadyResolve: null,
                        dataClose: null,
                        dataCloseResolve: null,
                        uploadChunks: [],
                        renameFrom: null,
                        utf8: false,
                    };
                    socket.write("220 FileShare FTP Server ready.\r\n");
                },

                data(socket, data) {
                    const text = typeof data === "string" ? data : Buffer.from(data).toString("utf-8");
                    // FTP commands are line-based
                    const lines = text.split(/\r?\n/);
                    for (const line of lines) {
                        if (line.trim()) {
                            handleFtpCommand(socket, line, settings).catch((err) => {
                                console.error("[FTP] Command error:", err);
                                try {
                                    socket.write("500 Internal error.\r\n");
                                } catch { /* socket may be closed */ }
                            });
                        }
                    }
                },

                close(socket) {
                    if (socket.data) {
                        cleanupDataConnection(socket.data);
                    }
                },

                error(socket, err) {
                    console.error("[FTP] Socket error:", err);
                    if (socket.data) {
                        cleanupDataConnection(socket.data);
                    }
                },
            },
        });

        console.log(`📁 FTP server listening on port ${settings.port}`);
        console.log(`   ftp://localhost:${settings.port}`);
        return { port: settings.port };
    } catch (err) {
        console.error(`❌ FTP server failed to start:`, err);
        return null;
    }
}

export function stopFtpServer(): void {
    if (ftpServer) {
        ftpServer.stop(true);
        ftpServer = null;
        console.log("📁 FTP server stopped.");
    }
}

export function isFtpRunning(): boolean {
    return ftpServer !== null;
}
