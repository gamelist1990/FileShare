import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { defaults } from "../src/server/config";

test("first-admin setup survives exhausted signup attempts but retains auth throttling", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fileshare-bootstrap-"));
  const port = 35000 + Math.floor(Math.random() * 10000);
  const origin = `http://127.0.0.1:${port}`;
  const config = structuredClone(defaults);
  config.port = port;
  config.origin = origin;
  config.dataDir = dir;
  config.registration.attemptsPerHour = 1;
  config.rate.authPerMinute = 8;
  const app = await createApp(config);
  try {
    const key = (await readFile(join(dir, "bootstrap.token"), "utf8")).trim();
    const options = (bootstrap?: string) =>
      fetch(origin + "/api/auth/register/options", {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "firstadmin", bootstrap }),
      });
    expect((await options()).status).toBe(200);
    expect((await options()).status).toBe(429);
    expect((await options("invalid-key")).status).toBe(403);
    app.store.db.run("UPDATE setup SET expires=?", [Date.now() - 1000]);
    expect((await options(key)).status).toBe(403);
    app.store.db.run("UPDATE setup SET expires=?", [Date.now() + 60000]);
    const setup = await options(key);
    expect(setup.status).toBe(200);
    expect(
      ((await setup.json()) as { challenge: string }).challenge,
    ).toBeTruthy();
    expect((await options(key)).status).toBe(200);
    expect((await options()).status).toBe(429);
    config.registration.enabled = false;
    expect((await options(key)).status).toBe(200);
    expect((await options(key)).status).toBe(429);
  } finally {
    app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
