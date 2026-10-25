import { existingDetectionProfile, withDetectionProfile, type DetectionMode } from '../app/detectionModes';
import { settings } from '../config/settings';
import { environments } from '../domain/sync';
import { type SyncProfile } from '../app/preferences';
import { type Library, type Service } from './model';

export interface AudioSettings { threshold: number; durationMs: number }
/** Build a preview without writes. Only existing library/fallback profiles are included. */
export function planAudioSettings(library: Library, values: AudioSettings,
  fallback?: (videoId: string, service: Service) => SyncProfile | undefined, detectionMode?: DetectionMode) {
  if (!Number.isFinite(values.threshold) || values.threshold < 0 || values.threshold > 1) throw new Error('しきい値は0〜1です');
  if (!Number.isInteger(values.durationMs) || values.durationMs < 0 || values.durationMs > settings.maxDurationMs) throw new Error('継続時間は0〜2000msの整数です');
  if (!library.songs.length) throw new Error('保存済みの曲がありません。先に曲を登録してください');
  const next = structuredClone(library);
  let songCount = 0; let profileCount = 0;
  for (const song of next.songs) {
    let count = 0;
    for (const service of environments) {
      const profile = song.profiles[service] ?? fallback?.(song.videoId, service);
      if (!profile) continue;
      if (!detectionMode && profile.modeProfiles) throw new Error('モード別設定の一括適用には対象モードを選択してください');
      if (detectionMode) {
        const saved = existingDetectionProfile(profile, detectionMode);
        if (!saved) continue;
        song.profiles[service] = withDetectionProfile(profile, { ...saved, input: { ...saved.input, ...values } });
      } else {
        song.profiles[service] = { ...structuredClone(profile), input: { ...structuredClone(profile.input), ...values } };
      }
      count++;
    }
    if (count) songCount++;
    profileCount += count;
  }
  if (!profileCount) throw new Error('保存済みの音検知設定がありません。先に曲・機種の設定を保存してください');
  return { source: JSON.stringify(library), library: next, songCount, profileCount, detectionMode, values: { ...values } };
}
