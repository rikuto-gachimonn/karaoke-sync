export function statistics(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const middle = Math.floor(sorted.length / 2);
  return { n: sorted.length, median: sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!, max: sorted.at(-1)!,
    standardDeviation: Math.sqrt(sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / sorted.length) };
}
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
export function aggregateTrials(documents: { name: string; data: unknown }[]) {
  const rejected: { name: string; reason: string }[] = [];
  const groups = new Map<string, { total: number; incomplete: number; cleanupErrors: number; detectToRequest: number[]; detectToPlaying: number[]; requestToPlaying: number[] }>();
  const seen = new Set<string>();
  for (const { name, data } of documents) {
    const document = object(data); const run = object(document?.run); const mic = object(run?.mic);
    const options = object(mic?.options); const environment = object(document?.environment);
    if (document?.schema !== 'karaokesync-youtube-probe-v1' || !run || !mic || !options || !['mic-resume', 'mic-compensation'].includes(String(run.condition))) {
      rejected.push({ name, reason: '条件⑥⑦の診断JSONではありません' }); continue;
    }
    const entries = Array.isArray(run.entries) ? run.entries : [];
    const first = object(entries[0]);
    const identity = JSON.stringify([environment?.origin, environment?.userAgent, run.id, run.startedMs, first?.wallTime]);
    if (seen.has(identity)) { rejected.push({ name, reason: '同じ試行の重複保存' }); continue; }
    seen.add(identity);
    const compensation = object(run.compensation); const effective = object(compensation?.effective);
    if (run.condition === 'mic-compensation' && (!effective || !['baseline', 'wait', 'position', 'combined'].includes(String(effective.mode)) || !finite(effective.waitMs) || !finite(effective.offsetMs))) {
      rejected.push({ name, reason: '補正設定が不正' }); continue;
    }
    const key = JSON.stringify({ condition: run.condition, mode: effective?.mode ?? 'baseline', waitMs: effective?.waitMs ?? 0,
      offsetMs: effective?.offsetMs ?? 0, retainMic: options.retainMic, videoId: run.videoId, startSec: options.startSec,
      threshold: options.threshold, durationMs: options.durationMs, waitTimeoutMs: options.waitTimeoutMs,
      userAgent: environment?.userAgent ?? 'unknown', origin: environment?.origin ?? 'unknown' });
    let group = groups.get(key);
    if (!group) { group = { total: 0, incomplete: 0, cleanupErrors: 0, detectToRequest: [], detectToPlaying: [], requestToPlaying: [] }; groups.set(key, group); }
    group.total++;
    if (entries.some(e => object(e)?.event === 'mic.release.error')) group.cleanupErrors++;
    const metrics = [mic.requestAfterDetectedMs, mic.playingAfterDetectedMs, mic.playingAfterRequestMs];
    if (run.dropped !== 0 || mic.initialOutcome !== 'playing' || !metrics.every(value => finite(value) && value >= 0)) { group.incomplete++; continue; }
    group.detectToRequest.push(metrics[0] as number); group.detectToPlaying.push(metrics[1] as number); group.requestToPlaying.push(metrics[2] as number);
  }
  return { note: 'APIイベントの観測値のみ。固定待機でジッターは消えず、位置補正の音声同期効果は判定できません。p95はnearest-rank、標準偏差は母標準偏差（nで除算）。端末の実音声経路・実発音・試験順序は観察メモと合わせて別途比較してください。',
    rejected, groups: [...groups].map(([key, group]) => ({ configuration: JSON.parse(key), total: group.total,
      incompleteOrFailed: group.incomplete, cleanupErrors: group.cleanupErrors,
      warning: group.detectToPlaying.length < 20 ? '有効試行20未満：探索的参考値。特にp95は不安定で、少数では最大値と一致します。' : '20以上でも精度保証なし。p95・ばらつきはより多くの反復と同一実機条件で確認してください。',
      detectToRequestMs: statistics(group.detectToRequest), detectToPlayingMs: statistics(group.detectToPlaying), requestToPlayingMs: statistics(group.requestToPlaying) })) };
}
