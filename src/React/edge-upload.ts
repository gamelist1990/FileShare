import { prepareChunk } from "./transfer";

export type EdgeStatus = {
  size: number;
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
    signal: options.signal,
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

function createProgressReporter(
  initialBytes: number,
  progress: (bytes: number, speed: number) => void,
) {
  let bytes = initialBytes;
  const samples = [{ at: performance.now(), bytes }];
  const report = () => {
    const now = performance.now(),
      cutoff = now - 1500;
    while (samples.length > 1 && samples[1].at <= cutoff) samples.shift();
    const first = samples[0]!,
      elapsed = now - first.at,
      speed =
        elapsed >= 250
          ? (Math.max(0, bytes - first.bytes) / elapsed) * 1000
          : 0;
    progress(bytes, speed);
  };
  const timer = window.setInterval(report, 250);
  return {
    update(nextBytes: number) {
      if (nextBytes > bytes) {
        bytes = nextBytes;
        samples.push({ at: performance.now(), bytes });
      }
      report();
    },
    dispose() {
      window.clearInterval(timer);
    },
  };
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
  if (
    status.size !== options.file.size ||
    !Number.isSafeInteger(status.offset) ||
    status.offset < 0 ||
    status.offset > status.size ||
    (status.offset !== status.size && status.offset % options.blockBytes !== 0)
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

  let next = status.offset,
    compression = options.compress,
    failed: unknown,
    lastBytes = status.receivedBytes;
  const reporter = createProgressReporter(lastBytes, options.progress);
  const pump = async () => {
    while (!failed && !options.stopped() && !options.signal?.aborted) {
      const offset = next;
      if (offset >= options.file.size) return;
      next += options.blockBytes;
      let retries = 0;
      while (!failed && !options.stopped() && !options.signal?.aborted) {
        try {
          const prepared = await prepareChunk(
            options.file.slice(offset, offset + options.blockBytes),
            compression,
          );
          if (prepared.logicalBytes >= 32768 && !prepared.compressed)
            compression = false;
          const result = (await edgeRequest(
            options.path + "/chunk",
            options.ticket,
            "PATCH",
            {
              body: prepared.body,
              signal: options.signal,
              headers: {
                "Content-Type": "application/octet-stream",
                "Upload-Offset": String(offset),
                "Upload-Checksum": prepared.checksum,
                ...(prepared.compressed ? { "Upload-Encoding": "gzip" } : {}),
              },
            },
          )) as EdgeStatus;
          if (result.state === "error")
            throw new EdgeUploadError(
              result.error ?? "A1からA8への反映に失敗しました",
              true,
            );
          if (
            result.size !== options.file.size ||
            !Number.isSafeInteger(result.receivedBytes) ||
            result.receivedBytes > result.size
          )
            throw new EdgeUploadError("A1の受領位置が一致しません", true);
          lastBytes = Math.max(lastBytes, result.receivedBytes);
          reporter.update(lastBytes);
          break;
        } catch (error) {
          if (options.stopped() || options.signal?.aborted) return;
          if (error instanceof EdgeUploadError && error.fatal) {
            failed = error;
            return;
          }
          if (++retries > 6) {
            failed = error;
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
