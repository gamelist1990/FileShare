import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { randomToken, digestToken } from "@pexserver/secure-envelope";
import { createApp } from "../src/server/app";
import { Store } from "../src/server/store";
import { defaults } from "../src/server/config";

let app: Awaited<ReturnType<typeof createApp>>, dir: string, origin: string;
const cookies: Record<string, string> = {};
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "fileshare-admin-"));
  const port = 46000 + Math.floor(Math.random() * 8000);
  origin = `http://127.0.0.1:${port}`;
  const config = structuredClone(defaults);
  Object.assign(config, { port, origin, dataDir: dir });
  config.rate.authPerMinute = 200;
  app = await createApp(config);
  for (const [name, level] of [
    ["admin", 4],
    ["staff", 3],
  ] as const) {
    app.store.db.run("INSERT INTO users VALUES (?,?,?,?,?,?,?)", [
      name,
      name,
      level,
      "approved",
      5e9,
      "127.0.0.1",
      Date.now(),
    ]);
    const token = randomToken();
    cookies[name] = "fs_session=" + token;
    app.store.db.run("INSERT INTO sessions VALUES (?,?,?)", [
      digestToken(token),
      name,
      Date.now() + 3600000,
    ]);
  }
});
afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});
function request(
  path: string,
  method = "GET",
  body?: unknown,
  user = "admin",
  cookie?: string,
) {
  return fetch(origin + path, {
    method,
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      Cookie: cookie ?? cookies[user] ?? "",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function invitation(extra = {}) {
  const response = await request("/api/admin/staff-invites", "POST", {
    label: "Review team",
    hours: 24,
    maxUses: 1,
    ...extra,
  });
  expect(response.status).toBe(200);
  const result = await response.json();
  return {
    ...result,
    token: new URLSearchParams(new URL(result.url).hash.slice(1)).get(
      "staff-invite",
    )!,
  };
}
async function options(name: string, token: string) {
  const response = await request(
    "/api/auth/register/options",
    "POST",
    { name, staffInvite: token },
    "",
  );
  expect(response.status).toBe(200);
  return {
    options: await response.json(),
    cookie: response.headers.get("set-cookie")!.split(";")[0],
  };
}
function registration(challenge: string, verified = true) {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const credential = randomBytes(32),
    len = Buffer.alloc(2);
  len.writeUInt16BE(credential.length);
  const cose = isoCBOR.encode(
    new Map<any, any>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x!, "base64url")],
      [-3, Buffer.from(jwk.y!, "base64url")],
    ]),
  );
  const authData = Buffer.concat([
    createHash("sha256").update("127.0.0.1").digest(),
    Buffer.from([verified ? 0x45 : 0x41]),
    Buffer.alloc(4),
    Buffer.alloc(16),
    len,
    credential,
    cose,
  ]);
  const attestation = isoCBOR.encode(
    new Map<any, any>([
      ["fmt", "none"],
      ["attStmt", new Map()],
      ["authData", authData],
    ]),
  );
  return {
    id: credential.toString("base64url"),
    rawId: credential.toString("base64url"),
    type: "public-key",
    clientExtensionResults: {},
    response: {
      attestationObject: Buffer.from(attestation).toString("base64url"),
      clientDataJSON: Buffer.from(
        JSON.stringify({
          type: "webauthn.create",
          challenge,
          origin,
          crossOrigin: false,
        }),
      ).toString("base64url"),
      transports: ["internal"],
    },
  };
}

test("all new administration endpoints reject staff and anonymous callers", async () => {
  for (const [path, method, body] of [
    ["/api/admin/settings", "GET", undefined],
    ["/api/admin/settings", "PATCH", { ai: defaults.ai }],
    ["/api/admin/staff-invites", "GET", undefined],
    ["/api/admin/staff-invites", "POST", {}],
    ["/api/admin/staff-invites/revoke", "POST", { id: "x" }],
    ["/api/admin/applications/deny", "POST", { ids: ["x"] }],
    ["/api/admin/audit/dates", "GET", undefined],
    ["/api/admin/audit", "GET", undefined],
  ] as const) {
    expect((await request(path, method, body, "staff")).status).toBe(403);
    expect((await request(path, method, body, "")).status).toBe(401);
  }
});
test("bulk rejection is atomic, only affects pending accounts, and records each review", async () => {
  for (const id of ["pending-a", "pending-b"])
    app.store.db.run("INSERT INTO users VALUES (?,?,?,?,?,?,?)", [
      id,
      id,
      0,
      "pending",
      5e9,
      "192.0.2.10",
      Date.now(),
    ]);
  expect(
    (
      await request("/api/admin/applications/deny", "POST", {
        ids: ["pending-a", "admin"],
      })
    ).status,
  ).toBe(409);
  expect(app.store.user("pending-a")!.status).toBe("pending");
  expect(
    (
      await request("/api/admin/applications/deny", "POST", {
        ids: ["pending-a", "pending-a"],
      })
    ).status,
  ).toBe(400);
  const denied = await request("/api/admin/applications/deny", "POST", {
    ids: ["pending-a", "pending-b"],
  });
  expect((await denied.json()).count).toBe(2);
  expect(app.store.user("pending-b")!.status).toBe("denied");
  expect(app.store.user("admin")!.status).toBe("approved");
  expect(
    (
      app.store.db
        .query(
          "SELECT count(*) AS n FROM audit WHERE action='application.deny'",
        )
        .get() as any
    ).n,
  ).toBe(2);
});
test("daily log books use JST boundaries and keyset pagination without leaking tokens", async () => {
  for (const [time, action] of [
    [Date.UTC(2001, 0, 1, 14, 59, 59), "user.update"],
    [Date.UTC(2001, 0, 1, 15), "register"],
    [Date.UTC(2001, 0, 1, 15, 1), "login"],
  ] as const)
    app.store.db.run(
      "INSERT INTO audit(time,ip,user_id,action,detail) VALUES (?,?,?,?,?)",
      [time, "192.0.2.1", "admin", action, "test"],
    );
  const dates = await (
    await request("/api/admin/audit/dates?month=2001-01&scope=review")
  ).json();
  expect(dates.days).toEqual([
    { day: "2001-01-02", count: 1 },
    { day: "2001-01-01", count: 1 },
  ]);
  expect(
    (
      await (
        await request("/api/admin/audit?date=2001-01-02&scope=review")
      ).json()
    ).entries.length,
  ).toBe(1);
  for (let i = 0; i < 105; i++)
    app.store.db.run(
      "INSERT INTO audit(time,ip,action,detail) VALUES (?,?,?,?)",
      [Date.UTC(2001, 0, 2), "local", "login", "page-test"],
    );
  const first = await (
    await request("/api/admin/audit?date=2001-01-02")
  ).json();
  expect(first.entries.length).toBe(100);
  expect(first.next).toBeTruthy();
  const second = await (
    await request(`/api/admin/audit?date=2001-01-02&before=${first.next}`)
  ).json();
  expect(second.entries.length).toBe(7);
  expect(second.next).toBeNull();
  expect(
    new Set([...first.entries, ...second.entries].map((e) => e.id)).size,
  ).toBe(107);
  expect((await request("/api/admin/audit?date=2001-02-31")).status).toBe(400);
  expect((await request("/api/admin/audit/dates?month=invalid")).status).toBe(
    400,
  );
});
test("a staff invite requires verified WebAuthn and atomically approves exactly its allowed uses", async () => {
  app.store.config.registration.enabled = false;
  const invite = await invitation();
  expect(invite.url).toContain("/#staff-invite=");
  const listed = await (await request("/api/admin/staff-invites")).text();
  expect(listed).not.toContain(invite.token);
  const bad = await options("no-uv", invite.token);
  expect(
    (
      await request(
        "/api/auth/register/verify",
        "POST",
        registration(bad.options.challenge, false),
        "",
        bad.cookie,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      app.store.db
        .query("SELECT uses FROM staff_invites WHERE id=?")
        .get(invite.id) as any
    ).uses,
  ).toBe(0);
  const a = await options("invited-a", invite.token),
    b = await options("invited-b", invite.token);
  const results = await Promise.all([
    request(
      "/api/auth/register/verify",
      "POST",
      registration(a.options.challenge),
      "",
      a.cookie,
    ),
    request(
      "/api/auth/register/verify",
      "POST",
      registration(b.options.challenge),
      "",
      b.cookie,
    ),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 403]);
  const created = app.store.db
    .query("SELECT level,status,quota FROM users WHERE name IN (?,?)")
    .all("invited-a", "invited-b");
  expect(created).toEqual([{ level: 3, status: "approved", quota: 5e9 }]);
  expect(
    (
      app.store.db
        .query("SELECT uses FROM staff_invites WHERE id=?")
        .get(invite.id) as any
    ).uses,
  ).toBe(1);
  expect(
    (
      await request(
        "/api/auth/register/options",
        "POST",
        { name: "extra", staffInvite: invite.token },
        "",
      )
    ).status,
  ).toBe(403);
  app.store.config.registration.enabled = true;
});
test("revoked, expired and issuer-demoted invites cannot authorize registration, including an in-flight ceremony", async () => {
  const invite = await invitation();
  const pending = await options("revoked-person", invite.token);
  expect(
    (
      await request("/api/admin/staff-invites/revoke", "POST", {
        id: invite.id,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await request(
        "/api/auth/register/verify",
        "POST",
        registration(pending.options.challenge),
        "",
        pending.cookie,
      )
    ).status,
  ).toBe(403);
  const expired = await invitation();
  app.store.db.run("UPDATE staff_invites SET expires=? WHERE id=?", [
    Date.now() - 1,
    expired.id,
  ]);
  expect(
    (
      await request(
        "/api/auth/staff-invite",
        "POST",
        { token: expired.token },
        "",
      )
    ).status,
  ).toBe(403);
  const demoted = await invitation();
  app.store.db.run("UPDATE users SET level=3 WHERE id='admin'");
  expect(
    (
      await request(
        "/api/auth/staff-invite",
        "POST",
        { token: demoted.token },
        "",
      )
    ).status,
  ).toBe(403);
  app.store.db.run("UPDATE users SET level=4 WHERE id='admin'");
});
test("AI settings persist, never allow endpoint overrides, and dynamically start aggregate-only monitoring", async () => {
  const bodies: any[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      bodies.push(await req.json());
      return Response.json({
        choices: [{ message: { content: "集計を確認しました" } }],
      });
    },
  });
  app.store.config.ai.endpoint = `http://127.0.0.1:${server.port}/v1/chat/completions`;
  const config = {
    enabled: true,
    model: "gemma4-test",
    intervalSeconds: 60,
    endpoint: "http://169.254.169.254/",
  };
  try {
    expect(
      (
        await request("/api/admin/settings", "PATCH", {
          ai: { ...config, intervalSeconds: 0 },
        })
      ).status,
    ).toBe(400);
    const result = await (
      await request("/api/admin/settings", "PATCH", { ai: config })
    ).json();
    expect(result.ai.endpoint).toBe(app.store.config.ai.endpoint);
    app.store.audit("198.51.100.211", null, "login", "private-filename.txt");
    for (let i = 0; i < 60 && !bodies.length; i++) await Bun.sleep(100);
    expect(bodies.length).toBe(1);
    const sent = JSON.stringify(bodies[0]);
    expect(sent).not.toContain("198.51.100.211");
    expect(sent).not.toContain("private-filename.txt");
    expect(
      (
        await request("/api/admin/settings", "PATCH", {
          ai: { ...config, enabled: false },
        })
      ).status,
    ).toBe(200);
    const cloned = structuredClone(defaults);
    cloned.dataDir = dir;
    const reopened = new Store(cloned);
    try {
      expect(cloned.ai.enabled).toBe(false);
      expect(cloned.ai.model).toBe("gemma4-test");
      expect(cloned.ai.endpoint).toBe(defaults.ai.endpoint);
    } finally {
      reopened.db.close();
    }
  } finally {
    app.store.config.ai.enabled = false;
    server.stop(true);
  }
});

test("VIP invitations grant only Level 1, never a client-selected role, and retain default quota", async () => {
  const invite = await invitation({ level: 1 });
  const info = await (
    await request("/api/auth/staff-invite", "POST", { token: invite.token }, "")
  ).json();
  expect(info.level).toBe(1);
  const ceremony = await options("invited-vip", invite.token);
  expect(
    (
      await request(
        "/api/auth/register/verify",
        "POST",
        { ...registration(ceremony.options.challenge), level: 4 },
        "",
        ceremony.cookie,
      )
    ).status,
  ).toBe(200);
  const vip = app.store.db
    .query("SELECT level,status,quota FROM users WHERE name='invited-vip'")
    .get();
  expect(vip).toEqual({
    level: 1,
    status: "approved",
    quota: defaults.vipQuotaBytes,
  });
  expect(
    (await request("/api/admin/staff-invites", "POST", { level: 4 })).status,
  ).toBe(400);
});

test("registration defaults to invitation-only and rechecks disabled public signup at verification", async () => {
  expect(
    (await (await request("/api/me", "GET", undefined, "")).json())
      .registration,
  ).toBe(false);
  expect(
    (
      await request(
        "/api/auth/register/options",
        "POST",
        { name: "without-invite" },
        "",
      )
    ).status,
  ).toBe(403);
  expect(
    (await request("/api/auth/login/options", "POST", {}, "")).status,
  ).toBe(200);
  const policy = {
    publicRegistration: true,
    autoApprove: true,
    generalUploads: true,
  };
  expect(
    (await request("/api/admin/settings", "PATCH", { registration: policy }))
      .status,
  ).toBe(200);
  const start = async (name: string) => {
    const result = await request(
      "/api/auth/register/options",
      "POST",
      { name },
      "",
    );
    expect(result.status).toBe(200);
    return {
      options: await result.json(),
      cookie: result.headers.get("set-cookie")!.split(";")[0],
    };
  };
  // Existing administrator at loopback already uses its per-IP allocation.
  app.store.config.registration.accountsPerIp = 50;
  const race = await start("public-race");
  await request("/api/admin/settings", "PATCH", {
    registration: { ...policy, publicRegistration: false },
  });
  expect(
    (
      await request(
        "/api/auth/register/verify",
        "POST",
        registration(race.options.challenge),
        "",
        race.cookie,
      )
    ).status,
  ).toBe(403);
  expect(
    app.store.db.query("SELECT 1 FROM users WHERE name='public-race'").get(),
  ).toBeNull();
  await request("/api/admin/settings", "PATCH", { registration: policy });
  const valid = await start("public-auto");
  expect(
    (
      await request(
        "/api/auth/register/verify",
        "POST",
        registration(valid.options.challenge),
        "",
        valid.cookie,
      )
    ).status,
  ).toBe(200);
  const general = app.store.db
    .query("SELECT * FROM users WHERE name='public-auto'")
    .get() as any;
  expect(general.level).toBe(0);
  expect(general.status).toBe("approved");
  const token = randomToken();
  app.store.db.run("INSERT INTO sessions VALUES (?,?,?)", [
    digestToken(token),
    general.id,
    Date.now() + 60000,
  ]);
  const cookie = "fs_session=" + token;
  const listing = await (
    await request("/api/items", "GET", undefined, "", cookie)
  ).json();
  expect(listing.uploadable).toBe(true);
  expect(listing.writable).toBe(false);
  const upload = await request(
    "/api/uploads",
    "POST",
    { name: "general.txt", size: 0, space: "shared" },
    "",
    cookie,
  );
  expect(upload.status).toBe(201);
  const { id } = await upload.json();
  expect(
    (await request(`/api/uploads/${id}/complete`, "POST", {}, "", cookie))
      .status,
  ).toBe(200);
  expect(
    (
      await request(
        `/api/items/${id}`,
        "PATCH",
        { visibility: "private" },
        "",
        cookie,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await request(
        "/api/folders",
        "POST",
        { name: "not-allowed", space: "shared" },
        "",
        cookie,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await request(
        "/api/uploads",
        "POST",
        { name: "private.txt", size: 0, space: "private" },
        "",
        cookie,
      )
    ).status,
  ).toBe(403);
  expect(
    (await request("/api/admin/settings", "GET", undefined, "", cookie)).status,
  ).toBe(403);
  await request("/api/admin/settings", "PATCH", {
    registration: { ...policy, generalUploads: false },
  });
  expect(
    (
      await request(
        "/api/uploads",
        "POST",
        { name: "disabled.txt", size: 0 },
        "",
        cookie,
      )
    ).status,
  ).toBe(403);
  const cloned = structuredClone(defaults);
  cloned.dataDir = dir;
  const reopened = new Store(cloned);
  try {
    expect(reopened.registrationPolicy).toEqual({
      ...policy,
      generalUploads: false,
    });
  } finally {
    reopened.db.close();
  }
  app.store.registrationPolicy = {
    publicRegistration: false,
    autoApprove: false,
    generalUploads: false,
  };
});
