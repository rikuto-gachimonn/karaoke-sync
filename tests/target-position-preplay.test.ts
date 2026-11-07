import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionController } from '../src/session/controller';
import { prepositionWhilePaused } from '../src/session/preposition';
import { SimulatedPlayer, SimulatedLease } from '../src/adapters/simulation';
import { SustainedVolumeDetector } from '../src/domain/detector';
import { defaultDetectionProfile, type DetectionMode } from '../src/app/detectionModes';
import { playbackPlan } from '../src/domain/sync';
const id='dQw4w9WgXcQ';
const flush=async()=>{for(let i=0;i<100;i++)await Promise.resolve();};
class CuedPlayer extends SimulatedPlayer { async prepare(_id='',start=0){this.currentPosition=start;} }
function setup(mode:DetectionMode='vocal',position=32,enabled=true){
 const player=new CuedPlayer(),lease=new SimulatedLease(),detector=new SustainedVolumeDetector();
 const prepare=vi.spyOn(player,'prepare'),pause=vi.spyOn(player,'pause'),seek=vi.spyOn(player,'seek'),play=vi.spyOn(player,'play'),arm=vi.spyOn(detector,'arm'),acquire=vi.fn(async()=>lease);
 const controller=new SessionController({createPlayer:()=>player,audio:{acquire},createDetector:()=>detector});
 const input={...defaultDetectionProfile(id,'DAM',mode).input,savedPositionSec:mode==='accompaniment'?position:99,vocalPositionSec:mode==='vocal'?position:99,preseekBeforeDetection:enabled};
 return{controller,player,lease,prepare,pause,seek,play,arm,acquire,input,fire:async()=>{for(const timeMs of [0,100,200])lease.sample({rms:.5,timeMs});await flush();}};
}
async function manuallyPause(s:ReturnType<typeof setup>){s.player.emit({type:'playing'});await flush();}
beforeEach(()=>vi.useFakeTimers());afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();});
describe('目的位置からの事前手動再生',()=>{
 it.each([['vocal',2],['vocal',32],['vocal',60],['accompaniment',2],['accompaniment',32],['accompaniment',60]] as const)('%sの%s秒は補正後位置から準備し、即時一時停止・検知・再開する',async(mode,position)=>{
  const s=setup(mode,position),before=structuredClone(s.input),target=position+.2;
  await s.controller.prepare(s.input);expect(s.prepare).toHaveBeenCalledExactlyOnceWith(id,target);expect(s.controller.getSnapshot().phase).toBe('preplay');expect(s.acquire).not.toHaveBeenCalled();expect(s.play).not.toHaveBeenCalled();
  await manuallyPause(s);expect(s.pause).toHaveBeenCalledTimes(1);expect(s.player.playbackState).toBe('paused');expect(s.arm).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(100);expect(s.controller.getSnapshot().phase).toBe('armed');expect(s.seek).not.toHaveBeenCalled();expect(s.player.currentPosition).toBe(target);
  await s.fire();expect(s.play).toHaveBeenCalledTimes(1);expect(s.seek).not.toHaveBeenCalled();expect(s.controller.log.snapshot().some(e=>e.event==='player.seek.reused')).toBe(true);expect(s.input).toEqual(before);await s.controller.stop();
 });
 it('比較OFFは0秒から従来どおり準備し、検知後にシークする',async()=>{
  const s=setup('vocal',32,false);await s.controller.prepare(s.input);expect(s.prepare).toHaveBeenCalledWith(id,0);await manuallyPause(s);expect(s.controller.getSnapshot().phase).toBe('armed');expect(s.seek).not.toHaveBeenCalled();await s.fire();expect(s.seek).toHaveBeenCalledExactlyOnceWith(32.2);expect(s.play).toHaveBeenCalledTimes(1);await s.controller.stop();
 });
 it('正負補正・B・安定化待機も既存planの位置を使い二重加算しない',async()=>{
  const s=setup();Object.assign(s.input,{offsetSec:-.1,startAdjustmentMs:-100,stabilizationWaitMs:100,compensation:{mode:'combined',waitMs:50,offsetMs:50}});const plan=playbackPlan(s.input);await s.controller.prepare(s.input);expect(s.prepare).toHaveBeenCalledWith(id,plan.seekSec);await manuallyPause(s);await vi.advanceTimersByTimeAsync(100);await s.fire();expect(s.play).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(plan.waitMs);expect(s.play).toHaveBeenCalledTimes(1);expect(s.seek).not.toHaveBeenCalled();await s.controller.stop();
 });
 it('一時停止時に進みすぎていた場合だけ検知前に位置を直す',async()=>{
  const s=setup();await s.controller.prepare(s.input);s.player.currentPosition=32.7;await manuallyPause(s);expect(s.seek).toHaveBeenCalledExactlyOnceWith(32.2);await vi.advanceTimersByTimeAsync(100);expect(s.controller.getSnapshot().phase).toBe('armed');await s.fire();expect(s.seek).toHaveBeenCalledTimes(1);await s.controller.stop();
 });
 it('確認中に位置が遅れてずれた場合も一度だけ補正する',async()=>{
  const s=setup();await s.controller.prepare(s.input);await manuallyPause(s);expect(s.seek).not.toHaveBeenCalled();s.player.currentPosition=33;await vi.advanceTimersByTimeAsync(150);expect(s.seek).toHaveBeenCalledExactlyOnceWith(32.2);expect(s.controller.getSnapshot().phase).toBe('armed');await s.controller.stop();
 });
 it('負の開始候補は0秒で準備し、検知後の不足待機を維持',async()=>{
  const s=setup('vocal',0);s.input.startAdjustmentMs=-1000;await s.controller.prepare(s.input);expect(s.prepare).toHaveBeenCalledWith(id,0);await manuallyPause(s);await vi.advanceTimersByTimeAsync(100);await s.fire();await vi.advanceTimersByTimeAsync(799);expect(s.play).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(1);expect(s.play).toHaveBeenCalledTimes(1);expect(s.seek).not.toHaveBeenCalled();await s.controller.stop();
 });
 it('準備後に分かる動画長で位置確認と検知後の位置を上限に制限',async()=>{
  const s=setup('vocal',60);s.player.videoDuration=40;await s.controller.prepare(s.input);await manuallyPause(s);await vi.advanceTimersByTimeAsync(100);expect(s.player.currentPosition).toBe(40);await s.fire();expect(s.seek).toHaveBeenCalledExactlyOnceWith(40);await s.controller.stop();
 });
 it.each(['position','buffering'] as const)('%sが確認できなければ検知待機へ進まず資源を解放',async reason=>{
  const s=setup();await s.controller.prepare(s.input);if(reason==='position')vi.spyOn(s.player,'position').mockReturnValue(0);await manuallyPause(s);if(reason==='buffering')s.player.playbackState='other';await vi.advanceTimersByTimeAsync(2500);expect(s.controller.getSnapshot().phase).toBe('error');expect(s.arm).not.toHaveBeenCalled();expect(s.play).not.toHaveBeenCalled();expect(s.player.disposed).toBe(true);expect(s.lease.released).toBe(true);expect(vi.getTimerCount()).toBe(0);
 });
 it.each(['blocked','error'] as const)('%sでも従来の安全な終了を維持',async type=>{
  const s=setup();await s.controller.prepare(s.input);s.player.emit({type,message:'restricted'});await flush();expect(s.controller.getSnapshot().phase).toBe('error');expect(s.acquire).not.toHaveBeenCalled();expect(s.arm).not.toHaveBeenCalled();expect(s.play).not.toHaveBeenCalled();
 });
 it('再生イベントだけで現在状態を確認できなければ検知しない',async()=>{
  const s=setup();await s.controller.prepare(s.input);vi.spyOn(s.player,'readPlaybackState').mockResolvedValue('other');await manuallyPause(s);expect(s.controller.getSnapshot().phase).toBe('preplay');expect(s.acquire).not.toHaveBeenCalled();expect(s.arm).not.toHaveBeenCalled();await s.controller.stop();
 });
 it('位置確認中の停止を遅着結果で取り消さない',async()=>{
  const s=setup();await s.controller.prepare(s.input);await manuallyPause(s);await s.controller.stop();await vi.advanceTimersByTimeAsync(3000);expect(s.controller.getSnapshot().phase).toBe('idle');expect(s.arm).not.toHaveBeenCalled();expect(s.play).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
 });
 it('既に目的位置ならPAUSEDを2回確認してシークせず完了',async()=>{
  const player=new CuedPlayer();player.playbackState='paused';player.currentPosition=32.25;const seek=vi.spyOn(player,'seek');const pending=prepositionWhilePaused(player,32.2,new AbortController().signal);await flush();await vi.advanceTimersByTimeAsync(100);expect(await pending).toBe(32.25);expect(seek).not.toHaveBeenCalled();
 });
});
