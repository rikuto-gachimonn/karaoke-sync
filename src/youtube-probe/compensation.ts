export type CompensationMode = 'baseline' | 'wait' | 'position' | 'combined';
export interface Compensation { mode: CompensationMode; waitMs: number; offsetMs: number }
export const compensationDefaults: Compensation = { mode: 'baseline', waitMs: 0, offsetMs: 0 };
export function effectiveCompensation(value: Compensation) {
  if (!['baseline', 'wait', 'position', 'combined'].includes(value.mode) ||
    !Number.isInteger(value.waitMs) || value.waitMs < 0 || value.waitMs > 60000 ||
    !Number.isInteger(value.offsetMs) || Math.abs(value.offsetMs) > 86400000) throw new Error('補正設定が不正です（待機0〜60000ms、位置補正±86400000msの整数）');
  return { ...value, waitMs: value.mode === 'wait' || value.mode === 'combined' ? value.waitMs : 0,
    offsetMs: value.mode === 'position' || value.mode === 'combined' ? value.offsetMs : 0 };
}
export function correctedPosition(startSec: number, offsetMs: number, durationSec: number) {
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error('動画長を取得できないため範囲を保証できません。新しい試行で再検証してください');
  const rawSec = startSec + offsetMs / 1000;
  return { rawSec, seekSec: Math.max(0, Math.min(durationSec, rawSec)), durationSec };
}
