import { validProfile } from '../library/model';
import { type SyncInput } from '../domain/sync';

export const preferencesKey = 'karaokesync.app.sync-preferences.v1';
export const preferencesV2Key = 'karaokesync.app.sync-preferences.v2';
export const preferencesV4Key = 'karaokesync.app.sync-preferences.v4';
export const preferencesV3Key = 'karaokesync.app.sync-preferences.v3';
export interface ModeProfile { input: SyncInput; retainMic: boolean }
export interface SyncProfile extends ModeProfile { modeProfiles?: Record<string, ModeProfile> }
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;
interface Preferences { version: 1 | 2 | 3 | 4; profiles: Record<string, SyncProfile> }
const keyFor = (videoId: string, service: string) => `${videoId}:${service}`;
function read(storage: StoragePort, version: 1 | 2 | 3 | 4 = 1): Preferences {
  const raw = storage.getItem(version === 4 ? preferencesV4Key : version === 3 ? preferencesV3Key : version === 2 ? preferencesV2Key : preferencesKey);
  if (raw === null && version !== 1) return read(storage, version === 4 ? 3 : version === 3 ? 2 : 1);
  if (raw === null) return { version: 1, profiles: {} };
  const value = JSON.parse(raw) as Preferences;
  if (!value || value.version !== version || !value.profiles || typeof value.profiles !== 'object' || Array.isArray(value.profiles)) throw new Error('保存設定の形式が不正です。上書きせず停止しました');
  return value;
}
export function saveSyncProfile(storage: StoragePort, profile: SyncProfile, version: 1 | 2 | 3 | 4 = 1) {
  profile = validProfile(profile, profile.input.videoId, profile.input.service);
  const previous = read(storage, version);
  const profiles = { ...previous.profiles, [keyFor(profile.input.videoId, profile.input.service)]: profile };
  storage.setItem(version === 4 ? preferencesV4Key : version === 3 ? preferencesV3Key : version === 2 ? preferencesV2Key : preferencesKey, JSON.stringify({ version, profiles }));
}
export function loadSyncProfile(storage: StoragePort, videoId: string, service: string, version: 1 | 2 | 3 | 4 = 1): SyncProfile | undefined {
  const profile = read(storage, version).profiles[keyFor(videoId, service)];
  if (profile === undefined) return undefined;
  if (!profile || typeof profile !== 'object' || !profile.input || typeof profile.retainMic !== 'boolean') throw new Error('保存設定が不正です');
  return validProfile(profile, videoId, service as SyncInput['service']);
}
