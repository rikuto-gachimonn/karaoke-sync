import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../src/ui/App';
import { createApp } from '../src/app/createApp';
import { LiveHistory } from '../src/domain/liveRecommendation';
import { defaultDetectionProfile } from '../src/app/detectionModes';
afterEach(()=>vi.unstubAllGlobals());
function storage(){const data=new Map<string,string>();return{data,getItem:(key:string)=>data.get(key)??null,setItem:vi.fn((key:string,value:string)=>{data.set(key,value);})};}
it.each(['idle','preparing','armed','playing','paused','buffering','ended'] as const)('%sでも調整UIを非表示にして開始位置調整・プレビュー・セッション操作は維持',phase=>{
 const st=storage();vi.stubGlobal('localStorage',st);const app=createApp('simulation');vi.spyOn(app.controller,'getSnapshot').mockReturnValue({...app.controller.getSnapshot(),generation:1,phase,canPrepare:phase==='idle'});
 const html=renderToStaticMarkup(createElement(App,app));const live=html.match(/<section class="live-adjustment"[^>]*>([\s\S]*?)<\/section>/)?.[0];
 expect(live).toContain('hidden=""');for(const label of ['今合ってる','今回の調整を次回用に保存','今回の補正を0秒に戻す','＋5秒','＋0.1秒'])expect(live).toContain(label);
 const correction=html.slice(html.indexOf('<details id="correction-panel"'),html.indexOf('class="tools-area"'));
 for(const text of ['開始位置を50ms戻す','補正を0秒に戻す','ピー音で開始位置を確認','この開始位置設定を保存'])expect(correction).toContain(text);
 expect(html).toContain('id="youtube-host"');expect(html).toContain('id="detection-start"');expect(html).toContain('すべてを停止');expect(st.setItem).not.toHaveBeenCalled();
});
it('保存された過去の補正履歴を消去せず、診断UIと保存データを保持する',()=>{
 const st=storage(),input=defaultDetectionProfile('dQw4w9WgXcQ','DAM','vocal','simulation').input;
 const history=new LiveHistory(st);history.capture('past',[{id:1,createdMs:0,trigger:'vocal',environment:'DAM',input,retainMicRequested:true,microphoneUsed:true,initialRequests:1,resumeRequests:0,outcome:'stopped',liveAdjustmentMs:100,liveOperations:[{timeMs:1,requestedMs:100,clampedMs:100,fromSec:10,targetSec:10.1}]}]);
 const before=[...st.data];st.setItem.mockClear();vi.stubGlobal('localStorage',st);const html=renderToStaticMarkup(createElement(App,createApp('simulation')));
expect(html).toContain('保持したリアルタイム補正結果');
 expect([...st.data]).toEqual(before);expect(st.setItem).not.toHaveBeenCalled();
});
