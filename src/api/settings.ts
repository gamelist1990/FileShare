import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CURRENT_SETTINGS_VERSION } from "../version";

export interface SettingsFile {
  "settings-version": number;
  modules: Record<string, unknown>;
}

interface SettingsModuleDefinition<T> {
  defaultValue: T;
}

type SettingsMigration = (raw: any) => any;

const moduleRegistry = new Map<string, SettingsModuleDefinition<unknown>>();
const migrationRegistry = new Map<number, SettingsMigration>();

let settingsFilePath = "";
let currentSettings: SettingsFile = {
  "settings-version": CURRENT_SETTINGS_VERSION,
  modules: {},
};

export function registerSettingsModule<T>(name: string, defaultValue: T): void {
  moduleRegistry.set(name, { defaultValue });
}

/**
 * Register migration function for transition: fromVersion -> fromVersion + 1.
 */
export function registerSettingsMigration(fromVersion: number, migration: SettingsMigration): void {
  migrationRegistry.set(fromVersion, migration);
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function mergeModuleDefaults(rawModules: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...rawModules };
  for (const [name, def] of moduleRegistry.entries()) {
    if (merged[name] === undefined) {
      merged[name] = deepClone(def.defaultValue);
    }
  }
  return merged;
}

function normalizeAndMigrate(raw: any): SettingsFile {
  let normalized: SettingsFile;
  const rawVersion = Number(raw?.["settings-version"]);
  const hasNumericVersion = Number.isFinite(rawVersion);

  // Legacy (v0): plain object with module keys directly.
  if (!raw || typeof raw !== "object") {
    normalized = { "settings-version": 0, modules: {} };
  } else if (!hasNumericVersion) {
    normalized = {
      "settings-version": 0,
      modules: { ...raw },
    };
  } else {
    normalized = {
      "settings-version": Math.floor(rawVersion),
      modules: (raw.modules && typeof raw.modules === "object") ? raw.modules : {},
    };
  }

  while (normalized["settings-version"] < CURRENT_SETTINGS_VERSION) {
    const fromVersion = normalized["settings-version"];
    const migration = migrationRegistry.get(fromVersion);
    if (migration) {
      const migrated = migration(normalized);
      normalized = {
        "settings-version": fromVersion + 1,
        modules: (migrated?.modules && typeof migrated.modules === "object")
          ? migrated.modules
          : {},
      };
    } else {
      normalized = {
        "settings-version": fromVersion + 1,
        modules: normalized.modules,
      };
    }
  }

  normalized.modules = mergeModuleDefaults(normalized.modules);
  return normalized;
}

function persistSettings(): void {
  if (!settingsFilePath) return;
  try {
    const dir = dirname(settingsFilePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(settingsFilePath, JSON.stringify(currentSettings, null, 2), "utf-8");
  } catch (err) {
    console.error("⚠️  settings.json の保存に失敗:", err);
  }
}

/** Initialize settings from <sharePath>/.fileshare/settings.json */
export function initSettings(sharePath: string): void {
  const settingsDir = join(sharePath, ".fileshare");
  settingsFilePath = join(settingsDir, "settings.json");

  if (!existsSync(settingsDir)) {
    mkdirSync(settingsDir, { recursive: true });
  }

  let raw: any = null;
  if (existsSync(settingsFilePath)) {
    try {
      raw = JSON.parse(readFileSync(settingsFilePath, "utf-8"));
    } catch (err) {
      console.error("⚠️  settings.json の読み込みに失敗。デフォルトで再生成します:", err);
      raw = null;
    }
  }

  currentSettings = normalizeAndMigrate(raw);
  persistSettings();
  console.log(`⚙️  設定を読み込みました (v${currentSettings["settings-version"]}): ${settingsFilePath}`);
}

export function getModuleSettings<T>(name: string): T {
  const fromSettings = currentSettings.modules[name];
  if (fromSettings !== undefined) {
    return deepClone(fromSettings as T);
  }
  const def = moduleRegistry.get(name);
  if (!def) {
    throw new Error(`Settings module not registered: ${name}`);
  }
  return deepClone(def.defaultValue as T);
}
