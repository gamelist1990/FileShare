import { getModuleSettings, registerSettingsMigration, registerSettingsModule } from "./settings";

export type RateLimitTarget = "upload" | "download" | "disk" | "list" | "status" | "auth" | "fileops";

interface RateLimitRule {
  enabled: boolean;
  maxRequests: number;
  windowMs: number;
}

interface RateLimitSettings {
  upload: RateLimitRule;
  download: RateLimitRule;
  // New API-specific rules (default disabled)
  disk: RateLimitRule;     // /api/disk
  list: RateLimitRule;     // /api/list
  status: RateLimitRule;   // /api/status
  auth: RateLimitRule;     // /api/auth/login, /api/auth/register
  fileops: RateLimitRule;  // /api/mkdir, /api/rename, /api/delete
}

interface RateLimitBucket {
  count: number;
  windowStart: number;
}

interface RateLimitCheckResult {
  allowed: boolean;
  retryAfterSec?: number;
  limit?: number;
  remaining?: number;
}

const SETTINGS_KEY = "ratelimit";

const bucketsByKey = new Map<string, RateLimitBucket>();

const DEFAULT_RATE_LIMIT_SETTINGS: RateLimitSettings = {
  upload: {
    enabled: false,
    maxRequests: 30,
    windowMs: 60_000,
  },
  download: {
    enabled: false,
    maxRequests: 120,
    windowMs: 60_000,
  },
  // Sensible defaults (disabled) — operators can enable/tune per module
  disk: {
    enabled: false,
    maxRequests: 30,
    windowMs: 60_000,
  },
  list: {
    enabled: false,
    maxRequests: 60,
    windowMs: 60_000,
  },
  status: {
    enabled: false,
    maxRequests: 60,
    windowMs: 60_000,
  },
  auth: {
    enabled: false,
    maxRequests: 10,
    windowMs: 60_000,
  },
  fileops: {
    enabled: false,
    maxRequests: 30,
    windowMs: 60_000,
  },
};

export function registerRateLimitSettings(): void {
  registerSettingsModule<RateLimitSettings>(SETTINGS_KEY, DEFAULT_RATE_LIMIT_SETTINGS);
}

function getRule(target: RateLimitTarget): RateLimitRule {
  const settings = getModuleSettings<RateLimitSettings>(SETTINGS_KEY);
  const rule = settings[target];
  return {
    enabled: Boolean(rule?.enabled),
    maxRequests: Math.max(1, Math.floor(Number(rule?.maxRequests ?? 1))),
    windowMs: Math.max(1_000, Math.floor(Number(rule?.windowMs ?? 60_000))),
  };
}

export function checkIpRateLimit(target: RateLimitTarget, ip: string): RateLimitCheckResult {
  const rule = getRule(target);
  if (!rule.enabled) {
    return { allowed: true };
  }

  const now = Date.now();
  const key = `${target}:${ip}`;
  const bucket = bucketsByKey.get(key);

  if (!bucket || (now - bucket.windowStart) >= rule.windowMs) {
    bucketsByKey.set(key, { count: 1, windowStart: now });
    return {
      allowed: true,
      limit: rule.maxRequests,
      remaining: Math.max(0, rule.maxRequests - 1),
    };
  }

  if (bucket.count >= rule.maxRequests) {
    const retryAfterMs = Math.max(0, rule.windowMs - (now - bucket.windowStart));
    return {
      allowed: false,
      retryAfterSec: Math.ceil(retryAfterMs / 1000),
      limit: rule.maxRequests,
      remaining: 0,
    };
  }

  bucket.count += 1;
  bucketsByKey.set(key, bucket);
  return {
    allowed: true,
    limit: rule.maxRequests,
    remaining: Math.max(0, rule.maxRequests - bucket.count),
  };
}
