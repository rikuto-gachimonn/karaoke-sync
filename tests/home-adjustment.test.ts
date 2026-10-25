import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adjustEffectiveStart, playbackPlan, positionComponentsMs, startPosition, type SyncInput, validateInput } from '../src/domain/sync';
import { correctedPosition, effectiveCompensation } from '../src/youtube-probe/compensation';
import { SongLibrary, libraryKey, libraryV2Key, defaultProfile, emptyLibrary, setSongProfile, upsertSong, deleteSong, validSong, type Song } from '../src/library/model';
import { parseImport, mergeImport, importChoices } from '../src/library/backup';
import { saveSyncProfile, loadSyncProfile, preferencesKey, preferencesV2Key } from '../src/app/preferences';
import { selectSong } from '../src/library/selection';
import { SessionController } from '../src/session/controller';
import { SimulatedPlayer, SimulatedLease } from '../src/adapters/simulation';
import { SustainedVolumeDetector } from '../src/domain/detector';
import { sessionOptions } from '../src/config/settings';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { App } from '../src/ui/App';
import { createApp } from '../src/app/createApp';

const videoId = 'M7lc1UVf-VE';
const initial = (): SyncInput => ({ ...defaultProfile(videoId, 'DAM').input, savedPositionSec: 10, durationMs: 0 });
const song = (): Song => ({ videoId, title: '自宅テスト曲', artist: '歌手', profiles: { DAM: defaultProfile(videoId, 'DAM'), JOYSOUND: defaultProfile(videoId, 'JOYSOUND') } });
function storage() {
  const data = new Map<string, string>();
  return { data, getItem: vi.fn((key: string) => data.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { data.set(key, value); }) };
}
async function flush() { for (let i = 0; i < 80; i++) await Promise.resolve(); }

describe('実効開始位置の整数ms調整', () => {
  it.each([1000, 100, 10])('±%smsは基準モードで有効で、元のオフセットとBを変更しない', step => {
    const input = initial(); const changed = adjustEffectiveStart(input, step);
    expect(positionComponentsMs(changed).effectiveMs).toBe(10000 + step);
    expect(changed.compensation).toEqual(input.compensation); expect(changed.offsetSec).toBe(input.offsetSec); expect(changed.savedPositionSec).toBe(10);
    expect(adjustEffectiveStart(changed, -step).startAdjustmentMs).toBe(0);
  });
  it('10000回の10ms加算と減算でも累積誤差がない', () => {
    let input = initial(); for (let i = 0; i < 10000; i++) input = adjustEffectiveStart(input, 10);
    expect(input.startAdjustmentMs).toBe(100000); expect(positionComponentsMs(input).effectiveMs).toBe(110000);
    for (let i = 0; i < 10000; i++) input = adjustEffectiveStart(input, -10);
    expect(input.startAdjustmentMs).toBe(0); expect(positionComponentsMs(input).effectiveMs).toBe(10000);
  });
  it('既存オフセットと有効Bの後に主調整を一度だけ加算する', () => {
    const input = { ...initial(), offsetSec: -0.05, compensation: { mode: 'combined' as const, waitMs: 100, offsetMs: 200 } };
    const changed = adjustEffectiveStart(input, 10);
    expect(positionComponentsMs(changed)).toEqual({ baseMs: 9950, bMs: 200, adjustmentMs: 10, detectionMs: 0, effectiveMs: 10160 });
    expect(correctedPosition(startPosition(changed), 200 + changed.startAdjustmentMs!, 120).seekSec).toBeCloseTo(10.16, 10);
  });
  it.each(['baseline', 'wait', 'position', 'combined'] as const)('旧%s設定の主調整未定義は0として従来計算と一致', mode => {
    const input = { ...initial(), savedPositionSec: 0.3, offsetSec: -0.05, compensation: { mode, waitMs: 100, offsetMs: -50 } };
    const oldResult = correctedPosition(startPosition(input), effectiveCompensation(input.compensation).offsetMs, 120).seekSec;
    expect(positionComponentsMs(input).effectiveMs / 1000).toBeCloseTo(oldResult, 10);
  });
  it('負のBにも10ms調整を加算し、負値を待機用に保持する', () => {
    let input = { ...initial(), savedPositionSec: 0, compensation: { mode: 'position' as const, waitMs: 0, offsetMs: -500 } };
    input = adjustEffectiveStart(input, 10) as typeof input;
    expect(playbackPlan(input).rawMs).toBe(-490);
    const zero = adjustEffectiveStart(input, -1000); expect(positionComponentsMs(zero).effectiveMs).toBe(0);
    expect(playbackPlan(adjustEffectiveStart(zero, -10)).rawMs).toBe(-1500);
  });
  it('正のBを超えて戻した分は待機時間になる', () => {
    const input = { ...initial(), savedPositionSec: 0, compensation: { mode: 'position' as const, waitMs: 0, offsetMs: 500 } };
    const changed = adjustEffectiveStart(input, -1000); expect(changed.startAdjustmentMs).toBe(-1000); expect(playbackPlan(changed).waitMs).toBe(500); expect(positionComponentsMs(changed).effectiveMs).toBe(0);
  });
  it('0ms操作は設定を変更せず、調整上限を超えない', () => {
    expect(adjustEffectiveStart(initial(), 0)).toEqual(initial());
    const changed = adjustEffectiveStart({ ...initial(), startAdjustmentMs: 86400000 }, 1000);
    expect(changed.startAdjustmentMs).toBe(86400000);
  });
  it.each([NaN, Infinity, 0.1, 86400001])('不正な主調整%sを拒否する', startAdjustmentMs => {
    expect(() => validateInput({ ...initial(), startAdjustmentMs })).toThrow('整数');
  });
});

describe('v2曲保存と自宅テストの独立性', () => {
  it('v1を読取りだけで引き継ぎ、明示保存はv2へ行い元のD/Jを保持する', () => {
    const s = storage(); const old = upsertSong(emptyLibrary(), song()); s.data.set(libraryKey, JSON.stringify(old));
    const raw = s.data.get(libraryKey); const store = new SongLibrary(s, 2); expect(s.setItem).not.toHaveBeenCalled(); expect(store.snapshot()).toEqual(old);
    const home = defaultProfile(videoId, 'HOME'); home.input.startAdjustmentMs = -100; home.input.compensation = { mode: 'combined', waitMs: 50, offsetMs: 200 };
    store.commit(setSongProfile(store.snapshot(), videoId, home));
    const restored = new SongLibrary(s, 2).snapshot().songs[0]!;
    expect(restored.profiles.DAM).toEqual(old.songs[0]!.profiles.DAM); expect(restored.profiles.JOYSOUND).toEqual(old.songs[0]!.profiles.JOYSOUND);
    expect(restored.profiles.HOME).toEqual(home); expect(s.data.get(libraryKey)).toBe(raw);
    expect(s.setItem.mock.calls.every(([key]) => key === libraryV2Key)).toBe(true);
  });
  it('v2バックアップはHOME・主調整・伴奏記録を含めて復元する', () => {
    const s = storage(); const store = new SongLibrary(s, 2); const item = song(); item.accompanimentRef = 'https://youtu.be/M7lc1UVf-VE?t=5';
    item.profiles.HOME = defaultProfile(videoId, 'HOME'); item.profiles.HOME.input.startAdjustmentMs = 10;
    store.commit(upsertSong(store.snapshot(), item)); const raw = JSON.parse(store.export()); expect(raw.version).toBe(2);
    expect(raw.format).toBe('karaokesync-library-v2'); expect(parseImport(store.export()).library).toEqual(store.snapshot());
  });
  it('HOMEだけの復元選択はDAM/JOYSOUNDを上書きしない', () => {
    const current = upsertSong(emptyLibrary(), song()); const incoming = upsertSong(emptyLibrary(), { ...song(), profiles: { HOME: defaultProfile(videoId, 'HOME') } });
    const choices = importChoices(current, incoming); expect(choices[0]?.profiles.HOME).toBe(true);
    const merged = mergeImport(current, incoming, choices);
    expect(merged.songs[0]?.profiles.DAM).toEqual(current.songs[0]?.profiles.DAM); expect(merged.songs[0]?.profiles.JOYSOUND).toEqual(current.songs[0]?.profiles.JOYSOUND);
    expect(merged.songs[0]?.profiles.HOME?.input.service).toBe('HOME');
  });
  it('現行React v1バックアップと旧HTML 0.6を引き続き取り込む', () => {
    const v1 = upsertSong(emptyLibrary(), song()); expect(parseImport(JSON.stringify(v1)).library).toEqual(v1);
    const old = { appName: 'Karaoke Sync', backupVersion: '0.6', songs: [{ videoId, savedSec: '12.35', songInfo: { title: '旧曲', artist: '歌手', service: 'DAM' }, detectSettings: { offset: -0.05, threshold: 0.08 } }] };
    const imported = parseImport(JSON.stringify(old)).library.songs[0]!;
    expect(imported.profiles.HOME).toBeUndefined(); expect(imported.profiles.JOYSOUND).toBeUndefined(); expect(positionComponentsMs(imported.profiles.DAM!.input).effectiveMs).toBe(12300);
  });
  it('v2で全曲削除しても旧v1曲を自動再取込しない', () => {
    const s = storage(); s.data.set(libraryKey, JSON.stringify(upsertSong(emptyLibrary(), song())));
    const store = new SongLibrary(s, 2); store.commit(deleteSong(store.snapshot(), videoId));
    expect(new SongLibrary(s, 2).snapshot().songs).toHaveLength(0); expect(s.data.has(libraryKey)).toBe(true);
  });
  it('破損v2ではv1へ黙って戻らず、保存失敗でもv1/v2を保持する', () => {
    const s = storage(); const old = JSON.stringify(upsertSong(emptyLibrary(), song())); s.data.set(libraryKey, old); s.data.set(libraryV2Key, 'broken');
    expect(() => new SongLibrary(s, 2)).toThrow(); expect(s.setItem).not.toHaveBeenCalled();
    s.data.delete(libraryV2Key); const store = new SongLibrary(s, 2); s.setItem.mockImplementationOnce(() => { throw new Error('quota'); });
    expect(() => store.commit(store.snapshot())).toThrow('quota'); expect(s.data.get(libraryKey)).toBe(old); expect(s.data.has(libraryV2Key)).toBe(false);
  });
  it('v2同期設定保存もv1を消さず3環境を保持する', () => {
    const s = storage(); saveSyncProfile(s, defaultProfile(videoId, 'DAM')); saveSyncProfile(s, defaultProfile(videoId, 'JOYSOUND'));
    const raw = s.data.get(preferencesKey); const home = defaultProfile(videoId, 'HOME'); home.input.startAdjustmentMs = 1000;
    saveSyncProfile(s, home, 2); expect(s.data.get(preferencesKey)).toBe(raw); expect(s.data.has(preferencesV2Key)).toBe(true);
    expect(loadSyncProfile(s, videoId, 'HOME', 2)).toEqual(home); expect(loadSyncProfile(s, videoId, 'DAM', 2)?.input.service).toBe('DAM'); expect(loadSyncProfile(s, videoId, 'JOYSOUND', 2)?.input.service).toBe('JOYSOUND');
  });
  it('伴奏記録の空欄・ID・URLは許可し、自動操作用データは作らない', () => {
    for (const accompanimentRef of ['', videoId, `https://www.youtube.com/watch?v=${videoId}`, `https://youtu.be/${videoId}`]) expect(validSong({ ...song(), accompanimentRef }).accompanimentRef).toBe(accompanimentRef);
  });
  it.each(['javascript:alert(1)', 'https://evil.example/watch?v=M7lc1UVf-VE', 'not a video', 'https://youtube.com/watch?v=short'])('不正伴奏記録%sを拒否する', accompanimentRef => {
    expect(() => validSong({ ...song(), accompanimentRef })).toThrow('伴奏');
  });
});

describe('自宅テストと調整位置の実行契約', () => {
  beforeEach(() => vi.useFakeTimers()); afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
  it.each([[1000, 11], [-1000, 9], [-20000, 0], [300000, 240]])('主調整%imsは動画範囲内の%s秒へ一度だけシークする', async (startAdjustmentMs, target) => {
    const player = new SimulatedPlayer(); const lease = new SimulatedLease(); const seek = vi.spyOn(player, 'seek'); const play = vi.spyOn(player, 'play');
    const controller = new SessionController({ createPlayer: () => player, audio: { acquire: async () => lease }, createDetector: () => new SustainedVolumeDetector() }, undefined, { ...sessionOptions });
    await controller.prepare({ ...initial(), service: 'HOME', startAdjustmentMs }); player.emit({ type: 'playing' }); await flush();
    expect(controller.getSnapshot().phase).toBe('armed'); lease.sample({ rms: 0.5, timeMs: 10 }); lease.sample({ rms: 0.5, timeMs: 20 }); await flush();
    if(startAdjustmentMs < -10000){expect(seek).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(-10000-startAdjustmentMs);} expect(seek).toHaveBeenCalledExactlyOnceWith(target); expect(play).toHaveBeenCalledTimes(1); expect(controller.getSnapshot().phase).toBe('starting'); await controller.stop();
  });
  it('曲選択で自宅設定を選んでもDAMに流用せず、未保存HOMEは初期値になる', async () => {
    const controller = { getSnapshot: () => ({ canPrepare: true }), stop: vi.fn(async () => {}) };
    const item = song(); const home = await selectSong(controller as never, item, 'HOME', 'real'); expect(home.input.savedPositionSec).toBe(0);
    item.profiles.HOME = defaultProfile(videoId, 'HOME'); item.profiles.HOME.input.startAdjustmentMs = 500;
    expect((await selectSong(controller as never, item, 'HOME', 'real')).input.startAdjustmentMs).toBe(500);
    expect((await selectSong(controller as never, item, 'DAM', 'real')).input.startAdjustmentMs).toBeUndefined();
  });
});

describe('3段階調整の画面', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('6操作とHOMEを表示し、停止中の調整だけを案内する', () => {
    vi.stubGlobal('localStorage', storage());
    const html = renderToStaticMarkup(createElement(App, createApp('simulation')));
    for (const step of [1000, 100, 10]) { expect(html).toContain(`開始位置を${step}ms戻す`); expect(html).toContain(`開始位置を${step}ms進める`); }
    expect(html).toContain('自宅テスト（PC＋スピーカー）'); expect(html).toContain('基準モードでも有効'); expect(html).toContain('10ms刻みは同期精度の保証ではありません');
    expect(html).toContain('次の検知準備・初回検知時に適用'); expect(localStorage.setItem).not.toHaveBeenCalled();
  });
});
