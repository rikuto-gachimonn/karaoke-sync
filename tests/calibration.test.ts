import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { summarize, suggestThreshold } from '../src/calibration/statistics';
import { MeteredAudioInput, meterPercent } from '../src/calibration/meter';
import { CalibrationController } from '../src/calibration/controller';
import { rms } from '../src/adapters/audio/microphone';
import { SimulatedLease } from '../src/adapters/simulation';
import { AudioAcquireError, type AudioLease } from '../src/session/ports';
import { adoptThreshold } from '../src/domain/sync';
import { defaultProfile, SongLibrary, emptyLibrary, upsertSong, libraryV2Key } from '../src/library/model';
import { parseImport } from '../src/library/backup';
import { createApp } from '../src/app/createApp';
import { App } from '../src/ui/App';
import { VolumeMeter } from '../src/ui/VolumeMeter';
import { CalibrationPanel } from '../src/ui/CalibrationPanel';

const id='M7lc1UVf-VE'; const context=id+':HOME';
async function flush(){for(let i=0;i<80;i++) await Promise.resolve();}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
function setup(){
  const leases:SimulatedLease[]=[];
  const acquire=vi.fn(async()=>{const lease=new SimulatedLease();leases.push(lease);return lease;});
  const meter=new MeteredAudioInput({acquire});const stop=vi.fn(async()=>{});const log=vi.fn();const ready=vi.fn(()=>true);
  const calibration=new CalibrationController(meter,stop,ready,log,()=>Date.now());
  const window=async(values:number[])=>{for(let i=0;i<40;i++){leases.at(-1)!.sample({rms:values[i%values.length]!,timeMs:Date.now()});await vi.advanceTimersByTimeAsync(100);}await flush();};
  return {calibration,meter,acquire,stop,log,leases,window,ready};
}
beforeEach(()=>vi.useFakeTimers());
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();});

describe('RMS・統計・提案',()=>{
  it.each([0,0.001,0.25,1])('実adapterのRMS %sを同じ値・同じ尺度で表示する',async volume=>{
    const samples=new Float32Array([volume,-volume,volume,-volume]);const value=rms(samples);
    const lease=new SimulatedLease();const meter=new MeteredAudioInput({acquire:async()=>lease});const owned=await meter.acquire();
    lease.sample({rms:value,timeMs:performance.now()});
    expect(meter.getSnapshot().rms).toBeCloseTo(volume,6);
    const html=renderToStaticMarkup(createElement(VolumeMeter,{meter,threshold:value}));
    expect(html).toContain('aria-valuenow="'+value+'"');expect(html).toContain('しきい値 '+value.toFixed(4));
    expect(meterPercent(value)).toBeCloseTo(Math.sqrt(value)*100,10);await owned.release();
  });
  it('中央値・P10・P90・最大値を算出し元配列を変更しない',()=>{
    const values=[0.4,0,0.2,0.1,0.3];const result=summarize(values);
    expect(result.median).toBe(0.2);expect(result.p10).toBeCloseTo(0.04);expect(result.p90).toBeCloseTo(0.36);expect(result.max).toBe(0.4);expect(values[0]).toBe(0.4);
  });
  it.each([[],[NaN],[Infinity],[-0.1],[1.1]].map(values=>({values})))('不正統計入力$valuesを拒否する',({values})=>expect(()=>summarize(values)).toThrow());
  it('突発音最大値で候補を過大にしない',()=>{
    const noise=summarize([...Array(99).fill(0.01),1]);const music=summarize(Array(100).fill(0.1));
    expect(noise.max).toBe(1);expect(suggestThreshold(noise,music).value).toBe(0.055);
  });
  it.each([[0.1,0.1],[0.1,0.11],[0.01,0.014],[0.1,0.05]])('雑音%sと伴奏%sの重なり・小差では提案しない',(noise,music)=>{
    const proposal=suggestThreshold(summarize([noise]),summarize([music]));expect(proposal.value).toBeUndefined();expect(proposal.reason).toContain('困難');
  });
  it('無音伴奏は候補を出さず極小の理由を示す',()=>expect(suggestThreshold(summarize([0]),summarize([0])).reason).toContain('無音'));
  it('低音量でも十分な差があれば候補を算出する',()=>expect(suggestThreshold(summarize([0.001]),summarize([0.01])).value).toBe(0.0055));
  it('冒頭に小さい音や無音が多い伴奏を中央値だけで成功としない',()=>{
    const music=summarize([...Array(20).fill(0),...Array(80).fill(0.3)]);
    expect(suggestThreshold(summarize([0.01]),music).value).toBeUndefined();
  });
});

describe('一つのマイク取得とメーターの所有権',()=>{
  it('音検知とメーターは一つのleaseを使い、表示だけは最大10Hz',async()=>{
    const s=setup();const notify=vi.fn();s.meter.subscribe(notify);const owned=await s.meter.acquire();const detector=vi.fn();owned.subscribe(detector);
    for(let i=0;i<20;i++)s.leases[0]!.sample({rms:i/20,timeMs:i*10});
    expect(s.acquire).toHaveBeenCalledTimes(1);expect(detector).toHaveBeenCalledTimes(20);expect(notify).toHaveBeenCalledTimes(3);
    await expect(s.meter.acquire()).rejects.toThrow('未完了');await owned.release();expect(s.meter.getSnapshot().active).toBe(false);
  });
  it('入力元不明を本体と断定せず、解放後のメーターを非表示にする',async()=>{
    const s=setup();const lease=await s.meter.acquire();expect(s.meter.getSnapshot().input).toBe('不明');await lease.release();
    const html=renderToStaticMarkup(createElement(VolumeMeter,{meter:s.meter,threshold:0.08}));expect(html).toContain('未測定');expect(html).not.toContain('role="meter"');
  });
  it('報告名をそのまま表示し遅着更新や重複解放を防ぐ',async()=>{
    const lease=new SimulatedLease();const source={...lease,inputInfo:()=> 'Reported input',subscribe:lease.subscribe.bind(lease),release:vi.fn(()=>lease.release())};
    const meter=new MeteredAudioInput({acquire:async()=>source});const owned=await meter.acquire();expect(meter.getSnapshot().input).toBe('Reported input');
    await Promise.all([owned.release(),owned.release()]);expect(source.release).toHaveBeenCalledTimes(1);
    lease.sample({rms:1,timeMs:100});expect(meter.getSnapshot().active).toBe(false);
  });
  it('部分取得失敗の資源所有権を引き継ぎ解放まで次の取得を拒否する',async()=>{
    const partial={subscribe:vi.fn(),release:vi.fn(async()=>{})};const meter=new MeteredAudioInput({acquire:async()=>{throw new AudioAcquireError('partial',partial);}});
    let failure:AudioAcquireError|undefined;try{await meter.acquire();}catch(error){failure=error as AudioAcquireError;}
    expect(failure).toBeInstanceOf(AudioAcquireError);expect(meter.busy).toBe(true);await failure!.lease.release();expect(meter.busy).toBe(false);
  });
});

describe('4秒測定の安全性',()=>{
  it('雑音・伴奏を測定し推定をログへ残すが自動採用はしない',async()=>{
    const s=setup();await s.calibration.start('noise',context);await s.window([0.01]);
    expect(s.calibration.getSnapshot()).toMatchObject({busy:false,noise:{median:0.01,count:40}});expect(s.leases[0]!.released).toBe(true);
    await s.calibration.start('music',context);await s.window([0.1]);expect(s.calibration.suggestion(context).value).toBe(0.055);
    expect(s.stop).toHaveBeenCalledTimes(2);expect(s.acquire).toHaveBeenCalledTimes(2);expect(s.log.mock.calls.some(([event])=>event==='measurement.result')).toBe(true);
    expect(s.log.mock.calls.some(([event])=>event==='measurement.adopted')).toBe(false);
    expect(s.calibration.suggestion('other').value).toBeUndefined();
  });
  it('中断・停止連打後は結果や古いタイマーを実行せず解放する',async()=>{
    const s=setup();await s.calibration.start('noise',context);await Promise.all([s.calibration.cancel(),s.calibration.cancel()]);
    await vi.advanceTimersByTimeAsync(10000);expect(s.calibration.getSnapshot().noise).toBeUndefined();expect(s.meter.busy).toBe(false);
    expect(s.log.mock.calls.filter(([event])=>event==='measurement.finished')).toHaveLength(1);
  });
  it('停止処理待ち中の中断は新しいマイク取得を始めない',async()=>{
    const s=setup();const pending=deferred<void>();s.stop.mockReturnValue(pending.promise);const start=s.calibration.start('noise',context);await flush();await s.calibration.cancel();
    expect(s.calibration.getSnapshot().busy).toBe(true);expect(s.acquire).not.toHaveBeenCalled();pending.resolve();await start;
    expect(s.calibration.getSnapshot().busy).toBe(false);expect(s.acquire).not.toHaveBeenCalled();
  });
  it('取得待ち中断後の遅着leaseを回収し二重取得しない',async()=>{
    const pending=deferred<AudioLease>();const lease=new SimulatedLease();const acquire=vi.fn(()=>pending.promise);const meter=new MeteredAudioInput({acquire});
    const cal=new CalibrationController(meter,async()=>{},()=>true,vi.fn());const start=cal.start('noise',context);await flush();await cal.cancel();
    await cal.start('music',context);expect(acquire).toHaveBeenCalledTimes(1);expect(cal.getSnapshot().busy).toBe(true);
    pending.resolve(lease);await start;expect(lease.released).toBe(true);expect(cal.getSnapshot().busy).toBe(false);
  });
  it('権限拒否では測定を始めず再試行可能なエラーになる',async()=>{
    const s=setup();s.acquire.mockRejectedValueOnce(new Error('NotAllowedError'));await s.calibration.start('noise',context);
    expect(s.calibration.getSnapshot()).toMatchObject({busy:false,phase:'error'});expect(s.calibration.getSnapshot().message).toContain('NotAllowedError');expect(s.meter.busy).toBe(false);
  });
  it('サンプル不足を無音成功と混同しない',async()=>{
    const s=setup();await s.calibration.start('noise',context);await vi.advanceTimersByTimeAsync(4000);await flush();
    expect(s.calibration.getSnapshot().phase).toBe('error');expect(s.calibration.getSnapshot().noise).toBeUndefined();expect(s.leases[0]!.released).toBe(true);
  });
  it('無音サンプルの継続観測は測定可能',async()=>{
    const s=setup();await s.calibration.start('noise',context);await s.window([0]);expect(s.calibration.getSnapshot().noise?.max).toBe(0);
  });
  it('測定中エラーでマイクを解放する',async()=>{
    const s=setup();await s.calibration.start('noise',context);s.leases[0]!.sample({rms:NaN,timeMs:100});await flush();
    expect(s.calibration.getSnapshot().phase).toBe('error');expect(s.leases[0]!.released).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);expect(s.calibration.getSnapshot().noise).toBeUndefined();
  });
  it('前セッションの回収失敗なら新規取得を拒否する',async()=>{
    const s=setup();s.ready.mockReturnValue(false);await s.calibration.start('noise',context);expect(s.acquire).not.toHaveBeenCalled();expect(s.calibration.getSnapshot().phase).toBe('error');
  });
  it('解放失敗を表示し明示再試行で回復する',async()=>{
    const s=setup();await s.calibration.start('noise',context);const release=vi.spyOn(s.leases[0]!,'release').mockRejectedValueOnce(new Error('close failed'));
    await s.calibration.cancel();expect(s.calibration.getSnapshot()).toMatchObject({busy:true,phase:'error'});expect(s.meter.busy).toBe(true);
    await s.calibration.retryRelease();expect(release).toHaveBeenCalledTimes(2);expect(s.calibration.getSnapshot().busy).toBe(false);
  });
  it('解放未完了中の再試行を並行releaseにしない',async()=>{
    const s=setup();await s.calibration.start('noise',context);const pending=deferred<void>();const release=vi.spyOn(s.leases[0]!,'release').mockReturnValue(pending.promise);
    const cancel=s.calibration.cancel();await vi.advanceTimersByTimeAsync(3001);const retry=s.calibration.retryRelease();expect(release).toHaveBeenCalledTimes(1);expect(s.calibration.getSnapshot().busy).toBe(true);
    pending.resolve();await cancel;await retry;expect(s.calibration.getSnapshot().busy).toBe(false);
  });
  it('測定中の通常再生準備を拒否し、停止後だけ再開できる',async()=>{
    const app=createApp('simulation');await app.calibration.start('noise',context);
    await app.controller.prepare(defaultProfile(id,'HOME').input);expect(app.controller.getSnapshot().phase).toBe('idle');
    await app.stopAll();await app.controller.prepare({...defaultProfile(id,'HOME').input,playbackMode:'preplay'});expect(app.controller.getSnapshot().phase).toBe('preplay');await app.stopAll();
  });
  it('測定前の通常セッションを停止してからマイクを取得する',async()=>{
    const app=createApp('simulation');await app.controller.prepare({...defaultProfile(id,'HOME').input,playbackMode:'legacy'});
    expect(app.controller.getSnapshot().phase).toBe('armed');await app.calibration.start('noise',context);
    expect(app.controller.getSnapshot()).toMatchObject({phase:'idle',mic:'off'});expect(app.calibration.getSnapshot().phase).toBe('measuring');await app.stopAll();
  });
});

describe('提案採用と曲・環境別保存',()=>{
  it.each(['DAM','JOYSOUND','HOME'] as const)('%sのしきい値のみ採用・保存・復元する',service=>{
    const data=new Map<string,string>();const storage={getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value);}};
    const original=defaultProfile(id,service);const changed=adoptThreshold(original.input,0.055);expect(original.input.threshold).toBe(0.035);expect({...changed,threshold:0.035}).toEqual(original.input);
    const store=new SongLibrary(storage,2);store.commit(upsertSong(emptyLibrary(),{videoId:id,title:'曲',artist:'',profiles:{[service]:{...original,input:changed}}}));
    const restored=parseImport(store.export()).library.songs[0]!;expect(restored.profiles[service]!.input.threshold).toBe(0.055);
    expect(Object.keys(restored.profiles)).toEqual([service]);expect(storage.getItem(libraryV2Key)).not.toBeNull();
  });
  it.each([NaN,Infinity,-0.1,1.1])('不正候補%sを採用しない',value=>expect(()=>adoptThreshold(defaultProfile(id,'HOME').input,value)).toThrow());
  it('採用しない場合は保存を呼ばず、測定中の曲選択・準備をUIで禁止する',async()=>{
    const storage={getItem:vi.fn(()=>null as string|null),setItem:vi.fn()};vi.stubGlobal('localStorage',storage);
    const app=createApp('simulation');await app.calibration.start('noise',context);
    const html=renderToStaticMarkup(createElement(App,app));expect(html).toMatch(/<button[^>]*disabled=""[^>]*>検知を開始/);expect(html).toContain('測定モード');expect(storage.setItem).not.toHaveBeenCalled();await app.stopAll();
  });
  it('候補があっても採用操作なしで設定を変更しないと明示する',()=>{
    const s=setup();const adopt=vi.fn();const html=renderToStaticMarkup(createElement(CalibrationPanel,{calibration:s.calibration,context,canAdopt:true,onAdopt:adopt}));
    expect(html).toContain('提案だけでは設定を変えません');expect(html).toContain('生音声は保存しません');expect(adopt).not.toHaveBeenCalled();
  });
});

describe('測定中断・入力中断・状態維持の追加回帰',()=>{
  it('入力中断をメーターと測定に伝播し解放する',async()=>{
    let interrupted:((message:string)=>void)|undefined;
    const lease=new SimulatedLease();const source:AudioLease={subscribe:lease.subscribe.bind(lease),release:lease.release.bind(lease),onInterrupted:listener=>{interrupted=listener;return ()=>{interrupted=undefined;};}};
    const meter=new MeteredAudioInput({acquire:async()=>source});const cal=new CalibrationController(meter,async()=>{},()=>true,vi.fn());
    await cal.start('noise',context);interrupted?.('track ended');await flush();
    expect(cal.getSnapshot()).toMatchObject({busy:false,phase:'error'});expect(cal.getSnapshot().message).toContain('track ended');expect(meter.getSnapshot().active).toBe(false);expect(lease.released).toBe(true);
  });
  it('古い音量のまま測定中と表示しない',async()=>{
    const s=setup();const lease=await s.meter.acquire();s.leases[0]!.sample({rms:0.25,timeMs:performance.now()-2000});
    const html=renderToStaticMarkup(createElement(VolumeMeter,{meter:s.meter,threshold:0.08}));expect(html).toContain('観測待ち／中断中');expect(html).not.toContain('role="meter"');await lease.release();
  });
  it('マイク取得期限後の遅着stream相当も回収する',async()=>{
    const pending=deferred<AudioLease>();const lease=new SimulatedLease();const meter=new MeteredAudioInput({acquire:()=>pending.promise});const cal=new CalibrationController(meter,async()=>{},()=>true,vi.fn());
    const start=cal.start('noise',context);await flush();await vi.advanceTimersByTimeAsync(60000);expect(cal.getSnapshot().message).toContain('期限超過');expect(cal.getSnapshot().busy).toBe(true);
    pending.resolve(lease);await start;expect(lease.released).toBe(true);expect(meter.busy).toBe(false);
  });
  it('途中の長い無観測区間を成功扱いしない',async()=>{
    const s=setup();await s.calibration.start('noise',context);
    for(let i=0;i<10;i++){s.leases[0]!.sample({rms:0.01,timeMs:Date.now()});await vi.advanceTimersByTimeAsync(100);}
    await vi.advanceTimersByTimeAsync(1000);
    for(let i=0;i<20;i++){s.leases[0]!.sample({rms:0.01,timeMs:Date.now()});await vi.advanceTimersByTimeAsync(100);}
    await flush();expect(s.calibration.getSnapshot().noise).toBeUndefined();expect(s.calibration.getSnapshot().phase).toBe('error');
  });
  it('測定末尾の無観測も成功にしない',async()=>{
    const s=setup();await s.calibration.start('noise',context);
    for(let i=0;i<32;i++){s.leases[0]!.sample({rms:0.01,timeMs:Date.now()});await vi.advanceTimersByTimeAsync(100);}
    await vi.advanceTimersByTimeAsync(800);await flush();expect(s.calibration.getSnapshot().noise).toBeUndefined();expect(s.calibration.getSnapshot().phase).toBe('error');
  });
  it('測定中は登録曲の選択も禁止する',async()=>{
    const data=new Map<string,string>();const storage={getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value);}};
    const store=new SongLibrary(storage,2);store.commit(upsertSong(emptyLibrary(),{videoId:id,title:'試験曲',artist:'',profiles:{}}));vi.stubGlobal('localStorage',storage);
    const app=createApp('simulation');await app.calibration.start('noise',context);
    const html=renderToStaticMarkup(createElement(App,app));expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="この曲を選択: 試験曲/);await app.stopAll();
  });
  it('曲・環境変更のresetで前の候補を破棄し、古いタイマーを残さない',async()=>{
    const s=setup();await s.calibration.start('noise',context);await s.window([0.01]);await s.calibration.start('music',context);await s.window([0.1]);expect(s.calibration.suggestion(context).value).toBe(0.055);
    await s.calibration.reset();expect(s.calibration.suggestion(context).value).toBeUndefined();expect(s.calibration.getSnapshot().noise).toBeUndefined();expect(s.calibration.getSnapshot().music).toBeUndefined();expect(vi.getTimerCount()).toBe(0);
  });
  it('再測定失敗時に前回の同種結果を誤って再提案しない',async()=>{
    const s=setup();await s.calibration.start('noise',context);await s.window([0.01]);await s.calibration.start('music',context);await s.window([0.1]);
    await s.calibration.start('noise',context);await vi.advanceTimersByTimeAsync(4000);await flush();expect(s.calibration.suggestion(context).value).toBeUndefined();expect(s.calibration.getSnapshot().noise).toBeUndefined();
  });
  it('検知終了後のマイク保持中も同じ入力でメーターだけ更新する',async()=>{
    const app=createApp('simulation');await app.controller.prepare({...defaultProfile(id,'HOME').input,playbackMode:'legacy',durationMs:0});
    app.simulation.sample({rms:0.5,timeMs:performance.now()});await flush();app.simulation.playerEvent('playing');await flush();
    expect(app.controller.getSnapshot()).toMatchObject({phase:'playing',mic:'retained'});
    await vi.advanceTimersByTimeAsync(100);const before=app.controller.log.snapshot().length;app.simulation.sample({rms:0.2,timeMs:performance.now()});
    expect(app.meter.getSnapshot().rms).toBe(0.2);expect(app.controller.log.snapshot()).toHaveLength(before);
    await app.stopAll();expect(app.meter.getSnapshot().active).toBe(false);
  });
});
