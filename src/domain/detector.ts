import { settings } from '../config/settings';
import type { Detector, VolumeSample } from '../session/ports';

export class SustainedVolumeDetector implements Detector {
  constructor(private firstExceeded?: (sample: VolumeSample) => void) {}
  private config = { threshold: 0, durationMs: 0 };
  private callback?: () => void;
  private since?: number;
  private last?: number;

  arm(config: { threshold: number; durationMs: number }, detected: () => void): void {
    this.disarm();
    this.config = { ...config };
    this.callback = detected;
  }

  sample({ rms, timeMs }: VolumeSample): void {
    if (!this.callback) return;
    if (!Number.isFinite(rms) || rms < 0 || rms > 1 || !Number.isFinite(timeMs) || timeMs < 0) {
      this.since = this.last = undefined;
      return;
    }
    if (this.last !== undefined && (timeMs <= this.last || timeMs - this.last > settings.maxSampleGapMs)) this.since = undefined;
    this.last = timeMs;
    if (rms <= this.config.threshold) { this.since = undefined; return; }
    if (this.since === undefined) { this.since = timeMs; this.firstExceeded?.({ rms, timeMs }); }
    if (timeMs - this.since >= this.config.durationMs) {
      const callback = this.callback;
      this.disarm();
      callback();
    }
  }

  disarm(): void { this.callback = undefined; this.since = this.last = undefined; }
}
