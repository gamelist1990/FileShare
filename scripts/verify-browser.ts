import { chromium } from "@playwright/test";
import { readFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { defaults } from "../src/server/config";
const port = 39000 + Math.floor(Math.random() * 10000);
const origin = "http://localhost:" + port;
const dataDir = await mkdtemp(join(tmpdir(), "fileshare-browser-"));
const app = await createApp({
  ...structuredClone(defaults),
  port,
  origin,
  dataDir,
});
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {}),
});
const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  }),
  page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: {
    protocol: "ctap2",
    transport: "internal",
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
  },
});
let loginPayload: unknown;
page.on("request", (request) => {
  if (request.url().endsWith("/api/auth/login/verify"))
    loginPayload = request.postDataJSON();
});
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
await mkdir(".artifacts", { recursive: true });
try {
  await page.goto(origin);
  await page.getByRole("heading", { name: "ファイルを、つなぐ。" }).waitFor();
  await page.screenshot({ path: ".artifacts/desktop.png", fullPage: true });
  await page
    .getByRole("button", { name: "パスキーでログイン", exact: true })
    .click();
  await page.getByText("管理者の初期設定", { exact: true }).click();
  const setup = page
    .locator("details")
    .filter({ has: page.getByText("管理者の初期設定", { exact: true }) });
  await setup.getByLabel("ユーザー名", { exact: true }).fill("browseradmin");
  const token = (
    await readFile(join(dataDir, "bootstrap.token"), "utf8")
  ).trim();
  await setup.getByLabel("初期設定キー").fill(token);
  await setup.getByRole("button", { name: "管理者を作成" }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "管理者を登録しました" })
    .waitFor();
  await page
    .getByRole("button", { name: "パスキーでログイン", exact: true })
    .click();
  if (await page.getByText("管理者の初期設定", { exact: true }).count())
    throw new Error("Completed administrator setup must not remain visible");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "パスキーでログイン", exact: true })
    .click();
  await page.getByText("Level 4 · 管理者", { exact: true }).waitFor();
  const replay = await page.evaluate(
    async (payload) =>
      (
        await fetch("/api/auth/login/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
      ).status,
    loginPayload,
  );
  if (replay !== 400)
    throw new Error("WebAuthn challenge replay was not rejected");
  await page
    .getByRole("button", { name: "プライベートフォルダ", exact: false })
    .click();
  await page.locator("input[type=file]").setInputFiles({
    name: "browser-proof.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(
      "Verified browser upload with a real WebAuthn ceremony.",
    ),
  });
  await page
    .getByRole("button", { name: "browser-proof.txt", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "browser-proof.txtの設定" }).click();
  await page
    .getByRole("dialog")
    .locator('select[name="visibility"]')
    .selectOption("public");
  await page.getByRole("button", { name: "設定を保存" }).click();
  await page.getByRole("button", { name: "管理ページ", exact: true }).click();
  await page.getByRole("heading", { name: "ユーザーと権限" }).waitFor();
  await page.screenshot({ path: ".artifacts/admin.png", fullPage: true });
  await page
    .getByRole("button", { name: "共有ストレージ", exact: true })
    .click();
  await page
    .getByRole("button", { name: "プライベートフォルダ", exact: false })
    .click();
  await page.screenshot({ path: ".artifacts/private.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: ".artifacts/mobile.png", fullPage: true });
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    "Browser verified: bootstrap WebAuthn registration, passkey login, private upload, publication settings, administrator page, desktop/mobile screenshots.",
  );
} catch (e) {
  await page.screenshot({
    path: ".artifacts/browser-failure.png",
    fullPage: true,
  });
  throw e;
} finally {
  await browser.close();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
}
