export const displayPreferencesKey = 'karaokesync.display-preferences.v1';
export interface DisplayPreferences { volumePercent: number; showHelp: boolean }
export const defaultDisplayPreferences: DisplayPreferences = { volumePercent: 60, showHelp: true };
export function readDisplayPreferences(storage: Pick<Storage, 'getItem'>): DisplayPreferences {
  const raw = storage.getItem(displayPreferencesKey);
  if (raw === null) return { ...defaultDisplayPreferences };
  const value = JSON.parse(raw);
  if (!value || !Number.isFinite(value.volumePercent) || value.volumePercent < 0 || value.volumePercent > 100 || typeof value.showHelp !== 'boolean') throw new Error('表示・確認音設定を読み込めません');
  return { volumePercent: value.volumePercent, showHelp: value.showHelp };
}
export function writeDisplayPreferences(storage: Pick<Storage, 'setItem'>, value: DisplayPreferences) {
  storage.setItem(displayPreferencesKey, JSON.stringify(value));
}
