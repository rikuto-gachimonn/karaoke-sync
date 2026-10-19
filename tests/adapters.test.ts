import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { YouTubePlayer } from '../src/adapters/youtube/player';
import type { YouTubeApi, YouTubeHandle, YouTubeOptions } from '../src/adapters/youtube/api';
import { BrowserAudioInput, rms, type AudioEnvironment } from '../src/adapters/audio/microphone';
import { AudioAcquireError, type PlayerEvent } from '../src/session/ports';
import { settings } from '../src/config/settings';
import { SessionController } from '../src/session/controller';
import { SimulatedPlayer } from '../src/adapters/simulation';
import { SustainedVolumeDetector } from '../src/domain/detector';

async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

function youtube() {
  let options!: YouTubeOptions;
  let state = -1;
  let videoId = '';
  const handle: YouTubeHandle = {
    cueVideoById: vi.fn(value => { videoId = value.videoId; }),
    playVideo: vi.fn(), pauseVideo: vi.fn(() => { state = 2; }),
    getPlayerState: vi.fn(() => state), getVideoData: () => ({ video_id: videoId }), destroy: vi.fn(),
  };
  const host = { ownerDocument: { createElement: () => ({}) }, appendChild: vi.fn(), replaceChildren: vi.fn() } as unknown as HTMLElement;
  const api: YouTubeApi = { Player: class { constructor(_element: HTMLElement, value: YouTubeOptions) { options = value; return handle; } } as unknown as YouTubeApi['Player'] };
  const player = new YouTubePlayer(host, async () => api, 'http://localhost:5173');
  const events: PlayerEvent[] = []; player.subscribe(event => events.push(event));
  const prepare = async () => {
    const preparation = player.prepare('dQw4w9WgXcQ', 12.35); await flush();
    options.events.onReady({ target: handle }); await flush();
    state = 5; options.events.onStateChange({ data: 5 }); await preparation;
  };
  return { player, handle, host, events, prepare, options: () => options,
    state: (value: number) => { state = value; options.events.onStateChange({ data: value }); } };
}

describe('YouTube IFrame adapter契約', () => {
  it('onReady前の停止では未準備APIを呼ばず、破棄で準備を取消する', async () => {
    const s = youtube(); const pending = s.player.prepare('dQw4w9WgXcQ', 0);
    const assertion = expect(pending).rejects.toThrow('破棄'); await flush();
    await s.player.pause(); expect(s.handle.pauseVideo).not.toHaveBeenCalled();
    expect(await s.player.readPlaybackState()).toBe('other');
    await s.player.dispose(); await assertion; expect(s.handle.destroy).toHaveBeenCalledTimes(1);
  });
  it('可視プレイヤーをcueし、指定位置とoriginを設定。準備だけでは再生しない', async () => {
    const s = youtube(); await s.prepare();
    expect(s.options().width).toBe('100%'); expect(s.options().height).toBe('270');
    expect(s.options().playerVars).toEqual({ autoplay: 0, playsinline: 1, origin: 'http://localhost:5173' });
    expect(s.handle.cueVideoById).toHaveBeenCalledWith({ videoId: 'dQw4w9WgXcQ', startSeconds: 12.35 });
    expect(s.handle.playVideo).not.toHaveBeenCalled(); await s.player.dispose();
  });

  it('play/再開はplayVideoだけ、pauseは現在状態で確認。番号はイベントへ付けない', async () => {
    const s = youtube(); await s.prepare(); s.player.play(99); s.state(1);
    expect(s.events.at(-1)).toEqual({ type: 'playing' });
    expect(await s.player.readPlaybackState()).toBe('playing');
    await s.player.pause(); expect(await s.player.readPlaybackState()).toBe('paused');
    s.player.play(101); expect(s.handle.playVideo).toHaveBeenCalledTimes(2);
    expect(s.handle.cueVideoById).toHaveBeenCalledTimes(1); await s.player.dispose();
  });

  it('BUFFERING/PAUSED/ENDED/再生ブロックを通知する', async () => {
    const s = youtube(); await s.prepare();
    s.state(3); s.state(2); s.state(0); s.options().events.onAutoplayBlocked();
    expect(s.events.map(e => e.type)).toEqual(['cued', 'buffering', 'paused', 'ended', 'blocked']);
    expect(await s.player.readPlaybackState()).toBe('ended'); await s.player.dispose();
  });

  it('埋込エラー153を分類しcue待ちをrejectする', async () => {
    const s = youtube(); const pending = s.player.prepare('dQw4w9WgXcQ', 0);
    const assertion = expect(pending).rejects.toThrow('153');
    await flush(); s.options().events.onReady({ target: s.handle }); await flush();
    s.options().events.onError({ data: 153 }); await assertion;
    expect(s.events.at(-1)).toMatchObject({ type: 'error' }); await s.player.dispose();
  });

  it('準備完了前のplayを拒否し、破棄でCUED待ちを解除する', async () => {
    const s = youtube(); expect(() => s.player.play(1)).toThrow('準備');
    const pending = s.player.prepare('dQw4w9WgXcQ', 0); const assertion = expect(pending).rejects.toThrow('破棄');
    await flush(); s.options().events.onReady({ target: s.handle }); await flush();
    await s.player.dispose(); await assertion; s.state(1);
    expect(s.handle.destroy).toHaveBeenCalledTimes(1); expect(s.events).toEqual([]);
    await s.player.dispose(); expect(s.handle.destroy).toHaveBeenCalledTimes(1);
  });

  it('APIロード中の取消後はiframeを生成しない', async () => {
    const api = deferred<YouTubeApi>(); const host = { appendChild: vi.fn() } as unknown as HTMLElement;
    const player = new YouTubePlayer(host, () => api.promise, 'http://localhost');
    const pending = player.prepare('dQw4w9WgXcQ', 0); const assertion = expect(pending).rejects.toThrow('取消');
    // disposeはまだDOMを持たないhostにも対応する実DOMを模擬。
    host.replaceChildren = vi.fn(); await player.dispose(); api.resolve({ Player: vi.fn() as unknown as YouTubeApi['Player'] });
    await assertion; expect(host.appendChild).not.toHaveBeenCalled();
  });

  it('pauseがPLAYINGのままなら期限で未確認を報告する', async () => {
    const s = youtube(); await s.prepare(); s.state(1);
    vi.mocked(s.handle.pauseVideo).mockImplementation(() => {});
    const pausing = s.player.pause(); const assertion = expect(pausing).rejects.toThrow('停止を確認');
    await vi.advanceTimersByTimeAsync(2_550); await assertion; await s.player.dispose();
  });
});

function audio() {
  const trackEvents = new Map<string, EventListenerOrEventListenerObject>();
  const track = {
    stop: vi.fn(), getSettings: () => ({ echoCancellation: false }),
    addEventListener: vi.fn((name: string, listener: EventListener) => trackEvents.set(name, listener)),
    removeEventListener: vi.fn(),
  };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  const contextEvents = new Map<string, EventListener>();
  let state = 'running';
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const analyser = { fftSize: 0, disconnect: vi.fn(), getFloatTimeDomainData: vi.fn((data: Float32Array) => data.fill(0.25)) };
  const context = {
    get state() { return state; }, sampleRate: 48_000,
    resume: vi.fn(async () => {}), close: vi.fn(async () => { state = 'closed'; }),
    createMediaStreamSource: vi.fn(() => source), createAnalyser: vi.fn(() => analyser),
    addEventListener: vi.fn((name: string, listener: EventListener) => contextEvents.set(name, listener)), removeEventListener: vi.fn(),
  };
  let frame: FrameRequestCallback | undefined;
  const environment: AudioEnvironment = {
    createContext: () => context as unknown as AudioContext, getUserMedia: vi.fn(async () => stream), now: () => 100,
    requestFrame: vi.fn(callback => { frame = callback; return 42; }), cancelFrame: vi.fn(),
  };
  const diagnostic = vi.fn();
  const input = new BrowserAudioInput(environment, diagnostic);
  return { input, environment, context, source, analyser, track, stream, diagnostic, frame: () => frame?.(100),
    running: () => { state = 'running'; contextEvents.get('statechange')?.(new Event('statechange')); },
    interrupt: () => { state = 'suspended'; contextEvents.get('statechange')?.(new Event('statechange')); } };
}

describe('Web Audio/getUserMedia adapter契約', () => {
  it.each([0, 30_000])('動画待機%sms→PLAYING→実adapterの3秒起動失敗→直接操作で再取得する', async waitMs => {
    const failed = audio(); failed.interrupt(); failed.context.resume.mockReturnValue(new Promise(() => {}));
    const retry = audio(); let attempts = 0;
    const player = new SimulatedPlayer(); const play = vi.spyOn(player, 'play');
    const controller = new SessionController({ createPlayer: () => player, createDetector: () => new SustainedVolumeDetector(),
      audio: { acquire: signal => (++attempts === 1 ? failed : retry).input.acquire(signal) } });
    await controller.prepare({ videoId: 'M7lc1UVf-VE', service: 'DAM', savedPositionSec: 10, offsetSec: 0, threshold: 0.035, durationMs: 200, playbackMode: 'preplay' });
    player.emit({ type: 'buffering' }); await vi.advanceTimersByTimeAsync(waitMs);
    expect(attempts).toBe(0);
    player.emit({ type: 'playing' }); await flush();
    await vi.advanceTimersByTimeAsync(settings.audioStartTimeoutMs); await flush();
    expect(controller.getSnapshot()).toMatchObject({ phase: 'micReady', mic: 'off' });
    expect(failed.track.stop).toHaveBeenCalledTimes(1); expect(failed.context.close).toHaveBeenCalledTimes(1);
    expect(play).not.toHaveBeenCalled();
    controller.retryMicrophone(); expect(retry.context.resume).toHaveBeenCalledTimes(1);
    await flush(); expect(controller.getSnapshot().phase).toBe('armed'); expect(play).not.toHaveBeenCalled();
    await controller.stop(); expect(retry.track.stop).toHaveBeenCalledTimes(1);
  });
  it('呼出しの同期区間でresumeを要求し、マイク取得後の経路変更で再起動する', async () => {
    const s = audio(); s.interrupt();
    s.context.resume.mockReturnValueOnce(new Promise(() => {}));
    s.context.resume.mockImplementationOnce(async () => { s.running(); });
    const acquisition = s.input.acquire();
    expect(s.context.resume).toHaveBeenCalledTimes(1);
    const lease = await acquisition;
    expect(s.context.resume).toHaveBeenCalledTimes(2);
    expect(s.diagnostic).toHaveBeenCalledWith('mic.context.resume.request', expect.stringContaining('after-microphone'));
    expect(s.diagnostic).toHaveBeenCalledWith('mic.context.start.completed', expect.stringContaining('running'));
    await lease.release();
  });

  it('マイク取得完了から起動期限を数え、停止後のresume完了で復活しない', async () => {
    const s = audio(); const stream = deferred<MediaStream>(); const resumed = deferred<void>();
    s.interrupt();
    vi.mocked(s.environment.getUserMedia).mockReturnValueOnce(stream.promise);
    s.context.resume.mockReturnValue(resumed.promise);
    const acquisition = s.input.acquire(); const assertion = expect(acquisition).rejects.toThrow('AudioContext起動期限');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(s.context.close).not.toHaveBeenCalled();
    stream.resolve(s.stream); await flush();
    await vi.advanceTimersByTimeAsync(settings.audioStartTimeoutMs - 1);
    expect(s.context.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await assertion;
    expect(s.diagnostic).toHaveBeenCalledWith('mic.context.start.timeout', expect.stringContaining('3000'));
    expect(s.track.stop).toHaveBeenCalledTimes(1);
    resumed.resolve(); await flush();
    expect(s.context.close).toHaveBeenCalledTimes(1);
    expect(s.diagnostic.mock.calls.some(([event]) => event === 'mic.context.start.completed')).toBe(false);
  });

  it('マイク取得後runningなら、取得前のresumeが未完了でも検知用leaseを返す', async () => {
    const s = audio(); s.context.resume.mockReturnValueOnce(new Promise(() => {}));
    const lease = await s.input.acquire();
    expect(s.diagnostic).toHaveBeenCalledWith('mic.context.start.completed', expect.stringContaining('running'));
    await vi.advanceTimersByTimeAsync(settings.audioStartTimeoutMs);
    expect(s.diagnostic.mock.calls.some(([event]) => event === 'mic.context.start.timeout')).toBe(false);
    await lease.release();
  });

  it('runningを確認しRMS測定。検知購読停止後は分析を止め資源は保持できる', async () => {
    const s = audio(); const lease = await s.input.acquire(); const listener = vi.fn();
    const off = lease.subscribe(listener); s.frame();
    expect(listener).toHaveBeenCalledWith({ rms: 0.25, timeMs: 100 });
    expect(s.source.connect).toHaveBeenCalledWith(s.analyser);
    off(); expect(s.environment.cancelFrame).toHaveBeenCalledWith(42); expect(s.track.stop).not.toHaveBeenCalled();
    await lease.release(); expect(s.track.stop).toHaveBeenCalledTimes(1); expect(s.context.close).toHaveBeenCalledTimes(1);
    expect(s.source.disconnect).toHaveBeenCalledTimes(1); await lease.release(); expect(s.track.stop).toHaveBeenCalledTimes(1);
  });

  it('権限拒否でも先行作成Contextを閉じる', async () => {
    const s = audio(); vi.mocked(s.environment.getUserMedia).mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    await expect(s.input.acquire()).rejects.toThrow('denied'); expect(s.context.close).toHaveBeenCalledTimes(1);
  });

  it('resume失敗・suspendedでは取得済みtrackを必ず停止する', async () => {
    const s = audio(); s.context.resume.mockRejectedValueOnce(new Error('resume failed'));
    await expect(s.input.acquire()).rejects.toThrow('resume failed'); expect(s.track.stop).toHaveBeenCalledTimes(1);
    const other = audio(); other.interrupt(); await expect(other.input.acquire()).rejects.toThrow('稼働していません');
    expect(other.track.stop).toHaveBeenCalledTimes(1);
  });

  it('resumeの同期例外でもContextとtrackを回収する', async () => {
    const s = audio(); s.context.resume.mockImplementationOnce(() => { throw new Error('sync resume'); });
    await expect(s.input.acquire()).rejects.toThrow('sync resume'); expect(s.track.stop).toHaveBeenCalledTimes(1);
  });

  it('入力中断を通知し、解放後は中断を通知しない', async () => {
    const s = audio(); const lease = await s.input.acquire(); const interrupted = vi.fn();
    lease.onInterrupted?.(interrupted); s.interrupt(); expect(interrupted).toHaveBeenCalledTimes(1);
    await lease.release(); s.interrupt(); expect(interrupted).toHaveBeenCalledTimes(1);
  });

  it('許可待ち期限超過でContextを閉じ、後から来たstreamも止める', async () => {
    const s = audio(); const pending = deferred<MediaStream>(); vi.mocked(s.environment.getUserMedia).mockReturnValueOnce(pending.promise);
    const acquisition = s.input.acquire(); const assertion = expect(acquisition).rejects.toThrow('期限超過');
    await vi.advanceTimersByTimeAsync(settings.acquireTimeoutMs); await assertion;
    expect(s.context.close).toHaveBeenCalledTimes(1); pending.resolve(s.stream); await flush();
    expect(s.track.stop).toHaveBeenCalledTimes(1); expect(s.diagnostic).toHaveBeenCalledWith('mic.lateStream.stopped');
  });

  it('resume未完了にも期限を設けtrackを回収する', async () => {
    const s = audio(); s.interrupt(); s.context.resume.mockReturnValue(new Promise(() => {}));
    const pending = s.input.acquire(); const assertion = expect(pending).rejects.toThrow('AudioContext起動期限');
    await vi.advanceTimersByTimeAsync(settings.cleanupTimeoutMs); await assertion;
    expect(s.track.stop).toHaveBeenCalledTimes(1);
  });

  it('停止signalはGUM取消を仮定せず、Contextを即時回収して遅着streamも停止する', async () => {
    const s = audio(); const pending = deferred<MediaStream>();
    vi.mocked(s.environment.getUserMedia).mockReturnValueOnce(pending.promise);
    const abort = new AbortController(); const acquisition = s.input.acquire(abort.signal);
    const assertion = expect(acquisition).rejects.toThrow('ブラウザ要求は未取消');
    await flush(); abort.abort(); await assertion;
    expect(s.context.close).toHaveBeenCalledTimes(1);
    pending.resolve(s.stream); await flush(); expect(s.track.stop).toHaveBeenCalledTimes(1);
  });

  it('停止signalがresume待ちでも取得済みtrackを回収する', async () => {
    const s = audio(); s.interrupt(); s.context.resume.mockReturnValue(new Promise(() => {}));
    const abort = new AbortController(); const pending = s.input.acquire(abort.signal);
    const assertion = expect(pending).rejects.toThrow('中止'); await flush(); abort.abort(); await assertion;
    expect(s.track.stop).toHaveBeenCalledTimes(1); expect(s.context.close).toHaveBeenCalledTimes(1);
  });

  it('既に取消済みならContextもGUMも開始しない', async () => {
    const s = audio(); const create = vi.spyOn(s.environment, 'createContext'); const abort = new AbortController(); abort.abort();
    await expect(s.input.acquire(abort.signal)).rejects.toThrow('取消済み');
    expect(create).not.toHaveBeenCalled(); expect(s.environment.getUserMedia).not.toHaveBeenCalled();
  });

  it('分析例外を中断通知し、ノード切断失敗でもContextとtrackを回収する', async () => {
    const s = audio(); const lease = await s.input.acquire(); const interrupted = vi.fn();
    lease.onInterrupted?.(interrupted); lease.subscribe(() => {});
    s.analyser.getFloatTimeDomainData.mockImplementationOnce(() => { throw new Error('analyser failed'); });
    s.frame(); expect(interrupted).toHaveBeenCalledWith(expect.stringContaining('分析エラー'));
    s.source.disconnect.mockImplementationOnce(() => { throw new Error('disconnect failed'); });
    await expect(lease.release()).rejects.toThrow('未完了');
    expect(s.track.stop).toHaveBeenCalledTimes(1); expect(s.context.close).toHaveBeenCalledTimes(1);
    await lease.release();
  });

  it('部分取得の解放失敗はleaseを失わずcontrollerへ引渡す', async () => {
    const s = audio(); s.context.resume.mockRejectedValueOnce(new Error('resume failed'));
    s.context.close.mockRejectedValueOnce(new Error('close failed'));
    let failure: unknown;
    try { await s.input.acquire(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AudioAcquireError);
    await (failure as AudioAcquireError).lease.release(); expect(s.context.close).toHaveBeenCalledTimes(2);
  });

  it('RMSは波形の二乗平均平方根', () => {
    expect(rms(new Float32Array([0.5, -0.5]))).toBe(0.5);
    expect(rms(new Float32Array([0, 0]))).toBe(0);
  });
});

describe('通常プレイヤーの検知時シーク', () => {
  it('公式seekToを使い動画長と現在位置を取得する。シーク自体でplayしない', async () => {
    const s = youtube(); const seekTo = vi.fn();
    Object.assign(s.handle, { seekTo, getDuration: () => 120, getCurrentTime: () => 12.35 });
    await s.prepare(); s.player.seek(12.35);
    expect(seekTo).toHaveBeenCalledExactlyOnceWith(12.35, true);
    expect(s.player.duration()).toBe(120); expect(s.player.position()).toBe(12.35);
    expect(s.handle.playVideo).not.toHaveBeenCalled(); await s.player.dispose(); expect(() => s.player.seek(0)).toThrow('準備');
  });
  it('準備前はシークや観測APIを呼ばない', () => {
    const s = youtube(); expect(() => s.player.seek(0)).toThrow('準備'); expect(() => s.player.duration()).toThrow('準備'); expect(() => s.player.position()).toThrow('準備');
  });
});

describe('YouTubeエラー説明の回帰',()=>{
  it.each([2,5,100,101,150])('onError %sを日本語案内へ変換し既存イベント処理を維持する',async code=>{
    const s=youtube();await s.prepare();s.options().events.onError({data:code});
    expect(s.events.at(-1)).toMatchObject({type:'error'});const event=s.events.at(-1)!;if(event.type==='error'){expect(event.message).toContain('YouTube '+code+':');if(code===101||code===150)expect(event.message).toContain('動画所有者側の設定');}
    await s.player.dispose();expect(s.handle.destroy).toHaveBeenCalledTimes(1);
  });
});
