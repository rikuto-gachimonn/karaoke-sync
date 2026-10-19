import { validateInput, environments, type SyncInput } from '../domain/sync';
import { settings } from '../config/settings';
import type { SyncProfile } from '../app/preferences';

export type Service = SyncInput['service'];
export interface Song { videoId: string; title: string; artist: string; accompanimentRef?: string; profiles: Partial<Record<Service, SyncProfile>> }
export interface Library { format: 'karaokesync-library'; version: 1; songs: Song[] }
export const libraryKey = 'karaokesync.app.library.v1';
export const libraryV2Key = 'karaokesync.app.library.v2';
export const libraryV3Key = 'karaokesync.app.library.v3';
export const libraryLimits = { songs: 1000, textLength: 200, backupBytes: 5 * 1024 * 1024 } as const;
export const emptyLibrary = (): Library => ({ format: 'karaokesync-library', version: 1, songs: [] });
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('データ形式が不正です');
  return value as Record<string, unknown>;
};
const text = (value: unknown, required: boolean) => {
  if (typeof value !== 'string' || value.length > libraryLimits.textLength || (required && !value.trim())) throw new Error('曲名・アーティストは200文字以内、曲名は必須です');
  return value.trim();
};
export function defaultProfile(videoId: string, service: Service, mode: 'real' | 'simulation' = 'real'): SyncProfile {
  return { retainMic: true, input: { videoId, service, savedPositionSec: 0, offsetSec: 0,
    threshold: settings.normalThreshold, durationMs: settings.normalDurationMs,
    playbackMode: mode === 'real' ? 'preplay' : 'legacy', armedTimeoutMs: settings.defaultArmedTimeoutMs,
    compensation: { mode: 'baseline', waitMs: 0, offsetMs: 0 } } };
}
export function validProfile(value: unknown, videoId: string, service: Service): SyncProfile {
  const profile = record(value); const input = record(profile.input) as unknown as SyncInput;
  if (typeof profile.retainMic !== 'boolean' || input.videoId !== videoId || input.service !== service) throw new Error('曲・機種と設定が一致しません');
  validateInput(input);
  if (input.compensation === null || input.playbackMode === null || input.armedTimeoutMs === null) throw new Error('同期設定が不正です');
  return structuredClone({ input, retainMic: profile.retainMic });
}
export function validSong(value: unknown): Song {
  const song = record(value);
  if (typeof song.videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(song.videoId)) throw new Error('動画IDは11文字です');
  const profiles = record(song.profiles);
  if (Object.keys(profiles).some(key => !environments.includes(key as Service))) throw new Error('対応していない機種の設定です');
  const result: Song = { videoId: song.videoId, title: text(song.title, true), artist: text(song.artist, false), profiles: {} };
  if (song.accompanimentRef !== undefined) result.accompanimentRef = validAccompaniment(song.accompanimentRef);
  for (const service of environments) if (profiles[service] !== undefined) result.profiles[service] = validProfile(profiles[service], song.videoId, service);
  return result;
}
export function validAccompaniment(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('伴奏の記録はYouTube URLまたは動画ID（2048文字以内）です');
  const reference = value.trim();
  if (!reference || /^[A-Za-z0-9_-]{11}$/.test(reference)) return reference;
  try {
    const url = new URL(reference);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) throw new Error();
    const id = url.hostname === 'youtu.be' ? url.pathname.slice(1) :
      ['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname) ?
        url.pathname === '/watch' ? url.searchParams.get('v') : url.pathname.match(/^\/(?:embed|shorts)\/([A-Za-z0-9_-]{11})$/)?.[1] : undefined;
    if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error();
    return reference;
  } catch { throw new Error('伴奏の記録はYouTube動画のURLまたは11文字のIDを入力してください'); }
}
// 外部保存v2は別の識別子。内部モデルは既存の検証・マージ関数と共有する。
export function encodeLibraryV2(library: Library) { return { format: 'karaokesync-library-v2', version: 2, songs: library.songs }; }
export function decodeLibraryV2(value: unknown): Library {
  const data = record(value);
  if (data.format !== 'karaokesync-library-v2' || data.version !== 2) throw new Error('曲リストv2の形式が不正です');
  return validLibrary({ ...data, format: 'karaokesync-library', version: 1 });
}
export function encodeLibraryV3(library:Library) { return {format:'karaokesync-library-v3',version:3,songs:library.songs}; }
export function decodeLibraryV3(value:unknown):Library {
  const data=record(value);
  if(data.format!=='karaokesync-library-v3'||data.version!==3) throw new Error('曲リストv3の形式が不正です');
  return validLibrary({...data,format:'karaokesync-library',version:1});
}
const normalized = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
export function duplicate(a: Song, b: Song) {
  return a.videoId === b.videoId || (!!a.artist && !!b.artist && normalized(a.title) === normalized(b.title) && normalized(a.artist) === normalized(b.artist));
}
export function validLibrary(value: unknown): Library {
  const data = record(value);
  if (data.format !== 'karaokesync-library' || data.version !== 1 || !Array.isArray(data.songs) || data.songs.length > libraryLimits.songs) throw new Error('曲リストの形式・バージョン・曲数が不正です');
  const songs = data.songs.map(validSong);
  for (let i = 0; i < songs.length; i++) if (songs.slice(0, i).some(other => duplicate(songs[i]!, other))) throw new Error('動画IDまたは曲名・アーティストが重複しています');
  return { format: 'karaokesync-library', version: 1, songs };
}
export function upsertSong(library: Library, song: Song, previousVideoId?: string): Library {
  const candidate = validSong(song);
  if (previousVideoId && !library.songs.some(item => item.videoId === previousVideoId)) throw new Error('編集対象が見つかりません');
  const songs = previousVideoId ? library.songs.map(item => item.videoId === previousVideoId ? candidate : item) : [...library.songs, candidate];
  return validLibrary({ ...library, songs });
}
export function changeSongIdentity(song: Song, videoId: string, title: string, artist: string, accompanimentRef?: string): Song {
  const changed = structuredClone(song); changed.videoId = videoId; changed.title = title; changed.artist = artist;
  for (const profile of Object.values(changed.profiles)) profile.input.videoId = videoId;
  if (accompanimentRef !== undefined) changed.accompanimentRef = accompanimentRef;
  return validSong(changed);
}
export function setSongProfile(library: Library, videoId: string, profile: SyncProfile): Library {
  const song = library.songs.find(item => item.videoId === videoId);
  if (!song) throw new Error('曲が見つかりません');
  return upsertSong(library, { ...song, profiles: { ...song.profiles, [profile.input.service]: validProfile(profile, videoId, profile.input.service) } }, videoId);
}
export function deleteSong(library: Library, videoId: string): Library {
  return validLibrary({ ...library, songs: library.songs.filter(song => song.videoId !== videoId) });
}
export interface StoragePort { getItem(key: string): string | null; setItem(key: string, value: string): void }
/** 単一キーへ一括書込。検証・競合確認・setItem成功後だけメモリを更新する。 */
export class SongLibrary {
  private raw: string | null;
  private data: Library;
  private key: string;
  private legacyReads = new Map<string,string|null>();
  constructor(private storage: StoragePort, private storageVersion: 1 | 2 | 3 = 1) {
    this.key = storageVersion === 3 ? libraryV3Key : storageVersion === 2 ? libraryV2Key : libraryKey;
    this.raw = storage.getItem(this.key);
    if (storageVersion !== 1 && this.raw === null) {
      const previous = storageVersion===3 ? [libraryV2Key,libraryKey] : [libraryKey];
      this.data=emptyLibrary();
      for(const key of previous) {
        const raw=storage.getItem(key);this.legacyReads.set(key,raw);
        if(raw!==null) {this.data=key===libraryV2Key?decodeLibraryV2(JSON.parse(raw)):validLibrary(JSON.parse(raw));break;}
      }
    } else this.data = this.raw === null ? emptyLibrary() : storageVersion === 3 ? decodeLibraryV3(JSON.parse(this.raw)) : storageVersion === 2 ? decodeLibraryV2(JSON.parse(this.raw)) : validLibrary(JSON.parse(this.raw));
  }
  snapshot(): Library { return structuredClone(this.data); }
  commit(value: Library): Library {
    const next = validLibrary(value);
    if (this.storage.getItem(this.key) !== this.raw || (this.raw === null && [...this.legacyReads].some(([key,raw])=>this.storage.getItem(key)!==raw))) throw new Error('別タブで曲リストが更新されました。再読込してからやり直してください');
    const raw = JSON.stringify(this.storageVersion === 3 ? encodeLibraryV3(next) : this.storageVersion === 2 ? encodeLibraryV2(next) : next);
    if (new Blob([raw]).size > libraryLimits.backupBytes) throw new Error('曲リストが5MiBの保存上限を超えています');
    this.storage.setItem(this.key, raw);
    this.raw = raw; this.data = next; return this.snapshot();
  }
  export(): string { return JSON.stringify({ ...(this.storageVersion === 3 ? encodeLibraryV3(this.data) : this.storageVersion === 2 ? encodeLibraryV2(this.data) : this.data), exportedAt: new Date().toISOString() }, null, 2); }
}
