import {adjustEffectiveStart,selectedTrigger,validateInput,type SyncInput} from './sync';
import type {TriggerTrial} from '../diagnostics/trials';
export interface LiveResult {id:string;input:SyncInput;totalMs:number;retainMic:boolean;operations:number;termination?:string;dismissedTotalMs?:number}
export const liveHistoryKey='karaokesync.app.live-results.v1';
type StoragePort=Pick<Storage,'getItem'|'setItem'>;
export function liveRecommendation(result:LiveResult,current:SyncInput) {
  validateInput(current);
  if(!Number.isSafeInteger(result.totalMs)||Math.abs(result.totalMs)>86400000)throw new Error('補正結果の合計が不正です');
  if(current.videoId!==result.input.videoId||current.service!==result.input.service||selectedTrigger(current)!==selectedTrigger(result.input))throw new Error('補正結果の曲・環境・トリガーが一致しません');
  const applied=current.liveApplied?.find(item=>item.resultId===result.id)?.totalMs??0;
  const remainingMs=result.totalMs-applied;
  const next=adjustEffectiveStart(current,remainingMs);
  if((next.startAdjustmentMs??0)!==(current.startAdjustmentMs??0)+remainingMs)throw new Error('推奨補正が保存上限を超えます');
  next.liveApplied=[...(current.liveApplied??[]).filter(item=>item.resultId!==result.id),{resultId:result.id,totalMs:result.totalMs}].slice(-30);
  validateInput(next);
  return {remainingMs,next};
}
/** 曲設定とは別キー。自動記録は結果だけであり、同期設定を書き換えない。 */
export class LiveHistory {
  private raw:string|null;private values:LiveResult[];private listeners=new Set<()=>void>();
  constructor(private storage:StoragePort){
    this.raw=storage.getItem(liveHistoryKey);
    const value:unknown=this.raw===null?{version:1,results:[]}:JSON.parse(this.raw);
    if(!value||typeof value!=='object'||!('version' in value)||value.version!==1||!('results' in value)||!Array.isArray(value.results)||value.results.length>30)throw new Error('補正結果履歴の形式が不正です。上書きせず保持しました');
    this.values=value.results.map((item:LiveResult)=>{
      if(!item||typeof item.id!=='string'||item.id.length>100||!item.input||typeof item.retainMic!=='boolean'||!Number.isSafeInteger(item.totalMs)||Math.abs(item.totalMs)>86400000||!Number.isInteger(item.operations)||item.operations<0||item.operations>100000||item.dismissedTotalMs!==undefined&&!Number.isSafeInteger(item.dismissedTotalMs)||item.termination!==undefined&&typeof item.termination!=='string')throw new Error('補正結果が不正です');
      validateInput(item.input);return structuredClone(item);
    });
    if(new Set(this.values.map(item=>item.id)).size!==this.values.length)throw new Error('補正結果IDが重複しています');
  }
  getSnapshot=()=>this.values;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  private commit(next:LiveResult[]){
    const raw=JSON.stringify({version:1,results:next});if(raw===this.raw)return;
    if(this.storage.getItem(liveHistoryKey)!==this.raw)throw new Error('別タブで補正結果が更新されました。再読込してください');
    this.storage.setItem(liveHistoryKey,raw);this.raw=raw;this.values=next;this.listeners.forEach(listener=>listener());
  }
  capture(runId:string,trials:TriggerTrial[]){
    const next=structuredClone(this.values);
    for(const trial of trials){
      if(!trial.liveOperations?.length)continue;
      const id=runId+':'+trial.id;const previous=next.findIndex(item=>item.id===id);
      const result:LiveResult={id,input:structuredClone(trial.input),retainMic:trial.retainMicRequested,totalMs:trial.liveAdjustmentMs??0,operations:trial.liveOperations.length+(trial.liveOperationsDropped??0),termination:trial.termination};
      if(previous>=0){result.dismissedTotalMs=next[previous]!.dismissedTotalMs;next[previous]=result;}else next.push(result);
    }
    if(this.raw===null&&!next.length)return;
    this.commit(next.slice(-30));
  }
  dismiss(id:string){this.commit(this.values.map(item=>item.id===id?{...item,dismissedTotalMs:item.totalMs}:item));}
}
