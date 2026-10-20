import { test,expect } from "bun:test";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { defaults } from "../src/server/config";
import { maintenance,cleanup } from "../src/server/storage";

test("trash retention defaults disabled, saves policy and only purges old complete trash trees", async()=>{
 const dir=await mkdtemp(join(tmpdir(),"fileshare-trash-retention-"));
 const c=structuredClone(defaults);
 c.port=44000+Math.floor(Math.random()*400);
 c.origin="http://127.0.0.1:"+c.port;
 c.dataDir=dir;
 const app=await createApp(c);
 try {
  const now=Date.now(),older=now-40*86400000;
  app.store.db.run("INSERT INTO users VALUES (?,?,?,?,?,?,?)",["root","root",4,"approved",1e9,"127.0.0.1",now]);
  const admin=app.store.user("root")!;
  const insert=(id:string,name:string,parent:string|null,deleted:number|null,folder:number)=>{
   app.store.db.run("INSERT INTO items (id,parent,owner,name,folder,size,mime,visibility,min_level,created,deleted) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
   [id,parent,null,name,folder,0,"","public",0,now-45*86400000,deleted]);
  };
  const old="123e4567-e89b-12d3-a456-426614174001";
  const recent="123e4567-e89b-12d3-a456-426614174002";
  const normal="123e4567-e89b-12d3-a456-426614174003";
  const folder="123e4567-e89b-12d3-a456-426614174004";
  const child="123e4567-e89b-12d3-a456-426614174005";
  insert(old,"old",null,older,0);
  insert(recent,"recent",null,now-2*86400000,0);
  insert(normal,"keep",null,null,0);
  insert(folder,"folder",null,older,1);
  insert(child,"child",folder,now-2*86400000,0);
  await cleanup(app.store,false);
  expect(app.store.db.query("SELECT id FROM items WHERE id=?").get(old)).toBeTruthy();
  await expect(maintenance(app.store,admin,"trash-retention",{enabled:true,days:30},"127.0.0.1"))
    .resolves.toEqual({enabled:true,days:30});
  await cleanup(app.store,false);
  expect(app.store.db.query("SELECT id FROM items WHERE id=?").get(old)).toBeNull();
  expect(app.store.db.query("SELECT id FROM items WHERE id=?").get(recent)).toBeTruthy();
  expect(app.store.db.query("SELECT id FROM items WHERE id=?").get(normal)).toBeTruthy();
  expect(app.store.db.query("SELECT id FROM items WHERE id=?").get(folder)).toBeTruthy();
  expect(app.store.db.query("SELECT id FROM items WHERE id=?").get(child)).toBeTruthy();
  await maintenance(app.store,admin,"trash-retention",{enabled:false,days:30},"127.0.0.1");
  app.store.db.run("UPDATE items SET deleted=? WHERE id=?",[older,recent]);
  await cleanup(app.store,false);
  expect(app.store.db.query("SELECT id FROM items WHERE id=?").get(recent)).toBeTruthy();
  await expect(maintenance(app.store,admin,"trash-retention",{enabled:true,days:0},"127.0.0.1")).rejects.toThrow();
 } finally {
  await app.close();
  await rm(dir,{recursive:true,force:true});
 }
},20000);
