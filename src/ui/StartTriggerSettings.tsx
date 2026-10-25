import { triggerPosition, type SyncInput } from '../domain/sync';
import { detectionModes, detectionModeFor, detectionModeLabels, type DetectionMode } from '../app/detectionModes';
export function StartTriggerSettings({ input, disabled, onChange, onModeChange }: {
  input: SyncInput; disabled: boolean; onChange: (input: SyncInput) => void; onModeChange?: (mode: DetectionMode) => void;
}) {
  const selected = detectionModeFor(input);
  return <div className="trigger-settings" aria-label="検知モード設定"><fieldset disabled={disabled}>
    <label>検知モード<select value={selected} onChange={event => {
      const next = event.target.value as DetectionMode;
      if (onModeChange) onModeChange(next); else onChange({ ...input, startTrigger: next });
    }}>{detectionModes.map(value => <option key={value} value={value}>{detectionModeLabels[value]}</option>)}</select></label>
    <p>{selected === 'vocal' ? '自分の歌い始めを合図にします。' : 'カラオケの伴奏の始まりを合図にします。'}どちらも同じ音量と継続時間の判定です。歌声・音楽・話者を識別しません。</p>
    {input.threshold === 0 && <small>しきい値0では無音（RMS 0）も判定対象です。</small>}
    <label>再生開始位置（秒）<input type="number" min="0" step="0.01" value={Number.isNaN(triggerPosition(input)) ? '' : triggerPosition(input)} onChange={event => {
      const value = event.target.value === '' ? NaN : event.target.valueAsNumber;
      onChange({ ...input, [selected === 'vocal' ? 'vocalPositionSec' : 'savedPositionSec']: value });
    }} /></label>
  </fieldset></div>;
}
