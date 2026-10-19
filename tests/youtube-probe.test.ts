import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { YouTubeProbe, type Condition } from '../src/youtube-probe/probe';
import type { YouTubeApi, YouTubeHandle, YouTubeOptions } from '../src/adapters/youtube/api';
import type { AudioInput, AudioLease, VolumeSample } from '../src/session/ports';
import { AudioAcquireError } from '../src/session/ports';
import { micProbeDefaults, type MicProbeOptions } from '../src/youtube-probe/microphone';
import { compensationDefaults, type Compensation } from '../src/youtube-probe/compensation';

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
function setup(audio?: AudioInput) {
  type SeekHandle = YouTubeHandle & { seekTo: ReturnType<typeof vi.fn>; getCurrentTime(): number; getDuration(): number };
  const instances: { options: YouTubeOptions; handle: SeekHandle; state: number; video: string; position: number; duration: number }[] = [];
  const host = { ownerDocument: { createElement: () => ({}) }, appendChild: vi.fn(), replaceChildren: vi.fn() } as unknown as HTMLElement;
  const api: YouTubeApi = { Player: class {
    constructor(_target: HTMLElement, options: YouTubeOptions) {
      const instance = { options, state: -1, video: '', position: 0, duration: 120, handle: {} as SeekHandle };
      instance.handle = {
        cueVideoById: vi.fn(value => { instance.video = value.videoId; }),
        playVideo: vi.fn(), pauseVideo: vi.fn(), destroy: vi.fn(),
        getPlayerState: () => instance.state, getVideoData: () => ({ video_id: instance.video }),
        getCurrentTime: () => instance.position, seekTo: vi.fn(),
        getDuration: () => instance.duration,
      };
      instances.push(instance); return instance.handle;
    }
  } as unknown as YouTubeApi['Player'] };
  const probe = new YouTubeProbe(host, 'https://192.168.3.3:5173', async () => api, () => Date.now(),
    () => ({ isActive: false, hasBeenActive: true }), audio);
  async function prepare(condition: Condition = 'iframe', delay = 1000, options = micProbeDefaults, compensation = compensationDefaults) {
    await probe.start(condition, 'M7lc1UVf-VE', delay, options, compensation);
    const instance = instances.at(-1)!;
    instance.options.events.onReady({ target: instance.handle });
    return instance;
  }
  function state(value: number, index = instances.length - 1) {
    const instance = instances[index]!; instance.state = value; instance.options.events.onStateChange({ data: value });
  }
  return { probe, instances, prepare, state, host };
}

describe('独立YouTube検証', () => {
  it('可視cueのみで準備しiframe手動PLAYINGを破棄しない', async () => {
    const s = setup(); const i = await s.prepare(); s.state(5); s.state(3); s.state(1);
    expect(i.options.playerVars).toEqual({ autoplay: 0, playsinline: 1, origin: 'https://192.168.3.3:5173' });
    expect(i.options.height).toBe('270'); expect(i.handle.cueVideoById).toHaveBeenCalledWith({ videoId: 'M7lc1UVf-VE', startSeconds: 0 });
    expect(i.handle.playVideo).not.toHaveBeenCalled(); expect(i.handle.pauseVideo).not.toHaveBeenCalled();
    expect(i.handle.destroy).not.toHaveBeenCalled();
    expect(s.probe.run?.entries.map(e => e.event)).toContain('PLAYING');
  });
  it('ボタン再生は同期呼出しで1回実行する', async () => {
    const s = setup(); const i = await s.prepare('immediate'); s.state(5);
    s.probe.play('button'); expect(i.handle.playVideo).toHaveBeenCalledTimes(1);
    expect(s.probe.run?.entries.at(-1)).toMatchObject({ event: 'play.request', detail: 'button' });
  });
  it('CUED前は再生せずCUEDから指定時間後に1回のみ要求する', async () => {
    const s = setup(); const i = await s.prepare('delayed');
    await vi.advanceTimersByTimeAsync(2000); expect(i.handle.playVideo).not.toHaveBeenCalled();
    s.state(5); await vi.advanceTimersByTimeAsync(999); expect(i.handle.playVideo).not.toHaveBeenCalled();
    s.state(5); await vi.advanceTimersByTimeAsync(1); expect(i.handle.playVideo).toHaveBeenCalledTimes(1);
    s.state(3); s.state(5); await vi.advanceTimersByTimeAsync(5000); expect(i.handle.playVideo).toHaveBeenCalledTimes(1);
  });
  it('0秒待機もタイマーで非同期要求する', async () => {
    const s = setup(); const i = await s.prepare('delayed', 0); s.state(5);
    expect(i.handle.playVideo).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(0);
    expect(i.handle.playVideo).toHaveBeenCalledTimes(1);
  });
  it('ブロックとYouTube数値エラーを区別して保持し後続イベントも記録する', async () => {
    const s = setup(); const i = await s.prepare(); s.state(5);
    i.options.events.onAutoplayBlocked(); i.options.events.onError({ data: 153 }); s.state(2); s.state(-1); s.state(0);
    const entries = s.probe.run!.entries;
    expect(entries.find(e => e.event === 'onAutoplayBlocked')?.errorCode).toBeUndefined();
    expect(entries.find(e => e.event === 'onError')).toMatchObject({ errorCode: 153, observedVideoId: 'M7lc1UVf-VE', state: 5 });
    expect(entries.map(e => e.event)).toEqual(expect.arrayContaining(['PAUSED', 'UNSTARTED', 'ENDED']));
    expect(i.handle.destroy).not.toHaveBeenCalled();
    const exported = JSON.parse(s.probe.export({ userAgent: 'test' }));
    expect(exported.run.condition).toBe('iframe'); expect(exported.run.entries).toEqual(entries);
    expect(exported.environment.userAgent).toBe('test'); expect(entries[0]).toHaveProperty('wallTime');
  });
  it('試行変更で古いタイマーと遅着イベントを無効化する', async () => {
    const s = setup(); const old = await s.prepare('delayed'); s.state(5);
    const current = await s.prepare('iframe'); s.state(5);
    const count = s.probe.run!.entries.length;
    old.options.events.onStateChange({ data: 1 }); old.options.events.onAutoplayBlocked(); old.options.events.onError({ data: 100 });
    await vi.advanceTimersByTimeAsync(1500);
    expect(old.handle.playVideo).not.toHaveBeenCalled(); expect(old.handle.destroy).toHaveBeenCalledTimes(1);
    expect(current.handle.destroy).not.toHaveBeenCalled(); expect(s.probe.run!.entries).toHaveLength(count);
  });
  it('一時停止と明示破棄は待機再生を取消する', async () => {
    const s = setup(); const i = await s.prepare('delayed'); s.state(5); s.probe.pause();
    await vi.advanceTimersByTimeAsync(2000); expect(i.handle.playVideo).not.toHaveBeenCalled();
    expect(i.handle.pauseVideo).toHaveBeenCalledTimes(1); s.probe.dispose(); s.probe.dispose();
    expect(i.handle.destroy).toHaveBeenCalledTimes(1);
  });
  it('APIロード中に破棄したらiframeを生成しない', async () => {
    const host = { replaceChildren: vi.fn(), appendChild: vi.fn() } as unknown as HTMLElement;
    let resolve!: (api: YouTubeApi) => void;
    const probe = new YouTubeProbe(host, 'https://localhost', () => new Promise(r => { resolve = r; }), () => 0, () => undefined);
    const pending = probe.start('iframe', 'M7lc1UVf-VE', 1000); probe.dispose();
    const Player = vi.fn(); resolve({ Player: Player as unknown as YouTubeApi['Player'] }); await pending;
    expect(Player).not.toHaveBeenCalled(); expect(host.appendChild).not.toHaveBeenCalled();
  });
  it('準備期限超過をブロックと誤判定せず遅着CUEDを観察できる', async () => {
    const s = setup(); const i = await s.prepare(); await vi.advanceTimersByTimeAsync(15_000);
    expect(s.probe.run!.entries.map(e => e.event)).toContain('cue.timeout');
    expect(s.probe.run!.entries.map(e => e.event)).not.toContain('onAutoplayBlocked');
    s.state(5); expect(s.probe.ready).toBe(true); expect(i.handle.destroy).not.toHaveBeenCalled();
  });
  it('不正な入力で現在の試行を破棄しない', async () => {
    const s = setup(); const i = await s.prepare();
    await expect(s.probe.start('iframe', 'bad', 1000)).rejects.toThrow('11文字');
    await expect(s.probe.start('delayed', 'M7lc1UVf-VE', NaN)).rejects.toThrow('待機');
    expect(i.handle.destroy).not.toHaveBeenCalled();
  });
});

describe('事前再生後のシーク比較', () => {
  it('④は最初のPLAYINGから5秒後にseekToだけを1回呼ぶ', async () => {
    const s = setup(); const i = await s.prepare('seek-playing'); s.state(5);
    await vi.advanceTimersByTimeAsync(6000); expect(i.handle.seekTo).not.toHaveBeenCalled();
    i.position = 6; s.state(1); s.state(1);
    await vi.advanceTimersByTimeAsync(4999); expect(i.handle.seekTo).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(i.handle.seekTo).toHaveBeenCalledExactlyOnceWith(0, true);
    expect(i.handle.playVideo).not.toHaveBeenCalled(); expect(i.handle.pauseVideo).not.toHaveBeenCalled();
    s.state(3); s.state(1); await vi.advanceTimersByTimeAsync(5000);
    expect(i.handle.seekTo).toHaveBeenCalledTimes(1); expect(i.handle.destroy).not.toHaveBeenCalled();
  });
  it('⑤はPLAYINGで一時停止しPAUSEDから5秒後にseek、playの順で呼ぶ', async () => {
    const s = setup(); const i = await s.prepare('seek-paused'); s.state(5); i.position = 3; s.state(1);
    expect(i.handle.pauseVideo).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6000); expect(i.handle.seekTo).not.toHaveBeenCalled();
    s.state(2); await vi.advanceTimersByTimeAsync(4999); expect(i.handle.seekTo).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(i.handle.seekTo).toHaveBeenCalledExactlyOnceWith(0, true);
    expect(i.handle.playVideo).toHaveBeenCalledTimes(1);
    expect(i.handle.seekTo.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(i.handle.playVideo).mock.invocationCallOrder[0]!);
    s.state(1); expect(i.handle.pauseVideo).toHaveBeenCalledTimes(1);
  });
  it('位置変化と暫定安定の時刻を別々に測定しJSONに含める', async () => {
    const s = setup(); const i = await s.prepare('seek-playing'); s.state(5); i.position = 6; s.state(1);
    await vi.advanceTimersByTimeAsync(5000); expect(s.probe.run?.seek?.positionChangedAfterMs).toBeUndefined();
    i.position = 0.05; await vi.advanceTimersByTimeAsync(50);
    expect(s.probe.run?.seek?.positionChangedAfterMs).toBe(50);
    i.position = 0.5; await vi.advanceTimersByTimeAsync(1000);
    expect(s.probe.run?.seek).toMatchObject({ stableAfterMs: 1050, outcome: 'observed-stable' });
    const exported = JSON.parse(s.probe.export({})); expect(exported.run.seek.beforeSec).toBe(6);
    expect(exported.run.entries.find((e: { event: string }) => e.event === 'seek.request').currentTimeSec).toBe(6);
    expect(exported.seekObservation.pollMs).toBe(50);
  });
  it('BUFFERINGが途中に入った場合は安定観測期間を数え直す', async () => {
    const s = setup(); const i = await s.prepare('seek-playing'); s.state(5); i.position = 6; s.state(1);
    await vi.advanceTimersByTimeAsync(5000); i.position = 0; await vi.advanceTimersByTimeAsync(50);
    i.position = 0.5; await vi.advanceTimersByTimeAsync(500); s.state(3); s.state(1);
    await vi.advanceTimersByTimeAsync(600); expect(s.probe.run?.seek?.stableAfterMs).toBeUndefined();
    i.position = 1; await vi.advanceTimersByTimeAsync(450); expect(s.probe.run?.seek?.outcome).toBe('observed-stable');
  });
  it('PAUSEDのままでは安定扱いせず、観測期限超過もblockedと判定しない', async () => {
    const s = setup(); const i = await s.prepare('seek-paused'); s.state(5); i.position = 6; s.state(1); s.state(2);
    await vi.advanceTimersByTimeAsync(5000); i.position = 0;
    await vi.advanceTimersByTimeAsync(15000);
    expect(s.probe.run?.seek).toMatchObject({ positionChangedAfterMs: 50, outcome: 'observation-timeout' });
    expect(s.probe.run?.seek?.stableAfterMs).toBeUndefined();
    expect(s.probe.run?.entries.some(e => e.event === 'onAutoplayBlocked')).toBe(false);
  });
  it('元位置0秒付近では位置変化を捏造しない', async () => {
    const s = setup(); const i = await s.prepare('seek-paused'); s.state(5); s.state(1); s.state(2);
    await vi.advanceTimersByTimeAsync(5000); s.state(1); await vi.advanceTimersByTimeAsync(50);
    i.position = 0.4; await vi.advanceTimersByTimeAsync(1000);
    expect(s.probe.run?.seek?.positionChangedAfterMs).toBeUndefined();
    expect(s.probe.run?.seek?.stableAfterMs).toBe(1050);
  });
  it('試行変更・待機取消・状態変更は予定シークを実行しない', async () => {
    const s = setup(); const old = await s.prepare('seek-playing'); s.state(5); s.state(1);
    await s.prepare('iframe'); await vi.advanceTimersByTimeAsync(5000); expect(old.handle.seekTo).not.toHaveBeenCalled();
    const cancelled = await s.prepare('seek-paused'); s.state(5); s.state(1); s.probe.pause(); s.state(2);
    await vi.advanceTimersByTimeAsync(5000); expect(cancelled.handle.seekTo).not.toHaveBeenCalled();
    const paused = await s.prepare('seek-playing'); s.state(5); s.state(1); s.state(2);
    await vi.advanceTimersByTimeAsync(5000); expect(paused.handle.seekTo).not.toHaveBeenCalled();
    expect(s.probe.run?.entries.at(-1)?.event).toBe('seek.cancelled');
  });
  it('シーク後のブロック・エラーは観測を止めてプレイヤーとコードを保持する', async () => {
    const s = setup(); const i = await s.prepare('seek-playing'); s.state(5); i.position = 6; s.state(1);
    await vi.advanceTimersByTimeAsync(5000); i.options.events.onAutoplayBlocked(); i.options.events.onError({ data: 5 });
    const count = s.probe.run!.entries.length; await vi.advanceTimersByTimeAsync(16000);
    expect(s.probe.run!.entries).toHaveLength(count); expect(s.probe.run?.seek?.outcome).toBe('interrupted');
    expect(s.probe.run!.entries.at(-1)).toMatchObject({ event: 'onError', errorCode: 5, currentTimeSec: 6 });
    expect(i.handle.destroy).not.toHaveBeenCalled();
  });
});

async function flushMic() { for (let i = 0; i < 50; i++) await Promise.resolve(); }
function micSetup(options: Partial<MicProbeOptions> = {}, compensation?: Compensation) {
  let listener: ((sample: VolumeSample) => void) | undefined;
  let interrupted: ((message: string) => void) | undefined;
  const off = vi.fn(() => { listener = undefined; });
  const lease: AudioLease = { subscribe: vi.fn(value => { listener = value; return off; }),
    release: vi.fn(async () => {}), onInterrupted: value => { interrupted = value; return () => { interrupted = undefined; }; } };
  const audio: AudioInput = { acquire: vi.fn(async () => lease) };
  const s = setup(audio);
  const settings = { ...micProbeDefaults, ...options };
  const prepare = async () => { const player = await s.prepare(compensation ? 'mic-compensation' : 'mic-resume', 1000, settings, compensation); s.state(5); return player; };
  const arm = async () => { const player = await prepare(); s.state(1); s.state(2); await flushMic(); return player; };
  let time = 100;
  const sample = (rms = 0.5, gap = 50) => { time += gap; listener?.({ rms, timeMs: time }); };
  return { ...s, audio, lease, off, prepare, arm, sample, interrupt: () => interrupted?.('input lost') };
}

describe('⑥ 事前再生＋実マイク検知の契約', () => {
  it('初回PLAYINGで一時停止しPAUSED確認までマイクを取得しない', async () => {
    const s = micSetup(); const i = await s.prepare();
    expect(s.audio.acquire).not.toHaveBeenCalled(); s.state(1); s.state(1);
    expect(i.handle.pauseVideo).toHaveBeenCalledTimes(1); expect(s.audio.acquire).not.toHaveBeenCalled();
    s.state(2); s.state(2); await flushMic(); expect(s.audio.acquire).toHaveBeenCalledTimes(1);
    expect(s.probe.run?.mic?.phase).toBe('armed'); expect(i.handle.playVideo).not.toHaveBeenCalled();
    expect(i.handle.seekTo).not.toHaveBeenCalled();
    expect(s.probe.run?.entries.map(e => e.event)).toEqual(expect.arrayContaining(['mic.acquire', 'mic.acquired', 'detector.armed']));
  });
  it('しきい値と継続時間成立後に指定位置のseek→playを1回のみ実行する', async () => {
    const s = micSetup({ startSec: 12.35, threshold: 0.2, durationMs: 100 }); const i = await s.arm();
    s.sample(0.2); s.sample(0.5); s.sample(0.5); expect(i.handle.playVideo).not.toHaveBeenCalled();
    s.sample(0.5); s.sample(0.5); s.state(2);
    expect(i.handle.seekTo).toHaveBeenCalledExactlyOnceWith(12.35, true); expect(i.handle.playVideo).toHaveBeenCalledTimes(1);
    expect(i.handle.seekTo.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(i.handle.playVideo).mock.invocationCallOrder[0]!);
    expect(s.off).toHaveBeenCalledTimes(1); expect(s.lease.release).not.toHaveBeenCalled();
    expect(s.probe.run?.entries.filter(e => e.event === 'detector.detected')).toHaveLength(1);
    expect(s.probe.run?.entries.filter(e => e.event === 'play.request')).toHaveLength(1);
    s.state(3); await vi.advanceTimersByTimeAsync(400); s.state(1); s.state(1);
    expect(s.probe.run?.mic?.playingAfterDetectedMs).toBe(400);
    const json = JSON.parse(s.probe.export({ observation: 'Bluetooth route checked by user' }));
    expect(json.run.mic.options.startSec).toBe(12.35); expect(json.run.mic.playingAfterDetectedMs).toBe(400);
  });
  it.each([30000, 60000])('%ims待機後も検知で再開でき、待機中の再生要求はない', async wait => {
    const s = micSetup({ durationMs: 0 }); const i = await s.arm();
    await vi.advanceTimersByTimeAsync(wait); expect(i.handle.playVideo).not.toHaveBeenCalled();
    s.sample(); expect(i.handle.playVideo).toHaveBeenCalledTimes(1);
    expect(s.probe.run?.mic?.detectedAfterArmedMs).toBe(wait);
  });
  it('解放設定は検知時にマイクだけを解放して動画を維持する', async () => {
    const s = micSetup({ retainMic: false, durationMs: 0 }); const i = await s.arm(); s.sample(); await flushMic();
    expect(s.lease.release).toHaveBeenCalledTimes(1); expect(i.handle.destroy).not.toHaveBeenCalled();
    s.state(1); expect(s.probe.run?.mic?.phase).toBe('playing');
    s.probe.dispose(); await flushMic(); expect(s.lease.release).toHaveBeenCalledTimes(1);
  });
  it('保持設定でもすべて停止・重複停止は同じleaseを並行解放しない', async () => {
    const s = micSetup({ durationMs: 0 }); const i = await s.arm(); s.sample(); s.state(1);
    s.probe.dispose(); s.probe.dispose(); await flushMic();
    expect(s.lease.release).toHaveBeenCalledTimes(1); expect(i.handle.destroy).toHaveBeenCalledTimes(1);
    expect(s.probe.run?.mic?.phase).toBe('stopped');
  });
  it('検知後の一時停止・再開は検知を再開せずseekもしない', async () => {
    const s = micSetup({ durationMs: 0 }); const i = await s.arm(); s.sample(); s.state(1);
    s.probe.pause(); s.state(2); s.probe.resume(); s.state(1); s.sample();
    expect(i.handle.playVideo).toHaveBeenCalledTimes(2); expect(i.handle.seekTo).toHaveBeenCalledTimes(1);
    expect(s.audio.acquire).toHaveBeenCalledTimes(1); expect(s.probe.run?.mic?.phase).toBe('playing');
  });
  it('検知直後の一時停止でも遅着PLAYINGから自動復帰しない', async () => {
    const s = micSetup({ durationMs: 0 }); const i = await s.arm(); s.sample(); s.probe.pause(); s.state(1);
    await flushMic(); expect(i.handle.playVideo).toHaveBeenCalledTimes(1);
    expect(i.handle.destroy).toHaveBeenCalledTimes(1); expect(s.probe.run?.mic?.phase).toBe('error');
  });
  it('検知前のページ再生操作は無効、iframeから想定外再生したら資源を解放する', async () => {
    const s = micSetup(); const i = await s.arm(); s.probe.play('button'); s.probe.resume();
    expect(i.handle.playVideo).not.toHaveBeenCalled(); s.state(1); await flushMic();
    expect(s.lease.release).toHaveBeenCalledTimes(1); expect(i.handle.destroy).toHaveBeenCalledTimes(1);
  });
  it('マイク許可待ちで停止後、遅着leaseを解放し検知を開始しない', async () => {
    const s = micSetup(); let resolve!: (value: AudioLease) => void;
    vi.mocked(s.audio.acquire).mockReturnValueOnce(new Promise(yes => { resolve = yes; }));
    const i = await s.prepare(); s.state(1); s.state(2); s.probe.dispose();
    resolve(s.lease); await flushMic(); expect(s.lease.release).toHaveBeenCalledTimes(1);
    expect(s.lease.subscribe).not.toHaveBeenCalled(); expect(i.handle.playVideo).not.toHaveBeenCalled();
    expect(vi.mocked(s.audio.acquire).mock.calls[0]?.[0]?.aborted).toBe(true);
  });
  it('権限拒否と待機期限超過では再生せず資源を解放する', async () => {
    const denied = micSetup(); vi.mocked(denied.audio.acquire).mockRejectedValueOnce(new Error('denied'));
    const p = await denied.arm(); expect(p.handle.destroy).toHaveBeenCalledTimes(1);
    expect(p.handle.playVideo).not.toHaveBeenCalled(); expect(denied.probe.run?.mic?.phase).toBe('error');
    const s = micSetup({ waitTimeoutMs: 1000 }); const i = await s.arm();
    await vi.advanceTimersByTimeAsync(1000); expect(s.lease.release).toHaveBeenCalledTimes(1);
    expect(i.handle.destroy).toHaveBeenCalledTimes(1); expect(i.handle.playVideo).not.toHaveBeenCalled();
  });
  it.each(['blocked', 'error', 'ended', 'interrupted'])('%sでマイクとプレイヤーを解放する', async kind => {
    const s = micSetup(); const i = await s.arm();
    if (kind === 'blocked') i.options.events.onAutoplayBlocked();
    if (kind === 'error') i.options.events.onError({ data: 5 });
    if (kind === 'ended') s.state(0);
    if (kind === 'interrupted') s.interrupt();
    await flushMic(); expect(i.handle.destroy).toHaveBeenCalledTimes(1); expect(s.lease.release).toHaveBeenCalledTimes(1);
  });
  it('マイク解放失敗を表示し明示的に再試行できる', async () => {
    const s = micSetup(); await s.arm(); vi.mocked(s.lease.release).mockRejectedValueOnce(new Error('close failed'));
    s.probe.dispose(); await flushMic();
    expect(s.probe.run?.entries.some(e => e.event === 'mic.release.error')).toBe(true);
    await s.probe.retryMicCleanup(); expect(s.lease.release).toHaveBeenCalledTimes(2);
    expect(s.probe.run?.entries.at(-1)?.event).toBe('mic.cleanup.retried');
  });
  it('新しい試行で古い検知コールバックから再生しない', async () => {
    const s = micSetup(); const i = await s.arm(); const oldSample = vi.mocked(s.lease.subscribe).mock.calls[0]![0];
    await s.probe.start('iframe', 'M7lc1UVf-VE', 1000); oldSample({ rms: 1, timeMs: 500 }); oldSample({ rms: 1, timeMs: 600 });
    expect(i.handle.playVideo).not.toHaveBeenCalled(); expect(s.probe.run?.condition).toBe('iframe');
  });
  it('PAUSED未確認・検知後のPLAYING未確認に期限を設ける', async () => {
    const first = micSetup(); const i = await first.prepare(); first.state(1);
    await vi.advanceTimersByTimeAsync(10000); expect(i.handle.destroy).toHaveBeenCalledTimes(1);
    expect(first.audio.acquire).not.toHaveBeenCalled();
    const s = micSetup({ durationMs: 0 }); const p = await s.arm(); s.sample();
    await vi.advanceTimersByTimeAsync(10000); expect(p.handle.destroy).toHaveBeenCalledTimes(1);
    expect(s.lease.release).toHaveBeenCalledTimes(1);
  });
});

describe('⑥ マイク資源の追加競合回帰', () => {
  it('旧取得の部分失敗が新しい試行のマイクを解放しない', async () => {
    const s = micSetup(); let rejectOld!: (reason: unknown) => void;
    vi.mocked(s.audio.acquire).mockReturnValueOnce(new Promise((_yes, no) => { rejectOld = no; }));
    await s.prepare(); s.state(1); s.state(2); s.probe.dispose();
    await s.arm(); expect(s.probe.run?.mic?.phase).toBe('armed');
    const partial: AudioLease = { subscribe: vi.fn(), release: vi.fn(async () => {}) };
    rejectOld(new AudioAcquireError('old partial failure', partial)); await flushMic();
    expect(partial.release).toHaveBeenCalledTimes(1); expect(s.lease.release).not.toHaveBeenCalled();
    expect(s.probe.run?.mic?.phase).toBe('armed'); s.probe.dispose(); await flushMic();
  });
  it('解放未完了に期限を設け、再試行してもreleaseを並行呼出ししない', async () => {
    const s = micSetup(); await s.arm(); let finish!: () => void;
    vi.mocked(s.lease.release).mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
    s.probe.dispose(); await vi.advanceTimersByTimeAsync(3001);
    expect(s.probe.run?.entries.some(e => e.event === 'mic.release.error')).toBe(true);
    const retry = s.probe.retryMicCleanup(); await flushMic(); expect(s.lease.release).toHaveBeenCalledTimes(1);
    finish(); await retry; expect(s.probe.run?.entries.at(-1)?.event).toBe('mic.cleanup.retried');
  });
  it('0ms継続でもしきい値超過前に再生しない', async () => {
    const s = micSetup({ durationMs: 0 }); const i = await s.arm();
    s.sample(0); s.sample(micProbeDefaults.threshold); expect(i.handle.playVideo).not.toHaveBeenCalled();
    s.sample(0.5); expect(i.handle.playVideo).toHaveBeenCalledTimes(1);
  });
  it('マイク取得後の停止状態が変わっていたらarmせず解放する', async () => {
    const s = micSetup(); let resolve!: (value: AudioLease) => void;
    vi.mocked(s.audio.acquire).mockReturnValueOnce(new Promise(yes => { resolve = yes; }));
    const i = await s.prepare(); s.state(1); s.state(2);
    i.state = 1; resolve(s.lease); await flushMic();
    expect(s.lease.subscribe).not.toHaveBeenCalled(); expect(s.lease.release).toHaveBeenCalledTimes(1);
    expect(i.handle.destroy).toHaveBeenCalledTimes(1); expect(i.handle.playVideo).not.toHaveBeenCalled();
  });
});

describe('⑥ 継続時間の入力・境界値回帰', () => {
  it.each([0, 50, 1000])('継続%imsを待機期限と混同せず受け付け、成立直前には再生しない', async durationMs => {
    const s = micSetup({ durationMs }); const i = await s.arm();
    expect(s.probe.run?.mic?.options.durationMs).toBe(durationMs);
    expect(s.probe.run?.mic?.phase).toBe('armed');
    expect(i.handle.playVideo).not.toHaveBeenCalled();
    const emit = vi.mocked(s.lease.subscribe).mock.calls[0]![0];
    const threshold = micProbeDefaults.threshold;
    emit({ rms: threshold, timeMs: 10 });
    expect(i.handle.playVideo).not.toHaveBeenCalled();
    emit({ rms: threshold + 0.01, timeMs: 100 });
    if (durationMs === 0) {
      expect(i.handle.playVideo).toHaveBeenCalledTimes(1);
    } else {
      expect(i.handle.playVideo).not.toHaveBeenCalled();
      for (let elapsed = 50; elapsed < durationMs; elapsed += 50) {
        emit({ rms: threshold + 0.01, timeMs: 100 + elapsed });
      }
      emit({ rms: threshold + 0.01, timeMs: 100 + durationMs - 1 });
      expect(i.handle.playVideo).not.toHaveBeenCalled();
      emit({ rms: threshold + 0.01, timeMs: 100 + durationMs });
      expect(i.handle.playVideo).toHaveBeenCalledTimes(1);
    }
    emit({ rms: 1, timeMs: 100 + durationMs + 1 });
    expect(i.handle.playVideo).toHaveBeenCalledTimes(1);
    expect(i.handle.seekTo).toHaveBeenCalledTimes(1);
    s.probe.dispose(); await flushMic();
  });
  it.each([-1, -50, NaN, Infinity, -Infinity, 2001])('不正な継続時間%sを準備前に拒否する', async durationMs => {
    const s = micSetup({ durationMs });
    await expect(s.prepare()).rejects.toThrow('継続時間は0〜2000ms');
    expect(s.instances).toHaveLength(0); expect(s.audio.acquire).not.toHaveBeenCalled();
  });
  it.each(['abc', '', '50ms'])('数値でない継続時間%jを拒否する', async input => {
    const s = micSetup({ durationMs: input as unknown as number });
    await expect(s.prepare()).rejects.toThrow('継続時間は0〜2000ms');
    expect(s.audio.acquire).not.toHaveBeenCalled();
  });
  it('1秒の下限は継続時間ではなく検知待機期限の検査である', async () => {
    const s = micSetup({ durationMs: 0, waitTimeoutMs: 0 });
    await expect(s.prepare()).rejects.toThrow('検知待機期限は1〜300秒');
    expect(s.audio.acquire).not.toHaveBeenCalled();
  });
});

describe('⑦ 再生補正比較', () => {
  it.each([
    ['baseline', 0, 10], ['wait', 100, 10], ['position', 0, 10.5], ['combined', 100, 10.5],
  ] as const)('%sは有効な待機量・位置補正だけを適用する', async (mode, waitMs, target) => {
    const s = micSetup({ durationMs: 0, startSec: 10 }, { mode, waitMs: 100, offsetMs: 500 }); const i = await s.arm();
    s.sample();
    if (waitMs) { expect(i.handle.playVideo).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(99); expect(i.handle.playVideo).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(1); }
    expect(i.handle.seekTo).toHaveBeenCalledExactlyOnceWith(target, true); expect(i.handle.playVideo).toHaveBeenCalledTimes(1);
    expect(s.probe.run?.mic?.requestAfterDetectedMs).toBe(waitMs);
    i.position = target + 0.2; s.state(3); await vi.advanceTimersByTimeAsync(200); s.state(1); s.state(1); s.sample();
    expect(s.probe.run?.mic).toMatchObject({ playingAfterRequestMs: 200, playingAfterDetectedMs: waitMs + 200, seekRequestedSec: target, playingPositionSec: target + 0.2 });
    expect(s.probe.run?.entries.filter(e => e.event === 'play.request')).toHaveLength(1);
    s.probe.dispose(); await flushMic();
  });
  it('待機0msと補正0msは即時要求で⑥の基準と一致する', async () => {
    const s = micSetup({ durationMs: 0, startSec: 10 }, { mode: 'combined', waitMs: 0, offsetMs: 0 }); const i = await s.arm(); s.sample();
    expect(i.handle.playVideo).toHaveBeenCalledTimes(1); expect(i.handle.seekTo).toHaveBeenCalledWith(10, true);
    expect(s.probe.run?.mic?.requestAfterDetectedMs).toBe(0);
    expect(s.probe.run?.entries.map(e => e.event)).toEqual(expect.arrayContaining(['compensation.wait.start', 'compensation.wait.end']));
    s.probe.dispose(); await flushMic();
  });
  it.each([[10, -500, 9.5], [0, -500, 0], [10, -20000, 0], [120, 0, 120], [119, 2000, 120], [121, 0, 120]])('開始%s秒＋%smsを動画範囲の%s秒へ制限する', async (startSec, offsetMs, target) => {
    const s = micSetup({ durationMs: 0, startSec }, { mode: 'position', waitMs: 0, offsetMs }); const i = await s.arm(); s.sample();
    expect(i.handle.seekTo).toHaveBeenCalledWith(target, true); expect(s.probe.run?.mic?.videoDurationSec).toBe(120);
    s.probe.dispose(); await flushMic();
  });
  it.each([0, NaN, Infinity])('動画長%sが取得不能ならシークせず資源解放', async duration => {
    const s = micSetup({ durationMs: 0 }, { mode: 'baseline', waitMs: 0, offsetMs: 0 }); const i = await s.arm(); i.duration = duration; s.sample(); await flushMic();
    expect(i.handle.seekTo).not.toHaveBeenCalled(); expect(i.handle.playVideo).not.toHaveBeenCalled();
    expect(i.handle.destroy).toHaveBeenCalledTimes(1); expect(s.lease.release).toHaveBeenCalledTimes(1);
  });
  it.each(['stop', 'pause', 'error', 'replace'])('補正待機中の%sでタイマーを取消し遅延再生しない', async action => {
    const s = micSetup({ durationMs: 0 }, { mode: 'wait', waitMs: 1000, offsetMs: 0 }); const i = await s.arm(); s.sample(); s.sample();
    expect(s.probe.run?.mic?.phase).toBe('waiting');
    if (action === 'stop') s.probe.dispose();
    if (action === 'pause') s.probe.pause();
    if (action === 'error') i.options.events.onError({ data: 5 });
    if (action === 'replace') await s.probe.start('iframe', 'M7lc1UVf-VE', 1000);
    await vi.advanceTimersByTimeAsync(2000); expect(i.handle.seekTo).not.toHaveBeenCalled(); expect(i.handle.playVideo).not.toHaveBeenCalled();
    expect(s.off).toHaveBeenCalledTimes(1); s.probe.dispose(); await flushMic(); expect(s.lease.release).toHaveBeenCalledTimes(1);
  });
  it('解放設定は補正待機中に解放し、重複検知でタイマーを増やさない', async () => {
    const s = micSetup({ durationMs: 0, retainMic: false }, { mode: 'wait', waitMs: 1000, offsetMs: 0 }); const i = await s.arm(); s.sample(); s.sample(); await flushMic();
    expect(s.lease.release).toHaveBeenCalledTimes(1); expect(i.handle.playVideo).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000); expect(i.handle.playVideo).toHaveBeenCalledTimes(1); s.probe.dispose(); await flushMic(); expect(s.lease.release).toHaveBeenCalledTimes(1);
  });
  it('補正待機中に動画が再生されたら要求を中止する', async () => {
    const s = micSetup({ durationMs: 0 }, { mode: 'wait', waitMs: 100, offsetMs: 0 }); const i = await s.arm(); s.sample(); s.state(1);
    await vi.advanceTimersByTimeAsync(100); expect(i.handle.playVideo).not.toHaveBeenCalled(); expect(i.handle.destroy).toHaveBeenCalledTimes(1);
  });
  it('補正待機で中断した試行を手動再開しても初回遅延として集計しない', async () => {
    const s = micSetup({ durationMs: 0 }, { mode: 'wait', waitMs: 100, offsetMs: 0 }); await s.arm(); s.sample(); s.probe.pause(); s.state(2); s.probe.resume(); s.state(1);
    expect(s.probe.run?.mic?.initialOutcome).toBe('interrupted'); expect(s.probe.run?.mic?.playingAfterDetectedMs).toBeUndefined(); s.probe.dispose(); await flushMic();
  });
  it.each([{ mode: 'wait', waitMs: -1, offsetMs: 0 }, { mode: 'position', waitMs: 0, offsetMs: NaN }, { mode: 'wait', waitMs: 0.5, offsetMs: 0 }])('不正補正%jを準備前に拒否', async invalid => {
    const s = micSetup({}, invalid as Compensation); await expect(s.prepare()).rejects.toThrow('補正設定'); expect(s.audio.acquire).not.toHaveBeenCalled();
  });
});
