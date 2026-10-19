import { prepositionWhilePaused, preseekToleranceSec } from './preposition';
import { sessionOptions, settings, type SessionOptions } from '../config/settings';
import { LeaseReleaser } from './leaseReleaser';
import { DiagnosticLog } from '../diagnostics/log';
import { playbackPlan, startPosition, selectedTrigger, validateInput, type SyncInput } from '../domain/sync';
import type { AudioLease, Detector, Player, PlayerEvent, SessionDependencies, Unsubscribe } from './ports';
import { AudioAcquireError, AudioStartError } from './ports';
import { trialExport, type TriggerTrial } from '../diagnostics/trials';
import { initialState, sessionReducer, type Phase, type SessionState } from './state';
import { correctedPosition } from '../youtube-probe/compensation';

interface Context {
  input: SyncInput;
  generation: number;
  player: Player;
  detector: Detector;
  lease?: AudioLease;
  acquiring: boolean;
  requestId: number;
  desiredPlayback: boolean;
  retired: boolean;
  disposed: boolean;
  terminal: 'idle' | 'ended' | 'error';
  message: string;
  timers: Set<ReturnType<typeof setTimeout>>;
  playTimer?: ReturnType<typeof setTimeout>;
  audioOff?: Unsubscribe;
  interruptionOff?: Unsubscribe;
  playerOff?: Unsubscribe;
  cleanup?: Promise<void>;
  pausePending?: Promise<void>;
  detached?: boolean;
  acquisitionAbort: AbortController;
  sampleTimeMs?: number;
  detectedPlaybackConfirmed?: boolean;
  triggerConsumed: boolean;
  prepositionedSec?:number;
  trial: TriggerTrial;
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export class SessionController {
  private state: SessionState = { ...initialState };
  private listeners = new Set<() => void>();
  private generation = 0;
  private current?: Context;
  private retiring = new Set<Context>();
  private detached = new Set<Context>();
  private releaser = new LeaseReleaser();
  private trials: TriggerTrial[] = [];
  private droppedTrials = 0;
  private runId=globalThis.crypto?.randomUUID?.()??`${Date.now()}-${Math.random().toString(36).slice(2)}`;
  exportTrials = () => ({...trialExport(this.trials,this.droppedTrials),runId:this.runId});

  constructor(
    private dependencies: SessionDependencies,
    readonly log = new DiagnosticLog(),
    private options: SessionOptions = sessionOptions,
  ) {}

  getSnapshot = (): SessionState => this.state;
  subscribe = (listener: () => void): Unsubscribe => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private update(patch: Partial<Omit<SessionState, 'generation'>>): void {
    this.state = sessionReducer(this.state, { type: 'update', generation: this.generation, patch: {
      ...patch,
      canRecoverAcquisition: !this.current && this.retiring.size > 0 && [...this.retiring].every(context => context.acquiring && !context.lease && context.disposed),
      canPrepare: !this.current && !this.retiring.size && ![...this.detached].some(context => context.lease),
    } });
    // 音量表示だけの10Hz更新で診断リングを埋めず、測定への描画負荷も抑える。
    if (Object.keys(patch).some(key => key !== 'volume')) this.log.add(this.generation, 'state', `${this.state.phase}: ${this.state.message}`);
    this.listeners.forEach(listener => listener());
  }

  private valid(context: Context): boolean { return this.current === context && !context.retired; }

  private deadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms);
      promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
  }

  private schedule(context: Context, ms: number, action: () => void): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => { context.timers.delete(timer); if (this.valid(context)) action(); }, ms);
    context.timers.add(timer);
    return timer;
  }

  async prepare(input: SyncInput): Promise<void> {
    if (this.dependencies.allowPrepare?.() === false) { this.log.add(this.generation, 'prepare.ignored', '測定またはマイク資源の終了待ち'); return; }
    if (this.current || this.retiring.size || [...this.detached].some(context => context.lease)) { this.log.add(this.generation, 'prepare.ignored', '既存セッションまたは資源の解放待ち'); return; }
    try { validateInput(input); } catch (error) { this.update({ phase: 'error', message: errorText(error) }); return; }
    const snapshot = { ...input, compensation: input.compensation ? { ...input.compensation } : undefined };
    const generation = ++this.generation;
    let context: Context;
    try {
      const created = this.log.add(generation,'trial.prepared',JSON.stringify({trigger:selectedTrigger(snapshot),input:snapshot,retainMic:this.options.retainMic}));
      const trial:TriggerTrial = {id:generation,createdMs:created.timeMs,trigger:selectedTrigger(snapshot),environment:snapshot.service,input:structuredClone(snapshot),retainMicRequested:this.options.retainMic,microphoneUsed:false,initialRequests:0,resumeRequests:0,outcome:'pending'};
      this.trials.push(trial);if(this.trials.length>settings.triggerTrialMaxEntries){this.trials.shift();this.droppedTrials++;}
      context = {
        input: snapshot,
        generation, detector: this.dependencies.createDetector(), player: this.dependencies.createPlayer(),
        acquiring: false, requestId: 0, desiredPlayback: false, retired: false, disposed: false,
        trial, triggerConsumed:false, terminal: 'idle', message: '', timers: new Set(), acquisitionAbort: new AbortController(),
      };
    } catch (error) { const failed=this.trials.at(-1);if(failed?.id===generation){failed.outcome='failed';failed.termination=errorText(error);}this.update({ phase: 'error', message: errorText(error) }); return; }
    this.current = context;
    this.update({ phase: 'preparing', mic: snapshot.playbackMode === 'preplay' || selectedTrigger(snapshot)==='manual' ? 'off' : 'acquiring', volume: 0, liveAdjustmentMs: 0, notice: '', resourceWarning: this.detached.size ? this.state.resourceWarning : '', message: '動画と検知の準備中' });
    try {
      context.playerOff = context.player.subscribe(event => this.onPlayer(context, event));
      if (snapshot.playbackMode === 'preplay') {
        await this.deadline(context.player.prepare(snapshot.videoId, 0), this.options.prepareTimeoutMs, '動画準備期限超過');
        if (this.valid(context)) {
          this.log.add(generation, 'player.prepared');
          this.update({ phase: 'preplay', mic: 'off', message: 'YouTube内の再生ボタンを直接タップしてください。再生確認後に自動一時停止します' });
        }
        return;
      }
      await this.armSession(context, snapshot, false);
    } catch (error) {
      if (this.valid(context)) await this.finish(context, 'error', errorText(error));
      else this.log.add(generation, 'prepare.cancelled', errorText(error));
    }
  }


  private async armSession(context: Context, snapshot: SyncInput, playerReady: boolean) {
    const generation = context.generation;
    if(selectedTrigger(snapshot)==='manual') {
      if(!playerReady) await this.deadline(context.player.prepare(snapshot.videoId,0),this.options.prepareTimeoutMs,'動画準備期限超過');
      if(!this.valid(context)) return;
      if(playerReady && await this.deadline(context.player.readPlaybackState(),this.options.cleanupTimeoutMs,'一時停止状態の確認期限超過')!=='paused') throw new Error('手動開始準備でPAUSEDを確認できません');
      if(!this.valid(context)) return;
      await this.preparePosition(context);
      if(!this.valid(context))return;
      this.update({phase:'manualReady',mic:'off',message:'手動開始待ち：画面の「この位置から開始」を押してください（音検知なし）'});
      this.log.add(generation,'trigger.manual.ready');
      this.schedule(context,snapshot.armedTimeoutMs??this.options.armedTimeoutMs,()=>{void this.finish(context,'idle','手動開始待機期限超過');});
      return;
    }
    context.acquiring = true;
    this.log.add(generation, 'mic.acquire');
    // 取得そのものはキャンセルできない契約。停止後の遅着leaseも必ず回収する。
    // 再試行ボタンのユーザー操作内でAudioContext生成・resumeまで同期的に進める。
    let acquisition: Promise<AudioLease>;
    try { acquisition = this.dependencies.audio.acquire(context.acquisitionAbort.signal); }
    catch (error) { acquisition = Promise.reject(error); }
    const acquire = acquisition.then(async lease => {
      context.acquiring = false;
      context.lease = lease;
      context.trial.microphoneUsed = true;
      this.log.add(generation, 'mic.acquired');
      if (this.valid(context)) context.interruptionOff = lease.onInterrupted?.(message => {
        if (this.valid(context)) this.microphoneInterrupted(context, message);
      });
      if (!this.valid(context)) await this.cleanup(context);
      return lease;
    }, async error => {
      context.acquiring = false;
      if (error instanceof AudioAcquireError) context.lease = error.lease;
      this.log.add(generation, 'mic.acquire.failed', errorText(error));
      if (context.retired) await this.cleanup(context);
      throw error;
    });
    this.log.add(generation, 'player.prepare', `start=${startPosition(snapshot)}, service=${snapshot.service}`);
    await Promise.all([
      this.deadline(acquire, this.options.acquireTimeoutMs, 'マイク取得期限超過'),
      playerReady ? Promise.resolve() : this.deadline(context.player.prepare(snapshot.videoId, selectedTrigger(snapshot)==='accompaniment'?startPosition(snapshot):0), this.options.prepareTimeoutMs, '動画準備期限超過').then(() => { this.log.add(generation, 'player.prepared'); }),
    ]);
    if (!this.valid(context)) return;
    if (playerReady && await this.deadline(context.player.readPlaybackState(), this.options.cleanupTimeoutMs, '一時停止状態の確認期限超過') !== 'paused') throw new Error('マイク取得後に動画の一時停止を確認できません');
    if (!this.valid(context)) return;
    await this.preparePosition(context);
    if(!this.valid(context))return;
    context.detector.arm(snapshot, () => this.detected(context));
    this.update({ phase: 'armed', mic: 'running', message: '検知待機中', notice: '音検知を開始しました' });
    this.log.add(generation, 'detector.armed', JSON.stringify({ threshold: snapshot.threshold, durationMs: snapshot.durationMs, retainMic: this.options.retainMic }));
    this.schedule(context, snapshot.armedTimeoutMs ?? this.options.armedTimeoutMs, () => { void this.finish(context, 'idle', '検知待機期限超過'); });
    let lastVolumeUpdate = -Infinity;
    context.audioOff = context.lease!.subscribe(sample => {
      if (this.valid(context) && this.state.phase === 'armed') {
        if (sample.timeMs - lastVolumeUpdate >= 100) { lastVolumeUpdate = sample.timeMs; this.update({ volume: sample.rms }); }
        context.sampleTimeMs = sample.timeMs;
        context.detector.sample(sample);
      }
    });
    if (this.state.phase !== 'armed') { context.audioOff(); context.audioOff = undefined; }

  }

  private async preparePosition(context:Context):Promise<void> {
    if(!context.input.preseekBeforeDetection)return;
    if(context.input.playbackMode!=='preplay')throw new Error('事前シークは事前再生方式で比較してください');
    const duration=context.player.duration?.();
    if(!duration||!Number.isFinite(duration)||duration<=0)throw new Error('動画長を取得できません');
    const plan=playbackPlan(context.input),target=Math.min(duration,plan.seekSec);
    this.log.add(context.generation,'player.preseek.request',JSON.stringify({target,plan}));
    const observed=await prepositionWhilePaused(context.player,target,context.acquisitionAbort.signal);
    if(!this.valid(context))return;
    context.prepositionedSec=target;
    context.trial.prepositionSec=observed;
    this.log.add(context.generation,'player.preseek.confirmed',JSON.stringify({target,observed,toleranceSec:preseekToleranceSec}));
  }

  private async acceptPreplay(context: Context): Promise<void> {
    this.update({ phase: 'prepausing', message: '事前再生の実状態を確認し、自動一時停止中' });
    const request = context.requestId;
    try {
      const observed = await this.deadline(context.player.readPlaybackState(), this.options.cleanupTimeoutMs, '事前再生確認期限超過');
      if (!this.valid(context) || request !== context.requestId) return;
      if (observed !== 'playing') { this.update({ phase: 'preplay', message: '現在の再生を確認できません。YouTubeを直接タップしてください' }); return; }
      this.log.add(context.generation, 'preplay.pause.request');
      await this.pausePlayer(context);
      if (!this.valid(context)) return;
      const paused = await this.deadline(context.player.readPlaybackState(), this.options.cleanupTimeoutMs, '事前一時停止確認期限超過');
      if (!this.valid(context)) return;
      if (paused !== 'paused') throw new Error('事前再生後のPAUSEDを確認できません');
      this.log.add(context.generation, 'preplay.paused');
      this.update({ phase: 'preparing', mic: selectedTrigger(context.input)==='manual'?'off':'acquiring', message: selectedTrigger(context.input)==='manual'?'動画の一時停止を確認。手動開始を準備中':'動画の一時停止を確認。マイクを取得して検知準備中' });
      await this.armSession(context, context.input, true);
    } catch (error) { await this.handlePreplayPreparationError(context, error); }
  }
  private async handlePreplayPreparationError(context: Context, error: unknown): Promise<void> {
    if (!this.valid(context)) return;
    if (error instanceof AudioStartError && !context.lease && !context.acquiring) {
      // AudioStartErrorは資源回収済みの場合だけ返される。動画の一時停止を再確認する。
      try {
        await this.pausePlayer(context);
        if (!this.valid(context)) return;
        this.log.add(context.generation, 'mic.activation.required', errorText(error));
        this.update({ phase: 'micReady', mic: 'off', volume: 0, message: `${errorText(error)}。音検知は未開始です。「マイクを起動して検知開始」を押すか、すべて停止してください。広告の有無は判定していません` });
        return;
      } catch (pauseError) { error = pauseError; }
    }
    if (this.valid(context)) await this.finish(context, 'error', errorText(error));
  }
  retryMicrophone(): void {
    const context = this.current;
    if (!context || !this.valid(context) || this.state.phase !== 'micReady') return;
    this.log.add(context.generation, 'mic.activation.retry', 'ページ上の操作による再取得。広告状態は不明');
    this.update({ phase: 'preparing', mic: 'acquiring', message: '操作を受け付けました。マイクを起動中（検知は未開始）' });
    // awaitやタイマーを挟まずadapterのresumeを呼ぶ。二重クリックはphaseで拒否する。
    void this.armSession(context, context.input, true).catch(error => this.handlePreplayPreparationError(context, error));
  }
  manualStart(): void {
    const context=this.current;
    if(context && selectedTrigger(context.input)==='manual' && this.state.phase==='manualReady') this.beginPlayback(context,'manual');
  }
  private detected(context: Context): void { this.beginPlayback(context,'rms'); }
  private beginPlayback(context: Context, source:'rms'|'manual'): void {
    if (!this.valid(context) || context.triggerConsumed || this.state.phase !== (source==='manual'?'manualReady':'armed')) return;
    if((selectedTrigger(context.input)==='manual')!==(source==='manual')) return;
    context.triggerConsumed=true;
    context.trial.triggerMs=this.log.add(context.generation,'trigger.fired',JSON.stringify({trigger:selectedTrigger(context.input),source,sampleTimeMs:context.sampleTimeMs})).timeMs;
    context.trial.sourceSampleMs=context.sampleTimeMs;
    this.update({notice:source==='rms'?'音を検知しました。動画を再生します':'手動開始を受け付けました'});
    context.detector.disarm();
    context.audioOff?.();
    context.audioOff = undefined;
    context.timers.forEach(clearTimeout);
    context.timers.clear();
    if(source==='rms') {
      this.log.add(context.generation, 'detector.detected');
      this.log.add(context.generation, 'detector.duration.satisfied', `sampleTimeMs=${context.sampleTimeMs ?? 'unknown'}`);
    }
    if (selectedTrigger(context.input)!=='accompaniment' || context.input.playbackMode === 'preplay' || playbackPlan(context.input).waitMs > 0 || (context.input.startAdjustmentMs ?? 0) !== 0 || (context.input.compensation && context.input.compensation.mode !== 'baseline')) {
      const compensation = playbackPlan(context.input);
      this.update({ phase: 'waiting', notice: source==='rms'?'音を検知しました。動画を再生します':'手動開始を受け付けました', message: `${source==='manual'?'手動開始受理':'検知成立'}。固定待機${compensation.waitMs}ms（ジッターや実発音の同期を保証しません）` });
      this.log.add(context.generation, 'compensation.wait.start', JSON.stringify(compensation));
      const request = context.requestId;
      const start = () => { void this.seekAndPlay(context, request); };
      context.trial.plannedRequestMs=context.trial.triggerMs!+compensation.waitMs;
      const remainingMs=Math.max(0,context.trial.plannedRequestMs-this.log.time());
      if (remainingMs > 0) this.schedule(context, remainingMs, start); else start();
      if (context.input.playbackMode === 'preplay' && !this.options.retainMic && context.lease) void this.releaseDuringPlayback(context);
    } else this.requestPlay(context);
  }

  private async seekAndPlay(context: Context, request: number): Promise<void> {
    try {
      this.log.add(context.generation, 'compensation.wait.end');
      if (context.input.playbackMode === 'preplay') {
        const observed = await this.deadline(context.player.readPlaybackState(), this.options.cleanupTimeoutMs, '再生直前の状態確認期限超過');
        if (!this.valid(context) || request !== context.requestId || this.state.phase !== 'waiting') return;
        if (observed !== 'paused') throw new Error('再生直前にPAUSEDを確認できません');
      }
      if (!this.valid(context) || request !== context.requestId || this.state.phase !== 'waiting') return;
      if (!context.player.seek || !context.player.duration) throw new Error('このプレイヤーはシーク補正に対応していません');
      const duration=context.player.duration();
      const position = correctedPosition(0, playbackPlan(context.input).seekSec * 1000, duration);
      this.log.add(context.generation, 'player.start.position', JSON.stringify(position));
      context.trial.seekSec=position.seekSec;
      const observedPosition=context.player.position?.();
      if(context.prepositionedSec===position.seekSec && Number.isFinite(observedPosition) && Math.abs(observedPosition!-position.seekSec)<=preseekToleranceSec){
        this.log.add(context.generation,'player.seek.reused','事前シークの位置を再観測。検知後の再シーク要求なし');
      } else {this.log.add(context.generation,'player.seek.request',JSON.stringify(position));context.player.seek(position.seekSec);}
      if (this.valid(context) && request === context.requestId && this.state.phase === 'waiting') this.requestPlay(context);
    } catch (error) { if (this.valid(context)) await this.finish(context, 'error', errorText(error)); }
  }

  private requestPlay(context: Context): void {
    context.desiredPlayback = true;
    const request = ++context.requestId;
    this.update({ phase: 'starting', message: '再生要求中（発音確認ではありません）' });
    context.playTimer = this.schedule(context, this.options.playingTimeoutMs, () => { void this.finish(context, 'error', '再生開始確認期限超過'); });
    const requested=this.log.add(context.generation, 'player.play.request', String(request));
    if(context.trial.playRequestMs===undefined) {context.trial.playRequestMs=requested.timeMs;context.trial.initialRequests++;}
    else context.trial.resumeRequests++;
    try { context.player.play(request); }
    catch (error) { void this.finish(context, 'error', errorText(error)); }
  }

  private async pausePlayer(context: Context): Promise<void> {
    if (!context.pausePending) {
      const operation = Promise.resolve().then(() => context.player.pause());
      context.pausePending = operation;
      void operation.then(() => { if (context.pausePending === operation) context.pausePending = undefined; }, () => { if (context.pausePending === operation) context.pausePending = undefined; });
    }
    await this.deadline(context.pausePending, this.options.cleanupTimeoutMs, '一時停止確認期限超過');
  }

  private onPlayer(context: Context, event: PlayerEvent): void {
    const received=this.log.add(context.generation, `player.${event.type}`, `request=${event.requestId ?? 'unknown'}${'message' in event ? `: ${event.message}` : ''}`);
    this.log.add(context.generation, 'player.context', JSON.stringify({ event: event.type, phase: this.state.phase, mic: this.state.mic, advertising: 'unknown' }));
    if(event.type==='playing'&&this.valid(context)&&context.triggerConsumed&&context.desiredPlayback&&(event.requestId===undefined||event.requestId===context.requestId)&&context.trial.playingEventMs===undefined)context.trial.playingEventMs=received.timeMs;
    if (event.type === 'playing' && this.valid(context) && context.input.playbackMode === 'preplay') {
      if (this.state.phase === 'preplay') { void this.acceptPreplay(context); return; }
      if (this.state.phase === 'prepausing') return;
      if (['preparing', 'micReady', 'armed', 'manualReady', 'waiting'].includes(this.state.phase)) {
        const request = context.requestId;
        void this.deadline(context.player.readPlaybackState(), this.options.cleanupTimeoutMs, '想定外再生の状態確認期限超過').then(observed => {
          if (this.valid(context) && request === context.requestId && observed === 'playing') void this.finish(context, 'error', '検知前・補正待機中の想定外再生を停止しました');
        }, error => { if (this.valid(context) && request === context.requestId) void this.finish(context, 'error', errorText(error)); });
        return;
      }
    }
    if (event.type === 'playing' && (!this.valid(context) || !context.desiredPlayback || (event.requestId !== undefined && event.requestId !== context.requestId))) {
      if (this.valid(context) && (this.state.phase === 'preparing' || this.state.phase === 'armed' || this.state.phase === 'manualReady')) {
        void this.finish(context, 'error', '検知前の想定外再生を停止しました。再準備してください');
        return;
      }
      if (this.valid(context) && (context.desiredPlayback || this.state.phase === 'paused')) {
        this.recoverPlayback(context, '古い再生イベントを受信。再生意図を解除して再確認');
        return;
      }
      void this.pausePlayer(context).catch(error => {
        if (this.valid(context)) void this.finish(context, 'error', errorText(error));
        else { this.log.add(context.generation, 'stale.pause.failed', errorText(error)); }
      });
      return;
    }
    if (!this.valid(context)) return;
    if (event.requestId !== undefined && event.requestId !== context.requestId) return;
    if (event.requestId === undefined && (event.type === 'playing' || event.type === 'paused' || event.type === 'ended')) {
      void this.verifyUntaggedEvent(context, event.type);
      return;
    }
    this.applyPlayerEvent(context, event);
  }

  private async verifyUntaggedEvent(context: Context, type: 'playing' | 'paused' | 'ended'): Promise<void> {
    const request = context.requestId;
    try {
      const observed = await this.deadline(context.player.readPlaybackState(), this.options.cleanupTimeoutMs, '動画状態確認期限超過');
      // 問合せ中のpause/stop/resumeを跨いだ結果は、新しい要求へ転用しない。
      if (!this.valid(context) || request !== context.requestId) return;
      this.log.add(context.generation, 'player.observed', `${type} => ${observed}`);
      if (observed !== type) {
        if (type === 'playing') this.recoverPlayback(context, '再生イベントと現在状態が不一致。再生で再確認してください');
        return;
      }
      // requestIdの捏造ではなく「現在の実状態」の確認として処理する。
      this.applyPlayerEvent(context, { type });
    } catch (error) {
      if (this.valid(context) && request === context.requestId) this.recoverPlayback(context, `動画状態が未確認: ${errorText(error)}`);
    }
  }

  private recoverPlayback(context: Context, message: string): void {
    if (!this.valid(context)) return;
    context.desiredPlayback = false;
    ++context.requestId;
    if (context.playTimer) { clearTimeout(context.playTimer); context.timers.delete(context.playTimer); }
    this.update({ phase: 'paused', message: '一時停止を確認中' });
    const request = context.requestId;
    void this.pausePlayer(context).then(() => {
      if (this.valid(context) && request === context.requestId) this.update({ message });
    }, error => { if (this.valid(context)) void this.finish(context, 'error', errorText(error)); });
  }

  private applyPlayerEvent(context: Context, event: PlayerEvent): void {
    if (event.type === 'playing') {
      if (!context.desiredPlayback) return;
      if (!['starting', 'buffering', 'playing'].includes(this.state.phase)) return;
      if (context.playTimer) { clearTimeout(context.playTimer); context.timers.delete(context.playTimer); }
      context.detectedPlaybackConfirmed = true;
      if(context.trial.playingConfirmedMs===undefined) {
        context.trial.playingConfirmedMs=this.log.add(context.generation,'trial.playing.confirmed','API上のみ・実発音未確認').timeMs;
        context.trial.outcome='api-playing';
        try { const position=context.player.position?.();if(Number.isFinite(position))context.trial.playingPositionSec=position; } catch { /* 観測不能は未記録 */ }
      }
      this.update({ phase: 'playing', mic: context.lease ? 'retained' : 'off', message: 'プレイヤー再生状態を確認（検知終了・実発音は未確認）' });
      if (!this.options.retainMic && context.lease) void this.releaseDuringPlayback(context);
    } else if (event.type === 'ended' && (['playing', 'starting', 'buffering'].includes(this.state.phase) || context.input.playbackMode === 'preplay')) {
      void this.finish(context, 'ended', '再生終了');
    } else if (event.type === 'blocked' || event.type === 'error') {
      void this.finish(context, 'error', event.type === 'blocked' ? `自動再生ブロック: ${event.message}。すべて停止後、事前再生方式で再準備してください。ブラウザ制限は解除できない場合があります` : event.message);
    } else if (event.type === 'paused' && context.input.playbackMode === 'preplay' && !context.detectedPlaybackConfirmed && ['starting', 'buffering'].includes(this.state.phase)) {
      this.log.add(context.generation, 'preplay.paused.pending', '開始待ち中のPAUSED。PLAYING・ブロック・期限で判定');
    } else if (event.type === 'paused' && ['starting', 'buffering', 'playing'].includes(this.state.phase)) {
      void this.pause();
    } else if (event.type === 'buffering' && ['starting', 'buffering', 'playing'].includes(this.state.phase)) {
      this.update({ phase: 'buffering', message: 'BUFFERING: 読み込み待ち。実音の同期は維持できない可能性があります' });
    }
  }

  private async releaseDuringPlayback(context: Context): Promise<void> {
    const lease = context.lease;
    if (!lease) return;
    this.log.add(context.generation, 'mic.release.request', context.input.playbackMode === 'preplay' ? '検知終了後の解放比較（固定待機中を含む）' : '再生確認後の解放比較');
    try {
      await this.deadline(this.releaser.release(lease), this.options.cleanupTimeoutMs, 'マイク解放期限超過');
      if (context.lease === lease) context.lease = undefined;
      context.trial.microphoneReleasedMs=this.log.add(context.generation,'trial.mic.released').timeMs;
      if (this.valid(context)) this.update({ mic: 'off' });
    } catch (error) { if (this.valid(context)) this.update({mic:'releasing',resourceWarning:'マイク解放未完了: '+errorText(error)+'。すべて停止で再試行'}); }
  }

  playbackPosition(): number | undefined {
    const context=this.current;
    if(!context || !this.valid(context) || this.state.phase!=='playing') return;
    const value=context.player.position?.();
    return Number.isFinite(value) ? value : undefined;
  }
  adjustLive(deltaMs:number): void {
    const context=this.current;
    if(!context || !this.valid(context) || this.state.phase!=='playing' || !context.desiredPlayback) return;
    if(!Number.isSafeInteger(deltaMs) || Math.abs(deltaMs)>1000) return;
    try {
      const current=this.playbackPosition(), duration=context.player.duration?.();
      if(current===undefined || !Number.isFinite(duration) || !duration || duration<=0 || !context.player.seek) throw new Error('現在位置・動画長を確認できません');
      const targetMs=Math.max(0,Math.min(Math.round(duration*1000),Math.round(current*1000)+deltaMs));
      const appliedMs=targetMs-Math.round(current*1000);
      context.player.seek(targetMs/1000);
      const operation=this.log.add(context.generation,'player.live.seek',JSON.stringify({current,requestedDeltaMs:deltaMs,targetSec:targetMs/1000,appliedMs}));
      context.trial.liveAdjustmentMs=(context.trial.liveAdjustmentMs??0)+appliedMs;
      context.trial.liveOperations??=[];
      if(context.trial.liveOperations.length>=500){context.trial.liveOperations.shift();context.trial.liveOperationsDropped=(context.trial.liveOperationsDropped??0)+1;}
      context.trial.liveOperations.push({timeMs:operation.timeMs,requestedMs:deltaMs,clampedMs:appliedMs,fromSec:current,targetSec:targetMs/1000});
      for (const delayMs of [250,1000]) this.schedule(context,delayMs,()=>{
        try {this.log.add(context.generation,'player.live.seek.observed',JSON.stringify({delayMs,positionSec:context.player.position?.(),requestedSec:targetMs/1000,audibleTiming:'unmeasured'}));}catch(error){this.log.add(context.generation,'player.live.seek.observe.failed',errorText(error));}
      });
      this.update({liveAdjustmentMs:(this.state.liveAdjustmentMs??0)+appliedMs,notice:'再生位置変更を要求しました。実発音と微小シーク精度は未確認です'});
    } catch(error) {this.update({notice:'位置調整できません: '+errorText(error)});}
  }
  private microphoneInterrupted(context:Context,message:string):void {
    context.interruptionOff?.();context.interruptionOff=undefined;
    context.detector.disarm();context.audioOff?.();context.audioOff=undefined;
    this.log.add(context.generation,'mic.interrupted',message);
    this.update({notice:message+'。音検知を停止しました。イヤホン接続を確認してください'});
    if(context.triggerConsumed) {
      this.update({mic:'releasing'});
      void this.releaseDuringPlayback(context);
    } else void this.finish(context,'error',message+'。音検知を停止しました');
  }

  async pause(): Promise<void> {
    const context = this.current;
    if (!context || !['waiting', 'starting', 'buffering', 'playing'].includes(this.state.phase)) return;
    if (this.state.phase === 'waiting') { context.timers.forEach(clearTimeout); context.timers.clear(); }
    context.desiredPlayback = false;
    const request = ++context.requestId;
    if (context.playTimer) { clearTimeout(context.playTimer); context.timers.delete(context.playTimer); }
    this.update({ phase: 'paused', message: '一時停止を確認中' });
    try {
      await this.pausePlayer(context);
      if (this.valid(context) && context.requestId === request) this.update({ message: '一時停止中。再生で続きから再開' });
    } catch (error) { if (this.valid(context)) await this.finish(context, 'error', errorText(error)); }
  }

  resume(): void {
    const context = this.current;
    if (context && !context.pausePending && this.state.phase === 'paused' && this.state.message !== '一時停止を確認中') {
      if(context.triggerConsumed && context.trial.playRequestMs===undefined) {
        this.update({phase:'waiting',message:'中断した初回開始位置を適用中'});
        void this.seekAndPlay(context,context.requestId);
      } else this.requestPlay(context);
    }
  }

  async stop(): Promise<void> {
    this.log.add(this.generation, 'session.stop.request');
    this.update({notice:'音検知を停止しました（ユーザー操作）'});
    for (const context of this.retiring) {
      context.terminal = 'idle';
      context.message = 'すべて停止';
    }
    for (const context of [this.current, ...this.retiring, ...this.detached]) {
      if (context?.lease) this.releaser.retryFailed(context.lease);
    }
    if (this.current) await this.finish(this.current, 'idle', 'すべて停止');
    else if (this.retiring.size) await Promise.all([...this.retiring].map(context => this.cleanup(context)));
    else this.update({ phase: 'idle', mic: 'off', message: 'すべて停止' });
    await Promise.all([...this.detached].filter(context => context.lease).map(context => this.cleanup(context)));
  }

  // ブラウザの取得要求を取り消さず、明示操作で旧セッションだけを隔離する。
  async recoverPendingAcquisition(): Promise<void> {
    if (this.current || !this.retiring.size) return;
    await Promise.all([...this.retiring].map(context => this.cleanup(context)));
    const pending = [...this.retiring];
    if (!pending.length || !pending.every(context => context.acquiring && !context.lease && context.disposed)) return;
    if (this.detached.size + pending.length > settings.maxDetachedAcquisitions) {
      this.update({ resourceWarning: '未完了取得の復旧上限です。許可ダイアログを閉じ、ページを再読み込みしてください' });
      return;
    }
    for (const context of pending) {
      context.detached = true;
      this.retiring.delete(context);
      this.detached.add(context);
      this.log.add(context.generation, 'mic.acquire.detached', '取消ではない。遅着資源は引き続き解放');
    }
    this.update({ phase: 'idle', mic: 'off', message: '新しい準備が可能です', resourceWarning: '旧マイク取得は未取消です。遅着時は解放します。許可画面が残る場合は閉じてください' });
  }

  private async finish(context: Context, terminal: Context['terminal'], message: string): Promise<void> {
    if (context.retired) return;
    this.log.add(context.generation, 'session.finish', `${terminal}: ${message}`);
    context.trial.termination=message;
    if(context.trial.outcome!=='api-playing') context.trial.outcome=message.includes('自動再生ブロック')?'blocked':message.includes('期限超過')?'timeout':terminal==='error'?'failed':terminal==='ended'?'ended':'stopped';
    context.retired = true;
    context.acquisitionAbort.abort();
    context.terminal = terminal;
    context.message = message;
    context.desiredPlayback = false;
    ++context.requestId;
    this.current = undefined;
    ++this.generation;
    this.retiring.add(context);
    context.detector.disarm();
    context.audioOff?.();
    context.interruptionOff?.();
    context.timers.forEach(clearTimeout);
    context.timers.clear();
    this.update({ phase: 'stopping', mic: 'releasing', message, notice: terminal==='error' ? '終了: '+message+'。マイク接続・権限を確認してください' : this.state.notice });
    await this.cleanup(context);
  }

  private async cleanup(context: Context): Promise<void> {
    if (context.cleanup) return context.cleanup;
    context.cleanup = (async () => {
      try {
        // playerの破棄とlease解放は独立。片方失敗でも他方を必ず試す。
        const results = await Promise.allSettled([
          (async () => {
            if (context.disposed) return;
            try { await this.pausePlayer(context); } finally {
              await this.deadline(context.player.dispose(), this.options.cleanupTimeoutMs, 'プレイヤー破棄期限超過');
              context.disposed = true;
              this.log.add(context.generation, 'player.disposed');
              context.playerOff?.();
            }
          })(),
          (async () => {
            const lease = context.lease;
            if (!lease) return;
            await this.deadline(this.releaser.release(lease), this.options.cleanupTimeoutMs, 'マイク解放期限超過');
            if (context.lease === lease) context.lease = undefined;
            context.trial.microphoneReleasedMs=this.log.add(context.generation, 'mic.released').timeMs;
          })(),
        ]);
        const failure = results.find(result => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
        // dispose待ちの途中で取得が完了したleaseも、この終了処理で回収する。
        const lateLease = context.lease;
        if (lateLease) {
          await this.deadline(this.releaser.release(lateLease), this.options.cleanupTimeoutMs, 'マイク解放期限超過');
          if (context.lease === lateLease) context.lease = undefined;
          context.trial.microphoneReleasedMs=this.log.add(context.generation, 'mic.released.late').timeMs;
        }
        if (context.acquiring || context.lease) {
          if (!context.detached) this.update({ phase: 'stopping', mic: 'releasing', message: 'セッション無効化済み。マイク取得は未取消・遅着時に解放。復旧操作が可能です' });
          return;
        }
        context.trial.cleanupComplete=true;context.trial.cleanupFailure=undefined;
        this.retiring.delete(context);
        if (context.detached) {
          this.detached.delete(context);
          this.update({ resourceWarning: this.detached.size ? '旧マイク取得の完了・解放を引き続き監視中' : '' });
        } else this.update({ phase: context.terminal, mic: 'off', message: context.message, resourceWarning: this.detached.size ? this.state.resourceWarning : '' });
      } catch (error) {
        context.trial.cleanupComplete=false;context.trial.cleanupFailure=errorText(error);
        this.log.add(context.generation, 'cleanup.failed', errorText(error));
        if (context.detached) this.update({ resourceWarning: `旧取得の解放未完了: ${errorText(error)}。すべて停止で再試行` });
        else this.update({ phase: 'error', mic: 'releasing', message: `解放未完了: ${errorText(error)}。すべて停止で再試行` });
      }
    })();
    await context.cleanup;
    context.cleanup = undefined;
  }
}

export const phaseLabels: Record<Phase, string> = {
  micReady: 'マイク起動の操作待ち（音検知は未開始）',
  preplay: '事前手動再生待ち', prepausing: '事前再生を自動一時停止中', waiting: '補正待機中',
  buffering: '読み込み待ち（再生未確認）',
  manualReady:'手動開始待ち',
  idle: '未準備', preparing: '準備中', armed: '検知待機', starting: '再生要求中',
  playing: '再生中', paused: '一時停止', ended: '終了', stopping: '終了処理中', error: 'エラー',
};


