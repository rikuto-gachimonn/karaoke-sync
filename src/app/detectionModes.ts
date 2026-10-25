import { settings } from '../config/settings';
import { selectedTrigger, triggerPosition, type SyncInput } from '../domain/sync';
import type { ModeProfile, SyncProfile } from './preferences';

export const detectionModes = ['vocal', 'accompaniment'] as const;
export type DetectionMode = typeof detectionModes[number];
export const detectionModeLabels: Record<DetectionMode, string> = { vocal: '歌声検知', accompaniment: '伴奏検知' };
export function detectionModeFor(input: SyncInput): DetectionMode {
  return selectedTrigger(input) === 'accompaniment' ? 'accompaniment' : 'vocal';
}
export function defaultDetectionProfile(videoId: string, service: SyncInput['service'], mode: DetectionMode, runtime: 'real' | 'simulation' = 'real'): ModeProfile {
  return { retainMic: true, input: { videoId, service, startTrigger: mode, savedPositionSec: 0, offsetSec: 0,
    threshold: settings.normalThreshold, durationMs: settings.normalDurationMs,
    playbackMode: runtime === 'real' ? 'preplay' : 'legacy', armedTimeoutMs: settings.defaultArmedTimeoutMs,
    compensation: { mode: 'baseline', waitMs: 0, offsetMs: 0 } } };
}
/** Read-only migration. The original legacy profile remains archived in the container. */
export function existingDetectionProfile(profile: SyncProfile | undefined, mode: DetectionMode): ModeProfile | undefined {
  if (!profile) return;
  if (profile.modeProfiles?.[mode]) return structuredClone(profile.modeProfiles[mode]);
  if (detectionModes.some(key => !!profile.modeProfiles?.[key])) return;
  if (mode === 'vocal' && selectedTrigger(profile.input) === 'accompaniment' && profile.input.vocalPositionSec === undefined) return;
  const { input, retainMic } = profile;
  const migrated = { input: { ...structuredClone(input), startTrigger: mode }, retainMic };
  if (mode === 'vocal') migrated.input.vocalPositionSec = selectedTrigger(input) === 'accompaniment' ? input.vocalPositionSec! : triggerPosition(input);
  return migrated;
}
export function selectDetectionProfile(profile: SyncProfile | undefined, videoId: string, service: SyncInput['service'], mode: DetectionMode, runtime: 'real' | 'simulation'): ModeProfile {
  return existingDetectionProfile(profile, mode) ?? defaultDetectionProfile(videoId, service, mode, runtime);
}
/** Only the explicitly saved mode changes; other modes and the legacy record are retained. */
export function withDetectionProfile(previous: SyncProfile | undefined, next: ModeProfile): SyncProfile {
  const mode = detectionModeFor(next.input);
  if (next.input.startTrigger !== mode) throw new Error('保存する検知モードが不正です');
  const base: SyncProfile = structuredClone(previous ?? next);
  if (base.input.videoId !== next.input.videoId || base.input.service !== next.input.service) throw new Error('曲・機種と設定が一致しません');
  const modeProfiles = { ...base.modeProfiles };
  if (previous && !detectionModes.some(key => !!previous.modeProfiles?.[key])) {
    for (const key of detectionModes) {
      const saved = existingDetectionProfile(previous, key);
      if (saved) modeProfiles[key] = saved;
    }
  }
  modeProfiles[mode] = { input: structuredClone(next.input), retainMic: next.retainMic };
  return { ...base, modeProfiles };
}

/** Restore only modes represented in the backup; retain other saved modes, including legacy fallbacks. */
export function mergeDetectionProfiles(current: SyncProfile | undefined, incoming: SyncProfile): SyncProfile {
  if (!current || (!current.modeProfiles && !incoming.modeProfiles && detectionModeFor(current.input) === detectionModeFor(incoming.input))) return structuredClone(incoming);
  const modeProfiles = { ...structuredClone(current.modeProfiles ?? {}), ...structuredClone(incoming.modeProfiles ?? {}) };
  for (const mode of detectionModes) {
    const explicitIncoming = incoming.modeProfiles?.[mode] ?? (detectionModeFor(incoming.input) === mode ? existingDetectionProfile(incoming, mode) : undefined);
    const value = explicitIncoming ?? existingDetectionProfile(current, mode) ?? existingDetectionProfile(incoming, mode);
    if (value) modeProfiles[mode] = value;
  }
  return { ...structuredClone(incoming), modeProfiles };
}
