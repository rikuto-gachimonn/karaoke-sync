// 実測前の暫定値。製品の対応可否や同期精度を保証する値ではない。
export const settings = {
  positionStepMs: 50,
  meterUpdateMs: 100,
  meterStaleMs: 1000,
  measurementDurationMs: 4000,
  measurementMaxGapMs: 500,
  measurementMinSamples: 20,
  maxStartAdjustmentMs: 86_400_000,
  defaultThreshold: 0.08, // 検証ページの既定値は維持
  defaultDurationMs: 50,
  normalThreshold: 0.035,
  normalDurationMs: 200,
  maxDurationMs: 2_000,
  maxOffsetSec: 30,
  maxSampleGapMs: 100,
  acquireTimeoutMs: 60_000,
  prepareTimeoutMs: 15_000,
  armedTimeoutMs: 300_000, // 検証ページの従来上限は維持
  defaultArmedTimeoutMs: 1_800_000,
  maxArmedTimeoutMs: 1_800_000,
  playingTimeoutMs: 10_000,
  cleanupTimeoutMs: 3_000,
  audioStartTimeoutMs: 3_000,
  maxDetachedAcquisitions: 2,
  triggerTrialMaxEntries: 30,
  logMaxEntries: 2_000,
  logMaxBytes: 1_048_576,
} as const;

export interface SessionOptions {
  acquireTimeoutMs: number;
  prepareTimeoutMs: number;
  armedTimeoutMs: number;
  playingTimeoutMs: number;
  cleanupTimeoutMs: number;
  // 模擬試験用。製品での採用方針は段階2の実測後に決定する。
  retainMic: boolean;
}

export const sessionOptions: SessionOptions = { ...settings, armedTimeoutMs: settings.defaultArmedTimeoutMs, retainMic: true };
