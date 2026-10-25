import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { App } from '../src/ui/App';
import { createApp } from '../src/app/createApp';
import { adjustEffectiveStart, positionComponentsMs, validateInput, environments } from '../src/domain/sync';
import { defaultProfile, emptyLibrary, SongLibrary, upsertSong, libraryV2Key } from '../src/library/model';
import { parseImport } from '../src/library/backup';
import { settings, sessionOptions } from '../src/config/settings';
import { SessionController } from '../src/session/controller';
import { SimulatedPlayer, SimulatedLease } from '../src/adapters/simulation';
import { SustainedVolumeDetector } from '../src/domain/detector';
import { openPanel } from '../src/ui/navigation';
const id = 'M7lc1UVf-VE';
const profile = () => defaultProfile(id, 'HOME');
const storage = () => { const data = new Map<string,string>(); return { getItem: (key:string) => data.get(key) ?? null, setItem: vi.fn((key:string, value:string) => { data.set(key,value); }) }; };
async function flush() { for (let i=0;i<80;i++) await Promise.resolve(); }
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('4段階調整と設定整理', () => {
  it.each([5000,1000,100,10])('±%imsは基準方式で動作し0秒と整数上限を守る', step => {
    const input = { ...profile().input, savedPositionSec: 2, offsetSec: 0.1 };
    const changed = adjustEffectiveStart(input,step);
    expect(positionComponentsMs(changed).effectiveMs).toBe(2100+step);
    expect(adjustEffectiveStart(changed,-step).startAdjustmentMs).toBe(0);
    expect(positionComponentsMs(adjustEffectiveStart(input,-5000)).effectiveMs).toBe(0);
    expect(adjustEffectiveStart({...input,startAdjustmentMs:settings.maxStartAdjustmentMs},step).startAdjustmentMs).toBe(settings.maxStartAdjustmentMs);
  });
  it('保存済みB・オフセットを保持し5秒操作と再読込で二重加算しない', () => {
    const input = {...profile().input, savedPositionSec:10, offsetSec:0.1, compensation:{mode:'combined' as const,waitMs:123,offsetMs:200}};
    const adjusted = adjustEffectiveStart(input,5000);
    const store = new SongLibrary(storage(),2);
    store.commit(upsertSong(emptyLibrary(),{videoId:id,title:'曲',artist:'歌手',profiles:{HOME:{input:adjusted,retainMic:false}}}));
    const restored = parseImport(store.export()).library.songs[0]!.profiles.HOME!;
    expect(restored.input).toEqual(adjusted); expect(restored.retainMic).toBe(false);
    expect(positionComponentsMs(restored.input).effectiveMs).toBe(15300);
  });
  it('音声検知は初期展開、実験設定は閉じたパネルに置き全入力をDOMに維持する', () => {
    const st = storage(); vi.stubGlobal('localStorage',st);
    const html = renderToStaticMarkup(createElement(App,createApp('simulation')));
    for(const step of [5000,1000,100,10]) for(const direction of ['進める','戻す']) expect(html).toContain(`開始位置を${step}ms${direction}`);
    const normal = html.slice(html.indexOf('id="audio-settings"'),html.indexOf('class="service-picker"'));
    expect(normal).toContain('音量しきい値'); expect(normal).toContain('継続時間'); expect(normal).toContain('この設定を保存');
    expect(normal).not.toContain('同期補正方式');
    expect(normal).toContain('この設定をすべての曲に適用');
    expect(normal).not.toContain('role="alertdialog"');
    const dev = html.slice(html.indexOf('<details id="developer-settings"'),html.indexOf('<summary>模擬イベント操作'));
    expect(dev.match(/^<details[^>]*>/)?.[0]).not.toContain('open=');
    for(const label of ['同期補正方式','固定待機','B 追加位置補正','既存オフセット','検知待機期限','検知後のマイク資源']) expect(dev).toContain(label);
    expect(st.setItem).not.toHaveBeenCalled();
  });
  it('開閉導線は既存入力オブジェクトを置換せず値を維持する', () => {
    const field = {value:'-1234',focus:vi.fn()};
    const panel = {tagName:'DETAILS',open:false,scrollIntoView:vi.fn(),querySelector:()=>field};
    const doc = {getElementById:()=>panel} as unknown as Document;
    openPanel('developer-settings',doc); panel.open=false; openPanel('developer-settings',doc);
    expect(panel.open).toBe(true); expect(panel.querySelector()).toBe(field); expect(field.value).toBe('-1234');
  });
  it.each(environments)('%sの旧期限と解放選択をv2再読込・バックアップで維持する', service => {
    const st=storage(); const store=new SongLibrary(st,2); const p=defaultProfile(id,service);
    p.input.armedTimeoutMs=45000;p.input.playbackMode='legacy';p.retainMic=false;
    store.commit(upsertSong(emptyLibrary(),{videoId:id,title:'曲',artist:'',profiles:{[service]:p}}));
    const read=new SongLibrary(st,2);expect(read.snapshot().songs[0]!.profiles[service]).toEqual(p);
    expect(parseImport(read.export()).library.songs[0]!.profiles[service]).toEqual(p);
    expect(JSON.parse(st.getItem(libraryV2Key)!)).toBeTruthy();
  });
  it('新規は30分・保持・実接続の事前再生を推奨し期限欠落を勝手に保存しない', () => {
    expect(profile()).toMatchObject({retainMic:true,input:{armedTimeoutMs:1800000,playbackMode:'preplay'}});
    const p=profile(); delete p.input.armedTimeoutMs;
    const st=storage(); const store=new SongLibrary(st,2);store.commit(upsertSong(emptyLibrary(),{videoId:id,title:'曲',artist:'',profiles:{HOME:p}}));
    expect(new SongLibrary(st,2).snapshot().songs[0]!.profiles.HOME!.input.armedTimeoutMs).toBeUndefined();
  });
  it.each([1000,45000,300000,1800000])('期限%imsを受理する', armedTimeoutMs => expect(()=>validateInput({...profile().input,armedTimeoutMs})).not.toThrow());
  it.each([0,999,1800001,Infinity,NaN,1000.5])('不正・無制限期限%sを拒否する', armedTimeoutMs => expect(()=>validateInput({...profile().input,armedTimeoutMs})).toThrow('待機期限'));
});

describe('期限と資源の回帰', () => {
  it.each([undefined,1000,1800000])('期限%sで停止しマイクを一度解放、再生しない', async armedTimeoutMs => {
    vi.useFakeTimers(); const player=new SimulatedPlayer();const lease=new SimulatedLease();const release=vi.spyOn(lease,'release'); const acquire=vi.fn(async()=>lease);const play=vi.spyOn(player,'play');
    const controller=new SessionController({createPlayer:()=>player,audio:{acquire},createDetector:()=>new SustainedVolumeDetector()},undefined,{...sessionOptions});
    await controller.prepare({...profile().input,playbackMode:'legacy',armedTimeoutMs});
    const timeout=armedTimeoutMs??1800000;await vi.advanceTimersByTimeAsync(timeout-1);expect(controller.getSnapshot().phase).toBe('armed');
    await vi.advanceTimersByTimeAsync(1);await flush();
    expect(controller.getSnapshot()).toMatchObject({phase:'idle',mic:'off',message:'検知待機期限超過'});
    expect(acquire).toHaveBeenCalledTimes(1);expect(release).toHaveBeenCalledTimes(1);expect(play).not.toHaveBeenCalled();
    await controller.stop();expect(release).toHaveBeenCalledTimes(1);
  });
});
