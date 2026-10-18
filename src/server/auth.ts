import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomToken, digestToken } from "@pexserver/secure-envelope";
import type { Store, User } from "./store";
import { HttpError, requireUser } from "./policy";
const SESSION_TTL = 12 * 60 * 60 * 1000;
export function cookieValue(cookie: string | undefined, name: string) {
  return (
    cookie
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(name + "="))
      ?.slice(name.length + 1) ?? ""
  );
}
export function sessionUser(store: Store, cookie: string | undefined) {
  const token = cookieValue(cookie, "fs_session");
  if (!token) return null;
  return store.db
    .query(
      "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.expires>? AND u.status='approved'",
    )
    .get(digestToken(token), Date.now()) as User | null;
}
export function authCookie(
  store: Store,
  name: string,
  value: string,
  maxAge: number,
) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${store.config.origin.startsWith("https:") ? "; Secure" : ""}`;
}
export function publicUser(u: User | null) {
  return u
    ? {
        id: u.id,
        name: u.name,
        level: u.level,
        quota: u.quota,
        status: u.status,
      }
    : null;
}
export async function authRoute(
  store: Store,
  route: string,
  data: any,
  ip: string,
  cookie: string | undefined,
  current: User | null,
): Promise<{ body: unknown; cookie?: string }> {
  const rpID = new URL(store.config.origin).hostname;
  if (route === "logout") {
    store.db.run("DELETE FROM sessions WHERE hash=?", [
      digestToken(cookieValue(cookie, "fs_session")),
    ]);
    return {
      body: { ok: true },
      cookie: authCookie(store, "fs_session", "", 0),
    };
  }
  if (route === "register/options" || route === "enroll/options") {
    const enroll = route.startsWith("enroll");
    if (enroll) requireUser(current);
    if (!store.config.registration.enabled && !enroll && !data.bootstrap)
      throw new HttpError(403, "新規登録を受け付けていません");
    const name = enroll
      ? current!.name
      : String(data.name ?? "")
          .trim()
          .toLowerCase();
    if (!/^[a-z0-9_-]{2,32}$/.test(name))
      throw new HttpError(400, "ユーザー名は英数字・_・-の2〜32文字です");
    let setupHash: string | null = null;
    if (!enroll && data.bootstrap) {
      setupHash = digestToken(String(data.bootstrap));
      if (
        !store.db
          .query("SELECT 1 FROM setup WHERE hash=? AND expires>?")
          .get(setupHash, Date.now())
      )
        throw new HttpError(403, "初期設定キーが無効または期限切れです");
    }
    // A verified bootstrap key authorizes first-admin setup independently of
    // ordinary signup attempts. The shared auth/request rate limits still apply.
    if (
      !setupHash &&
      !store.limit(
        "register:" + ip,
        store.config.registration.attemptsPerHour,
        3_600_000,
      )
    )
      throw new HttpError(429, "登録回数の上限です。時間をおいてください");
    if (!enroll && store.db.query("SELECT 1 FROM users WHERE name=?").get(name))
      throw new HttpError(409, "登録できないユーザー名です");
    if (!enroll && !setupHash) checkIp(store, ip);
    const id = enroll ? current!.id : randomUUID();
    const opts = await generateRegistrationOptions({
      rpName: "PEXserver FileShare",
      rpID,
      userID: new TextEncoder().encode(id),
      userName: name,
      attestationType: "none",
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
      excludeCredentials: enroll
        ? (
            store.db
              .query("SELECT id,transports FROM credentials WHERE user_id=?")
              .all(id) as any[]
          ).map((c) => ({ id: c.id, transports: JSON.parse(c.transports) }))
        : [],
    });
    const cid = randomToken();
    store.db.run("INSERT INTO challenges VALUES (?,?,?,?,?,?)", [
      cid,
      enroll ? "enroll" : "register",
      JSON.stringify({ id, name, setupHash }),
      opts.challenge,
      ip,
      Date.now() + 300_000,
    ]);
    return { body: opts, cookie: authCookie(store, "fs_challenge", cid, 300) };
  }
  if (route === "register/verify" || route === "enroll/verify") {
    const enroll = route.startsWith("enroll");
    const challenge = consumeChallenge(
      store,
      cookie,
      enroll ? "enroll" : "register",
      ip,
    );
    const meta = JSON.parse(challenge.user_id);
    if (enroll && requireUser(current).id !== meta.id)
      throw new HttpError(403, "認証をやり直してください");
    const verification = await verifyRegistrationResponse({
      response: data as RegistrationResponseJSON,
      expectedChallenge: challenge.challenge,
      expectedOrigin: store.config.origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
    if (!verification.verified || !verification.registrationInfo)
      throw new HttpError(400, "パスキーを確認できません");
    const { credential } = verification.registrationInfo;
    store.db.transaction(() => {
      if (!enroll) {
        if (meta.setupHash) {
          if (
            !store.db
              .query("SELECT 1 FROM setup WHERE hash=? AND expires>?")
              .get(meta.setupHash, Date.now()) ||
            store.db.query("SELECT 1 FROM users WHERE level=4").get()
          )
            throw new HttpError(403, "初期設定は完了しています");
          store.db.run("DELETE FROM setup");
        } else checkIp(store, ip);
        store.db.run("INSERT INTO users VALUES (?,?,?,?,?,?,?)", [
          meta.id,
          meta.name,
          meta.setupHash ? 4 : 0,
          meta.setupHash ? "approved" : "pending",
          store.config.vipQuotaBytes,
          ip,
          Date.now(),
        ]);
      }
      store.db.run("INSERT INTO credentials VALUES (?,?,?,?,?)", [
        credential.id,
        meta.id,
        credential.publicKey,
        credential.counter,
        JSON.stringify(credential.transports ?? []),
      ]);
    })();
    if (meta.setupHash) {
      try {
        unlinkSync(join(store.config.dataDir, "bootstrap.token"));
      } catch {}
    }
    store.audit(ip, store.user(meta.id), enroll ? "passkey.add" : "register");
    return {
      body: {
        ok: true,
        message: meta.setupHash
          ? "管理者を登録しました。パスキーでログインしてください。"
          : enroll
            ? "パスキーを追加しました。"
            : "登録を受け付けました。管理者の承認をお待ちください。",
      },
      cookie: authCookie(store, "fs_challenge", "", 0),
    };
  }
  if (route === "login/options") {
    const opts = await generateAuthenticationOptions({
      rpID,
      userVerification: "required",
    });
    const cid = randomToken();
    store.db.run("INSERT INTO challenges VALUES (?,?,?,?,?,?)", [
      cid,
      "login",
      null,
      opts.challenge,
      ip,
      Date.now() + 300_000,
    ]);
    return { body: opts, cookie: authCookie(store, "fs_challenge", cid, 300) };
  }
  if (route === "login/verify") {
    const challenge = consumeChallenge(store, cookie, "login", ip);
    const credential = store.db
      .query("SELECT * FROM credentials WHERE id=?")
      .get(String(data.id ?? "")) as any;
    const user = credential ? store.user(credential.user_id) : null;
    if (!user || user.status !== "approved")
      throw new HttpError(401, "認証できません。承認状況を確認してください");
    const result = await verifyAuthenticationResponse({
      response: data as AuthenticationResponseJSON,
      expectedChallenge: challenge.challenge,
      expectedOrigin: store.config.origin,
      expectedRPID: rpID,
      credential: {
        id: credential.id,
        publicKey: new Uint8Array(credential.public_key),
        counter: credential.counter,
        transports: JSON.parse(credential.transports),
      },
      requireUserVerification: true,
    });
    if (!result.verified) throw new HttpError(401, "認証できません");
    const token = randomToken();
    store.db.transaction(() => {
      store.db.run("UPDATE credentials SET counter=? WHERE id=?", [
        result.authenticationInfo.newCounter,
        credential.id,
      ]);
      store.db.run("DELETE FROM sessions WHERE user_id=? AND expires<=?", [
        user.id,
        Date.now(),
      ]);
      const count = store.db
        .query("SELECT count(*) AS n FROM sessions WHERE user_id=?")
        .get(user.id) as { n: number };
      if (count.n >= 10)
        store.db.run(
          "DELETE FROM sessions WHERE hash IN (SELECT hash FROM sessions WHERE user_id=? ORDER BY expires LIMIT 1)",
          [user.id],
        );
      store.db.run("INSERT INTO sessions VALUES (?,?,?)", [
        digestToken(token),
        user.id,
        Date.now() + SESSION_TTL,
      ]);
    })();
    store.audit(ip, user, "login");
    return {
      body: { ok: true, user: publicUser(user) },
      cookie: authCookie(store, "fs_session", token, SESSION_TTL / 1000),
    };
  }
  throw new HttpError(404, "見つかりません");
}
function checkIp(store: Store, ip: string) {
  const count = store.db
    .query("SELECT count(*) AS n FROM users WHERE ip=?")
    .get(ip) as { n: number };
  if (count.n >= store.config.registration.accountsPerIp)
    throw new HttpError(
      403,
      "このIPの登録上限です。管理者にお問い合わせください",
    );
}
function consumeChallenge(
  store: Store,
  cookie: string | undefined,
  kind: string,
  ip: string,
): any {
  const id = cookieValue(cookie, "fs_challenge");
  const row = store.db
    .query("DELETE FROM challenges WHERE id=? RETURNING *")
    .get(id) as any;
  if (!row || row.kind !== kind || row.ip !== ip || row.expires <= Date.now())
    throw new HttpError(400, "認証操作をやり直してください");
  return row;
}
