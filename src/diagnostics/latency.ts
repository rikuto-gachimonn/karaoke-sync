import {selectedTrigger,triggerPosition,validateInput} from '../domain/sync';
import type {TriggerTrial} from './trials';
import {statistics} from '../youtube-probe/statistics';
export function latencySummary(trials:TriggerTrial[]) {
  const groups=new Map<string,{total:number;failed:number;request:number[];playing:number[];afterRequest:number[]}>();
  for(const trial of trials){
    const input=trial.input;
    const key=JSON.stringify({comparisonContext:trial.comparisonContext,videoId:input.videoId,service:input.service,trigger:selectedTrigger(input),positionSec:triggerPosition(input),offsetSec:input.offsetSec,startAdjustmentMs:input.startAdjustmentMs??0,compensation:input.compensation??{mode:'baseline',waitMs:0,offsetMs:0},stabilizationWaitMs:input.stabilizationWaitMs??0,preseekBeforeDetection:input.preseekBeforeDetection??false,threshold:input.threshold,durationMs:input.durationMs,playbackMode:input.playbackMode??'legacy',retainMic:trial.retainMicRequested});
    let group=groups.get(key);if(!group){group={total:0,failed:0,request:[],playing:[],afterRequest:[]};groups.set(key,group);}group.total++;
    if(trial.triggerMs===undefined||trial.playRequestMs===undefined||trial.playingConfirmedMs===undefined){group.failed++;continue;}
    const values=[trial.playRequestMs-trial.triggerMs,trial.playingConfirmedMs-trial.triggerMs,trial.playingConfirmedMs-trial.playRequestMs];
    if(values.some(value=>!Number.isFinite(value)||value<0)){group.failed++;continue;}
    group.request.push(values[0]!);group.playing.push(values[1]!);group.afterRequest.push(values[2]!);
  }
  const describe=(values:number[])=>{const summary=statistics(values);return summary?{...summary,mean:values.reduce((a,b)=>a+b,0)/values.length,min:Math.min(...values),range:Math.max(...values)-Math.min(...values)}:null;};
  return {note:'同じ設定のAPI観測値だけを比較。実発音・Bluetooth経路は未測定。標準偏差は母標準偏差。少数試行で安定化効果を判定しない。',groups:[...groups].map(([key,value])=>({configuration:JSON.parse(key),total:value.total,incompleteOrFailed:value.failed,warning:value.playing.length<20?'有効試行20未満：探索的な参考値':'実機条件・試験順序を揃えて比較してください',triggerToRequestMs:describe(value.request),triggerToPlayingMs:describe(value.playing),requestToPlayingMs:describe(value.afterRequest)}))};
}

/** 診断JSONをローカルで集計。ネットワーク送信・曲設定への取込は行わない。 */
export function aggregateSessionLogs(documents:{name:string;data:unknown}[]) {
  const trials:TriggerTrial[]=[],rejected:{name:string;reason:string}[]=[];const seen=new Set<string>();
  for(const document of documents){
    try {
      const root=document.data as Record<string,unknown>|null;
      const value=(root?.triggerTrials??root) as Record<string,unknown>|null;
      if(!value||value.format!=='karaokesync-trigger-trials'||value.version!==1||typeof value.runId!=='string'||!value.runId||value.runId.length>100||!Array.isArray(value.trials)||value.trials.length>30)throw new Error('更新版の通常アプリ診断JSONではありません');
      for(const item of value.trials){
        const trial=item as TriggerTrial;
        if(!trial||!Number.isSafeInteger(trial.id)||trial.id<0||!trial.input||typeof trial.retainMicRequested!=='boolean')throw new Error('試行の形式が不正です');
        validateInput(trial.input);
        if(trial.trigger!==selectedTrigger(trial.input)||trial.environment!==trial.input.service)throw new Error('試行と設定の環境・トリガーが不一致です');
        for(const time of [trial.createdMs,trial.triggerMs,trial.playRequestMs,trial.playingConfirmedMs])if(time!==undefined&&(!Number.isFinite(time)||time<0))throw new Error('時刻が不正です');
      }
      for(const trial of value.trials as TriggerTrial[]){const key=value.runId+':'+trial.id;if(seen.has(key)){rejected.push({name:document.name,reason:'重複試行を除外（最初のJSONを優先）'});continue;}seen.add(key);trials.push({...trial,comparisonContext:{userAgent:typeof root?.userAgent==='string'?root.userAgent:'unknown',origin:typeof root?.origin==='string'?root.origin:'unknown',mode:typeof root?.mode==='string'?root.mode:'unknown'}});}
    }catch(error){rejected.push({name:document.name,reason:String(error)});}
  }
  return {...latencySummary(trials),acceptedTrials:trials.length,rejected};
}
