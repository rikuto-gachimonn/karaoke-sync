import { useEffect, useRef, useState } from 'react';
import { triggerPosition, type SyncInput } from '../domain/sync';
import { detectionModeFor } from '../app/detectionModes';
import { formatPositionSeconds } from './StartPositionSummary';
export function SingingPositionInput({input, disabled, onChange}:{input:SyncInput;disabled:boolean;onChange:(input:SyncInput)=>void}) {
  const selected = detectionModeFor(input);
  const basePosition = triggerPosition(input);
  const editingPosition = useRef(false);
  const [positionDraft, setPositionDraft] = useState(() => formatPositionSeconds(basePosition));
  useEffect(() => {
    if (!editingPosition.current) setPositionDraft(formatPositionSeconds(basePosition));
  }, [basePosition, selected, input.videoId, input.service]);
  return <fieldset className="singing-position-input" disabled={disabled}>
    <label>YouTubeの歌い始め位置（秒）<input type="number" min="0" step="0.01" value={positionDraft} onFocus={() => { editingPosition.current = true; }} onBlur={() => { editingPosition.current = false; setPositionDraft(formatPositionSeconds(basePosition)); }} onChange={event => {
      setPositionDraft(event.target.value);
      const value = event.target.value === '' ? NaN : event.target.valueAsNumber;
      onChange({ ...input, [selected === 'vocal' ? 'vocalPositionSec' : 'savedPositionSec']: value });
    }} /></label>
    <small>YouTube動画で実際に歌い始める時刻を入力してください。自動補正はこの入力値を書き換えません。</small>
  </fieldset>;
}
