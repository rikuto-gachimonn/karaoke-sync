export interface VolumeSummary { count: number; median: number; p10: number; p90: number; max: number }
export function summarize(values: number[]): VolumeSummary {
  if (!values.length || values.some(value => !Number.isFinite(value) || value < 0 || value > 1)) throw new Error('有効なRMS測定値がありません');
  const sorted = [...values].sort((a,b) => a-b);
  const q = (fraction: number) => { const index = (sorted.length-1)*fraction; const low = Math.floor(index); return sorted[low]! + (sorted[Math.ceil(index)]!-sorted[low]!)*(index-low); };
  return { count: sorted.length, median: q(0.5), p10: q(0.1), p90: q(0.9), max: sorted.at(-1)! };
}
export function suggestThreshold(noise?: VolumeSummary, music?: VolumeSummary): { value?: number; reason: string } {
  if (!noise || !music) return { reason: '雑音と伴奏を両方測定してください' };
  const gap = music.p10-noise.p90;
  const margin = Math.max(0.005, noise.p90*0.25);
  if (music.p90 < 0.001) return { reason: '伴奏が無音または極小です。入力元・音量を確認してください' };
  if (gap < margin) return { reason: '雑音と伴奏の分布が重なるか差が小さく、区別が困難です。位置・入力元・伴奏音量を見直して再測定してください' };
  return { value: Math.round(((noise.p90+music.p10)/2)*1e6)/1e6, reason: '雑音P90と伴奏P10の中間値。差が max(0.005, 雑音P90×25%) 以上の場合のみ提案します。突発音の最大値は候補計算に使いません。冒頭の小音・継続時間・実際の誤検知は別途確認が必要です' };
}
