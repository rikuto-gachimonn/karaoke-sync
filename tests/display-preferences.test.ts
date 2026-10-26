import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { App } from '../src/ui/App';
import { createApp } from '../src/app/createApp';
import { describe, expect, it, vi } from 'vitest';
import { defaultDisplayPreferences, displayPreferencesKey, readDisplayPreferences, writeDisplayPreferences } from '../src/app/displayPreferences';
describe('独立した表示・確認音設定',()=>{
 it('初回は60%・説明ON、読み込みだけでは保存しない',()=>{expect(readDisplayPreferences({getItem:()=>null})).toEqual(defaultDisplayPreferences);});
 it('音量0/100・説明OFFを再読み込みでき、曲データに触れない',()=>{const values=new Map([['song','unchanged']]);const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};for(const volumePercent of [0,100]){writeDisplayPreferences(storage,{volumePercent,showHelp:false});expect(readDisplayPreferences(storage)).toEqual({volumePercent,showHelp:false});}expect(values.get('song')).toBe('unchanged');expect([...values.keys()]).toEqual(['song',displayPreferencesKey]);});
 it.each(['bad','null','{"volumePercent":200,"showHelp":false}','{"volumePercent":60,"showHelp":0}'])('不正設定を黙って書き換えない: %s',raw=>{expect(()=>readDisplayPreferences({getItem:()=>raw})).toThrow();});
 it('保存失敗を呼び出し元へ通知する',()=>{expect(()=>writeDisplayPreferences({setItem:()=>{throw Error('quota');}},defaultDisplayPreferences)).toThrow('quota');});
});

it('説明OFFでも入力・操作・候補・警告を補足説明の外に保ち、保存しない',()=>{
 const setItem=vi.fn();vi.stubGlobal('localStorage',{getItem:(key:string)=>key===displayPreferencesKey?JSON.stringify({volumePercent:0,showHelp:false}):null,setItem});
 try {
  const html=renderToStaticMarkup(createElement(App,createApp('simulation')));
  expect(html).toContain('data-show-help="false"');expect(html).toContain('step="5"');
  for(const text of ['確認音を試す','詳しい説明を表示','YouTubeの歌い始め位置','補正後の再生開始候補','同一出力先は保証できません','端末音量・実際の音圧は保証しません'])expect(html).toContain(text);
  for(const match of html.matchAll(/<(p|small|dd)[^>]*data-help[^>]*>(.*?)<\/\1>/g))expect(match[2]).not.toMatch(/<(button|input|select|output)|role="(alert|status)"|aria-describedby/);
  expect(setItem).not.toHaveBeenCalled();
 } finally {vi.unstubAllGlobals();}
});
