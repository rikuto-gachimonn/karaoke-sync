# Ver.1.0向け動画入力・スマホUI改善

## 操作の変更

- 曲管理の新規登録・既存曲編集で「YouTube URLまたは動画ID」を入力できる。
- 対応: youtu.be共有、youtube.com/www.youtube.com/m.youtube.comのwatch?v=、embed、shorts、live、および11文字ID。
- URL APIでホスト・プロトコル・パス・IDを検証し、共有・再生リスト・時刻パラメーターは無視する。再生位置への自動変換はしない。
- 抽出IDを入力欄の下に表示する。形式が正しくても動画の実在・埋め込み可否は保証しない。
- 同一動画IDの新規登録は、登録済み曲名付きの通知と、その曲を選択するボタンを登録ボタン近くに表示する。保存・上書きは行わない。
- 同一IDの既存曲編集は重複とせず更新する。別動画への変更は従来の確認を維持し、各環境の同期設定を引き継ぐ。
- 新規成功は「登録しました」、編集成功は「曲情報を更新しました」と表示する。
- 詳細設定の手入力動画もURLに対応。「この動画を使用」で確定し、確定前は選択中の動画を変更しない。同じIDなら曲選択・同期設定を維持する。別IDへ手入力で切り替える場合は曲選択を解除する従来仕様を維持する。

## メイン画面

- 「検知を準備」「すべて停止」をセッションの先頭2操作として維持。
- 一時停止・再生は開発者向け設定へ移動。内部の制御や状態ごとの有効／無効条件は維持する。
- 手動トリガーの「この位置から開始」も維持し、主要2ボタンの次に配置する。
- 主操作の直後に曲選択・詳細設定・曲管理・診断の導線を置く。
- 実効開始位置は初期収納のdetailsへ変更。summaryに現在値を常時表示し、全4段階のボタンはDOMに保持する。開閉で設定の書換え・保存・プレイヤー再生成は行わない。
- 保存・復元などの通知は収納欄の外に置き、閉じていても確認できるようにした。
- ネイティブsummaryのクリック・Enter操作を利用し、48px以上の見出し領域と既存のフォーカス表示を維持する。

## エラー案内

[YouTube IFrame API公式のonError分類](https://developers.google.com/youtube/iframe_api_reference#Events)に基づき、2/5/100/101/150/153を日本語表示する。
101と150は所有者設定等による埋め込み制限の可能性を伝える。150だけで入力やNetlifyの障害と断定しない。
失敗した試行の動画IDと元動画を開くリンク、停止後の再読み込み・再選択・別動画の利用を案内する。
元動画で再生できても埋め込み再生の保証にはならない。エラーのイベント型・停止・復帰処理は変更せず、制限回避は行わない。

## 保存と保護

保存するvideoIdは従来どおり11文字。v3キー・JSON形式、v2/v1/旧HTML0.6からの取り込みに変更はない。
曲・DAM／JOYSOUND／HOMEごとの設定、4トリガー、校正・メーター、事前再生・音検知・同期補正を維持する。
既存未コミットコードは .local-https/recovery-before-v1-ui-20261019 にコピーした。Git除外領域であり配信物には含まれない。
ブラウザ操作は既存データと別の127.0.0.1:5187で行い、検証用の曲だけを登録した。既存URLの保存済みデータは操作していない。

## 最終検証

- pnpm.cmd test: 492成功、0失敗（従来439件を維持し、配置変更に対応する2件を更新、53件追加）。
- pnpm.cmd typecheck: 成功。
- pnpm.cmd build: 成功。
- ローカル静的HTTP検査: 20項目成功、代表的秘密情報パターン0件。
- PC内蔵ブラウザの390px/320px幅で横はみ出しなし、URL登録、重複通知、同一ID編集、10ms変更後の収納・再展開、Enter操作、詳細設定での同一URL確定を確認。
- 確認用ブラウザのviewport設定を解除してタブを閉じ、開発サーバーと静的検査サーバーを停止した。

iPhone Safari実機でのタップ・ソフトキーボード・ファイル復元・事前再生・マイク・Bluetooth実発音は今回未確認。
動画の実在・埋め込み可否のオンライン検査は追加せず、正式IFrame APIの実再生で確認する仕様を維持する。
Netlify再デプロイ、Cloudflare公開、GitHub push、mainへのマージは行っていない。

## 変更ファイル

- src/youtube/videoReference.ts: 標準URL APIによるID抽出。
- src/youtube/errors.ts: エラー文の生成。
- src/library/songDraft.ts: 保存前の正規化と重複検査、新規／編集の区別。
- src/ui/VideoReferenceInput.tsx / ManualVideoInput.tsx / YouTubeErrorHelp.tsx: 入力確認・明示確定・エラー案内。
- src/ui/SongLibraryPanel.tsx: URL登録・編集、明確な登録結果と重複選択導線。
- src/ui/App.tsx / styles.css: 補助操作の移動、収納式調整、短い導線とレスポンシブ調整。
- src/adapters/youtube/player.ts: onErrorの説明生成だけを変更。
- tests/video-registration.test.ts: URL・登録・重複・編集・エラー・UIの追加テスト。
- tests/adapters.test.ts: 実adapterのonError変換の追加回帰テスト。
- tests/ui-layout.test.ts / settings-usability.test.ts: 意図した画面配置への期待を更新。
- docs/v1-ui.md: 本資料。

旧HTML、README、tatus、検証ページ①〜⑦、マイクアダプター、セッション制御、保存データ、依存パッケージは変更していない。
