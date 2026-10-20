import { test, expect } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import net from "node:net";
import tls from "node:tls";

test("IPv6-only TLS gateway preserves WebSocket request and forwards a bounded PROXY v2 identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fileshare-direct-v6-"));
  const key = join(dir, "key.pem"), cert = join(dir, "cert.pem");
  const openssl = spawnSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-subj", "/CN=localhost", "-keyout", key, "-out", cert, "-days", "1",
  ], { stdio: "ignore" });
  if (openssl.status !== 0) {
    await rm(dir, { recursive: true, force: true });
    throw new Error("OpenSSL test certificate generation failed");
  }
  const upstream = net.createServer();
  const served = new Promise<{ header: Buffer; request: string }>((resolve, reject) => {
    upstream.on("connection", socket => {
      let received = Buffer.alloc(0);
      socket.on("data", bytes => {
        received = Buffer.concat([received, bytes]);
        if (received.length >= 52 && received.includes("\r\n\r\n", 52)) {
          socket.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK");
          resolve({
            header: received.subarray(0, 52),
            request: received.subarray(52).toString(),
          });
          socket.end();
        }
      });
      socket.on("error", reject);
    });
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const backendPort = (upstream.address() as net.AddressInfo).port;
  const probe = net.createServer();
  await new Promise<void>(resolve => probe.listen(0, "::1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  probe.close();
  const gateway = Bun.spawn(["node", "deploy/direct-ipv6-gateway.mjs"], {
    env: {
      ...process.env,
      FILESHARE_DIRECT_IPV6_BIND: "::1",
      FILESHARE_DIRECT_IPV6_PORT: String(port),
      FILESHARE_DIRECT_BACKEND: "127.0.0.1",
      FILESHARE_DIRECT_SOURCE: "127.0.0.1",
      FILESHARE_DIRECT_BACKEND_PORT: String(backendPort),
      FILESHARE_DIRECT_TLS_CERT: cert,
      FILESHARE_DIRECT_TLS_KEY: key,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    let client: tls.TLSSocket | undefined;
    for (let attempt=0;attempt<60;attempt++) {
      try {
        client = await new Promise<tls.TLSSocket>((resolve,reject) => {
          const c=tls.connect({host:"::1",port,servername:"localhost",rejectUnauthorized:false},()=>resolve(c));
          c.once("error",reject);
        });
        break;
      } catch { await Bun.sleep(30); }
    }
    if (!client) throw new Error("IPv6 test gateway never listened");
    client.write("GET /api/uploads/123/stream HTTP/1.1\r\nHost: share.pexserver.com:8443\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    const [forwarded,response]=await Promise.all([
      served,
      new Promise<string>((resolve,reject)=>{
        let raw="";
        client!.on("data",(b)=>{raw+=b.toString(); if(raw.includes("\r\n\r\nOK"))resolve(raw);});
        client!.on("error",reject);
      }),
    ]);
    expect(forwarded.header.subarray(0,12)).toEqual(Buffer.from([13,10,13,10,0,13,10,81,85,73,84,10]));
    expect(forwarded.header[12]).toBe(0x21);
    expect(forwarded.header[13]).toBe(0x21);
    expect(forwarded.header.readUInt16BE(14)).toBe(36);
    expect(forwarded.request).toContain("Upgrade: websocket");
    expect(response).toContain("200 OK");
    client.destroy();
  } finally {
    gateway.kill();await gateway.exited;
    upstream.close();
    await rm(dir,{recursive:true,force:true});
  }
},20000);

import { createDirectUploadTicket, verifyDirectUploadTicket } from "../src/server/edge-auth";
import { createApp } from "../src/server/app";
import { defaults } from "../src/server/config";
import { randomToken, digestToken } from "@pexserver/secure-envelope";
import { packBlock, PIPELINE_PROTOCOL } from "../src/shared/pipeline";
import WS from "ws-node";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

test("cross-host direct IPv6 WSS requires a short-lived signed ticket and rechecks revoked sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fileshare-direct-auth-"));
  const secret = "e".repeat(64);
  const secretFile = join(dir, "secret");
  await writeFile(secretFile, secret);
  const previous = process.env.FILESHARE_EDGE_SECRET_FILE;
  process.env.FILESHARE_EDGE_SECRET_FILE = secretFile;
  const config = structuredClone(defaults);
  config.host = "127.0.0.1";
  config.port = 38800 + Math.floor(Math.random() * 700);
  config.origin = "http://127.0.0.1:" + config.port;
  config.dataDir = join(dir,"data");
  config.directIpv6.enabled = true;
  const app = await createApp(config);
  let ws: WS | null = null;
  try {
    const session = randomToken(), hash=digestToken(session);
    app.store.db.run("INSERT INTO users VALUES (?,?,?,?,?,?,?)",
      ["direct-owner","direct-owner",1,"approved",5000000000,"192.0.2.1",Date.now()]);
    app.store.db.run("INSERT INTO sessions VALUES (?,?,?)",
      [hash,"direct-owner",Date.now()+300000]);
    const create=await fetch(config.origin+"/api/uploads",{
      method:"POST",
      headers:{Origin:config.origin,Cookie:"fs_session="+session,"Content-Type":"application/json"},
      body:JSON.stringify({name:"direct.bin",size:2*1024*1024,space:"private"}),
    });
    expect(create.status).toBe(201);
    const {id}=await create.json() as {id:string};
    const token=createDirectUploadTicket(secret,{
      v:1,scope:"direct-upload",id,userId:"direct-owner",
      session:hash,size:2*1024*1024,expiresAt:Date.now()+300000,
    });
    expect(verifyDirectUploadTicket(secret,token)?.id).toBe(id);
    expect(verifyDirectUploadTicket("a".repeat(64),token)).toBeNull();
    ws=new WS("ws://127.0.0.1:"+config.port+"/api/uploads/"+id+"/stream",
      [PIPELINE_PROTOCOL,token],{
        headers:{Host:config.directIpv6.host+":"+config.directIpv6.port,Origin:config.origin},
      });
    const messages:any[]=[];
    ws.on("message",data=>messages.push(JSON.parse(data.toString())));
    async function take(kind:string) {
      for(let n=0;n<100;n++){
        const i=messages.findIndex(m=>m.type===kind);
        if(i>=0)return messages.splice(i,1)[0];
        await Bun.sleep(10);
      }
      throw new Error("Missing "+kind);
    }
    const ready=await take("ready");
    expect(ready.offset).toBe(0);
    const bytes=Buffer.alloc(1024*1024,17);
    const frame=packBlock(0,bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),
      bytes.length,createHash("sha256").update(bytes).digest("hex"),false);
    ws.send(frame);
    const ack=await take("ack");
    expect(ack.offset).toBe(1024*1024);
    app.store.db.run("DELETE FROM sessions WHERE hash=?",[hash]);
    const second=packBlock(bytes.length,bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),
      bytes.length,createHash("sha256").update(bytes).digest("hex"),false);
    ws.send(second);
    const err=await take("error");
    expect(err.status).toBe(401);
    const check=app.store.db.query("SELECT offset FROM uploads WHERE id=?").get(id) as {offset:number};
    expect(check.offset).toBe(bytes.length);
  } finally {
    ws?.terminate();
    await app.close();
    if(previous===undefined)delete process.env.FILESHARE_EDGE_SECRET_FILE;
    else process.env.FILESHARE_EDGE_SECRET_FILE=previous;
    await rm(dir,{recursive:true,force:true});
  }
},20000);
