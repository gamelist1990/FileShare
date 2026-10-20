import { test,expect } from "bun:test";
import { createDirectDownloadTicket, verifyDirectDownloadTicket } from "../src/server/edge-auth";

test("RTC downloads require a valid, time-limited, item-scoped signed ticket",()=>{
 const secret="3".repeat(64);
 const info={v:1 as const,scope:"direct-download" as const,
   id:"123e4567-e89b-12d3-a456-426614174000",
   userId:"owner",session:"4".repeat(64),expiresAt:Date.now()+120000};
 const token=createDirectDownloadTicket(secret,info);
 expect(verifyDirectDownloadTicket(secret,token)).toEqual(info);
 expect(verifyDirectDownloadTicket("5".repeat(64),token)).toBeNull();
 expect(verifyDirectDownloadTicket(secret,token+"X")).toBeNull();
 const bad=createDirectDownloadTicket(secret,{...info,expiresAt:Date.now()-100});
 expect(verifyDirectDownloadTicket(secret,bad)).toBeNull();
});
