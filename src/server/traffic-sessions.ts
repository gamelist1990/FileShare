import {
  acceptTrafficClientHello,
  openTraffic,
  sealTraffic,
  type TrafficHello,
  type TrafficKeys,
} from "@pexserver/secure-envelope/traffic";

type Session = {
  keys: TrafficKeys;
  ip: string;
  seen: Set<string>;
};

export type ChannelRequest = {
  requestId: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
};

export class TrafficSessions {
  private sessions = new Map<string, Session>();

  async open(hello: TrafficHello, ip: string) {
    this.cleanup();
    if (this.sessions.size >= 4096) throw new Error("Too many traffic sessions");
    let sessionsForIp = 0;
    for (const session of this.sessions.values())
      if (session.ip === ip && ++sessionsForIp >= 64)
        throw new Error("Too many traffic sessions for this client");
    const accepted = await acceptTrafficClientHello(hello, 15 * 60_000);
    this.sessions.set(accepted.keys.sessionId, {
      keys: accepted.keys,
      ip,
      seen: new Set(),
    });
    return accepted.welcome;
  }

  async decode(sessionId: string, packet: string, ip: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.ip !== ip || session.keys.expiresAt <= Date.now()) {
      this.sessions.delete(sessionId);
      throw new Error("Traffic session expired");
    }
    const opened = await openTraffic<ChannelRequest>(packet, session.keys, "request");
    if (session.seen.has(opened.packetId)) throw new Error("Traffic packet replayed");
    session.seen.add(opened.packetId);
    if (session.seen.size > 2048) this.sessions.delete(sessionId);
    const value = opened.value;
    if (
      !value ||
      typeof value.requestId !== "string" ||
      !/^[0-9a-f-]{36}$/.test(value.requestId) ||
      !["GET", "POST", "PATCH", "DELETE"].includes(value.method) ||
      typeof value.path !== "string" ||
      value.path.length > 2048 ||
      !value.path.startsWith("/api/") ||
      value.path.startsWith("/api/channel") ||
      value.path.startsWith("/api/transport/") ||
      /[\r\n]/.test(value.path)
    )
      throw new Error("Invalid traffic operation");
    return { request: value, keys: session.keys };
  }

  encode(keys: TrafficKeys, requestId: string, status: number, data: unknown) {
    return sealTraffic({ requestId, status, data }, keys, "response");
  }

  private cleanup() {
    const now = Date.now();
    for (const [id, session] of this.sessions)
      if (session.keys.expiresAt <= now) this.sessions.delete(id);
  }
}
