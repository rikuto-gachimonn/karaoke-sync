import { latencySummary } from '../diagnostics/latency';
import type { LogEntry } from '../diagnostics/log';
import type { LiveHistory } from '../domain/liveRecommendation';
import type { SyncInput } from '../domain/sync';
import type { SessionController } from '../session/controller';

/** Preserve the normal diagnostic document; dedicated trial metadata remains nested. */
export function diagnosticDocument(value: {
  mode: string; userAgent: string; origin: string; timeOriginMs: number;
  retainMic: boolean; input: SyncInput; dropped: number; entries: readonly LogEntry[];
  triggerTrials: ReturnType<SessionController['exportTrials']>;
  liveResults: ReturnType<LiveHistory['getSnapshot']>;
}) {
  return { ...value, clock: 'performance.now (ms); audible output not measured', latency: latencySummary(value.triggerTrials.trials) };
}
