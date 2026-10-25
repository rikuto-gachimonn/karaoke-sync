import { playbackPlan, positionComponentsMs, type SyncInput } from '../domain/sync';

const seconds = new Intl.NumberFormat('en-US', { useGrouping: false, minimumFractionDigits: 2, maximumFractionDigits: 20 });
/** Display only. Preserve fractional input precision; never write a formatted value to storage. */
export function formatPositionSeconds(value: number): string {
  return Number.isFinite(value) ? seconds.format(value) : '';
}
const signed = (value: number) => `${value < 0 ? '−' : '＋'}${formatPositionSeconds(Math.abs(value))}`;

export function StartPositionSummary({ input }: { input: SyncInput }) {
  let plan: ReturnType<typeof playbackPlan>;
  let bMs: number;
  try { plan = playbackPlan(input); bMs = positionComponentsMs(input).bMs; }
  catch { return <p role="status">開始位置の入力値を確認してください。</p>; }
  return <section className="start-position-summary" aria-label="開始位置と補正の表示">
    <dl>
      <dt>検知継続時間による自動補正</dt>
      <dd><output aria-label="検知継続時間の自動補正量">{input.autoCompensateDetectionDuration === true ? `${signed(plan.detectionMs / 1000)}秒（${plan.detectionMs}ms）` : '自動補正：OFF（＋0.00秒）'}</output></dd>
      <dd className="position-explanation">{input.autoCompensateDetectionDuration === true ? '検知が成立するまでの設定時間分、開始候補を進めます。実測した遅延ではありません。' : '検知継続時間は開始候補に加算しません。'}</dd>
      <dt>手動補正（主調整）</dt>
      <dd><output aria-label="手動補正量">{signed((input.startAdjustmentMs ?? 0) / 1000)} 秒</output></dd>
      <dt>補正後の再生開始位置</dt>
      <dd className="start-position-result"><output aria-label="補正後の再生開始候補">{formatPositionSeconds(plan.seekSec)} 秒</output></dd>
    </dl>
    <small>YouTube APIへ要求する開始候補です（動画長による上限制限前）。Bluetoothイヤホンの実発音時刻を保証する値ではありません。</small>
    <details className="start-position-breakdown"><summary>その他の補正・待機の内訳</summary><dl>
      <dt>旧オフセット（位置に加算）</dt><dd>{signed(Math.round(input.offsetSec * 1000) / 1000)} 秒</dd>
      <dt>追加比較補正B（有効な分だけ加算）</dt><dd>{signed(bMs / 1000)} 秒</dd>
      <dt>安定化待機（位置にも加算）</dt><dd>{formatPositionSeconds(plan.stabilizationMs / 1000)} 秒</dd>
      <dt>比較固定待機A（位置には加算しない）</dt><dd>{formatPositionSeconds(plan.fixedWaitMs / 1000)} 秒</dd>
      <dt>負の開始位置を補う追加待機</dt><dd>{formatPositionSeconds(plan.negativeWaitMs / 1000)} 秒</dd>
      <dt>検知成立後の予定総待機</dt><dd>{formatPositionSeconds(plan.waitMs / 1000)} 秒</dd>
    </dl><small>開始候補の下限は0秒です。上限は動画長が分かった再生要求時に制限します。保存した歌い始め位置は変更しません。</small></details>
  </section>;
}
