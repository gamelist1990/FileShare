import { test, expect } from "bun:test";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { createTransport, parseProxy } from "../src/server/transport";
import { defaults } from "../src/server/config";
function header() {
  const b = Buffer.alloc(28);
  Buffer.from([13, 10, 13, 10, 0, 13, 10, 81, 85, 73, 84, 10]).copy(b);
  b[12] = 0x21;
  b[13] = 0x11;
  b.writeUInt16BE(12, 14);
  Buffer.from([203, 0, 113, 9, 127, 0, 0, 1]).copy(b, 16);
  b.writeUInt16BE(1234, 24);
  b.writeUInt16BE(8100, 26);
  return b;
}
const request =
  "GET / HTTP/1.1\r\nHost: localhost\r\nX-Forwarded-For: 1.2.3.4\r\n";
async function exchange(
  parts: Buffer[],
  enabled = true,
  trusted = ["127.0.0.1"],
) {
  const h = http.createServer((req, res) =>
    res.end((req.socket as any).clientIp),
  );
  const t = createTransport(
    { ...structuredClone(defaults), proxy: { enabled, trustedPeers: trusted } },
    h,
  );
  t.server.listen(0, "127.0.0.1");
  await once(t.server, "listening");
  try {
    return await new Promise<string>((resolve, reject) => {
      const s = net.connect(
          (t.server.address() as net.AddressInfo).port,
          "127.0.0.1",
        ),
        data: Buffer[] = [];
      s.setTimeout(3000, () => s.destroy(new Error("timeout")));
      s.on("error", reject);
      s.on("data", (c) => data.push(c));
      s.on("end", () => resolve(Buffer.concat(data).toString()));
      s.on("connect", async () => {
        for (const p of parts) {
          s.write(p);
          await Bun.sleep(2);
        }
      });
    });
  } finally {
    t.close();
    h.close();
  }
}
test("PROXY v2 fragmented preface and keepalive preserve trusted IP for every request", async () => {
  const b = header();
  const response = await exchange([
    b.subarray(0, 5),
    b.subarray(5),
    Buffer.from(request + "\r\n" + request + "Connection: close\r\n\r\n"),
  ]);
  expect(response.match(/203\.0\.113\.9/g)?.length).toBe(2);
  expect(response).not.toContain("1.2.3.4");
});
test("direct HTTP produces the requested protocol error when enabled", async () => {
  const r = await exchange([
    Buffer.from(request + "Connection: close\r\n\r\n"),
  ]);
  expect(r).toContain("400 Bad Request");
  expect(r).toContain("有効な通信プロトコルではありません");
});
test("direct mode ignores forged IP; untrusted peers rejected even with valid PROXY", async () => {
  expect(
    await exchange([Buffer.from(request + "Connection: close\r\n\r\n")], false),
  ).toContain("127.0.0.1");
  expect(
    await exchange(
      [header(), Buffer.from(request + "Connection: close\r\n\r\n")],
      true,
      ["192.0.2.1"],
    ),
  ).toContain("400 Bad Request");
});
test("invalid version, command, transport, address size and nested identity are rejected", () => {
  for (const [offset, value] of [
    [12, 0x11],
    [12, 0x20],
    [12, 0x22],
    [13, 0x12],
    [13, 0x31],
  ]) {
    const b = header();
    b[offset] = value;
    expect(() => parseProxy(b)).toThrow();
  }
  const short = header();
  short.writeUInt16BE(1, 14);
  expect(() => parseProxy(short)).toThrow();
  const huge = header();
  huge.writeUInt16BE(65535, 14);
  expect(() => parseProxy(huge)).toThrow();
  expect(parseProxy(header().subarray(0, 20))).toBeNull();
});
test("IPv6 original client is parsed canonically and malformed TLVs are rejected", () => {
  const b = Buffer.alloc(52);
  header().subarray(0, 12).copy(b);
  b[12] = 0x21;
  b[13] = 0x21;
  b.writeUInt16BE(36, 14);
  b.writeUInt16BE(0x2001, 16);
  b.writeUInt16BE(0xdb8, 18);
  b.writeUInt16BE(1, 30);
  b.writeUInt16BE(1234, 48);
  b.writeUInt16BE(8100, 50);
  expect(parseProxy(b)?.ip).toBe("2001:db8::1");
  const bad = Buffer.concat([header(), Buffer.from([1, 0, 8, 0])]);
  bad.writeUInt16BE(16, 14);
  expect(() => parseProxy(bad)).toThrow();
});
