import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { detectionModes, defaultDetectionProfile, existingDetectionProfile, selectDetectionProfile, withDetectionProfile, mergeDetectionProfiles } from '../src/app/detectionModes';
import { saveSyncProfile, loadSyncProfile, preferencesV3Key } from '../src/app/preferences';
import { defaultProfile, emptyLibrary, upsertSong, setSongProfile, SongLibrary, libraryV3Key, libraryV4Key, changeSongIdentity, validProfile, type Song } from '../src/library/model';
import { parseImport, mergeImport, importChoices } from '../src/library/backup';
import { planAudioSettings } from '../src/library/audioSettings';
import { triggerPosition, playbackPlan, type StartTrigger } from '../src/domain/sync';
import { SustainedVolumeDetector } from '../src/domain/detector';
import { SessionController } from '../src/session/controller';
import { SimulatedPlayer, SimulatedLease } from '../src/adapters/simulation';
import { StartTriggerSettings } from '../src/ui/StartTriggerSettings';
const a = 'M7lc1UVf-VE', b = 'dQw4w9WgXcQ';
function storage() { const data = new Map<string, string>(); return { data, getItem: (k: string) => data.get(k) ?? null, setItem: vi.fn((k: string, v: string) => { data.set(k, v); }) }; }
function legacy(trigger?: StartTrigger) {
  const profile = defaultProfile(a, 'DAM'); Object.assign(profile.input, { startTrigger: trigger, savedPositionSec: 10, vocalPositionSec: 20, cuePositionSec: 30,
    threshold: .08, durationMs: 70, offsetSec: -.2, startAdjustmentMs: -1000, stabilizationWaitMs: 50,
    compensation: { mode: 'combined', waitMs: 200, offsetMs: -300 }, liveApplied: [{ resultId: 'kept', totalMs: -100 }] });
  profile.retainMic = false; return profile;
}
describe('独立した2種類の検知モードと互換保存', () => {
  it('新規モードは0.035/200msで、UIは歌声・伴奏だけを表示', () => {
    expect(detectionModes).toEqual(['vocal', 'accompaniment']);
    const input = defaultDetectionProfile(a, 'DAM', 'vocal').input;
    expect(input).toMatchObject({ startTrigger: 'vocal', threshold: .035, durationMs: 200 });
    const html = renderToStaticMarkup(createElement(StartTriggerSettings, { input, disabled: false, onChange: vi.fn() }));
    expect([...html.matchAll(/<option[^>]*value="([^"]+)"/g)].map(m => m[1])).toEqual(['vocal', 'accompaniment']);
    expect(html).toContain('value="vocal" selected'); expect(html).toContain('歌声検知'); expect(html).toContain('伴奏検知'); expect(html).toContain('識別しません');
  });
  it.each([[undefined, 'accompaniment', 10], ['accompaniment', 'accompaniment', 10], ['vocal', 'vocal', 20], ['cue', 'vocal', 30], ['manual', 'vocal', 10]] as const)('旧%sを%sへ位置・補正・全設定を保って読み、書き込まない', (trigger, mode, position) => {
    const original = legacy(trigger), before = structuredClone(original);
    const read = existingDetectionProfile(original, mode)!;
    expect(triggerPosition(read.input)).toBe(position);
    expect(playbackPlan(read.input)).toEqual(playbackPlan(original.input));
    expect(read.input).toMatchObject({ threshold: .08, durationMs: 70, offsetSec: -.2, startAdjustmentMs: -1000, stabilizationWaitMs: 50, liveApplied: before.input.liveApplied });
    expect(original).toEqual(before);
  });
  it('他方モードを未保存なら初期値を返し、不用意に混同・生成しない', () => {
    const old = legacy('accompaniment'); delete old.input.vocalPositionSec; expect(existingDetectionProfile(old, 'vocal')).toBeUndefined();
    expect(selectDetectionProfile(old, a, 'DAM', 'vocal', 'real')).toEqual(defaultDetectionProfile(a, 'DAM', 'vocal'));
    expect(old).not.toHaveProperty('modeProfiles');
  });
  it.each(['DAM', 'JOYSOUND', 'HOME'] as const)('%sの2モードを独立保存し再読込・v4バックアップ復元で正負補正も維持', service => {
    const st = storage(), store = new SongLibrary(st, 4), old = legacy('cue'); old.input.service = service;
    let container = withDetectionProfile(old, { ...defaultDetectionProfile(a, service, 'vocal'), input: { ...defaultDetectionProfile(a, service, 'vocal').input, threshold: .035, vocalPositionSec: 45, startAdjustmentMs: -250 } });
    container = withDetectionProfile(container, { ...defaultDetectionProfile(a, service, 'accompaniment'), input: { ...defaultDetectionProfile(a, service, 'accompaniment').input, threshold: .08, savedPositionSec: 5, startAdjustmentMs: 800 } });
    store.commit(upsertSong(emptyLibrary(), { videoId: a, title: '曲', artist: '', profiles: { [service]: container } }));
    expect(existingDetectionProfile(new SongLibrary(st, 4).snapshot().songs[0]!.profiles[service], 'vocal')!.input).toMatchObject({ threshold: .035, startAdjustmentMs: -250, vocalPositionSec: 45 });
    expect(existingDetectionProfile(container, 'accompaniment')!.input).toMatchObject({ threshold: .08, startAdjustmentMs: 800, savedPositionSec: 5 });
    expect(container.input).toEqual(old.input); expect(container.retainMic).toBe(false);
    const backup = parseImport(store.export()).library; expect(backup).toEqual(store.snapshot());
    expect(mergeImport(emptyLibrary(), backup, importChoices(emptyLibrary(), backup))).toEqual(backup);
    expect(JSON.parse(store.export()).version).toBe(4); expect(st.data.has(libraryV4Key)).toBe(true); expect(st.data.has(libraryV3Key)).toBe(false);
  });
  it.each([1, 2, 3] as const)('旧v%sキーとその全データを読取移行後も変更しない', version => {
    const st = storage(), old = new SongLibrary(st, version); old.commit(upsertSong(emptyLibrary(), { videoId: a, title: '旧曲', artist: '', profiles: { DAM: legacy('vocal') } }));
    const before = [...st.data], store = new SongLibrary(st, 4), song = store.snapshot().songs[0]!;
    expect([...st.data]).toEqual(before);
    const edited = existingDetectionProfile(song.profiles.DAM, 'vocal')!; edited.input.threshold = .15;
    store.commit(setSongProfile(store.snapshot(), a, withDetectionProfile(song.profiles.DAM, edited)));
    for (const [key, raw] of before) expect(st.data.get(key)).toBe(raw);
    expect(existingDetectionProfile(new SongLibrary(st, 4).snapshot().songs[0]!.profiles.DAM, 'vocal')!.input.threshold).toBe(.15);
  });
  it('旧共通設定の個別位置が両方保存されていれば両モードを復元し、以降は独立', () => {
    const original = legacy('accompaniment');
    expect(existingDetectionProfile(original, 'vocal')!.input).toMatchObject({ vocalPositionSec: 20, threshold: .08, offsetSec: -.2 });
    expect(existingDetectionProfile(legacy('vocal'), 'accompaniment')!.input.savedPositionSec).toBe(10);
    const next = withDetectionProfile(original, { ...defaultDetectionProfile(a, 'DAM', 'vocal'), input: { ...defaultDetectionProfile(a, 'DAM', 'vocal').input, threshold: .035 } });
    expect(existingDetectionProfile(next, 'vocal')!.input.threshold).toBe(.035);
    expect(existingDetectionProfile(next, 'accompaniment')!.input.threshold).toBe(.08);
    const brandNew = withDetectionProfile(undefined, defaultDetectionProfile(a, 'DAM', 'vocal'));
    expect(existingDetectionProfile(brandNew, 'accompaniment')).toBeUndefined();
  });
  it('手入力preferencesもv4で両モードを独立保存し旧v3は保持', () => {
    const st = storage(); saveSyncProfile(st, legacy('accompaniment'), 3); const before = st.data.get(preferencesV3Key);
    let next = withDetectionProfile(loadSyncProfile(st, a, 'DAM', 4), defaultDetectionProfile(a, 'DAM', 'vocal'));
    saveSyncProfile(st, next, 4); const accompaniment = existingDetectionProfile(next, 'accompaniment')!; accompaniment.input.durationMs = 500;
    next = withDetectionProfile(loadSyncProfile(st, a, 'DAM', 4), accompaniment); saveSyncProfile(st, next, 4);
    expect(existingDetectionProfile(loadSyncProfile(st, a, 'DAM', 4), 'vocal')!.input.durationMs).toBe(200);
    expect(existingDetectionProfile(loadSyncProfile(st, a, 'DAM', 4), 'accompaniment')!.input.durationMs).toBe(500); expect(st.data.get(preferencesV3Key)).toBe(before);
  });
  it('選択中モードだけの全曲適用は他方・旧レコード・未知の保存枠を保持し未登録機種を作成', () => {
    const source = legacy('cue'); source.modeProfiles = { future: { input: { ...source.input }, retainMic: false } };
    let profile = withDetectionProfile(source, defaultDetectionProfile(a, 'DAM', 'vocal'));
    profile = withDetectionProfile(profile, defaultDetectionProfile(a, 'DAM', 'accompaniment'));
    const songs: Song[] = [{ videoId: a, title: 'A', artist: '', profiles: { DAM: profile } }, { videoId: b, title: 'B', artist: '', profiles: { JOYSOUND: withDetectionProfile(undefined, defaultDetectionProfile(b, 'JOYSOUND', 'vocal')) } }];
    const library = { ...emptyLibrary(), songs }, before = structuredClone(library);
    expect(() => planAudioSettings(library, { threshold: .12, durationMs: 600 })).toThrow('対象モード');
    const plan = planAudioSettings(library, { threshold: .12, durationMs: 600 }, undefined, 'vocal');
    expect(plan).toMatchObject({ songCount: 2, profileCount: 6, createdCount: 4 });
    const updated = plan.library.songs[0]!.profiles.DAM!;
    expect(existingDetectionProfile(updated, 'vocal')!.input).toMatchObject({ threshold: .12, durationMs: 600 });
    expect(updated.input).toEqual(before.songs[0]!.profiles.DAM!.input);
    expect(updated.modeProfiles!.accompaniment).toEqual(profile.modeProfiles!.accompaniment); expect(updated.modeProfiles!.future).toEqual(profile.modeProfiles!.future);
    expect(existingDetectionProfile(plan.library.songs[0]!.profiles.JOYSOUND, 'vocal')!.input.threshold).toBe(.12); expect(library).toEqual(before);
    expect(planAudioSettings({ ...emptyLibrary(), songs: [songs[1]!] }, { threshold: .1, durationMs: 200 }, undefined, 'accompaniment')).toMatchObject({profileCount:3,createdCount:3});
  });
  it('旧バックアップの復元は該当モードだけを更新し他方を消さない', () => {
    const st = storage(), old = new SongLibrary(st, 3); old.commit(upsertSong(emptyLibrary(), { videoId: a, title: '曲', artist: '', profiles: { DAM: legacy('accompaniment') } }));
    const incoming = parseImport(old.export()).library;
    const container = withDetectionProfile(withDetectionProfile(legacy('accompaniment'), defaultDetectionProfile(a, 'DAM', 'vocal')), defaultDetectionProfile(a, 'DAM', 'accompaniment'));
    const current = upsertSong(emptyLibrary(), { ...incoming.songs[0]!, profiles: { DAM: container } });
    const choices = importChoices(current, incoming); choices[0]!.profiles.DAM = true;
    const restored = mergeImport(current, incoming, choices).songs[0]!.profiles.DAM!;
    expect(existingDetectionProfile(restored, 'accompaniment')!.input.threshold).toBe(.08);
    expect(existingDetectionProfile(restored, 'vocal')).toEqual(existingDetectionProfile(container, 'vocal'));
  });
  it('旧モードから移行した位置も、他モードのバックアップ復元で消さない', () => {
    const source = legacy('manual'); const current = withDetectionProfile(source, defaultDetectionProfile(a, 'DAM', 'accompaniment'));
    const incoming = legacy('accompaniment'); incoming.input.threshold = .2;
    const merged = mergeDetectionProfiles(current, incoming);
    expect(existingDetectionProfile(merged, 'vocal')!.input).toMatchObject({ threshold: .08, startAdjustmentMs: -1000, vocalPositionSec: 10 });
    expect(existingDetectionProfile(merged, 'accompaniment')!.input.threshold).toBe(.2);
    const twoOldFormats = mergeDetectionProfiles(legacy('vocal'), incoming);
    expect(existingDetectionProfile(twoOldFormats, 'vocal')!.input.vocalPositionSec).toBe(20);
    expect(existingDetectionProfile(twoOldFormats, 'accompaniment')!.input.threshold).toBe(.2);
  });
  it('ID変更時は全モードの帰属を更新し不正なモード値は上書きせず拒否', () => {
    const profile = withDetectionProfile(legacy('manual'), defaultDetectionProfile(a, 'DAM', 'vocal'));
    const song = changeSongIdentity({ videoId: a, title: '曲', artist: '', profiles: { DAM: profile } }, b, '改名', '');
    expect(song.profiles.DAM!.input.videoId).toBe(b); expect(song.profiles.DAM!.modeProfiles!.vocal!.input.videoId).toBe(b);
    const invalid = structuredClone(profile); invalid.modeProfiles!.vocal!.input.startTrigger = 'accompaniment'; expect(() => validProfile(invalid, a, 'DAM')).toThrow('一致');
  });
  it('未知の旧トリガーを含むデータは削除/初期化せずエラーで保護', () => {
    const st = storage(); st.data.set(libraryV3Key, JSON.stringify({ format: 'karaokesync-library-v3', version: 3, songs: [{ videoId: a, title: '旧曲', artist: '', profiles: { DAM: { ...legacy(), input: { ...legacy().input, startTrigger: 'future' } } } }] }));
    const before = [...st.data]; expect(() => new SongLibrary(st, 4)).toThrow('開始トリガー'); expect([...st.data]).toEqual(before); expect(st.setItem).not.toHaveBeenCalled();
  });
  it('v4初回保存の失敗・旧領域の別タブ更新で一部だけ移行しない', () => {
    const st = storage(); const old = new SongLibrary(st, 3); old.commit(upsertSong(emptyLibrary(), { videoId: a, title: '旧曲', artist: '', profiles: { DAM: legacy('vocal') } }));
    const store = new SongLibrary(st, 4), before = store.snapshot(), raw = st.data.get(libraryV3Key);
    const next = setSongProfile(before, a, withDetectionProfile(before.songs[0]!.profiles.DAM, defaultDetectionProfile(a, 'DAM', 'vocal')));
    st.setItem.mockImplementationOnce(() => { throw new Error('QuotaExceededError'); });
    expect(() => store.commit(next)).toThrow('Quota'); expect(store.snapshot()).toEqual(before); expect(st.data.has(libraryV4Key)).toBe(false); expect(st.data.get(libraryV3Key)).toBe(raw);
    old.commit(emptyLibrary()); expect(() => store.commit(next)).toThrow('別タブ'); expect(st.data.has(libraryV4Key)).toBe(false);
  });
  it('v4の空リストや破損状態から旧データを勝手に復活させない', () => {
    const st = storage(); new SongLibrary(st, 3).commit(upsertSong(emptyLibrary(), { videoId: a, title: '旧曲', artist: '', profiles: { DAM: legacy() } }));
    new SongLibrary(st, 4).commit(emptyLibrary()); expect(new SongLibrary(st, 4).snapshot().songs).toHaveLength(0);
    st.data.set(libraryV4Key, 'broken'); const before = [...st.data]; expect(() => new SongLibrary(st, 4)).toThrow(); expect([...st.data]).toEqual(before);
  });
  it('不正なモードを含むv4バックアップの復元プレビューを拒否し元データを保護', () => {
    const st = storage(), store = new SongLibrary(st, 4); const profile = withDetectionProfile(legacy('accompaniment'), defaultDetectionProfile(a, 'DAM', 'vocal'));
    store.commit(upsertSong(emptyLibrary(), { videoId: a, title: '曲', artist: '', profiles: { DAM: profile } }));
    const before = [...st.data], backup = JSON.parse(store.export()); backup.songs[0].profiles.DAM.modeProfiles.vocal.input.threshold = 2;
    expect(() => parseImport(JSON.stringify(backup))).toThrow('しきい値'); expect([...st.data]).toEqual(before);
  });
  it.each(detectionModes)('%sも共通検知器で等号境界・継続200ms・一度だけの再生を守る', async mode => {
    const player = new SimulatedPlayer(), lease = new SimulatedLease(), detector = new SustainedVolumeDetector();
    const controller = new SessionController({ createPlayer: () => player, audio: { acquire: async () => lease }, createDetector: () => detector });
    const play = vi.spyOn(player, 'play'); await controller.prepare(defaultDetectionProfile(a, 'DAM', mode, 'simulation').input);
    lease.sample({ rms: .035, timeMs: 0 }); lease.sample({ rms: .034, timeMs: 50 });
    lease.sample({ rms: .035, timeMs: 100 }); lease.sample({ rms: .035, timeMs: 200 });
    expect(play).not.toHaveBeenCalled(); lease.sample({ rms: .035, timeMs: 300 });
    for (let i = 0; i < 80; i++) await Promise.resolve();
    expect(play).toHaveBeenCalledTimes(1); lease.sample({ rms: .5, timeMs: 400 });
    for (let i = 0; i < 80; i++) await Promise.resolve(); expect(play).toHaveBeenCalledTimes(1); await controller.stop();
  });
});
