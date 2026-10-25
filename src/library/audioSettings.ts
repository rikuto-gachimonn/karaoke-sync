import { existingDetectionProfile, withDetectionProfile, type DetectionMode } from '../app/detectionModes';
import { settings } from '../config/settings';
import { environments, triggerPosition, validateInput, type SyncInput } from '../domain/sync';
import { type SyncProfile } from '../app/preferences';
import { type Library, type Service } from './model';

export interface AudioSettings { threshold: number; durationMs: number }
export type ApplyScope = 'audio' | 'sync';
export const syncSettingKeys = ['offsetSec', 'startAdjustmentMs', 'playbackMode', 'compensation', 'stabilizationWaitMs', 'preseekBeforeDetection'] as const;
/** Explicit allowlist: never copy identity, another mode's positions, timeout, mic policy or adoption history. */
function copySyncSettings(target: SyncInput, source: SyncInput, mode: DetectionMode): SyncInput {
  const next = structuredClone(target);
  for (const key of syncSettingKeys) Object.assign(next, { [key]: structuredClone(source[key]) });
  next.autoCompensateDetectionDuration = source.autoCompensateDetectionDuration === true;
  if (mode === 'vocal') next.vocalPositionSec = triggerPosition(source);
  else next.savedPositionSec = triggerPosition(source);
  validateInput(next);
  return next;
}
/** Build a preview without writes. Only existing library/fallback profiles are included. */
export function planAudioSettings(library: Library, values: AudioSettings,
  fallback?: (videoId: string, service: Service) => SyncProfile | undefined, detectionMode?: DetectionMode, syncInput?: SyncInput) {
  const audioValues = { threshold: values.threshold, durationMs: values.durationMs };
  const scope: ApplyScope = syncInput ? 'sync' : 'audio';
  if (syncInput) {
    validateInput(syncInput);
    if (!detectionMode || syncInput.startTrigger !== detectionMode) throw new Error('一括適用のモードが一致しません');
  }
  if (!Number.isFinite(values.threshold) || values.threshold < 0 || values.threshold > 1) throw new Error('しきい値は0〜1です');
  if (!Number.isInteger(values.durationMs) || values.durationMs < 0 || values.durationMs > settings.maxDurationMs) throw new Error('継続時間は0〜2000msの整数です');
  if (!library.songs.length) throw new Error('保存済みの曲がありません。先に曲を登録してください');
  const next = structuredClone(library);
  let songCount = 0; let profileCount = 0;
  const serviceCounts = { DAM: 0, JOYSOUND: 0, HOME: 0 };
  const fallbackSources: {videoId:string;service:Service;source:string}[] = [];
  for (const song of next.songs) {
    let count = 0;
    for (const service of environments) {
      const profile = song.profiles[service] ?? fallback?.(song.videoId, service);
      if (!profile) continue;
      if (!song.profiles[service]) fallbackSources.push({videoId:song.videoId,service,source:JSON.stringify(profile)});
      if (!detectionMode && profile.modeProfiles) throw new Error('モード別設定の一括適用には対象モードを選択してください');
      if (detectionMode) {
        const saved = existingDetectionProfile(profile, detectionMode);
        if (!saved) continue;
        const nextInput = syncInput ? copySyncSettings(saved.input, syncInput, detectionMode) : saved.input;
        song.profiles[service] = withDetectionProfile(profile, { ...saved, input: { ...nextInput, ...audioValues } });
      } else {
        song.profiles[service] = { ...structuredClone(profile), input: { ...structuredClone(profile.input), ...audioValues } };
      }
      count++; serviceCounts[service]++;
    }
    if (count) songCount++;
    profileCount += count;
  }
  if (!profileCount) throw new Error('保存済みの音検知設定がありません。先に曲・機種の設定を保存してください');
  return { source: JSON.stringify(library), library: next, songCount, profileCount, serviceCounts, fallbackSources, scope, syncInput: syncInput ? structuredClone(syncInput) : undefined, detectionMode, values: { ...audioValues } };
}
