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
let staffCheckPage: typeof page | null = null;
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
  await page.getByRole("button", { name: "Admin", exact: true }).click();
  await page.getByRole("heading", { name: "ユーザーと権限" }).waitFor();
  for (const name of ["review_pending_one", "review_pending_two"])
    app.store.db.run("INSERT INTO users VALUES (?,?,?,?,?,?,?)", [
      name,
      name,
      0,
      "pending",
      5e9,
      "192.0.2.12",
      Date.now(),
    ]);
  await page.getByRole("button", { name: "更新", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "review_pending_one", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "承認待ちをすべて選択", exact: true })
    .click();
  await page
    .getByRole("button", { name: "選択した申請を無効化（2）", exact: true })
    .click();
  await page.getByText("2件の申請を無効化しました", { exact: true }).waitFor();
  if (app.store.user("review_pending_one")?.status !== "denied")
    throw new Error("Bulk review did not reject the pending application");
  await page.getByLabel("監視間隔（秒）", { exact: true }).fill("120");
  await page.getByRole("button", { name: "AI設定を保存", exact: true }).click();
  await page.getByText("AI監視の設定を保存しました", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "招待URLを発行", exact: true })
    .click();
  const staffURLField = page.getByLabel("発行した招待URL", { exact: true });
  await staffURLField.waitFor();
  const staffURL = await staffURLField.inputValue();
  await page.getByRole("button", { name: "ログを更新", exact: true }).click();
  await page.locator(".audit-book").first().waitFor();
  await page
    .locator(".audit-library")
    .screenshot({ path: ".artifacts/review-books.png" });
  await page.screenshot({ path: ".artifacts/admin.png", fullPage: true });
  const staffContext = await browser.newContext();
  const staffPage = await staffContext.newPage();
  staffCheckPage = staffPage;
  staffPage.on("pageerror", (e) => errors.push(e.message));
  const staffCDP = await staffContext.newCDPSession(staffPage);
  await staffCDP.send("WebAuthn.enable");
  await staffCDP.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await staffPage.goto(staffURL);
  await staffPage
    .getByLabel("スタッフのユーザー名", { exact: true })
    .fill("invitedstaff");
  await staffPage.screenshot({
    path: ".artifacts/staff-invite.png",
    fullPage: true,
  });
  const staffVerification = staffPage.waitForResponse(
    (r) => r.url().endsWith("/api/auth/register/verify"),
    { timeout: 10000 },
  );
  await staffPage
    .getByRole("button", {
      name: "パスキーを登録してスタッフになる",
      exact: true,
    })
    .click();
  const registrationResult = await staffVerification;
  console.log(
    "Staff registration response:",
    registrationResult.status(),
    await registrationResult.json(),
  );
  await staffPage
    .getByRole("status")
    .filter({
      hasText: "スタッフとして登録しました。パスキーでログインしてください。",
    })
    .waitFor();
  await staffPage
    .getByRole("button", { name: "パスキーでログイン", exact: true })
    .click();
  await staffPage
    .getByRole("dialog")
    .getByRole("button", { name: "パスキーでログイン", exact: true })
    .click();
  await staffPage.getByText("Level 3 · スタッフ", { exact: true }).waitFor();
  if (
    await staffPage.getByRole("button", { name: "Admin", exact: true }).count()
  )
    throw new Error("Invited staff must not see administrator navigation");
  await staffPage.goto(staffURL);
  await staffPage
    .getByText("招待URLは無効・期限切れ・利用済みです", { exact: true })
    .waitFor();
  await staffContext.close();
  staffCheckPage = null;
  await page.getByRole("button", { name: "FileShare", exact: true }).click();
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
  if (staffCheckPage && !staffCheckPage.isClosed()) {
    console.log(
      "Staff registration alerts:",
      await staffCheckPage.getByRole("alert").allTextContents(),
    );
    console.log(
      "Staff account state:",
      app.store.db
        .query("SELECT level,status FROM users WHERE name=?")
        .get("invitedstaff"),
    );
    await staffCheckPage.screenshot({
      path: ".artifacts/staff-failure.png",
      fullPage: true,
    });
  }
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
