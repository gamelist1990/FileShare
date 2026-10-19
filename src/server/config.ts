import { readFileSync } from "node:fs";
import { resolve } from "node:path";
export interface Config {
  http3Port: number;
  host: string;
  port: number;
  origin: string;
  dataDir: string;
  capacityBytes: number;
  vipQuotaBytes: number;
  proxy: { enabled: boolean; trustedPeers: string[] };
  registration: {
    enabled: boolean;
    accountsPerIp: number;
    attemptsPerHour: number;
  };
  rate: {
    requestsPerMinute: number;
    globalRequestsPerMinute: number;
    authPerMinute: number;
    concurrentTransfersPerIp: number;
    maxConnections: number;
    maxBytesPerSecond: number;
  };
  preview: {
    enabled: boolean;
    ffmpeg: string;
    threads: number;
    maxSeconds: number;
    cacheBytes: number;
  };
  ai: {
    enabled: boolean;
    endpoint: string;
    model: string;
    intervalSeconds: number;
  };
}
export const defaults: Config = {
  http3Port: 0,
  host: "127.0.0.1",
  port: 8100,
  origin: "http://localhost:8100",
  dataDir: "./data",
  capacityBytes: 200_000_000_000,
  vipQuotaBytes: 5_000_000_000,
  proxy: { enabled: false, trustedPeers: ["127.0.0.1", "::1"] },
  registration: { enabled: true, accountsPerIp: 1, attemptsPerHour: 5 },
  rate: {
    requestsPerMinute: 600,
    globalRequestsPerMinute: 6000,
    authPerMinute: 20,
    concurrentTransfersPerIp: 3,
    maxConnections: 512,
    maxBytesPerSecond: 50_000_000,
  },
  preview: {
    enabled: true,
    ffmpeg: "ffmpeg",
    threads: 2,
    maxSeconds: 120,
    cacheBytes: 2_000_000_000,
  },
  ai: {
    enabled: false,
    endpoint: "http://127.0.0.1:18081/v1/chat/completions",
    model: "gemma4",
    intervalSeconds: 60,
  },
};
export function loadConfig(file = process.env.FILESHARE_CONFIG): Config {
  const raw = file ? JSON.parse(readFileSync(file, "utf8")) : {};
  const c = {
    ...defaults,
    ...raw,
    proxy: { ...defaults.proxy, ...raw.proxy },
    registration: { ...defaults.registration, ...raw.registration },
    rate: { ...defaults.rate, ...raw.rate },
    preview: { ...defaults.preview, ...raw.preview },
    ai: { ...defaults.ai, ...raw.ai },
  } as Config;
  const url = new URL(c.origin);
  if (
    !Number.isSafeInteger(c.http3Port) ||
    c.http3Port < 0 ||
    c.http3Port > 65535 ||
    (c.http3Port && url.protocol !== "https:")
  )
    throw new Error("http3Port must be 0 (disabled) or an HTTPS UDP port");
  if (
    url.origin !== c.origin ||
    (url.protocol !== "https:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  )
    throw new Error("origin must be HTTPS (localhost allowed for development)");
  for (const n of [
    c.port,
    c.capacityBytes,
    c.vipQuotaBytes,
    ...Object.values(c.rate),
    c.registration.accountsPerIp,
    c.registration.attemptsPerHour,
    c.preview.threads,
    c.preview.maxSeconds,
    c.preview.cacheBytes,
    c.ai.intervalSeconds,
  ])
    if (!Number.isSafeInteger(n) || n < 1)
      throw new Error("Invalid numeric configuration");
  if (
    c.port > 65535 ||
    c.vipQuotaBytes > c.capacityBytes ||
    c.preview.cacheBytes >= c.capacityBytes
  )
    throw new Error("Invalid capacity or port");
  if (c.proxy.enabled && !c.proxy.trustedPeers.length)
    throw new Error("PROXY v2 requires trustedPeers");
  c.dataDir = resolve(c.dataDir);
  return c;
}
