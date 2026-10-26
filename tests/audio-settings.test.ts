import { defaultDetectionProfile, existingDetectionProfile, withDetectionProfile, detectionModes } from '../src/app/detectionModes';
import { playbackPlan, environments } from '../src/domain/sync';
import { describe, expect, it, vi } from 'vitest';
import { planAudioSettings } from '../src/library/audioSettings';
import { defaultProfile, emptyLibrary, SongLibrary, type Library } from '../src/library/model';
import { loadSyncProfile, saveSyncProfile } from '../src/app/preferences';
import { importChoices, mergeImport, parseImport } from '../src/library/backup';

const a = 'M7lc1UVf-VE', b = 'dQw4w9WgXcQ';
function fixture(): Library {
  const dam = defaultProfile(a, 'DAM');
  Object.assign(dam.input, { savedPositionSec: 12, offsetSec: -0.4, startAdjustmentMs: 350,
    stabilizationWaitMs: 120, startTrigger: 'vocal', vocalPositionSec: 8, cuePositionSec: 9,
    compensation: { mode: 'combined', waitMs: 100, offsetMs: -250 },
    liveApplied: [{ resultId: 'prior', totalMs: 50 }] });
  dam.retainMic = false;
  const joy = defaultProfile(a, 'JOYSOUND'); joy.input.startTrigger = 'cue'; joy.input.startAdjustmentMs = -800;
  return { ...emptyLibrary(), songs: [
    { videoId: a, title: '曲A', artist: '歌手A', accompanimentRef: `https://youtu.be/${a}`, profiles: { DAM: dam, JOYSOUND: joy } },
    { videoId: b, title: '曲B', artist: '', profiles: { JOYSOUND: defaultProfile(b, 'JOYSOUND') } },
  ] };
}
function storage() {
  const data = new Map<string, string>();
  return { data, getItem: (key: string) => data.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => { data.set(key, value); }) };
}
describe('音検知設定の全曲適用', () => {
  it.each([{ threshold: .071, durationMs: 340 }, { threshold: 0, durationMs: 0 }, { threshold: 1, durationMs: 2000 }])('現在値%jを既存の全機種へ適用し他の全フィールドを維持', values => {
    const original = fixture(), before = structuredClone(original);
    const plan = planAudioSettings(original, values);
    expect(plan).toMatchObject({ songCount: 2, profileCount: 3, values });
    const expected = structuredClone(before);
    for (const song of expected.songs) for (const profile of Object.values(song.profiles)) Object.assign(profile.input, values);
    expect(plan.library).toEqual(expected);
    expect(original).toEqual(before);
    expect(plan.library.songs[1]!.profiles.DAM).toBeUndefined();
    expect(plan.library.songs[0]!.profiles.HOME).toBeUndefined();
  });
  it('プレビュー・キャンセルで永続データとメモリを変更しない', () => {
    const s = storage(), store = new SongLibrary(s, 3); store.commit(fixture());
    const before = [...s.data], snapshot = store.snapshot(); s.setItem.mockClear();
    planAudioSettings(snapshot, { threshold: .1, durationMs: 500 }); // cancel: discard preview, no commit
    expect([...s.data]).toEqual(before); expect(store.snapshot()).toEqual(snapshot); expect(s.setItem).not.toHaveBeenCalled();
  });
  it.each([1, 2, 3] as const)('v%iの再読込とバックアップ・復元を維持', version => {
    const s = storage(), store = new SongLibrary(s, version); store.commit(fixture());
    const history = JSON.stringify({ nextRecommendation: -50, history: [100, -50] });
    s.data.set('karaokesync.app.live-results', history);
    const plan = planAudioSettings(store.snapshot(), { threshold: .056, durationMs: 420 });
    store.commit(plan.library);
    expect(new SongLibrary(s, version).snapshot()).toEqual(plan.library);
    const imported = parseImport(store.export()).library;
    const restored = mergeImport(emptyLibrary(), imported, importChoices(emptyLibrary(), imported));
    expect(restored).toEqual(plan.library);
    expect(s.data.get('karaokesync.app.live-results')).toBe(history);
  });
  it('旧設定のフォールバックは登録済み曲・既存機種だけを曲バックアップ対象へ取り込む', () => {
    const s = storage(); const library = fixture(); delete library.songs[0]!.profiles.JOYSOUND;
    const fallback = defaultProfile(a, 'JOYSOUND'); fallback.input.savedPositionSec = 45;
    saveSyncProfile(s, fallback, 2);
    saveSyncProfile(s, defaultProfile('abcdefghijk', 'DAM'), 2);
    const before = [...s.data];
    const plan = planAudioSettings(library, { threshold: .09, durationMs: 600 }, (id, service) => loadSyncProfile(s, id, service, 3));
    expect(plan.profileCount).toBe(3); expect(plan.library.songs).toHaveLength(2);
    expect(plan.library.songs[0]!.profiles.JOYSOUND!.input).toEqual({ ...fallback.input, threshold: .09, durationMs: 600 });
    expect([...s.data]).toEqual(before);
    const store = new SongLibrary(s, 3); store.commit(plan.library);
    expect(parseImport(store.export()).library).toEqual(plan.library);
  });
  it('既存HOME設定も同じ2項目だけ更新', () => {
    const library = fixture(); library.songs[0]!.profiles.HOME = defaultProfile(a, 'HOME');
    expect(planAudioSettings(library, { threshold: .07, durationMs: 300 }).profileCount).toBe(4);
  });
  it.each([{ threshold: NaN, durationMs: 200 }, { threshold: -1, durationMs: 200 }, { threshold: 1.01, durationMs: 200 },
    { threshold: .035, durationMs: NaN }, { threshold: .035, durationMs: 1.5 }, { threshold: .035, durationMs: 2001 }])('不正入力%jで書込み計画を拒否', values => {
    expect(() => planAudioSettings(fixture(), values)).toThrow();
  });
  it('曲なし・設定なしを案内し新しい機種設定を生成しない', () => {
    expect(() => planAudioSettings(emptyLibrary(), { threshold: .035, durationMs: 200 })).toThrow('保存済みの曲がありません');
    const library = fixture(); for (const song of library.songs) song.profiles = {};
    expect(() => planAudioSettings(library, { threshold: .035, durationMs: 200 })).toThrow('保存済みの音検知設定がありません');
  });
  it('書込み失敗・別タブ競合で一部だけ変更しない', () => {
    const s = storage(), store = new SongLibrary(s, 3); store.commit(fixture());
    const before = [...s.data], snapshot = store.snapshot();
    const plan = planAudioSettings(snapshot, { threshold: .1, durationMs: 300 });
    s.setItem.mockImplementationOnce(() => { throw new Error('QuotaExceededError'); });
    expect(() => store.commit(plan.library)).toThrow('Quota');
    expect([...s.data]).toEqual(before); expect(store.snapshot()).toEqual(snapshot);
    const other = new SongLibrary(s, 3); other.commit(planAudioSettings(snapshot, { threshold: .2, durationMs: 400 }).library);
    expect(() => store.commit(plan.library)).toThrow('別タブ');
    expect(new SongLibrary(s, 3).snapshot().songs[0]!.profiles.DAM!.input.threshold).toBe(.2);
  });
});

describe('未設定を含む全曲・3機種の音検知適用',()=>{
 it.each(detectionModes)('%sだけを全登録曲×3機種へ作成し、対象外モードは作らない',mode=>{
  const library=fixture();for(const song of library.songs)song.profiles={};const before=structuredClone(library);
  const plan=planAudioSettings(library,{threshold:.08,durationMs:300},undefined,mode);
  expect(plan).toMatchObject({songCount:2,profileCount:6,createdCount:6,serviceCounts:{DAM:2,JOYSOUND:2,HOME:2}});
  for(const song of plan.library.songs)for(const service of environments){const container=song.profiles[service]!;expect(Object.keys(container.modeProfiles!)).toEqual([mode]);const saved=existingDetectionProfile(container,mode)!;expect(saved).toEqual({...defaultDetectionProfile(song.videoId,service,mode),input:{...defaultDetectionProfile(song.videoId,service,mode).input,threshold:.08,durationMs:300}});}
  expect(library).toEqual(before);
 });
 it.each([true,false])('既存同期・他モード・未知枠を維持し自動補正%sは通常計算へ反映',enabled=>{
  const library=fixture(),song=library.songs[0]!;
  const vocal=defaultDetectionProfile(a,'DAM','vocal');Object.assign(vocal.input,{vocalPositionSec:30,startAdjustmentMs:-100,autoCompensateDetectionDuration:enabled,durationMs:200,offsetSec:-.05,stabilizationWaitMs:50});
  let container=withDetectionProfile(song.profiles.DAM,vocal);container=withDetectionProfile(container,defaultDetectionProfile(a,'DAM','accompaniment'));container.modeProfiles!.future=structuredClone(vocal);song.profiles.DAM=container;
  const before=structuredClone(container),priorPlan=playbackPlan(vocal.input);
  const plan=planAudioSettings(library,{threshold:.09,durationMs:300},undefined,'vocal');const after=plan.library.songs[0]!.profiles.DAM!;
  expect(after.input).toEqual(before.input);expect(after.modeProfiles!.accompaniment).toEqual(before.modeProfiles!.accompaniment);expect(after.modeProfiles!.future).toEqual(before.modeProfiles!.future);
  const updated=existingDetectionProfile(after,'vocal')!;expect(updated.input).toEqual({...vocal.input,threshold:.09,durationMs:300});expect(playbackPlan(updated.input).seekSec-priorPlan.seekSec).toBeCloseTo(enabled?.1:0);
 });
 it('他方のモードしかない曲に初期プロファイルを追加して同期位置を上書きしない',()=>{
  const library=fixture();const other=defaultDetectionProfile(a,'DAM','accompaniment');other.input.savedPositionSec=77.25;other.input.startAdjustmentMs=-500;other.input.autoCompensateDetectionDuration=false;
  library.songs[0]!.profiles.DAM=withDetectionProfile(undefined,other);const original=structuredClone(library.songs[0]!.profiles.DAM);
  const plan=planAudioSettings(library,{threshold:.07,durationMs:400},undefined,'vocal');const result=plan.library.songs[0]!.profiles.DAM!;
  expect(result.input).toEqual(original.input);expect(existingDetectionProfile(result,'accompaniment')).toEqual(other);expect(existingDetectionProfile(result,'vocal')!.input).toMatchObject({threshold:.07,durationMs:400,savedPositionSec:0});
 });
 it('新規枠込みでも取消・保存失敗は無変更、再読込とバックアップ復元は一致',()=>{
  const s=storage(),store=new SongLibrary(s,4),library=fixture();for(const song of library.songs)song.profiles={};store.commit(library);const before=[...s.data];s.setItem.mockClear();
  const plan=planAudioSettings(store.snapshot(),{threshold:.09,durationMs:300},undefined,'vocal');expect([...s.data]).toEqual(before);expect(s.setItem).not.toHaveBeenCalled();
  s.setItem.mockImplementationOnce(()=>{throw Error('quota');});expect(()=>store.commit(plan.library)).toThrow('quota');expect([...s.data]).toEqual(before);expect(store.snapshot()).toEqual(library);
  store.commit(plan.library);expect(new SongLibrary(s,4).snapshot()).toEqual(plan.library);const backup=parseImport(store.export()).library;expect(mergeImport(emptyLibrary(),backup,importChoices(emptyLibrary(),backup))).toEqual(plan.library);
 });
 it('確認時に存在しなかった外部プロファイルも競合検査の対象に記録する',()=>{
  const library=fixture();for(const song of library.songs)song.profiles={};const plan=planAudioSettings(library,{threshold:.1,durationMs:300},()=>undefined,'vocal');expect(plan.fallbackSources).toHaveLength(6);expect(plan.fallbackSources.every(item=>item.source===undefined)).toBe(true);
 });
 it('旧フォールバックの同期位置を保ち、未保存機種だけを補完する',()=>{
  const library=fixture();for(const song of library.songs)song.profiles={};const fallback=defaultProfile(a,'HOME');fallback.input.startTrigger='vocal';fallback.input.savedPositionSec=45;fallback.input.offsetSec=-.5;fallback.input.autoCompensateDetectionDuration=false;
  const plan=planAudioSettings(library,{threshold:.11,durationMs:500},(id,service)=>id===a&&service==='HOME'?fallback:undefined,'vocal');expect(plan).toMatchObject({profileCount:6,createdCount:5});const updated=existingDetectionProfile(plan.library.songs[0]!.profiles.HOME,'vocal')!;expect(updated.input.savedPositionSec).toBe(45);expect(updated.input.offsetSec).toBe(-.5);expect(updated.input.autoCompensateDetectionDuration).toBe(false);
 });
});
