import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeSettingsPanel } from '../src/ui/navigation';
import { defaultDetectionProfile, detectionModes, withDetectionProfile, existingDetectionProfile } from '../src/app/detectionModes';
import { defaultProfile, emptyLibrary, SongLibrary } from '../src/library/model';
import { parseImport } from '../src/library/backup';
import { StartTriggerSettings } from '../src/ui/StartTriggerSettings';
import { App } from '../src/ui/App';
import { createApp } from '../src/app/createApp';
afterEach(()=>vi.unstubAllGlobals());
const id='dQw4w9WgXcQ';
it.each(['DAM','JOYSOUND','HOME'] as const)('%sの新規設定だけ0.05/200ms、保存済み0.035や個別値は不変',service=>{
 const data=new Map<string,string>(),storage={getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>{data.set(k,v);}};
 expect(defaultProfile(id,service).input).toMatchObject({threshold:.05,durationMs:200});
 let profile=withDetectionProfile(undefined,defaultDetectionProfile(id,service,'vocal'));
 for(const mode of detectionModes){const saved=defaultDetectionProfile(id,service,mode);saved.input.threshold=mode==='vocal'?.035:.08;profile=withDetectionProfile(profile,saved);}
 const store=new SongLibrary(storage,4);store.commit({...emptyLibrary(),songs:[{videoId:id,title:'保存曲',artist:'',profiles:{[service]:profile}}]});const before=[...data];
 const reloaded=new SongLibrary(storage,4).snapshot(),restored=parseImport(store.export()).library;
 for(const library of [reloaded,restored]){expect(existingDetectionProfile(library.songs[0]!.profiles[service],'vocal')!.input.threshold).toBe(.035);expect(existingDetectionProfile(library.songs[0]!.profiles[service],'accompaniment')!.input.threshold).toBe(.08);}
 expect([...data]).toEqual(before);
});
it.each(detectionModes)('%sの案内は用途に対応し、既存の入力値を変更しない',mode=>{
 const input=defaultDetectionProfile(id,'DAM',mode).input,before=structuredClone(input),change=vi.fn();
 const html=renderToStaticMarkup(createElement(StartTriggerSettings,{input,disabled:false,onChange:change}));
 if(mode==='vocal')expect(html).toContain('カラオケのBGM音量は最初に小さめに設定することをおすすめします');
 else {expect(html).toContain('伴奏の小さい音から検知');expect(html).not.toContain('BGM音量は最初に小さめ');}
 expect(input).toEqual(before);expect(change).not.toHaveBeenCalled();
});
it('保存の直下に同じ検知開始操作があり、長い設定5欄に閉じる操作を置く',()=>{
 vi.stubGlobal('localStorage',{getItem:()=>null,setItem:vi.fn()});const html=renderToStaticMarkup(createElement(App,createApp('simulation')));
 expect(html).toMatch(/この開始位置設定を保存<\/button><button class="primary correction-prepare"[^>]*>検知を開始/);
 expect(html.match(/この設定欄を閉じる/g)).toHaveLength(5);expect(html).toContain('class="preview-start"');
});
function closing(reduce=false){
 let frame:FrameRequestCallback|undefined;
 const summary={focus:vi.fn(),scrollIntoView:vi.fn()},input={value:'30.25'};
 const panel={open:true,isConnected:true,querySelector:vi.fn(()=>summary),input};
 const view={requestAnimationFrame:vi.fn((f:FrameRequestCallback)=>{frame=f;return 1;}),cancelAnimationFrame:vi.fn(()=>{frame=undefined;}),matchMedia:vi.fn(()=>({matches:reduce}))};
 return{panel,summary,input,view,close:()=>closeSettingsPanel(panel as unknown as HTMLDetailsElement,view as unknown as Window),paint:()=>{const f=frame;frame=undefined;f?.(0);}};
}
describe('手動収納と見出しへの移動',()=>{
 it.each([false,true])('閉じてから描画後に見出しへ移動し値を保持、動き低減=%s',reduce=>{const s=closing(reduce);s.close();expect(s.panel.open).toBe(false);expect(s.summary.scrollIntoView).not.toHaveBeenCalled();s.paint();expect(s.summary.focus).toHaveBeenCalledWith({preventScroll:true});expect(s.summary.scrollIntoView).toHaveBeenCalledWith({behavior:reduce?'auto':'smooth',block:'start',inline:'nearest'});expect(s.input.value).toBe('30.25');});
 it('閉じ直しは1回にまとめ、再展開した場合にはスクロールしない',()=>{const s=closing();s.close();s.close();s.paint();expect(s.summary.scrollIntoView).toHaveBeenCalledTimes(1);s.close();s.panel.open=true;s.paint();expect(s.summary.scrollIntoView).toHaveBeenCalledTimes(1);});
 it('DOMが取り除かれた後にはスクロールしない',()=>{const s=closing();s.close();s.panel.isConnected=false;s.paint();expect(s.summary.scrollIntoView).not.toHaveBeenCalled();});
});
