import { defaultDetectionProfile, detectionModeFor, existingDetectionProfile, withDetectionProfile, type DetectionMode } from '../app/detectionModes';
import { settings } from '../config/settings';
import { environments, type SyncInput } from '../domain/sync';
import { type SyncProfile } from '../app/preferences';
import { type Library, type Service } from './model';

export interface AudioSettings { threshold: number; durationMs: number }
/** Build a preview without writes. Explicit mode updates cover every song and service, creating only the selected mode when absent. */
export function planAudioSettings(library: Library, values: AudioSettings,
  fallback?: (videoId: string, service: Service) => SyncProfile | undefined, detectionMode?: DetectionMode, runtime: 'real' | 'simulation' = 'real') {
  const audioValues = { threshold: values.threshold, durationMs: values.durationMs };
  if (!Number.isFinite(values.threshold) || values.threshold < 0 || values.threshold > 1) throw new Error('しきい値は0〜1です');
  if (!Number.isInteger(values.durationMs) || values.durationMs < 0 || values.durationMs > settings.maxDurationMs) throw new Error('継続時間は0〜2000msの整数です');
  if (!library.songs.length) throw new Error('保存済みの曲がありません。先に曲を登録してください');
  const next = structuredClone(library);
  let songCount = 0; let profileCount = 0; let createdCount = 0;
  const serviceCounts = { DAM: 0, JOYSOUND: 0, HOME: 0 };
  const fallbackSources: {videoId:string;service:Service;source:string|undefined}[] = [];
  for (const song of next.songs) {
    let count = 0;
    for (const service of environments) {
      const profile = song.profiles[service] ?? fallback?.(song.videoId, service);
      if (!profile && !detectionMode) continue;
      if (!song.profiles[service]) fallbackSources.push({videoId:song.videoId,service,source:JSON.stringify(profile)});
      if (!detectionMode && profile?.modeProfiles) throw new Error('モード別設定の一括適用には対象モードを選択してください');
      if (detectionMode) {
        const existing = existingDetectionProfile(profile, detectionMode);
        if (!existing) createdCount++;
        const saved = existing ?? defaultDetectionProfile(song.videoId, service, detectionMode, runtime);
        song.profiles[service] = withDetectionProfile(profile, { ...saved, input: { ...saved.input, ...audioValues } });
      } else {
        song.profiles[service] = { ...structuredClone(profile!), input: { ...structuredClone(profile!.input), ...audioValues } };
      }
      count++; serviceCounts[service]++;
    }
    if (count) songCount++;
    profileCount += count;
  }
  if (!profileCount) throw new Error('保存済みの音検知設定がありません。先に曲・機種の設定を保存してください');
  return { source: JSON.stringify(library), library: next, songCount, profileCount, createdCount, serviceCounts, fallbackSources, detectionMode, values: { ...audioValues } };
}

/** Refresh only the applied audio fields; keep all unsaved position/compensation edits intact. */
export function refreshAppliedAudioInput(input: SyncInput, plan: ReturnType<typeof planAudioSettings>): SyncInput {
  if (!plan.detectionMode || detectionModeFor(input) !== plan.detectionMode) return input;
  const profile = plan.library.songs.find(song => song.videoId === input.videoId)?.profiles[input.service];
  const saved = existingDetectionProfile(profile, plan.detectionMode);
  return saved ? { ...input, threshold: saved.input.threshold, durationMs: saved.input.durationMs } : input;
}
