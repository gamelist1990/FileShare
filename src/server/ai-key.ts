import { isIP } from "node:net";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
export function encryptKey(value: string, secret: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv(
      "aes-256-gcm",
      createHash("sha256").update(secret).digest(),
      iv,
    );
  return JSON.stringify({
    iv: iv.toString("base64"),
    body: Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]).toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  });
}
export function decryptKey(value: string, secret: string) {
  const v = JSON.parse(value),
    d = createDecipheriv(
      "aes-256-gcm",
      createHash("sha256").update(secret).digest(),
      Buffer.from(v.iv, "base64"),
    );
  d.setAuthTag(Buffer.from(v.tag, "base64"));
  return Buffer.concat([
    d.update(Buffer.from(v.body, "base64")),
    d.final(),
  ]).toString("utf8");
}
export function validateEndpoint(raw: unknown) {
  if (typeof raw !== "string" || raw.length > 2048)
    throw Error("Endpointを確認してください");
  const u = new URL(raw);
  const hostname = u.hostname.replace(/^\[|\]$/g, "");
  const internal =
    hostname === "localhost" ||
    hostname === "::1" ||
    (isIP(hostname) === 4 &&
      /^(127\.|10\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|172\.(1[6-9]|2\d|3[01])\.)/.test(
        hostname,
      ));
  if (
    !["https:", "http:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    /^(169\.254\.|0\.|metadata\.)/.test(u.hostname) ||
    u.hostname === "metadata.google.internal" ||
    (u.protocol === "http:" && !internal)
  )
    throw Error("HTTPSまたは内部ネットワークのEndpointを指定してください");
  u.pathname = u.pathname.replace(/\/$/, "");
  if (!u.pathname.endsWith("/chat/completions"))
    u.pathname += "/chat/completions";
  return u.href;
}
