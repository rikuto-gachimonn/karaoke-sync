import { settings } from '../config/settings';
import { AudioAcquireError, type AudioInput, type AudioLease } from '../session/ports';
import { summarize, suggestThreshold, type VolumeSummary } from './statistics';
export type MeasurementKind = 'noise' | 'music';
export interface MeasurementState {
  busy: boolean; phase: 'idle' | 'acquiring' | 'measuring' | 'releasing' | 'error'; message: string;
  context: string; kind?: MeasurementKind; noise?: VolumeSummary; music?: VolumeSummary;
}
export class CalibrationController {
  private state: MeasurementState = {busy:false,phase:'idle',message:'伴奏を止めて雑音を測定してください',context:''};
  private listeners = new Set<() => void>();
  private run?: { abort: AbortController; cancelled: boolean; lease?: AudioLease; timer?: ReturnType<typeof setTimeout>; off?: () => void; interruptionOff?: () => void; finishing?: Promise<void>; pending?: boolean };
  constructor(private audio: AudioInput, private stopSession: () => Promise<void>, private sessionReady: () => boolean, private log: (event:string,detail:string) => void, private now = () => performance.now()) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<MeasurementState>) { this.state={...this.state,...patch}; this.listeners.forEach(listener=>listener()); }
  suggestion(context:string) { return context === this.state.context ? suggestThreshold(this.state.noise,this.state.music) : {reason:'この曲・環境で測定してください'}; }
  async start(kind:MeasurementKind, context:string) {
    if (this.state.busy) return;
    if (context !== this.state.context) this.update({noise:undefined,music:undefined,context});
    const run = {abort:new AbortController(),cancelled:false} as NonNullable<typeof this.run>;
    this.run=run;
    this.update({busy:true,phase:'acquiring',kind,[kind]:undefined,message:'再生・検知を停止してマイクを準備中'});
    this.log('measurement.start',JSON.stringify({kind,context,durationMs:settings.measurementDurationMs}));
    try {
      run.pending=true;
      try { await this.stopSession(); } finally { run.pending=false; }
      if (run.cancelled) { await this.finish(run,'測定を中断しました'); return; }
      if (!this.sessionReady()) throw new Error('前のセッションの資源解放が未完了です。すべて停止後に再試行してください');
      run.pending=true;
      run.timer=setTimeout(()=>{ run.cancelled=true; run.abort.abort(); this.update({message:'マイク取得期限超過。要求の終了と資源回収を待っています'}); },settings.acquireTimeoutMs);
      this.log('measurement.mic.acquire',kind);
      try { run.lease=await this.audio.acquire(run.abort.signal); }
      finally { run.pending=false; clearTimeout(run.timer); }
      if (run.cancelled) { await this.finish(run,'測定を中断しました'); return; }
      const values:number[]=[]; let first:number|undefined; let last:number|undefined; let maxGap=0;
      const started=this.now();
      this.update({phase:'measuring',message:kind === 'noise' ? '雑音を4秒測定中：伴奏を停止し静かにしてください' : '伴奏を4秒測定中：曲の冒頭の小さい音を流してください'});
      this.log('measurement.acquired',JSON.stringify({kind,input:run.lease.inputInfo?.()??'不明'}));
      run.interruptionOff=run.lease.onInterrupted?.(message=>{void this.finish(run,'測定エラー: '+message,true);});
      run.off=run.lease.subscribe(sample=>{
        if (this.run!==run || run.cancelled || run.finishing || this.state.phase!=='measuring') return;
        if (!Number.isFinite(sample.rms)||sample.rms<0||sample.rms>1||!Number.isFinite(sample.timeMs)) {void this.finish(run,'測定エラー: RMSまたは時刻が不正です',true);return;}
        if (last!==undefined && sample.timeMs<=last) return;
        if (last!==undefined) maxGap=Math.max(maxGap,sample.timeMs-last);
        first ??=sample.timeMs;last=sample.timeMs;
        if(values.length<1000) values.push(sample.rms);
      });
      if(this.run!==run || run.finishing) return;
      run.timer=setTimeout(()=>{
        if (this.run!==run || run.cancelled || run.finishing) return;
        if (values.length<settings.measurementMinSamples || first===undefined || last===undefined || last-first<settings.measurementDurationMs*0.75 || this.now()-last>settings.measurementMaxGapMs || maxGap>settings.measurementMaxGapMs || this.now()-started>settings.measurementDurationMs+1000) {void this.finish(run,'測定不足または入力中断です。画面を表示したまま再測定してください',true);return;}
        const summary=summarize(values);
        this.update({[kind]:summary});
        this.log('measurement.result',JSON.stringify({kind,context,...summary}));
        const proposal=this.suggestion(context);
        this.log('measurement.suggestion',JSON.stringify(proposal));
        void this.finish(run,'測定完了。マイクを解放しました');
      },settings.measurementDurationMs);
    } catch(error) {
      if(error instanceof AudioAcquireError) run.lease=error.lease;
      await this.finish(run,run.cancelled?'測定を中断しました':'測定エラー: '+String(error),!run.cancelled);
    }
  }
  async cancel() {
    const run=this.run;
    if(!run) return;
    run.cancelled=true;run.abort.abort();clearTimeout(run.timer);
    if(run.pending) {this.update({message:'測定中断：取得要求の終了と遅着資源の回収を待っています'});return;}
    await this.finish(run,'測定を中断しました');
  }
  async reset() { await this.cancel(); if(!this.state.busy) this.update({noise:undefined,music:undefined,context:''}); }
  async retryRelease() {
    const run=this.run;
    if(run?.lease && this.state.phase==='error') await this.finish(run,'資源解放を再試行しました');
  }
  private finish(run:NonNullable<typeof this.run>, message:string, error=false):Promise<void> {
    if(this.run!==run) return Promise.resolve();
    if(run.finishing) return run.finishing;
    clearTimeout(run.timer);run.off?.();run.off=undefined;run.interruptionOff?.();run.interruptionOff=undefined;
    this.update({phase:'releasing',message:'測定終了・マイク解放中'});
    const cleanupWarning=setTimeout(()=>{ if(this.run===run) this.update({phase:'error',message:'マイク解放が未完了です。処理の完了待ちです（再試行で重複解放しません）'}); },settings.cleanupTimeoutMs);
    run.finishing=Promise.resolve().then(async()=>{
      if(run.lease) await run.lease.release();
      this.log('measurement.finished',message);
      if(this.run===run) {this.run=undefined;this.update({busy:false,phase:error?'error':'idle',message});}
    }).catch(failure=>{this.log('measurement.release.failed',String(failure));this.update({busy:true,phase:'error',message:'マイク資源解放が未完了です。解放再試行を押してください: '+String(failure)});}).finally(()=>{clearTimeout(cleanupWarning);run.finishing=undefined;});
    return run.finishing;
  }
}
