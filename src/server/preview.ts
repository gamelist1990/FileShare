import { spawn } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { readdir, stat, unlink, rename } from "node:fs/promises";
import type { Store, Item } from "./store";
import { HttpError } from "./policy";
export class Previews {
  active: string | null = null;
  jobs = new Map<string, { state: string; error?: string; updated: number }>();
  constructor(private store: Store) {}
  path(id: string) {
    return join(this.store.cacheDir, id + ".mp4");
  }
  status(item: Item) {
    if (existsSync(this.path(item.id))) return { state: "ready" };
    return this.jobs.get(item.id) ?? { state: "original" };
  }
  async request(item: Item) {
    if (!this.store.config.preview.enabled)
      throw new HttpError(403, "動画変換は無効です");
    if (item.folder || !/\.(mp4|webm|mov|mkv|avi|m4v)$/i.test(item.name))
      throw new HttpError(400, "動画を選択してください");
    if (existsSync(this.path(item.id))) return { state: "ready" };
    if (this.active === item.id) return { state: "processing" };
    const old = this.jobs.get(item.id);
    if (old?.state === "failed" && Date.now() - old.updated < 60_000)
      return old;
    if (this.active)
      throw new HttpError(
        429,
        "他の動画を変換中です。少し待って再試行してください",
      );
    this.active = item.id;
    this.jobs.set(item.id, { state: "processing", updated: Date.now() });
    this.run(item).catch(() => {});
    return { state: "processing" };
  }
  async prune(target = this.store.config.preview.cacheBytes) {
    const files = await Promise.all(
      (await readdir(this.store.cacheDir))
        .filter((n) => /^[a-f0-9-]{36}\.mp4$/.test(n))
        .map(async (n) => ({
          n,
          info: await stat(join(this.store.cacheDir, n)),
        })),
    );
    let size = files.reduce((sum, x) => sum + x.info.size, 0);
    for (const f of files.sort((a, b) => a.info.mtimeMs - b.info.mtimeMs)) {
      if (size <= target) break;
      await unlink(join(this.store.cacheDir, f.n)).catch(() => {});
      size -= f.info.size;
    }
  }
  private async run(item: Item) {
    const config = this.store.config.preview,
      temporary = this.path(item.id) + ".partial";
    try {
      const maxFile = Math.min(50_000_000, Math.floor(config.cacheBytes / 2));
      await this.prune(config.cacheBytes - maxFile);
      await new Promise<void>((resolve, reject) => {
        // No hwaccel/GPU devices. One process, bounded output, CPU threads and execution time.
        const proc = spawn(
          config.ffmpeg,
          [
            "-nostdin",
            "-v",
            "error",
            "-protocol_whitelist",
            "file",
            "-format_whitelist",
            "mov,matroska,webm,avi",
            "-filter_threads",
            String(config.threads),
            "-hwaccel",
            "none",
            "-threads",
            String(config.threads),
            "-i",
            this.store.blobPath(item.id),
            "-t",
            String(config.maxSeconds),
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-vf",
            "scale=w=min(640\\,iw):h=min(360\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2,fps=24,format=yuv420p",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-threads",
            String(config.threads),
            "-b:v",
            "400k",
            "-maxrate",
            "480k",
            "-bufsize",
            "960k",
            "-c:a",
            "aac",
            "-b:a",
            "64k",
            "-movflags",
            "+faststart",
            "-fs",
            String(maxFile),
            "-f",
            "mp4",
            "-y",
            temporary,
          ],
          {
            stdio: ["ignore", "ignore", "ignore"],
            env: { PATH: process.env.PATH, HOME: process.env.HOME },
          },
        );
        const timer = setTimeout(() => {
          proc.kill("SIGKILL");
        }, 180_000);
        timer.unref();
        proc.once("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
        proc.once("exit", (code) => {
          clearTimeout(timer);
          code === 0
            ? resolve()
            : reject(
                new Error(
                  "CPU変換に失敗しました。対応形式とFFmpegを確認してください",
                ),
              );
        });
      });
      if (!this.store.item(item.id))
        throw new Error("元のファイルが削除されました");
      await rename(temporary, this.path(item.id));
      this.jobs.set(item.id, { state: "ready", updated: Date.now() });
    } catch {
      await unlink(temporary).catch(() => {});
      this.jobs.set(item.id, {
        state: "failed",
        error: "動画を変換できません。FFmpegとファイル形式を確認してください。",
        updated: Date.now(),
      });
    } finally {
      this.active = null;
      for (const [id, j] of this.jobs)
        if (Date.now() - j.updated > 3_600_000) this.jobs.delete(id);
      while (this.jobs.size > 256)
        this.jobs.delete(this.jobs.keys().next().value!);
    }
  }
}
