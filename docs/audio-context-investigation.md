# AudioContext起動失敗とYouTube広告の切り分け

## 確認できた事実

調査対象はReact通常アプリ。旧HTML、YouTubeプレイヤーの設定、データ形式、しきい値の既定値0.035、継続時間200msは変更していない。iPhoneでの広告表示とエラーの同時発生はユーザーからの観測であり、この修正の実機検証結果ではない。

修正前の発生元は `src/adapters/audio/microphone.ts` の `AudioContext起動期限超過`。ユーザーのいう「オーディオコンテキスト起動期限超過」に該当する。`acquire()`でContextを生成して直ちに`resume()`を要求し、マイク取得完了後、その最初のresume Promiseが完了するまで `settings.cleanupTimeoutMs = 3000` ms待っていた。

- 起算点：マイクのgetUserMediaが完了し、leaseを作成した直後。YouTube手動タップ時でも広告開始時でもない。
- 解除条件：resume Promiseがresolve/reject、または停止signalによる中断。その後のstateがrunningでなければ別の起動エラーになる。
- getUserMediaには別途60000msの期限、セッション側の取得全体にも60000msの期限がある。動画準備期限15000ms、停止確認期限3000msも別物。
- 事前再生方式のマイク取得は、PLAYINGイベントの現在状態確認→pauseVideo→PAUSED確認の後に始まる。プレイヤーの待機がAudioContextの3秒期限を直接消費する構造ではない。
- 広告終了付近で初めてPLAYINGが通知された場合、その直後に起動が始まりエラーになる時系列とは整合する。ただし広告終了をAPIで確認していないため、これは原因の確定ではない。

## 旧版との比較

| 処理 | 旧HTML | 修正前React事前再生方式 |
|---|---|---|
| 起点 | ページ上のマイク検知開始操作 | YouTubeの非同期PLAYING通知後 |
| マイクとContext | getUserMedia→Context生成→分析ノード接続 | Context生成→resume要求→getUserMedia→resume完了待ち→ノード接続 |
| resumeと起動検査 | 明示resume・running検査・起動期限なし | 最初のresumeだけを待つ。runningも検査 |
| 動画 | マイク準備後、保存位置でcue→検知時play | ユーザーの事前再生→自動停止→マイク準備→検知時seek/play |
| 音声経路への希望 | 対応する場合audioSession.typeをplay-and-recordに設定 | 同設定なし。Web側でBluetooth経路を保証しない |

旧版でエラーが出なかったことだけではContextが常にrunningだったと証明できない。一方、Reactの起動がページの直接操作から離れ、マイク取得後の状態に応じたresumeがない点は回帰要因の候補。今回はBluetooth経路への影響が未検証のaudioSession設定を追加せず、起動順序・明示操作による復旧に範囲を限定した。

## 今回の修正

1. Context生成直後のresumeは維持。マイク取得後に分析ノードを接続し、その時点でrunningでなければ再度resumeを要求する。取得後に既にrunningなら、取得前の未完了Promiseだけを理由に期限超過にしない。既に確定した起動エラーと最終的なrunning確認は維持する。
2. 起動期限は独立した `audioStartTimeoutMs = 3000` msに分離。延長していない。失敗・中断時のtrack停止とContext closeを維持する。
3. 起動失敗を `AudioStartError` と分類。資源回収に成功した場合のみ、事前再生済み動画を一時停止して `micReady`（音検知未開始）へ移る。解放に失敗した場合は既存の終了・解放再試行へ進む。
4. 「マイクを起動して検知開始」をタップすると、awaitやタイマーを挟まずContext生成・resumeを呼ぶ。成功後に動画のPAUSEDを再確認してから検知を開始する。二重操作、停止後の遅着、想定外再生を防ぐ。
5. 再試行でも失敗する場合は起動操作待ちへ戻る。「すべて停止」は動画も終了する。新たな検知成功・再生成功とは表示しない。

既存の自動起動が成功する環境では追加操作は不要。起動操作待ちにはマイク資源を保持しない。再試行でブラウザ制限を必ず解除できるとは保証しない。YouTubeのonAutoplayBlocked/onErrorはこれとは別に処理する。

## 広告についての判断と限界

旧版もReact版も公式YT.Playerを使用。Reactのautoplay:0、playsinline:1、originの指定から広告増加の原因とは判断できない。広告を要求する独自コード、遮断・回避コードは追加していない。公開元・動画・アカウント・ブラウザ条件の違いが影響する可能性はあるが、現時点で原因は未確定。

[公式IFrame API](https://developers.google.com/youtube/iframe_api_reference)の通常の再生状態イベントから広告と本編の切替や実発音を確定しない。今回のログにも広告状態はunknownと記録する。[Web Audio仕様](https://webaudio.github.io/web-audio-api/#dom-audiocontext-resume)では、起動が許可されない場合のresumeは待機し得る。[WebKitの未完了resume報告](https://bugs.webkit.org/show_bug.cgi?id=281566)もあるが、この端末で同じ原因とは断定しない。

本編準備や検知後に再度広告が出るなど、PLAYINGだけでは同期成功を保証できない状況は残る。実際の本人歌唱とBluetooth出力は耳で確認する。広告を自動判別して待ち飛ばす実装はしていない。

## 診断JSONで見る順序

既存の診断JSON保存を使う。追加ログの時刻はperformance.now基準で、実際に音が出た時刻ではない。

`player.playing` → `preplay.pause.request` → `preplay.paused` → `mic.acquire` → `mic.context.created` → `mic.context.resume.request` → `mic.gum.request/completed` → 必要ならafter-microphoneのresume → `mic.context.start.wait` → `mic.context.start.completed` → `mic.acquired` → `detector.armed`

失敗時は `mic.context.start.timeout` / `mic.initialization.failed`、資源解放、`mic.activation.required` を確認。再試行は `mic.activation.retry` から新しい起動ログになる。

- Contextログ：生成・resume要求/完了/失敗、起動待ち開始・成功・期限超過、statechange、時刻・経過ms。取得できる場合のみ起動呼出し時のuserActivationも記録。
- `player.context`：受信したイベントと、その時点のセッションphase/mic、advertising:unknown。既存playerイベント・requestIdの記録形式は維持。
- 生音声は保存しない。起動失敗時に広告があったかはユーザーの観察としてJSONに添えるメモに記録する。

## iPhone Safari＋Bluetoothでの再確認

同じ動画・しきい値0.035・継続200ms・保存済み位置で、広告あり/なしそれぞれを複数回比較する。広告の出現をプログラムで強制したり回避したりしない。

1. Bluetoothイヤホンを接続し、通常アプリで「検知を準備」→埋込みプレイヤーを直接タップ。広告が見えたか、終了と本編開始の時点をメモする。
2. 自動一時停止後、起動成功なら「音検知待機中」、失敗なら「マイク起動の操作待ち」になることを確認。未起動なのに音量測定・検知成功と表示しないことを確認。
3. 起動操作待ちならページ上の「マイクを起動して検知開始」を直接タップ。マイク許可、音量表示、PAUSED維持を確認し、合図後だけ自動再開することを確認。
4. 各段階で「すべて停止」を試し、マイク使用表示が消え、遅れて検知・再生しないことを確認。再準備も試す。
5. Bluetooth出力先・無音・音質変化・ループを耳で確認。保持/解放比較、画面復帰後の中断も別試行で確認する。
6. 各試行の診断JSONを保存。広告観察とplayer.context、Context state、gum完了、起動期限起算点を照合する。PLAYINGだけで実発音・同期成功とは判定しない。

ローカル回帰テストは広告自体を再生せず、BUFFERINGから本編開始相当のPLAYINGまで0/30000ms待つイベント列を再現する。実マイクアダプターの未完了resume、3秒の起動失敗、直接操作からの再取得を組み合わせて検査する。広告、Safariのユーザー操作判定、Bluetoothの実経路は自動テストでは再現・実証していない。

ローカル検証結果：既存646件＋追加15件の計661件成功、型検査・本番ビルド成功。既存の未完了resumeテスト2件は、stateをsuspendedかつ両resume要求を未完了にする実態に即したfixtureへ補強した。期限超過・停止・track回収という期待値は維持した。
