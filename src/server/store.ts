import { Database } from "bun:sqlite";
import {
  mkdirSync,
  chmodSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  generateKey,
  randomToken,
  digestToken,
} from "@pexserver/secure-envelope";
import type { Config } from "./config";
import {
  defaultRegistrationPolicy,
  validateRegistrationPolicy,
  type RegistrationPolicy,
  validateAISettings,
  validateFilePolicy,
  defaultFilePolicy,
  type FilePolicy,
} from "./settings";
export const ITEM_SELECT =
  "SELECT i.*,m.uploaded_by,m.expires_at,m.downloads,m.purged,u.name AS uploader_name FROM items i LEFT JOIN item_meta m ON m.item_id=i.id LEFT JOIN users u ON u.id=m.uploaded_by";
export interface User {
  id: string;
  name: string;
  level: number;
  status: string;
  quota: number;
  ip: string;
  created: number;
}
export interface Item {
  id: string;
  parent: string | null;
  owner: string | null;
  name: string;
  folder: number;
  size: number;
  mime: string;
  visibility: string;
  min_level: number;
  key_hash: string | null;
  created: number;
  deleted: number | null;
  uploaded_by?: string | null;
  uploader_name?: string | null;
  expires_at?: number | null;
  downloads?: number;
  purged?: number;
}
export class Store {
  registrationPolicy: RegistrationPolicy = { ...defaultRegistrationPolicy };
  filePolicy: FilePolicy;
  db: Database;
  secret: string;
  blobDir: string;
  tempDir: string;
  cacheDir: string;
  constructor(public config: Config) {
    this.filePolicy = {
      ...defaultFilePolicy,
      maxFileBytes: Math.min(
        defaultFilePolicy.maxFileBytes,
        config.capacityBytes,
      ),
    };
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    chmodSync(config.dataDir, 0o700);
    this.blobDir = join(config.dataDir, "blobs");
    this.tempDir = join(config.dataDir, "uploads");
    this.cacheDir = join(config.dataDir, "previews");
    for (const dir of [this.blobDir, this.tempDir, this.cacheDir])
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    const keyPath = join(config.dataDir, "envelope.key");
    if (!existsSync(keyPath))
      writeFileSync(keyPath, generateKey(), { mode: 0o600, flag: "wx" });
    chmodSync(keyPath, 0o600);
    this.secret = readFileSync(keyPath, "utf8").trim();
    this.db = new Database(join(config.dataDir, "fileshare.sqlite"), {
      create: true,
      strict: true,
    });
    chmodSync(join(config.dataDir, "fileshare.sqlite"), 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, level INTEGER NOT NULL CHECK(level BETWEEN 0 AND 4), status TEXT NOT NULL, quota INTEGER NOT NULL, ip TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS credentials (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), public_key BLOB NOT NULL, counter INTEGER NOT NULL, transports TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS device_enrollments (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, kind TEXT NOT NULL, user_id TEXT, challenge TEXT NOT NULL, ip TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, parent TEXT REFERENCES items(id), owner TEXT REFERENCES users(id), name TEXT NOT NULL, folder INTEGER NOT NULL, size INTEGER NOT NULL DEFAULT 0, mime TEXT NOT NULL DEFAULT '', visibility TEXT NOT NULL DEFAULT 'private', min_level INTEGER NOT NULL DEFAULT 0, key_hash TEXT, created INTEGER NOT NULL, deleted INTEGER);
      CREATE UNIQUE INDEX IF NOT EXISTS item_name ON items(COALESCE(parent,''), COALESCE(owner,''), name) WHERE deleted IS NULL;
      CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), parent TEXT, owner TEXT, name TEXT NOT NULL, size INTEGER NOT NULL, offset INTEGER NOT NULL DEFAULT 0, mime TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS upload_blocks (upload_id TEXT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE, start INTEGER NOT NULL, length INTEGER NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(upload_id,start));
      CREATE TABLE IF NOT EXISTS grants (user_id TEXT NOT NULL REFERENCES users(id), item_id TEXT NOT NULL REFERENCES items(id), expires INTEGER NOT NULL, PRIMARY KEY(user_id,item_id));
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, time INTEGER NOT NULL, ip TEXT NOT NULL, user_id TEXT, action TEXT NOT NULL, detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS setup (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_reports (id INTEGER PRIMARY KEY, time INTEGER NOT NULL, report TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS item_parent ON items(parent); CREATE INDEX IF NOT EXISTS audit_time ON audit(time);
      CREATE TABLE IF NOT EXISTS admin_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS staff_invites (id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, label TEXT NOT NULL, expires INTEGER NOT NULL, max_uses INTEGER NOT NULL, uses INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, created_by TEXT NOT NULL REFERENCES users(id), revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS profiles (user_id TEXT PRIMARY KEY REFERENCES users(id), bio TEXT NOT NULL, links TEXT NOT NULL, avatar BLOB, avatar_type TEXT);
      CREATE TABLE IF NOT EXISTS item_meta (item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE, uploaded_by TEXT REFERENCES users(id), expires_at INTEGER, downloads INTEGER NOT NULL DEFAULT 0, purged INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS upload_policies (upload_id TEXT PRIMARY KEY REFERENCES uploads(id) ON DELETE CASCADE, retention_seconds INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS download_receipts (hash TEXT PRIMARY KEY, item_id TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS item_expiry ON item_meta(expires_at) WHERE purged=0;
      CREATE INDEX IF NOT EXISTS audit_upload_detail ON audit(detail) WHERE action='upload';
      INSERT OR IGNORE INTO item_meta(item_id,uploaded_by) SELECT i.id,COALESCE((SELECT a.user_id FROM audit a JOIN users u ON u.id=a.user_id WHERE a.action='upload' AND a.detail=i.id ORDER BY a.id DESC LIMIT 1),i.owner) FROM items i WHERE i.folder=0 AND NOT EXISTS(SELECT 1 FROM item_meta m WHERE m.item_id=i.id);
    `);
    const inviteColumns = this.db
      .query("PRAGMA table_info(staff_invites)")
      .all() as { name: string }[];
    if (!inviteColumns.some((c) => c.name === "level"))
      this.db.exec(
        "ALTER TABLE staff_invites ADD COLUMN level INTEGER NOT NULL DEFAULT 3 CHECK(level IN (1,3))",
      );
    const savedRegistration = this.db
      .query("SELECT value FROM admin_settings WHERE key='registration'")
      .get() as { value: string } | null;
    if (savedRegistration)
      this.registrationPolicy = validateRegistrationPolicy(
        JSON.parse(savedRegistration.value),
      );
    const savedFiles = this.db
      .query("SELECT value FROM admin_settings WHERE key='files'")
      .get() as { value: string } | null;
    if (savedFiles)
      this.filePolicy = validateFilePolicy(
        JSON.parse(savedFiles.value),
        config.capacityBytes,
      );
    const savedAI = this.db
      .query("SELECT value FROM admin_settings WHERE key='ai'")
      .get() as { value: string } | null;
    if (savedAI)
      Object.assign(config.ai, validateAISettings(JSON.parse(savedAI.value)));
    const count = this.db
      .query(
        "SELECT count(*) AS n FROM users WHERE level=4 AND status='approved'",
      )
      .get() as { n: number };
    const setupPath = join(config.dataDir, "bootstrap.token");
    if (!count.n && !existsSync(setupPath)) {
      const token = randomToken();
      this.db.run("DELETE FROM setup");
      this.db.run("INSERT INTO setup VALUES (?,?)", [
        digestToken(token),
        Date.now() + 86_400_000,
      ]);
      writeFileSync(setupPath, token + "\n", { mode: 0o600 });
      console.log(
        "First administrator: use bootstrap.token from the protected data directory (expires in 24 hours).",
      );
    }
  }
  user(id: string) {
    return this.db
      .query("SELECT * FROM users WHERE id=?")
      .get(id) as User | null;
  }
  item(id: string) {
    return this.db
      .query(ITEM_SELECT + " WHERE i.id=? AND i.deleted IS NULL")
      .get(id) as Item | null;
  }
  audit(ip: string, user: User | null, action: string, detail = "") {
    this.db.run(
      "INSERT INTO audit(time,ip,user_id,action,detail) VALUES (?,?,?,?,?)",
      [Date.now(), ip, user?.id ?? null, action, detail.slice(0, 1000)],
    );
  }
  limit(key: string, max: number, window: number) {
    const now = Date.now();
    const row = this.db
      .query(
        `INSERT INTO limits(key,count,expires) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires<=? THEN 1 ELSE count+1 END, expires=CASE WHEN expires<=? THEN ? ELSE expires END RETURNING count`,
      )
      .get(key, now + window, now, now, now + window) as { count: number };
    return row.count <= max;
  }
  usage(owner?: string) {
    const used = (
      this.db
        .query(
          `SELECT COALESCE(sum(i.size),0) AS n FROM items i WHERE NOT EXISTS (SELECT 1 FROM item_meta m WHERE m.item_id=i.id AND m.purged=1) ${owner ? "AND i.owner=?" : ""}`,
        )
        .get(...(owner ? [owner] : [])) as { n: number }
    ).n;
    const reserved = (
      this.db
        .query(
          `SELECT COALESCE(sum(size),0) AS n FROM uploads ${owner ? "WHERE owner=?" : ""}`,
        )
        .get(...(owner ? [owner] : [])) as { n: number }
    ).n;
    return { used, reserved };
  }
}
