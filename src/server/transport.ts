import net from "node:net";
import http from "node:http";
import type { Config } from "./config";
const SIGNATURE = Buffer.from([13, 10, 13, 10, 0, 13, 10, 81, 85, 73, 84, 10]);
export const normalizeIp = (ip: string) => {
  const s = ip.replace(/^::ffff:/, "");
  if (net.isIP(s) === 6) return new URL(`http://[${s}]/`).hostname.slice(1, -1);
  return s;
};
export function parseProxy(
  data: Buffer,
): { ip: string; length: number } | null {
  if (data.length < 16) return null;
  if (
    !data.subarray(0, 12).equals(SIGNATURE) ||
    data[12] !== 0x21 ||
    ![0x11, 0x21].includes(data[13])
  )
    throw new Error("Invalid PROXY v2");
  const n = data.readUInt16BE(14),
    min = data[13] === 0x11 ? 12 : 36;
  if (n < min || n > 512) throw new Error("Invalid address length");
  if (data.length < 16 + n) return null;
  let ip: string;
  if (min === 12) ip = [...data.subarray(16, 20)].join(".");
  else
    ip = Array.from({ length: 8 }, (_, i) =>
      data.readUInt16BE(16 + i * 2).toString(16),
    ).join(":");
  // Validate all optional TLVs; never treat nested headers as another trusted identity.
  for (let i = 16 + min; i < 16 + n;) {
    if (i + 3 > 16 + n) throw new Error("Invalid TLV");
    const end = i + 3 + data.readUInt16BE(i + 1);
    if (end > 16 + n) throw new Error("Invalid TLV");
    i = end;
  }
  return { ip: normalizeIp(ip), length: 16 + n };
}
const errorPage =
  '<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>通信プロトコルエラー | PEXserver</title><body style="background:#f6f3ea;color:#25282e;font-family:system-ui;padding:10vw"><p style="color:#a7472b">PEXserver / FileShare</p><h1>有効な通信プロトコルではありません</h1><p>このサービスには正規のプロキシ経由でアクセスしてください。</p></body></html>';
function reject(socket: net.Socket) {
  socket.end(
    `HTTP/1.1 400 Bad Request\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(errorPage)}\r\nConnection: close\r\n\r\n${errorPage}`,
  );
}
export function createTransport(config: Config, httpServer: http.Server) {
  const sockets = new Set<net.Socket>();
  const peers = new Map<string, number>();
  const server = net.createServer({ pauseOnConnect: true }, (socket) => {
    const peer = normalizeIp(socket.remoteAddress ?? "");
    const count = peers.get(peer) ?? 0;
    if (
      sockets.size >= config.rate.maxConnections ||
      count >= (config.proxy.enabled ? config.rate.maxConnections : 32)
    ) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    peers.set(peer, count + 1);
    socket.on("close", () => {
      sockets.delete(socket);
      const n = (peers.get(peer) ?? 1) - 1;
      if (n) peers.set(peer, n);
      else peers.delete(peer);
    });
    socket.on("error", () => socket.destroy());
    socket.setNoDelay(true);
    if (!config.proxy.enabled) {
      (socket as any).clientIp = peer;
      httpServer.emit("connection", socket);
      socket.resume();
      return;
    }
    if (!config.proxy.trustedPeers.map(normalizeIp).includes(peer)) {
      reject(socket);
      return;
    }
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => socket.destroy(), 5000);
    timer.unref();
    socket.once("close", () => clearTimeout(timer));
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        const prefixLength = Math.min(buffer.length, 12);
        if (
          !buffer
            .subarray(0, prefixLength)
            .equals(SIGNATURE.subarray(0, prefixLength))
        )
          throw new Error("Missing PROXY");
        const parsed = parseProxy(buffer);
        if (!parsed) return;
        socket.pause();
        socket.removeListener("data", onData);
        clearTimeout(timer);
        (socket as any).clientIp = parsed.ip;
        const rest = buffer.subarray(parsed.length);
        if (rest.length) socket.unshift(rest);
        httpServer.emit("connection", socket);
        socket.resume();
      } catch {
        socket.removeListener("data", onData);
        clearTimeout(timer);
        reject(socket);
      }
    };
    socket.on("data", onData);
    socket.resume();
  });
  return {
    server,
    close() {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}
