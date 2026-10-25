import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { defaultDetectionProfile, existingDetectionProfile, withDetectionProfile, detectionModes } from '../src/app/detectionModes';
import { saveSyncProfile, loadSyncProfile } from '../src/app/preferences';
import { playbackPlan, validateInput, triggerPosition, type SyncInput } from '../src/domain/sync';
import { liveRecommendation, captureStartPosition, type LiveResult } from '../src/domain/liveRecommendation';
import { defaultProfile, emptyLibrary, SongLibrary, type Library } from '../src/library/model';
import { parseImport, mergeImport, importChoices } from '../src/library/backup';
import { planAudioSettings } from '../src/library/audioSettings';
import { SessionController } from '../src/session/controller';
import { SimulatedLease, SimulatedPlayer } from '../src/adapters/simulation';
import { SustainedVolumeDetector } from '../src/domain/detector';
import { sessionOptions } from '../src/config/settings';
import { App } from '../src/ui/App';
import { createApp } from '../src/app/createApp';
const a='M7lc1UVf-VE', b='dQw4w9WgXcQ';
const fresh=(mode:'vocal'|'accompaniment'='vocal'):SyncInput=>({...defaultDetectionProfile(a,'DAM',mode,'simulation').input,savedPositionSec:30,vocalPositionSec:30});
const storage=()=>{const data=new Map<string,string>();return {data,getItem:(key:string)=>data.get(key)??null,setItem:vi.fn((key:string,value:string)=>data.set(key,value))};};
async function flush(){for(let i=0;i<70;i++)await Promise.resolve();}
function setup(){const player=new SimulatedPlayer(),lease=new SimulatedLease();const seek=vi.spyOn(player,'seek'),play=vi.spyOn(player,'play');const controller=new SessionController({createPlayer:()=>player,audio:{acquire:async()=>lease},createDetector:()=>new SustainedVolumeDetector()},undefined,{...sessionOptions});return {player,lease,seek,play,controller};}
beforeEach(()=>vi.useFakeTimers());
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();});
describe('設定時間だけを共通で自動補正',()=>{
  it.each(detectionModes)('%sは0/100/200/300/500msに連動し基準を書き換えない',mode=>{
    for(const durationMs of [0,100,200,300,500]){const value={...fresh(mode),durationMs};expect(playbackPlan(value)).toMatchObject({seekSec:30+durationMs/1000,detectionMs:durationMs,waitMs:0});expect(triggerPosition(value)).toBe(30);}
  });
  it.each([undefined,false])('既存未指定/%sはOFFで従来位置を維持',flag=>{expect(playbackPlan({...fresh(),autoCompensateDetectionDuration:flag,offsetSec:-.1,startAdjustmentMs:-50})).toMatchObject({seekSec:29.85,detectionMs:0});});
  it.each([-500,500])('手動補正%ims・B・安定化待機を一度ずつ適用',startAdjustmentMs=>{expect(playbackPlan({...fresh(),offsetSec:-.1,startAdjustmentMs,stabilizationWaitMs:300,compensation:{mode:'combined',offsetMs:50,waitMs:100}})).toMatchObject({seekSec:30.45+startAdjustmentMs/1000,waitMs:400,userPositionMs:30150+startAdjustmentMs});});
  it('負位置の不足を待機に変換し0秒を下回らない',()=>{expect(playbackPlan({...fresh(),vocalPositionSec:.1,offsetSec:-.5})).toMatchObject({rawMs:-200,seekSec:0,waitMs:200});});
  it.each([null,1,'true'])('不正フラグ%sを拒否',flag=>{expect(()=>validateInput({...fresh(),autoCompensateDetectionDuration:flag} as unknown as SyncInput)).toThrow('自動補正');});
  it.each(['cue','manual'] as const)('廃止UIの%sへ自動補正を追加しない',startTrigger=>{expect(playbackPlan({...fresh(),startTrigger,cuePositionSec:30})).toMatchObject({seekSec:30,detectionMs:0});});
  it.each(detectionModes)('%sのlegacy/preplay/事前シークが同じ補正位置を使う',async mode=>{
    for(const playbackMode of ['legacy','preplay'] as const)for(const preseek of [false,true]){
      if(playbackMode==='legacy'&&preseek)continue;
      const s=setup();await s.controller.prepare({...fresh(mode),playbackMode,preseekBeforeDetection:preseek});
      if(playbackMode==='preplay'){s.player.emit({type:'playing'});await flush();if(preseek)await vi.advanceTimersByTimeAsync(100);await flush();}
      expect(s.controller.getSnapshot().phase).toBe('armed');
      if(preseek)expect(s.seek).toHaveBeenCalledExactlyOnceWith(30.2);
      for(const timeMs of [0,100,199])s.lease.sample({rms:.5,timeMs});await flush();expect(s.play).not.toHaveBeenCalled();
      s.lease.sample({rms:.5,timeMs:200});s.lease.sample({rms:.5,timeMs:250});await flush();
      expect(s.seek).toHaveBeenCalledExactlyOnceWith(30.2);expect(s.play).toHaveBeenCalledTimes(1);
      expect(s.controller.exportTrials().trials[0]!.input.vocalPositionSec).toBe(30);await s.controller.stop();
    }
  });
  it.each([0,200])('継続%imsでも動画長へ開始位置を制限する',async durationMs=>{const s=setup();s.player.videoDuration=30.1;await s.controller.prepare({...fresh('accompaniment'),savedPositionSec:31,durationMs});s.lease.sample({rms:.5,timeMs:0});s.lease.sample({rms:.5,timeMs:100});s.lease.sample({rms:.5,timeMs:200});await flush();expect(s.seek).toHaveBeenCalledExactlyOnceWith(30.1);await s.controller.stop();});
  it('実サンプルが設定時間を超過しても設定200msだけ加算する',async()=>{const s=setup();await s.controller.prepare(fresh());for(const timeMs of [0,90,180,270])s.lease.sample({rms:.5,timeMs});await flush();expect(s.seek).toHaveBeenCalledExactlyOnceWith(30.2);await s.controller.stop();});
});

describe('新規ON・既存OFF・モード別v4永続化',()=>{
 it.each(['DAM','JOYSOUND','HOME'] as const)('%sで両モードの値とON/OFFを独立保存・復元',service=>{
   const s=storage();let container;
   for(const mode of detectionModes){const input={...fresh(mode),service,autoCompensateDetectionDuration:mode==='vocal',threshold:mode==='vocal'?.035:.08,durationMs:mode==='vocal'?100:300,offsetSec:mode==='vocal'?-.5:.6};container=withDetectionProfile(container,{input,retainMic:mode==='vocal'});}
   saveSyncProfile(s,container!,4);const loaded=loadSyncProfile(s,a,service,4)!;
   for(const mode of detectionModes){const saved=existingDetectionProfile(loaded,mode)!;expect(saved.input.autoCompensateDetectionDuration).toBe(mode==='vocal');expect(saved.input.threshold).toBe(mode==='vocal'?.035:.08);expect(playbackPlan(saved.input).seekSec).toBe(mode==='vocal'?29.6:30.6);}
   const store=new SongLibrary(s,4);store.commit({...emptyLibrary(),songs:[{videoId:a,title:'曲',artist:'歌手',profiles:{[service]:loaded}}]});
   const imported=parseImport(store.export()).library;expect(mergeImport(emptyLibrary(),imported,importChoices(emptyLibrary(),imported))).toEqual(store.snapshot());
 });
 it.each([1,2,3,4] as const)('旧v%iの未指定を読み取り時にONへ変更せず元キーを維持',version=>{
   const s=storage(),store=new SongLibrary(s,version),old=defaultProfile(a,'DAM');old.input.savedPositionSec=30;
   if(version===4)Object.assign(old,{modeProfiles:{vocal:{input:{...old.input,startTrigger:'vocal',vocalPositionSec:30},retainMic:true}}});
   store.commit({...emptyLibrary(),songs:[{videoId:a,title:'旧曲',artist:'',profiles:{DAM:old}}]});const before=[...s.data];
   const restored=new SongLibrary(s,4).snapshot().songs[0]!.profiles.DAM!;
   const mode=version===4?'vocal':'accompaniment';expect(playbackPlan(existingDetectionProfile(restored,mode)!.input).seekSec).toBe(30);
   expect([...s.data]).toEqual(before);const imported=parseImport(store.export()).library;expect(playbackPlan(existingDetectionProfile(imported.songs[0]!.profiles.DAM!,mode)!.input).seekSec).toBe(30);
 });
});
function library():Library {
 return {...emptyLibrary(),songs:[a,b].map((videoId,index)=>({videoId,title:'曲'+index,artist:'歌手',accompanimentRef:'https://youtu.be/'+videoId,profiles:Object.fromEntries((index===0?['DAM','JOYSOUND','HOME']:['DAM']).map(service=>{
   let profile=withDetectionProfile(undefined,{input:{...fresh(),videoId,service:service as 'DAM',vocalPositionSec:10+index,autoCompensateDetectionDuration:false,startAdjustmentMs:-500,armedTimeoutMs:60000,liveApplied:[{resultId:'saved',totalMs:50}]},retainMic:false});
   profile=withDetectionProfile(profile,{input:{...fresh('accompaniment'),videoId,service:service as 'DAM',savedPositionSec:70},retainMic:true});return [service,profile];}))} ))};
}
describe('既存計画と単一コミットを使う一括適用A/B',()=>{
 it.each(detectionModes)('%sのAは2項目のみ、Bは同期項目もコピーし他モード・アーカイブ・履歴を保護',mode=>{
   const original=library(),before=structuredClone(original),source={...fresh(mode),durationMs:300,threshold:.077,offsetSec:-1.2,startAdjustmentMs:123,stabilizationWaitMs:400,preseekBeforeDetection:true,playbackMode:'preplay' as const,compensation:{mode:'combined' as const,waitMs:50,offsetMs:-80}};
   for(const scope of ['audio','sync']){
     const plan=planAudioSettings(original,source,undefined,mode,scope==='sync'?source:undefined);
     expect(plan).toMatchObject({songCount:2,profileCount:4,serviceCounts:{DAM:2,JOYSOUND:1,HOME:1},scope});
     for(const [index,song] of plan.library.songs.entries())for(const [service,profile] of Object.entries(song.profiles)){
       const old=before.songs[index]!.profiles[service as 'DAM']!;expect({...profile,modeProfiles:undefined}).toEqual({...old,modeProfiles:undefined});
       const other=mode==='vocal'?'accompaniment':'vocal';expect(profile.modeProfiles![other]).toEqual(old.modeProfiles![other]);
       const saved=existingDetectionProfile(profile,mode)!;const expected={...old.modeProfiles![mode]!.input,threshold:.077,durationMs:300};
       if(scope==='sync')Object.assign(expected,{offsetSec:-1.2,startAdjustmentMs:123,stabilizationWaitMs:400,preseekBeforeDetection:true,playbackMode:'preplay',compensation:source.compensation,autoCompensateDetectionDuration:true,[mode==='vocal'?'vocalPositionSec':'savedPositionSec']:30});
       expect(saved.input).toEqual(expected);expect(saved.retainMic).toBe(old.modeProfiles![mode]!.retainMic);
     }
     expect(plan.library.songs[1]!.profiles.JOYSOUND).toBeUndefined();expect(original).toEqual(before);
   }
 });
 it('存在しないモードの保存枠を増やさない',()=>{const current=library();current.songs[1]!.profiles.DAM=withDetectionProfile(undefined,{input:{...fresh('accompaniment'),videoId:b},retainMic:true});const plan=planAudioSettings(current,fresh(),undefined,'vocal',fresh());expect(plan.profileCount).toBe(3);expect(plan.library.songs[1]).toEqual(current.songs[1]);});
 it.each(['audio','sync'])('%sの取消・保存失敗でメモリも永続データも部分更新しない',scope=>{const s=storage(),store=new SongLibrary(s,4);store.commit(library());const before=[...s.data],snapshot=store.snapshot();s.setItem.mockClear();const plan=planAudioSettings(snapshot,fresh(),undefined,'vocal',scope==='sync'?fresh():undefined);expect([...s.data]).toEqual(before);expect(s.setItem).not.toHaveBeenCalled();s.setItem.mockImplementationOnce(()=>{throw Error('quota');});expect(()=>store.commit(plan.library)).toThrow('quota');expect(store.snapshot()).toEqual(snapshot);expect([...s.data]).toEqual(before);store.commit(plan.library);expect(new SongLibrary(s,4).snapshot()).toEqual(plan.library);});
 it('Bはモード不一致・不正な同期入力を拒否する',()=>{expect(()=>planAudioSettings(library(),fresh(),undefined,'accompaniment',fresh())).toThrow('一致');expect(()=>planAudioSettings(library(),fresh(),undefined,'vocal',{...fresh(),startAdjustmentMs:Infinity})).toThrow();});
});

describe('±5秒と次回保存の重複防止',()=>{
 it.each([-5000,-1000,-100,-50,50,100,1000,5000])('%imsを現在位置にseekし表示用の値と保存差分へ反映',async delta=>{const s=setup();await s.controller.prepare({...fresh(),durationMs:0});s.lease.sample({rms:.5,timeMs:0});await flush();s.player.emit({type:'playing',requestId:s.player.requestId});s.player.currentPosition=10;s.controller.adjustLive(delta);expect(s.seek).toHaveBeenLastCalledWith(10+delta/1000);expect((await s.controller.displayPlaybackObservation())!.position).toBe(10+delta/1000);expect(s.controller.getSnapshot().liveAdjustmentMs).toBe(delta);expect(s.play).toHaveBeenCalledTimes(1);await s.controller.stop();});
 it.each([[2,-5000,0,-2000],[238,5000,240,2000]])('端%sで%imsを範囲制限する',async(current,delta,target,applied)=>{const s=setup();await s.controller.prepare({...fresh(),durationMs:0});s.lease.sample({rms:.5,timeMs:0});await flush();s.player.emit({type:'playing',requestId:s.player.requestId});s.player.currentPosition=current;s.controller.adjustLive(delta);expect(s.seek).toHaveBeenLastCalledWith(target);expect(s.controller.getSnapshot().liveAdjustmentMs).toBe(applied);await s.controller.stop();});
 it('無効値・再生中以外は5秒シークしない',async()=>{const s=setup();s.controller.adjustLive(5000);await s.controller.prepare({...fresh(),durationMs:0});s.controller.adjustLive(5000);expect(s.seek).not.toHaveBeenCalled();s.lease.sample({rms:.5,timeMs:0});await flush();s.player.emit({type:'playing',requestId:s.player.requestId});s.seek.mockClear();for(const delta of [5001,-5001,NaN,.5])s.controller.adjustLive(delta);expect(s.seek).not.toHaveBeenCalled();await s.controller.pause();s.controller.adjustLive(5000);expect(s.seek).not.toHaveBeenCalled();await s.controller.stop();});
 it('自動補正を基準へ焼き込まず次回推奨を一度だけ採用',()=>{const input=fresh(),result:LiveResult={id:'run:1',input,totalMs:5000,retainMic:true,operations:1};const first=liveRecommendation(result,input).next;expect(playbackPlan(first).seekSec).toBe(35.2);expect(first.vocalPositionSec).toBe(30);expect(liveRecommendation(result,JSON.parse(JSON.stringify(first))).remainingMs).toBe(0);});
 it.each([true,false])('今合ってる保存は自動補正%s・Sを再加算せずリアルタイム結果も採用済みにする',flag=>{const input={...fresh(),autoCompensateDetectionDuration:flag,stabilizationWaitMs:300},result:LiveResult={id:'run:1',input,totalMs:5000,retainMic:true,operations:1};const captured=captureStartPosition(input,42.25,result);expect(playbackPlan(captured).seekSec).toBe(42.25);expect(playbackPlan(captureStartPosition(captured,42.25,result)).seekSec).toBe(42.25);expect(liveRecommendation(result,JSON.parse(JSON.stringify(captured))).remainingMs).toBe(0);expect(captured.vocalPositionSec).toBe(30);});
 it('初期UIに保存は1つ、Aが既定・新規ON・大小の補正が共存',()=>{vi.stubGlobal('localStorage',storage());const html=renderToStaticMarkup(createElement(App,createApp('simulation')));expect(html.match(/>この設定を保存<\/button>/g)).toHaveLength(1);expect(html).toContain('この設定をすべての曲に適用');expect(html).toContain('value="audio" selected');expect(html).toContain('＋0.20秒（200ms）');for(const label of ['−5秒','＋5秒','−0.05秒','＋0.05秒','−0.1秒','＋0.1秒','−1秒','＋1秒'])expect(html).toContain(label);});
});
