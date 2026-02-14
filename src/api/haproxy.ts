import { getModuleSettings, registerSettingsMigration, registerSettingsModule } from "./settings";

const PROXY_V2_SIGNATURE = Buffer.from([
  0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51,
  0x55, 0x49, 0x54, 0x0a,
]);

export interface HAProxySettings {
  proxyProtocolV2: boolean;
}

export interface HAProxyEnforcementResult {
  ok: boolean;
  reason?: string;
}

export interface ProxyV2Header {
  version: number;
  command: "LOCAL" | "PROXY";
  family: "UNSPEC" | "INET" | "INET6" | "UNIX";
  protocol: "UNSPEC" | "STREAM" | "DGRAM";
  sourceAddress: string;
  destAddress: string;
  sourcePort: number;
  destPort: number;
  headerLength: number;
}

const SETTINGS_KEY = "haproxy";
const PROXY_V2_HEADER_NAME = "x-proxy-protocol-v2";

const DEFAULT_HAPROXY_SETTINGS: HAProxySettings = {
  proxyProtocolV2: false,
};

export function registerHAProxySettings(): void {
  registerSettingsModule<HAProxySettings>(SETTINGS_KEY, DEFAULT_HAPROXY_SETTINGS);

  // v1 -> v2: compact haproxy settings to only { proxyProtocolV2 }
  registerSettingsMigration(1, (raw: any) => {
    const modules: Record<string, any> = {
      ...(raw?.modules && typeof raw.modules === "object" ? raw.modules : {}),
    };
    const prev = modules[SETTINGS_KEY];
    modules[SETTINGS_KEY] = {
      proxyProtocolV2: Boolean(prev?.proxyProtocolV2),
    };
    return { ...raw, modules };
  });
}

function getHAProxySettings(): HAProxySettings {
  const raw = getModuleSettings<HAProxySettings>(SETTINGS_KEY);
  return {
    proxyProtocolV2: Boolean(raw?.proxyProtocolV2),
  };
}

export function isHAProxyProxyProtocolV2Enabled(): boolean {
  return getHAProxySettings().proxyProtocolV2;
}

export function isProxyV2(data: Buffer): boolean {
  if (data.length < PROXY_V2_SIGNATURE.length) return false;
  return data.subarray(0, PROXY_V2_SIGNATURE.length).equals(PROXY_V2_SIGNATURE);
}

export function parseProxyV2(data: Buffer): ProxyV2Header | null {
  if (!isProxyV2(data)) return null;
  if (data.length < 16) return null;

  const versionAndCommand = data[12];
  const version = (versionAndCommand & 0xf0) >> 4;
  const commandBit = versionAndCommand & 0x0f;
  const command = commandBit === 0x01 ? "PROXY" : "LOCAL";

  const familyAndProtocol = data[13];
  const familyBit = (familyAndProtocol & 0xf0) >> 4;
  const protocolBit = familyAndProtocol & 0x0f;

  let family: ProxyV2Header["family"] = "UNSPEC";
  if (familyBit === 0x1) family = "INET";
  else if (familyBit === 0x2) family = "INET6";
  else if (familyBit === 0x3) family = "UNIX";

  let protocol: ProxyV2Header["protocol"] = "UNSPEC";
  if (protocolBit === 0x1) protocol = "STREAM";
  else if (protocolBit === 0x2) protocol = "DGRAM";

  const addressLength = data.readUInt16BE(14);
  const totalHeaderLength = 16 + addressLength;
  if (data.length < totalHeaderLength) return null;

  let src = "";
  let dst = "";
  let srcPort = 0;
  let dstPort = 0;

  if (family === "INET" && (protocol === "STREAM" || protocol === "DGRAM")) {
    if (addressLength >= 12) {
      src = `${data[16]}.${data[17]}.${data[18]}.${data[19]}`;
      dst = `${data[20]}.${data[21]}.${data[22]}.${data[23]}`;
      srcPort = data.readUInt16BE(24);
      dstPort = data.readUInt16BE(26);
    }
  } else if (family === "INET6" && (protocol === "STREAM" || protocol === "DGRAM")) {
    if (addressLength >= 36) {
      const srcBuf = data.subarray(16, 32);
      const dstBuf = data.subarray(32, 48);
      src = formatIPv6(srcBuf);
      dst = formatIPv6(dstBuf);
      srcPort = data.readUInt16BE(48);
      dstPort = data.readUInt16BE(50);
    }
  }

  return {
    version,
    command,
    family,
    protocol,
    sourceAddress: src,
    destAddress: dst,
    sourcePort: srcPort,
    destPort: dstPort,
    headerLength: totalHeaderLength,
  };
}

export function parseProxyV2Chain(data: Buffer): { headers: ProxyV2Header[]; payload: Buffer } {
  const headers: ProxyV2Header[] = [];
  let offset = 0;
  let iteration = 0;
  const MAX_ITER = 32;

  while (offset < data.length && iteration < MAX_ITER) {
    const chunk = data.subarray(offset);
    if (!isProxyV2(chunk)) break;
    const hdr = parseProxyV2(chunk);
    if (!hdr) break;
    headers.push(hdr);
    offset += hdr.headerLength;
    iteration++;
  }

  return {
    headers,
    payload: data.subarray(offset),
  };
}

export function getOriginalClientFromHeaders(headers: ProxyV2Header[]): { ip: string; port: number } | null {
  if (!headers.length) return null;
  const last = headers[headers.length - 1];
  if (!last?.sourceAddress) return null;
  return { ip: last.sourceAddress, port: last.sourcePort };
}

function formatIPv6(buf: Buffer): string {
  const parts: string[] = [];
  for (let i = 0; i < 16; i += 2) {
    parts.push(buf.readUInt16BE(i).toString(16));
  }
  return parts.join(":");
}

function decodeProxyHeaderValue(value: string): Buffer | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  // Hex support: "0d0a..." or "0x0d0a..."
  const hexCandidate = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
  if (/^[0-9a-fA-F]+$/.test(hexCandidate) && hexCandidate.length % 2 === 0) {
    try {
      return Buffer.from(hexCandidate, "hex");
    } catch {
      // fall through
    }
  }

  // Base64 support
  try {
    const buf = Buffer.from(trimmed, "base64");
    if (buf.length > 0) return buf;
  } catch {
    // ignore
  }

  return null;
}

function hasForwardedHeaders(request: Request): boolean {
  const fwd = request.headers.get("x-forwarded-for")?.trim();
  if (fwd) return true;
  const real = request.headers.get("x-real-ip")?.trim();
  return Boolean(real);
}

function hasValidProxyV2Header(request: Request): boolean {
  const encoded = request.headers.get(PROXY_V2_HEADER_NAME);
  if (!encoded) return false;
  const buf = decodeProxyHeaderValue(encoded);
  if (!buf) return false;
  const chain = parseProxyV2Chain(buf);
  const orig = getOriginalClientFromHeaders(chain.headers);
  return Boolean(orig?.ip);
}

export function validateHAProxyTransport(request: Request): HAProxyEnforcementResult {
  const settings = getHAProxySettings();
  if (!settings.proxyProtocolV2) {
    return { ok: true };
  }

  // Accept either explicit parsed proxy-v2 header or standard forwarded headers.
  if (hasValidProxyV2Header(request) || hasForwardedHeaders(request)) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: "HAProxy (Proxy Protocol v2) が有効なため、プロキシ経由の接続のみ許可されています",
  };
}

/**
 * Resolve original client IP from HAProxy-related headers when enabled.
 *
 * Note: Bun's HTTP API does not expose raw TCP bytes, so proxy protocol v2 is
 * expected via configured header (base64/hex encoded) from an upstream adapter.
 */
export function resolveClientIpFromHAProxy(request: Request): string | null {
  const settings = getHAProxySettings();
  if (!settings.proxyProtocolV2) return null;

  const encoded = request.headers.get(PROXY_V2_HEADER_NAME);
  if (encoded) {
    const buf = decodeProxyHeaderValue(encoded);
    if (buf) {
      const chain = parseProxyV2Chain(buf);
      const orig = getOriginalClientFromHeaders(chain.headers);
      if (orig?.ip) return orig.ip;
    }
  }

  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) {
    const ip = fwd.split(",")[0]?.trim();
    if (ip) return ip;
  }

  const real = request.headers.get("x-real-ip");
  if (real) {
    const ip = real.trim();
    if (ip) return ip;
  }

  return null;
}
