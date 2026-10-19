import { randomUUID } from "node:crypto";
import { chromium } from "@playwright/test";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
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
  await page.getByRole("heading", { name: "共有ストレージ" }).waitFor();
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
  const copyToast = page
    .locator(".toast")
    .filter({ hasText: "コピーしました" });
  await copyToast.hover();
  await page.waitForTimeout(4400);
  if ((await copyToast.count()) !== 1)
    throw new Error("Hovered toast disappeared before the user could read it");
  await page.screenshot({ path: ".artifacts/copy-toast.png", fullPage: false });
  await page.mouse.move(0, 0);
  await copyToast.waitFor({ state: "detached", timeout: 5000 });
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
  async function expectStaffCapacity(value: string, bytes: number) {
    await staffPage
      .locator(".hero-note strong")
      .filter({ hasText: value })
      .waitFor();
    await staffPage
      .locator(".quota small")
      .filter({ hasText: "/ " + value })
      .waitFor();
    if (
      (await staffPage
        .getByRole("progressbar", { name: "ストレージ使用量" })
        .getAttribute("max")) !== String(bytes)
    )
      throw new Error("Quota progress maximum differs from displayed capacity");
  }
  await staffPage
    .getByRole("button", { name: "プライベートフォルダ", exact: false })
    .click();
  await expectStaffCapacity("5.00 GB", 5e9);
  await staffPage.screenshot({
    path: ".artifacts/private-quota-5gb.png",
    fullPage: true,
  });
  await staffPage
    .getByRole("button", { name: "メイン共有フォルダ", exact: false })
    .click();
  await expectStaffCapacity("200.00 GB", 200e9);
  app.store.db.run("UPDATE users SET quota=? WHERE name='invitedstaff'", [8e9]);
  await staffPage
    .getByRole("button", { name: "プライベートフォルダ", exact: false })
    .click();
  await expectStaffCapacity("8.00 GB", 8e9);
  // Hold a stale shared response until a later private request has completed.
  let releaseShared!: () => void, sharedArrived!: () => void;
  const held = new Promise<void>((r) => (releaseShared = r)),
    arrived = new Promise<void>((r) => (sharedArrived = r));
  await staffPage.route("**/api/items?space=shared", async (route) => {
    const response = await route.fetch();
    sharedArrived();
    await held;
    await route.fulfill({ response });
  });
  await staffPage
    .getByRole("button", { name: "メイン共有フォルダ", exact: false })
    .click();
  await arrived;
  if (
    (await staffPage.locator(".hero-note strong").textContent()) !==
    "読み込み中…"
  )
    throw new Error(
      "Switching spaces must clear the old capacity while loading",
    );
  await staffPage
    .getByRole("button", { name: "プライベートフォルダ", exact: false })
    .click();
  await expectStaffCapacity("8.00 GB", 8e9);
  const staleDelivered = staffPage.waitForResponse((r) =>
    r.url().endsWith("/api/items?space=shared"),
  );
  releaseShared();
  await staleDelivered;
  await staffPage.waitForLoadState("networkidle");
  await staffPage.unroute("**/api/items?space=shared");
  await expectStaffCapacity("8.00 GB", 8e9);

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
  await page.goto(origin + "/profile");
  await page.getByLabel("表示名", { exact: true }).fill("PEX Creator");
  await page.getByLabel("所在地", { exact: true }).fill("東京 / オンライン");
  const profilePng = Buffer.from(
    await page.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = 1500;
      c.height = 500;
      const ctx = c.getContext("2d")!;
      const gradient = ctx.createLinearGradient(0, 0, 1500, 500);
      gradient.addColorStop(0, "#162e52");
      gradient.addColorStop(0.65, "#376b9d");
      gradient.addColorStop(1, "#dcb798");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 1500, 500);
      ctx.fillStyle = "#ffffff15";
      ctx.beginPath();
      ctx.arc(1250, 500, 380, 0, Math.PI * 2);
      ctx.fill();
      return c.toDataURL("image/png").split(",")[1];
    }),
    "base64",
  );
  await page.getByLabel("カバー画像", { exact: true }).setInputFiles({
    name: "cover.png",
    mimeType: "image/png",
    buffer: profilePng,
  });
  await page.locator(".social-cover img").waitFor();
  await page.getByLabel("アイコン", { exact: true }).setInputFiles({
    name: "avatar.png",
    mimeType: "image/png",
    buffer: profilePng,
  });
  await page.locator("img.social-avatar").waitFor();

  await page
    .getByLabel("説明", { exact: true })
    .fill("Browser verified profile");
  await page
    .getByRole("button", { name: "SNSリンクを追加", exact: true })
    .click();
  await page.getByLabel("SNS名", { exact: true }).fill("Example");
  await page
    .getByLabel("HTTPS URL", { exact: true })
    .fill("https://example.com/profile");
  for (const width of [320, 390, 700, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    if (
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      )
    )
      throw new Error(`Profile editor overflows at ${width}px`);
    if (width === 390 || width === 1440)
      await page.screenshot({
        path: `.artifacts/profile-editor-${width}.png`,
        fullPage: true,
      });
  }
  await page
    .getByRole("button", { name: "プロフィールを保存", exact: true })
    .click();
  await page.getByText("プロフィールを保存しました", { exact: true }).waitFor();
  await page
    .getByRole("link", { name: "投稿者ページを見る", exact: true })
    .click();
  await page.getByText("Browser verified profile", { exact: true }).waitFor();
  await page
    .getByRole("heading", { name: "PEX Creator", exact: true, level: 1 })
    .waitFor();
  await page.getByText("東京 / オンライン", { exact: false }).waitFor();
  for (const selector of [".social-cover img", "img.social-avatar"]) {
    await page.locator(selector).evaluate(async (img: HTMLImageElement) => {
      await img.decode();
      if (!img.naturalWidth) throw new Error("Profile image did not decode");
    });
  }
  for (const width of [320, 390, 700, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    if (
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      )
    )
      throw new Error(`Profile overflows at ${width}px`);
    if (width === 390 || width === 1440)
      await page.screenshot({
        path: `.artifacts/profile-${width}.png`,
        fullPage: true,
      });
  }
  await page.getByRole("tab", { name: "メディア", exact: true }).click();
  await page
    .getByRole("heading", { name: "メディアはまだありません", exact: true })
    .waitFor();
  await page.getByRole("tab", { name: "ファイル", exact: true }).click();

  await page
    .getByRole("link", { name: "browser-proof.txt", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "browser-proof.txt", exact: true })
    .waitFor();
  await page
    .locator(".text-preview")
    .filter({ hasText: "Verified browser upload" })
    .waitFor();
  const directPreview = page.url();
  if (!/\/files\/[a-f0-9-]{36}\/preview$/.test(directPreview))
    throw new Error("Standalone preview URL missing");
  await page
    .getByRole("button", { name: "プレビューURLをコピー", exact: true })
    .click();
  if (
    (await page.evaluate(() => navigator.clipboard.readText())) !==
    directPreview
  )
    throw new Error("Preview URL clipboard mismatch");
  const fileId = directPreview.split("/").at(-2)!;
  const malicious =
    "# Safe Markdown\n\n<script>window.previewExecuted=true</script>\n\n[bad](javascript:alert(1))\n\n![tracking](https://example.com/tracking.png)";
  app.store.db.run("UPDATE items SET name='safe.md',size=? WHERE id=?", [
    Buffer.byteLength(malicious),
    fileId,
  ]);
  await writeFile(join(app.store.blobDir, fileId), malicious);
  await page.reload();
  await page
    .getByRole("heading", { name: "Safe Markdown", exact: true })
    .waitFor();
  if (
    await page
      .locator(
        ".markdown-preview script, .markdown-preview img, .markdown-preview a[href^='javascript:']",
      )
      .count()
  )
    throw new Error("Markdown allowed active HTML or tracking images");
  if (await page.evaluate(() => !!(window as any).previewExecuted))
    throw new Error("Uploaded script executed");
  await page.screenshot({
    path: ".artifacts/markdown-preview.png",
    fullPage: true,
  });
  await page.goto(origin + "/rankings");
  await page
    .getByRole("heading", { name: "ダウンロードランキング", exact: true })
    .waitFor();
  await page
    .getByRole("heading", { name: "投稿者別ランキング", exact: true })
    .waitFor();
  await page.screenshot({
    path: ".artifacts/rankings-mobile.png",
    fullPage: true,
  });
  const videoId = randomUUID(),
    videoBytes = await readFile(
      new URL("../tests/fixtures/native-preview.mp4", import.meta.url),
    );
  await writeFile(join(app.store.blobDir, videoId), videoBytes);
  await writeFile(join(app.store.cacheDir, videoId + ".mp4"), videoBytes);
  app.store.db.run(
    "INSERT INTO items(id,name,folder,size,mime,visibility,created) VALUES (?,?,0,?,?,?,?)",
    [
      videoId,
      "native-preview.mp4",
      videoBytes.length,
      "video/mp4",
      "public",
      Date.now(),
    ],
  );
  await page.goto(origin + `/files/${videoId}/preview`);
  await page.locator("video").waitFor();
  await page
    .getByRole("button", { name: "元の画質で再生", exact: true })
    .waitFor();
  const nativeVideo = page.locator("video");
  if (
    (await nativeVideo.getAttribute("src")) !==
    `/api/content/${videoId}/preview`
  )
    throw new Error("Cached lightweight preview was not reused");
  if (
    (await nativeVideo.getAttribute("playsinline")) === null ||
    (await nativeVideo.getAttribute("preload")) !== "metadata"
  )
    throw new Error("Native inline/metadata video settings missing");
  await page.waitForFunction(() => {
    const video = document.querySelector("video");
    return !!video && video.readyState >= 1 && video.videoWidth === 320;
  });
  await page
    .getByRole("button", { name: "元の画質で再生", exact: true })
    .click();
  if (
    (await page.locator("video").getAttribute("src")) !==
    `/api/content/${videoId}`
  )
    throw new Error("Original-quality switching failed");
  await page.screenshot({
    path: ".artifacts/native-video.png",
    fullPage: true,
  });
  await page.goto(origin);
  await page.getByRole("button", { name: "パスキー追加", exact: true }).click();
  await page.getByText("登録済み 1 / 3 件", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "別端末用の登録URLを発行", exact: true })
    .click();
  const deviceURL = await page
    .getByLabel("別端末用の登録URL", { exact: true })
    .inputValue();
  const deviceContext = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });
  const devicePage = await deviceContext.newPage();
  const deviceCDP = await deviceContext.newCDPSession(devicePage);
  await deviceCDP.send("WebAuthn.enable");
  await deviceCDP.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await devicePage.goto(deviceURL);
  await devicePage
    .getByRole("button", { name: "この端末にパスキーを追加", exact: true })
    .click();
  await devicePage
    .getByRole("status")
    .filter({ hasText: "パスキーを追加しました" })
    .waitFor();
  const deviceToast = devicePage
    .locator(".toast")
    .filter({ hasText: "パスキーを追加しました" });
  await deviceToast.locator(".toast-text").tap();
  await deviceToast.waitFor({ state: "detached", timeout: 5000 });
  await devicePage
    .getByRole("button", { name: "ログイン画面へ戻る", exact: true })
    .click();
  await devicePage.locator(".screen-page").waitFor({ state: "detached" });
  await devicePage
    .getByRole("button", { name: "パスキーでログイン", exact: true })
    .click();
  await devicePage
    .locator(".screen-content")
    .getByRole("button", { name: "パスキーでログイン", exact: true })
    .click();
  await devicePage.getByText("Level 4 · 管理者", { exact: true }).waitFor();
  await deviceContext.close();
  await page.getByRole("button", { name: "一覧に戻る", exact: true }).click();
  await page.getByRole("button", { name: "パスキー追加", exact: true }).click();
  await page.getByText("登録済み 2 / 3 件", { exact: true }).waitFor();
  await page.screenshot({
    path: ".artifacts/passkey-devices.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "一覧に戻る", exact: true }).click();
  await page.getByRole("link", { name: "User", exact: true }).click();
  await page
    .getByRole("heading", { name: "投稿者を探す", exact: true })
    .waitFor();
  await page
    .getByLabel("投稿者名を検索", { exact: true })
    .fill("does-not-exist");
  await page
    .getByText("一致する投稿者が見つかりません。", { exact: true })
    .waitFor();
  await page.getByLabel("投稿者名を検索", { exact: true }).fill("browseradmin");
  const creator = page
    .locator(".creator-card")
    .filter({ hasText: "browseradmin" });
  await creator.waitFor();
  for (const width of [320, 390, 700]) {
    await page.setViewportSize({ width, height: 844 });
    if (
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      )
    )
      throw new Error(`User directory overflows at ${width}px`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: ".artifacts/user-search-mobile.png",
    fullPage: true,
  });
  await creator.click();
  await page
    .getByRole("heading", { name: "投稿したファイル", exact: true })
    .waitFor();
  await page.getByRole("link", { name: "safe.md", exact: true }).click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page
    .getByRole("button", { name: "プレビューURLをコピー", exact: true })
    .click();
  await page.getByText("コピーしました", { exact: true }).waitFor();
  if (
    (await page
      .locator(".toast")
      .evaluate((e) => getComputedStyle(e).animationName)) !== "none"
  )
    throw new Error(
      "Reduced-motion preference did not disable notification animation",
    );
  await page.getByRole("button", { name: "通知を閉じる", exact: true }).click();
  await page.locator(".toast").waitFor({ state: "detached" });
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
