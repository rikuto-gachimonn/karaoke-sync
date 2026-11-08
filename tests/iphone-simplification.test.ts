import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../src/ui/App';
import { createApp } from '../src/app/createApp';
import { initialState, type SessionState } from '../src/session/state';
import { diagnosticDocument } from '../src/ui/diagnosticExport';
import { trialExport } from '../src/diagnostics/trials';
import { aggregateSessionLogs, latencySummary } from '../src/diagnostics/latency';
import { defaultDetectionProfile } from '../src/app/detectionModes';

function render(patch: Partial<SessionState> = {}, confirmed = false) {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
  const app = createApp('simulation');
  vi.spyOn(app.controller, 'getSnapshot').mockReturnValue({ ...initialState, generation: 3, ...patch });
  const trial = { id: 3, createdMs: 0, trigger: 'vocal' as const, environment: 'DAM' as const, input: defaultDetectionProfile('dQw4w9WgXcQ', 'DAM', 'vocal', 'simulation').input, retainMicRequested: true, microphoneUsed: true, initialRequests: 1, resumeRequests: 0, outcome: 'api-playing' as const, playingConfirmedMs: 100 };
  if (confirmed) vi.spyOn(app.controller, 'exportTrials').mockReturnValue({ ...app.controller.exportTrials(), trials: trialExport([trial],0).trials });
  return renderToStaticMarkup(createElement(App, app));
}
afterEach(() => vi.unstubAllGlobals());
it.each(['playing', 'buffering'] as const)('再生確認済み%sでは大きな状態欄を隠し動画直下の停止を残す', phase => {
 const html = render({ phase, canPrepare: false }, true);
 expect(html).toMatch(/class="session-card" hidden=""/);
 expect(html).toContain('aria-label="現在の機種と検知モード">DAM / 歌声検知');
 expect(html.slice(html.indexOf('class="playback-time-main"'),html.indexOf('class="live-adjustment"'))).toContain('すべてを停止');
 expect(html).toMatch(/<button hidden=""[^>]*>一時停止/);
});
it.each(['preplay','armed','starting','paused','error'] as const)('%sは必要な状態欄と操作を維持する', phase => {
 expect(render({phase,canPrepare:false})).not.toMatch(/class="session-card" hidden/);
});
it('再生確認前のバッファリング・復旧要求・マイク異常を隠さない', () => {
 expect(render({phase:'buffering'})).not.toMatch(/class="session-card" hidden/);
 for (const patch of [{resourceWarning:'マイク解放に失敗'}, {canRecoverAcquisition:true}]) {
  const html=render({phase:'playing',...patch},true);
  expect(html).not.toMatch(/class="session-card" hidden/);
  if(patch.resourceWarning)expect(html).toContain('<p role="alert">マイク解放に失敗</p>');
 }
});
it('技術設定と診断を閉じた下部領域にまとめ、重複UIだけを削除する',()=>{
 const html=render();const dev=html.slice(html.indexOf('<details id="developer-settings"'));
 expect(dev).toMatch(/^<details[^>]*><summary>開発者向け設定を表示/);
 for(const text of ['再生方式','目的位置から事前再生する','安定化待機','同期補正方式','基準位置と適用タイミングの内訳','API遅延の比較統計','保持したリアルタイム補正結果']) {
  expect(dev).toContain(text);
 }
 expect(dev).not.toMatch(/type="checkbox" checked=""[^>]*\/>目的位置/);
 expect(html.match(/>診断JSONを保存<\/button>/g)).toHaveLength(1);
 expect(html).not.toContain('開始トリガー比較JSONを保存');expect(html).not.toContain('使い方・音声出力について');expect(html).not.toContain('詳しい説明を表示');
 for(const text of ['使い方ガイド','JSONバックアップ','この開始位置設定を保存','この設定欄を閉じる','音が出ない・音質がおかしい場合'])expect(html).toContain(text);
 expect(html).toContain('hidden="" aria-label="歌唱中の位置調整"');
});
it('説明開閉ボタンは欄別の対象と閉じた初期状態を持ち、補足には操作や警告を入れない',()=>{
 const html=render();const buttons=[...html.matchAll(/<button[^>]*class="explanation-toggle"[^>]*>/g)].map(m=>m[0]);
 expect(buttons.length).toBeGreaterThanOrEqual(7);
 const targets=buttons.map(tag=>tag.match(/aria-controls="([^"]+)"/)![1]);expect(new Set(targets).size).toBe(buttons.length);
 for(const tag of buttons)expect(tag).toContain('aria-expanded="false"');
 for(const match of html.matchAll(/<(p|small|dd)[^>]*data-help[^>]*>(.*?)<\/\1>/g))expect(match[2]).not.toMatch(/<(button|input|select|output)|role="(alert|status)"/);
 expect(localStorage.setItem).not.toHaveBeenCalled();
});
it('統合診断は従来の通常項目・専用試行情報を維持しtimeOriginMsだけを追加する',()=>{
 const app=createApp('simulation');const trials=app.controller.exportTrials();
 const input=defaultDetectionProfile('dQw4w9WgXcQ','DAM','vocal','simulation').input;
 const document=diagnosticDocument({mode:'simulation',userAgent:'test',origin:'https://test.invalid',timeOriginMs:12345,retainMic:true,input,dropped:2,entries:[],triggerTrials:trials,liveResults:[]});
 expect(Object.keys(document).sort()).toEqual(['mode','clock','userAgent','origin','timeOriginMs','retainMic','input','dropped','entries','triggerTrials','liveResults','latency'].sort());
 expect(document.triggerTrials).toEqual(trials);expect(document.latency).toEqual(latencySummary(trials.trials));expect(document.timeOriginMs).toBe(12345);
 expect(()=>aggregateSessionLogs([{name:'combined.json',data:JSON.parse(JSON.stringify(document))}])).not.toThrow();
 expect(input).toEqual(defaultDetectionProfile('dQw4w9WgXcQ','DAM','vocal','simulation').input);
});
