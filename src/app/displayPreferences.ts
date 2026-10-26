export const displayPreferencesKey = 'karaokesync.display-preferences.v1';
export interface DisplayPreferences { volumePercent: number; showHelp: boolean; volumeScale?: 1 | 2 }
export const defaultDisplayPreferences: DisplayPreferences = { volumePercent: 30, showHelp: true, volumeScale: 2 };
export function readDisplayPreferences(storage: Pick<Storage, 'getItem'>): DisplayPreferences {
  const raw = storage.getItem(displayPreferencesKey);
  if (raw === null) return { ...defaultDisplayPreferences };
  const value = JSON.parse(raw);
  if (!value || !Number.isFinite(value.volumePercent) || value.volumePercent < 0 || value.volumePercent > 100 || typeof value.showHelp !== 'boolean' || (value.volumeScale !== undefined && value.volumeScale !== 1 && value.volumeScale !== 2)) throw new Error('表示・確認音設定を読み込めません');
  return { volumePercent: value.volumePercent, showHelp: value.showHelp, volumeScale: value.volumeScale ?? 1 };
}
export function writeDisplayPreferences(storage: Pick<Storage, 'setItem'>, value: DisplayPreferences) {
  storage.setItem(displayPreferencesKey, JSON.stringify(value));
}
