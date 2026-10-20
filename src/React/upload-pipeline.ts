import {
  BLOCK_BYTES,
  MAX_BLOCK_BYTES,
  MIN_BLOCK_BYTES,
  FRAME_HEADER,
  MAX_IN_FLIGHT,
  PIPELINE_PROTOCOL,
  PipelineWindow,
  packBlock,
} from "../shared/pipeline";
import { prepareChunk } from "./transfer";
export class PipelineError extends Error {
  constructor(
    message: string,
    public fatal = false,
  ) {
    super(message);
  }
}
/** One socket, a bounded application window, and only durable ACK offsets count as progress. */
export function uploadPipeline(options: {
  url: string;
  protocols?: string[];
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  file: Blob;
  offset: number;
  roundTripMs: number;
  compress: boolean;
  stopped: () => boolean;
  progress: (offset: number, speed: number) => void;
  signal?: AbortSignal;
  feedback?: (state: {
    window: number;
    inFlight: number;
    bytesPerSecond: number;
  }) => void;
}) {
  return new Promise<{ offset: number; stopped: boolean }>(
    (resolve, reject) => {
      const ws = new WebSocket(
          options.url,
          options.protocols ?? PIPELINE_PROTOCOL,
        ),
        control = new PipelineWindow(options.roundTripMs);
      let ready = false,
        pumping = false,
        settled = false,
        finishing = false,
        paused = false,
        next = options.offset,
        acknowledged = options.offset,
        lastActivity = performance.now(),
        connectionId = "",
        queuedWire = 0,
        sentAny = false;
      let compression = options.compress,
        blockBytes = BLOCK_BYTES,
        timer: ReturnType<typeof setTimeout> | undefined;
      const flight = new Map<
        number,
        { sent: number; bytes: number; wire: number; count: number }
      >();
      const stopTimer = setInterval(() => {
        if (options.stopped() || options.signal?.aborted) {
          paused = true;
          finish();
        } else if (
          !ready &&
          performance.now() - lastActivity > (options.connectTimeoutMs ?? 15000)
        ) {
          fail(new PipelineError("先送り転送の接続確認がタイムアウトしました"));
        } else if (performance.now() - lastActivity > (options.idleTimeoutMs ?? 180000)) {
          fail(new PipelineError("転送が途切れました"));
        }
      }, 200);
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearInterval(stopTimer);
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (ws.readyState < 2) ws.close();
        const settle = () =>
          error
            ? reject(error)
            : resolve({ offset: acknowledged, stopped: paused });
        if (connectionId && (error || paused)) {
          const url = new URL(options.url);
          url.protocol = url.protocol === "wss:" ? "https:" : "http:";
          url.pathname += "/stop";
          const controller = new AbortController(),
            deadline = setTimeout(() => controller.abort(), 8000);
          void fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ connectionId }),
            credentials: "same-origin",
            signal: controller.signal,
          })
            .catch(() => {})
            .finally(() => {
              clearTimeout(deadline);
              settle();
            });
        } else settle();
      };
      const fail = (error: unknown) => finish(error);
      const abort = () => {
        paused = true;
        finish();
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      const schedule = () => {
        if (timer || settled) return;
        timer = setTimeout(() => {
          timer = undefined;
          void pump();
        }, 10);
      };
      const pump = async () => {
        if (pumping || settled || !ready || finishing || paused) return;
        pumping = true;
        try {
          while (
            !settled &&
            ws.readyState === WebSocket.OPEN &&
            !options.stopped() &&
            next < options.file.size &&
            flight.size < MAX_IN_FLIGHT &&
            queuedWire < Math.max(16, control.window) * blockBytes
          ) {
            // Keep the browser network pipe saturated without unbounded memory growth.
            if (
              ws.bufferedAmount >
              blockBytes * Math.max(16, control.window)
            ) {
              schedule();
              break;
            }
            const offset = next,
              prepared = await prepareChunk(
                options.file.slice(offset, offset + blockBytes),
                compression,
              );
            if (
              settled ||
              ws.readyState !== WebSocket.OPEN ||
              options.stopped()
            )
              break;
            if (prepared.logicalBytes >= 32768 && !prepared.compressed)
              compression = false;
            const end = offset + prepared.logicalBytes,
              frame = packBlock(
                offset,
                prepared.body,
                prepared.logicalBytes,
                prepared.checksum,
                prepared.compressed,
              );
            flight.set(end, {
              sent: performance.now(),
              bytes: prepared.logicalBytes,
              wire: frame.byteLength,
              count: flight.size + 1,
            });
            queuedWire += frame.byteLength;
            next = end;
            sentAny = true;
            ws.send(frame);
          }
          if (
            !settled &&
            next === options.file.size &&
            flight.size === 0 &&
            !finishing
          ) {
            finishing = true;
            if (!sentAny) ws.send(JSON.stringify({ type: "finish" }));
          }
        } catch (error) {
          fail(error);
        } finally {
          pumping = false;
        }
      };
      ws.onmessage = async (event) => {
        lastActivity = performance.now();
        try {
          const message = JSON.parse(String(event.data));
          if (message.type === "error")
            throw new PipelineError(
              message.error ?? "転送を再開してください",
              [400, 401, 403, 404, 413, 507].includes(message.status),
            );
          if (message.type === "ready") {
            if (
              ready ||
              message.protocol !== PIPELINE_PROTOCOL ||
              message.size !== options.file.size ||
              ![
                MIN_BLOCK_BYTES,
                BLOCK_BYTES,
                2 * 1024 * 1024,
                MAX_BLOCK_BYTES,
              ].includes(message.blockBytes) ||
              message.maxInFlight !== MAX_IN_FLIGHT ||
              !Number.isSafeInteger(message.offset) ||
              message.offset < 0 ||
              message.offset > message.size
            )
              throw new PipelineError("転送設定が一致しません", true);
            if (typeof message.connectionId !== "string")
              throw new PipelineError("転送接続が不正です", true);
            connectionId = message.connectionId;
            blockBytes = message.blockBytes;
            ready = true;
            next = acknowledged = message.offset;
            if (message.receipt) {
              const receipt = message.receipt;
              if (
                !Number.isSafeInteger(receipt.start) ||
                !Number.isSafeInteger(receipt.length) ||
                receipt.start < 0 ||
                receipt.length < 1 ||
                receipt.length > 8 * 1024 * 1024 ||
                receipt.start + receipt.length !== message.offset
              )
                throw new PipelineError("再開位置が不正です", true);
              const bytes = await options.file
                .slice(receipt.start, receipt.start + receipt.length)
                .arrayBuffer();
              const hash = Array.from(
                new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
                (b) => b.toString(16).padStart(2, "0"),
              ).join("");
              if (hash !== receipt.hash)
                throw new PipelineError(
                  "前回と同じファイルを選択してください",
                  true,
                );
            }
            if (settled) return;
            options.progress(acknowledged, 0);
            ws.send(JSON.stringify({ type: "ping", nonce: performance.now() }));
            void pump();
            return;
          }
          if (message.type === "pong") {
            control.observeRtt(performance.now() - message.nonce);
            void pump();
            return;
          }
          if (message.type === "ack") {
            const frame = flight.get(message.offset);
            if (
              !frame ||
              message.offset !== acknowledged + frame.bytes ||
              message.bytes !== frame.bytes
            )
              throw new PipelineError("受領確認が一致しません", true);
            const result = control.acknowledge(
              frame.sent,
              performance.now(),
              frame.wire,
              Number(message.processingMs) || 0,
              frame.count,
            );
            options.feedback?.({
              window: result.window,
              inFlight: flight.size,
              bytesPerSecond: result.bytesPerSecond,
            });
            flight.delete(message.offset);
            queuedWire -= frame.wire;
            acknowledged = message.offset;
            options.progress(
              acknowledged,
              (result.bytesPerSecond * frame.bytes) / Math.max(1, frame.wire),
            );
            void pump();
            return;
          }
          if (message.type === "done") {
            if (
              !finishing ||
              acknowledged !== options.file.size ||
              message.offset !== acknowledged
            )
              throw new PipelineError("転送完了位置が一致しません", true);
            finish();
            return;
          }
          throw new PipelineError("転送応答が不正です", true);
        } catch (error) {
          fail(error);
        }
      };
      ws.onerror = () => fail(new PipelineError("先送り転送に接続できません"));
      ws.onclose = () => {
        if (paused) finish();
        else if (!settled) fail(new PipelineError("転送接続が切断されました"));
      };
    },
  );
}
