# Chrome切替とYouTube Premiumの調査

確認日: 2026-10-25。対象はReact版SyncLab。旧HTML・プレイヤー・認証処理・保存形式は変更していない。

## Chrome起動

[Chromium公式資料](https://chromium.googlesource.com/chromium/src/+/main/docs/ios/opening_links.md)ではiOS Chrome用にHTTPのgooglechrome、HTTPSのgooglechromesスキームを定義している。SyncLabではユーザーがリンクを押した時だけ現在URLのスキームを置き換える。ページのサブパス・クエリ・フラグメントは維持する。

資料にあるインストール検出はネイティブiOSアプリ向けで、通常のWebページでは利用できない。起動成功・未導入をタイマーで断定しない。通常URLリンク・選択可能なURL欄・クリップボード失敗時の長押しコピーを常に代替として用意する。iPhoneでCriOSを識別した場合は再起動リンクを出さず「すでにChrome」と表示する。UA識別は補助であり、デスクトップ表示等で判定不能ならURLコピーを利用する。Android/PCではChrome専用スキームへ自動転送しない。

SafariとChromeのlocalStorageは自動共有しない。曲管理でJSONバックアップ→切替先で復元する。既存バックアップに含まれないリアルタイム補正履歴等の別保存領域も、自動移行されるとは説明しない。ブラウザ切替により保存データは削除しない。

## Premiumについて確認できたこと

- [YouTube公式ヘルプ「I see ads on YouTube videos」](https://support.google.com/youtube/answer/7437519?hl=en&co=GENIE.Platform%3DiOS)は、加入アカウントへのログイン、アプリ外再生時のログイン状態、埋込み動画でのYouTube Cookieを確認するよう案内している。Chrome自体のGoogleアカウントログインと、同ブラウザ内のYouTubeで加入アカウントが有効であることを同一視しない。
- 同ヘルプはクリエイターが動画に含める宣伝等までPremiumで消えるとは説明していない。PC向けCookie設定手順を、そのままiPhone用の解決手順として案内しない。
- [IFrame APIリファレンス](https://developers.google.com/youtube/iframe_api_reference)および[Player Parameters](https://developers.google.com/youtube/player_parameters)に、Premium加入状態の取得や広告なし再生を指定する公開APIは確認できなかった。SyncLabで加入状態を確認・強制反映する機能は実装しない。
- [YouTube Developer Policies III.I](https://developers.google.com/youtube/terms/developer-policies)は広告の改変・妨害・置換・ブロックを禁止している。広告のスキップ・削除・ブロック、独自のGoogleアカウントID/パスワード収集は実装しない。

## 推論と未確認事項

ログイン・Cookie・プライバシー設定が異なればSafariとChromeで広告表示が異なる可能性はある。ただし、今回調べた公式資料は「iPhone Chromeでログインすれば、SyncLabの第三者サイト内IFrameにも必ずPremiumが反映される」とは保証していない。SyncLabでの反映、Safariとの差、広告頻度は実機未検証。Chromeへの切替を広告なし再生の保証として案内しない。

規約に沿う選択肢は、YouTubeが提供するPremium特典を加入アカウントで通常利用すること。埋込み側で機能が反映されない場合は、公式YouTubeサイト/アプリで確認し公式サポートを利用する。公式サイト/アプリでの視聴はSyncLabの同期制御とは別になる。

## iPhone実機の確認手順（未実施）

1. Safariで曲のJSONバックアップを保存し、Chrome起動リンクを直接タップする。未導入/起動制限時は通常リンク・URL欄・コピー失敗時の案内を確認する。
2. Chromeでは切替不要表示と、必要な曲バックアップの復元を確認する。初回・再読込で音声検知欄が開き、閉じたまま数値編集や時刻更新をしても勝手に再展開しないことを確認する。
3. 同じ動画・アカウント・ネットワーク条件でSafari/Chromeを比較する。各ブラウザのYouTubeで加入状態を確認し、通常視聴とSyncLab埋込みを分けて広告の観測を記録する。広告を強制出現/スキップさせない。
4. 音検知・正負の補正・一時停止シーク・今合ってる・バックアップ復元・Bluetooth出力を既存の操作で確認する。IFrameのPLAYINGは実際のBluetooth発音時刻や同期成功の証明とはしない。
