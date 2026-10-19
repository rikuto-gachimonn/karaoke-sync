import { validateInput, type SyncInput } from '../domain/sync';

export const preferencesKey = 'karaokesync.app.sync-preferences.v1';
export const preferencesV2Key = 'karaokesync.app.sync-preferences.v2';
export const preferencesV3Key = 'karaokesync.app.sync-preferences.v3';
export interface SyncProfile { input: SyncInput; retainMic: boolean }
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;
interface Preferences { version: 1 | 2 | 3; profiles: Record<string, SyncProfile> }
const keyFor = (videoId: string, service: string) => `${videoId}:${service}`;
function read(storage: StoragePort, version: 1 | 2 | 3 = 1): Preferences {
  const raw = storage.getItem(version === 3 ? preferencesV3Key : version === 2 ? preferencesV2Key : preferencesKey);
  if (raw === null && version !== 1) return read(storage, version === 3 ? 2 : 1);
  if (raw === null) return { version: 1, profiles: {} };
  const value = JSON.parse(raw) as Preferences;
  if (!value || value.version !== version || !value.profiles || typeof value.profiles !== 'object' || Array.isArray(value.profiles)) throw new Error('保存設定の形式が不正です。上書きせず停止しました');
  return value;
}
export function saveSyncProfile(storage: StoragePort, profile: SyncProfile, version: 1 | 2 | 3 = 1) {
  validateInput(profile.input);
  if (typeof profile.retainMic !== 'boolean') throw new Error('マイク保持設定が不正です');
  const previous = read(storage, version);
  const profiles = { ...previous.profiles, [keyFor(profile.input.videoId, profile.input.service)]: profile };
  storage.setItem(version === 3 ? preferencesV3Key : version === 2 ? preferencesV2Key : preferencesKey, JSON.stringify({ version, profiles }));
}
export function loadSyncProfile(storage: StoragePort, videoId: string, service: string, version: 1 | 2 | 3 = 1): SyncProfile | undefined {
  const profile = read(storage, version).profiles[keyFor(videoId, service)];
  if (profile === undefined) return undefined;
  if (!profile || typeof profile !== 'object' || !profile.input || typeof profile.retainMic !== 'boolean') throw new Error('保存設定が不正です');
  validateInput(profile.input);
  if (profile.input.videoId !== videoId || profile.input.service !== service) throw new Error('保存設定の動画・機種が一致しません');
  return profile;
}
