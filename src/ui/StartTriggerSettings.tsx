import { selectedTrigger, startTriggers, triggerLabels, triggerDescriptions, type SyncInput, type StartTrigger } from '../domain/sync';
export function StartTriggerSettings({input,disabled,onChange}:{input:SyncInput;disabled:boolean;onChange:(input:SyncInput)=>void}) {
  const trigger=selectedTrigger(input);
  const key=trigger==='vocal'?'vocalPositionSec':trigger==='cue'?'cuePositionSec':undefined;
  return <section className="trigger-settings" aria-label="開始トリガー設定"><fieldset disabled={disabled}>
    <label>開始トリガー<select value={trigger} onChange={event=>onChange({...input,startTrigger:event.target.value as StartTrigger})}>
      {startTriggers.map(value=><option key={value} value={value}>{triggerLabels[value]}</option>)}
    </select></label>
    <p>{triggerDescriptions[trigger]}</p>
    {key && <label>{trigger==='vocal'?'本人動画の歌い出し位置':'発声合図に対応する動画開始位置'}（秒）<input type="number" min="0" step="0.01" placeholder="未指定なら登録開始位置" value={input[key]===undefined||Number.isNaN(input[key])?'':input[key]} onChange={event=>onChange({...input,[key]:event.target.value===''?undefined:event.target.valueAsNumber})}/></label>}
  </fieldset>
  <small>変更は「すべて停止」後。各開始位置は別に保持し、既存オフセット・有効B補正・4段階の主調整は全方式で共通に加算します。</small>
  {(trigger==='vocal'||trigger==='cue')&&<p>既存のしきい値提案は雑音・伴奏の比較です。声の識別機能ではなく、声の合図に適した値かは実際に確認してください。</p>}
  {trigger==='manual'&&<p>マイクなしのため、RMS方式とBluetooth音声経路が異なる可能性があります。実際の出力先を確認してください。</p>}
  </section>;
}
