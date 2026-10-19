/** Native bundle smoke test with isolated credentials/data; never contacts production. */
import { Store } from "../src/server/store";
import { defaults } from "../src/server/config";
import { initUpload } from "../src/server/storage";
import { randomToken, digestToken } from "@pexserver/secure-envelope";
import {
  packBlock,
  BLOCK_BYTES,
  PIPELINE_PROTOCOL,
} from "../src/shared/pipeline";
import WS from "ws-node";
import { randomBytes, createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const root = await mkdtemp(join(tmpdir(), "fileshare-binary-pipeline-")),
  config = structuredClone(defaults);
config.port = 53000 + Math.floor(Math.random() * 5000);
config.origin = `http://127.0.0.1:${config.port}`;
config.dataDir = root;
const store = new Store(config),
  token = randomToken(),
  data = randomBytes(4 * BLOCK_BYTES);
store.db.run("INSERT INTO users VALUES (?,?,?,?,?,?,?)", [
  "smoke",
  "smoke",
  4,
  "approved",
  5e9,
  "192.0.2.1",
  Date.now(),
]);
store.db.run("INSERT INTO sessions VALUES (?,?,?)", [
  digestToken(token),
  "smoke",
  Date.now() + 60000,
]);
const upload = initUpload(store, store.user("smoke"), {
  name: "native-pipeline.bin",
  size: data.length,
  space: "private",
});
const blobDir = store.blobDir;
store.db.close();
const configPath = join(root, "config.json");
await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
const child = Bun.spawn(
  [resolve(process.argv[2] ?? "FileShare"), "--config", configPath],
  { stdout: "pipe", stderr: "pipe" },
);
let ws: WS | undefined;
try {
  let started = false;
  for (let n = 0; n < 100; n++) {
    try {
      if ((await fetch(config.origin + "/healthz")).ok) {
        started = true;
        break;
      }
    } catch {}
    if (child.exitCode !== null) break;
    await Bun.sleep(50);
  }
  if (!started)
    throw new Error(
      "Native binary did not start: " +
        (await new Response(child.stderr).text()),
    );
  ws = new WS(
    config.origin.replace("http:", "ws:") + `/api/uploads/${upload.id}/stream`,
    PIPELINE_PROTOCOL,
    { headers: { Origin: config.origin, Cookie: `fs_session=${token}` } },
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Native pipeline timeout")),
      10000,
    );
    ws!.on("error", reject);
    ws!.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "error") reject(new Error(JSON.stringify(message)));
      if (message.type === "ready")
        for (let offset = 0; offset < data.length; offset += BLOCK_BYTES) {
          const part = data.subarray(offset, offset + BLOCK_BYTES);
          ws!.send(
            packBlock(
              offset,
              Uint8Array.from(part).buffer,
              part.length,
              createHash("sha256").update(part).digest("hex"),
              false,
            ),
          );
        }
      if (message.type === "done") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  const done = await fetch(
    config.origin + `/api/uploads/${upload.id}/complete`,
    {
      method: "POST",
      headers: {
        Origin: config.origin,
        Cookie: `fs_session=${token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    },
  );
  if (!done.ok)
    throw new Error("Native completion failed: " + (await done.text()));
  if (!(await readFile(join(blobDir, upload.id))).equals(data))
    throw new Error("Native saved bytes differ");
  console.log(
    "Native binary verified: authenticated single-socket pipelining, durable receipts and saved-file integrity.",
  );
} finally {
  ws?.terminate();
  child.kill("SIGTERM");
  await child.exited;
  await rm(root, { recursive: true, force: true });
}
