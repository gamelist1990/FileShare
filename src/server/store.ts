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
}
export class Store {
  db: Database;
  secret: string;
  blobDir: string;
  tempDir: string;
  cacheDir: string;
  constructor(public config: Config) {
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
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, kind TEXT NOT NULL, user_id TEXT, challenge TEXT NOT NULL, ip TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, parent TEXT REFERENCES items(id), owner TEXT REFERENCES users(id), name TEXT NOT NULL, folder INTEGER NOT NULL, size INTEGER NOT NULL DEFAULT 0, mime TEXT NOT NULL DEFAULT '', visibility TEXT NOT NULL DEFAULT 'private', min_level INTEGER NOT NULL DEFAULT 0, key_hash TEXT, created INTEGER NOT NULL, deleted INTEGER);
      CREATE UNIQUE INDEX IF NOT EXISTS item_name ON items(COALESCE(parent,''), COALESCE(owner,''), name) WHERE deleted IS NULL;
      CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), parent TEXT, owner TEXT, name TEXT NOT NULL, size INTEGER NOT NULL, offset INTEGER NOT NULL DEFAULT 0, mime TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS grants (user_id TEXT NOT NULL REFERENCES users(id), item_id TEXT NOT NULL REFERENCES items(id), expires INTEGER NOT NULL, PRIMARY KEY(user_id,item_id));
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, time INTEGER NOT NULL, ip TEXT NOT NULL, user_id TEXT, action TEXT NOT NULL, detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS setup (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_reports (id INTEGER PRIMARY KEY, time INTEGER NOT NULL, report TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS item_parent ON items(parent); CREATE INDEX IF NOT EXISTS audit_time ON audit(time);
    `);
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
      .query("SELECT * FROM items WHERE id=? AND deleted IS NULL")
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
          `SELECT COALESCE(sum(size),0) AS n FROM items ${owner ? "WHERE owner=?" : ""}`,
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
