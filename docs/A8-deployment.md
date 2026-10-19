# A8 deployment — 2026-10-19

## Hardware observed

| Host   | CPU                         | RAM available at inspection      | GPU                    | Disk                  |
| ------ | --------------------------- | -------------------------------- | ---------------------- | --------------------- |
| HomePC | Ryzen Embedded R2514, 4C/8T | ~15GiB / 26GiB                   | Radeon Vega integrated | ~106GiB free / 233GiB |
| A8     | Ryzen 7 8745HS, 8C/16T      | ~3.4GiB / 10GiB visible to Linux | Radeon 780M integrated | ~843GiB free / 937GiB |

HomePC had a load average around 9 and a Java process using about 5 CPU cores. Its additional RAM does not imply spare CPU capacity. No AI service was migrated. A8's existing `ai-inference.service` remains running.

## Installed service

- User: `pexserver-home`
- Unit: `~/.config/systemd/user/fileshare.service`, enabled; user linger is already enabled.
- Binary: `~/.local/opt/pex-fileshare/FileShare`
- Configuration: `~/.config/pex-fileshare/config.json` (0600)
- Storage: `~/.local/share/pex-fileshare` (0700)
- Listen: `100.69.76.52:8100` on Tailscale; PROXY v2 required.
- Public origin: `https://share.pexserver.com` — HTTPS and hostname routing verified on 2026-10-19.
- Application capacity: 200GB total, default personal quota 5GB, 2GB within the total reserved for previews.
- Resources: `CPUQuota=200%`, `MemoryMax=1G`, `Nice=10`, `TasksMax=96`.
- FFmpeg: Ubuntu 26.04 package `8.0.1-3ubuntu2`, CPU only; wrapper at `~/.local/opt/pex-fileshare/ffmpeg`. Needed packages were extracted without sudo; keep the local FFmpeg/libavdevice runtime updated alongside system security updates.
- AI advisory: disabled by default; can use the existing local OpenAI-compatible endpoint when explicitly configured.

The previous dirty checkout at `~/WorkSpace/FileShare` has not been overwritten. Its tracked diff was saved to `~/fileshare-existing-changes-20261019.patch`; existing untracked theme/tests remain there.

## Verification

- Local unit/integration tests cover 28 security/transport/administration scenarios (220 assertions).
- Chromium virtual authenticator: first administrator registration, passkey login, rejection of challenge replay, private upload, publication settings, administrator page, desktop/mobile screenshots.
- A8 real TCP: PROXY v2 request returned HTTP 200; ordinary HTTP returned the Japanese protocol error with HTTP 400.
- A8 CPU media: synthetic MP4 converted successfully; an HLS playlist disguised as MP4 was rejected by the demuxer whitelist.
- Bun dependency audit: no reported vulnerabilities at validation time. This is not an independent security audit.

## Public edge and first administrator

The public edge is `132.145.118.98` (Tailscale `100.98.217.24`). DNS for `share.pexserver.com` points to that public address. `proxy.trustedPeers` is restricted to `100.98.217.24`. FerrumProxy GUI was used to add the exact hostname mapping `share.pexserver.com` with path `/` to `100.69.76.52:8100`, save configuration and restart only the web instance. The existing port 443 listener and fallback to `100.83.127.8:8123` remain. GUI certificate provisioning expanded the certificate to both `play.pexserver.com` and `share.pexserver.com`; it expires 2027-01-16. Both public sites returned HTTPS 200 with normal certificate validation. `/api/me` reports 200GB capacity; `/healthz` returns `{"ok":true}`. The anonymous administrator endpoint returns 401, including with spoofed forwarding/role headers. Automatic renewal uses `snap.certbot.renew.timer`; the proxy reloads changed certificate files for new connections.

The initial administrator and a real passkey were registered on 2026-10-19; the bootstrap key was consumed. Sign in using that registered passkey. Initial setup is hidden after completion. Do not use a test virtual authenticator for production.

```sh
systemctl --user status fileshare.service
journalctl --user -u fileshare.service -n 50 --no-pager
systemctl --user restart fileshare.service
```

Back up the entire protected data directory consistently (stop service or use SQLite's online backup API). Copying just the SQLite main file while WAL writes are active is not sufficient. Keep `envelope.key` private. The service enforces a logical quota; no OS disk partition was created.

FerrumProxy deployed versions: core `2026.10.18-89a39ac`, GUI `2026.10.18-faf0043`. Pre-change edge backups are protected under `/home/ubuntu/backups/host-routing-20261019/`.

## FileShare 2.1 update

Deployed on 2026-10-19: daily JST review books, persistent AI settings, atomic bulk application rejection, bounded/revocable staff invitations, uploader records, download counters and ACL-filtered rankings, per-file retention, administrator file policies, file-type SVG icons and modal focus/scroll handling. New uploads default to at most 5GB per file and a user-selected lifetime from one minute to 30 days. These limits and public metadata/ranking switches are editable in Admin. Existing files retain their prior data and have no expiry until configured. File deadlines block access immediately; a lightweight minute task purges expired blobs, while broader orphan/session cleanup remains hourly.

The SQLite migration adds tables and indexes without altering the existing item/upload column layouts. Before deployment, an online SQLite backup, binary and config were saved under `~/.local/opt/pex-fileshare/backups/admin-2.1-20261019T001804Z/`. Before/after row counts, total stored bytes and the administrator count matched; no existing file was expired or purged during this update. Binary SHA-256: `85ea24ff46340fbffcb9a8c991673d2d87569f722b69e3b74ca94b3045b5df8a`.

Browser CI also verifies invited staff registration and login with a virtual WebAuthn authenticator, the absence of administrator navigation for staff, and rejection of a spent invitation reopened within the same page. Test credentials are isolated from production.

## FileShare 2.2 mobile layout

Login, previews, file settings, folder creation and deletion confirmation now use full-viewport task pages with a sticky Back button and native browser Back support. There is a single scroll surface; closing a task restores background scrolling, focus and the current folder. Forms use 16px inputs and larger touch targets on phones. Mobile file rows and administration tables become cards with visible labels; the administration menu links directly to each section. Notifications remain accessible while a task is open. The viewport includes safe-area support for phones with display cutouts.

The browser verification covers full-viewport settings, both Back actions, folder creation, preserving the current folder and administrator layouts at 320, 390 and 700 pixels. This update changes no database schema or storage policy.

Deployed to A8 on 2026-10-19 from commit `785062a`. The user service is active and public HTTPS health checks succeed. The production mobile login page was verified in the browser, including returning to the file list. Before/after deployment: 3 items, 18,986,855 stored bytes, 1 administrator; all counts matched. Rollback snapshot: `~/.local/opt/pex-fileshare/backups/mobile-2.2-20261019T003934Z/` (previous binary and online SQLite backup). Deployed binary SHA-256: `181abcb4182dfdcba0e5e5441ac31a6cb551e6ae485750534aa30f72df2d41cd`. GitHub Actions run `39181701224` passed all checks, browser/mobile tests and CPU preview verification, and published release `release-2.2` with all platform binaries.

## FileShare 2.3 control improvements

Staff-invitation and file-link copying now runs within the original click gesture, uses both compatible clipboard paths, and selects the URL with manual-copy instructions when copying is unavailable. Copy feedback appears next to the button. Retention and file-size controls share preset dropdowns with custom values and explicit units (minutes/hours/days, bytes/KB/MB/GB). Existing file deadlines remain unchanged unless a new duration is selected. Upload presets respect the administrator's maximum. Month and scope filters use matching grid rows and 46px controls, including native month-input normalization.

Browser verification checks exact clipboard contents, fallback when Clipboard API writes are denied, preset/custom unit conversion and persistence, and matching desktop filter geometry.

Deployed to A8 on 2026-10-19 from commit `96bd03f`. The service is active; public HTTPS health checks pass and the served JavaScript SHA-256 matches the local build. Before/after counts remain 3 items, 18,986,855 bytes and 1 administrator. Rollback snapshot: `~/.local/opt/pex-fileshare/backups/controls-2.3-20261019T004608Z/`. Binary SHA-256: `c9f73facfcf4eeb63568f890a61a5064dd61c6e832c6746eb90c66fe8200355a`. GitHub Actions run `39182174779` passed all checks, including exact clipboard contents with the normal API and simulated permission denial, saving 250MB/45-day custom settings, matching month/scope geometry, mobile regressions and CPU preview isolation. Release `release-2.3` was published successfully. Preview fixture settings used for UI screenshots were isolated from production.

## FileShare 2.4 transfer optimization

The latency-aware upload algorithm, negotiated and checksummed gzip upload chunks, bounded text-download compression, larger streaming read buffers and cached static-asset gzip are described in [transfer-performance.md](transfer-performance.md), with baseline/optimized measurements. No schema migration or storage-policy changes are required. The transfer limits and CPU-only preview configuration are preserved.

Deployed to A8 on 2026-10-19 from commit `8375811`. Rollback snapshot: `~/.local/opt/pex-fileshare/backups/transfer-2.4-20261019T010438Z/` (previous binary and online SQLite backup). Binary SHA-256: `4c8c72998f085251a978553788eb188d8dc21fefadfebca8d25a45a5e3c3ff45`. The service is active, public HTTPS health returns OK, and the production FerrumProxy path serves `index.js` with gzip: 85,085 wire bytes decode exactly to the 271,138-byte local bundle. `Accept-Encoding: gzip;q=0` returns identity with the correct 271,138-byte length. Before/after storage counts remain 3 items, 18,986,855 bytes and 1 administrator. GitHub Actions run `39183554191` completed successfully: 31 tests / 265 assertions, actual Chromium compressed upload and saved-file integrity, mobile/admin/passkey regressions, CPU preview checks and release `release-2.4` with all platform binaries. Synthetic low-link benchmark results are documented separately; they do not measure end-user WAN throughput through FerrumProxy/Tailscale.

## FileShare 2.5 upload pipeline

The single-socket protocol and measurements are documented in [upload-pipeline.md](upload-pipeline.md). This update adds the `upload_blocks` receipt table without changing existing upload/item columns. An online database/binary rollback snapshot is required before deployment. Existing uploads remain readable with offset-only compatibility; new receipts are recorded for both transport paths. No FerrumProxy port, hostname or certificate changes are required because WebSocket upgrades use the existing HTTPS route.

### 2026-10-19: 転送パイプラインと招待制御（2.6）反映済み

CI run 39203548984成功後、release-2.6のLinux x64実行ファイルをA8へ反映。SHA-256 `f0d74642028e924bf83579756698886656dfb0053e85d8a02921a191c1430543`。オンラインSQLiteバックアップと旧実行ファイルは `~/.local/opt/pex-fileshare/backups/registration-2.6-20261019T051738Z/`。前後とも3ファイル47,998,735 bytes、承認済み管理者1・スタッフ1。既存招待1件はLevel 3を保持。公開HTTPSの `/api/me` で `registration:false`、`autoApprove:false`、`pipeline:fileshare-upload-v1`、`setupRequired:false` と200GB割当を確認。ユーザーサービスactive。登録・転送テスト42件347 assertions、ブラウザでパスキーと圧縮・切断再開を検証。

### 2026-10-19: 投稿者ページと権限付きプレビュー（2.7）反映済み

CI run 39203963126成功後にrelease-2.7のLinux x64実行ファイルを反映。SHA-256 `0d840d779516f33ed56aeacc152e0a057002d6371d84e1a5b0dcebee8bfe3d86`。バックアップ `~/.local/opt/pex-fileshare/backups/preview-2.7-20261019T052152Z/`、反映直前3ファイル47,998,735 bytes、管理者1・スタッフ1。公開healthz成功、ユーザーサービスactive。45テスト395 assertionsに加え、CIブラウザでプロフィール・投稿者一覧・独立ランキング・プレビューURLコピーとMarkdown内スクリプト拒否を検証。本番ブラウザでもランキングと公開投稿者ページを確認。

### 2026-10-19: HTTP/3広告の設定対応（2.8）反映済み

CI run 39204559277成功後、release-2.8をA8へ反映。実行ファイルSHA-256 `52e078432bf3844ab6c08d2dadbfd39c50f0682fa400bfe1fee6ce2d8542f77c`、バックアップ `~/.local/opt/pex-fileshare/backups/http3-advertisement-2.8-20261019T052919Z/`。公開healthzとランキング200、wgetによる公開ファイルのRange取得1024 bytes、招待限定登録・初期設定完了を確認。fileshareと既存ai-inferenceのユーザーサービスはactive。3ファイル47,998,735 bytes、管理者1・スタッフ1を保持。

**HTTP/3はまだ有効化していない。** FerrumProxy core 69dbb36のARM64リリースは公開エッジのwebインスタンスに `.next` として配置済み。GUI更新確認でCodexブラウザが操作不能となり、ユーザーへキャンセルを依頼中。GUI復旧後、GUI更新・webコア更新・`https.http3` の有効化・UDP443到達性確認が必要。GUIの自己更新確認をページ内表示へ変更する修正92cc445もpush済み。公開QUIC/TLSの実接続が成功するまでFileShareの `http3Port` は0のままとし、Alt-Svcを広告しない。

### 2026-10-19: VIP共有権限・別端末パスキー・軽量動画（2.9）反映済み

CI run 39205561882（fe68fc5）成功後、release-2.9をA8へ反映。実行ファイルSHA-256 `113c4ebc0f70b296517cb702458085ad3a2054c9998898ac24d8803654707826`。バックアップ `~/.local/opt/pex-fileshare/backups/vip-passkeys-video-2.9-20261019T054034Z/`。反映前後とも3ファイル47,998,735 bytes、承認済み管理者1・スタッフ1、登録パスキー2件を保持。実ユーザーのパスキー登録・登録URL発行は実施せず、device_enrollmentsは0件。既存登録設定のない環境ではVIP共有投稿・編集false、上限3件が適用される。

47テスト430 assertions、型検査、依存監査、実行ファイルの転送検証に成功。CIブラウザでは別コンテキストの新規WebAuthn認証器で登録URLから既存アカウントへパスキーを追加し、そのパスキーでログインできることを検証。動画の実際のメタデータ取得、キャッシュされた軽量版選択、元画質への切替、playsinline/preloadも検証。CPU動画検証でH.264/yuv420p・最大640x360・moov先頭とプレイリスト拒否を確認。公開healthz、動画状態API（匿名で変換不可）、配信中UI内のVIP別設定・端末登録・画質切替を確認。共有権限の変更は新規・再開転送で再検証する。HTTP/3広告は従来通り無効のまま。

### 2026-10-19: User検索・アニメーション通知（2.10）反映済み

CI run 39206943542（694ff85）成功後、release-2.10をA8へ反映。実行ファイルSHA-256 `d7a7b94099d2840572d6b737a77c34a4ac4ff189005c38c5f8ca09bd062f3eeb`。バックアップ `~/.local/opt/pex-fileshare/backups/user-search-toasts-2.10-20261019T055250Z/`。前後とも3ファイル47,998,735 bytes、管理者1・スタッフ1、登録パスキー2件を保持。公開 `/users` が200、匿名の投稿者名検索が成功。配信中の圧縮JSを展開してローカルの最終ビルドと完全一致することを確認。

48テスト451 assertionsで検索の非公開親フォルダ・VIP制限・期限切れ・拒否ユーザー・投稿者表示OFF・24件のページ分割を検証。CIブラウザでUserナビからの検索と投稿一覧への遷移、320/390/700pxでの表示、コピー通知のホバー停止と自動消去、手動閉じる、動きを減らす設定、タッチ後の自動消去を確認。既存のパスキー・転送・CPU動画検証も成功。招待URL/端末登録URLは入力欄に保持し、一度だけ表示するファイル招待キーは専用画面へ移して自動消去の対象外とした。

### 2026-10-19: FerrumProxy HTTP/3待受を有効化、公開UDP到達性を確認中

GUIの更新確認をユーザーが閉じた後、GUIからwebインスタンスのみcore `2026.10.19-69dbb36`へ更新。HTTP/3チェックを有効化・保存し、webのみ再起動した。ARM64実行ファイルSHA-256 `0172673afcc04f3eb3eadfbeaedd7cc61334bc2dd3cf1f8d7fc97be8218e16bd`。公開エッジはUDP443を待受中で、ホストのiptables許可もnetfilter-persistentで保存済み。サバイバル・VoiceChatの既存PIDは維持。

RustのHTTP/3プローブでTailscale宛てに実QUIC/TLS接続し、証明書検証付きhealthz 200と公開ファイルRange 206・1024 bytesを確認。一方、公開IP `132.145.118.98` 宛ては作業端末とA8の2台から接続タイムアウトし、公開インターフェースの同時tcpdumpではUDP443の到着0件。Oracle Cloudのセキュリティ・リスト／NSGでUDP443受信許可が必要と考えられ、ユーザーへ確認依頼中。

公開QUIC接続が成功するまではA8の `http3Port` は0を維持し、Alt-Svcを広告しない。通常HTTPSのshare healthzとplayが200、wgetで公開ファイルRange 1024 bytes取得成功。fileshareと既存ai-inferenceはactive。実行ファイル・ユーザー・保存ファイルは今回変更していない。

### 2026-10-19: 公開HTTP/3有効化完了

ユーザーがOracle Cloud側のUDP443受信を許可後、公開IP経由で証明書検証付きQUIC/TLSのhealthz 200とファイルRange 206・1024 bytesに成功。設定バックアップ `~/.local/opt/pex-fileshare/backups/http3-enabled-20261019T060652Z/` を作り、A8の `http3Port: 443` を有効化してfileshareを再起動。通常HTTPSのGET healthz 200、`Alt-Svc: h3=":443"; ma=300` とwgetのRange取得1024 bytesを確認。fileshare・既存ai-inferenceはactive。転送パイプラインのWebSocketは従来通りTCPを使用する。

### 2026-10-19: カスタマイズ可能なプロフィール（2.11）反映済み

CI run 39208572333（cbe7323）成功後、release-2.11をA8へ反映。実行ファイルSHA-256 `9b40d14c8394af85bdabd1894126fa2aa627790090f1c52b65308984a2eb4726`。オンラインSQLite・旧実行ファイル・設定のバックアップ `~/.local/opt/pex-fileshare/backups/social-profile-2.11-20261019T061406Z/`。前後とも3ファイル47,998,735 bytes、管理者1・スタッフ1、パスキー2件を保持。profilesへ表示名・所在地・カバー画像・表示位置の追加列を移行。既存ユーザーのプロフィールは代筆していない。

見出しを「共有ストレージ」へ変更。プロフィールはカバーと重ねた丸いアイコン、@ユーザー名、説明・SNS、権限に沿ったファイルのタイムラインとメディア切替を備える。編集は画面内ライブプレビュー、ブラウザ内画像縮小、カバー位置調整、表示名・所在地の任意設定に対応。画像の公開にも投稿者表示OFFと利用資格の再確認を適用する。表示名での投稿者検索も可能。

49テスト480 assertions、型検査、依存監査、CIブラウザの画像選択→軽量化→保存→実画像decode、320/390/700/1440pxでの編集・公開ページの横はみ出し検査に成功。既存パスキー・転送・CPU動画テストも成功。本番ブラウザで新しい見出し・公開プロフィール・メディア切替を確認し、配信中JSがローカル最終ビルドと完全一致。HTTP/3広告443を保持し、公開QUIC healthzとHTTPS、wget Rangeも確認。fileshare・ai-inferenceはactive。
