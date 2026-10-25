import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { AppServices } from '../app/createApp';
import { LiveHistory, liveRecommendation } from '../domain/liveRecommendation';
import { aggregateSessionLogs, latencySummary } from '../diagnostics/latency';
import { settings } from '../config/settings';
import { playbackPlan, selectedTrigger, triggerLabels, adoptThreshold, adjustPosition, adjustEffectiveStart, environments, environmentLabels, type SyncInput } from '../domain/sync';
import { phaseLabels } from '../session/controller';
import { compensationDefaults, type Compensation } from '../youtube-probe/compensation';
import { saveSyncProfile, loadSyncProfile } from '../app/preferences';
import { SongLibrary, emptyLibrary, defaultProfile, setSongProfile, type Library, type Song, type Service } from '../library/model';
import { planAudioSettings } from '../library/audioSettings';
import { selectSong } from '../library/selection';
import { SongLibraryPanel } from './SongLibraryPanel';
import { openPanel } from './navigation';
import { StartTriggerSettings } from './StartTriggerSettings';
import { VolumeMeter } from './VolumeMeter';
import { ManualVideoInput } from './ManualVideoInput';
import { YouTubeErrorHelp } from './YouTubeErrorHelp';
import { ChromeOpen } from './ChromeOpen';
import { PlaybackTime } from './PlaybackTime';
import { CalibrationPanel } from './CalibrationPanel';

export function App({ controller, simulation, mode, setRetainMic, meter, calibration, stopAll }: AppServices) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const logVersion=useSyncExternalStore(controller.log.subscribe, controller.log.getVersion, controller.log.getVersion);
  const trialSnapshot=useMemo(()=>controller.exportTrials(),[controller,logVersion]);
  const latency=useMemo(()=>latencySummary(trialSnapshot.trials),[trialSnapshot]);
  const measurement = useSyncExternalStore(calibration.subscribe, calibration.getSnapshot, calibration.getSnapshot);
  const [audioExpanded, setAudioExpanded] = useState(true);
  const audioSettingsRef = useRef<HTMLDetailsElement>(null);
  useLayoutEffect(() => {
    const expand = () => {
      if (audioSettingsRef.current) audioSettingsRef.current.open = true;
      setAudioExpanded(true);
    };
    expand();
    window.addEventListener('pageshow', expand);
    return () => window.removeEventListener('pageshow', expand);
  }, []);
  const [retainMic, setRetain] = useState(true);
  const [saveMessage, setSaveMessage] = useState('');
  const [historyStatus]=useState(()=>{try{return {store:new LiveHistory(localStorage),error:''};}catch(error){return {store:undefined,error:String(error)};}});
  const emptyResults=useState<ReturnType<LiveHistory['getSnapshot']>>([])[0];
  const results=useSyncExternalStore(historyStatus.store?.subscribe??(()=>()=>{}),historyStatus.store?.getSnapshot??(()=>emptyResults),()=>emptyResults);
  const [historyError,setHistoryError]=useState('');
  const [importedLatency,setImportedLatency]=useState<ReturnType<typeof aggregateSessionLogs>>();
  const [latencyError,setLatencyError]=useState('');const latencyImportId=useRef(0);
  useEffect(()=>{try{const exported=controller.exportTrials();historyStatus.store?.capture(exported.runId,exported.trials);}catch(error){setHistoryError(String(error));}},[controller,historyStatus.store,logVersion,state.liveAdjustmentMs,state.phase]);
  const [libraryStatus] = useState(() => {
    try { return { store: new SongLibrary(localStorage, 3), error: '' }; }
    catch (error) { return { store: undefined, error: String(error) }; }
  });
  const [library, setLibrary] = useState<Library>(() => libraryStatus.store?.snapshot() ?? emptyLibrary());
  const [selectedVideoId, setSelectedVideoId] = useState<string>();
  const [switchingSong, setSwitchingSong] = useState(false);
  const [input, setInput] = useState<SyncInput>({
    videoId: 'dQw4w9WgXcQ', service: 'DAM', savedPositionSec: 0, offsetSec: 0,
    threshold: settings.normalThreshold, durationMs: settings.normalDurationMs,
    playbackMode: mode === 'real' ? 'preplay' : 'legacy', compensation: { ...compensationDefaults }, armedTimeoutMs: settings.defaultArmedTimeoutMs,
  });
  const [audioPlan, setAudioPlan] = useState<ReturnType<typeof planAudioSettings>>();
  const [applyingAudio, setApplyingAudio] = useState(false);
  const active = !state.canPrepare || switchingSong || measurement.busy || applyingAudio || !!audioPlan;
  function libraryChanged(next: Library) {
    setLibrary(next);
    if (selectedVideoId && !next.songs.some(song => song.videoId === selectedVideoId)) {
      setSelectedVideoId(undefined); setInput(defaultProfile('', input.service, mode).input);
    }
  }
  async function chooseSong(song: Song, service: Service = input.service) {
    if (switchingSong) return false;
    setSwitchingSong(true);
    try {
      await calibration.reset();
      if(calibration.getSnapshot().busy) throw new Error('測定資源の回収が未完了です。解放後に再試行してください');
      const profile = await selectSong(controller, song, service, mode, () => loadSyncProfile(localStorage, song.videoId, service, 3));
      setInput(profile.input); setRetain(profile.retainMic); setRetainMic(profile.retainMic); setSelectedVideoId(song.videoId);
      setSaveMessage(`${song.title} / ${environmentLabels[service]}を読み込みました。設定が未保存なら初期値です。変更は保存してください`); return true;
    } catch (error) { setSaveMessage(`曲を変更できません: ${String(error)}`); return false; }
    finally { setSwitchingSong(false); }
  }
  function initialProfiles(videoId: string): Song['profiles'] {
    const profiles: Song['profiles'] = {};
    for (const service of environments) {
      const existing = loadSyncProfile(localStorage, videoId, service, 3);
      if (existing) profiles[service] = existing;
    }
    if (videoId === input.videoId) profiles[input.service] = { input: structuredClone(input), retainMic };
    return profiles;
  }
  function saveCurrentSettings(next: SyncInput = input, nextRetain = retainMic) {
    try {
      if (selectedVideoId) {
        if (!libraryStatus.store) throw new Error('曲リストを読み込めません');
        libraryChanged(libraryStatus.store.commit(setSongProfile(library, selectedVideoId, { input: next, retainMic:nextRetain })));
        setSaveMessage('選択曲・機種の同期設定を曲リストへ保存しました（JSONバックアップ対象）');
      } else { saveSyncProfile(localStorage, { input: next, retainMic }, 3); setSaveMessage('手入力動画・環境の同期設定をv3専用領域へ保存しました。曲登録で曲リストへ引き継げます'); }
      return true;
    } catch (error) { setSaveMessage(`保存できません: ${String(error)}`); return false; }
  }
  function previewAudioSettings() {
    if (active) return;
    try {
      if (!libraryStatus.store) throw new Error('曲リストを読み込めません');
      setAudioPlan(planAudioSettings(library, { threshold: input.threshold, durationMs: input.durationMs },
        (videoId, service) => loadSyncProfile(localStorage, videoId, service, 3)));
      setSaveMessage('');
    } catch (error) { setSaveMessage(`一括適用できません: ${String(error)}`); }
  }
  async function applyAudioSettings() {
    if (!audioPlan || applyingAudio) return;
    setApplyingAudio(true);
    setSaveMessage('音検知設定を適用中…');
    // Allow the busy state to paint before the synchronous, single-key commit.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    try {
      if (!libraryStatus.store) throw new Error('曲リストを読み込めません');
      if (JSON.stringify(libraryStatus.store.snapshot()) !== audioPlan.source) throw new Error('確認中に曲リストが更新されました。内容を確認してやり直してください');
      libraryChanged(libraryStatus.store.commit(audioPlan.library));
      setSaveMessage(`${audioPlan.songCount}曲・${audioPlan.profileCount}件の設定に音検知設定を適用しました。未保存の機種設定は追加していません`);
    } catch (error) { setSaveMessage(`一括適用に失敗しました: ${String(error)}`); }
    finally { setApplyingAudio(false); setAudioPlan(undefined); }
  }
  function numeric(key: 'savedPositionSec' | 'offsetSec' | 'threshold' | 'durationMs', value: string) {
    setInput(previous => ({ ...previous, [key]: value === '' ? NaN : Number(value) }));
  }
  const logs = controller.log.snapshot();
  const compensation = input.compensation ?? compensationDefaults;
  function changeCompensation(patch: Partial<Compensation>) {
    setInput(previous => ({ ...previous, compensation: { ...(previous.compensation ?? compensationDefaults), ...patch } }));
  }
  function stepCompensation(steps: number) {
    const mode = compensation.mode === 'wait' || compensation.mode === 'combined' ? 'combined' : 'position';
    changeCompensation({ mode, offsetMs: Math.max(-86400000, Math.min(86400000, (Number.isFinite(compensation.offsetMs) ? compensation.offsetMs : 0) + steps * settings.positionStepMs)) });
  }

  let effectiveDisplay = '入力値を確認してください';
  try { effectiveDisplay = `${(playbackPlan(input).userPositionMs / 1000).toFixed(3)} 秒`; } catch { /* 不正入力は準備時にも検証 */ }
  function stepEffective(deltaMs: number) {
    try { setInput(adjustEffectiveStart(input, deltaMs)); }
    catch (error) { setSaveMessage(String(error)); }
  }
  const result=[...results].reverse().find(item=>item.input.videoId===input.videoId&&item.input.service===input.service&&selectedTrigger(item.input)===selectedTrigger(input));
  let recommendation:ReturnType<typeof liveRecommendation>|undefined;
  let savedForRecommendation:SyncInput|undefined;
  let savedRetain=retainMic;
  let recommendationError='';
  try {
    if(result){
      const profile=library.songs.find(song=>song.videoId===selectedVideoId)?.profiles[input.service]??loadSyncProfile(localStorage,input.videoId,input.service,3);
      savedForRecommendation=profile?.input??result.input;savedRetain=profile?.retainMic??result.retainMic;
      recommendation=liveRecommendation(result,savedForRecommendation);
    }
  }catch(error){recommendationError=String(error);}
  function adoptResult(){
    if(!result||!recommendation||!savedForRecommendation||switchingSong||measurement.busy||(!state.canPrepare&&state.phase!=='playing'))return;
    try {
      // 未保存の編集や別の操作による保存を黙って失わない。
      const latest=library.songs.find(song=>song.videoId===selectedVideoId)?.profiles[input.service]?.input??loadSyncProfile(localStorage,input.videoId,input.service,3)?.input??result.input;
      if(JSON.stringify(latest)!==JSON.stringify(savedForRecommendation))throw new Error('保存設定が変わりました。再確認してください');
      if(recommendation.remainingMs===0){setSaveMessage('この補正結果は採用済みです');return;}
      if((JSON.stringify(input)!==JSON.stringify(latest)||retainMic!==savedRetain)&&!window.confirm('未保存の画面設定があります。推奨値は保存済み設定（未保存なら試行開始時設定）を基に計算します。置き換えて保存しますか？'))return;
      if(saveCurrentSettings(recommendation.next,savedRetain)){setInput(recommendation.next);setRetain(savedRetain);setRetainMic(savedRetain);controller.log.add(state.generation,'recommendation.applied',JSON.stringify({resultId:result.id,deltaMs:recommendation.remainingMs}));setSaveMessage('推奨値を採用・保存しました。基準位置は維持し、次回準備から反映します');}
    }catch(error){setSaveMessage(String(error));}
  }
  return <main className="karaoke-app">
    <header className="app-header"><h1>SyncLab</h1><span>{mode === 'simulation' ? '模擬モード' : '実接続'}</span></header>
    <p className="session-notice" role="status" aria-live="polite">{state.notice}</p>
    <div className="performance-area">
      <section id="current-song" className="current-song" aria-label="選択中の曲" tabIndex={-1}>
        <div><h2>{library.songs.find(song => song.videoId === selectedVideoId)?.title ?? '手入力の動画'}</h2>
        <p>{library.songs.find(song => song.videoId === selectedVideoId)?.artist || input.videoId || '曲を選択してください'}</p></div>
        <button aria-controls="song-picker" onClick={() => openPanel('song-picker')}>曲を変更</button>
      </section>
      <details id="audio-settings" className="normal-settings tool-panel" ref={audioSettingsRef} open={audioExpanded} onToggle={event => setAudioExpanded(event.currentTarget.open)}><summary>音声検知</summary><div className="panel-body"><fieldset disabled={active}><legend>音検知・設定保存</legend>
        <label>音量しきい値<input type="number" min="0" max="1" step="0.005" value={Number.isNaN(input.threshold) ? '' : input.threshold} onChange={event => numeric('threshold', event.target.value)} /></label>
        <label>継続時間（ms）<input type="number" min="0" max={settings.maxDurationMs} step="10" value={Number.isNaN(input.durationMs) ? '' : input.durationMs} onChange={event => numeric('durationMs', event.target.value)} /></label>
        <div className="actions"><button onClick={() => saveCurrentSettings()}>この曲・機種の設定を保存</button><button onClick={() => {
          try {
            const saved = library.songs.find(song => song.videoId === selectedVideoId)?.profiles[input.service] ?? loadSyncProfile(localStorage, input.videoId, input.service, 3);
            if (!saved) { setSaveMessage('この動画・機種の保存設定はありません'); return; }
            setInput(saved.input); setRetain(saved.retainMic); setRetainMic(saved.retainMic); setSaveMessage('設定を復元しました。次の準備から適用します');
          } catch (error) { setSaveMessage(`復元できません: ${String(error)}`); }
        }}>この動画・機種の設定を復元</button></div>
        <button onClick={previewAudioSettings}>音検知設定を全曲に適用</button>
        <p>検知待機は新規設定で30分。保存済みの期限を優先します。現在: {(input.armedTimeoutMs ?? settings.defaultArmedTimeoutMs) / 1000}秒（変更は開発者向け設定）。</p>
      </fieldset>{audioPlan && <div className="import-preview" role="alertdialog" aria-modal="false" aria-labelledby="audio-apply-title" aria-describedby="audio-apply-description" aria-busy={applyingAudio}>
        <h2 id="audio-apply-title">音検知設定の一括適用</h2>
        <p id="audio-apply-description">現在の音量しきい値{audioPlan.values.threshold}、検知継続時間{audioPlan.values.durationMs}msを保存済みの全曲に適用します。既存の音検知設定は上書きされます。よろしいですか？（対象: {audioPlan.songCount}曲・{audioPlan.profileCount}件）</p>
        <div className="actions"><button autoFocus disabled={applyingAudio} onClick={() => { setAudioPlan(undefined); setSaveMessage('一括適用をキャンセルしました'); }}>キャンセル</button><button disabled={applyingAudio} onClick={() => { void applyAudioSettings(); }}>{applyingAudio ? '適用中…' : '適用'}</button></div>
      </div>}<p role="status" className="save-status">{saveMessage}</p><button aria-controls="calibration-panel" onClick={()=>openPanel('calibration-panel')}>しきい値を測定・提案</button></div></details>
      <div className="service-picker"><fieldset disabled={active}>
        <label>カラオケ機種・利用環境<select value={input.service} onChange={event => {
          const service = event.target.value as Service;
          const song = library.songs.find(item => item.videoId === selectedVideoId);
          if (song) { void chooseSong(song, service); return; }
          try {
            const profile = loadSyncProfile(localStorage, input.videoId, service, 3) ?? defaultProfile(input.videoId, service, mode);
            setInput(profile.input); setRetain(profile.retainMic); setRetainMic(profile.retainMic); setSaveMessage(`${environmentLabels[service]}の保存設定または初期値を読み込みました。未保存の編集は引き継ぎません`);
          } catch (error) { setSaveMessage(String(error)); }
        }}><option value="DAM">DAM</option><option value="JOYSOUND">JOYSOUND</option><option value="HOME">自宅テスト（PC＋スピーカー）</option></select></label>
      </fieldset></div>
      <StartTriggerSettings input={input} disabled={active} onChange={next=>{ if(!active) setInput(next); }} />
      <VolumeMeter meter={meter} threshold={input.threshold} />
    <section className="session-card" aria-labelledby="session-heading"><h2 id="session-heading" className="sr-only">セッション操作</h2>
      <div role="status" aria-live="polite"><strong>{state.phase === 'armed' ? '音検知待機中（'+triggerLabels[selectedTrigger(input)]+'）' : phaseLabels[state.phase]}</strong><p>{state.message}</p><small>セッションのマイク: {state.mic}</small></div>
      {measurement.busy && <p role="status">測定モード: {measurement.message}（すべて停止で中断）</p>}
      {measurement.phase==='error' && <p role="alert">{measurement.message}。測定パネルで確認してください。</p>}
      {state.phase==='error'&&<YouTubeErrorHelp message={state.message} videoId={controller.exportTrials().trials.at(-1)?.input.videoId??input.videoId}/>}
      {state.resourceWarning && <p role="alert">{state.resourceWarning}</p>}
      <div className="session-actions">
        <button className="primary prepare" disabled={active} onClick={() => { setRetainMic(retainMic);void controller.prepare(input); }}>{selectedTrigger(input)==='manual'?'手動開始を準備':'検知を開始'}</button>
        <button className="stop" onClick={() => { void stopAll(); }}>すべてを停止</button>
        {state.phase==='micReady' && <button className="primary" onClick={() => controller.retryMicrophone()}>マイクを起動して検知開始</button>}
        {selectedTrigger(input)==='manual' && <button className="primary" disabled={state.phase!=='manualReady'||measurement.busy} onClick={()=>controller.manualStart()}>この位置から開始</button>}
        {state.canRecoverAcquisition && <button onClick={() => { void controller.recoverPendingAcquisition(); }}>未完了の取得を切り離して復旧</button>}
      </div>
      {state.canRecoverAcquisition && <p>この操作はブラウザの取得要求を取り消しません。旧要求の結果は隔離して回収し、新しい準備を可能にします。復旧回数には上限があります。</p>}
    </section>
      <section className="player-card" aria-label="YouTubeプレイヤー">
        <div id="youtube-host" className="player-host" />
        <PlaybackTime controller={controller} phase={state.phase} />
        <p className="player-hint">{input.playbackMode === 'preplay' ? '準備 → 事前手動再生待ち → YouTube内の▶をタップ' : '従来方式：準備・検知待機中はYouTubeを操作しないでください'}</p>
      </section>
      <nav className="tool-links" aria-label="その他の操作">
        <button aria-controls="song-picker" onClick={()=>openPanel('song-picker')}>曲を選ぶ</button>
        <button aria-controls="settings-panel" onClick={() => openPanel('settings-panel')}>詳細設定</button>
        <button aria-controls="song-management" onClick={() => openPanel('song-management')}>曲管理</button>
        <button aria-controls="diagnostics-panel" onClick={() => openPanel('diagnostics-panel')}>診断ログ</button>
      </nav>
      <details id="correction-panel" className="correction-card" aria-labelledby="correction-heading">
        <summary><h2 id="correction-heading">実効開始位置の調整</h2><output aria-label="実効開始位置" className="effective-position">{effectiveDisplay}</output></summary>
        <div className="panel-body"><small>＋は先へ／−は前へ</small>
        <fieldset disabled={active} className="correction-controls">
          {([5000, 1000, 100, 50, 10] as const).map(step => <div className="position-step" key={step}>
            <button aria-label={`開始位置を${step}ms戻す`} onClick={() => stepEffective(-step)}>−{step / 1000}秒</button>
            <span>{step}ms</span>
            <button aria-label={`開始位置を${step}ms進める`} onClick={() => stepEffective(step)}>＋{step / 1000}秒</button>
          </div>)}
        </fieldset>
        <p>停止後に調整 → 次の検知準備・初回検知時に適用。基準モードでも有効。</p>
        <small>主調整: {input.startAdjustmentMs ?? 0}ms。10ms刻みは同期精度の保証ではありません。</small>
        <p>表示は動画長制限前。負の位置は不足分だけ検知後に待機して0秒から再生。A固定待機とは加算し、動画長の上限は再生要求時に制限します。</p>
        </div>
      </details>
      {(historyStatus.error||historyError)&&<p role="alert">補正結果の記録: {historyStatus.error||historyError}。元データを上書きせず保持します。</p>}
      {result&&recommendation&&recommendation.remainingMs!==0&&result.dismissedTotalMs!==result.totalMs&&<section className="recommendation-card" aria-label="次回の同期調整の提案">
        <h3>次回の同期調整の提案</h3>
        <p>{library.songs.find(song=>song.videoId===result.input.videoId)?.title??result.input.videoId} / {environmentLabels[result.input.service]} / {triggerLabels[selectedTrigger(result.input)]}</p>
        <p>現在の保存設定: {(playbackPlan(savedForRecommendation!).userPositionMs/1000).toFixed(3)}秒（未保存の場合は試行開始時）</p>
        <p>今回の操作合計: {result.totalMs>=0?'＋':''}{(result.totalMs/1000).toFixed(3)}秒 / 未採用分: {recommendation.remainingMs>=0?'＋':''}{recommendation.remainingMs}ms</p>
        <strong>おすすめの開始位置: {(playbackPlan(recommendation.next).userPositionMs/1000).toFixed(3)}秒</strong>
        <p>今回の操作履歴から、次回は{Math.abs(recommendation.remainingMs)}ms{recommendation.remainingMs>0?'進める':'戻す'}候補です。実移動・次回の同期成功を保証しません。</p>
        <div className="actions"><button disabled={switchingSong||measurement.busy||(!state.canPrepare&&state.phase!=='playing')} onClick={adoptResult}>推奨値を適用・保存</button><button onClick={()=>{try{historyStatus.store?.dismiss(result.id);}catch(error){setHistoryError(String(error));}}}>今回は変更しない</button></div>
      </section>}
      {recommendationError&&<p role="alert">推奨値を計算できません: {recommendationError}</p>}
      <section hidden={state.phase!=='playing' && !state.liveAdjustmentMs} className="live-adjustment" aria-label="歌唱中の位置調整">
        <h2>歌唱中の位置調整</h2>
        <div className="actions">{[-1000,-100,-50,50,100,1000].map(ms=><button key={ms} disabled={state.phase!=='playing'} onClick={()=>controller.adjustLive(ms)}>{ms>0?'＋':'−'}{Math.abs(ms)/1000}秒</button>)}</div>
        <p>今回の移動要求合計: {state.liveAdjustmentMs??0}ms（実移動・発音精度は未保証）</p>
        <button disabled={!recommendation?.remainingMs||switchingSong||measurement.busy||(!state.canPrepare&&state.phase!=='playing')} onClick={adoptResult}>今回の調整を次回用に保存</button>
        <button disabled={state.phase!=='playing'} onClick={()=>{
          try {const position=controller.playbackPosition();if(position===undefined)return;const base=playbackPlan(input).userPositionMs-(input.startAdjustmentMs??0);const next={...input,startAdjustmentMs:Math.round(position*1000)-base};if(saveCurrentSettings(next)){setInput(next);setSaveMessage('今合ってる: 現在の動画位置を次回トリガー時の開始位置として保存しました。次回準備から反映します');}}catch(error){setSaveMessage(String(error));}
        }}>今合ってる（現在位置を保存）</button>
        <small>＋は先へ、−は戻す。seek要求だけを行います。途切れ・再バッファリングは実機で確認してください。</small>
      </section>
    </div>
    <div className="tools-area">
      <ChromeOpen />
      <SongLibraryPanel store={libraryStatus.store} library={library} loadError={libraryStatus.error} selected={selectedVideoId}
        active={active} busy={switchingSong || measurement.busy} currentVideoId={input.videoId} initialProfiles={initialProfiles}
        onChanged={libraryChanged} onSelect={chooseSong} onRestored={() => { setSelectedVideoId(undefined); setInput(defaultProfile('', input.service, mode).input); }} />
    <CalibrationPanel calibration={calibration} context={input.videoId+':'+input.service} canAdopt={!active} onAdopt={value=>{
      const context=input.videoId+':'+input.service;
      if(active || calibration.suggestion(context).value!==value) return;
      setInput(previous=>adoptThreshold(previous,value));
      controller.log.add(state.generation,'measurement.adopted',JSON.stringify({context,threshold:value}));
      setSaveMessage('提案しきい値を採用しました。次回準備から適用します。曲・利用環境へ保存してください');
    }} />
    <details id="settings-panel" className="tool-panel"><summary>詳細設定・設定の保存／復元</summary><div className="panel-body">
      <fieldset disabled={active}><legend>準備前に入力</legend>
        <label>再生方式<select value={input.playbackMode ?? 'legacy'} onChange={event => setInput({ ...input, playbackMode: event.target.value as SyncInput['playbackMode'] })}><option value="preplay">事前再生方式（推奨・iPhone向け）</option><option value="legacy">従来方式（事前再生なし・PC比較用）</option></select></label>
        <ManualVideoInput videoId={input.videoId} onApply={videoId=>{
          if(active)return;
          if(videoId===input.videoId){setSaveMessage('同じ動画IDです。現在の同期設定を維持しました');return;}
          if(selectedVideoId){setSelectedVideoId(undefined);setInput(defaultProfile(videoId,input.service,mode).input);setRetain(true);setRetainMic(true);setSaveMessage('曲リスト選択を解除し、新しい動画を確定しました。同期設定は初期値です');}
          else {setInput({...input,videoId});setSaveMessage('手入力動画を確定しました。開始位置・設定を確認してください');}
        }}/>
        <label>開始位置（秒）（登録開始位置）<input type="number" min="0" step="0.05" value={Number.isNaN(input.savedPositionSec) ? '' : input.savedPositionSec} onChange={event => numeric('savedPositionSec', event.target.value)} /></label>

      </fieldset>
      <p>曲選択・機種変更時は未保存の編集を引き継ぎません。必要な調整は先に保存してください。</p>
      <p>開始設定は「検知を開始」時に確定し、検知成立時の初回シークに適用します。歌唱中は別枠の位置調整を利用できます。変更・動画切替は「すべて停止」後に行ってください。</p>
      <details><summary>基準位置と適用タイミングの内訳</summary>{(()=>{try{const plan=playbackPlan(input);return <dl><dt>YouTube基準位置（選択トリガー）</dt><dd>{(selectedTrigger(input)==='vocal'?input.vocalPositionSec??input.savedPositionSec:selectedTrigger(input)==='cue'?input.cuePositionSec??input.savedPositionSec:input.savedPositionSec).toFixed(3)}秒</dd><dt>主調整 / 旧オフセット / B</dt><dd>{input.startAdjustmentMs??0}ms / {input.offsetSec}秒 / {compensation.offsetMs}ms（Bは方式に従う）</dd><dt>安定化待機 / 負位置不足 / 比較A待機</dt><dd>{plan.stabilizationMs}ms / {plan.negativeWaitMs}ms / {plan.fixedWaitMs}ms</dd><dt>予定総待機 / 動画開始候補（動画長制限前）</dt><dd>{plan.waitMs}ms / {plan.seekSec.toFixed(3)}秒</dd><dt>直近試行の実適用位置（API要求値）</dt><dd>{(()=>{const trial=trialSnapshot.trials.at(-1);return trial?.input.videoId===input.videoId&&trial.environment===input.service&&selectedTrigger(trial.input)===selectedTrigger(input)&&trial.seekSec!==undefined?trial.seekSec.toFixed(3)+'秒（実発音未確認）':'未記録';})()}</dd></dl>;}catch{return <p>入力値を確認してください</p>;}})()}</details>
      <p>正の補正は動画の先の位置から開始します。操作刻みは実際の同期精度を保証しません。</p>
    </div></details>
    <details id="developer-settings" className="tool-panel"><summary>開発者向け設定・比較実験</summary><div className="panel-body">
      <div className="actions" aria-label="補助の再生操作">
        <button disabled={!['waiting', 'starting', 'buffering', 'playing'].includes(state.phase)} onClick={() => { void controller.pause(); }}>一時停止</button>
        <button disabled={state.phase !== 'paused' || state.message === '一時停止を確認中'} onClick={() => controller.resume()}>再生</button>
      </div>
      <p>通常の位置調整はメイン画面で行ってください。折りたたんでも保存値・編集中の値は維持されます。</p>
      <fieldset disabled={active}><legend>停止中のみ変更可能</legend>
        <label>安定化待機（ms・比較用）<input type="number" min="0" max="60000" step="1" value={input.stabilizationWaitMs??0} onChange={event=>setInput({...input,stabilizationWaitMs:event.target.valueAsNumber})}/></label>
        <label className="check"><input type="checkbox" checked={input.preseekBeforeDetection??false} onChange={event=>setInput({...input,preseekBeforeDetection:event.target.checked})}/>事前シークを比較する（事前再生方式のみ・実機未検証）</label>
        <p>初期値0ms・事前シーク無効。ばらつき低減は未確認です。安定化待機分だけ動画開始位置を進め、既存の比較A待機は従来どおり位置へ加算しません。待機分の映像・歌唱冒頭を飛ばす可能性があります。</p>
        <label>同期補正方式<select value={compensation.mode} onChange={event => changeCompensation({ mode: event.target.value as Compensation['mode'] })}><option value="baseline">基準</option><option value="wait">A：固定待機</option><option value="position">B：位置補正</option><option value="combined">A＋B：組み合わせ</option></select></label>
        <label>A 固定待機（ms）<input type="number" min="0" max="60000" step="1" value={Number.isNaN(compensation.waitMs) ? '' : compensation.waitMs} onChange={event => changeCompensation({ waitMs: event.target.valueAsNumber })} /></label>
        <details className="tool-panel"><summary>互換設定：既存オフセットと追加比較B</summary><div className="panel-body">
        <label>既存オフセット（秒、開始位置へ加算）<input type="number" min="-30" max="30" step="0.05" value={Number.isNaN(input.offsetSec) ? '' : input.offsetSec} onChange={event => numeric('offsetSec', event.target.value)} /></label>
        <div className="actions"><button onClick={() => setInput({ ...input, offsetSec: adjustPosition(input.offsetSec, -1) })}>既存オフセット −0.05秒</button><button onClick={() => setInput({ ...input, offsetSec: adjustPosition(input.offsetSec, 1) })}>既存オフセット ＋0.05秒</button></div>
        <label>B 追加位置補正（ms、BまたはA＋B時のみ）<input type="number" min="-86400000" max="86400000" step="1" value={Number.isNaN(compensation.offsetMs) ? '' : compensation.offsetMs} onChange={event => changeCompensation({ offsetMs: event.target.valueAsNumber })} /></label>
        <div className="actions"><button aria-label="補正を50ms戻す" onClick={() => stepCompensation(-1)}>比較B −50ms</button><button aria-label="補正を50ms進める" onClick={() => stepCompensation(1)}>比較B ＋50ms</button></div>
        <p>過去データの位置計算を維持する設定です。通常の調整はメイン画面だけで行ってください。同じ補正をここにも重ねて入力しないでください。</p>
        <p>計算: 従来開始位置（開始秒＋既存オフセットを0以上へ制限）＋有効B＋主調整ms。最後に動画範囲へ制限。</p>
        </div></details>
        <label>検知待機期限（秒、継続時間とは別）<input type="number" min="1" max={settings.maxArmedTimeoutMs / 1000} value={(input.armedTimeoutMs ?? settings.defaultArmedTimeoutMs) / 1000} onChange={event => setInput({ ...input, armedTimeoutMs: event.target.valueAsNumber * 1000 })} /></label>
        <label>検知後のマイク資源<select value={retainMic ? 'retain' : 'release'} onChange={event => { const value = event.target.value === 'retain'; setRetain(value); setRetainMic(value); }}><option value="retain">保持（新規設定で推奨・検知は終了）</option><option value="release">解放（比較用）</option></select></label>

      </fieldset>
      <p>期限は1〜1800秒の有限値です。保存済みの期限・マイク保持／解放を優先し、自動上書きしません。期限未指定は30分です。</p>
      <p>保持は今回の実機結果に基づく推奨初期値です。すべてのiPhone・イヤホンに最適とは限りません。保持でも停止・期限切れ時には解放します。</p>
    </div></details>
    {mode === 'simulation' && <details className="tool-panel"><summary>模擬イベント操作</summary><div className="panel-body">
      <p>「模擬音を入力」→「模擬PLAYING」で検知成立と再生確認を別々に試せます。無音・停止・エラーも確認できます。</p>
      <div className="actions">
        <button disabled={state.phase !== 'armed'} onClick={() => simulation.tone()}>模擬持続音（最大2.2秒）</button>
        <button disabled={state.phase !== 'armed'} onClick={() => simulation.sample({ rms: 0.5, timeMs: performance.now() })}>模擬音を入力（1観測）</button>
        <button disabled={state.phase !== 'armed'} onClick={() => simulation.sample({ rms: 0, timeMs: performance.now() })}>模擬無音</button>
        <button disabled={!['starting', 'buffering'].includes(state.phase)} onClick={() => simulation.playerEvent('playing')}>模擬PLAYING</button>
        <button disabled={state.phase !== 'preplay'} onClick={() => simulation.playerEvent('playing')}>模擬事前手動再生</button>
        <button disabled={state.phase !== 'playing'} onClick={() => simulation.playerEvent('ended')}>模擬動画終了</button>
        <button disabled={state.phase !== 'starting'} onClick={() => simulation.playerEvent('blocked')}>模擬再生ブロック</button>
        <button disabled={active} onClick={() => { simulation.denyNext(); void controller.prepare(input); }}>模擬マイク拒否で準備</button>
      </div>
      <p>継続時間が0msより大きい場合、100ms以内の間隔で音の観測を継続する必要があります。0msなら1観測で検知します。</p>
    </div></details>}
    <details id="diagnostics-panel" className="tool-panel"><summary>診断ログ・JSON保存</summary><div className="panel-body">
      <p>単調時計の時刻（ms）。実際のイヤホン発音時刻ではありません。上限による破棄: {controller.log.dropped}件</p>
      <button onClick={() => {
        const blob = new Blob([JSON.stringify({ mode, clock: 'performance.now (ms); audible output not measured', userAgent: navigator.userAgent, origin:window.location.origin, retainMic, input, dropped: controller.log.dropped, entries: logs, triggerTrials:controller.exportTrials(),liveResults:results,latency:latencySummary(controller.exportTrials().trials) }, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a'); link.href = url; link.download = 'karaokesync-stage2a-log.json'; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1_000);
      }}>診断JSONを保存</button>
      <button onClick={()=>{
        const blob=new Blob([JSON.stringify({...controller.exportTrials(),latency:latencySummary(controller.exportTrials().trials),mode,origin:window.location.origin,userAgent:navigator.userAgent,timeOriginMs:performance.timeOrigin},null,2)],{type:'application/json'});
        const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download='karaokesync-trigger-trials.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      }}>開始トリガー比較JSONを保存</button>
      <p>直近30試行の準備時設定とAPI上の結果を保存します。API再生成功は実際のBluetooth発音・同期精度の確認ではありません。</p>
      <details><summary>API遅延の比較統計（現在の最大30試行）</summary><pre className="latency-summary">{JSON.stringify(latency,null,2)}</pre><p>平均・母標準偏差・最小・最大・最大最小差。実発音時刻は含みません。</p></details>
      <label>保存した通常アプリ診断JSONを比較（最大20件・合計10MiB）<input type="file" multiple accept=".json,application/json" onChange={event=>{
        const files=Array.from(event.target.files??[]);event.target.value='';const request=++latencyImportId.current;setLatencyError('');setImportedLatency(undefined);
        void (async()=>{try{if(files.length>20||files.some(file=>file.size>5*1024*1024)||files.reduce((total,file)=>total+file.size,0)>10*1024*1024)throw new Error('20ファイル以内・各5MiB・合計10MiB以内です');const documents=await Promise.all(files.map(async file=>({name:file.name,data:JSON.parse(await file.text()) as unknown})));if(request===latencyImportId.current)setImportedLatency(aggregateSessionLogs(documents));}catch(error){if(request===latencyImportId.current)setLatencyError(String(error));}})();
      }}/></label>{latencyError&&<p role="alert">集計できません: {latencyError}</p>}{importedLatency&&<details open><summary>保存JSONの比較結果（API上のみ）</summary><pre className="latency-summary">{JSON.stringify(importedLatency,null,2)}</pre></details>}
      <details><summary>保持したリアルタイム補正結果（最大30件）</summary><pre className="latency-summary">{JSON.stringify(results,null,2)}</pre><p>次回推奨値の採用履歴は曲設定へ保存します。結果履歴は別キーで、曲バックアップには含みません。診断JSONには含みます。</p></details>
      <div className="logs"><table><caption>直近100件（JSON出力には保持中の全件）</caption><thead><tr><th>時刻</th><th>世代</th><th>イベント</th><th>詳細</th></tr></thead><tbody>{logs.slice(-100).map(entry => <tr key={entry.sequence}><td>{entry.timeMs.toFixed(1)}</td><td>{entry.generation}</td><td>{entry.event}</td><td>{entry.detail}</td></tr>)}</tbody></table></div>
    </div></details>
      <details className="tool-panel"><summary>使い方・音声出力について</summary><div className="panel-body">
        <p>事前再生方式は「検知を開始」→YouTube内を直接タップ→自動一時停止→マイク許可→音検知で自動再開です。待機中の無音を確認してください。</p>
        <p>PLAYINGはAPI上の確認で実発音ではありません。Bluetooth出力先はWebから完全制御できません。無音・音質低下時は停止し、端末の出力先とマイク保持／解放設定を確認してください。</p>
        <p>固定待機でジッターは消えません。操作刻みは同期精度を保証しません。曲・機種変更時に未保存の調整は引き継ぎません。</p>
        {!active && <p><a href={mode === 'real' ? `${import.meta.env.BASE_URL}?mode=simulation` : import.meta.env.BASE_URL}>{mode === 'real' ? '模擬モードへ切替' : '実接続モードへ切替'}</a>（画面設定とログはリセット）</p>}
      </div></details>
    </div>
  </main>;
}

