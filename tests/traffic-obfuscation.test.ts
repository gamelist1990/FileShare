import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createTrafficClientHello,
  openTraffic,
  sealTraffic,
  type TrafficKeys,
} from "@pexserver/secure-envelope/traffic";
import { openAsset } from "@pexserver/secure-envelope/asset";
import { createApp } from "../src/server/app";
import { defaults } from "../src/server/config";

let app: Awaited<ReturnType<typeof createApp>>;
let directory: string;
let origin: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "fileshare-traffic-"));
  const config = structuredClone(defaults);
  config.port = 43000 + Math.floor(Math.random() * 1000);
  config.origin = origin = `http://127.0.0.1:${config.port}`;
  config.dataDir = directory;
  app = await createApp(config);
});

afterAll(async () => {
  app.close();
  await rm(directory, { recursive: true, force: true });
});

async function session() {
  const client = await createTrafficClientHello();
  const response = await fetch(origin + "/api/transport/open", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(client.hello),
  });
  expect(response.status).toBe(200);
  return client.complete(await response.json());
}

async function channel(keys: TrafficKeys, value: unknown, packet?: string) {
  const body = packet ?? (await sealTraffic(value, keys, "request"));
  const response = await fetch(origin + "/api/channel", {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/octet-stream",
      "X-PEX-Session": keys.sessionId,
    },
    body,
  });
  return { response, body };
}

test("the public API travels through one padded authenticated channel", async () => {
  const keys = await session();
  const requestId = crypto.randomUUID();
  const { response, body } = await channel(keys, {
    requestId,
    method: "GET",
    path: "/api/me",
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/octet-stream");
  expect(body).not.toContain("/api/me");
  expect(body).not.toContain("setupRequired");
  const encrypted = await response.text();
  expect(encrypted).not.toContain("setupRequired");
  const result = (
    await openTraffic<{ requestId: string; status: number; data: any }>(
      encrypted,
      keys,
      "response",
    )
  ).value;
  expect(result.requestId).toBe(requestId);
  expect(result.status).toBe(200);
  expect(result.data.setupRequired).toBe(true);
});

test("traffic packets are single-use and cannot route outside the API", async () => {
  const keys = await session();
  const packet = await sealTraffic(
    { requestId: crypto.randomUUID(), method: "GET", path: "/api/me" },
    keys,
    "request",
  );
  expect((await channel(keys, {}, packet)).response.status).toBe(200);
  expect((await channel(keys, {}, packet)).response.status).toBe(409);
  const escaped = await channel(keys, {
    requestId: crypto.randomUUID(),
    method: "GET",
    path: "/index.js",
  });
  expect(escaped.response.status).toBe(409);
});

test("the application bundle is encrypted and its key is channel-only", async () => {
  const direct = await fetch(origin + "/api/bootstrap");
  expect(direct.status).toBe(404);
  const keys = await session();
  const bootstrap = await channel(keys, {
    requestId: crypto.randomUUID(),
    method: "GET",
    path: "/api/bootstrap",
  });
  const metadata = (
    await openTraffic<{
      requestId: string;
      status: number;
      data: { key: string; context: string };
    }>(
      await bootstrap.response.text(),
      keys,
      "response",
    )
  ).value.data;
  const encrypted = await (await fetch(origin + "/app.bin")).text();
  expect(encrypted).not.toContain("共有ストレージ");
  expect(await openAsset(encrypted, metadata.key, metadata.context)).toContain(
    "共有ストレージ",
  );
  const loader = await (await fetch(origin + "/index.js")).text();
  expect(loader).not.toContain(metadata.key);
  expect((await readFile(join(process.cwd(), "public/app.bin"), "utf8"))).toBe(
    encrypted,
  );
});
