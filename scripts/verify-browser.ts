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
let compressedUpload = false,
  pipelineSockets = 0;
const browserProof = Buffer.from(
  "Verified browser upload with a real WebAuthn ceremony.\n".repeat(100000),
);
let staffCheckPage: typeof page | null = null;
page.on("websocket", (socket) => {
  if (!socket.url().endsWith("/stream")) return;
  pipelineSockets++;
  socket.on("framesent", ({ payload }) => {
    if (
      Buffer.isBuffer(payload) &&
      payload.length >= 56 &&
      payload.readUInt32BE(0) === 0x46535531 &&
      payload[4] === 1
    )
      compressedUpload = true;
  });
});
page.on("request", (request) => {
  if (
    request.method() === "PATCH" &&
    request.url().includes("/api/uploads/") &&
    request.headers()["upload-encoding"] === "gzip"
  )
    compressedUpload = true;
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
    .locator(".screen-content")
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
  await page
    .getByLabel("投稿からの保存期間", { exact: true })
    .selectOption("1440");
  // Drop a real browser connection after its first durable ACK; the app must resume.
  await page.evaluate(() => {
    const Native = window.WebSocket;
    let interrupted = false;
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (String(url).endsWith("/stream"))
          this.addEventListener("message", (event) => {
            const message = JSON.parse(String(event.data));
            if (message.type === "ack" && !interrupted) {
              interrupted = true;
              this.close(4001, "Simulated interruption");
            }
          });
      }
    };
  });
  await page.locator("input[type=file]").setInputFiles({
    name: "browser-proof.txt",
    mimeType: "text/plain",
    buffer: browserProof,
  });
  await page
    .getByRole("button", { name: "browser-proof.txt", exact: true })
    .waitFor();
  if (!compressedUpload || pipelineSockets < 2)
    throw new Error(
      "Browser did not negotiate compressed pipeline upload and reconnect",
    );
  if (
    (
      app.store.db
        .query("SELECT count(*) AS n FROM items WHERE name='browser-proof.txt'")
        .get() as any
    ).n !== 1
  )
    throw new Error("Resumption duplicated the file");
  const downloadReady = page.waitForEvent("download");
  await page
    .getByRole("button", {
      name: "browser-proof.txtをダウンロード",
      exact: true,
    })
    .click();
  const browserDownload = await downloadReady;
  const downloadedPath = await browserDownload.path();
  if (!downloadedPath || !(await readFile(downloadedPath)).equals(browserProof))
    throw new Error("Browser gzip download changed the saved file bytes");
  await page.getByRole("button", { name: "browser-proof.txtの設定" }).click();
  await page
    .locator(".screen-content")
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
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "URLをコピー", exact: true }).click();
  await page.getByText("コピーしました", { exact: true }).waitFor();
  if ((await page.evaluate(() => navigator.clipboard.readText())) !== staffURL)
    throw new Error(
      "Copy button did not copy the complete staff invitation URL",
    );
  await page.evaluate(async () => {
    await navigator.clipboard.writeText("clipboard-fallback-test");
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: () =>
        Promise.reject(new Error("Simulated clipboard permission denial")),
    });
  });
  await page.getByRole("button", { name: "URLをコピー", exact: true }).click();
  if ((await page.evaluate(() => navigator.clipboard.readText())) !== staffURL)
    throw new Error(
      "Clipboard permission fallback did not copy the staff invitation",
    );
  await page.evaluate(() => {
    delete (navigator.clipboard as any).writeText;
  });
  await page
    .getByLabel("1ファイルの上限", { exact: true })
    .selectOption("1000000000");
  await page
    .getByLabel("1ファイルの上限", { exact: true })
    .selectOption("custom");
  await page
    .getByLabel("1ファイルの上限（単位）", { exact: true })
    .selectOption("1000000");
  await page
    .getByLabel("1ファイルの上限（カスタム値）", { exact: true })
    .fill("250");
  await page
    .getByLabel("保存期間の最大", { exact: true })
    .selectOption("43200");
  await page
    .getByLabel("保存期間の最大", { exact: true })
    .selectOption("custom");
  await page
    .getByLabel("保存期間の最大（単位）", { exact: true })
    .selectOption("1440");
  await page
    .getByLabel("保存期間の最大（カスタム値）", { exact: true })
    .fill("45");
  await page
    .getByRole("button", { name: "ファイル設定を保存", exact: true })
    .click();
  await page.getByText("ファイル設定を保存しました", { exact: true }).waitFor();
  const savedPolicy = await page.evaluate(
    async () => (await (await fetch("/api/admin/settings")).json()).files,
  );
  if (
    savedPolicy.maxFileBytes !== 250000000 ||
    savedPolicy.maxRetentionSeconds !== 45 * 86400
  )
    throw new Error(
      "Preset/custom units were not saved with the correct values",
    );
  const filters = await page
    .locator(".audit-controls input,.audit-controls select")
    .evaluateAll((elements) =>
      elements.map((e) => {
        const r = e.getBoundingClientRect();
        return { y: r.y, height: r.height };
      }),
    );
  if (
    filters.length !== 2 ||
    filters[0].y !== filters[1].y ||
    filters[0].height !== filters[1].height
  )
    throw new Error("Desktop audit filters are not aligned");

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
    .getByLabel("招待されたユーザー名", { exact: true })
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
    .locator(".screen-content")
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
  await page.getByRole("button", { name: "browser-proof.txtの設定" }).click();
  const mobileBounds = await page.locator(".screen-page").boundingBox();
  if (
    !mobileBounds ||
    mobileBounds.x !== 0 ||
    mobileBounds.y !== 0 ||
    mobileBounds.width !== 390 ||
    mobileBounds.height !== 844
  )
    throw new Error("Mobile settings must fill the viewport");
  await page.screenshot({ path: ".artifacts/mobile-settings.png" });
  await page.goBack();
  await page.locator(".screen-page").waitFor({ state: "detached" });
  if (
    await page.evaluate(
      () =>
        document.getElementById("root")?.inert ||
        document.body.style.overflow === "hidden",
    )
  )
    throw new Error("Browser Back must unlock the file list");
  await page.getByRole("button", { name: "browser-proof.txtの設定" }).click();
  await page.getByRole("button", { name: "一覧に戻る", exact: true }).click();
  await page.locator(".screen-page").waitFor({ state: "detached" });
  await page.getByRole("button", { name: "＋ フォルダ", exact: true }).click();
  await page.getByLabel("フォルダ名", { exact: true }).fill("mobile-folder");
  await page.getByRole("button", { name: "作成する", exact: true }).click();
  await page.locator(".screen-page").waitFor({ state: "detached" });
  await page
    .getByRole("button", { name: "mobile-folder", exact: true })
    .click();
  await page.getByRole("button", { name: "＋ フォルダ", exact: true }).click();
  await page.goBack();
  await page.locator(".screen-page").waitFor({ state: "detached" });
  await page
    .getByRole("navigation", { name: "現在のフォルダ" })
    .getByRole("button", { name: "mobile-folder", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Admin", exact: true }).click();
  for (const width of [320, 390, 700]) {
    await page.setViewportSize({ width, height: 844 });
    if (
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      )
    )
      throw new Error(`Administrator page overflows at ${width}px`);
  }
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
