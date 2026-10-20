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

### 2026-10-19: 選択領域の容量表示（2.12）反映済み

CI run 39209196057（361107c）成功後、release-2.12を反映。実行ファイルSHA-256 `f891c3d58ff05579c2068d4b16a949df60161559e6787c8c9a38afce058eb272`。バックアップ `~/.local/opt/pex-fileshare/backups/quota-display-2.12-20261019T061915Z/`。上部の200GB固定表示を選択領域APIのcapacityに変更し、個人・共有のラベルと使用量バーを一致。取得前・切替中は容量を仮表示せず、遅延した古い応答の反映も防ぐ。CIブラウザで5GB→共有200GB→カスタム8GB、遅延した共有応答が後着する場合を検証。管理者の全容量利用は維持。配信JSと最終ビルドの完全一致、healthz成功、fileshare・ai-inference activeを確認。

### 2026-10-19: 共有URLのOpen Graph（2.13）反映済み

CI run 39209878811（7817bfe）成功後、release-2.13をA8へ反映。実行ファイルSHA-256 `ffbce4547a635bd82b6cb6ffd631475da555959db02e14c6178c455d35306967`。オンラインSQLite・実行ファイル・設定のバックアップ `~/.local/opt/pex-fileshare/backups/share-og-2.13-20261019T062514Z/`。最終確認のストレージは4件48,067,016 bytes、管理者1・スタッフ1、パスキー2件。HTTP/3広告443を維持し、fileshare・ai-inferenceはactive。

`/?item=<ID>` と `/files/<ID>/preview` のHTMLへファイル別タイトル、説明、Open Graph、Twitter Card、canonicalをサーバーで出力。公開画像とMP4/WebMは対応コンテンツURLを指定する。メタデータの判定は常に匿名のcanReadを使い、所有者・管理者セッションでも非公開情報を埋め込まない。HTMLはno-storeで、期限や親フォルダ・閲覧権限変更を毎回確認する。通常HTML・gzip・HEAD、記号入りファイル名のエスケープ、非公開・招待・階級・期限・親権限、公開範囲変更直後をテスト。50テスト534 assertions、型検査、ブラウザ、転送、CPU動画のCI検証に成功。

本番の指定共有URLをwgetで取得し、`w6n7A8MWJHovR_-i.mp4 | FileShare`、容量29.08 MB・投稿者koukunnを含む説明、正規共有URL、video/mp4のOG動画URL、Twitter Cardを確認。独立プレビューURLのOG情報も確認。公開IP経由の証明書検証付きHTTP/3で共有HTMLの200応答を確認した。個人容量表示の2.12修正も含む。

### 2026-10-20: A1一時受信・A8バックグラウンド反映を有効化

A8へ実行ファイルSHA-256 `6423a6aabace003cffd7eb43f2709abdae2bfdfa37f859272e0e16062df09f2d` を配置。設定変更前のバックアップは `~/.local/opt/pex-fileshare/backups/edge-spool-enable-20261019T153247Z/config.json`（SHA-256 `d165a56eb40305d7ac48d209cf83e99e7c42a0d72eb6495eaf82cb507437ba51`）。A8の `edgeSpool.enabled` を有効化し、A1のTailnet IPだけを信頼する設定と既存のHMAC secret file設定を確認して `fileshare.service` を再起動した。保存ファイルやSQLiteデータは変更していない。

A1では `fileshare-a1-edge-spool.service` が `127.0.0.1:8124` で稼働中。FerrumProxyのWeb用443インスタンスに `share.pexserver.com /edge-upload → 127.0.0.1:8124` を追加し、既存の `/ → 100.69.76.52:8100` を維持した。Web用インスタンスだけを再起動し、FerrumProxyの管理サービスや他のインスタンスは再起動していない。公開 `/edge-upload/healthz` とA8 `/healthz` が200、公開 `/api/me` が `pipeline:fileshare-upload-v2` と `edgeSpool:true` を返し、A8のFileShareサービスはactive。

ブラウザーは認証・容量予約・最終確定をA8で行い、2MiB以上のファイルは最大4並列でA1へ受信する。A1は最大24GBを一時保管し、8GBの空き容量を維持する。A8への反映が完了してから通常のアップロード確定とダウンロード公開を行う。A1→A8の実測帯域は約5.8MB/sのため、この構成はA1での受信待ちを短くするが、A8への反映時間は短縮しない。実ファイルのアップロード試験は行っていない。

ローカルでは `bun run typecheck`、`bun run build:exe`、Python構文検査、`git diff --check` が成功。ユニットテストは実行していない。

### 2026-10-20: A1受信の詰まりと速度表示の平滑化

並列PATCHの応答間隔だけで速度を計算していたため、完了応答が重なると表示値が大きく跳ねていた。ブラウザーはA1の耐久受領済みバイト数を維持したまま、1.5秒の移動窓から速度を算出し、250msごとに表示を更新する。A1では同一ファイルの別ブロックの `pwrite` と `fsync` を並行化し、同一ブロックの再送はロックで直列化する。SQLiteの受領記録は各ブロックの `fsync` 後に確定する。

A8実行ファイルSHA-256 `5860fdd8f10448ccff975e791f96f3a73789b576afc7f6dd2862c36fbe0bec15` を配置し、A1 spoolのPythonソースSHA-256 `1f94a7e3ae8aa7eed3637b1d0fa3cc9aeb6cd8fc57101672f191b1881e99d785` を反映。A8の実行ファイル・設定・オンラインSQLiteバックアップは `~/.local/opt/pex-fileshare/backups/upload-stutter-fix-20261019T154843Z/`、A1の反映前ソース保全コピーは `/home/ubuntu/.local/opt/fileshare-edge-spool/backups/parallel-block-write-20261019T154744Z/a1-edge-spool.py`。両ホストで未完了アップロード予約が0件であることを再起動直前に確認した。

A1の公開 `/edge-upload/healthz`、A8の `/healthz` が200、公開 `/api/me` は `pipeline:fileshare-upload-v2` と `edgeSpool:true` を返し、両サービスはactive。公開 `/index.js` のSHA-256 `99472a3a44f53ec152e0a46c12fcb12c51e7ef6f747a7fbb379c2bb05718b62f` はローカルビルドと一致。実ファイルのアップロードは行っていない。

### 2026-10-20: 管理画面・検索・差分転送（2.16）反映済み

公開整理と機能追加の `a832477`（2.14）、確定済みブロック解放の `aa6f387`（2.15）、HTTP/1互換修正を含む `93b6a0b`（2.16）をpush済み。最終CI [39288510492](https://github.com/gamelist1990/FileShare/actions/runs/39288510492) が成功し、release-2.16 Linux x64をA8へ配置した。実行ファイルSHA-256 `b56f8bcfa6fee4ca21315ce403b720ab05d9c7d9501c416b20747cca39f9c4f3`、A1 receiver SHA-256 `418708cd4c986ff3d442c4852e5086c0d4bf14afa92a107b67b4a533fe3274c1`。A8のFileShare、既存ai-inference、A1 receiverとFerrumProxyはactive。既存のFerrumProxy経路割当・他インスタンスは変更していない。

最初の切替直前のオンラインSQLite・実行ファイル・設定バックアップはA8 `~/.local/opt/pex-fileshare/backups/manager-delta-2.15-20261019T164225Z/`、A1 `~/.local/share/fileshare-edge-backups/manager-delta-2.15-20261019T164225Z/`。2.16切替前はそれぞれ `http1-edge-2.16-20261019T165005Z/`、`http1-edge-2.16-20261019T165006Z/` に保存。最終反映前後とも20件4,285,978,506 bytes、承認済みスタッフ3・管理者1、パスキー5件、未完了アップロード0件を確認した。

VIP・スタッフ・管理者の無期限保持、個人領域の初期値とCookie保存、管理者個人容量の割当遵守、共通ナビ、ファイル移動・複数外部ドロップ、プロフィール画像の選択状態と丸枠クロップ、アイコン付きランキング、公開タグ検索を追加。管理画面はユーザー検索・状態／権限フィルター・ページ分割と用途別ナビを備え、保存先ドライブの割当、OpenAI互換endpoint・暗号化API key保存・モデル取得／選択に対応する。実ドライブの新規割当は0件で、管理者がマウント済みの書込可能パスと容量を指定する。実AIサービスは有効化せず、APIは互換モックで検証した。

A1は受信中にA8へ転送し、A8がファイル・初回ディレクトリエントリーのfsyncとFULL-synchronous SQLite受領記録を確定した部分だけを解放する。A1は先にremote-read境界を記録してからhole punchingを行う。A8の受領位置が後退した場合は停止し、未確認部分は解放しない。公開済み転送途中のファイルはA8の確定済みprefixとA1の残りを順に読み出す。ダウンロードは256KiBずつ順次配信し、Range・HEAD・テキストプレビューと毎回の権限再確認を維持する。A1実機の一時プローブでも、論理サイズ1MiBのまま実使用量が1MiBから512KiBへ減ることを確認した。これは全量の二重保存ではなく、転送途中は両ホストにデータが分かれる。A1の24GB上限・8GB空き確保は維持し、物理回線速度の向上を実測したという主張はしない。

HTTP/1で同じ接続を再利用したリダイレクトがA8へ誤配送される問題を本番で発見したため、edge有効時のFileShareとA1はHTTP/1応答後に接続を閉じる。現行FerrumProxyのTCP接続ごとの経路選択に合わせる互換対応で、要求間の接続確立コストが生じる。ファイル本体は同じ接続で最後までストリーミングする。HTTP/3 bridgeではhop headerが除去され、QUIC接続と独立ストリームを再利用できる。WebSocket転送も維持する。

54テスト636 assertions、型検査、依存監査（122 packages、検出0）、ブラウザ、実行ファイル転送、CPU動画検証が成功。実Python receiverとA8の統合試験で、保存確定後の物理領域解放、境界をまたぐRange、A1再起動後の読み出しと転送再開、未確定prefix拒否、セッション失効、キャッシュ・ダウンロード集計を検証した。本番では追加Connectionヘッダーなしのwgetで公開ファイルRange 1024 bytes、curlで公開PNG全量68,281 bytes取得成功。A8原本・A1 cache・取得データのSHA-256はいずれも `595c6e11f57ed7a2b87f919be65ac63eb25f2b3380e3e31939be23a47416e14c`。公開IP経由の証明書検証付きHTTP/3 healthz 200、両healthz、検索・ランキング・Userページ、共有OG、匿名管理API 401を確認。配信JSはローカル生成物のSHA-256 `a1b7ca4a5e9c32e148034b907d4fb18d11b276b067aa0d74ff5c721985e64b28` と一致する。本番に試験アカウント・パスキー・試験ファイルは追加していない。

生成HTML/JS、ローカル共有サンプル、実験動画はGit追跡から除外し、元の作業端末のローカルファイルは保持した。履歴の書換えは実施していない。

### 2026-10-20: ドライブ自動検出・切断復帰・削除予約（2.17）反映済み

`30f092f`をpushし、[CI run 39291118436](https://github.com/gamelist1990/FileShare/actions/runs/39291118436)成功後、release-2.17 Linux x64をA8へ配置した。実行ファイルSHA-256 `9840b215830f72de015a2f862f1d0f735b69d63e5630c2c4034835ad7915862c`。反映前の実行ファイル・設定・オンラインSQLite・件数は `~/.local/opt/pex-fileshare/backups/drive-recovery-2.17-20261019T170730Z/`。前後とも20件4,285,978,506 bytes、承認済みスタッフ3・管理者1、パスキー5件、アップロード0件を保持した。FileShareと既存ai-inferenceはactive。A1 receiver・FerrumProxyの変更や再起動は不要で、既存の経路・HTTP/3設定を維持した。

管理画面はLinuxのmountinfoと書込可能なホーム領域から候補を検出し、選択・空き容量からの自動割当・プリセット・詳細パス指定を提供する。同じファイルシステムの既存未使用割当も差し引く。追加しても論理フォルダ・URL・権限を維持し、全体の容量だけを拡張する。個人割当は変更しない。A8実機のホーム領域は書込可能、確認時のファイルシステム空き882.92GB。実際の保存先割当は0件を維持し、管理者が候補を選ぶ状態とした。OSのドライブマウントや既存データのインポートは自動実行しない。

専用保存先の識別マーカーとファイルサイズを検証する。取り外し、異なるドライブへの入替、元ファイルの欠落・サイズ不一致時は一覧に「404・破損・接続不可」を表示し、通常配信・A1 cache認可・テキスト・動画変換／キャッシュ・独立プレビューを404で拒否する。メタデータを保持し、正しい保存先が戻れば同じURLで復帰する。一覧・プレビュー・管理画面は15秒ごとに状態確認し、独立404ページも15秒で再読込する。識別済みドライブのマーカーを勝手に再生成しない。旧版のマーカーなし保存先は、登録済みファイルを確認して一度だけ移行する。空の未識別パスはドライブを特定できないため自動移行しない。

切断／破損状態の通常削除は復元不可として記録し、A8 SQLiteのvolume_deletionsに削除予約を耐久保存する。完全削除でファイルのメタデータを消した後も予約は残る。期限切れ・取消済み転送にも同じ仕組みを適用する。正しいドライブが戻ったときに管理画面の再検出または通常最大1分の巡回で元blob・途中copyを削除し、ディレクトリfsync後に予約を消す。別ドライブには予約を実行しない。Linuxでは保存確定と削除に検証済みディレクトリFDを使い、途中のアンマウントで別の基底ディレクトリへ書き込まない。

55テスト678 assertions、型検査、依存監査（検出0）、ブラウザ、実行ファイル転送、CPU動画検証に成功。切断をディレクトリ移動で模擬し、同じパスに別の識別マーカーと同名ファイルを置いて、誤配信・誤保存・誤削除を拒否することを確認した。元の保存先を戻すと残したファイルは復帰し、切断中の削除と期限切れのblobはサーバー再起動を模したStore再生成後も削除された。通常フォルダ・個人上限・容量追加・重複登録拒否・サイズ破損の404・旧保存先の一度だけの移行も検証した。ブラウザでは候補選択、試験用パスへの容量追加、接続不可表示、390pxでの横はみ出し拒否、再接続表示を確認。実機のUSB取り外し試験や本番ファイルへの破損・削除操作は行っていない。

本番のhealthz、公開IPでの証明書検証付きHTTP/3 healthz 200、wget Range 1024 bytes、curlの公開PNG全量68,281 bytes（既存原本と同じSHA-256）を確認。配信JSはローカルの `353c723c9b8b3b38e378b25b3ed6ccc197907ca64aefa2bbdd8409e5f6322a16`、theme.cssは `c7f64887ff4dab8467a1d03cb0c50f6002396d15e11bb5646081e27ed5c3fc47` と一致。新設の保存先と削除予約はともに0件。CIスクリーンショットはfileshare-ui artifactのmanager-storage.png、manager-storage-offline-mobile.pngで確認できる。

### 2026-10-20: 管理コンソール・無期限保存UI（2.18）反映済み

`5956b5b`をpushし、[CI run 39349718613](https://github.com/gamelist1990/FileShare/actions/runs/39349718613)成功後、release-2.18 Linux x64をA8へ配置。実行ファイルSHA-256 `27669c583aa1255f74fd70bbad296c9ed8d30726f8035d49c67eda54a76b8788`。旧実行ファイル・設定・オンラインSQLite・件数は `~/.local/opt/pex-fileshare/backups/admin-layout-retention-2.18-20261020T004904Z/`。反映前後とも21件4,308,582,721 bytes、承認済みスタッフ3・管理者1、パスキー5、未完了アップロード0、追加保存先0を保持。FileShareと既存ai-inferenceはactive。A1 receiver、FerrumProxy経路・HTTP/3設定は変更していない。

管理画面の入口をダッシュボードへ変更。PCは左メニュー、スマホは選択式メニューを使い、ユーザー、ファイル、ストレージ、申請・招待、利用・保存設定、AI監視、審査・ログ、ごみ箱、メンテナンスに分けた。カードから承認待ち・容量・保存待ちの操作へ遷移できる。`/admin?view=storage`等で直接開く項目を指定し、ブラウザ履歴にも対応する。カテゴリ切替ではフォームをアンマウントせず入力状態を保持する。小画面は入力16px、主要操作44pxの高さを確保し、サイドメニューを畳む。従来の全項目表示は「全体」から利用できる。

管理者用「ファイル記録の調整」の保存期間に無期限が欠けていたため追加した。通常アップロード、ドラッグ投稿、既存ファイルの設定、管理者の記録調整で無期限の選択を揃えた。スタッフの共有ストレージ投稿と管理者の無期限設定は、既存のサーバー側許可を維持する。プライベートの初期値は0（無期限）で、本人が選んだ期間のCookie保存は保持。共有URLから開いた個人フォルダは選択中タブではなく実際の保存先ownerで保持期間の初期値を判定する。既存ファイルの期限を一括変更していない。

55テスト678 assertions、型検査、依存監査（検出0）、WebAuthnブラウザ、実行ファイル転送、CPU動画検証が成功。ブラウザ試験ではスタッフが共有へ無期限を選んで投稿し、owner=NULL・expires_at=NULLで保存されたこと、管理者用ファイル記録編集で無期限を選びexpires_at=NULLにできることを確認。個人領域の無期限初期値と明示的に選択した60分のCookie復元も継続検証。管理ダッシュボード、PCカテゴリの分離、スマホの項目切替、320/390/700pxでのページ横はみ出し防止を確認。CI fileshare-ui artifactにadmin-dashboard-desktop.png、admin-dashboard-mobile.pngを保存した。本番ユーザーでの試験投稿・期限変更や新規パスキー作成は行っていない。

本番healthz、公開IP・証明書検証付きHTTP/3 healthz 200、wget Range 1024 bytes、匿名の`/admin?view=storage`が401を確認。公開JS SHA-256 `ca0e1dedbb3e50dbd036cf12b263ebff741deae96208d31c3a41f0074a7a857d`、theme.css `d3a42626fc2d47c4214216b4b62b3b8d07928aa7c8a98de1bb1b49ab0899650a` はローカル最終生成物と一致する。
