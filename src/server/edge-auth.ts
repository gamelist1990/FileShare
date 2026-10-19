import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";

export type EdgeUploadTicket = {
  v: 1;
  scope: "edge-upload";
  id: string;
  userId: string;
  session?: string;
  clientIp: string;
  size: number;
  blockBytes: number;
  expiresAt: number;
};

export function loadEdgeSecret() {
  const path = process.env.FILESHARE_EDGE_SECRET_FILE;
  if (!path)
    throw new Error("FILESHARE_EDGE_SECRET_FILE is required for edge uploads");
  const secret = readFileSync(path, "utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(secret))
    throw new Error("Invalid FileShare edge secret");
  return secret;
}

export function createEdgeUploadTicket(
  secret: string,
  ticket: EdgeUploadTicket,
) {
  const payload = Buffer.from(JSON.stringify(ticket)).toString("base64url"),
    signature = createHmac("sha256", secret)
      .update("edge-upload-v1.")
      .update(payload)
      .digest("base64url");
  return payload + "." + signature;
}

export function verifyEdgeUploadTicket(
  secret: string,
  value: string,
): EdgeUploadTicket | null {
  if (value.length > 4096) return null;
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const expected = createHmac("sha256", secret)
      .update("edge-upload-v1.")
      .update(payload)
      .digest(),
    actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    return null;
  try {
    const ticket = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as EdgeUploadTicket;
    if (
      ticket.v !== 1 ||
      ticket.scope !== "edge-upload" ||
      !/^[a-f0-9-]{36}$/.test(ticket.id) ||
      typeof ticket.userId !== "string" ||
      ticket.userId.length > 100 ||
      typeof ticket.clientIp !== "string" ||
      !isIP(ticket.clientIp) ||
      !Number.isSafeInteger(ticket.size) ||
      ticket.size < 0 ||
      ![256 * 1024, 1024 * 1024, 2 * 1024 * 1024, 8 * 1024 * 1024].includes(
        ticket.blockBytes,
      ) ||
      !Number.isSafeInteger(ticket.expiresAt) ||
      ticket.expiresAt <= Date.now()
    )
      return null;
    return ticket;
  } catch {
    return null;
  }
}

export function edgeRequestSignature(
  secret: string,
  method: string,
  path: string,
  timestamp: string,
  body: Uint8Array,
) {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return createHmac("sha256", secret)
    .update(method.toUpperCase())
    .update("\n")
    .update(path)
    .update("\n")
    .update(timestamp)
    .update("\n")
    .update(bodyHash)
    .digest("hex");
}

export function verifyEdgeRequestSignature(
  secret: string,
  method: string,
  path: string,
  timestamp: string,
  body: Uint8Array,
  signature: string,
) {
  if (!/^\d{10,13}$/.test(timestamp) || !/^[a-f0-9]{64}$/.test(signature))
    return false;
  const time = Number(timestamp),
    now = Date.now();
  if (!Number.isSafeInteger(time) || Math.abs(now - time) > 5 * 60_000)
    return false;
  const expected = Buffer.from(
      edgeRequestSignature(secret, method, path, timestamp, body),
      "hex",
    ),
    actual = Buffer.from(signature, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
