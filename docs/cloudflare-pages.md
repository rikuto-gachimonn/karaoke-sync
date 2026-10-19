# Cloudflare Pages配信の準備と公開前確認

調査日: 2026-10-18。今回はローカル準備のみ。Cloudflareログイン・プロジェクト作成・アップロード・デプロイ・ドメイン設定は未実施。
この資料にある将来の外部操作は、公開範囲を決定しユーザーが明示承認した後にだけ行う。

## 結論と確認できた構成

現在のReactアプリは静的Pagesに適合する構成。サーバーAPI・SSR・DB・Pages Functionsは不要。
ただしCloudflare上・Access認証下・iPhone Safariでの実接続は未検証であり、実機での成立を保証するものではない。

| 項目 | 現在の値 |
| --- | --- |
| 作業ブランチ | feature/codex-karaokesync |
| ビルド | pnpm build（tsc --noEmit && vite build） |
| 出力 | dist（Viteの既定outDirを実際のビルドで確認） |
| Node | .node-version の24.19.0 |
| pnpm | package.jsonのpackageManager: pnpm@11.25.0 |
| フロントエンド | React 19.3.1 / TypeScript 7.0.2 / Vite 8.3.4 |
| エントリー | index.html（通常アプリ）、youtube-probe.html（検証①〜⑦） |
| ビルド成果物 | 2ページ、assets内JS/CSS、404.html、_headers。計9ファイル |
| 公開に不要 | src、node_modules、docs、scripts、旧HTML、README、tatus、.local-https、証明書、秘密鍵、バックアップJSON |

公式の[React/Vite用ビルド設定](https://developers.cloudflare.com/pages/configuration/build-configuration/)も静的出力distに対応している。
ビルドは通常モードで行う。dev:iphone、HTTPS用証明書、PCのLAN IPはCloudflare配信に不要。
Git連携を将来選ぶ場合、[ビルド環境の指定方法](https://developers.cloudflare.com/pages/configuration/build-image/)に従いNODE_VERSION=24.19.0、PNPM_VERSION=11.25.0を明示し、インストールログで両バージョンとlockfileの適用を確認する。
ローカルで依存を再インストールするならpnpm install --frozen-lockfileを使う。今回、依存追加・再インストール・lockfile変更は行っていない。

## 今回追加した配信設定

### public/_headers

- Referrer-Policy: strict-origin-when-cross-origin。既存HTMLの指定と整合し、YouTubeに配信元originを渡せる形を維持する。no-referrerへ変更しない。
- X-Content-Type-Options: nosniff。
- X-Robots-Tag: noindex, nofollow。検索掲載の抑止依頼であり、認証・非公開化ではない。
- Cache-Control: no-cache。再検証を求める値であり、保存を完全禁止するno-storeとは異なる。認証の代替ではない。

[Pagesの_headers仕様](https://developers.cloudflare.com/pages/configuration/headers/)に従いpublicからdistへコピーする。Cloudflare側で消費される制御ファイルであり、ファイル自体は配信しない想定。
CSP、Permissions-Policy、COEPは今回追加しない。未検証の許可リストやmicrophone=()、厳しい埋め込み制約でYouTube・マイクを壊すことを避けるため。
これは包括的なセキュリティ対策を完了したという意味ではない。将来導入する場合はYouTubeの動的スクリプト・iframe、Safariのマイク・再生を実機確認する。
Cloudflareダッシュボード側の追加ヘッダー・Transform Rules・Analytics等は今回未確認。公開後の実レスポンスも確認する。

### public/404.htmlと画面遷移

現在の画面遷移はReact内の折りたたみ操作と/?mode=simulationで、History APIのパス型ルーターは使っていない。
そのため/* /index.html 200の一律SPAフォールバックは追加しない。
明示的な404.htmlを置き、存在しないアセットやURLを通常アプリのHTMLへ黙って置き換えない。
[Pagesの標準SPA動作](https://developers.cloudflare.com/pages/configuration/serving-pages/)はトップレベル404.htmlの有無で異なる。
将来/about等のルーターを導入した場合にだけ、実アセット・検証ページを優先するフォールバックを設計し直す。
Pagesの.htmlから拡張子なしへの正規化などの挙動は、今回のローカル簡易サーバーでは完全再現していない。

## 認証付きテスト環境の選択

| 選択肢 | 利点 | 注意・推奨 |
| --- | --- | --- |
| 通常のpages.dev | 独自ドメイン不要、HTTPS配信 | URLを知っている人限定ではない。今回は選定・公開しない |
| pages.dev＋Cloudflare Access | 認証対象をメール等で制限可能、PCサーバー不要 | 個人テストの推奨候補。rootとプレビュー両方を保護する |
| 独自ドメイン＋Access | 利用URLを固定しやすい | ドメイン所有・費用・設定が追加。最初の検証では必須にしない |
| フロントエンドの合言葉画面／noindexのみ | 簡単に見える | 配信済みJSやURLを保護できず認証の代替にならない。採用しない |

[Accessの選択肢](https://www.cloudflare.com/products/access/)と[料金ページ](https://www.cloudflare.com/plans/zero-trust-services/)を参照。無料プランの対象・上限・必要な契約情報は利用開始時にユーザーが確認し、有料プランや有料ドメインを自動選択しない。
[メールのワンタイムPIN](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)を使う場合も、Allow対象は本人の特定メールアドレス等に限定する。EveryoneやBypassを設定しない。
認証はCloudflare側で行い、APIトークン・メールのPIN・パスワードをVITE_変数や配信JSへ埋め込まない。

### Accessの保護範囲

[プレビューの公式資料](https://developers.cloudflare.com/pages/configuration/preview-deployments/)ではプレビューURLも初期状態は公開とされる。
プレビューだけを保護して本番ホストを開けたままにしない。
[pages.dev本番まで保護する公式手順](https://developers.cloudflare.com/pages/platform/known-issues/#enable-access-on-your-pagesdev-domain)に従い、Pages SettingsでAccessを有効化し、作成されたAccessアプリのPublic hostnameを調整して本番ホストも対象にする。
ワイルドカードを外して本番用とした後は、プレビュー用ポリシーを再作成し、本番と*.<project>.pages.devの両方にポリシーがあることを確認する。
独自ドメインを追加する場合は、そのホストにも別途Self-hostedのAccessアプリとポリシーを設定する。
具体的な画面名称・空プロジェクト時の可否はダッシュボード未確認。ホスト名の保護範囲を画面と匿名アクセスで確認してから実アプリを載せる。

## 安全な初回デプロイ手順（将来・未実施）

今回の作業では、以下のログインや外部操作は実行していない。

1. ユーザーが公開URLでよいか、Access付きで制限するかを決定する。認証付きが推奨。将来の外部操作を明示承認する。
2. 現在の同一オリジンで曲・全利用環境の必要な設定を保存し、v3バックアップを取得する。診断JSONは別物なので区別する。
3. ローカルでpnpm check、pnpm pages:checkを実行し、出力一覧を確認する。アップロード対象はdistの中身だけ。
4. 初期段階はGit連携の自動公開より[Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/)を推奨する。今はコードが未コミットであり、Git連携には別途コミット・pushの承認が必要。
5. 認証付きの場合は、実アプリをアップロードする前に空のPagesプロジェクトを作成し、Accessで本番・プレビューを保護できるか確認する。公式にはWranglerで空プロジェクトを作る方法があるが、今回はWranglerを導入・実行していない。
6. 空プロジェクトではAccess設定ができない等の場合、実アプリを先に公開しない。非機密のプレースホルダーを使う段取りへ変更するか、別方式をユーザーと決める。プレースホルダーの外部公開も別途承認が必要。
7. 設定後、未ログインの別ブラウザ／プライベートタブから、本番ホストと利用予定のプレビューホストの保護を確認する。後者は最初の実際のURLができた時点でも再確認する。
8. 本人がダッシュボードでDirect Uploadを行い、distだけを選んで内容を最終確認する。「Deploy」「Save and Deploy」は外部公開の操作なので、今回の準備では押さない。
9. その後の承認済み公開では、ダッシュボードに表示された実際の本番URL・デプロイID・公開日・ビルド時のバージョンを記録する。ここには未作成URLや架空の成功記録を置かない。
10. 匿名アクセスでHTMLと/assets内JS/CSSが認証で拒否され、本人だけが取得できることを確認する。検証ページ/youtube-probeも保護する。Access対象ホストの漏れがあれば実験を停止する。

空プロジェクト・Accessの事前設定可否は今回の調査だけでは確定しない。設定完了前の実アプリの一時公開を安全とみなさない。
Direct UploadとGit連携は後から自由に切り替えられると仮定せず、公式制約を確認してプロジェクト方式を選ぶ。
将来Git連携を採用する場合の設定は、ルート=このプロジェクト、ビルドコマンド=pnpm build、出力=dist、上記Node/pnpm指定。今回はデプロイ用スクリプトや自動公開CIを追加していない。

## iPhoneでPCなしで利用する手順（公開・認証確認後）

1. Safariで固定した本番HTTPS URLを開く。プレビューのハッシュURLを普段使いの保存先にしない。
2. Accessを使うなら本人のメール／IDプロバイダーで認証する。Safariのプライベートモードを常用保存先にしない。
3. Bluetoothイヤホンを接続して出力先を確認する。店舗Wi-Fiまたはモバイル回線からPagesとYouTubeへ接続できることを確認する。
4. バックアップを復元し、曲と利用環境を選ぶ。
5. 通常の事前再生手順で準備する。最初のマイク要求時にSafariで許可する。拒否した場合は、そのWebサイトのマイク設定とiOS側のSafari権限を確認して再試行する。
6. HTTPSであることは必要条件で、許可やAudioContext起動・自動再生の成功保証ではない。証明書警告が出たら回避して進まず、配信設定を確認する。mkcertのCA追加はPages配信では不要。
7. 待機中の無音、メーター、入力元の報告名を確認する。名前が不明なら本体マイクと断定しない。
8. 検知／手動開始後にPLAYING、実際のイヤホン音、出力先、音質、音声ループの有無を別々に確認する。
9. 異常時はすべて停止し、保持／解放の設定と端末の出力先を見直す。保持が全端末で最適とはしない。
10. 画面をつけたまま使用する。画面非表示で停止する現仕様を維持しており、バックグラウンド再生・オフライン動作・PWAインストールは追加していない。

一度配信済みなら利用時のPC開発サーバーは不要。ただしインターネット、CloudflareとYouTubeへの到達、Safariの権限・再生条件は必要。

## 曲・同期設定の移行

localStorageはブラウザ・プロファイル・オリジン（scheme/host/port）ごとに別領域。
LANのhttps://PC-IP:5173、本番pages.dev、プレビューホスト、独自ドメイン、PCとiPhoneはそれぞれ保存を共有しない。
パスが変わるだけでは同一オリジンだが、ホスト・ポート・HTTP/HTTPSが変わると別領域。既存曲や設定は自動移行されない。

1. 元のURL・元のブラウザで曲を選び、DAM／JOYSOUND／自宅テストの編集済み設定をそれぞれ保存する。
2. 手入力だけの動画は曲として登録し、設定を曲リストに含める。手入力専用preferences、未保存の編集、測定結果は曲リストJSONの対象外。
3. 曲管理の「曲リストと保存済み同期設定をJSONで保存」でv3を取得する。必要なら診断・比較JSONを別に保存する。
4. バックアップは本人が安全な方法でiPhoneの「ファイル」へ置く。今回は転送・クラウドアップロードを行っていない。
5. 新しい固定URLで曲管理からJSONを選び、プレビューを確認して新規曲・曲情報・各環境設定の上書きを明示選択し復元する。
6. 曲数、動画ID、開始トリガー、各開始位置、4段階調整値、しきい値、待機期限、保持方針を比較し、数曲で検証する。
7. 元のlocalStorageと元JSONは残す。新URLから旧URLのlocalStorageを直接読み取ることはできない。「このオリジンの旧localStorage」取込も別オリジンを横断しない。

曲情報・設定はv3キーを使い、v3未作成時のみ同一オリジン内のv2/v1を読み取る仕様。旧HTML0.6／Reactv1/v2のバックアップもプレビュー経由で取り込める。
URLを将来変更するときも同じ手順。Safariのサイトデータ削除・プライベートモード終了・端末交換・容量制約で失う可能性があるため、JSONを定期保存する。
AccessのログインユーザーごとにlocalStorageが分割される機能はない。同じ端末・ブラウザプロファイル・オリジンを複数人が使えばデータを共有し得る。Accessは保存データの暗号化ではない。

## 公開・プライバシーの調査結果

- ブラウザ実装でマイクはgetUserMedia→AudioContext→AnalyserのRMS観測に使い、destinationへ接続しない。
- 調査したsrcには録音のMediaRecorder、音声アップロード用fetch/WebSocket/sendBeacon等の実装はない。RMS統計はメモリ・診断JSONに入り、生PCMは保存しない。
- アプリコードがマイク音声を外部送信する経路は確認していない。ただし第三者YouTube API・ブラウザ・OS内部を完全監査したという意味ではない。
- YouTubeのスクリプト・iframe・映像取得は外部通信。動画ID、配信元origin、IP、Cookie等がYouTube側へ伝わり得る。Cloudflareも配信の通信情報を扱い、Access利用時には認証情報・アクセス記録を扱う。
- 曲リスト・同期設定はブラウザ内に保存され、サーバー同期・Cloudflare KV/D1等は実装していない。別人が公開サイトを開いても本人のブラウザ内データがそのまま見える構成ではない。
- 診断JSONにはUser-Agent、動画ID、利用環境、時刻、設定、マイク報告名が含まれる。機器名に所有者の名前が含まれる場合があり、共有前に不要な名前や環境情報を削除・伏せ字化する。今回、既存ログ仕様の変更・匿名化は行っていない。
- 曲リストJSONには曲名・アーティスト・動画ID・伴奏URL・開始位置等の嗜好や設定が含まれる。暗号化されないため、公開リポジトリ・dist・公開URL・第三者へそのまま置かない。
- クライアントの秘密情報を守る方法としてVITE_環境変数は使えない。Cloudflare APIトークン・Access秘密鍵・PIN等は配信物へ含めない。今回のクライアントはそれらを要求しない。
- 今回の代表的なキー／秘密鍵パターン検査でsrc・HTML・設定・distに検出はなかった。ただし未知形式・難読化・OS環境・依存全体を完全監査するものではない。
- ダッシュボードでAnalytics、Zaraz等を有効にすると通信が増える可能性がある。今回設定していないため、利用開始時に不要なものを無効のままにする。

## 公開後の確認表

- 全ホストの未認証アクセスでHTML／JS／CSS／検証ページを取得できないこと。
- 本人のSafariでトップ、再読込、模擬モード、検証ページ、アセットのContent-Typeと404を確認すること。
- 最終HTTPレスポンスのReferrer-Policy、追加CSP／Permissions-Policyの有無、YouTube onErrorコードを確認すること。
- マイク許可・拒否・再試行、AudioContext起動、4秒測定、メーター・提案と保存を確認すること。
- 4トリガー、事前再生・自動一時停止、固定待機、初回再生要求、PLAYING、停止・曲変更・タイムアウトを確認すること。
- Bluetooth出力先、無音・音質低下・ループ、保持／解放差を観察すること。
- 曲・全環境のv3保存、再読込後の復元、バックアップ・プレビュー取込を確認すること。
- APIのPLAYINGやHTTPS到達だけを実発音・同期精度の成功と扱わないこと。

## ロールバック

公開前に、検証済みのdistコピーと対応するコード控え、依存lockfile、ビルド日時をPC内へ保存する。バックアップJSONは配信物と別に管理する。
既存の本番デプロイがある場合は[Pagesのロールバック](https://developers.cloudflare.com/pages/configuration/rollbacks/)手順で、既知の本番デプロイへ戻す。プレビューをそのままロールバック先にできるとは仮定しない。
初回公開で過去の本番がない場合は戻す先がない。Accessを制限したまま配信停止・修正版の承認を検討する。
アセットのロールバックではlocalStorage・Accessポリシー・ドメイン設定・データ形式は戻らない。先にJSONを退避し、旧アプリでv3を読めると仮定しない。
設定事故で認証が漏れた場合は先にアクセスを閉じる。プロジェクト削除・公開停止・再デプロイも外部操作なので、別途ユーザーの指示で行う。

## ローカル検証と限界

実行: pnpm check、その後node --experimental-strip-types scripts/check-pages.ts。追加したpnpm pages:checkでもビルド＋同じ静的検査を一括実行できる。
既存423件＋追加16件=439件成功。型検査・本番ビルド成功。distは9ファイル。実HTTPを127.0.0.1に限定して20項目検証後、サーバー停止。
静的検査は自身の簡易HTTPハンドラーで現在の_headersの/*ルールを適用する。Cloudflareのエッジ、Access、.html正規化、TLS、Safari、YouTube接続のエミュレーターではない。
Vite previewは_headersをCloudflareと同じようには適用しないため、ヘッダー確認には今回のローカル検査を使う。必要ならUIの静的表示はpnpm previewで手動確認し、終了後に停止する。

検査内容: 配信許可ファイル、秘密鍵・代表トークン形式、ビルド済みJS/CSS参照、dev参照の残留、Referrer、媒体を止める未検証ポリシーの不在、トップ/query/probe/404/非配信ファイル/パストラバーサル。
secretPatternFindings=0はパターン検査の範囲内での結果。隠れたあらゆる秘密情報が絶対ないという保証ではない。
実機・実サービス未確認: Cloudflare上のビルド、初回Access設定、無料プラン適用、認証動作、TLS、iPhone Safariのマイク・Bluetooth・実発音・同期精度。

## 変更ファイル

- public/_headers、public/404.html: 最小配信設定。
- scripts/pages-audit.ts、scripts/check-pages.ts: ローカル専用検査。外部接続・デプロイ機能はない。
- tests/pages.test.ts: 追加16件。
- package.json: pages:checkを追加。既存buildスクリプト・依存は変更しない。
- docs/cloudflare-pages.md: 本資料。

既存ソース、YouTube・マイク制御、検証ページ①〜⑦、旧HTML、README、tatus、ユーザーデータは変更していない。
変更前の控え: .local-https/recovery-before-pages-20261018（Git除外領域）。main変更・commit・push・merge・外部公開は行っていない。
