import { assertStorageAvailable } from "./volumes";
import {
  readDurablePrefix,
  pendingEdge,
  publishEdge,
  contentLocation,
  authorizeContent,
} from "./edge-files";
import { searchPublic } from "./search";
import { socialHtml } from "./social";
import {
  profile,
  saveProfile,
  userFiles,
  uploaderRanking,
  profileAllowed,
  searchUploaders,
} from "./community";
import { previewKind } from "../shared/preview";
import { attachUploadPipeline } from "./upload-pipeline";
import {
  createEdgeUploadTicket,
  loadEdgeSecret,
  verifyEdgeRequestSignature,
} from "./edge-auth";
import { blockBytesForSize, MAX_BLOCK_BYTES } from "../shared/pipeline";
import { gzipSync } from "node:zlib";
import { acceptsGzip, compressibleName } from "../shared/compression";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { join } from "node:path";
import { readFile, stat, readdir, open as openFile } from "node:fs/promises";
import { Store, type User, type Item } from "./store";
import type { Config } from "./config";
import {
  HttpError,
  requireUser,
  requireAdmin,
  readItem,
  canRead,
} from "./policy";
import { sessionUser, publicUser, authRoute, cookieValue } from "./auth";
import { createTransport } from "./transport";
import {
  readBody,
  listItems,
  initUpload,
  getUpload,
  leaseUpload,
  commitUploadBlock,
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
import {
  seal,
  digestToken,
  open as openEnvelope,
} from "@pexserver/secure-envelope";
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
    edgeSecret = config.edgeSpool.enabled ? loadEdgeSecret() : null,
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
  const edgeInfo = (
    row: any,
    user: User | null,
    ip: string,
    session: string,
  ) => {
    if (!edgeSecret || !user || !isIP(ip)) return undefined;
    const ticket = createEdgeUploadTicket(edgeSecret, {
      v: 1,
      scope: "edge-upload",
      id: row.id,
      userId: user.id,
      session: digestToken(session),
      clientIp: ip,
      size: row.size,
      blockBytes: Math.min(1024 * 1024, blockBytesForSize(row.size)),
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    });
    return {
      path: config.edgeSpool.path + "/" + row.id,
      ticket,
      blockBytes: Math.min(1024 * 1024, blockBytesForSize(row.size)),
    };
  };
  const server = http.createServer(
    {
      maxHeaderSize: 16_384,
      requestTimeout: 0,
      headersTimeout: 15_000,
      keepAliveTimeout: 5000,
    },
    async (req, res) => {
      // FerrumProxy HTTP/1 path routing currently selects an origin per TCP
      // connection. A fresh HTTP/1 connection must select A1 vs A8 again.
      // Its HTTP/3 bridge strips hop headers and keeps the QUIC connection alive.
      if (config.edgeSpool.enabled) res.setHeader("Connection", "close");
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
        "Content-Security-Policy": `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' ${new URL(config.origin).origin.replace(/^http/, "ws")}; font-src 'self'; frame-src 'self'; object-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
      };
      if (config.origin.startsWith("https:"))
        security["Strict-Transport-Security"] = "max-age=31536000";
      for (const [k, v] of Object.entries(security)) res.setHeader(k, v);
      if (config.http3Port)
        res.setHeader("Alt-Svc", `h3=":${config.http3Port}"; ma=300`);
      try {
        if (!ip) throw new HttpError(403, "接続情報が不正です");
        req.setTimeout(90_000, () => req.destroy());
        const trustedInternal =
          config.edgeSpool.enabled &&
          ip === config.edgeSpool.trustedIp &&
          req.url?.startsWith("/api/internal/edge-sync/");
        if (!trustedInternal) {
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
            pipeline: "fileshare-upload-v2",
            edgeSpool: config.edgeSpool.enabled,
            setupRequired: !store.db
              .query("SELECT 1 FROM users WHERE level=4 LIMIT 1")
              .get(),
            preview: config.preview.enabled,
            filePolicy: store.filePolicy,
            maintenanceUntil:
              store.maintenanceUntil && store.maintenanceUntil > Date.now()
                ? store.maintenanceUntil
                : null,
          });
          return;
        }
        if (
          store.maintenanceUntil &&
          store.maintenanceUntil > Date.now() &&
          path.startsWith("/api/") &&
          user?.level !== 4 &&
          !path.startsWith("/api/auth/")
        )
          throw new HttpError(
            503,
            "メンテナンス中です。管理者以外は操作できません",
          );
        if (path === "/healthz" && method === "GET") {
          json(res, 200, { ok: true });
          return;
        }
        if (path === "/api/profile" && method === "GET") {
          const current = requireUser(user);
          if (!profileAllowed(current))
            throw new HttpError(
              403,
              "プロフィールの編集はVIP・スタッフ・管理者のみ利用できます",
            );
          json(res, 200, profile(store, current.id, true));
          return;
        }
        if (path === "/api/profile" && method === "PATCH") {
          json(
            res,
            200,
            saveProfile(
              store,
              user,
              JSON.parse((await readBody(req, 1600000)).toString()),
              ip,
            ),
          );
          return;
        }
        if (path === "/api/users" && method === "GET") {
          json(
            res,
            200,
            searchUploaders(
              store,
              user,
              url.searchParams.get("q") ?? "",
              url.searchParams.get("after") ?? "",
            ),
          );
          return;
        }
        const authorRoute =
          /^\/api\/users\/([^/]+)(?:\/(files|avatar|cover))?$/.exec(path);
        if (authorRoute && ["GET", "HEAD"].includes(method)) {
          const id = decodeURIComponent(authorRoute[1]);
          const author = profile(store, id);
          if (authorRoute[2] === "avatar" || authorRoute[2] === "cover") {
            const kind = authorRoute[2];
            const row = store.db
              .query(
                `SELECT ${kind},${kind}_type FROM profiles WHERE user_id=?`,
              )
              .get(id) as any;
            if (!row?.[kind + "_type"] || !profileAllowed(store.user(id)!))
              throw new HttpError(404, "アイコンがありません");
            res.writeHead(200, {
              "Content-Type": row[kind + "_type"],
              "Content-Length": String(row[kind].length),
            });
            res.end(method === "HEAD" ? undefined : row[kind]);
            return;
          }
          json(
            res,
            200,
            authorRoute[2] === "files"
              ? userFiles(
                  store,
                  user,
                  id,
                  Number(url.searchParams.get("offset") ?? 0),
                )
              : author,
          );
          return;
        }
        if (path === "/api/rankings/uploaders" && method === "GET") {
          json(res, 200, uploaderRanking(store, user));
          return;
        }
        const textPreview = /^\/api\/items\/([a-f0-9-]{36})\/text$/.exec(path);
        if (textPreview && method === "GET") {
          const item = readItem(store, user, textPreview[1]);
          assertStorageAvailable(store, item);
          if (
            item.folder ||
            !["text", "markdown"].includes(previewKind(item.name))
          )
            throw new HttpError(400, "テキスト形式を選択してください");
          if (edgeSecret && config.edgeSpool.enabled) {
            res.writeHead(307, {
              Location: contentLocation(
                store,
                edgeSecret,
                item,
                ip,
                user,
                cookieValue(req.headers.cookie, "fs_session"),
                false,
                null,
              ).replace("/content?", "/text?"),
            });
            res.end();
            return;
          }
          enterTransfer();
          const handle = await openFile(store.blobPath(item.id), "r");
          try {
            const buffer = Buffer.alloc(Math.min(item.size, 512 * 1024));
            const { bytesRead } = await handle.read(
              buffer,
              0,
              buffer.length,
              0,
            );
            await bandwidth.acquire(bytesRead);
            json(res, 200, {
              text: buffer.subarray(0, bytesRead).toString("utf8"),
              truncated: item.size > bytesRead,
            });
          } finally {
            await handle.close();
          }
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
        if (path === "/api/search" && method === "GET") {
          json(res, 200, searchPublic(store, url));
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
        if (path === "/api/items/move" && method === "POST") {
          const body = await data();
          if (
            !Array.isArray(body.ids) ||
            !body.ids.length ||
            body.ids.length > 200 ||
            body.ids.some((x: unknown) => typeof x !== "string") ||
            new Set(body.ids).size !== body.ids.length ||
            (body.parent !== null && typeof body.parent !== "string")
          )
            throw new HttpError(
              400,
              "移動するファイルとフォルダを確認してください",
            );
          store.db.transaction(() => {
            for (const id of body.ids)
              updateItem(store, user, id, { parent: body.parent }, ip);
          })();
          json(res, 200, { ok: true });
          return;
        }
        if (path === "/api/folders" && method === "POST") {
          json(res, 201, mkdir(store, user, await data(), ip));
          return;
        }
        if (path === "/api/trash" && method === "POST") {
          json(res, 200, trashItems(store, user, (await data()).ids, ip));
          return;
        }
        if (path === "/api/uploads" && method === "POST") {
          const upload = initUpload(store, user, await data()),
            row = getUpload(store, user, upload.id),
            edge = edgeInfo(
              row,
              user,
              ip,
              cookieValue(req.headers.cookie, "fs_session"),
            );
          json(res, 201, { ...upload, ...(edge ? { edge } : {}) });
          return;
        }
        const edgeSync =
          /^\/api\/internal\/edge-sync\/([a-f0-9-]{36})(?:\/(chunk|publish|complete|authorize|origin|prefix))?$/.exec(
            path,
          );
        if (edgeSync) {
          if (
            !edgeSecret ||
            !config.edgeSpool.enabled ||
            ip !== config.edgeSpool.trustedIp
          )
            throw new HttpError(403, "中継サーバーを確認できません");
          const rawBody =
            method === "POST"
              ? await readBody(req, MAX_BLOCK_BYTES)
              : Buffer.alloc(0);
          if (
            !verifyEdgeRequestSignature(
              edgeSecret,
              method,
              req.url ?? path,
              String(req.headers["x-fileshare-edge-time"] ?? ""),
              rawBody,
              String(req.headers["x-fileshare-edge-signature"] ?? ""),
            )
          )
            throw new HttpError(401, "中継認証を確認できません");
          if (edgeSync[2] === "authorize" && method === "POST") {
            const body = JSON.parse(rawBody.toString());
            const result = authorizeContent(store, edgeSecret, body);
            if (result.id !== edgeSync[1])
              throw new HttpError(403, "ファイルが一致しません");
            json(res, 200, result);
            return;
          }
          if (edgeSync[2] === "prefix" && method === "GET") {
            const bytes = await readDurablePrefix(
              store,
              edgeSync[1],
              Number(url.searchParams.get("offset")),
              Number(url.searchParams.get("length")),
            );
            await bandwidth.acquire(bytes.length);
            res.writeHead(200, {
              "Content-Type": "application/octet-stream",
              "Content-Length": String(bytes.length),
              "Cache-Control": "no-store",
            });
            res.end(bytes);
            return;
          }
          if (edgeSync[2] === "origin" && ["GET", "HEAD"].includes(method)) {
            const item = store.item(edgeSync[1]);
            if (item) assertStorageAvailable(store, item);
            if (!item || pendingEdge(store, item.id))
              throw new HttpError(404, "ファイルがまだA1にあります");
            await sendFile(
              req,
              res,
              store.blobPath(item.id),
              item,
              bandwidth,
              false,
            );
            return;
          }
          const uploadId = edgeSync[1],
            row = store.db
              .query("SELECT user_id FROM uploads WHERE id=?")
              .get(uploadId) as { user_id: string } | null;
          if (!row) {
            const item = store.item(uploadId);
            if (item && method === "POST" && edgeSync[2] === "publish") {
              json(res, 200, safeItem(store, item));
              return;
            }
            if (
              item &&
              ((method === "GET" && !edgeSync[2]) ||
                (method === "POST" && edgeSync[2] === "complete"))
            ) {
              json(res, 200, {
                done: true,
                offset: item.size,
                size: item.size,
              });
              return;
            }
            throw new HttpError(404, "転送が見つかりません");
          }
          const owner = store.user(row.user_id),
            current = getUpload(store, owner, uploadId, true);
          if (method === "POST" && edgeSync[2] === "publish") {
            const body = JSON.parse(rawBody.toString());
            if (
              !store.db
                .query(
                  "SELECT 1 FROM sessions WHERE hash=? AND user_id=? AND expires>?",
                )
                .get(String(body.session ?? ""), row.user_id, Date.now())
            )
              throw new HttpError(
                403,
                "ログインし直してから転送を再開してください",
              );
            if (body.size !== current.size || body.offset !== current.size)
              throw new HttpError(409, "A1の受領が完了していません");
            json(res, 200, publishEdge(store, owner, uploadId, ip));
            return;
          }
          if (method === "POST" && edgeSync[2] === "complete") {
            json(
              res,
              200,
              await completeUpload(store, owner, uploadId, ip, true),
            );
            return;
          }
          if (method === "GET" && !edgeSync[2]) {
            json(res, 200, {
              done: false,
              offset: current.offset,
              size: current.size,
              receipt: current.receipt,
            });
            return;
          }
          if (method === "POST" && edgeSync[2] === "chunk") {
            enterTransfer();
            const offset = Number(req.headers["upload-offset"]),
              checksum = String(req.headers["upload-checksum"] ?? "");
            if (!Number.isSafeInteger(offset) || offset < 0)
              throw new HttpError(400, "転送位置が不正です");
            await bandwidth.acquire(rawBody.length);
            const release = leaseUpload(uploadId);
            try {
              const result = await commitUploadBlock(
                store,
                owner,
                uploadId,
                offset,
                rawBody,
                checksum,
                "identity",
                MAX_BLOCK_BYTES,
                undefined, // Edge blocks have their own geometry; hash, size and sequential offset are checked by commitUploadBlock.
                true,
              );
              json(res, 200, result);
            } finally {
              release();
            }
            return;
          }
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
            try {
              const row = getUpload(store, user, upload[1]),
                edge = edgeInfo(
                  row,
                  user,
                  ip,
                  cookieValue(req.headers.cookie, "fs_session"),
                );
              json(res, 200, {
                id: row.id,
                offset: row.offset,
                size: row.size,
                encodings: ["identity", "gzip"],
                pipeline: "fileshare-upload-v2",
                receipt: row.receipt,
                ...(edge ? { edge } : {}),
              });
            } catch (error) {
              if (!(error instanceof HttpError && error.status === 404 && user))
                throw error;
              const meta = store.db
                  .query("SELECT uploaded_by FROM item_meta WHERE item_id=?")
                  .get(upload[1]) as { uploaded_by: string | null } | null,
                item = store.item(upload[1]);
              if (
                !item ||
                item.folder ||
                item.deleted ||
                item.purged ||
                meta?.uploaded_by !== user.id
              )
                throw error;
              json(res, 200, {
                id: item.id,
                offset: item.size,
                size: item.size,
                name: item.name,
                completed: true,
              });
            }
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
            assertStorageAvailable(store, i);
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
          if (method === "GET" && action === "preview") {
            const item = readItem(store, user, id);
            assertStorageAvailable(store, item);
            json(res, 200, {
              ...previews.status(item),
              canCreate:
                !!user &&
                config.preview.enabled &&
                !pendingEdge(store, item.id),
              maxSeconds: config.preview.maxSeconds,
            });
            return;
          }
          if (method === "POST" && action === "preview") {
            const i = readItem(store, user, id);
            assertStorageAvailable(store, i);
            requireUser(user);
            if (pendingEdge(store, i.id))
              throw new HttpError(
                409,
                "元動画は再生できます。軽量版の作成はA8への保存後に利用できます",
              );
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
          assertStorageAvailable(store, item);
          if (item.folder)
            throw new HttpError(400, "ファイルを選択してください");
          if (edgeSecret && config.edgeSpool.enabled) {
            res.writeHead(307, {
              Location: contentLocation(
                store,
                edgeSecret,
                item,
                ip,
                user,
                cookieValue(req.headers.cookie, "fs_session"),
                true,
                url.searchParams.get("ticket"),
              ),
            });
            res.end();
            return;
          }
          enterTransfer();
          const sent = await sendFile(
            req,
            res,
            store.blobPath(item.id),
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
          assertStorageAvailable(store, item);
          if (item.folder)
            throw new HttpError(400, "ファイルを選択してください");
          if (!raw[2] && edgeSecret && config.edgeSpool.enabled) {
            res.writeHead(307, {
              Location: contentLocation(
                store,
                edgeSecret,
                item,
                ip,
                user,
                cookieValue(req.headers.cookie, "fs_session"),
                false,
                null,
              ),
            });
            res.end();
            return;
          }
          if (raw[2] && !(await existsPreview(raw[1])))
            throw new HttpError(404, "プレビュー準備中です");
          res.removeHeader("X-Frame-Options");
          res.setHeader(
            "Content-Security-Policy",
            `sandbox; default-src 'none'; frame-ancestors ${canRead(store, null, item) ? "*" : "'self'"}`,
          );
          enterTransfer();
          await sendFile(
            req,
            res,
            raw[2] ? previews.path(item.id) : store.blobPath(item.id),
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
              metrics: {
                users: (
                  store.db.query("SELECT COUNT(*) AS n FROM users").get() as any
                ).n,
                pending: (
                  store.db
                    .query(
                      "SELECT COUNT(*) AS n FROM users WHERE status='pending'",
                    )
                    .get() as any
                ).n,
                replicas: (
                  store.db
                    .query(
                      "SELECT COUNT(*) AS n FROM edge_files WHERE pending=1",
                    )
                    .get() as any
                ).n,
              },
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
            path === "/rankings" ||
            path === "/search" ||
            path === "/users" ||
            path === "/profile" ||
            /^\/users\/[^/]+$/.test(path) ||
            /^\/files\/[a-f0-9-]{36}\/preview$/.test(path) ||
            path === "/index.html" ||
            Object.hasOwn(ASSETS, path))
        ) {
          if (path === "/admin") requireAdmin(user);
          if (/^\/files\/[a-f0-9-]{36}\/preview$/.test(path)) {
            const file = readItem(store, user, path.split("/")[2]);
            try {
              assertStorageAvailable(store, file);
            } catch (error) {
              if (!(error instanceof HttpError)) throw error;
              res.writeHead(404, {
                "Content-Type": "text/html; charset=utf-8",
                "Cache-Control": "no-store",
              });
              res.end(
                `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="15"><title>404 · 破損・接続不可 | FileShare</title><link rel="stylesheet" href="/theme.css"><main class="panel storage-error"><strong>404</strong><h1>破損・接続不可</h1><p>保存先ドライブまたはファイルを確認できません。ドライブの再接続後に再読み込みしてください。</p><a href="${path}">再読み込み</a> · <a href="/">FileShareへ戻る</a></main></html>`,
              );
              return;
            }
            res.removeHeader("X-Frame-Options");
            res.setHeader(
              "Content-Security-Policy",
              security["Content-Security-Policy"].replace(
                "frame-ancestors 'none'",
                "frame-ancestors *",
              ),
            );
          }
          const asset =
            assetCache[Object.hasOwn(ASSETS, path) ? path : "/index.html"];
          if (!asset) throw new HttpError(404, "見つかりません");
          const html = asset.type.startsWith("text/html")
            ? Buffer.from(
                socialHtml(store, url, asset.identity.toString("utf8")),
              )
            : null;
          const identity = html ?? asset.identity;
          const encoded = html
            ? html.length >= 1024
              ? gzipSync(html, { level: 1 })
              : null
            : asset.gzip;
          const compressed =
            encoded && acceptsGzip(req.headers["accept-encoding"]);
          const body = compressed ? encoded! : identity;
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
        const unavailable = ["ENOENT", "ENODEV", "ESTALE", "EIO"].includes(
          (e as NodeJS.ErrnoException).code ?? "",
        );
        let status =
          e instanceof HttpError
            ? e.status
            : unavailable
              ? 404
              : e instanceof SyntaxError
                ? 400
                : 500;
        let message =
          e instanceof HttpError
            ? e.message
            : unavailable
              ? "破損・接続不可：保存先ドライブまたはファイルを確認できません"
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
