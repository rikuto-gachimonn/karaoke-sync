import { YouTubeProbe, type Condition } from './probe';
import { micProbeDefaults } from './microphone';
import type { CompensationMode } from './compensation';
import { aggregateTrials } from './statistics';
import './styles.css';

const root = document.querySelector<HTMLElement>('#probe-root')!;
root.innerHTML = `
<h1>YouTube再生検証</h1>
<p>検証専用ページです。通常のKaraokeSyncセッション制御は使用しません。⑥⑦は実マイクを使用します。</p>
<p>各条件で「新しい試行を準備」を押してください。前のプレイヤーとログは置き換わるため、先にJSONを保存してください。</p>
<label>動画ID <input id="video" value="M7lc1UVf-VE" maxlength="11" autocapitalize="off" spellcheck="false"></label>
<label>試験条件 <select id="condition">
<option value="iframe">① iframe内の再生ボタンを直接タップ</option>
<option value="immediate">② ページのボタンから即時playVideo()</option>
<option value="delayed">③ CUED後に待機して自動playVideo()</option>
<option value="seek-playing">④ 手動再生→PLAYINGから5秒後にseekToのみ</option>
<option value="seek-paused">⑤ 手動再生→自動一時停止→5秒後にseekTo＋playVideo</option>
<option value="mic-resume">⑥ 手動再生→自動一時停止→マイク検知で再開</option>
<option value="mic-compensation">⑦ マイク検知＋再生タイミング・位置補正の比較</option>
</select></label>
<label>③の待機時間（秒） <input id="delay" type="number" min="0" max="300" step="1" value="5"></label>
<fieldset><legend>⑥⑦ マイク音検知の設定（準備時に確定）</legend>
<label>開始位置（秒）<input id="mic-start" type="number" min="0" max="86400" step="0.05" value="0"></label>
<label>RMSしきい値（超過で判定）<input id="mic-threshold" type="number" min="0" max="1" step="0.01" value="${micProbeDefaults.threshold}"></label>
<label>検知継続時間（ms、0＝最初のしきい値超過で成立）<input id="mic-duration" type="number" min="0" max="2000" step="10" value="${micProbeDefaults.durationMs}"></label>
<label>検知待機期限（秒、継続時間とは別。1〜300秒、初期180秒）<input id="mic-timeout" type="number" min="1" max="300" value="180"></label>
<label>検知後のマイク<select id="mic-retain"><option value="retain">保持</option><option value="release">解放</option></select></label>
</fieldset>
<fieldset><legend>⑦ 補正比較（⑥には適用しません）</legend>
<label>方式<select id="compensation-mode"><option value="baseline">基準：即時・開始位置のみ</option><option value="wait">A：固定待機</option><option value="position">B：位置補正</option><option value="combined">A＋B：組み合わせ</option></select></label>
<label>A 待機時間（ms、0〜60000）<input id="compensation-wait" type="number" min="0" max="60000" step="1" value="0"></label>
<label>B 位置補正（ms、負数可）<input id="compensation-offset" type="number" min="-86400000" max="86400000" step="1" value="0"></label>
<p>実際のシーク位置は開始位置＋有効な補正量を0〜動画長に制限します。固定待機でジッターは消えません。API遅延だけで音声同期の合否を判定しません。</p>
</fieldset>
<button id="prepare">新しい試行を準備</button>
<p id="instruction" role="status"></p>
<div id="player-host" aria-label="可視YouTubeプレイヤー"></div>
<div class="buttons"><button id="play" disabled>② 即時再生</button><button id="pause">一時停止／待機取消</button>
<button id="snapshot">状態を記録</button><button id="destroy">試行終了・破棄</button></div>
<div class="buttons"><button id="resume" disabled>⑥⑦ 検知後の再開</button><button id="stop-all">すべて停止</button><button id="retry-cleanup">マイク解放を再試行</button></div>
<p id="status" role="status">未準備</p><p id="error" role="alert"></p>
<p id="seek-metrics" role="status"></p>
<p id="mic-status" role="status"></p>
<p id="compensation-status" role="status"></p>
<p>⑥はiframe内で直接再生してください。PLAYING→自動一時停止→PAUSED確認後にマイクを取得し検知を開始します。
armed表示後、短時間・30秒・60秒待って音を出す試行を比較できます。待機中に動画が止まり無音であることを耳でも確認してください。
マイク取得時・検知後の実発音、Bluetooth出力先、音質・ループの有無をメモしてください。画面をつけたまま使用します。</p>
<label>観察メモ（Bluetooth接続・出力先・実際に音が聞こえたか等）<textarea id="note" maxlength="2000"></textarea></label>
<button id="add-note">メモを記録</button><button id="save">この条件のJSONを保存</button>
<p>PLAYINGはAPI上の状態です。イヤホンでの実発音は別途観察してください。①〜⑤は失敗後もプレイヤーを保持し、⑥⑦はエラー時に資源を解放します。</p>
<p>④⑤は動画内の再生ボタンを直接タップしてください。④は最初のPLAYINGから5秒後、再生したままseekTo(0, true)だけを要求します。
⑤は最初のPLAYING後に自動で一時停止し、PAUSED確認から5秒後にseekTo(0, true)とplayVideo()を要求します。
待機中は触らないでください。元位置が0秒付近の場合は位置変化を判別できないことがあります。マイク検知は使用しません。</p>
<p>③の待機中は画面・iframeを触らずお待ちください。①のタップ自体は親ページから観測できず、後続イベントを記録します。
新しいプレイヤーでもブラウザの操作履歴はリセットされません。厳密に比較する場合は各条件を新しいタブで開き、実施順序をメモしてください。</p>
<pre id="logs" aria-label="時刻付き診断ログ"></pre>
<h2>複数JSONの集計（この端末内で処理）</h2>
<label>保存した診断JSONを複数選択<input id="aggregate-files" type="file" accept=".json,application/json" multiple></label>
<p>方式・設定別のAPI遅延統計です。実発音は測定できません。同じBluetooth・端末条件のファイルを選んでください。</p>
<div id="aggregate-table" style="overflow-x:auto"></div>
<pre id="aggregate-result"></pre>`;
function element<T extends HTMLElement>(id: string) { return document.getElementById(id) as T; }
const probe = new YouTubeProbe(element('player-host'), location.origin);
const condition = element<HTMLSelectElement>('condition');
const play = element<HTMLButtonElement>('play');
const error = element('error');
let starting = false;
function render() {
  const run = probe.run;
  play.disabled = !probe.ready || run?.condition !== 'immediate';
  const last = run?.entries.at(-1);
  element('status').textContent = run ? `試行 ${run.id} / ${run.condition} / ${last?.event ?? ''} / state=${last?.state ?? '?'} / video=${last?.observedVideoId ?? '?'} / エラーコード=${[...run.entries].reverse().find(e => e.errorCode !== undefined)?.errorCode ?? 'なし'}` : '未準備';
  const issue = run && [...run.entries].reverse().find(e => ['onError', 'onAutoplayBlocked', 'exception', 'ready.timeout', 'cue.timeout', 'mic.error', 'mic.release.error', 'player.dispose.error'].includes(e.event));
  error.textContent = issue ? `${issue.event}: ${issue.detail ?? ''}` : '';
  const metrics = run?.seek;
  const mic = run?.mic;
  element('compensation-status').textContent = run?.compensation ? `⑦ ${run.compensation.effective.mode} / 有効待機=${run.compensation.effective.waitMs}ms / 有効位置補正=${run.compensation.effective.offsetMs}ms / 検知→要求=${mic?.requestAfterDetectedMs?.toFixed(2) ?? '?'}ms / 要求→PLAYING=${mic?.playingAfterRequestMs?.toFixed(2) ?? '?'}ms / 指定シーク=${mic?.seekRequestedSec ?? '?'}秒（制限前=${mic?.rawSeekSec ?? '?'}秒） / PLAYING観測位置=${mic?.playingPositionSec ?? '?'}秒` : '';
  element<HTMLButtonElement>('resume').disabled = !mic || mic.phase !== 'paused' || mic.detectedMs === undefined;
  element('mic-status').textContent = mic ? `⑥ ${mic.phase} / RMS=${mic.rms?.toFixed(4) ?? '?'} / 検知まで=${mic.detectedAfterArmedMs?.toFixed(1) ?? '?'}ms / 検知→PLAYING=${mic.playingAfterDetectedMs?.toFixed(1) ?? '未確認'}ms（実発音・同期精度とは別） / マイク=${mic.options.retainMic ? '保持設定' : '解放設定'}。解放結果はmic.releasedを確認してください。` : '';
  element('seek-metrics').textContent = metrics ? `シーク前=${metrics.beforeSec?.toFixed(3) ?? '?'}秒 / 位置変化確認まで=${metrics.positionChangedAfterMs?.toFixed(1) ?? '未確認'}ms / 暫定安定確認まで=${metrics.stableAfterMs?.toFixed(1) ?? '未確認'}ms / ${metrics.outcome ?? '観測中'}（50ms間隔・実発音とは別）` : '';
  element('logs').textContent = run?.entries.slice(-150).map(e => `${e.elapsedMs.toFixed(1)}ms ${e.event} state=${e.state ?? '?'} video=${e.observedVideoId ?? '?'} position=${e.currentTimeSec?.toFixed(3) ?? '?'}s code=${e.errorCode ?? '-'} ${e.detail ?? ''}`).join('\n') ?? '';
}
let renderScheduled = false;
probe.subscribe(() => {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => { renderScheduled = false; render(); });
}); // 計測中の各ログ記録でDOMを同期更新して再生要求を遅らせない。
element('prepare').onclick = () => {
  if (starting) return;
  starting = true;
  const selected = condition.value as Condition;
  element('instruction').textContent = selected.startsWith('seek-') ? 'CUED後、iframe内で直接再生し、以後は画面を触らずお待ちください。④⑤の待機時間は固定5秒です。' : selected === 'iframe' ? 'CUED後、iframe内の再生ボタンを直接タップしてください。' : selected === 'immediate' ? 'CUED後、② 即時再生をタップしてください。' : 'CUED後は触らず待ってください。指定時間後に1回だけ要求します。';
  if (selected === 'mic-resume' || selected === 'mic-compensation') element('instruction').textContent = 'CUED後にiframe内で直接再生し、armedになるまで待ちます。待機中の無音とBluetooth出力先を確認してから音を出してください。';
  void probe.start(selected, element<HTMLInputElement>('video').value.trim(), Number(element<HTMLInputElement>('delay').value) * 1000, {
    startSec: Number(element<HTMLInputElement>('mic-start').value), threshold: Number(element<HTMLInputElement>('mic-threshold').value),
    durationMs: element<HTMLInputElement>('mic-duration').valueAsNumber, retainMic: element<HTMLSelectElement>('mic-retain').value === 'retain',
    waitTimeoutMs: Number(element<HTMLInputElement>('mic-timeout').value) * 1000,
  }, { mode: element<HTMLSelectElement>('compensation-mode').value as CompensationMode,
    waitMs: element<HTMLInputElement>('compensation-wait').valueAsNumber,
    offsetMs: element<HTMLInputElement>('compensation-offset').valueAsNumber })
    .then(() => render(), reason => { error.textContent = String(reason); })
    .finally(() => { starting = false; });
};
// PromiseやsetTimeoutを挟まず、ユーザーのクリックスタック内で実行する。
play.onclick = () => probe.play('button');
element('pause').onclick = () => probe.pause();
element('resume').onclick = () => probe.resume();
element('stop-all').onclick = () => { try { probe.dispose(); render(); } catch (reason) { error.textContent = String(reason); } };
element('retry-cleanup').onclick = () => { void probe.retryMicCleanup().then(render, reason => { error.textContent = String(reason); }); };
element('snapshot').onclick = () => probe.snapshot();
element('add-note').onclick = () => probe.note(element<HTMLTextAreaElement>('note').value);
element('destroy').onclick = () => { try { probe.dispose(); render(); } catch (reason) { error.textContent = String(reason); } };
element('save').onclick = () => {
  const iframe = element('player-host').querySelector('iframe');
  const json = probe.export({ userAgent: navigator.userAgent, origin: location.origin, secureContext: isSecureContext,
    visibility: document.visibilityState, iframe: iframe ? { src: iframe.src, allow: iframe.allow, referrerPolicy: iframe.referrerPolicy } : null,
    observation: element<HTMLTextAreaElement>('note').value });
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url;
  link.download = `youtube-probe-${probe.run?.condition ?? 'none'}-${Date.now()}.json`;
  document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60_000);
};
document.addEventListener('visibilitychange', () => {
  probe.note(`visibility=${document.visibilityState}`);
  if (document.visibilityState === 'hidden' && probe.run?.mic) probe.dispose();
});
window.addEventListener('pagehide', () => probe.dispose());
if (import.meta.hot) import.meta.hot.dispose(() => probe.dispose());

element<HTMLInputElement>('aggregate-files').onchange = () => {
  const files = [...(element<HTMLInputElement>('aggregate-files').files ?? [])];
  void Promise.all(files.map(async file => {
    try {
      if (file.size > 10 * 1024 * 1024) return { name: file.name, data: null };
      return { name: file.name, data: JSON.parse((await file.text()).replace(/^\uFEFF/, '')) as unknown };
    } catch { return { name: file.name, data: null }; }
  })).then(documents => {
    const result = aggregateTrials(documents);
    element('aggregate-result').textContent = JSON.stringify(result, null, 2);
    const table = document.createElement('table');
    const addRow = (values: string[], header = false) => {
      const row = table.insertRow();
      for (const value of values) { const cell = document.createElement(header ? 'th' : 'td'); cell.textContent = value; cell.style.padding = '8px'; cell.style.whiteSpace = 'nowrap'; row.appendChild(cell); }
    };
    addRow(['方式', 'A(ms)', 'B(ms)', 'マイク', '有効/総数', '不完全/失敗', '検知→要求(ms)', '検知→PLAYING(ms)', '要求→PLAYING(ms)'], true);
    const format = (metric: ReturnType<typeof import('./statistics').statistics>) => metric ? `${metric.median.toFixed(2)} / ${metric.p95.toFixed(2)} / ${metric.max.toFixed(2)} / ${metric.standardDeviation.toFixed(2)}` : '有効試行なし';
    for (const group of result.groups) addRow([`${group.configuration.condition}: ${group.configuration.mode}`, `${group.configuration.waitMs}`, `${group.configuration.offsetMs}`,
      group.configuration.retainMic ? '保持' : '解放', `${group.detectToPlayingMs?.n ?? 0}/${group.total}`, `${group.incompleteOrFailed}`,
      format(group.detectToRequestMs), format(group.detectToPlayingMs), format(group.requestToPlayingMs)]);
    const caption = document.createElement('caption'); caption.textContent = '各遅延欄：中央値 / p95 / 最大 / 標準偏差。少数試行は参考値。設定詳細と警告は下のJSON参照。'; table.prepend(caption);
    element('aggregate-table').replaceChildren(table);
  });
};
