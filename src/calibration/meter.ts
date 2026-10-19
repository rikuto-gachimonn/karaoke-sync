import { settings } from '../config/settings';
import type { AudioInput, AudioLease, VolumeSample } from '../session/ports';
import { AudioAcquireError } from '../session/ports';
export interface MeterState { active: boolean; rms: number; input: string; lastSampleMs?: number }
/** 音検知と同じAudioLeaseを購読する。メーター自身は別のマイクを取得しない。 */
export class MeteredAudioInput implements AudioInput {
  private state: MeterState = { active: false, rms: 0, input: '不明' };
  private listeners = new Set<() => void>();
  private occupied = false;
  get busy() { return this.occupied; }
  constructor(private source: AudioInput) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<MeterState>) { this.state = {...this.state,...patch}; this.listeners.forEach(listener => listener()); }
  async acquire(signal?: AbortSignal): Promise<AudioLease> {
    if (this.occupied) throw new Error('別のマイク取得または解放が未完了です');
    this.occupied = true;
    let source: AudioLease;
    try { source = await this.source.acquire(signal); }
    catch (error) {
      if (error instanceof AudioAcquireError) throw new AudioAcquireError(error.message, this.wrap(error.lease, false));
      this.occupied = false; throw error;
    }
    return this.wrap(source, true);
  }
  private wrap(source: AudioLease, ready: boolean): AudioLease {
    let off: (() => void) | undefined; let interruptedOff: (() => void) | undefined;
    const interruptions = new Set<(message: string) => void>();
    let releasing: Promise<void> | undefined;
    const release = () => {
      if (releasing) return releasing;
      off?.(); off = undefined; interruptedOff?.(); interruptedOff = undefined;
      this.update({ active:false, rms:0, lastSampleMs:undefined });
      releasing = Promise.resolve().then(() => source.release()).then(() => { this.occupied=false; }, error => { releasing=undefined; throw error; });
      return releasing;
    };
    const wrapped: AudioLease = {
      subscribe: listener => source.subscribe(listener), release,
      inputInfo: () => source.inputInfo?.() ?? '不明',
      onInterrupted: listener => { interruptions.add(listener); return () => { interruptions.delete(listener); }; },
    };
    if (ready) {
      try {
        this.update({ active:true, rms:0, input:source.inputInfo?.() ?? '不明', lastSampleMs:undefined });
        let last = -Infinity;
        off = source.subscribe((sample: VolumeSample) => {
          if (!Number.isFinite(sample.rms)||sample.rms<0||sample.rms>1||!Number.isFinite(sample.timeMs)||sample.timeMs-last < settings.meterUpdateMs) return;
          last=sample.timeMs;
          this.update({ active:true, rms:sample.rms, lastSampleMs:sample.timeMs });
        });
        interruptedOff = source.onInterrupted?.(message => { this.update({active:false,rms:0,lastSampleMs:undefined}); interruptions.forEach(listener => listener(message)); });
      } catch (error) { throw new AudioAcquireError(String(error), wrapped); }
    }
    return wrapped;
  }
}

/** 表示だけを平方根尺度へ変換する。検知しきい値のRMSは変換しない。 */
export function meterPercent(rms:number) { return Math.sqrt(Math.max(0,Math.min(1,Number.isFinite(rms)?rms:0)))*100; }
