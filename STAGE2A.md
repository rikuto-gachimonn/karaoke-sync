# 段階2A: 実API接続とPC検証

2026-10-18。段階2Aまで実装。iPhone実機・Bluetooth経路・同期精度は未検証。既存の設計資料4件、旧HTML、README、tatusは変更していない。

## 起動・操作

```powershell
pnpm install --frozen-lockfile --store-dir .pnpm-store
pnpm dev
```

PCで表示された `http://127.0.0.1:5173/` を開く。実接続が既定、`/?mode=simulation` は従来の模擬モード。サーバーは127.0.0.1限定で、インターネットやLANへ公開していない。

1. 埋込可能な動画の11文字ID、開始位置、0.05秒刻みの補正、機種、しきい値、継続時間を入力する。
2. 「保持」「解放」を選び「検知を準備」。初回はマイク許可が必要。YouTubeの外部APIへ接続する。準備だけではplayしない。
3. 準備完了で検知待機へ。会話や雑音でも条件を満たせば検知するので、待機前から伴奏を流さない。待機中にプレイヤーの再生ボタンを押すと想定外再生として停止する。
4. 音量超過が指定時間続くとDetector終了→playVideo要求1回。PLAYINGは現在プレイヤー状態を照会して確認する。
5. 一時停止は動画のみ、再開は続きから。音検知は再開しない。「すべて停止」でマイク解放とiframe破棄。次の試行は再準備。
6. ログはメモリ上だけにあり、JSON出力で手動保存できる。設定・音量・ログを旧localStorageに書き込まない。YouTubeの通常埋込にはYouTube側の通信や保存があり得るが、アプリによる旧データ移行・削除は行わない。

しきい値0.08と継続50msは調整前の仮値。今回のPC環境の静かな入力では0.08に届かず、接続確認には0/0.001を使用した。0ms・低しきい値の試験は環境ノイズでも再生を起こすため、実用設定として推奨する値ではない。

## 実装

- `src/adapters/youtube/api.ts`: 公式スクリプトの共有ロード、失敗・期限処理。
- `src/adapters/youtube/player.ts`: 正規可視iframe、cueと開始秒、CUED確認、play/pause/resume、状態照会、エラー/ブロック/BUFFERING、破棄。requestIdは付けない。
- `src/adapters/audio/microphone.ts`: 実getUserMedia、AudioContext.resume/running確認、Float32波形のRMS、購読中だけの分析、track終了/Context中断、資源解放。マイクをdestinationへ接続しない。録音・送信機能はない。
- controller: 実/模擬共通。論理的な中止signalは部分資源の回収用で、ブラウザgetUserMediaの取消ではない。遅着streamは回収。部分回収失敗はleaseをcontrollerに渡して明示再試行する。
- `src/app/createApp.ts`: 実/模擬の組立て、保持/解放の比較設定。旧取得の診断も取得時の世代で記録。
- UI: 可視プレイヤー、実設定、RMS、状態、診断JSON。モード切替は資源解放後のみ。

## 診断の意味

`mic.acquire`、`mic.context.running`、`mic.acquired`、`player.cued`/`player.prepared`、`detector.armed`、`detector.firstExceeded`、`detector.duration.satisfied`、`player.play.request`、`player.playing`/`player.observed`、`player.buffering`/`blocked`/`error`、`session.stop.request`/`finish`、`player.disposed`、`mic.resources.released`を記録する。

時刻はperformance.nowの単調時計（ms）。サンプル観測時刻も初回超過・成立の詳細に含める。PLAYINGは発音・Bluetooth出力・物理同期の証明ではない。外部の基準音とイヤホン発音を測る段階2Bでは別時計として校正する。保持は検知終了後もマイク取得を維持するという意味で、分析ループは終了する。

## PCで実際に確認した項目

Windows、同梱Playwrightから起動したヘッドレスMicrosoft Edge、localhost、マイク権限は自動化側で許可。fake media device/fileフラグは使用していない。入力APIは実getUserMedia。ブラウザの人手の許可ダイアログ操作は未確認。PCの音源/機器がiPhoneや店舗の伴奏を再現するわけではない。

| 項目 | 結果・条件 |
| --- | --- |
| 公式YouTube API・iframe | サンプル動画 `M7lc1UVf-VE` でCUED、BUFFERING、PLAYING、PAUSEDを受信。エラーなし |
| 実マイク | live track取得、48kHz、Context running、音声補正3項目falseを観測。RMSは約0.003台の入力を観測し、解放完了 |
| 保持設定 | しきい値0・継続0msで実入力からPLAYINGまで到達。保持中に一時停止→再開、停止後offとiframe削除 |
| 解放設定 | 同条件で検知→PLAYING後にマイクoff。一時停止→再開、停止後iframe削除 |
| 継続時間 | しきい値0.001・継続50msで初回超過→成立→play→PLAYINGを確認 |
| 模擬モード | 準備→模擬音→模擬PLAYING→停止を維持 |
| 390×844表示 | PC画面幅エミュレーションで横はみ出し・アプリJSエラーなし。iPhone検証ではない |

参考として保持/解放比較の各1試行で、play要求→PLAYINGイベントは約464ms/394ms、明示再開は約280ms/269msだった。50ms継続の別試行では約340ms。内部イベント間の値であり、実発音遅延でも同期ずれでもない。試行数が少なく、安定性・p95・±0.1秒目標の合否は評価していない。描画・計測負荷も段階2Bで記録する。

## 自動検査と未検証

`pnpm check`: 型検査、全72件（既存51件を無変更で維持＋adapter21件）、本番ビルド成功。新テストはcue先行再生禁止、IDなし状態通知、停止未確認、APIロード中取消、onReady前停止、権限拒否、resume失敗/未完了、入力中断、部分回収失敗、停止後の遅着stream等を検証する。PC確認時のonReady前API呼出し警告を受け、準備前はpauseVideoを呼ばず破棄で取消するよう修正した。frozen-lockfileによるオフライン整合確認も成功。node_modules/.pnpm-store/distはGit除外。

未検証: iPhone Safari、Bluetooth入出力・音質、初回の人手権限操作、長時間待機、自動再生ブロックの実環境再現、実動画の自然終了、実音の正確な開始位置、店舗の伴奏認識、実発音・同期精度。ブロック/ENDED/エラー/指定cue秒は模擬APIの自動テストで検証済み。実APIの成功例で全条件の成立を保証しない。

## 段階2BのHTTPS方法（提案のみ・未実施）

第一候補は **mkcert＋同一の信頼できるローカルWi-Fi＋Vite HTTPS**。無料ツールでローカルCAとPCのプライベートIP/DNS名をSANに含む証明書を用意し、iPhoneに公開CA証明書を入れて完全な信頼を有効にする。Viteのserver.httpsに証明書/鍵を設定し、承認したPCのLANアドレスだけへbindする。必要ならファイアウォールもプライベートネットワーク・検証ポートに限定する。公開ポート転送は不要。

導入、PC/iPhoneへの証明書信頼設定、LAN待受と到達性確認はユーザーの了承・端末操作が必要なので今回は行っていない。rootCA-key.pem等のCA秘密鍵は端末へコピーせず、Gitにも入れない。証明書の生成先・削除/信頼解除手順も設定時に決める。単に警告を無視した自己署名接続でマイクが使えるとは仮定しない。

比較候補はローカルのリバースプロキシ＋内部CA。TLS設定をViteから分離できる一方、追加プロセス・信頼設定が必要で初回はmkcert案を優先する。外部トンネルや静的公開は到達性が容易だが外部公開を伴うため、必要性を確認して別途承認を得た場合だけ検討する。現在はサービス接続・公開URL・証明書・費用を作っていない。

iPhoneのlocalhostはiPhone自身を指す。PCのHTTPプライベートIPへアクセスするだけではsecure contextの要件を満たさない。HTTPSが通っても、YouTubeの配信元識別・有音自動再生・Bluetooth経路が成立するかは改めて試験する。

公式資料（2026-10-18確認）:

- [YouTube IFrame API](https://developers.google.com/youtube/iframe_api_reference)
- [getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)、[AudioContext.resume](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/resume)
- [mkcert](https://github.com/FiloSottile/mkcert)、[Vite HTTPS設定](https://vite.dev/config/server-options.html#server-https)、[iPhoneの証明書信頼設定](https://support.apple.com/en-us/102390)
