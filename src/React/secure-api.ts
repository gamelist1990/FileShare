import {
  createTrafficClientHello,
  openTraffic,
  sealTraffic,
  type TrafficKeys,
} from "@pexserver/secure-envelope/traffic";

type SharedState = { keys?: TrafficKeys; opening?: Promise<TrafficKeys> };
const stateKey = Symbol.for("pexserver.fileshare.traffic.v1");
const state = ((globalThis as any)[stateKey] ??= {}) as SharedState;

async function openSession() {
  if (state.keys && state.keys.expiresAt > Date.now() + 5_000) return state.keys;
  if (!state.opening) {
    state.opening = (async () => {
      const client = await createTrafficClientHello();
      const response = await fetch("/api/transport/open", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(client.hello),
      });
      if (!response.ok) throw new Error("安全な通信を開始できませんでした");
      const keys = await client.complete(await response.json());
      state.keys = keys;
      return keys;
    })().finally(() => {
      state.opening = undefined;
    });
  }
  return state.opening;
}

export async function secureApi(
  path: string,
  method = "GET",
  body?: unknown,
  retry = true,
): Promise<any> {
  const keys = await openSession();
  const requestId = crypto.randomUUID();
  const packet = await sealTraffic(
    { requestId, method, path, ...(body === undefined ? {} : { body }) },
    keys,
    "request",
  );
  const response = await fetch("/api/channel", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-PEX-Session": keys.sessionId,
    },
    body: packet,
  });
  // A rejected packet has not reached an application route, so one fresh
  // session retry cannot duplicate a state-changing operation.
  if (response.status === 409 && retry) {
    state.keys = undefined;
    return secureApi(path, method, body, false);
  }
  if (!response.ok) throw new Error("安全な通信を処理できませんでした");
  const encrypted = await response.text();
  const result = (
    await openTraffic<{ requestId: string; status: number; data: any }>(
      encrypted,
      keys,
      "response",
    )
  ).value;
  if (result.requestId !== requestId || !Number.isInteger(result.status))
    throw new Error("応答形式が不正です");
  if (result.status < 200 || result.status >= 300)
    throw new Error(result.data?.error ?? "処理できませんでした");
  return result.data;
}
