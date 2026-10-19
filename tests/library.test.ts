import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SongLibrary, libraryKey, libraryLimits, emptyLibrary, defaultProfile, validLibrary, validSong, upsertSong, deleteSong, changeSongIdentity, setSongProfile, type Song } from '../src/library/model';
import { parseImport, importChoices, mergeImport, readLegacyBackup } from '../src/library/backup';
import { selectSong } from '../src/library/selection';
import { SimulatedPlayer, SimulatedLease } from '../src/adapters/simulation';
import { SessionController } from '../src/session/controller';
import { SustainedVolumeDetector } from '../src/domain/detector';
import { sessionOptions } from '../src/config/settings';
import { DiagnosticLog } from '../src/diagnostics/log';
import type { AudioLease } from '../src/session/ports';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SongLibraryPanel } from '../src/ui/SongLibraryPanel';

const videoA = 'M7lc1UVf-VE'; const videoB = 'dQw4w9WgXcQ';
function song(videoId = videoA, title = '曲A', artist = '歌手A'): Song {
  return { videoId, title, artist, profiles: { DAM: defaultProfile(videoId, 'DAM') } };
}
function storage() {
  const data = new Map<string, string>([['old-data', 'unchanged']]);
  return { data, getItem: vi.fn((key: string) => data.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { data.set(key, value); }) };
}
function legacy(songs: unknown[] = [{ videoId: videoA, savedSec: '12.35', songInfo: { title: '旧曲', artist: '旧歌手', service: 'DAM' }, detectSettings: { offset: -0.05, threshold: 0.12 } }]) {
  return JSON.stringify({ appName: 'Karaoke Sync', backupVersion: '0.6', songs });
}
async function flush() { for (let i = 0; i < 100; i++) await Promise.resolve(); }

describe('曲リストの登録・編集・削除と永続化', () => {
  it('登録、編集、ID変更、削除で同期設定の帰属を維持する', () => {
    const library = upsertSong(emptyLibrary(), song());
    expect(library.songs).toHaveLength(1);
    const changed = changeSongIdentity(library.songs[0]!, videoB, '編集後', '歌手B');
    const edited = upsertSong(library, changed, videoA);
    expect(edited.songs[0]).toMatchObject({ videoId: videoB, title: '編集後', profiles: { DAM: { input: { videoId: videoB } } } });
    expect(library.songs[0]?.videoId).toBe(videoA);
    expect(deleteSong(edited, videoB).songs).toHaveLength(0);
  });
  it('動画IDと正規化した曲名・アーティストの重複を拒否する', () => {
    const library = upsertSong(emptyLibrary(), song(videoA, 'ABC  SONG', 'Singer'));
    expect(() => upsertSong(library, song(videoA, '別タイトル', '別歌手'))).toThrow('重複');
    expect(() => upsertSong(library, song(videoB, 'ａｂｃ song ', 'singer'))).toThrow('重複');
    expect(upsertSong(library, song(videoB, 'ABC SONG (別版)', 'Singer')).songs).toHaveLength(2);
  });
  it('機種別の位置・補正・検知・再生方式・保持設定を独立保存する', () => {
    let library = upsertSong(emptyLibrary(), song());
    const joy = defaultProfile(videoA, 'JOYSOUND'); joy.input.savedPositionSec = 25; joy.input.compensation = { mode: 'combined', waitMs: 100, offsetMs: -50 }; joy.retainMic = false;
    library = setSongProfile(library, videoA, joy);
    expect(library.songs[0]?.profiles.DAM?.input.savedPositionSec).toBe(0);
    expect(library.songs[0]?.profiles.JOYSOUND).toEqual(joy);
  });
  it('単一の新キーに保存し、再起動・バックアップで曲と全設定を復元する', () => {
    const s = storage(); const store = new SongLibrary(s);
    const library = store.commit(upsertSong(store.snapshot(), song()));
    expect(new SongLibrary(s).snapshot()).toEqual(library);
    expect(parseImport(store.export()).library).toEqual(library);
    expect(s.data.get('old-data')).toBe('unchanged');
    expect(s.getItem.mock.calls.every(([key]) => key === libraryKey)).toBe(true);
    expect(s.setItem.mock.calls.every(([key]) => key === libraryKey)).toBe(true);
  });
  it('書込み失敗時は保存済みデータ・メモリを更新しない', () => {
    const s = storage(); const store = new SongLibrary(s); store.commit(upsertSong(store.snapshot(), song()));
    const raw = s.data.get(libraryKey); const previous = store.snapshot();
    s.setItem.mockImplementationOnce(() => { throw new Error('QuotaExceededError'); });
    expect(() => store.commit(upsertSong(previous, song(videoB, '曲B', '歌手B')))).toThrow('Quota');
    expect(s.data.get(libraryKey)).toBe(raw); expect(store.snapshot()).toEqual(previous);
  });
  it('別タブの変更を上書きしない', () => {
    const s = storage(); const first = new SongLibrary(s); const second = new SongLibrary(s);
    first.commit(upsertSong(first.snapshot(), song()));
    expect(() => second.commit(upsertSong(second.snapshot(), song(videoB)))).toThrow('別タブ');
    expect(new SongLibrary(s).snapshot().songs[0]?.videoId).toBe(videoA);
  });
  it('破損・未知バージョンの保存データを自動初期化しない', () => {
    const s = storage(); s.data.set(libraryKey, 'broken'); expect(() => new SongLibrary(s)).toThrow(); expect(s.setItem).not.toHaveBeenCalled();
    s.data.set(libraryKey, JSON.stringify({ ...emptyLibrary(), version: 2 })); expect(() => new SongLibrary(s)).toThrow(); expect(s.setItem).not.toHaveBeenCalled();
  });
  it('曲名・動画ID・帰属・不正数値と曲数上限を検証する', () => {
    expect(() => validSong({ ...song(), title: '' })).toThrow(); expect(() => validSong({ ...song(), artist: 'a'.repeat(201) })).toThrow();
    expect(() => validSong({ ...song(), videoId: '<script>' })).toThrow();
    expect(() => validSong({ ...song(), profiles: { DAM: defaultProfile(videoB, 'DAM') } })).toThrow('一致');
    const profile = defaultProfile(videoA, 'DAM'); profile.input.durationMs = -1;
    expect(() => setSongProfile(upsertSong(emptyLibrary(), song()), videoA, profile)).toThrow();
    expect(() => validLibrary({ ...emptyLibrary(), songs: Array(libraryLimits.songs + 1).fill(song()) })).toThrow();
  });
  it('snapshotの外部変更で保存済み設定を汚染しない', () => {
    const store = new SongLibrary(storage()); store.commit(upsertSong(store.snapshot(), song()));
    const snapshot = store.snapshot(); snapshot.songs[0]!.profiles.DAM!.input.savedPositionSec = 999;
    expect(store.snapshot().songs[0]?.profiles.DAM?.input.savedPositionSec).toBe(0);
  });
});

describe('旧HTML形式と安全な復元プレビュー', () => {
  it('実際の0.6形式の秒文字列・負補正秒・検知しきい値を移行する', () => {
    const imported = parseImport(legacy()); const saved = imported.library.songs[0]!;
    expect(saved.profiles.DAM?.input).toMatchObject({ savedPositionSec: 12.35, compensation: { mode: 'position', waitMs: 0, offsetMs: -50 }, threshold: 0.12, durationMs: 0, playbackMode: 'preplay' });
    expect(saved.profiles.JOYSOUND).toBeUndefined(); expect(imported.warnings.length).toBeGreaterThan(0);
  });
  it('機種未設定を推測せず拒否し、指定された移行先だけへ割り当てる', () => {
    const raw = legacy([{ videoId: videoA, savedSec: null, songInfo: null, detectSettings: null }]);
    expect(() => parseImport(raw)).toThrow('移行先機種');
    const result = parseImport(raw, 'JOYSOUND'); expect(result.library.songs[0]?.profiles.DAM).toBeUndefined();
    expect(result.library.songs[0]?.profiles.JOYSOUND?.input.savedPositionSec).toBe(0);
    expect(result.warnings.some(value => value.includes('未保存'))).toBe(true);
  });
  it('同一オリジンの旧キーを読み取りだけでバックアップへ変換する', () => {
    const s = storage(); s.data.set('song_list', JSON.stringify([videoA])); s.data.set(`sync_${videoA}`, '12.35');
    s.data.set(`song_info_${videoA}`, JSON.stringify({ title: '旧曲', artist: '歌手', service: 'DAM' }));
    s.data.set(`detect_settings_${videoA}`, JSON.stringify({ offset: 0.05, threshold: 0.08 }));
    const before = [...s.data]; expect(parseImport(readLegacyBackup(s)).library.songs).toHaveLength(1);
    expect([...s.data]).toEqual(before); expect(s.setItem).not.toHaveBeenCalled();
  });
  it('旧リストがなければ新規データを勝手に作らない', () => { expect(() => readLegacyBackup(storage())).toThrow('旧曲リストはありません'); });
  it.each(['broken', 'null', '{"songs":[]}', '{"format":"karaokesync-library","version":2,"songs":[]}'])('不正・未知JSON %sを拒否', raw => {
    expect(() => parseImport(raw)).toThrow();
  });
  it.each([
    { videoId: videoA, savedSec: 'NaN', songInfo: { service: 'DAM' } },
    { videoId: videoA, savedSec: '-1', songInfo: { service: 'DAM' } },
    { videoId: videoA, savedSec: '', songInfo: { service: 'DAM' } },
    { videoId: videoA, savedSec: '1', songInfo: { service: 'UNKNOWN' } },
    { videoId: videoA, savedSec: '1', songInfo: { service: 'DAM' }, detectSettings: { threshold: 2 } },
  ])('不正な旧曲%jを一部だけ取り込まず拒否', invalid => { expect(() => parseImport(legacy([invalid]))).toThrow(); });
  it('プレビューだけでは書込まず、重複の上書きは機種ごとに明示選択する', () => {
    const s = storage(); const store = new SongLibrary(s); const original = upsertSong(emptyLibrary(), song()); store.commit(original);
    const updated = song(); updated.title = '復元タイトル'; updated.profiles.DAM!.input.savedPositionSec = 50;
    updated.profiles.JOYSOUND = defaultProfile(videoA, 'JOYSOUND'); updated.profiles.JOYSOUND.input.savedPositionSec = 100;
    const incoming = upsertSong(emptyLibrary(), updated); const choices = importChoices(original, incoming);
    expect(choices[0]).toMatchObject({ metadata: false, profiles: { DAM: false, JOYSOUND: true } });
    const merged = mergeImport(original, incoming, choices);
    expect(merged.songs[0]?.title).toBe(original.songs[0]?.title); expect(merged.songs[0]?.profiles.DAM?.input.savedPositionSec).toBe(0);
    expect(merged.songs[0]?.profiles.JOYSOUND?.input.savedPositionSec).toBe(100); expect(store.snapshot()).toEqual(original);
    choices[0]!.metadata = true; choices[0]!.profiles.DAM = true;
    const applied = store.commit(mergeImport(original, incoming, choices)); expect(applied.songs[0]?.title).toBe('復元タイトル'); expect(applied.songs[0]?.profiles.DAM?.input.savedPositionSec).toBe(50);
  });
  it('新規候補を選択解除でき、同名・別IDは自動重複登録しない', () => {
    const original = upsertSong(emptyLibrary(), song()); const incoming = upsertSong(emptyLibrary(), song(videoB));
    const choices = importChoices(original, incoming); expect(choices[0]?.add).toBe(false); expect(mergeImport(original, incoming, choices)).toEqual(original);
    const unique = upsertSong(emptyLibrary(), song(videoB, '別曲')); const chosen = importChoices(original, unique); chosen[0]!.add = false;
    expect(mergeImport(original, unique, chosen)).toEqual(original);
  });
  it('後半の不正曲や保存失敗で既存データを失わない', () => {
    const s = storage(); const store = new SongLibrary(s); const before = store.commit(upsertSong(emptyLibrary(), song())); const raw = s.data.get(libraryKey);
    expect(() => parseImport(JSON.stringify({ ...emptyLibrary(), songs: [song(videoB, '別曲'), { videoId: 'bad' }] }))).toThrow();
    expect(store.snapshot()).toEqual(before); expect(s.data.get(libraryKey)).toBe(raw);
  });
});

describe('曲選択と再生機構の回帰', () => {
  beforeEach(() => vi.useFakeTimers()); afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
  function setup() {
    const player = new SimulatedPlayer(); const lease = new SimulatedLease(); const acquire = vi.fn(async (): Promise<AudioLease> => lease);
    const play = vi.spyOn(player, 'play'); const release = vi.spyOn(lease, 'release');
    const controller = new SessionController({ createPlayer: () => player, audio: { acquire }, createDetector: () => new SustainedVolumeDetector() }, new DiagnosticLog(() => Date.now()), { ...sessionOptions });
    const input = { ...defaultProfile(videoA, 'DAM').input, durationMs: 0, compensation: { mode: 'wait' as const, waitMs: 1000, offsetMs: 0 } };
    async function arm() { await controller.prepare(input); player.emit({ type: 'playing' }); await flush(); }
    return { player, lease, controller, acquire, play, release, arm };
  }
  it('補正待機中の曲変更で前曲のタイマー・検知・マイク・再生を停止する', async () => {
    const s = setup(); await s.arm(); s.lease.sample({ rms: 0.5, timeMs: 100 });
    expect(s.controller.getSnapshot().phase).toBe('waiting');
    const selected = await selectSong(s.controller, song(videoB, '次の曲'), 'DAM', 'real');
    expect(selected.input.videoId).toBe(videoB); await vi.advanceTimersByTimeAsync(2000); s.lease.sample({ rms: 1, timeMs: 300 });
    expect(s.play).not.toHaveBeenCalled(); expect(s.release).toHaveBeenCalledTimes(1); expect(s.player.disposed).toBe(true);
  });
  it('再生中の曲変更も停止し、JOYSOUND設定を選び直す', async () => {
    const s = setup(); await s.arm(); s.lease.sample({ rms: 0.5, timeMs: 100 }); await vi.advanceTimersByTimeAsync(1000);
    s.player.emit({ type: 'playing' }); await flush(); expect(s.controller.getSnapshot().phase).toBe('playing');
    const next = song(videoB, '次曲'); next.profiles.JOYSOUND = defaultProfile(videoB, 'JOYSOUND'); next.profiles.JOYSOUND.input.savedPositionSec = 123;
    const selected = await selectSong(s.controller, next, 'JOYSOUND', 'real');
    expect(selected.input.savedPositionSec).toBe(123); expect(s.controller.getSnapshot().phase).toBe('idle'); expect(s.release).toHaveBeenCalledTimes(1);
  });
  it('未保存機種では前曲の同期位置を引き継がず、既存専用設定は読み取りで利用する', async () => {
    const s = setup(); const next = song(videoB); const selected = await selectSong(s.controller, next, 'JOYSOUND', 'real');
    expect(selected.input.savedPositionSec).toBe(0); expect(selected.input.service).toBe('JOYSOUND');
    const fallback = defaultProfile(videoB, 'JOYSOUND'); fallback.input.savedPositionSec = 30;
    expect(await selectSong(s.controller, next, 'JOYSOUND', 'real', () => fallback)).toEqual(fallback);
  });
  it('マイク取得未完了なら次曲の設定を適用しない', async () => {
    const s = setup(); let resolve!: (lease: AudioLease) => void; s.acquire.mockReturnValueOnce(new Promise(yes => { resolve = yes; })); await s.arm();
    await expect(selectSong(s.controller, song(videoB), 'DAM', 'real')).rejects.toThrow('未完了');
    expect(s.play).not.toHaveBeenCalled(); resolve(s.lease); await flush(); expect(s.release).toHaveBeenCalledTimes(1);
  });
});

describe('曲リストのReact描画', () => {
  it('曲選択・編集・削除・JSON操作を表示し、曲情報のHTMLをエスケープする', () => {
    const s = storage(); const store = new SongLibrary(s);
    const library = store.commit(upsertSong(emptyLibrary(), song(videoA, '<script>alert(1)</script>', '<img src=x>')));
    const html = renderToStaticMarkup(createElement(SongLibraryPanel, { store, library, loadError: '', selected: videoA,
      active: false, busy: false, currentVideoId: videoA, initialProfiles: () => ({}), onChanged: () => {}, onRestored: () => {}, onSelect: async () => {} }));
    expect(html).toContain('この曲を選択'); expect(html).toContain('編集'); expect(html).toContain('削除'); expect(html).toContain('JSONファイル');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;'); expect(html).not.toContain('<script>'); expect(html).not.toContain('<img src=x>');
    expect(html).toContain('aria-pressed="true"');
  });
});
