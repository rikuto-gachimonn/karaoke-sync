import { useSyncExternalStore } from 'react';
import type { CalibrationController } from '../calibration/controller';
import type { VolumeSummary } from '../calibration/statistics';
function Summary({name,value}:{name:string;value?:VolumeSummary}) {
  if(!value) return <p>{name}: 未測定</p>;
  return <p>{name}: 中央値 {value.median.toFixed(4)} ／ P10 {value.p10.toFixed(4)} ／ P90 {value.p90.toFixed(4)} ／ 最大 {value.max.toFixed(4)}（{value.count}観測）</p>;
}
export function CalibrationPanel({calibration,context,canAdopt,onAdopt,blocked=false}:{blocked?:boolean;calibration:CalibrationController;context:string;canAdopt:boolean;onAdopt:(value:number)=>void}) {
  const state=useSyncExternalStore(calibration.subscribe,calibration.getSnapshot,calibration.getSnapshot);
  const proposal=calibration.suggestion(context);
  const matches=state.context===context;
  return <details id="calibration-panel" className="tool-panel"><summary>雑音・伴奏の測定としきい値の提案</summary><div className="panel-body">
    <p>測定モードでは通常の再生・音検知を停止します。YouTubeの自動再生はしません。画面を表示したまま測定してください。</p>
    <p data-help>① 伴奏を止め、静かにして雑音を4秒測定 → ② PCまたはカラオケ機器で曲の冒頭の小さい音を流し、伴奏を4秒測定。</p>
    <div className="actions">
      <button disabled={state.busy || blocked} onClick={()=>{void calibration.start('noise',context);}}>雑音を4秒測定（伴奏を止める）</button>
      <button disabled={state.busy || blocked} onClick={()=>{void calibration.start('music',context);}}>伴奏を4秒測定</button>
      <button disabled={!state.busy} onClick={()=>{void calibration.cancel();}}>測定を中断</button>
      {state.phase==='error'&&state.busy&&<button onClick={()=>{void calibration.retryRelease();}}>マイク解放を再試行</button>}
    </div>
    <p role="status">測定モード: {state.phase} ／ {state.message}</p>
    <Summary name="雑音" value={matches?state.noise:undefined}/><Summary name="伴奏" value={matches?state.music:undefined}/>
    <p>{proposal.reason}</p>
    {proposal.value!==undefined && <p>候補RMS: <strong>{proposal.value.toFixed(6)}</strong> <button disabled={!canAdopt||state.busy} onClick={()=>onAdopt(proposal.value!)}>この値を採用</button></p>}
    <p>提案だけでは設定を変えません。採用後も曲・利用環境の「設定を保存」が必要です。音量分布による推定であり、検知成功や同期精度を保証しません。</p>
    <p>マイクの取得・解放でBluetoothの音声経路が変わる場合があります。測定後に通常の事前再生をやり直し、入力元・実際の出力先・音質を確認してください。生音声は保存しません。</p>
  </div></details>;
}
