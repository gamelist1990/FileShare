// IPv6-only HTTPS / WebSocket transport gateway.
// Runs separately from FileShare and forwards a genuine PROXY v2 source identity.
// The FileShare backend MUST explicitly trust the gateway's loopback/Tailscale
// source; do not point this at arbitrary servers or bind it to an IPv4 wildcard.
import tls from "node:tls";
import net from "node:net";
import { readFileSync } from "node:fs";

const bind = process.env.FILESHARE_DIRECT_IPV6_BIND;
const listenPort = Number(process.env.FILESHARE_DIRECT_IPV6_PORT || "8443");
const backendHost = process.env.FILESHARE_DIRECT_BACKEND || "100.69.76.52";
const backendPort = Number(process.env.FILESHARE_DIRECT_BACKEND_PORT || "8100");
const localAddress = process.env.FILESHARE_DIRECT_SOURCE || "100.69.76.52";
const maxConnections = Number(process.env.FILESHARE_DIRECT_MAX_CONNECTIONS || "64");
const certificate = process.env.FILESHARE_DIRECT_TLS_CERT;
const key = process.env.FILESHARE_DIRECT_TLS_KEY;
if (
  !bind || net.isIP(bind) !== 6 ||
  !certificate || !key || net.isIP(localAddress) !== 4 ||
  !Number.isSafeInteger(listenPort) || listenPort < 1 || listenPort > 65535 ||
  !Number.isSafeInteger(backendPort) || backendPort < 1 || backendPort > 65535 ||
  !Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 4096
) throw new Error("Invalid direct IPv6 gateway configuration");

function ipv6Bytes(address) {
  const value = address.replace(/%.+$/, "").toLowerCase();
  if (net.isIP(value) !== 6 || value.includes(".")) throw new Error("Unsupported IPv6 address");
  const halves = value.split("::");
  if (halves.length > 2) throw new Error("Invalid IPv6");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1))
    throw new Error("Invalid IPv6 size");
  const values = [...left, ...Array(missing).fill("0"), ...right];
  if (values.length !== 8) throw new Error("Invalid IPv6 values");
  const b = Buffer.alloc(16);
  values.forEach((v, i) => {
    if (!/^[a-f0-9]{1,4}$/.test(v)) throw new Error("Invalid IPv6 segment");
    b.writeUInt16BE(parseInt(v, 16), i * 2);
  });
  return b;
}
function proxyHeader(client) {
  const header = Buffer.alloc(16 + 36);
  Buffer.from([13,10,13,10,0,13,10,81,85,73,84,10]).copy(header, 0);
  header[12] = 0x21; // PROXY version 2
  header[13] = 0x21; // TCP6
  header.writeUInt16BE(36, 14);
  ipv6Bytes(client.remoteAddress || "").copy(header, 16);
  ipv6Bytes(bind).copy(header, 32);
  header.writeUInt16BE(client.remotePort || 0, 48);
  header.writeUInt16BE(listenPort, 50);
  return header;
}
let active = 0;
const server = tls.createServer({
  key: readFileSync(key),
  cert: readFileSync(certificate),
  minVersion: "TLSv1.2",
  ALPNProtocols: ["http/1.1"],
  handshakeTimeout: 8000,
}, (client) => {
  if (net.isIP(client.remoteAddress || "") !== 6 || active >= maxConnections) {
    client.destroy();
    return;
  }
  active++;
  let closed = false;
  const release = () => {
    if (closed) return;
    closed = true;
    active--;
  };
  const upstream = net.createConnection({
    host: backendHost, port: backendPort, localAddress,
  });
  client.setNoDelay(true);
  upstream.setNoDelay(true);
  client.setTimeout(180000, () => client.destroy());
  upstream.setTimeout(180000, () => upstream.destroy());
  upstream.on("connect", () => {
    try {
      upstream.write(proxyHeader(client));
      client.pipe(upstream);
      upstream.pipe(client);
    } catch { client.destroy(); upstream.destroy(); }
  });
  upstream.on("error", () => client.destroy());
  client.on("error", () => upstream.destroy());
  upstream.on("close", () => client.destroy());
  client.on("close", () => { release(); upstream.destroy(); });
});
server.on("tlsClientError", () => {}); // Hostile/partial handshakes are normal on public listeners.
server.on("error", (error) => {
  console.error("direct-ipv6: cannot listen:", error.message);
  process.exitCode = 1;
});
server.listen({ host: bind, port: listenPort, ipv6Only: true }, () => {
  console.log("FileShare direct IPv6 gateway listening", bind, listenPort);
});
