import { defaultProfile, decodeLibraryV3, decodeLibraryV2, duplicate, emptyLibrary, libraryLimits, validLibrary, validSong, type Library, type Service, type Song } from './model';
import { environments } from '../domain/sync';

export interface ImportData { library: Library; source: string; warnings: string[] }
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('旧バックアップの形式が不正です');
  return value as Record<string, unknown>;
};
function oldNumber(value: unknown, fallback: number): number {
  if (value === null || value === undefined) return fallback;
  if ((typeof value !== 'string' && typeof value !== 'number') || (typeof value === 'string' && !value.trim())) throw new Error('旧形式の数値が不正です');
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error('旧形式の数値が不正です');
  return number;
}
export function parseImport(raw: string, unassignedService?: Service): ImportData {
  if (new Blob([raw]).size > libraryLimits.backupBytes) throw new Error('JSONは5MiB以内にしてください');
  const data = object(JSON.parse(raw.replace(/^\uFEFF/, '')));
  if (data.format === 'karaokesync-library-v3') return { library: decodeLibraryV3(data), source: 'React版 v3', warnings: [] };
  if (data.format === 'karaokesync-library-v2') return { library: decodeLibraryV2(data), source: 'React版 v2', warnings: [] };
  if (data.format === 'karaokesync-library') return { library: validLibrary(data), source: 'React版 v1', warnings: [] };
  if (data.appName !== 'Karaoke Sync' || data.backupVersion !== '0.6' || !Array.isArray(data.songs) || data.songs.length > libraryLimits.songs) throw new Error('対応形式はReact版v1/v2/v3または旧HTML版バックアップ0.6です');
  const warnings: string[] = ['旧形式は動画単位で機種別の設定を持ちません。記録された機種だけへ割り当て、他方には複製しません。旧キーは変更しません。'];
  const songs: Song[] = data.songs.map(value => {
    const old = object(value);
    const info = old.songInfo == null ? {} : object(old.songInfo);
    const detect = old.detectSettings == null ? {} : object(old.detectSettings);
    const recorded = info.service;
    if (recorded !== undefined && recorded !== '' && recorded !== 'DAM' && recorded !== 'JOYSOUND') throw new Error('旧形式の機種値が不正です');
    const service = recorded === 'DAM' || recorded === 'JOYSOUND' ? recorded : unassignedService;
    if (!service) throw new Error('機種未選択の旧データがあります。移行先機種を選択してから読み直してください');
    if (recorded !== 'DAM' && recorded !== 'JOYSOUND') warnings.push(`${String(old.videoId)}: 機種未選択の設定を指定された${service}へ割り当てます`);
    if (typeof old.videoId !== 'string') throw new Error('旧形式の動画IDが不正です');
    const profile = defaultProfile(old.videoId, service);
    profile.input.savedPositionSec = oldNumber(old.savedSec, 0);
    if (old.savedSec == null) warnings.push(`${old.videoId}: 開始位置は未保存のため初期値0秒。使用前に再設定してください`);
    const offsetMs = oldNumber(detect.offset, 0) * 1000;
    if (Math.abs(offsetMs - Math.round(offsetMs)) > 0.000001) throw new Error('旧補正値を整数msで表現できません。元データを確認してください');
    profile.input.compensation = { mode: offsetMs === 0 ? 'baseline' : 'position', waitMs: 0, offsetMs: Math.round(offsetMs) };
    profile.input.threshold = oldNumber(detect.threshold, 0.08);
    profile.input.durationMs = 0; // 旧版は最初のRMS超過で検知している。
    if (info.title !== undefined && typeof info.title !== 'string' || info.artist !== undefined && typeof info.artist !== 'string') throw new Error('旧曲情報が不正です');
    return validSong({ videoId: old.videoId, title: typeof info.title === 'string' && info.title.trim() ? info.title : `未設定 (${old.videoId})`, artist: info.artist ?? '', profiles: { [service]: profile } });
  });
  return { library: validLibrary({ ...emptyLibrary(), songs }), source: '旧HTML版 0.6', warnings };
}
export interface ImportChoice { videoId: string; add: boolean; metadata: boolean; profiles: Record<Service, boolean> }
export function importChoices(current: Library, incoming: Library): ImportChoice[] {
  return incoming.songs.map(song => {
    const existing = current.songs.find(item => item.videoId === song.videoId);
    return { videoId: song.videoId, add: !existing && !current.songs.some(item => duplicate(item, song)), metadata: false,
      profiles: { DAM: !!song.profiles.DAM && !existing?.profiles.DAM, JOYSOUND: !!song.profiles.JOYSOUND && !existing?.profiles.JOYSOUND, HOME: !!song.profiles.HOME && !existing?.profiles.HOME } };
  });
}
export function mergeImport(current: Library, incoming: Library, choices: ImportChoice[]): Library {
  const songs = structuredClone(current.songs);
  for (const song of incoming.songs) {
    const choice = choices.find(item => item.videoId === song.videoId);
    if (!choice) throw new Error('復元プレビューの選択がありません');
    const index = songs.findIndex(item => item.videoId === song.videoId);
    if (index < 0) { if (choice.add) songs.push(structuredClone(song)); continue; }
    const existing = songs[index]!;
    if (choice.metadata) { existing.title = song.title; existing.artist = song.artist; if (song.accompanimentRef !== undefined) existing.accompanimentRef = song.accompanimentRef; }
    for (const service of environments) if (choice.profiles[service] && song.profiles[service]) existing.profiles[service] = structuredClone(song.profiles[service]);
  }
  return validLibrary({ ...current, songs });
}
export function readLegacyBackup(storage: Pick<Storage, 'getItem'>): string {
  const raw = storage.getItem('song_list');
  if (raw === null) throw new Error('このオリジンに旧曲リストはありません。旧HTMLで書き出したJSONを使用してください');
  const ids: unknown = JSON.parse(raw);
  if (!Array.isArray(ids) || ids.length > libraryLimits.songs || !ids.every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id))) throw new Error('旧曲リストが不正です');
  return JSON.stringify({ appName: 'Karaoke Sync', backupVersion: '0.6', songs: ids.map(videoId => ({ videoId,
    savedSec: storage.getItem(`sync_${videoId}`), songInfo: JSON.parse(storage.getItem(`song_info_${videoId}`) ?? 'null') as unknown,
    detectSettings: JSON.parse(storage.getItem(`detect_settings_${videoId}`) ?? 'null') as unknown })) });
}
