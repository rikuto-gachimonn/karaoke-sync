import { settings } from '../config/settings';
import { effectiveCompensation, type Compensation } from '../youtube-probe/compensation';

export const startTriggers = ['accompaniment', 'vocal', 'cue', 'manual'] as const;
export type StartTrigger = typeof startTriggers[number];
export const triggerLabels: Record<StartTrigger,string> = { accompaniment:'伴奏検知', vocal:'歌声トリガー', cue:'発声合図', manual:'手動開始' };
export const triggerDescriptions: Record<StartTrigger,string> = {
  accompaniment:'従来どおり、伴奏のRMS音量で開始します。',
  vocal:'自分の歌い出しを合図にします。RMS音量だけで判定し、歌声や話者を識別しません。伴奏や雑音でも反応します。',
  cue:'任意の発声を合図にします。RMS音量だけで判定し、言葉の認識や話者の識別はしません。伴奏や雑音でも反応します。',
  manual:'準備完了後に開始ボタンで再生します。マイクは取得せず音検知は行いません。事前再生方式を推奨します。',
};
export function selectedTrigger(input:SyncInput):StartTrigger { return input.startTrigger ?? 'accompaniment'; }
export function triggerPosition(input:SyncInput):number {
  return selectedTrigger(input)==='vocal' ? input.vocalPositionSec ?? input.savedPositionSec : selectedTrigger(input)==='cue' ? input.cuePositionSec ?? input.savedPositionSec : input.savedPositionSec;
}
export interface SyncInput {
  startTrigger?: StartTrigger;
  vocalPositionSec?: number;
  cuePositionSec?: number;
  videoId: string;
  service: 'DAM' | 'JOYSOUND' | 'HOME';
  savedPositionSec: number;
  offsetSec: number;
  threshold: number;
  durationMs: number;
  playbackMode?: 'legacy' | 'preplay';
  compensation?: Compensation;
  armedTimeoutMs?: number;
  startAdjustmentMs?: number;
  stabilizationWaitMs?: number;
  preseekBeforeDetection?: boolean;
  liveApplied?: {resultId:string;totalMs:number}[];
}

export function validateInput(input: SyncInput): void {
  if (!/^[\w-]{11}$/.test(input.videoId)) throw new Error('動画IDは11文字で入力してください');
  if (!['DAM', 'JOYSOUND', 'HOME'].includes(input.service)) throw new Error('機種・利用環境を選択してください');
  if (!Number.isFinite(input.savedPositionSec) || input.savedPositionSec < 0) throw new Error('開始位置は0以上の有限数です');
  if (!Number.isFinite(input.offsetSec) || Math.abs(input.offsetSec) > settings.maxOffsetSec) throw new Error('補正は-30〜30秒です');
  if (!Number.isFinite(input.threshold) || input.threshold < 0 || input.threshold > 1) throw new Error('しきい値は0〜1です');
  if (!Number.isInteger(input.durationMs) || input.durationMs < 0 || input.durationMs > settings.maxDurationMs) throw new Error('継続時間は0〜2000msの整数です');
  if (input.playbackMode !== undefined && !['legacy', 'preplay'].includes(input.playbackMode)) throw new Error('再生方式が不正です');
  if (input.startTrigger !== undefined && !startTriggers.includes(input.startTrigger)) throw new Error('開始トリガーが不正です');
  for (const value of [input.vocalPositionSec,input.cuePositionSec]) if (value !== undefined && (!Number.isFinite(value)||value<0)) throw new Error('歌声・発声合図の開始位置は0以上の有限数です');
  if (input.compensation) effectiveCompensation(input.compensation);
  if (input.startAdjustmentMs !== undefined && (!Number.isSafeInteger(input.startAdjustmentMs) || Math.abs(input.startAdjustmentMs) > settings.maxStartAdjustmentMs)) throw new Error('実効開始位置の調整は±86400000msの整数です');
  if(input.stabilizationWaitMs!==undefined && (!Number.isInteger(input.stabilizationWaitMs)||input.stabilizationWaitMs<0||input.stabilizationWaitMs>60000)) throw new Error('安定化待機は0〜60000msの整数です');
  if(input.preseekBeforeDetection===true && input.playbackMode!=='preplay')throw new Error('事前シークは事前再生方式で比較してください');
  if(input.preseekBeforeDetection!==undefined && typeof input.preseekBeforeDetection!=='boolean') throw new Error('事前シーク設定が不正です');
  if(input.liveApplied!==undefined && (!Array.isArray(input.liveApplied)||input.liveApplied.length>30||input.liveApplied.some(item=>!item||typeof item.resultId!=='string'||item.resultId.length>100||!Number.isSafeInteger(item.totalMs)||Math.abs(item.totalMs)>86400000)||new Set(input.liveApplied.map(item=>item.resultId)).size!==input.liveApplied.length)) throw new Error('補正採用履歴が不正です');
  if (input.armedTimeoutMs !== undefined && (!Number.isInteger(input.armedTimeoutMs) || input.armedTimeoutMs < 1000 || input.armedTimeoutMs > settings.maxArmedTimeoutMs)) throw new Error('待機期限は1〜1800秒です');
  playbackPlan(input);
}

export function startPosition(input: SyncInput): number {
  return Math.max(0, (Math.round(triggerPosition(input) * 1_000) + Math.round(input.offsetSec * 1_000)) / 1_000);
}

export function adjustPosition(value: number, steps: number): number {
  return (Math.round(value * 1_000) + steps * settings.positionStepMs) / 1_000;
}

export const environments = ['DAM', 'JOYSOUND', 'HOME'] as const;
export const environmentLabels = { DAM: 'DAM', JOYSOUND: 'JOYSOUND', HOME: '自宅テスト（PC＋スピーカー）' } as const;
export function positionComponentsMs(input: SyncInput) {
  const baseMs = Math.max(0, Math.round(triggerPosition(input) * 1000) + Math.round(input.offsetSec * 1000));
  const bMs = effectiveCompensation(input.compensation ?? { mode: 'baseline', waitMs: 0, offsetMs: 0 }).offsetMs;
  const adjustmentMs = input.startAdjustmentMs ?? 0;
  if (![baseMs, bMs, adjustmentMs, baseMs + bMs + adjustmentMs].every(Number.isSafeInteger)) throw new Error('開始位置を安全な整数msで表現できません');
  return { baseMs, bMs, adjustmentMs, effectiveMs: Math.max(0, baseMs + bMs + adjustmentMs) };
}
/** 末尾の主調整だけを更新する。既存オフセットやBへ同じ値を書き込まない。 */
export function adjustEffectiveStart(input: SyncInput, deltaMs: number): SyncInput {
  if (!Number.isSafeInteger(deltaMs)) throw new Error('調整刻みは整数msです');
  if (deltaMs === 0) return { ...input };
  const { baseMs, bMs } = positionComponentsMs(input);
  const targetMs = baseMs + bMs + (input.startAdjustmentMs ?? 0) + deltaMs;
  const startAdjustmentMs = Math.max(-settings.maxStartAdjustmentMs, Math.min(settings.maxStartAdjustmentMs, targetMs - baseMs - bMs));
  return { ...input, startAdjustmentMs };
}

/** 提案の明示採用時のみ呼ぶ。既存の同期位置・比較設定を変更しない。 */
export function adoptThreshold(input:SyncInput,value:number):SyncInput {
  if(!Number.isFinite(value)||value<0||value>1) throw new Error('しきい値は0〜1です');
  return {...input,threshold:value};
}

/** 保存基準は不変。安定化待機を位置へ加算し、残る負位置は追加待機へ変換する。 */
export function playbackPlan(input: SyncInput) {
  const {bMs,adjustmentMs}=positionComponentsMs(input);
  const userPositionMs=Math.round(triggerPosition(input)*1000)+Math.round(input.offsetSec*1000)+bMs+adjustmentMs;
  const stabilizationMs=input.stabilizationWaitMs??0;
  if(!Number.isInteger(stabilizationMs)||stabilizationMs<0||stabilizationMs>60000) throw new Error('安定化待機が不正です');
  const rawMs=userPositionMs+stabilizationMs;
  if(!Number.isSafeInteger(rawMs)) throw new Error('開始位置を整数msで表現できません');
  const fixedWaitMs=effectiveCompensation(input.compensation ?? {mode:'baseline',waitMs:0,offsetMs:0}).waitMs;
  return {rawMs,userPositionMs,stabilizationMs,fixedWaitMs,seekSec:Math.max(0,rawMs)/1000,negativeWaitMs:Math.max(0,-rawMs),waitMs:fixedWaitMs+stabilizationMs+Math.max(0,-rawMs)};
}
