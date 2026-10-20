import { prepareChunk } from "./transfer";
import { uploadPipeline, PipelineError } from "./upload-pipeline";
import { PIPELINE_PROTOCOL } from "../shared/pipeline";

export type EdgeStatus = {
  size: number;
  blockBytes?: number;
  pipeline?: string;
  offset: number;
  receivedBytes: number;
  replicatedOffset: number;
  state: "receiving" | "syncing" | "ready" | "complete" | "error";
  receipt?: { start: number; length: number; hash: string } | null;
  error?: string;
};

export class EdgeUploadError extends Error {
  constructor(
    message: string,
    public fatal = false,
    public status?: number,
  ) {
    super(message);
  }
}

async function edgeRequest(
  path: string,
  ticket: string,
  method: string,
  options: {
    body?: BodyInit;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      Authorization: "Bearer " + ticket,
      ...(options.headers ?? {}),
    },
    body: options.body,
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(45_000)])
      : AbortSignal.timeout(45_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new EdgeUploadError(
      data.error ?? "A1一時ストレージに接続できません",
      [400, 401, 403, 404, 409, 413, 507].includes(response.status),
      response.status,
    );
  return data;
}

export function getEdgeStatus(
  path: string,
  ticket: string,
  signal?: AbortSignal,
) {
  return edgeRequest(path + "/status", ticket, "GET", {
    signal,
  }) as Promise<EdgeStatus>;
}

/** Track actual network progress separately from durable A1 receipts. */
export function createProgressReporter(
  initialBytes: number,
  progress: (bytes: number, speed: number) => void,
) {
  let bytes = initialBytes,
    sent = 0;
  const samples = [{ at: performance.now(), sent }];
  const report = () => {
    const now = performance.now(),
      cutoff = now - 1500;
    samples.push({ at: now, sent });
    while (samples.length > 2 && samples[1].at <= cutoff) samples.shift();
    const first = samples[0]!,
      elapsed = now - first.at;
    progress(
      bytes,
      elapsed >= 250 ? (Math.max(0, sent - first.sent) / elapsed) * 1000 : 0,
    );
  };
  const timer = globalThis.setInterval(report, 250);
  return {
    sent(delta: number) {
      sent += Math.max(0, delta);
      report();
    },
    update(nextBytes: number) {
      bytes = Math.max(bytes, nextBytes);
      report();
    },
    dispose() {
      globalThis.clearInterval(timer);
    },
  };
}

/** Idle deadlines restart on upload activity; slow but advancing uploads stay alive. */
export function sendEdgeBlock(options: {
  path: string;
  ticket: string;
  body: ArrayBuffer;
  headers: Record<string, string>;
  signal?: AbortSignal;
  sent: (delta: number) => void;
  idleMs?: number;
  receiptMs?: number;
}): Promise<EdgeStatus> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false,
      loaded = 0;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: unknown, data?: EdgeStatus) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(data!);
    };
    const abort = () => {
      finish(
        options.signal?.reason ?? new DOMException("Aborted", "AbortError"),
      );
      xhr.abort();
    };
    const arm = (ms: number) => {
      if (settled) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        finish(
          new EdgeUploadError(
            "A1への送信が停止したため、未確認ブロックを再送します",
          ),
        );
        xhr.abort();
      }, ms);
    };
    xhr.open("PATCH", options.path);
    xhr.setRequestHeader("Authorization", "Bearer " + options.ticket);
    for (const [name, value] of Object.entries(options.headers))
      xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => {
      options.sent(Math.max(0, event.loaded - loaded));
      loaded = Math.max(loaded, event.loaded);
      arm(options.idleMs ?? 45_000);
    };
    xhr.upload.onload = () => arm(options.receiptMs ?? 45_000);
    xhr.onload = () => {
      let data: any;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        finish(new EdgeUploadError("A1の応答を確認できません"));
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300)
        finish(
          new EdgeUploadError(
            data.error ?? "A1への送信に失敗しました",
            [400, 401, 403, 404, 409, 413, 507].includes(xhr.status),
            xhr.status,
          ),
        );
      else finish(undefined, data);
    };
    xhr.onerror = () =>
      finish(new EdgeUploadError("A1との接続が中断されました"));
    xhr.onabort = () =>
      finish(new EdgeUploadError("A1への送信が中断されました"));
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) {
      abort();
      return;
    }
    arm(options.idleMs ?? 45_000);
    try {
      xhr.send(options.body);
    } catch (error) {
      finish(error);
    }
  });
}

export async function uploadEdge(options: {
  path: string;
  ticket: string;
  file: Blob;
  authoritativeOffset: number;
  authoritativeReceipt?: { start: number; length: number; hash: string } | null;
  blockBytes: number;
  compress: boolean;
  stopped: () => boolean;
  signal?: AbortSignal;
  progress: (receivedBytes: number, speed: number) => void;
}) {
  if (options.authoritativeReceipt) {
    const receipt = options.authoritativeReceipt;
    if (
      !Number.isSafeInteger(receipt.start) ||
      !Number.isSafeInteger(receipt.length) ||
      receipt.start < 0 ||
      receipt.length < 1 ||
      receipt.length > 8 * 1024 * 1024 ||
      receipt.start + receipt.length !== options.authoritativeOffset ||
      !/^[a-f0-9]{64}$/.test(receipt.hash)
    )
      throw new EdgeUploadError("A8の再開確認情報が不正です", true);
    const bytes = await options.file
        .slice(receipt.start, receipt.start + receipt.length)
        .arrayBuffer(),
      hash = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (b) => b.toString(16).padStart(2, "0"),
      ).join("");
    if (hash !== receipt.hash)
      throw new EdgeUploadError("前回と同じファイルを選択してください", true);
  }
  let status = (await edgeRequest(
    options.path + "/start",
    options.ticket,
    "POST",
    {
      body: "{}",
      headers: { "Content-Type": "application/json" },
      signal: options.signal,
    },
  )) as EdgeStatus;
  // Existing reservations retain their block geometry across an upgrade.
  const blockBytes = status.blockBytes ?? options.blockBytes;
  if (
    ![256 * 1024, 1024 * 1024, 2 * 1024 * 1024, 8 * 1024 * 1024].includes(
      blockBytes,
    )
  )
    throw new EdgeUploadError("A1のブロックサイズが不正です", true);
  if (
    status.size !== options.file.size ||
    !Number.isSafeInteger(status.offset) ||
    status.offset < 0 ||
    status.offset > status.size ||
    (status.offset !== status.size && status.offset % blockBytes !== 0)
  )
    throw new EdgeUploadError("A1の再開位置が一致しません", true);
  if (status.state === "error")
    throw new EdgeUploadError(
      status.error ?? "A1からA8への反映に失敗しました",
      true,
    );
  if (status.receipt) {
    const receipt = status.receipt;
    if (
      !Number.isSafeInteger(receipt.start) ||
      !Number.isSafeInteger(receipt.length) ||
      receipt.start < 0 ||
      receipt.length < 1 ||
      receipt.start + receipt.length !== status.offset ||
      !/^[a-f0-9]{64}$/.test(receipt.hash)
    )
      throw new EdgeUploadError("A1の再開確認情報が不正です", true);
    const bytes = await options.file
      .slice(receipt.start, receipt.start + receipt.length)
      .arrayBuffer();
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    if (hash !== receipt.hash)
      throw new EdgeUploadError("前回と同じファイルを選択してください", true);
  }
  if (status.state === "complete")
    return { offset: status.size, stopped: false, complete: true };
  if (status.replicatedOffset >= options.file.size)
    return { offset: options.file.size, stopped: false, complete: false };

  if (
    status.pipeline === PIPELINE_PROTOCOL &&
    typeof WebSocket !== "undefined"
  ) {
    const url = new URL(options.path + "/stream", location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    try {
      const result = await uploadPipeline({
        url: url.href,
        protocols: [PIPELINE_PROTOCOL, options.ticket],
        connectTimeoutMs: 8000,
        file: options.file,
        offset: status.offset,
        roundTripMs: 0,
        compress: options.compress,
        stopped: options.stopped,
        signal: options.signal,
        progress: options.progress,
      });
      if (result.stopped || options.stopped() || options.signal?.aborted)
        return { offset: result.offset, stopped: true, complete: false };
      status = await getEdgeStatus(
        options.path,
        options.ticket,
        options.signal,
      );
      if (status.offset !== options.file.size)
        throw new EdgeUploadError("A1の永続受領位置が一致しません", true);
      return {
        offset: status.offset,
        stopped: false,
        complete: status.state === "complete",
      };
    } catch (error) {
      if (options.stopped() || options.signal?.aborted)
        return { offset: status.offset, stopped: true, complete: false };
      if (error instanceof EdgeUploadError && error.fatal) throw error;
      if (error instanceof PipelineError && error.fatal)
        throw new EdgeUploadError(error.message, true);
      // Unsupported/broken WebSockets resume from A1's durable receipts over HTTP.
      status = await getEdgeStatus(
        options.path,
        options.ticket,
        options.signal,
      );
      if (
        !Number.isSafeInteger(status.offset) ||
        status.offset < 0 ||
        status.offset > options.file.size ||
        (status.offset !== options.file.size &&
          status.offset % blockBytes !== 0)
      )
        throw new EdgeUploadError("A1の再開位置が不正です", true);
    }
  }

  let contiguous = status.offset;
  const transfers = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, transfers.signal])
    : transfers.signal;
  let next = status.offset,
    compression = options.compress,
    failed: unknown,
    lastBytes = status.receivedBytes;
  const reporter = createProgressReporter(lastBytes, options.progress);
  const pump = async () => {
    while (!failed && !options.stopped() && !signal.aborted) {
      // A lost early receipt must not let other pumps run past A1's receive window.
      if (next > contiguous + blockBytes * 8) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      const offset = next;
      if (offset >= options.file.size) return;
      next += blockBytes;
      const prepared = await prepareChunk(
        options.file.slice(offset, offset + blockBytes),
        compression,
      );
      if (prepared.logicalBytes >= 32768 && !prepared.compressed)
        compression = false;
      let retries = 0;
      while (!failed && !options.stopped() && !signal.aborted) {
        try {
          const result = await sendEdgeBlock({
            path: options.path + "/chunk",
            ticket: options.ticket,
            body: prepared.body,
            signal,
            sent: reporter.sent,
            headers: {
              "Content-Type": "application/octet-stream",
              "Upload-Offset": String(offset),
              "Upload-Checksum": prepared.checksum,
              ...(prepared.compressed ? { "Upload-Encoding": "gzip" } : {}),
            },
          });
          if (result.state === "error")
            throw new EdgeUploadError(
              result.error ?? "A1からA8への反映に失敗しました",
              true,
            );
          if (
            result.size !== options.file.size ||
            !Number.isSafeInteger(result.receivedBytes) ||
            result.receivedBytes < 0 ||
            !Number.isSafeInteger(result.offset) ||
            result.offset < 0 ||
            result.offset > result.size ||
            result.receivedBytes > result.size
          )
            throw new EdgeUploadError("A1の受領位置が一致しません", true);
          contiguous = Math.max(contiguous, result.offset);
          lastBytes = Math.max(lastBytes, result.receivedBytes);
          reporter.update(lastBytes);
          break;
        } catch (error) {
          if (options.stopped() || signal.aborted) return;
          if (error instanceof EdgeUploadError && error.fatal) {
            failed = error;
            transfers.abort();
            return;
          }
          if (++retries > 6) {
            failed = error;
            transfers.abort();
            return;
          }
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(4000, 300 * 2 ** retries)),
          );
        }
      }
    }
  };
  try {
    reporter.update(lastBytes);
    await Promise.all(Array.from({ length: 4 }, () => pump()));
    if (failed) throw failed;
    if (options.stopped() || options.signal?.aborted)
      return { offset: status.offset, stopped: true, complete: false };
    status = await getEdgeStatus(options.path, options.ticket, options.signal);
    if (status.offset !== options.file.size)
      throw new EdgeUploadError("A1で全ブロックを受領できませんでした");
    reporter.update(status.receivedBytes);
    return {
      offset: status.size,
      stopped: false,
      complete: status.state === "complete",
    };
  } finally {
    transfers.abort();
    reporter.dispose();
  }
}

export async function waitForEdgeSync(options: {
  path: string;
  ticket: string;
  fileSize: number;
  stopped: () => boolean;
  signal?: AbortSignal;
  progress: (replicatedOffset: number, speed: number) => void;
}) {
  let status = await getEdgeStatus(
      options.path,
      options.ticket,
      options.signal,
    ),
    previous = status.replicatedOffset,
    lastSample = performance.now();
  if (status.size !== options.fileSize)
    throw new EdgeUploadError("A8への反映サイズが一致しません", true);
  if (status.state === "error")
    throw new EdgeUploadError(status.error ?? "A8への反映に失敗しました");
  if (status.state === "complete")
    return { stopped: false, ready: true, complete: true };
  if (previous >= options.fileSize)
    return { stopped: false, ready: true, complete: false };
  options.progress(previous, 0);
  while (!options.stopped() && !options.signal?.aborted) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    if (options.stopped() || options.signal?.aborted) break;
    status = await getEdgeStatus(options.path, options.ticket, options.signal);
    if (status.size !== options.fileSize)
      throw new EdgeUploadError("A8への反映サイズが一致しません", true);
    if (status.state === "error")
      throw new EdgeUploadError(status.error ?? "A8への反映に失敗しました");
    if (status.state === "complete")
      return { stopped: false, ready: true, complete: true };
    const now = performance.now(),
      delta = Math.max(0, status.replicatedOffset - previous),
      speed = delta > 0 ? (delta / Math.max(1, now - lastSample)) * 1000 : 0;
    previous = status.replicatedOffset;
    lastSample = now;
    options.progress(previous, speed);
    if (status.replicatedOffset >= options.fileSize)
      return { stopped: false, ready: true, complete: false };
  }
  return { stopped: true, ready: false, complete: false };
}

export async function deleteEdgeUpload(path: string, ticket: string) {
  try {
    await edgeRequest(path, ticket, "DELETE");
  } catch (error) {
    if (!(error instanceof EdgeUploadError && error.fatal)) throw error;
  }
}

export async function publishEdgeUpload(path: string, ticket: string) {
  return edgeRequest(path + "/finish", ticket, "POST", {
    body: "{}",
    headers: { "Content-Type": "application/json" },
  });
}
