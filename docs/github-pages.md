# GitHub PagesでReact版と旧HTML版を共存させる

## 今回の作業範囲（2026-10-20）

feature/codex-karaokesync上で設定・ワークフロー・テストを作成した。GitHubへのpush、mainへのマージ、Actionsの起動、Pages設定変更、公開デプロイは行っていない。未追跡のtatusと既存のもう1つのファイルは保持した。

変更前のvite.config.ts・package.json・pnpm-lock.yaml・src/scripts/tests/publicは .local-https/recovery-before-github-pages-20261020 にコピーした。旧HTML・README・tatusは変更せず、ハッシュでも一致を確認する。

## 配信URLと成果物

| 内容 | 公開予定URL |
|---|---|
| React通常アプリ | https://rikuto-gachimonn.github.io/karaoke-sync/ |
| 従来の旧HTML | https://rikuto-gachimonn.github.io/karaoke-sync/karaoke_sync_test.html |
| 検証ページ①〜⑦ | https://rikuto-gachimonn.github.io/karaoke-sync/youtube-probe.html |

Viteのbaseは /karaoke-sync/。pnpm.cmd buildの出力先はdist。GitHubのLinuxランナー上ではpnpm buildを実行する。

ビルド時に元のkaraoke_sync_test.htmlをアセットとしてそのまま出力する。旧HTMLをReactの入口へ書き換えたり、ViteのHTML変換へ通したりしない。旧HTMLはYouTubeの外部スクリプト以外にローカル配信依存がなく、元のファイル名のまま共存できる。

配信対象はdistだけ。src、README、docs、秘密鍵、ローカル証明書、バックアップ、tatusなどをアップロードしない。リポジトリ全体をそのまま公開する以前の方式とは異なり、成果物に含めたページ以外のリポジトリ内ファイルは配信されなくなる。

アプリ内の実／模擬モード切替はViteのBASE_URLを利用する。404の戻り先もプロジェクトURLへ変更。React Router等のパス型画面遷移は使っておらず、通常の操作は同一ページとqueryなのでSPA用の全URL書換えは追加しない。

## ワークフロー

.github/workflows/pages.yml は次を実行する。

1. mainへのpush、またはmainを選んだ手動実行で開始する。featureブランチからの手動実行ではbuild/deployをスキップする。
2. .node-versionのNode.js、pnpm 11.25.0をセットアップする。
3. pnpm install --frozen-lockfileで依存を導入する。
4. テスト→型検査→本番ビルド→成果物／ローカルHTTP検査を実行する。
5. distだけをPagesアーティファクトへアップロードする。
6. build成功後のdeployジョブだけがpages:writeとid-token:writeを持ち、github-pages環境へ公開する。

個別のPATやデプロイ用秘密鍵は不要。GitHub標準のGITHUB_TOKEN/OIDCを使う。並行デプロイを制限し、実行中の公開処理を途中でキャンセルしない設定にした。GitHub上での実ワークフロー実行・環境ルール・利用枠は今回は未確認。

## ユーザーが公開する際の手順

**ここからは将来公開するときにユーザーが行う操作。今回は実施していない。**

1. 変更をレビューし、必要な曲リスト・同期設定をJSONへバックアップする。公開前のGitリビジョンや利用中の旧HTML URLも控える。
2. GitHubのrikuto-gachimonn/karaoke-sync → Settings → Pages → Build and deploymentを開く。
3. Sourceを現在のDeploy from a branchからGitHub Actionsへ変更する。main・/(root)の指定による配信ではなく、Actionsで生成するdistが公開元になる。
4. 公開する意思を確認したうえで今回の変更をpushし、mainへ反映する。**mainへのpushで自動デプロイが起動する。** featureへのpushだけでは公開しない。
5. ActionsでBuild and deploy KaraokeSync to GitHub Pagesを開き、build・deployの成功を確認する。既にmainへ反映している場合は、Source切替後にRun workflowでmainを選んで実行する。
6. github-pages環境の承認待ちになった場合は既存の保護ルールに従って承認する。mainの公開を許すルールになっているか確認する。
7. Settings → PagesでHTTPSが有効なことを確認し、上記3URLを開く。Source切替・初回デプロイの間に一時的な反映遅延やエラーが起こり得るため、利用中でない時間帯に切り替える。

Sourceがbranchのままでは、リポジトリに置いたReactソースをそのまま公開しても本番ビルドとして動作しない。設定切替前に起動して失敗したワークフローは、切替後にmainで再実行する。

## 既存サイト・データへの影響

- React版がプロジェクトURLの入口になる。旧版の直接URLは維持する。ユーザーは旧版へのブックマークをそのまま使える。
- 旧版とReact版は同じgithub.ioのoriginを使う。localStorageはパス別ではなくorigin単位なので既存保存領域自体は変わらない。旧版のsong_list/sync_*/song_info_*/detect_settings_*と、React版のkaraokesync.app.*は別のキーを使う。今回その保存処理を変更していない。
- 旧曲情報をReactへ移す場合は既存の旧形式JSONインポート、または同origin旧localStorageの手動プレビューを利用する。自動削除・自動上書きはしない。
- Netlifyやlocalhostのデータは別originなので自動では移らない。元の環境でJSONを書き出し、新しいURL側でプレビューして復元する。
- 同じgithub.ioホストの他プロジェクトともoriginは共通である。リポジトリのパスによる保存データの隔離はない。
- Netlifyの現在の公開内容やPrivateアクセス設定は変更していない。GitHub Pagesへその認証設定が引き継がれるわけではない。一般的なGitHub Pagesは公開サイトなので、URLを知っている人だけに限定する仕組みとは扱わない。
- 今回のdistはGitHubのプロジェクト配下用。Netlify等のルートへそのまま再デプロイしない。別配信先でルート配信する場合はbaseと404リンクを別途合わせる。

## YouTube・マイク・iPhone

HTTPSの通常ページから既存の公式IFrame APIを読み込む。originパラメーターはwindow.location.originのままにし、リポジトリのパスを混ぜない。既存のReferrerメタ指定を維持する。CSP・Permissions-Policy等の制限は追加しない。public/_headersはGitHub Pagesではカスタムヘッダーとして適用されない。

マイクはHTTPSのセキュアコンテキストとユーザーの許可が必要。新originでは許可を再確認する。動画の埋め込み制限・Safariの再生制限・Bluetoothの出力経路はホスティングだけでは解決しない。

公開後、iPhone Safariで以下を確認すること（現時点では未検証）。

- React版・旧HTML・検証ページが各URLで開く。
- YouTube内の直接手動再生、事前再生、自動一時停止、検知後再開が動く。
- マイク許可、音量メーター、検知、全停止時の解放が動く。
- Bluetooth出力・音切れ・ループ・同期精度を実際の音で確認する。
- 曲・環境別保存、再読込、バックアップ復元と、旧版の既存曲が保持される。

## 検証結果

- pnpm.cmd test：625件成功、失敗0（既存606件＋追加19件）。旧HTMLの公開禁止だった期待は今回の共存要件に合わせて更新し、そのテスト自体は維持した。
- pnpm.cmd typecheck：成功。
- pnpm.cmd build：成功。
- scripts/check-pages.ts：/karaoke-sync/配下のローカルHTTP検証23件成功、旧HTMLはバイト一致、秘密情報パターン検出0。検証サーバーは終了時に自動停止した。
- これらはローカル成果物の検査。GitHub Pages上での実HTTP応答・Actionsジョブ・iPhone・YouTube再生・Bluetoothの成功を示すものではない。ローカル検査では_headersを便宜的に適用するが、GitHubのヘッダーを再現するものではない。

## ロールバック

以前の動作するコミットへmainの内容を戻してワークフローを再実行する場合は、ビルド構成と旧HTMLを含む成果物が揃ったリビジョンを使う。公開Sourceを元のDeploy from a branch / main / /(root)へ戻す場合は、mainのルートに旧HTMLが残っていることを確認する。その方式ではReactソースがそのまま本番動作するわけではない。どちらの操作も今回は行わない。

## 主な変更ファイル

- .github/workflows/pages.yml：main限定の検証・ビルド・公開。
- vite.config.ts：baseと旧HTMLの無変換出力。
- src/ui/App.tsx：BASE_URLを用いたモード切替リンクのみ。
- public/404.html：プロジェクト配下への戻り先。
- scripts/pages-audit.ts、scripts/check-pages.ts：サブパス・旧HTML・公開対象・バイト一致の検査。
- tests/pages.test.ts、tests/github-pages.test.ts：共存とサブパスの回帰テスト。

参照：[ViteのGitHub Pages手順](https://vite.dev/guide/static-deploy.html#github-pages)、[GitHubのカスタムワークフロー](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)、[GitHub Pagesサイトの作成と公開範囲](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site)。
