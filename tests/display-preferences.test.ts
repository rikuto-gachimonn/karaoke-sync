import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { App } from '../src/ui/App';
import { createApp } from '../src/app/createApp';
import { describe, expect, it, vi } from 'vitest';
import { defaultDisplayPreferences, displayPreferencesKey, loadDisplayPreferences, readDisplayPreferences, writeDisplayPreferences } from '../src/app/displayPreferences';
describe('独立した表示・確認音設定',()=>{
 it('初回は20%・説明ON、読み込みだけでは保存しない',()=>{expect(readDisplayPreferences({getItem:()=>null})).toEqual(defaultDisplayPreferences);});
 it('音量0/100・説明OFFを再読み込みでき、曲データに触れない',()=>{const values=new Map([['song','unchanged']]);const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};for(const volumePercent of [0,100]){writeDisplayPreferences(storage,{volumePercent,showHelp:false,volumeScale:3});expect(readDisplayPreferences(storage)).toEqual({volumePercent,showHelp:false,volumeScale:3});}expect(values.get('song')).toBe('unchanged');expect([...values.keys()]).toEqual(['song',displayPreferencesKey]);});
 it.each(['bad','null','{"volumePercent":200,"showHelp":false}','{"volumePercent":60,"showHelp":0}'])('不正設定を黙って書き換えない: %s',raw=>{expect(()=>readDisplayPreferences({getItem:()=>raw})).toThrow();});
 it('保存失敗を呼び出し元へ通知する',()=>{expect(()=>writeDisplayPreferences({setItem:()=>{throw Error('quota');}},defaultDisplayPreferences)).toThrow('quota');});
});

it('説明OFFでも入力・操作・候補・警告を補足説明の外に保ち、保存しない',()=>{
 const setItem=vi.fn();vi.stubGlobal('localStorage',{getItem:(key:string)=>key===displayPreferencesKey?JSON.stringify({volumePercent:0,showHelp:false,volumeScale:3}):null,setItem});
 try {
  const html=renderToStaticMarkup(createElement(App,createApp('simulation')));
  expect(html).toContain('data-show-help="false"');expect(html).toContain('step="5"');
  for(const text of ['確認音を試す','詳しい説明を表示','YouTubeの歌い始め位置','補正後の再生開始候補','同一出力先は保証できません','端末音量・実際の音圧は保証しません'])expect(html).toContain(text);
  for(const match of html.matchAll(/<(p|small|dd)[^>]*data-help[^>]*>(.*?)<\/\1>/g))expect(match[2]).not.toMatch(/<(button|input|select|output)|role="(alert|status)"|aria-describedby/);
  expect(setItem).not.toHaveBeenCalled();
 } finally {vi.unstubAllGlobals();}
});
it.each([false,true])('説明切り替えは名前・状態を持つ1つのスイッチで表示する: %s',showHelp=>{
 vi.stubGlobal('localStorage',{getItem:(key:string)=>key===displayPreferencesKey?JSON.stringify({volumePercent:60,showHelp,volumeScale:3}):null,setItem:vi.fn()});
 try {
  const html=renderToStaticMarkup(createElement(App,createApp('simulation')));
  const control=html.slice(html.indexOf('<div class="display-preferences">'));
  expect(control.match(/role="switch"/g)).toHaveLength(1);
  expect(control).toMatch(/<label><span[^>]*>詳しい説明を表示<\/span>.*<input[^>]*role="switch"/);
  expect(control).toContain(`<span aria-hidden="true">${showHelp?'ON':'OFF'}</span>`);
  expect(control.includes('checked=""')).toBe(showHelp);
 } finally {vi.unstubAllGlobals();}
});
describe('0.60上限への一度だけの移行',()=>{
 function storage(raw:string|null){let value=raw;const setItem=vi.fn((_key:string,next:string)=>{value=next;});return {getItem:()=>value,setItem};}
 it.each([[undefined,100,25],[1,100,25],[2,100,50],[1,60,15],[2,30,15],[1,5,1.25],[2,5,2.5],[1,0,0],[2,0,0]])('旧スケール%s・%s%%を%s%%へ換算し従来ゲインを維持', (volumeScale,volumePercent,expected)=>{
  const store=storage(JSON.stringify({volumeScale,volumePercent,showHelp:false}));
  const first=loadDisplayPreferences(store);
  expect(first).toEqual({value:{volumePercent:expected,showHelp:false,volumeScale:3},error:''});
  expect(store.setItem).toHaveBeenCalledTimes(1);
  expect(loadDisplayPreferences(store)).toEqual(first);expect(loadDisplayPreferences(store)).toEqual(first);
  expect(store.setItem).toHaveBeenCalledTimes(1);
  const oldMax=volumeScale===2?.30:.15;
  expect(first.value.volumePercent*.60/100).toBeCloseTo(volumePercent*oldMax/100,12);
 });
 it('新規は20%、現行100%は100%のまま、読み込みによる書き込みなし',()=>{
  for(const raw of [null,JSON.stringify({volumePercent:100,volumeScale:3,showHelp:true})]){const store=storage(raw);expect(loadDisplayPreferences(store).value.volumePercent).toBe(raw===null?20:100);expect(store.setItem).not.toHaveBeenCalled();}
 });
 it('移行の保存失敗でも低い換算済みゲインで動き、再読込で二重換算しない',()=>{
  const raw=JSON.stringify({volumePercent:100,volumeScale:2,showHelp:false});
  const store={getItem:()=>raw,setItem:vi.fn(()=>{throw Error('quota');})};
  const result=loadDisplayPreferences(store);expect(result.value.volumePercent).toBe(50);expect(result.error).toContain('保存できません');
  expect(loadDisplayPreferences(store).value.volumePercent).toBe(50);expect(store.getItem()).toBe(raw);
 });
 it('小数移行値・説明表示・手動で選んだ100%を保存/復元する',()=>{
  const store=storage(JSON.stringify({volumePercent:5,volumeScale:1,showHelp:false}));const migrated=loadDisplayPreferences(store).value;
  writeDisplayPreferences(store,{...migrated,showHelp:true});expect(readDisplayPreferences(store)).toEqual({...migrated,showHelp:true});
  writeDisplayPreferences(store,{...migrated,volumePercent:100});expect(loadDisplayPreferences(store).value.volumePercent).toBe(100);
 });
 it('未知スケールを誤って変換・保存しない',()=>{const store=storage(JSON.stringify({volumePercent:100,showHelp:true,volumeScale:4}));expect(()=>loadDisplayPreferences(store)).toThrow();expect(store.setItem).not.toHaveBeenCalled();});
 it('旧設定でも切り替えボタンがなく、換算された値と試聴を表示する',()=>{
  vi.stubGlobal('localStorage',storage(JSON.stringify({volumePercent:100,showHelp:false,volumeScale:1})));
  try {const html=renderToStaticMarkup(createElement(App,createApp('simulation')));expect(html).not.toContain('新しい音量上限を使う');expect(html).not.toContain('以前の音量上限を使用中');expect(html).toContain('確認音を試す');expect(html).toContain('25%');}finally{vi.unstubAllGlobals();}
 });
});
