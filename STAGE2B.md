# 段階2B: ローカルHTTPSとiPhone Safari実機手順

準備日: 2026-10-18。今回はPC側の環境整備まで。**iPhone・Bluetoothの結果はすべて未検証**。同期精度の統計測定は成立性確認後に行う。

## 1. 準備した環境と確認結果

| 項目 | 現在の状態 |
| --- | --- |
| LAN HTTPS URL | `https://192.168.3.3:5173/`（起動中のみ） |
| PC接続 | 有線「イーサネット 3」。Windowsのネットワーク区分はPublic。設定は未変更 |
| サーバー待受 | PCのLAN IPv4だけ、5173固定。全インターフェースや外部IPv4は設定検査で拒否 |
| 証明書 | 公式mkcert v1.4.4のポータブル版で生成のみ。SAN: 192.168.3.3/localhost/127.0.0.1 |
| 秘密鍵・CAの保存先 | `%LOCALAPPDATA%\KaraokeSync\https`。OneDrive・Git配下に置かない |
| プロジェクト内設定 | `.local-https/server.json`。Git除外、Viteによる配信も拒否 |
| CA信頼登録 | WindowsのCurrentUser/LocalMachine Rootに今回のCAがないことを読み取り確認。iPhoneも未設定 |
| ファイアウォール | ルール追加・区分変更・無効化を一切していない。iPhoneからの到達性は未確認 |
| PC HTTPS試験 | 明示した公開CAでTLS署名とIPを検証し、ページ/アプリモジュールが200。CA未指定では信頼エラー |
| 配信制限 | `.local-https/server.json`、サーバー秘密鍵の`/@fs/` URL、mkcert.exeは403を確認 |
| 公開CA受渡し | ポート5174で公開CA/単一CAプロファイルだけ配信できることをPCから確認。秘密鍵URLは404 |
| 自動テスト | 既存72件は変更せず維持。追加20件、全92件・型検査・ビルドが成功 |

確認後にHTTPS・CA受渡し両サーバーを停止する。インターネット公開、トンネル、ルーターのポート転送、有料サービスは使用していない。YouTubeの正規外部通信には引き続きインターネット接続が必要。

### CAの本人確認用SHA-256指紋

```text
B4:95:6B:F0:A0:4D:6E:1E:8D:0C:91:B9:FB:E4:82:7C:3E:F0:31:55:EE:D3:93:5B:35:2B:48:26:74:25:7E:43
```

生成し直した場合は指紋も変わる。共有前にPCの出力と照合する。このCAの秘密鍵（rootCA-key.pem）はiPhone・共有サーバー・Gitへ渡さない。

## 2. ユーザーが行うPC側の準備

1. 自分が管理する信頼できる家庭内ネットワークか確認する。PCは有線でも、iPhoneが同じルーターの通常Wi-Fiに接続していればよい。ゲストWi-Fiや端末間通信遮断では接続できない場合がある。
2. 現在のPC区分はPublicなので、家庭内と確認できた場合だけWindowsの「設定 → ネットワークとインターネット → イーサネット → ネットワークプロファイル」をPrivateへ手動変更する。会社・学校・公共ネットワークでは勝手に変更せず管理者へ相談する。
3. iPhoneが同じLANへ接続していることをWi-Fiの詳細で確認する。VPN等がローカル通信を遮断していないか確認する。VPNをこちらで切断・再設定することはない。
4. 必要な場合だけ、下記の限定ルールをユーザー自身が管理者PowerShellで追加する。既存ルールは削除・上書きしない。Windows Defender Firewall全体を無効にしない。

以下は**未実行の手動操作例**。Nodeの実際のパスを確認し、同名ルールがあれば先に内容を確認する。Private区分になっていなければこのルールは適用されない。

```powershell
$ksNode = (Get-Command node).Source
New-NetFirewallRule -DisplayName 'KaraokeSync local HTTPS 5173' -Direction Inbound -Action Allow -Protocol TCP -LocalAddress 192.168.3.3 -LocalPort 5173 -RemoteAddress LocalSubnet -Profile Private -Program $ksNode
# 公開CAをLAN配信する方法を使う場合だけ追加
New-NetFirewallRule -DisplayName 'KaraokeSync public CA 5174' -Direction Inbound -Action Allow -Protocol TCP -LocalAddress 192.168.3.3 -LocalPort 5174 -RemoteAddress LocalSubnet -Profile Private -Program $ksNode
```

Node/pnpmが通常のPowerShellから見つからなければ、[開発ガイド](DEVELOPMENT.md)の環境を使うか、このチャットに起動を依頼する。ファイアウォール変更は依頼と区分確認後に扱う。

## 3. 公開CAの受渡しとiPhoneの明示操作

### A. 公開CAの受渡し

推奨は公開CAだけのローカル受渡し。PCで次を起動する。アプリ本体やプロジェクトファイルをHTTPで配信するサーバーではない。

```powershell
pnpm https:share-ca
```

iPhone Safariで `http://192.168.3.3:5174/root-ca.mobileconfig` を開く。内容はKaraokeSync Local Test CAの1証明書だけで、Wi-Fi/VPN/端末制限の設定を含まない。指紋・表示名・発行元をPC側と照合し、自分の検証CAと確認できたときだけダウンロードを許可する。初期受渡しはHTTPのため、信頼できる同一LANで行い、出所を確認する。

代替は `%LOCALAPPDATA%\KaraokeSync\https\root-ca.cer` を、ユーザーが選んだUSB/ファイル転送方法でiPhoneへ渡すこと。この場合ポート5174は不要。CA/サーバーの秘密鍵は転送しない。

### B. プロファイルのインストール（ユーザーのみ）

1. iPhoneの設定で「プロファイルがダウンロード済み」、または「一般 → VPNとデバイス管理」を開く。
2. `KaraokeSync Local Test CA` を確認し、必要なら端末のパスコードを入力してインストールする。署名なし表示はローカル生成のためだが、知らないプロファイルは入れない。
3. 「設定 → 一般 → 情報 → 証明書信頼設定」で、このCAだけに「ルート証明書を全面的に信頼する」を有効にする。プロファイルのインストールだけではTLSの信頼が有効にならない場合がある。
4. 受渡しが済んだらPCのCA共有サーバーをCtrl+Cで止める。

これはユーザーによる明示操作であり、自動化していない。iOS版や端末管理状態で画面名・利用可否が異なる場合は、表示内容を確認してから進める。今回この手順のiPhone実施はまだしていない。

Windowsの信頼ストアへCAを入れることは、iPhoneだけで試すための必須条件ではない。PCブラウザも警告なしでHTTPS利用したい場合は、別途公開CAを手動で信頼する。こちらではmkcert -installを実行していない。

## 4. HTTPSアプリの起動

```powershell
pnpm dev:iphone
```

iPhone Safariで **`https://192.168.3.3:5173/`** を開く。証明書警告が出る場合は無視してマイク試験を続けず、CAの信頼、IP一致、期限を確認する。iPhoneのlocalhostはPCではない。PCのIPが変わった場合は、古いURL・証明書のまま進めない。

アプリの起動だけではYouTubeのplayやマイク取得をしない。「検知を準備」で初めて取得を開始する。全設定・ログはメモリ上で、ページ再読込・モード切替で失われるので試行後にJSON保存する。

### IP変更・再設定

`https:setup`は既存設定と鍵を上書きしない。IP変更時はサーバーを止め、既存設定とサーバー証明書/鍵をユーザー承認のうえ別名退避して再生成する。CAディレクトリは保持すれば同じ信頼関係を使える。CAを作り直した場合はiPhoneの信頼設定も更新が必要。自動削除やルートCAの上書きはしない。

## 5. 成立性試験（iPhoneの実操作は次の指示後）

各試行の前にiPhone型番、iOS版、Safari、イヤホン型番、接続状態、機種、動画ID、開始秒、補正、しきい値、継続時間、保持/解放、待機秒、出力先を記録する。入力マイクは判明する範囲でよく、不明を本体マイクと断定しない。本体/イヤホンのどちらでも正常検知できればよい。

### 試験1: アクセスとマイク、検知前再生防止

1. アプリをHTTPSで開き、実接続モードの表示を確認する。画面をつけた前面表示で使用する。
2. Bluetoothイヤホンを接続し、コントロールセンター等で出力先を確認。音量を小さめにする。他アプリの音は止める。
3. 埋込可能な動画IDを入力。PCでは `M7lc1UVf-VE` を使ったが、同じ動画がiPhoneでも利用可能とは保証しない。
4. 最初はしきい値1、継続50ms、保持を選び「検知を準備」。マイク許可をユーザーが選ぶ。このしきい値は音量表示を観察するための値で、通常の検知設定ではない。
5. CUED/検知待機、RMS表示が変わるか、マイク使用表示を確認。待機中に勝手に動画が再生されないことを確認する。プレイヤーの再生ボタンを直接押さない。
6. すべて停止し、off・iframe消去・端末のマイク使用表示の変化を記録。即時表示が消えない場合も実状態とOS表示を分けて記録する。

### 試験2: 検知→自動再生→実際の発音

1. すべて停止後、静かな時のRMSより上で、伴奏を拾えるしきい値へ調整。PCで使った0/0.001は環境ノイズで発火した値で、iPhoneの推奨値ではない。
2. 継続0msで開始し、待機完了後に短いテスト音/伴奏を出して、検知・要求・プレイヤー状態と実際のイヤホン発音を別々に記録する。
3. 自動再生がブロックされたらエラー文とログを保存し、毎回タップすればよいという成功判定に置き換えない。隠れた事前再生で解除しない。
4. 音が出たら、Bluetoothのままか、本体/受話口へ切り替わっていないか、音質低下・無音・音声ループがないか確認。意図しない出力・ループがあればすべて停止。
5. 同じしきい値で継続50ms、必要なら200ms等を比較する。短音と持続音の結果を観察するが、残響が長い場合もあるため、手拍子の長さだけで条件成立を断定しない。

### 試験3: 保持/解放と再生操作

1. 「保持」で検知後、検知は終了しマイク資源はretainedかを確認。余分な音でplayが繰り返されないか確認。
2. 一時停止→再生で続きから再開し、音検知が自動再開しないことを確認。可能なら再生要求直後の一時停止も試す。
3. すべて停止してoffを確認しログを保存。
4. 他の条件をできるだけそろえ「解放」で再試行。PLAYING確認後にoffとなり、出力先・音質・無音区間に違いがあるか記録する。
5. 初回と再試行、短い待機と30秒程度の待機を分ける。成立が確認できた後に長めの待機や切断/再接続へ進む。まず各条件1〜3試行を目安にし、統計的な精度合格は出さない。

### 結果の記録欄（未記入＝未検証）

| 条件 | HTTPS/マイク | 検知/play/PLAYING | 実発音・出力先・音質 | 一時停止/再開/停止 | ログ名 |
| --- | --- | --- | --- | --- | --- |
| Bluetooth・保持 | 未検証 | 未検証 | 未検証 | 未検証 | |
| Bluetooth・解放 | 未検証 | 未検証 | 未検証 | 未検証 | |
| 継続0/50ms比較 | 未検証 | 未検証 | 未検証 | 未検証 | |

## 6. 診断JSONの確認

JSONをPCへユーザーが渡し、次で確認できる。ファイルは読み取りのみで、外部へ送信しない。

```powershell
pnpm log:inspect "C:\path\karaokesync-stage2a-log.json"
```

世代ごとに初回のイベントを確認する。

```text
mic.acquire → mic.acquired
player.cued → player.prepared
両準備完了 → detector.armed
detector.firstExceeded → detector.duration.satisfied
→ player.play.request → [player.buffering] → player.playing
→ player.observed (playing => playing)
session.stop.request / session.finish → player.disposed と mic.resources.released
```

マイクと動画の準備は並行なので、mic.acquiredとplayer.preparedの前後は固定しない。停止後は状態表示用の世代が進む場合がある。再開のplayは新しい検知成立を伴わず、初回の自動playと区別する。ブロック/失敗・ログ破棄は解析結果と生ログで確認する。解析スクリプトは内部順序の補助であり、実発音の自動合否判定ではない。

「PLAYINGあり・音なし」は、成功ではなく出力経路/ミュート等の切分け対象。「要求なし」は入力/検知/準備を、「要求あり・PLAYINGなし」はブロック/回線/動画制限を確認する。誤差統計はこの成立性試験の後。

## 7. 接続できない場合

- タイムアウト: 両端のIP/同一LAN、PCサーバー起動、Private区分、限定ファイアウォール、ゲスト隔離、VPNのLAN制限を確認。
- 証明書警告: 今回のCAと指紋、インストール後の完全な信頼、URLのIPとSAN、PC/iPhoneの日時を確認。
- マイクAPI不可: HTTPSを警告なしで開けるか、Safariのサイト権限と端末設定、別アプリのマイク使用を確認。
- YouTube 153等: origin/Referer・埋込可否・回線を確認。TLS成功と再生成功を同一視しない。
- 止まらない取得: すべて停止→必要なら未完了取得の復旧。ブラウザ要求自体を取消できたとは扱わない。

## 8. 終了と後片付け（ユーザー操作）

アプリですべて停止・JSON保存後、PCの両サーバーをCtrl+C。必要なら今回追加した名前のファイアウォールルールだけを削除する。iPhoneの「VPNとデバイス管理」から今回のCAプロファイルを削除し、完全な信頼の設定も確認する。既存の証明書・他のルールを一括削除しない。Windowsへ手動登録した場合は今回のCAだけを対象に信頼解除する。

## 公式資料

- [mkcert](https://github.com/FiloSottile/mkcert): 証明書生成と信頼ストア登録は別。CA秘密鍵を共有しない。
- [Appleの証明書信頼設定](https://support.apple.com/en-us/102390): 手動導入プロファイルのTLS信頼。
- [Vite server設定](https://vite.dev/config/server-options.html): host/https/strictPort/fs.deny。
