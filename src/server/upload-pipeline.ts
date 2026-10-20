import { randomUUID } from "node:crypto";
import type { User } from "./store";
import { WebSocketServer, WebSocket } from "ws-node";
import type http from "node:http";
import type { Store } from "./store";
import { sessionUser } from "./auth";
import { loadEdgeSecret, verifyDirectUploadTicket } from "./edge-auth";
import { HttpError } from "./policy";
import {
  getUpload,
  leaseUpload,
  commitUploadBlock,
  type Bandwidth,
} from "./storage";
import {
  BLOCK_BYTES,
  MAX_BLOCK_BYTES,
  blockBytesForSize,
  FRAME_HEADER,
  MAX_IN_FLIGHT,
  PIPELINE_PROTOCOL,
  unpackBlock,
} from "../shared/pipeline";

export function attachUploadPipeline(
  server: http.Server,
  store: Store,
  bandwidth: Bandwidth,
  reserve: (ip: string) => () => void,
) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: FRAME_HEADER + MAX_BLOCK_BYTES,
    perMessageDeflate: false,
    handleProtocols: (protocols) =>
      protocols.has(PIPELINE_PROTOCOL) ? PIPELINE_PROTOCOL : false,
  });
  const jobs = new Set<Promise<void>>();
  const sessions = new Set<WebSocket>();
  const streams = new Map<
    string,
    { connectionId: string; abort: () => Promise<void> | undefined }
  >();
  server.on("upgrade", (req, socket, head) => {
    let releaseTransfer: (() => void) | undefined,
      releaseUpload: (() => void) | undefined;
    try {
      const config = store.config,
        ip = (req.socket as any).clientIp ?? "";
      const host = new URL(config.origin).host;
      const direct =
        (config.directIpv6.enabled || config.webrtc.enabled) &&
        req.headers.host === config.directIpv6.host + ":" + config.directIpv6.port;
      if (
        !ip ||
        (req.headers.host !== host && !direct) ||
        req.headers.origin !== config.origin ||
        req.headers["sec-fetch-site"] === "cross-site"
      )
        throw new HttpError(403, "送信元を確認できません");
      const protocols = String(req.headers["sec-websocket-protocol"] ?? "")
        .split(",").map(s => s.trim());
      const directTicket = direct
        ? verifyDirectUploadTicket(loadEdgeSecret(), protocols[1] ?? "")
        : null;
      if (direct && (protocols.length !== 2 || !directTicket))
        throw new HttpError(403, "IPv6直接転送の認証が無効です");
      const currentUser = () => {
        if (!direct) return sessionUser(store, req.headers.cookie);
        if (!directTicket || !store.db.query(
          "SELECT 1 FROM sessions WHERE hash=? AND user_id=? AND expires>?"
        ).get(directTicket.session, directTicket.userId, Date.now()))
          return null;
        return store.user(directTicket.userId);
      };
      const handshakeUser = currentUser();
      if (
        store.maintenanceUntil &&
        store.maintenanceUntil > Date.now() &&
        handshakeUser?.level !== 4
      )
        throw new HttpError(
          503,
          "メンテナンス中です。管理者以外は操作できません",
        );
      const match = /^\/api\/uploads\/([a-f0-9-]{36})\/stream$/.exec(
        req.url ?? "",
      );
      if (
        !match ||
        req.method !== "GET" ||
        !String(req.headers["sec-websocket-protocol"] ?? "")
          .split(",")
          .map((s) => s.trim())
          .includes(PIPELINE_PROTOCOL)
      )
        throw new HttpError(400, "未対応の転送プロトコルです");
      releaseTransfer = reserve(ip);
      const id = match[1],
        user = handshakeUser,
        row = getUpload(store, user, id);
      if (direct && (!directTicket || directTicket.id !== id ||
          directTicket.userId !== row.user_id || directTicket.size !== row.size))
        throw new HttpError(403, "IPv6転送予約が一致しません");
      releaseUpload = leaseUpload(id);
      // Validate handshake fields before ws takes ownership; failed upgrades must release leases.
      if (
        req.headers.upgrade?.toLowerCase() !== "websocket" ||
        req.headers["sec-websocket-version"] !== "13" ||
        !/^[+/0-9A-Za-z]{22}==$/.test(
          String(req.headers["sec-websocket-key"] ?? ""),
        )
      )
        throw new HttpError(400, "接続形式が不正です");
      const transferLease = releaseTransfer,
        uploadLease = releaseUpload;
      let handed = false;
      const abandon = () => {
        if (!handed) {
          uploadLease();
          transferLease();
        }
      };
      socket.once("close", abandon);
      wss.handleUpgrade(req, socket, head, (ws) => {
        handed = true;
        socket.off("close", abandon);
        sessions.add(ws);
        const connectionId = randomUUID();
        const blockBytes = blockBytesForSize(row.size);
        let currentJob: Promise<void> | undefined;
        let expected = row.offset,
          processing = false,
          closing = false,
          released = false,
          finishRequested = false,
          lastSeen = Date.now(),
          lastProgress = Date.now();
        const queue: ReturnType<typeof unpackBlock>[] = [];
        const release = () => {
          if (!released) {
            released = true;
            uploadLease();
            transferLease();
          }
        };
        const send = (value: unknown) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
        };
        const fail = (error: unknown) => {
          if (closing) return;
          closing = true;
          queue.length = 0;
          const e =
            error instanceof HttpError
              ? error
              : new HttpError(400, "転送データを確認してください");
          send({ type: "error", status: e.status, error: e.message });
          ws.close(1008, "Upload rejected");
          if (!processing) release();
        };
        const finish = () => {
          if (!finishRequested || processing || queue.length || closing) return;
          try {
            const final = getUpload(
              store,
              currentUser(),
              id,
            );
            if (final.offset !== final.size)
              throw new HttpError(409, "転送が完了していません");
            closing = true;
            release();
            send({ type: "done", offset: final.offset });
            ws.close(1000, "Upload received");
          } catch (error) {
            fail(error);
          }
        };
        const pump = () => {
          if (processing || closing) return;
          processing = true;
          const job = (async () => {
            try {
              while (queue.length && !closing) {
                if (
                  store.maintenanceUntil &&
                  store.maintenanceUntil > Date.now() &&
                  currentUser()?.level !== 4
                )
                  throw new HttpError(
                    503,
                    "メンテナンス中です。再開後に転送できます",
                  );
                const block = queue.shift()!,
                  start = performance.now();
                await bandwidth.acquire(block.bytes.length);
                if (closing) break;
                const result = await commitUploadBlock(
                  store,
                  currentUser(),
                  id,
                  block.offset,
                  Buffer.from(
                    block.bytes.buffer,
                    block.bytes.byteOffset,
                    block.bytes.byteLength,
                  ),
                  block.checksum,
                  block.compressed ? "gzip" : "identity",
                  MAX_BLOCK_BYTES,
                  block.logicalBytes,
                );
                if (result.offset !== block.offset + block.logicalBytes)
                  throw new HttpError(400, "展開後のサイズが一致しません");
                if (result.offset === row.size) finishRequested = true;
                send({
                  type: "ack",
                  offset: result.offset,
                  bytes: block.logicalBytes,
                  processingMs: performance.now() - start,
                });
              }
            } catch (error) {
              fail(error);
            } finally {
              processing = false;
              if (closing) release();
              else finish();
            }
          })();
          currentJob = job;
          jobs.add(job);
          void job.finally(() => jobs.delete(job));
        };
        ws.on("message", (raw, binary) => {
          lastSeen = Date.now();
          if (closing) return;
          try {
            // An already open WebSocket must not bypass a newly enabled lockdown.
            if (
              store.maintenanceUntil &&
              store.maintenanceUntil > Date.now() &&
              currentUser()?.level !== 4
            )
              throw new HttpError(
                503,
                "メンテナンス中です。再開後に転送できます",
              );
            if (!binary) {
              if (!store.limit("pipeline-control:" + ip, 120, 60000))
                throw new HttpError(429, "転送操作が多すぎます");
              if (Buffer.byteLength(raw.toString()) > 256)
                throw new HttpError(400, "制御データが大きすぎます");
              const message = JSON.parse(raw.toString());
              if (
                message.type === "ping" &&
                typeof message.nonce === "number" &&
                Number.isFinite(message.nonce)
              ) {
                send({ type: "pong", nonce: message.nonce });
                return;
              }
              if (message.type === "finish" && !finishRequested) {
                finishRequested = true;
                finish();
                return;
              }
              throw new HttpError(400, "未対応の転送操作です");
            }
            if (
              finishRequested ||
              queue.length + (processing ? 1 : 0) >= MAX_IN_FLIGHT
            )
              throw new HttpError(429, "先送り転送の上限です");
            const buffer = Buffer.isBuffer(raw)
                ? raw
                : Buffer.concat(raw as Buffer[]),
              block = unpackBlock(buffer);
            getUpload(store, currentUser(), id);
            if (
              block.offset !== expected ||
              block.offset + block.logicalBytes > row.size ||
              block.logicalBytes !==
                Math.min(blockBytes, row.size - block.offset)
            )
              throw new HttpError(409, "転送位置が一致しません");
            lastProgress = Date.now();
            expected += block.logicalBytes;
            queue.push(block);
            pump();
          } catch (error) {
            fail(error);
          }
        });
        ws.on("pong", () => {
          lastSeen = Date.now();
        });
        ws.on("error", () => {
          closing = true;
          queue.length = 0;
          if (!processing) release();
        });
        ws.once("close", () => {
          clearInterval(heartbeat);
          sessions.delete(ws);
          if (streams.get(id)?.connectionId === connectionId)
            streams.delete(id);
          closing = true;
          queue.length = 0;
          if (!processing) release();
        });
        const heartbeat = setInterval(() => {
          if (
            Date.now() - lastSeen > 180000 ||
            Date.now() - lastProgress > 180000
          )
            ws.terminate();
          else if (ws.readyState === WebSocket.OPEN) ws.ping();
        }, 30000);
        heartbeat.unref();
        streams.set(id, {
          connectionId,
          abort: () => {
            closing = true;
            queue.length = 0;
            ws.terminate();
            if (!processing) release();
            return currentJob;
          },
        });
        send({
          type: "ready",
          connectionId,
          receipt: row.receipt,
          protocol: PIPELINE_PROTOCOL,
          offset: row.offset,
          size: row.size,
          blockBytes,
          maxInFlight: MAX_IN_FLIGHT,
        });
      });
      // handleUpgrade emits a socket error response for unsupported keys/version. All fields above were validated.
    } catch (error) {
      releaseUpload?.();
      releaseTransfer?.();
      const status = error instanceof HttpError ? error.status : 400;
      socket.end(
        `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
    }
  });
  return {
    async stop(id: string, user: User | null, connectionId: string) {
      getUpload(store, user, id);
      const stream = streams.get(id);
      if (stream?.connectionId === connectionId) await stream.abort();
      return getUpload(store, user, id).offset;
    },
    close() {
      for (const ws of sessions) ws.terminate();
      wss.close();
      return jobs.size
        ? Promise.allSettled([...jobs]).then(() => {})
        : undefined;
    },
  };
}
