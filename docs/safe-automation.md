# 低リスクPRの承認付き自動マージとPages

## 今回の状態

今回のPRはChrome外部起動・GitHub Actions/権限設定を含むため、手動確認・手動マージ専用。自動マージの実行・mainへの直接push・デプロイは行っていない。

2026-10-25のGitHub連携によるリポジトリ情報は `allow_auto_merge: false`。連携にはリポジトリ設定/ruleset変更のツールがなく、シェルGitHub接続も環境のプロキシ接続エラーのため利用できない。rulesetの現状は未確認で、設定変更も行っていない。以下の設定が完了するまで自動マージが使える状態とは扱わない。

## 構成と範囲

- `ci.yml`: main向けPRで `Test`、`Typecheck`、`Build` を実行する。Buildは本番ビルドとローカル配信物チェックも実施。全ジョブcontents:readのみ、PRで書込みトークン/外部シークレットを使わない。
- `low-risk-merge.yml`: main上のworkflow_dispatchのみ。PR番号と承認済みの40桁head SHAを指定した1回限りの許可。write以上の権限者による実行が必要。ラベルやPR本文では許可できない。
- 対象は、既存 `src/ui/styles.css` だけの200行以内の変更。追加・削除・リネーム、パッチ欠落、複数ファイル、外部参照・CSSエスケープ等は拒否。TSXにはイベントハンドラーや保存処理が混在するため、配置・文言変更でも自動判定できなければ手動確認する。対象拡大は別途手動レビューが必要。
- 信頼するmainのスクリプトだけを実行し、PRのコードはcheckout/実行しない。実効rulesetの必須チェック、コードオーナーレビュー/古い承認破棄、最新mainとの整合、対象PR/正確なSHAに紐づく最新のCI実行と3ジョブ成功を確認する。API失敗や不明な状態は拒否する。
- GitHub標準のマージAPIにhead SHAを渡す。GitHubの必須チェック/レビューは回避しない。SHAが変われば許可は失効し、新しい承認・CIが必要。ネイティブAuto-mergeの永続許可は使わないため、後からのpushまで許可が持ち越されない。リポジトリのAllow auto-mergeは無効のままで運用できる。
- 許可済みコミットでもチェック未完了時は待機マージを予約せず拒否。チェック成功後に再実行する。この保守的な方式は、すべてのPRを無条件でマージするものではない。
- マージジョブだけcontents:write / pull-requests:write / actions:read。PRの依存パッケージはインストールしない。後続ジョブだけactions:writeで既存 `pages.yml` をmainへ明示dispatchする。GITHUB_TOKENの変更がpushワークフローを再発火しない制約を標準のworkflow_dispatchで処理し、PATや外部秘密鍵を追加しない。
- 普通の手動マージは既存のmain push→Pagesを使う。Pagesのbuild/deployは引き続きmain限定で、検証成功後にdistだけを公開する。自動マージ経由の明示dispatchでも同じ処理を使う。

## GitHubで必要な初回設定（管理者）

1. 今回のPRを手動レビューし、GitHubのPR checksの3ジョブが成功してから手動でマージする。今回のPRを低リスク承認ワークフローへ渡さない。ワークフロー・外部API機能を含むので判定でも拒否される。
2. Settings → Rules → Rulesets → New branch ruleset。名前 `main-required-checks`、Enforcement **Active**、Target branchesに `main` を指定。Bypass listは空（GitHub Actionsや管理者のバイパスも追加しない）。
3. Require a pull request before mergingを有効化。Require review from Code OwnersとDismiss stale pull request approvals when new commits are pushedを有効化する。`.github/CODEOWNERS` によりワークフロー・権限・信頼するスクリプト・依存関係変更はオーナーレビュー対象とし、PR内の変更だけで承認させない。必要なレビュー人数は運用に合わせる（CSSだけは0、全PRに第三者レビューを求めるなら1以上）。GitHubのUI/プランで0とコードオーナー必須を併用できない場合は1以上とし、レビューを省略する回避は行わない。Require status checks to passを有効化し、最近実行された `Test`、`Typecheck`、`Build` を追加。各チェックの発行元は **GitHub Actions** に限定（App ID 15368）。Require branches to be up to date before mergingも有効化する。必要チェックが候補に出なければ、CIを実行してから再設定する。
4. rulesetを保存。スクリプトは `/rules/branches/main` で実効ルールを確認するため、旧来のブランチ保護だけでは承認しない。mainの削除・force pushも許可しない設定を推奨。既存のより厳しいルールを緩めない。
5. Settings → General → Pull Requestsでsquash mergeが許可されていることを確認（調査時は許可済み）。ネイティブのAllow auto-mergeを有効にする必要はない。もし別経路でネイティブAuto-mergeを許可するなら、本ワークフローのCSS判定はその別経路には適用されないため、各PRを人がレビューする。
6. Settings → Environmentsで `low-risk-automerge` を作成し、Deployment branches and tagsをSelected branches and tags → `main` のみにする。PR作成者がオーナー本人の場合、GitHubは自分のPR承認を認めないので、今後のワークフロー変更等には別の信頼できるCode Ownerとレビュー担当者が必要になる。レビュー要件を無効化して自動化することはしない。
7. Settings → Actions → Generalで上記ワークフローのジョブ別権限が組織/リポジトリポリシーに許可されていることを確認。既定トークン権限を一括writeへ変更せず、「Allow GitHub Actions to create and approve pull requests」は有効にしない。Settings → Pagesは既存のGitHub Actions方式を維持する。

## 以降の利用

Codexへの依頼時に「このPRのCSS変更を自動マージ対象として許可する」と範囲を明示し、対象差分とチェック成功を確認する。Actions → **Approve low-risk CSS PR** → Run workflow → branch **main** → PR番号と確認済みhead SHAを指定する。GitHub CLIが正規認証済みの環境なら次の操作でも同じ承認ができる（新しいPATは不要）。

```sh
gh workflow run low-risk-merge.yml --ref main -f pr_number=123 -f approved_head_sha=<確認済みの40桁SHA>
```

本セッションの公式GitHub連携にはworkflow_dispatchツールがないため、将来も同じツール構成ならActions画面でのこの許可操作が1回必要。毎PRの手動マージ自体は不要だが、PR単位の許可を省略する完全無操作運用ではない。ユーザーが許可していないPRは実行しない。

## 失敗・通知・復旧

- チェック失敗・高リスク差分・権限不足・保護未設定・SHA変更ではマージしない。Actionsログ/Job summaryが理由を示す。承認workflowは自動リトライや強制マージをしない。
- マージ済みでもPagesのdispatch/ビルド/デプロイが失敗する可能性がある。自動マージ側で同じマージSHAのdispatch runを特定して完了まで監視し、失敗・特定不能・タイムアウトなら元の承認workflowも失敗させる。summaryにPages runへのリンクを残し、Pagesの `report` ジョブにもbuild/deployの結果を残す。mainが同時更新されrunを特定できない場合も成功とは表示しない。
- 自動マージ後のデプロイ失敗はmainを自動巻戻ししない。GitHub Pagesで新しい版の公開が確認されるまでは、従来の公開版が継続する可能性がある。ActionsのPages runで失敗ステップを調べ、修正PRまたは許可した再実行で復旧する。
- GitHub Settings → Notifications → ActionsでWeb/Email通知と失敗通知を設定する。公式通知は主に自分が起動したrunが対象で、Bot経由のPages run単体が所有者へ必ずメールされるとは保証できないが、承認workflowもPages失敗を引き継ぐ。通知が届かない場合は承認workflowのsummaryからPages runを確認する。外部通知サービスへの送信は追加していない。
- ローカルの自動テストでは拒否条件とマージAPIのSHA引数を検査する。本番の自動マージ/デプロイの実行検証は、今回の禁止事項を守るため未実施。

## 公式資料

- [GitHub Auto-merge](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-auto-merge-for-pull-requests-in-your-repository)
- [Rulesetsのルール](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
- [GitHubのマージAPI](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request)
- [GITHUB_TOKENのイベント制約](https://docs.github.com/en/actions/concepts/security/github_token)
- [Actions通知](https://docs.github.com/en/actions/concepts/workflows-and-actions/notifications-for-workflow-runs)

## 今回の検証結果

- `pnpm check`: 全735テスト・型検査・本番ビルド成功。追加42件、既存テストは表示順・ラベルの期待値だけ更新。
- Chromiumの390px/320px相当の画面で18項目を確認。初期展開・手動折りたたみ・再描画後の閉状態維持・再読込時再展開、表示順、ボタンサイズ、赤字/等幅時刻、横スクロールなし、iPhone UAのChromeスキーム、CriOSの切替回避、コピー拒否時の案内、模擬音声の検知・メーター・時刻・停止を確認。iPhone実機の検証ではない。
- `scripts/check-pages.ts`: ローカルHTTP検証23件、旧HTML byte-identical、secret pattern findings 0。実サイトへのデプロイは実施していない。
- ワークフロー3ファイルのYAML構文と `git diff --check` 成功。GitHub上での権限・保護ルール・自動マージ・デプロイ実行は今回未検証。
