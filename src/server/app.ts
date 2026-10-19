import { attachUploadPipeline } from "./upload-pipeline";
import { gzipSync } from "node:zlib";
import { acceptsGzip, compressibleName } from "../shared/compression";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { readFile, stat, readdir } from "node:fs/promises";
import { Store, type User, type Item } from "./store";
import type { Config } from "./config";
import { HttpError, requireUser, requireAdmin, readItem } from "./policy";
import { sessionUser, publicUser, authRoute } from "./auth";
import { createTransport } from "./transport";
import {
  readBody,
  listItems,
  initUpload,
  getUpload,
  appendChunk,
  completeUpload,
  cancelUpload,
  mkdir,
  updateItem,
  unlock,
  trashItems,
  maintenance,
  cleanup,
  safeItem,
  sendFile,
  Bandwidth,
} from "./storage";
import { Previews } from "./preview";
import { startMonitor } from "./monitor";
import { seal, open as openEnvelope } from "@pexserver/secure-envelope";
import { ASSETS } from "../generated/v2assets";
import { adminAction } from "./admin";
import { ranking, recordDownload } from "./files";
// Public assets contain no session data. Encode once, then reuse bounded buffers.
const assetCache = Object.fromEntries(
  Object.entries(ASSETS).map(([path, asset]) => {
    const identity = Buffer.from(asset.body, "base64");
    const compressed =
      identity.length >= 1024 && compressibleName(path)
        ? gzipSync(identity, { level: 6 })
        : null;
    return [
      path,
      {
        type: asset.type,
        identity,
        gzip:
          compressed && compressed.length < identity.length ? compressed : null,
      },
    ];
  }),
);
export async function createApp(config: Config) {
  const store = new Store(config),
    previews = new Previews(store),
    bandwidth = new Bandwidth(config.rate.maxBytesPerSecond),
    active = new Map<string, number>();
  let totalTransfers = 0,
    globalWindow = Date.now(),
    globalRequests = 0;
  const reserveTransfer = (ip: string) => {
    if (
      (active.get(ip) ?? 0) >= config.rate.concurrentTransfersPerIp ||
      totalTransfers >= 32
    )
      throw new HttpError(429, "同時転送数の上限です");
    active.set(ip, (active.get(ip) ?? 0) + 1);
    totalTransfers++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (active.get(ip) ?? 1) - 1;
      if (n) active.set(ip, n);
      else active.delete(ip);
      totalTransfers--;
    };
  };
  const json = (
    res: ServerResponse,
    status: number,
    data: unknown,
    cookie?: string,
  ) => {
    if (cookie) res.setHeader("Set-Cookie", cookie);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
    });
    res.end(JSON.stringify(data));
  };
  const server = http.createServer(
    {
      maxHeaderSize: 16_384,
      requestTimeout: 0,
      headersTimeout: 15_000,
      keepAliveTimeout: 5000,
    },
    async (req, res) => {
      const ip = (req.socket as any).clientIp ?? "";
      let user: User | null = null;
      let releaseTransfer: (() => void) | undefined;
      const security: Record<string, string> = {
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Cache-Control": "no-store",
        "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
        "Content-Security-Policy": `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self' ${new URL(config.origin).origin.replace(/^http/, "ws")}; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
      };
      if (config.origin.startsWith("https:"))
        security["Strict-Transport-Security"] = "max-age=31536000";
      for (const [k, v] of Object.entries(security)) res.setHeader(k, v);
      try {
        if (!ip) throw new HttpError(403, "接続情報が不正です");
        req.setTimeout(90_000, () => req.destroy());
        if (Date.now() - globalWindow >= 60_000) {
          globalWindow = Date.now();
          globalRequests = 0;
        }
        if (++globalRequests > config.rate.globalRequestsPerMinute)
          throw new HttpError(429, "サーバーが混雑しています");
        if (
          !store.limit("request:" + ip, config.rate.requestsPerMinute, 60_000)
        ) {
          store.audit(ip, null, "rate.block");
          throw new HttpError(429, "リクエストが多すぎます");
        }
        const url = new URL(req.url ?? "/", config.origin),
          path = url.pathname,
          method = req.method ?? "GET";
        const expectedHost = new URL(config.origin).host;
        if (req.headers.host !== expectedHost)
          throw new HttpError(421, "公開URLからアクセスしてください");
        if (
          req.headers["sec-fetch-site"] === "cross-site" &&
          (!["GET", "HEAD"].includes(method) ||
            req.headers["sec-fetch-mode"] !== "navigate")
        )
          throw new HttpError(403, "外部サイトからのアクセスは許可されません");
        if (
          !["GET", "HEAD"].includes(method) &&
          req.headers.origin !== config.origin
        )
          throw new HttpError(403, "送信元を確認できません");
        user = sessionUser(store, req.headers.cookie);
        if (path === "/api/me" && method === "GET") {
          json(res, 200, {
            user: publicUser(user),
            capacity: config.capacityBytes,
            registration:
              config.registration.enabled &&
              store.registrationPolicy.publicRegistration,
            autoApprove: store.registrationPolicy.autoApprove,
            pipeline: "fileshare-upload-v1",
            setupRequired: !store.db
              .query("SELECT 1 FROM users WHERE level=4 LIMIT 1")
              .get(),
            preview: config.preview.enabled,
            filePolicy: store.filePolicy,
          });
          return;
        }
        if (path === "/healthz" && method === "GET") {
          json(res, 200, { ok: true });
          return;
        }
        if (path === "/api/rankings" && method === "GET") {
          json(res, 200, ranking(store, user));
          return;
        }
        if (path.startsWith("/api/auth/") && method === "POST") {
          if (!store.limit("auth:" + ip, config.rate.authPerMinute, 60_000)) {
            store.audit(ip, user, "auth.rate");
            throw new HttpError(429, "認証の試行回数が多すぎます");
          }
          const data = JSON.parse((await readBody(req)).toString() || "{}");
          try {
            const result = await authRoute(
              store,
              path.slice("/api/auth/".length),
              data,
              ip,
              req.headers.cookie,
              user,
            );
            json(res, 200, result.body, result.cookie);
          } catch (e) {
            store.audit(ip, user, "auth.failure");
            throw e;
          }
          return;
        }
        if (path === "/api/items" && method === "GET") {
          json(
            res,
            200,
            listItems(
              store,
              user,
              url.searchParams.get("parent"),
              url.searchParams.get("space") ?? "shared",
            ),
          );
          return;
        }
        const data = async () =>
          JSON.parse((await readBody(req)).toString() || "{}");
        if (path === "/api/folders" && method === "POST") {
          json(res, 201, mkdir(store, user, await data(), ip));
          return;
        }
        if (path === "/api/trash" && method === "POST") {
          json(res, 200, trashItems(store, user, (await data()).ids, ip));
          return;
        }
        if (path === "/api/uploads" && method === "POST") {
          json(res, 201, initUpload(store, user, await data()));
          return;
        }
        const streamStop =
          /^\/api\/uploads\/([a-f0-9-]{36})\/stream\/stop$/.exec(path);
        if (streamStop && method === "POST") {
          const data = JSON.parse((await readBody(req)).toString());
          if (
            typeof data.connectionId !== "string" ||
            data.connectionId.length > 64
          )
            throw new HttpError(400, "転送接続を指定してください");
          json(res, 200, {
            offset: await pipeline.stop(streamStop[1], user, data.connectionId),
          });
          return;
        }
        const upload =
          /^\/api\/uploads\/([a-f0-9-]{36})(?:\/(complete))?$/.exec(path);
        if (upload) {
          if (method === "GET" && !upload[2]) {
            const row = getUpload(store, user, upload[1]);
            json(res, 200, {
              id: row.id,
              offset: row.offset,
              size: row.size,
              encodings: ["identity", "gzip"],
              pipeline: "fileshare-upload-v1",
              receipt: row.receipt,
            });
            return;
          }
          if (method === "DELETE" && !upload[2]) {
            json(res, 200, await cancelUpload(store, user, upload[1]));
            return;
          }
          if (method === "POST" && upload[2]) {
            json(res, 200, await completeUpload(store, user, upload[1], ip));
            return;
          }
          if (method === "PATCH" && !upload[2]) {
            enterTransfer();
            json(
              res,
              200,
              await appendChunk(store, user, upload[1], req, bandwidth),
            );
            return;
          }
        }
        const itemRoute =
          /^\/api\/items\/([a-f0-9-]{36})(?:\/(unlock|ticket|preview))?$/.exec(
            path,
          );
        if (itemRoute) {
          const id = itemRoute[1],
            action = itemRoute[2];
          if (method === "GET" && !action) {
            json(res, 200, safeItem(store, readItem(store, user, id)));
            return;
          }
          if (method === "PATCH" && !action) {
            json(res, 200, updateItem(store, user, id, await data(), ip));
            return;
          }
          if (method === "POST" && action === "unlock") {
            json(res, 200, unlock(store, user, id, (await data()).key, ip));
            return;
          }
          if (method === "POST" && action === "ticket") {
            const i = readItem(store, user, id);
            if (i.folder)
              throw new HttpError(400, "ファイルを選択してください");
            const ticket = await seal(
              { id, user: user?.id ?? null },
              store.secret,
              "download",
              60_000,
            );
            json(res, 200, {
              url: "/api/download?ticket=" + encodeURIComponent(ticket),
            });
            return;
          }
          if (method === "POST" && action === "preview") {
            const i = readItem(store, user, id);
            requireUser(user);
            const status = await previews.request(i);
            json(res, 200, status);
            return;
          }
        }
        if (path === "/api/download" && ["GET", "HEAD"].includes(method)) {
          let payload: { id: string; user: string | null };
          try {
            payload = await openEnvelope(
              url.searchParams.get("ticket") ?? "",
              store.secret,
              "download",
            );
          } catch {
            throw new HttpError(403, "ダウンロードリンクが期限切れです");
          }
          if (payload.user !== (user?.id ?? null))
            throw new HttpError(403, "ログイン状態が変わりました");
          const item = readItem(store, user, payload.id);
          if (item.folder)
            throw new HttpError(400, "ファイルを選択してください");
          enterTransfer();
          const sent = await sendFile(
            req,
            res,
            join(store.blobDir, item.id),
            item,
            bandwidth,
            true,
          );
          if (sent) {
            recordDownload(
              store,
              item.id,
              url.searchParams.get("ticket") ?? "",
            );
            store.audit(ip, user, "download", item.id);
          }
          return;
        }
        const raw = /^\/api\/content\/([a-f0-9-]{36})(?:\/(preview))?$/.exec(
          path,
        );
        if (raw && ["GET", "HEAD"].includes(method)) {
          const item = readItem(store, user, raw[1]);
          if (item.folder)
            throw new HttpError(400, "ファイルを選択してください");
          if (raw[2] && !(await existsPreview(raw[1])))
            throw new HttpError(404, "プレビュー準備中です");
          enterTransfer();
          await sendFile(
            req,
            res,
            raw[2] ? previews.path(item.id) : join(store.blobDir, item.id),
            raw[2] ? { ...item, name: "preview.mp4" } : item,
            bandwidth,
            false,
          );
          return;
        }
        if (path.startsWith("/api/admin/")) {
          const admin = requireAdmin(user);
          const result = await adminAction(
            store,
            admin,
            ip,
            path,
            method,
            url,
            data,
          );
          if (result !== undefined) {
            json(res, 200, result);
            return;
          }
          if (path === "/api/admin/overview" && method === "GET") {
            const cacheBytes = (
              await Promise.all(
                (await readdir(store.cacheDir)).map((n) =>
                  stat(join(store.cacheDir, n)).then((s) => s.size),
                ),
              )
            ).reduce((a, b) => a + b, 0);
            json(res, 200, {
              users: store.db
                .query(
                  "SELECT id,name,level,status,quota,ip,created FROM users ORDER BY created DESC LIMIT 1000",
                )
                .all(),
              usage: store.usage(),
              capacity: config.capacityBytes,
              cacheBytes,
              trash: store.db
                .query(
                  "SELECT id,parent,name,folder,size,owner,deleted FROM items WHERE deleted IS NOT NULL AND NOT EXISTS(SELECT 1 FROM item_meta m WHERE m.item_id=items.id AND m.purged=1) ORDER BY deleted DESC LIMIT 500",
                )
                .all(),
              audit: store.db
                .query("SELECT * FROM audit ORDER BY id DESC LIMIT 100")
                .all(),
              reports: store.db
                .query("SELECT * FROM ai_reports ORDER BY id DESC LIMIT 10")
                .all(),
              aiEnabled: config.ai.enabled,
              uploads: store.db
                .query(
                  "SELECT id,name,size,offset,expires FROM uploads LIMIT 100",
                )
                .all(),
            });
            return;
          }
          if (path === "/api/admin/users" && method === "PATCH") {
            const body = await data(),
              target = store.user(String(body.id));
            if (!target) throw new HttpError(404, "ユーザーが見つかりません");
            const level = body.level ?? target.level,
              status = body.status ?? target.status,
              quota = body.quota ?? target.quota;
            if (
              !Number.isInteger(level) ||
              level < 0 ||
              level > 4 ||
              !["approved", "pending", "denied"].includes(status) ||
              !Number.isSafeInteger(quota) ||
              quota < 0 ||
              quota > config.capacityBytes
            )
              throw new HttpError(400, "権限または容量が不正です");
            const usage = store.usage(target.id);
            if (quota < usage.used + usage.reserved)
              throw new HttpError(409, "使用中の容量より小さくできません");
            if (
              target.level === 4 &&
              target.status === "approved" &&
              (level !== 4 || status !== "approved") &&
              (
                store.db
                  .query(
                    "SELECT count(*) AS n FROM users WHERE level=4 AND status='approved'",
                  )
                  .get() as { n: number }
              ).n <= 1
            )
              throw new HttpError(409, "最後の管理者は削除できません");
            store.db.transaction(() => {
              store.db.run(
                "UPDATE users SET level=?,status=?,quota=? WHERE id=?",
                [level, status, quota, target.id],
              );
              store.db.run("DELETE FROM sessions WHERE user_id=?", [target.id]);
              store.audit(
                ip,
                admin,
                "user.update",
                JSON.stringify({
                  id: target.id,
                  name: target.name,
                  before: {
                    level: target.level,
                    status: target.status,
                    quota: target.quota,
                  },
                  after: { level, status, quota },
                }),
              );
            })();
            json(res, 200, { ok: true });
            return;
          }
          if (path === "/api/admin/maintenance" && method === "POST") {
            const body = await data();
            json(
              res,
              200,
              await maintenance(store, user, body.action, body.ids, ip),
            );
            return;
          }
        }
        if (
          ["GET", "HEAD"].includes(method) &&
          (path === "/" ||
            path === "/admin" ||
            path === "/index.html" ||
            Object.hasOwn(ASSETS, path))
        ) {
          if (path === "/admin") requireAdmin(user);
          const asset =
            assetCache[
              path === "/" || path === "/admin" ? "/index.html" : path
            ];
          if (!asset) throw new HttpError(404, "見つかりません");
          const compressed =
            asset.gzip && acceptsGzip(req.headers["accept-encoding"]);
          const body = compressed ? asset.gzip! : asset.identity;
          res.writeHead(200, {
            "Content-Type": asset.type,
            "Content-Length": String(body.length),
            Vary: "Accept-Encoding",
            ...(compressed ? { "Content-Encoding": "gzip" } : {}),
          });
          res.end(method === "HEAD" ? undefined : body);
          return;
        }
        throw new HttpError(404, "見つかりません");
        function enterTransfer() {
          releaseTransfer = reserveTransfer(ip);
        }
      } catch (e) {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        let status =
          e instanceof HttpError
            ? e.status
            : e instanceof SyntaxError
              ? 400
              : 500;
        let message =
          e instanceof HttpError
            ? e.message
            : status === 400
              ? "入力形式が不正です"
              : "処理できませんでした";
        if ((e as any)?.code?.includes?.("SQLITE_CONSTRAINT")) {
          status = 409;
          message = "同じ名前が存在するか、操作が競合しました";
        }
        if (status === 500) console.error(e);
        if (status === 429) res.setHeader("Retry-After", "10");
        json(res, status, { error: message });
      } finally {
        releaseTransfer?.();
      }
    },
  );
  server.maxRequestsPerSocket = 1000;
  server.on("clientError", (_e, socket) => {
    if (socket.writable)
      socket.end(
        "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
  });
  const pipeline = attachUploadPipeline(server, store, bandwidth, (ip) => {
    if (Date.now() - globalWindow >= 60000) {
      globalWindow = Date.now();
      globalRequests = 0;
    }
    if (
      ++globalRequests > config.rate.globalRequestsPerMinute ||
      !store.limit("request:" + ip, config.rate.requestsPerMinute, 60000) ||
      !store.limit(
        "pipeline-connect:" + ip,
        Math.max(
          1,
          Math.min(120, Math.floor(config.rate.requestsPerMinute / 3)),
        ),
        60000,
      )
    )
      throw new HttpError(429, "転送接続が多すぎます");
    return reserveTransfer(ip);
  });
  const transport = createTransport(config, server);
  await new Promise<void>((resolve, reject) => {
    transport.server.once("error", reject);
    transport.server.listen(config.port, config.host, resolve);
  });
  const stopMonitor = startMonitor(store);
  // Enforce explicitly selected file deadlines and clear abandoned transfers.
  await cleanup(store);
  await previews.prune();
  let janitorRuns = 0;
  const janitor = setInterval(() => {
    cleanup(store, ++janitorRuns % 60 === 0)
      .then(() => previews.prune())
      .catch(console.error);
  }, 60_000);
  janitor.unref();
  async function existsPreview(id: string) {
    try {
      await stat(previews.path(id));
      return true;
    } catch {
      return false;
    }
  }
  return {
    store,
    server: transport.server,
    close() {
      clearInterval(janitor);
      stopMonitor();
      transport.close();
      server.close();
      const pending = pipeline.close();
      if (pending) return pending.finally(() => store.db.close());
      store.db.close();
    },
  };
}
