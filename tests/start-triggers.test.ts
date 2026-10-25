import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionController } from '../src/session/controller';
import { SimulatedPlayer, SimulatedLease } from '../src/adapters/simulation';
import { SustainedVolumeDetector } from '../src/domain/detector';
import { DiagnosticLog } from '../src/diagnostics/log';
import { sessionOptions } from '../src/config/settings';
import { adjustEffectiveStart, playbackPlan, selectedTrigger, triggerPosition, startTriggers, positionComponentsMs, validateInput, type SyncInput, type StartTrigger } from '../src/domain/sync';
import { defaultProfile, SongLibrary, emptyLibrary, upsertSong, libraryKey, libraryV2Key, libraryV3Key } from '../src/library/model';
import { parseImport, importChoices, mergeImport } from '../src/library/backup';
import { loadSyncProfile, saveSyncProfile, preferencesV2Key, preferencesV3Key } from '../src/app/preferences';
import { selectSong } from '../src/library/selection';
import { StartTriggerSettings } from '../src/ui/StartTriggerSettings';
import { App } from '../src/ui/App';
import { createApp } from '../src/app/createApp';
const id='M7lc1UVf-VE';
const input=(trigger?:StartTrigger):SyncInput=>({...defaultProfile(id,'HOME').input,durationMs:0,savedPositionSec:10,vocalPositionSec:20,cuePositionSec:30,startTrigger:trigger});
async function flush(){for(let i=0;i<80;i++)await Promise.resolve();}
function setup(retainMic=true){
  const players:SimulatedPlayer[]=[];const leases:SimulatedLease[]=[];const acquire=vi.fn(async()=>{const lease=new SimulatedLease();leases.push(lease);return lease;});
  const detectorArm=vi.fn();
  const controller=new SessionController({createPlayer:()=>{const player=new SimulatedPlayer();players.push(player);vi.spyOn(player,'play');vi.spyOn(player,'seek');return player;},audio:{acquire},createDetector:()=>{const detector=new SustainedVolumeDetector();const arm=detector.arm.bind(detector);detector.arm=(...args)=>{detectorArm(...args);arm(...args);};return detector;}},new DiagnosticLog(()=>Date.now()),{...sessionOptions,retainMic});
  const prepare=async(value:SyncInput)=>{await controller.prepare(value);if(value.playbackMode==='preplay'){players.at(-1)!.emit({type:'playing'});await flush();}};
  const fire=()=>leases.at(-1)?.sample({rms:0.5,timeMs:Date.now()});
  return {controller,players,leases,acquire,detectorArm,prepare,fire};
}
const storage=()=>{const data=new Map<string,string>();return {data,getItem:(key:string)=>data.get(key)??null,setItem:vi.fn((key:string,value:string)=>{data.set(key,value);})};};
beforeEach(()=>vi.useFakeTimers());afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();});

describe('開始トリガーの位置・入力互換性',()=>{
  it('旧データのトリガー未指定は伴奏検知・従来開始位置とする',()=>{const old=input();delete old.vocalPositionSec;delete old.cuePositionSec;expect(selectedTrigger(old)).toBe('accompaniment');expect(triggerPosition(old)).toBe(10);expect(()=>validateInput(old)).not.toThrow();});
  it.each([['accompaniment',10],['vocal',20],['cue',30],['manual',10]] as const)('%sは保存済み%s秒を基準にする',(trigger,position)=>{expect(triggerPosition(input(trigger))).toBe(position);});
  it.each(['vocal','cue'] as const)('%sの個別位置未指定は登録位置へフォールバックする',trigger=>{const value=input(trigger);delete value.vocalPositionSec;delete value.cuePositionSec;expect(triggerPosition(value)).toBe(10);});
  it.each(startTriggers)('%sに4段階の整数調整と既存補正を一度だけ適用する',trigger=>{
    const value={...input(trigger),offsetSec:0.1,compensation:{mode:'position' as const,waitMs:0,offsetMs:200}};
    for(const step of [5000,1000,100,10]){const changed=adjustEffectiveStart(value,step);expect(positionComponentsMs(changed).effectiveMs).toBe(triggerPosition(value)*1000+300+step);expect(adjustEffectiveStart(changed,-step).startAdjustmentMs).toBe(0);expect(changed.vocalPositionSec).toBe(20);expect(changed.cuePositionSec).toBe(30);}
  });
  it('方式切替だけでは各開始位置・旧オフセット・B・主調整を失わない',()=>{const original={...input('vocal'),offsetSec:0.2,startAdjustmentMs:10};let value=original;for(const trigger of startTriggers)value={...value,startTrigger:trigger};expect({...value,startTrigger:'vocal'}).toEqual(original);});
  it.each([null,'unknown',1])('不正方式%sを拒否する',startTrigger=>expect(()=>validateInput({...input(),startTrigger} as SyncInput)).toThrow('開始トリガー'));
  it.each([null,-1,NaN,Infinity])('不正な個別開始位置%sを拒否する',value=>{expect(()=>validateInput({...input(),vocalPositionSec:value} as SyncInput)).toThrow('開始位置');expect(()=>validateInput({...input(),cuePositionSec:value} as SyncInput)).toThrow('開始位置');});
});

describe('トリガー実行と安全性',()=>{
  it.each(startTriggers)('%sは事前再生を維持し初回要求は一度だけ',async trigger=>{
    const s=setup();await s.controller.prepare(input(trigger));expect(s.controller.getSnapshot().phase).toBe('preplay');s.controller.manualStart();expect(s.players[0]!.play).not.toHaveBeenCalled();
    s.players[0]!.emit({type:'playing'});await flush();expect(s.controller.getSnapshot().phase).toBe(trigger==='manual'?'manualReady':'armed');
    if(trigger==='manual'){expect(s.acquire).not.toHaveBeenCalled();expect(s.detectorArm).not.toHaveBeenCalled();s.controller.manualStart();s.controller.manualStart();}
    else {s.controller.manualStart();expect(s.players[0]!.play).not.toHaveBeenCalled();s.fire();s.fire();}
    await flush();expect(s.players[0]!.seek).toHaveBeenCalledExactlyOnceWith(triggerPosition(input(trigger)));expect(s.players[0]!.play).toHaveBeenCalledTimes(1);
    s.players[0]!.emit({type:'playing'});await flush();expect(s.controller.getSnapshot().phase).toBe('playing');s.controller.manualStart();s.fire();await flush();expect(s.players[0]!.play).toHaveBeenCalledTimes(1);
    expect(s.controller.exportTrials().trials[0]).toMatchObject({trigger,initialRequests:1,outcome:'api-playing',microphoneUsed:trigger!=='manual'});await s.controller.stop();
  });
  it.each(['vocal','cue'] as const)('%sも声を識別せず同じRMSしきい値・継続時間を使う',async trigger=>{
    const s=setup();await s.prepare({...input(trigger),durationMs:50});const lease=s.leases[0]!;lease.sample({rms:0.01,timeMs:0});lease.sample({rms:0.5,timeMs:100});lease.sample({rms:0.5,timeMs:149});await flush();expect(s.players[0]!.play).not.toHaveBeenCalled();lease.sample({rms:0.5,timeMs:150});await flush();expect(s.players[0]!.play).toHaveBeenCalledTimes(1);await s.controller.stop();
  });
  it.each(['manual','vocal','cue'] as const)('%sは従来再生方式でも有効範囲へシークする',async trigger=>{
    const s=setup();await s.prepare({...input(trigger),playbackMode:'legacy',startAdjustmentMs:1000000});if(trigger==='manual')s.controller.manualStart();else s.fire();await flush();expect(s.players[0]!.seek).toHaveBeenCalledExactlyOnceWith(240);await s.controller.stop();
  });
  it.each([['manual',-100000,0],['vocal',-100000,0],['cue',1000000,240]] as const)('%sの補正%imsは%s秒に制限する',async(trigger,startAdjustmentMs,target)=>{
    const s=setup();await s.prepare({...input(trigger),startAdjustmentMs});if(trigger==='manual')s.controller.manualStart();else s.fire();await flush();const wait=playbackPlan({...input(trigger),startAdjustmentMs}).waitMs;if(wait){expect(s.players[0]!.seek).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(wait);}expect(s.players[0]!.seek).toHaveBeenCalledExactlyOnceWith(target);await s.controller.stop();
  });
  it('手動待機中のiframe直接再生を成功とせず安全停止する',async()=>{const s=setup();await s.prepare(input('manual'));s.players[0]!.emit({type:'playing'});await flush();expect(s.controller.getSnapshot().phase).toBe('error');expect(s.players[0]!.play).not.toHaveBeenCalled();expect(s.acquire).not.toHaveBeenCalled();});
  it('手動待機の期限切れはマイク取得なしで終了する',async()=>{const s=setup();await s.prepare({...input('manual'),armedTimeoutMs:1000});await vi.advanceTimersByTimeAsync(1000);expect(s.controller.getSnapshot()).toMatchObject({phase:'idle',mic:'off',message:'手動開始待機期限超過'});expect(s.acquire).not.toHaveBeenCalled();expect(s.players[0]!.disposed).toBe(true);expect(s.controller.exportTrials().trials[0]!.outcome).toBe('timeout');});
  it.each(startTriggers)('%sの固定待機中に停止したら後から再生しない',async trigger=>{
    const s=setup();await s.prepare({...input(trigger),compensation:{mode:'wait',waitMs:500,offsetMs:0}});if(trigger==='manual')s.controller.manualStart();else s.fire();await flush();await s.controller.stop();await vi.advanceTimersByTimeAsync(1000);expect(s.players[0]!.play).not.toHaveBeenCalled();expect(s.leases.every(lease=>lease.released)).toBe(true);
  });
  it('曲変更・方式変更後に前試行のタイマーが新曲を再生しない',async()=>{
    const s=setup();await s.prepare({...input('vocal'),compensation:{mode:'wait',waitMs:500,offsetMs:0}});s.fire();await flush();
    const song={videoId:'dQw4w9WgXcQ',title:'次曲',artist:'',profiles:{HOME:{input:{...input('manual'),videoId:'dQw4w9WgXcQ'},retainMic:true}}};
    const next=await selectSong(s.controller,song,'HOME','real');await s.prepare(next.input);await vi.advanceTimersByTimeAsync(600);expect(s.players[0]!.play).not.toHaveBeenCalled();expect(s.players[1]!.play).not.toHaveBeenCalled();s.controller.manualStart();await flush();expect(s.players[1]!.play).toHaveBeenCalledTimes(1);await s.controller.stop();
  });
  it('初回待機中に一時停止し再開しても個別開始位置は適用し二重要求しない',async()=>{
    const s=setup();await s.prepare({...input('manual'),compensation:{mode:'wait',waitMs:500,offsetMs:0}});s.controller.manualStart();await s.controller.pause();s.controller.resume();await flush();expect(s.players[0]!.seek).toHaveBeenCalledExactlyOnceWith(10);expect(s.players[0]!.play).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(1000);expect(s.players[0]!.play).toHaveBeenCalledTimes(1);await s.controller.stop();
  });
  it('再生後の明示的な一時停止・再生は初回トリガーを再検知せず別要求として記録する',async()=>{
    const s=setup();await s.prepare(input('manual'));s.controller.manualStart();await flush();s.players[0]!.emit({type:'playing'});await flush();await s.controller.pause();s.controller.resume();s.controller.manualStart();await flush();expect(s.players[0]!.play).toHaveBeenCalledTimes(2);expect(s.players[0]!.seek).toHaveBeenCalledTimes(1);expect(s.controller.exportTrials().trials[0]).toMatchObject({initialRequests:1,resumeRequests:1});await s.controller.stop();
  });
});

describe('比較JSONの観測と結果',()=>{
  it('準備時設定を固定し各時刻とAPI遅延を記録する',async()=>{
    const s=setup(false);const value={...input('vocal'),offsetSec:0.1,startAdjustmentMs:10};await s.prepare(value);value.vocalPositionSec=999;await vi.advanceTimersByTimeAsync(20);s.fire();await flush();await vi.advanceTimersByTimeAsync(150);s.players[0]!.emit({type:'playing'});await flush();
    const exported=s.controller.exportTrials();const trial=exported.trials[0]!;expect(trial.input.vocalPositionSec).toBe(20);expect(trial.seekSec).toBe(20.11);expect(trial.triggerToRequestMs).toBe(0);expect(trial.requestToPlayingMs).toBe(150);expect(trial.triggerToPlayingMs).toBe(150);expect(trial.retainMicRequested).toBe(false);expect(trial.microphoneReleasedMs).toBeDefined();expect(exported.clock).toContain('not measured');
    trial.input.savedPositionSec=500;expect(s.controller.exportTrials().trials[0]!.input.savedPositionSec).toBe(10);await s.controller.stop();expect(s.controller.exportTrials().trials[0]).toMatchObject({outcome:'api-playing',cleanupComplete:true});
  });
  it.each([['blocked','blocked'],['error','failed']] as const)('%sを成功としない',(async(type,outcome)=>{const s=setup();await s.prepare(input('manual'));s.controller.manualStart();await flush();s.players[0]!.emit({type,message:'test'});await flush();expect(s.controller.exportTrials().trials[0]!.outcome).toBe(outcome);expect(s.controller.exportTrials().trials[0]!.playingConfirmedMs).toBeUndefined();}));
  it('BUFFERINGだけでは成功とせずPLAYING期限切れを記録する',async()=>{const s=setup();await s.prepare(input('manual'));s.controller.manualStart();await flush();s.players[0]!.emit({type:'buffering'});await vi.advanceTimersByTimeAsync(sessionOptions.playingTimeoutMs);expect(s.controller.exportTrials().trials[0]!.outcome).toBe('timeout');});
  it('プレイヤー作成失敗も試行失敗として記録する',async()=>{const controller=new SessionController({createPlayer:()=>{throw new Error('create failed');},audio:{acquire:vi.fn()},createDetector:()=>new SustainedVolumeDetector()});await controller.prepare(input('manual'));expect(controller.exportTrials().trials[0]).toMatchObject({outcome:'failed',termination:'create failed'});});
  it('上限30試行と破棄件数を明示する',async()=>{const s=setup();for(let i=0;i<32;i++){await s.controller.prepare({...input('manual'),playbackMode:'legacy'});await s.controller.stop();}expect(s.controller.exportTrials().trials).toHaveLength(30);expect(s.controller.exportTrials().dropped).toBe(2);});
});

describe('v3保存と旧データ保護',()=>{
  it.each(['DAM','JOYSOUND','HOME'] as const)('%sの全トリガー位置・補正をv3保存・復元する',service=>{
    const st=storage();const store=new SongLibrary(st,3);const p={input:{...input('vocal'),service,startAdjustmentMs:100},retainMic:false};
    store.commit(upsertSong(emptyLibrary(),{videoId:id,title:'試験',artist:'',profiles:{[service]:p}}));
    expect(new SongLibrary(st,3).snapshot().songs[0]!.profiles[service]).toEqual(p);expect(parseImport(store.export()).library.songs[0]!.profiles[service]).toEqual(p);
    expect(JSON.parse(store.export())).toMatchObject({format:'karaokesync-library-v3',version:3});expect(st.data.has(libraryV3Key)).toBe(true);expect(st.data.has(libraryV2Key)).toBe(false);expect(st.data.has(libraryKey)).toBe(false);
  });
  it.each([1,2] as const)('旧v%sを読取で引き継ぎ初回保存も元キーを変更しない',version=>{
    const st=storage();const old=new SongLibrary(st,version);const original={...input(),vocalPositionSec:undefined,cuePositionSec:undefined};old.commit(upsertSong(emptyLibrary(),{videoId:id,title:'旧曲',artist:'',profiles:{HOME:{input:original,retainMic:false}}}));
    const before=[...st.data];const next=new SongLibrary(st,3);expect([...st.data]).toEqual(before);expect(selectedTrigger(next.snapshot().songs[0]!.profiles.HOME!.input)).toBe('accompaniment');
    const changed=next.snapshot();changed.songs[0]!.profiles.HOME!.input.startTrigger='manual';next.commit(changed);for(const [key,value]of before)expect(st.getItem(key)).toBe(value);
    expect(new SongLibrary(st,version).snapshot().songs[0]!.profiles.HOME!.input.startTrigger).toBeUndefined();
  });
  it('v3空リストから旧曲を自動復活させない・破損v3から黙って戻らない',()=>{
    const st=storage();const old=new SongLibrary(st,2);old.commit(upsertSong(emptyLibrary(),{videoId:id,title:'旧曲',artist:'',profiles:{}}));const next=new SongLibrary(st,3);next.commit(emptyLibrary());expect(new SongLibrary(st,3).snapshot().songs).toEqual([]);
    st.data.set(libraryV3Key,'broken');expect(()=>new SongLibrary(st,3)).toThrow();expect(st.getItem(libraryV2Key)).not.toBeNull();
  });
  it('移行前に別タブがv2を書き換えたらv3へ黙って保存しない',()=>{
    const st=storage();const next=new SongLibrary(st,3);new SongLibrary(st,2).commit(emptyLibrary());expect(()=>next.commit(emptyLibrary())).toThrow('別タブ');expect(st.getItem(libraryV3Key)).toBeNull();
  });
  it('DAMだけ復元するとJOYSOUND・HOME設定を保持する',()=>{
    const current=upsertSong(emptyLibrary(),{videoId:id,title:'曲',artist:'',profiles:{DAM:{input:{...input('manual'),service:'DAM'},retainMic:true},JOYSOUND:{input:{...input('cue'),service:'JOYSOUND'},retainMic:false},HOME:{input:input('vocal'),retainMic:true}}});
    const incoming=structuredClone(current);incoming.songs[0]!.profiles.DAM!.input.startTrigger='cue';const choices=importChoices(current,incoming);choices[0]!.profiles={DAM:true,JOYSOUND:false,HOME:false};const merged=mergeImport(current,incoming,choices);
    expect(merged.songs[0]!.profiles.DAM!.input.startTrigger).toBe('cue');expect(merged.songs[0]!.profiles.JOYSOUND).toEqual(current.songs[0]!.profiles.JOYSOUND);expect(merged.songs[0]!.profiles.HOME).toEqual(current.songs[0]!.profiles.HOME);
  });
  it('手入力動画の設定もv2からv3へ読取移行し旧設定を保つ',()=>{
    const st=storage();saveSyncProfile(st,{input:input(),retainMic:false},2);const old=st.getItem(preferencesV2Key);expect(selectedTrigger(loadSyncProfile(st,id,'HOME',3)!.input)).toBe('accompaniment');
    saveSyncProfile(st,{input:input('cue'),retainMic:true},3);expect(st.getItem(preferencesV2Key)).toBe(old);expect(st.getItem(preferencesV3Key)).not.toBeNull();expect(loadSyncProfile(st,id,'HOME',3)!.input.startTrigger).toBe('cue');
  });
  it('旧HTML0.6とReactv2のトリガー未指定を伴奏検知として取り込む',()=>{
    const old=parseImport(JSON.stringify({appName:'Karaoke Sync',backupVersion:'0.6',songs:[{videoId:id,savedSec:'12',songInfo:{title:'曲',artist:'',service:'DAM'},detectSettings:{threshold:0.1,offset:0}}]}));expect(selectedTrigger(old.library.songs[0]!.profiles.DAM!.input)).toBe('accompaniment');
    const st=storage();const store=new SongLibrary(st,2);store.commit(old.library);expect(selectedTrigger(parseImport(store.export()).library.songs[0]!.profiles.DAM!.input)).toBe('accompaniment');
  });
  it('不正トリガーを含むv3全体を拒否し既存データを変更しない',()=>{
    const st=storage();const store=new SongLibrary(st,3);store.commit(upsertSong(emptyLibrary(),{videoId:id,title:'曲',artist:'',profiles:{HOME:{input:input('manual'),retainMic:true}}}));const before=st.getItem(libraryV3Key);const json=JSON.parse(store.export());json.songs[0].profiles.HOME.input.startTrigger='recognize-voice';expect(()=>parseImport(JSON.stringify(json))).toThrow('開始トリガー');expect(st.getItem(libraryV3Key)).toBe(before);
  });
});

describe('日本語UIと誤解防止',()=>{
  it.each(startTriggers)('%sの選択と位置欄を表示し音声認識と誤認させない',startTrigger=>{
    const change=vi.fn();const html=renderToStaticMarkup(createElement(StartTriggerSettings,{input:input(startTrigger),disabled:false,onChange:change}));for(const title of ['伴奏検知','歌声検知'])expect(html).toContain(title);
    expect(html).toContain('話者を識別しません');expect(html).not.toContain('<option value="cue"');expect(html).not.toContain('<option value="manual"');expect(change).not.toHaveBeenCalled();
  });
  it('待機中はモード変更を無効にし旧比較JSONは診断パネルに保持する',()=>{
    vi.stubGlobal('localStorage',storage());const app=createApp('simulation');vi.spyOn(app.controller,'getSnapshot').mockReturnValue({...app.controller.getSnapshot(),phase:'armed',canPrepare:false});const html=renderToStaticMarkup(createElement(App,app));expect(html).toMatch(/<fieldset disabled=""><label>検知モード/);expect(html).toContain('開始トリガー比較JSONを保存');expect(html).toContain('Bluetooth発音・同期精度');
  });
  it('設定読込・表示だけではv3への書込をしない',()=>{const st=storage();vi.stubGlobal('localStorage',st);const html=renderToStaticMarkup(createElement(App,createApp('simulation')));expect(html).toContain('マイク音量');expect(html).toContain('しきい値を測定・提案');expect(st.setItem).not.toHaveBeenCalled();});
});
