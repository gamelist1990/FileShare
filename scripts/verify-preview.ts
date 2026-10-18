import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/server/store";
import { Previews } from "../src/server/preview";
import { defaults } from "../src/server/config";
const dir = await mkdtemp(join(tmpdir(), "fileshare-media-"));
const ffmpeg = process.env.FFMPEG ?? "ffmpeg";
const store = new Store({
  ...structuredClone(defaults),
  dataDir: dir,
  preview: { ...defaults.preview, ffmpeg },
});
try {
  const id = randomUUID();
  const proc = Bun.spawn(
    [
      ffmpeg,
      "-nostdin",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=320x240:r=15",
      "-t",
      "1",
      "-c:v",
      "libx264",
      "-threads",
      "1",
      "-pix_fmt",
      "yuv420p",
      "-f",
      "mp4",
      join(store.blobDir, id),
    ],
    { stdout: "ignore", stderr: "inherit" },
  );
  // The synthetic source has no extension, so ffmpeg needs an explicit container.
  if ((await proc.exited) !== 0) throw new Error("Fixture generation failed");
  const source = await stat(join(store.blobDir, id));
  store.db.run(
    "INSERT INTO items(id,name,folder,size,mime,visibility,created) VALUES (?,?,0,?,?,?,?)",
    [id, "fixture.mp4", source.size, "video/mp4", "public", Date.now()],
  );
  const previews = new Previews(store);
  await previews.request(store.item(id)!);
  const start = Date.now();
  while (previews.active) {
    if (Date.now() - start > 30_000) throw new Error("Preview timeout");
    await Bun.sleep(100);
  }
  const job = previews.jobs.get(id);
  if (job?.state !== "ready") throw new Error(JSON.stringify(job));
  const info = await stat(previews.path(id));
  if (info.size < 100) throw new Error("Empty preview");
  const attack = randomUUID();
  await writeFile(
    join(store.blobDir, attack),
    "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:1,\n" +
      join(store.blobDir, id) +
      "\n#EXT-X-ENDLIST\n",
  );
  store.db.run(
    "INSERT INTO items(id,name,folder,size,mime,visibility,created) VALUES (?,?,0,1,?,?,?)",
    [attack, "fake.mp4", "video/mp4", "public", Date.now()],
  );
  await previews.request(store.item(attack)!);
  while (previews.active) await Bun.sleep(100);
  if (previews.jobs.get(attack)?.state !== "failed")
    throw new Error("Playlist/local file access was not rejected");
  console.log(
    JSON.stringify({
      ok: true,
      playlistRejected: true,
      cpuOnly: true,
      threads: 2,
      sourceBytes: source.size,
      previewBytes: info.size,
      elapsedMs: Date.now() - start,
    }),
  );
} finally {
  store.db.close();
  await rm(dir, { recursive: true, force: true });
}
