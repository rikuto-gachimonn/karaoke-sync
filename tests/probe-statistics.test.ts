import { describe, expect, it } from 'vitest';
import { aggregateTrials, statistics } from '../src/youtube-probe/statistics';

function trial(index: number, values = [10, 110, 100], extras: Record<string, unknown> = {}) {
  return { schema: 'karaokesync-youtube-probe-v1', environment: { userAgent: 'test Safari', origin: 'https://lan' },
    run: { id: index, startedMs: index * 1000, condition: 'mic-compensation', videoId: 'M7lc1UVf-VE', dropped: 0,
      compensation: { effective: { mode: 'wait', waitMs: 10, offsetMs: 0 } },
      entries: [{ wallTime: `trial-${index}`, event: 'trial.start' }],
      mic: { options: { startSec: 10, threshold: 0.08, durationMs: 50, retainMic: true, waitTimeoutMs: 180000 },
        initialOutcome: 'playing', requestAfterDetectedMs: values[0], playingAfterDetectedMs: values[1], playingAfterRequestMs: values[2] }, ...extras } };
}
describe('補正実験統計', () => {
  it('中央値、nearest-rank p95、最大、母標準偏差を算出する', () => {
    const result = statistics([400, 100, 300, 200])!;
    expect(result).toMatchObject({ n: 4, median: 250, p95: 400, max: 400 });
    expect(result.standardDeviation).toBeCloseTo(111.803398875);
    expect(statistics(Array.from({ length: 20 }, (_, i) => i + 1))).toMatchObject({ median: 10.5, p95: 19, max: 20 });
    expect(statistics([5])).toMatchObject({ n: 1, median: 5, p95: 5, max: 5, standardDeviation: 0 });
    expect(statistics([])).toBeNull();
  });
  it('成功試行の3遅延を方式別に集計し少数標本に警告する', () => {
    const result = aggregateTrials([1, 2, 3].map(index => ({ name: `${index}`, data: trial(index, [10, index * 100 + 10, index * 100]) })));
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({ total: 3, incompleteOrFailed: 0, detectToRequestMs: { median: 10 }, detectToPlayingMs: { median: 210 }, requestToPlayingMs: { median: 200 } });
    expect(result.groups[0]?.warning).toContain('20未満');
  });
  it('重複保存と不正JSONを報告し、欠落・失敗を0ms成功にしない', () => {
    const incomplete = trial(2); incomplete.run.mic.initialOutcome = 'interrupted';
    const result = aggregateTrials([{ name: 'ok', data: trial(1) }, { name: 'duplicate', data: trial(1) }, { name: 'failure', data: incomplete }, { name: 'dropped', data: trial(3, [1, 2, 1], { dropped: 2 }) }, { name: 'invalid', data: null }]);
    expect(result.rejected).toHaveLength(2); expect(result.groups[0]).toMatchObject({ total: 3, incompleteOrFailed: 2, detectToPlayingMs: { n: 1 } });
  });
  it('マイク保持、補正量、端末、曲設定が違う試行を混ぜない', () => {
    const changed = trial(2); changed.run.mic.options.retainMic = false;
    const offset = trial(3); offset.run.compensation.effective.offsetMs = 100;
    const browser = trial(4); browser.environment.userAgent = 'Edge';
    const mode = trial(5); mode.run.compensation.effective.mode = 'position';
    const threshold = trial(6); threshold.run.mic.options.threshold = 0.5;
    expect(aggregateTrials([trial(1), changed, offset, browser, mode, threshold].map((data, i) => ({ name: `${i}`, data }))).groups).toHaveLength(6);
  });
  it('旧形式の不足指標や負の遅延は不完全として扱い、解放失敗も計数する', () => {
    const missing = trial(1); delete (missing.run.mic as Partial<typeof missing.run.mic>).requestAfterDetectedMs;
    const cleanup = trial(2); cleanup.run.entries.push({ wallTime: 'error', event: 'mic.release.error' });
    const result = aggregateTrials([{ name: 'missing', data: missing }, { name: 'negative', data: trial(3, [-1, 2, 3]) }, { name: 'cleanup', data: cleanup }]);
    expect(result.groups[0]).toMatchObject({ total: 3, incompleteOrFailed: 2, cleanupErrors: 1, detectToPlayingMs: { n: 1 } });
  });
});
