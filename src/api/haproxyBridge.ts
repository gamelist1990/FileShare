import net from "node:net";
import {
  getOriginalClientFromHeaders,
  isProxyV2,
  parseProxyV2Chain,
} from "./haproxy";

interface BridgeOptions {
  listenHost: string;
  listenPort: number;
  targetHost: string;
  targetPort: number;
}

const HEADER_END = Buffer.from("\r\n\r\n", "utf8");
const MAX_HTTP_HEADER_BUFFER = 128 * 1024;

function makeProxyRequiredHtml(): string {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>HAProxy 経由が必要です</title>
  <style>
    body { font-family: Inter, Segoe UI, Roboto, sans-serif; margin: 0; background: #0f172a; color: #e2e8f0; }
    .wrap { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
    .card { max-width: 760px; width: 100%; background: #111827; border: 1px solid #334155; border-radius: 12px; padding: 24px; }
    h1 { margin: 0 0 12px; font-size: 24px; }
    p { margin: 8px 0; line-height: 1.6; color: #cbd5e1; }
    code { background: #1e293b; padding: 2px 6px; border-radius: 6px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>HAProxy 経由のアクセスが必要です</h1>
      <p>このサーバーは <strong>Proxy Protocol v2</strong> で動作中です。</p>
      <p>HAProxy / プロキシツール経由で接続してください。</p>
    </div>
  </div>
</body>
</html>`;
}

function writeProxyRequiredResponse(socket: net.Socket): void {
  const html = makeProxyRequiredHtml();
  const body = Buffer.from(html, "utf8");
  const head = [
    "HTTP/1.1 400 Bad Request",
    "Content-Type: text/html; charset=utf-8",
    `Content-Length: ${body.length}`,
    "Connection: close",
    "",
    "",
  ].join("\r\n");
  socket.write(Buffer.concat([Buffer.from(head, "utf8"), body]));
  socket.end();
}

function injectForwardHeaders(payload: Buffer, clientIp: string): Buffer {
  const idx = payload.indexOf(HEADER_END);
  if (idx < 0) return payload;

  const headerPart = payload.subarray(0, idx).toString("utf8");
  const bodyPart = payload.subarray(idx + 4);

  const lines = headerPart.split("\r\n");
  if (lines.length === 0) return payload;

  const reqLine = lines[0];
  const existing = lines.slice(1);

  // Bridge is trust boundary: always overwrite upstream-forwarded client IP headers
  // with the parsed Proxy Protocol v2 source IP.
  const outHeaders = existing.filter(
    (h) => !/^x-forwarded-for\s*:/i.test(h) && !/^x-real-ip\s*:/i.test(h)
  );
  outHeaders.push(`x-forwarded-for: ${clientIp}`);
  outHeaders.push(`x-real-ip: ${clientIp}`);

  const rebuilt = `${reqLine}\r\n${outHeaders.join("\r\n")}\r\n\r\n`;
  return Buffer.concat([Buffer.from(rebuilt, "utf8"), bodyPart]);
}

export function startHAProxyBridge(options: BridgeOptions): net.Server {
  const server = net.createServer((clientSocket) => {
    let buffer = Buffer.alloc(0);
    let initialized = false;
    let awaitingHttpHeaders = false;
    let connectingUpstream = false;
    let pendingAfterConnect = Buffer.alloc(0);
    let resolvedClientIp = "";
    let upstream: net.Socket | null = null;

    const cleanup = () => {
      if (upstream && !upstream.destroyed) upstream.destroy();
      if (!clientSocket.destroyed) clientSocket.destroy();
    };

    const initUpstream = (initialPayload: Buffer, clientIp: string) => {
      if (initialized || connectingUpstream) return;
      connectingUpstream = true;

      upstream = net.createConnection({
        host: options.targetHost,
        port: options.targetPort,
      });

      upstream.on("connect", () => {
        initialized = true;
        connectingUpstream = false;
        if (initialPayload.length > 0) {
          upstream!.write(injectForwardHeaders(initialPayload, clientIp));
        }
        if (pendingAfterConnect.length > 0) {
          upstream!.write(pendingAfterConnect);
          pendingAfterConnect = Buffer.alloc(0);
        }

        clientSocket.removeListener("data", onData);
        clientSocket.pipe(upstream!);
        upstream!.pipe(clientSocket);
      });

      upstream.on("error", () => cleanup());
      upstream.on("close", () => {
        if (!clientSocket.destroyed) clientSocket.end();
      });
    };

    const tryInitializeFromHttpHeaders = () => {
      if (!awaitingHttpHeaders || initialized || connectingUpstream) return;

      if (buffer.length > MAX_HTTP_HEADER_BUFFER) {
        clientSocket.removeListener("data", onData);
        writeProxyRequiredResponse(clientSocket);
        return;
      }

      const headerIdx = buffer.indexOf(HEADER_END);
      if (headerIdx < 0) return;

      const initialPayload = buffer;
      buffer = Buffer.alloc(0);
      initUpstream(initialPayload, resolvedClientIp);
    };

    const onData = (chunk: Buffer) => {
      if (initialized) return;

      if (connectingUpstream) {
        pendingAfterConnect = Buffer.concat([pendingAfterConnect, chunk]);
        return;
      }

      buffer = Buffer.concat([buffer, chunk]);

      if (awaitingHttpHeaders) {
        tryInitializeFromHttpHeaders();
        return;
      }

      // Need enough bytes to determine signature + v2 length
      if (buffer.length < 16) return;

      if (!isProxyV2(buffer)) {
        clientSocket.removeListener("data", onData);
        writeProxyRequiredResponse(clientSocket);
        return;
      }

      const addrLen = buffer.readUInt16BE(14);
      const firstHeaderLen = 16 + addrLen;
      if (buffer.length < firstHeaderLen) return;

      const parsed = parseProxyV2Chain(buffer);
      const orig = getOriginalClientFromHeaders(parsed.headers);
      if (!orig?.ip) {
        clientSocket.removeListener("data", onData);
        writeProxyRequiredResponse(clientSocket);
        return;
      }

      resolvedClientIp = orig.ip;
      buffer = Buffer.from(parsed.payload);
      awaitingHttpHeaders = true;
      tryInitializeFromHttpHeaders();
    };

    clientSocket.on("data", onData);
    clientSocket.on("error", () => cleanup());
    clientSocket.on("close", () => {
      if (upstream && !upstream.destroyed) upstream.end();
    });
  });

  server.listen(options.listenPort, options.listenHost, () => {
    console.log(`HAProxy bridge listening on ${options.listenHost}:${options.listenPort} -> ${options.targetHost}:${options.targetPort}`);
  });

  server.on("error", (err) => {
    console.error("HAProxy bridge error:", err);
  });

  return server;
}
