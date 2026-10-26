export const displayPreferencesKey = 'karaokesync.display-preferences.v1';
export interface DisplayPreferences { volumePercent: number; showHelp: boolean; volumeScale: 3 }
export const defaultDisplayPreferences: DisplayPreferences = { volumePercent: 20, showHelp: true, volumeScale: 3 };
type ReadStorage = Pick<Storage, 'getItem'>;
function decode(raw: string | null): { value: DisplayPreferences; migrated: boolean } {
  if (raw === null) return { value: { ...defaultDisplayPreferences }, migrated: false };
  const value = JSON.parse(raw);
  if (!value || !Number.isFinite(value.volumePercent) || value.volumePercent < 0 || value.volumePercent > 100 || typeof value.showHelp !== 'boolean' || (value.volumeScale !== undefined && ![1, 2, 3].includes(value.volumeScale))) throw new Error('表示・確認音設定を読み込めません');
  // Preserve exact gain, including fractional percentages; never round legacy audio upward.
  const ratio = value.volumeScale === 3 ? 1 : value.volumeScale === 2 ? .5 : .25;
  return { value: { volumePercent: value.volumePercent * ratio, showHelp: value.showHelp, volumeScale: 3 }, migrated: value.volumeScale !== 3 };
}
export function readDisplayPreferences(storage: ReadStorage): DisplayPreferences {
  return decode(storage.getItem(displayPreferencesKey)).value;
}
export function writeDisplayPreferences(storage: Pick<Storage, 'setItem'>, value: DisplayPreferences) {
  storage.setItem(displayPreferencesKey, JSON.stringify(value));
}
/** Persist the converted percentage and its scale in one write, only for legacy records. */
export function loadDisplayPreferences(storage: ReadStorage & Pick<Storage, 'setItem'>) {
  const decoded = decode(storage.getItem(displayPreferencesKey));
  let error = '';
  if (decoded.migrated) {
    try { writeDisplayPreferences(storage, decoded.value); }
    catch (cause) { error = `確認音設定の移行を保存できません。今回は従来のゲインを維持します: ${String(cause)}`; }
  }
  return { value: decoded.value, error };
}
