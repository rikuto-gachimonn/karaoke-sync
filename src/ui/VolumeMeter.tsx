import { useEffect, useState, useSyncExternalStore } from 'react';
import { settings } from '../config/settings';
import { meterPercent, type MeteredAudioInput } from '../calibration/meter';
export function VolumeMeter({meter,threshold}:{meter:MeteredAudioInput;threshold:number}) {
  const state=useSyncExternalStore(meter.subscribe,meter.getSnapshot,meter.getSnapshot);
  const [now,setNow]=useState(()=>performance.now());
  useEffect(()=>{ if(!state.active) return; const timer=setInterval(()=>setNow(performance.now()),500);return ()=>clearInterval(timer); },[state.active]);
  const current=state.active && state.lastSampleMs!==undefined && now-state.lastSampleMs<settings.meterStaleMs;
  return <section className="volume-meter" aria-label="マイク音量メーター">
    <h3>マイク音量</h3>
    <p>{!state.active?'未測定（マイク入力なし）':!current?'入力の観測待ち／中断中':'入力を測定中'}</p>
    {current && <>
      <div className="rms-scale" role="meter" aria-label="現在のRMS音量" aria-valuemin={0} aria-valuemax={1} aria-valuenow={state.rms}>
        <span className="rms-fill" style={{width:meterPercent(state.rms)+'%'}} />
        {Number.isFinite(threshold)&&<span className="rms-threshold" style={{left:meterPercent(threshold)+'%'}} />}
      </div>
      <output>現在RMS {state.rms.toFixed(4)} ／ しきい値 {Number.isFinite(threshold)?threshold.toFixed(4):'未設定'}</output>
    </>}
    <details className="meter-details"><summary>入力元・音量表示の詳細</summary>
    <small>共通のRMS 0〜1。表示幅は平方根尺度で小音量を拡大。縦線はしきい値です。</small>
    <p>入力元（ブラウザ報告名）: {state.active?state.input:'不明（未取得）'}</p>
    <small>報告名だけで本体／イヤホンを断定できません。Bluetoothの出力先・音質は端末で確認してください。</small></details>
  </section>;
}
