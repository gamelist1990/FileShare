# PEXserver FileShare 2

PEXserverの共有ストレージ。`PEXServerWebSite/src/renewal.css`の紙色、銅色、青いアクション色とヘッダーに揃えています。

## 起動

Bun 1.4以上とFFmpeg（CPU libx264/AAC）が必要です。

```sh
bun install --frozen-lockfile
bun run build
bun run start --config config.example.json
```

開発用URLは `http://localhost:8100`。`origin`とHostは完全一致が必要です。公開時は `https://share.pexserver.com` 等の確定URLに変更します。秘密鍵は初回にデータディレクトリ内へ0600で生成します。リポジトリにコミットしないでください。

初回だけ、サーバーの`data/bootstrap.token`を読み、トップのログイン →「管理者の初期設定」でユーザー名とキーを入力し、実機のパスキーを登録してください。初期設定キーは24時間で失効し、使用後に削除されます。期限切れの場合はサービスを停止して`bootstrap.token`を削除し、再起動すると未設定の場合だけ再発行します。管理者登録後はキーだけでは管理者を追加できません。予備のパスキーも登録してください。秘密キーをチャット・URLへ貼り付けないでください。

通常の新規登録はIPごとに既定1アカウント、1時間5回まで。パスキー登録後は承認待ちです。管理者だけが`/admin`で承認・拒否・権限変更できます。登録IPはログインで上書きせず、転送ヘッダーからのIP偽装も許可しません。同一NATを共有する利用者には管理者が`accountsPerIp`を調整します。`registration.enabled=false`で新規登録を停止できます。

## 権限

| Level | 名前     | 利用範囲                                                           |
| ----- | -------- | ------------------------------------------------------------------ |
| 0     | 一般     | 公開の共有ファイルの閲覧                                           |
| 1     | VIP      | 既定5GBの個人領域、VIP以上向けの公開ファイル                       |
| 2     | 招待     | VIP機能に加えて、対象キーを使った招待ファイルの閲覧                |
| 3     | スタッフ | 共有領域全般の管理と個人領域。他人の非公開個人領域にはアクセス不可 |
| 4     | 管理者   | 全領域と管理ページ                                                 |

個人領域の所有者はフォルダ・ファイルを公開／非公開／招待に変更し、最低Levelも指定できます。公開ファイルでも親が非公開なら外部へ露出しません。招待キーは256-bit乱数で生成し、サーバーはSHA-256のダイジェストだけを保持します。キー更新で既存の閲覧許可を失効します。招待キーの入力にはログインとLevel 2以上が必要です。ファイルIDとキーは所有者が閲覧者へ別途渡します。閲覧許可は24時間で失効します。管理者と共有領域のスタッフは通常の管理権限でアクセスします。

## ストレージと転送

全体は200,000,000,000 bytes（200GB）、個人領域は5,000,000,000 bytes（5GB）。管理者は個人枠を超えて全体上限内で利用できます。VIP・招待・スタッフの上限は管理者がユーザーごとに変更できます。ごみ箱と未完了の転送予約も容量に含め、並列転送はSQLiteトランザクションで予約します。プレビュー用に全体容量から既定2GBを確保します。これはアプリケーションでの上限で、OSの専用パーティションや物理的な200GB予約ではありません。SQLite・監査ログ等の小さな運用データは別枠です。

アップロードはSHA-256で検証する最大8MiBのチャンクと確定オフセットを使用。ブラウザは約2秒の応答を目標にチャンク量を調整し、失敗時は縮小・指数バックオフを行います。同じタブで同じファイルを選ぶと24時間以内の転送を再開できます。ダウンロードはRange対応。転送全体の帯域上限とバックプレッシャー、IPごとの同時転送制限を適用します。回線自体の上限を超える速度や、他アプリの通信負荷の自動検出は保証しません。`maxBytesPerSecond`を実回線速度の70〜85%程度に設定して余裕を作ってください。

管理画面から一括ごみ箱移動、復元、明示的な完全削除、期限切れ転送と孤立データの整理を実行できます。フォルダの復元は親から順に行ってください。自動整理で利用者のごみ箱を勝手に完全削除しません。

動画の軽量プレビューはCPUだけで作成します。GPUアクセラレーションなし、1ジョブ、2スレッド、最大480p・先頭120秒・50MB・180秒の実行時間制限。キャッシュも容量制限します。元動画の直接Range再生も可能です。FFmpegは最新の修正版を運用してください。FTPと旧パスワードAPIは削除し、旧JSONユーザーDB・任意の既存フォルダの公開には自動移行しません。

## FerrumProxy / HAProxy PROXY protocol v2

`proxy.enabled=true`でPROXY v2必須、`false`で通常HTTPです。前者ではバイナリPROXY v2ヘッダーがない接続にHTTP 400の「有効な通信プロトコルではありません」ページを返します。`X-Forwarded-For`や`X-Proxy-Protocol-V2`だけでは通過できません。IPv4/IPv6 TCP、分割ヘッダー、keepaliveに対応。LOCAL・UDP・UNIX・多重PROXYヘッダーはクライアントIPとして受理しません。受信元は`trustedPeers`の完全一致で限定してください。TLSはFerrumProxy等で終端し、バックエンドはTailscale等の暗号化されたプライベート経路で接続します。

`deploy/ferrumproxy.example.yml`と`deploy/haproxy.example.cfg`は例です。既存の443リスナーがある場合はホストルーティングへ追加し、既存サービスの設定を置き換えないでください。A8はTailscaleの`100.69.76.52:8100`を使用できます。信頼プロキシは実際の接続元だけに限定し、通常のインターネットへバックエンドポートを公開しないでください。

仕様: [HAProxy PROXY protocol](https://www.haproxy.org/download/2.9/doc/proxy-protocol.txt)、パスキー: [SimpleWebAuthn](https://simplewebauthn.dev/docs/packages/server)。

## セキュリティとAI監視

WebAuthnのOrigin/RP ID/ワンタイムチャレンジ/ユーザー検証を確認し、セッションはHttpOnly・SameSite=Strict（HTTPSではSecure）cookie。セッションの保存はランダムトークンのハッシュだけです。権限変更時に対象ユーザーのセッションを失効。全APIで所有者・親フォルダ・階級・キー許可を再検証します。ファイル名を実パスに使わずUUIDで保存し、HTML/SVG/JS等のアップロードは同一Originで実行させません。CSP・Originチェック・Host検証・監査ログ（30日）・全体/IP別レート制限と接続数制限を適用します。アプリ単体では回線を飽和させるDDoSを防げないため、公開側のFerrumProxy等でも制限してください。

`ai.enabled=true`にすると、10分間のイベント種類と件数だけをOpenAI互換APIへ送り、所見を管理者画面に出します。Gemma 4を使う場合も実際のモデルIDとAPI URLを設定します。AIへファイル内容、招待キー、ユーザー名、IPは渡しません。AIに削除・権限変更などの自動実行機能はありません。API失敗時も認証や転送は継続。認証が必要なAPIには環境変数`FILESHARE_AI_KEY`を設定します。

汎用暗号は別プロジェクト [PEXSecureEnvelope](https://github.com/gamelist1990/PEXSecureEnvelope) の公開AES-256-GCMを使用し、ダウンロードticketを用途別AAD付きで暗号化します。秘密鍵はサービスごとに異なります。実ファイルは0700ディレクトリ・0600ファイルに保存し、ディスク全体の暗号化にはLUKS等を別途使用してください。サーバー本文は配信せず、ブラウザ側JSの秘密保持は前提にしません。独自の謎暗号や透過Unicodeは安全性の根拠にしません。

## A8サービス登録・検証

`deploy/fileshare.service`を`~/.config/systemd/user/`へ配置するユーザーサービス例を用意しています。実行ファイルを`~/.local/opt/pex-fileshare/FileShare`、設定を`~/.config/pex-fileshare/config.json`へ配置します。設定は0600、データは0700にしてください。CPUは合計2コア相当、メモリ1GB、優先度Nice 10に制限します。ログイン前の起動には既存のuser linger設定が必要です。

```sh
bun run build
bun run typecheck
bun test
bun audit
bun run build:exe
# ブラウザテストは独立した一時サーバーとDBを自動で生成して実行
# bunx playwright install chromium
bun run verify:browser
```

ブラウザテストは仮想WebAuthn認証器で初期管理者作成、パスキーログイン、個人領域へのアップロード、公開設定、管理画面とデスクトップ・スマホ表示を検証します。テスト用DBは終了時に削除し、スクリーンショットは`.artifacts/`へ保存してGitには含めません。

CPU変換の実機確認: `FFMPEG=/path/to/ffmpeg bun scripts/verify-preview.ts`。

実際の配置先と未完了の公開設定は [A8 deployment](docs/A8-deployment.md) に記録しています。
