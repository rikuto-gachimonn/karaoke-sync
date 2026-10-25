import { useEffect, useState, useSyncExternalStore } from 'react';
import { deleteSong, duplicate, libraryLimits, upsertSong, type Library, type Song, type SongLibrary, type Service } from '../library/model';
import { importChoices, mergeImport, parseImport, readLegacyBackup, type ImportChoice, type ImportData } from '../library/backup';
import { prepareSongDraft, DuplicateVideoError } from '../library/songDraft';
import { TitleAutofill } from '../library/titleAutofill';
import { VideoReferenceInput } from './VideoReferenceInput';
import { environments, environmentLabels } from '../domain/sync';

interface Props {
  store?: SongLibrary; library: Library; loadError: string; selected?: string; active: boolean; busy: boolean;
  currentVideoId: string; initialProfiles(videoId: string): Song['profiles'];
  onChanged(library: Library): void; onSelect(song: Song): Promise<void | boolean>;
  onRestored(): void;
}
export function SongLibraryPanel(props: Props) {
  const { store, library, active, busy } = props;
  const [draft, setDraft] = useState({ videoId: props.currentVideoId, title: '', artist: '', accompanimentRef: '' });
  const [titleAutofill]=useState(()=>new TitleAutofill(title=>setDraft(previous=>({...previous,title}))));
  const titleState=useSyncExternalStore(titleAutofill.subscribe,titleAutofill.getSnapshot,titleAutofill.getSnapshot);
  useEffect(()=>()=>titleAutofill.cancel(),[titleAutofill]);
  const [editing, setEditing] = useState<string>();
  const [search, setSearch] = useState('');
  const [sort,setSort]=useState('registered');
  const [message, setMessage] = useState('');
  const [formNotice,setFormNotice]=useState<{text:string;error:boolean}>();
  const [duplicateVideo,setDuplicateVideo]=useState<Song>();
  const [legacyService, setLegacyService] = useState<Service | ''>('');
  const [preview, setPreview] = useState<{ data: ImportData; base: string; choices: ImportChoice[] }>();
  const [reading, setReading] = useState(false);
  const disabled = active || busy || reading || !store;
  const matchingSongs = library.songs.filter(song => `${song.title} ${song.artist} ${song.videoId}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())).sort((a,b)=>sort==='title'?a.title.localeCompare(b.title,'ja'):sort==='artist'?a.artist.localeCompare(b.artist,'ja'):0);
  function showImport(raw: string) {
    const data = parseImport(raw, legacyService || undefined);
    setPreview({ data, base: JSON.stringify(library), choices: importChoices(library, data.library) });
    setMessage('未反映です。追加候補と上書き対象を確認し、最後に「選択内容で復元」を押してください');
  }
  function changeChoice(videoId: string, patch: Partial<ImportChoice>) {
    setPreview(previous => previous && { ...previous, choices: previous.choices.map(choice => choice.videoId === videoId ? { ...choice, ...patch } : choice) });
  }
  return <div className="library-tools">
    {props.loadError && <p role="alert">曲リストを読み込めません: {props.loadError}。保存済みデータは変更していません。再読込して確認してください。</p>}
    <details id="song-picker" className="tool-panel"><summary>曲を選ぶ・検索</summary><div className="panel-body">
      <label>曲を検索<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="曲名・アーティスト・動画ID" /></label>
      <label>並べ替え<select value={sort} onChange={event=>setSort(event.target.value)}><option value="registered">登録順</option><option value="title">曲名順</option><option value="artist">アーティスト順</option></select></label>
      <ul className="song-list compact-song-list">{matchingSongs.map(song => <li key={song.videoId}>
        <button className="song-choice" disabled={busy || reading || !store} aria-pressed={props.selected === song.videoId} aria-label={`この曲を選択: ${song.title} / ${song.artist}`} onClick={() => {
          void props.onSelect(song).then(result => {
            if (result === false) return;
            const panel = document.getElementById('song-picker') as HTMLDetailsElement | null;
            if (panel) panel.open = false;
            const current = document.getElementById('current-song'); current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); current?.focus({ preventScroll: true });
          });
        }}><strong>{song.title}</strong><small>{song.artist || 'アーティスト未入力'}</small></button>
      </li>)}</ul>
      {!library.songs.length && <p>登録曲がありません。「曲管理」で登録してください。</p>}
      {library.songs.length > 0 && !matchingSongs.length && <p>一致する曲がありません。検索語を変更してください。</p>}
      <p className="compact-note">選択すると前の曲を安全に停止します。未保存の調整は引き継ぎません。</p>
    </div></details>
    <details id="song-management" className="tool-panel"><summary>曲管理・登録・バックアップ</summary><div className="panel-body">
    <h2 id="library-heading">曲リスト</h2>
    <p>曲選択は前の曲を停止・解放してから適用します。編集・削除・復元は「すべて停止」後に行ってください。設定変更は自動保存しません。</p>
    <label>曲を検索<input value={search} onChange={event => setSearch(event.target.value)} placeholder="曲名・アーティスト・動画ID" /></label>
    <p>{library.songs.length} / {libraryLimits.songs}曲。選択中: {library.songs.find(song => song.videoId === props.selected)?.title ?? '未選択（手入力）'}</p>
    <ul className="song-list">{library.songs.filter(song => `${song.title} ${song.artist} ${song.videoId}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(song => <li key={song.videoId}>
      <strong>{song.title}</strong> / {song.artist || 'アーティスト未入力'}<br /><small>{song.videoId} · 保存環境: {Object.keys(song.profiles).map(key => environmentLabels[key as Service]).join(' / ') || '未設定'}</small>
      {song.accompanimentRef && <details className="accompaniment-reference"><summary>保存済みPC伴奏の記録（参照用）</summary><p>{song.accompanimentRef}</p></details>}
      <div className="actions"><button disabled={busy || reading || !store} aria-pressed={props.selected === song.videoId} onClick={() => { void props.onSelect(song); }}>この曲を選択</button>
      <button disabled={disabled} onClick={() => { setFormNotice(undefined);setDuplicateVideo(undefined);titleAutofill.reset(song.title,true,song.videoId);setEditing(song.videoId); setDraft({ videoId: song.videoId, title: song.title, artist: song.artist, accompanimentRef: song.accompanimentRef ?? '' }); }}>編集</button>
      <button disabled={disabled} onClick={() => {
        if (!store || !window.confirm(`「${song.title}」とこの曲のDAM/JOYSOUND/自宅テスト設定を削除しますか？ 旧データ・従来の同期設定は削除しません。`)) return;
        try { props.onChanged(store.commit(deleteSong(library, song.videoId))); setMessage('曲を削除しました'); if (editing === song.videoId) {setEditing(undefined);titleAutofill.reset(draft.title,false);} }
        catch (error) { setMessage(String(error)); }
      }}>削除</button></div>
    </li>)}</ul>
    <form onSubmit={event => {
      event.preventDefault(); if (disabled || !store) return;
      try {
        const {song,videoChanged}=prepareSongDraft(library,draft,editing,props.initialProfiles);
        if (videoChanged && !window.confirm('動画IDを変更します。同期設定を引き継ぐため、開始位置を再確認してください。変更しますか？')) return;
        props.onChanged(store.commit(upsertSong(library, song, editing)));
        titleAutofill.reset();setEditing(undefined); setDraft({ title: '', artist: '', videoId: '', accompanimentRef: '' }); setDuplicateVideo(undefined);setFormNotice({text:editing?'曲情報を更新しました':'登録しました',error:false});
        void props.onSelect(song);
      } catch (error) { setDuplicateVideo(error instanceof DuplicateVideoError?error.song:undefined);setFormNotice({text:(error as Error).message,error:true}); }
    }}><fieldset disabled={disabled}><legend>{editing ? '曲情報を編集' : '曲を新規登録'}</legend>
      <label>曲名<input required maxLength={200} value={draft.title} onChange={event => titleAutofill.manual(event.target.value)} /></label>
      <label>アーティスト名<input maxLength={200} value={draft.artist} onChange={event => setDraft({ ...draft, artist: event.target.value })} /></label>
      <div className="url-registration"><VideoReferenceInput action={<button className="register-song" type="submit">{editing ? '曲情報を更新' : 'この曲を登録'}</button>} value={draft.videoId} onChange={videoId=>{setDraft(previous=>({...previous,videoId}));titleAutofill.referenceChanged(videoId);setFormNotice(undefined);setDuplicateVideo(undefined);}} /></div>
      <p role="status" aria-live="polite">{titleState.message}</p>
      <button type="button" disabled={titleState.status==='loading'} onClick={()=>titleAutofill.retry(draft.videoId,message=>window.confirm(message))}>タイトルを再取得</button>
      <small>新規入力時にYouTubeへ動画IDを送ってタイトルを取得します。曲名の手入力を優先し、取得失敗でも登録できます。</small>
      {formNotice&&<p className="registration-notice" role={formNotice.error?'alert':'status'}>{formNotice.text}</p>}
      {duplicateVideo&&<button type="button" onClick={()=>{void props.onSelect(duplicateVideo);}}>登録済みの「{duplicateVideo.title}」を選択</button>}
      <div className="actions"><button type="button" onClick={() => { setFormNotice(undefined);setDuplicateVideo(undefined);titleAutofill.reset();setEditing(undefined); setDraft({ videoId: props.currentVideoId, title: '', artist: '', accompanimentRef: '' }); }}>新規入力に戻す（現在の動画ID）</button></div>
    </fieldset></form>
    <h3>曲リストのバックアップ・復元</h3>
    <button disabled={!store || busy} onClick={() => {
      if (!store) return;
      const url = URL.createObjectURL(new Blob([store.export()], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `karaokesync-library-${Date.now()}.json`; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
    }}>曲リストと保存済み同期設定をJSONで保存</button>
    <p>画面で変更しただけの未保存設定は含みません。先に「この設定を保存」を押してください。</p>
    <fieldset disabled={disabled}><legend>復元の準備（まだ保存しません）</legend>
      <label>旧データの機種未選択設定の移行先<select value={legacyService} onChange={event => setLegacyService(event.target.value as Service | '')}><option value="">未指定（機種未選択データは拒否）</option>{environments.map(service => <option value={service} key={service}>{environmentLabels[service]}</option>)}</select></label>
      <label>JSONファイル（React v4 / v3 / v2 / v1 / 旧HTML 0.6）<input type="file" accept=".json,application/json" onChange={event => {
        const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
        setReading(true); setPreview(undefined);
        void (async () => { try {
          if (file.size > libraryLimits.backupBytes) throw new Error('JSONは5MiB以内にしてください');
          showImport(await file.text());
        } catch (error) { setMessage(`復元できません: ${String(error)}`); } finally { setReading(false); } })();
      }} /></label>
      <button onClick={() => { try { showImport(readLegacyBackup(localStorage)); } catch (error) { setPreview(undefined); setMessage(String(error)); } }}>このオリジンの旧localStorageを読んでプレビュー</button>
    </fieldset>
    {preview && <div className="import-preview"><p>復元時はバックアップに含まれるモードを更新し、含まれない既存モードは保持します。旧設定は対応するモードとして読み込みます。</p><h3>復元プレビュー（{preview.data.source}）</h3>
      {preview.data.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
      {preview.data.library.songs.map(song => {
        const existing = library.songs.find(item => item.videoId === song.videoId);
        const choice = preview.choices.find(item => item.videoId === song.videoId)!;
        const nameConflict = !existing && library.songs.some(item => duplicate(item, song));
        return <fieldset key={song.videoId} disabled={disabled}><legend>{song.title} / {song.artist} / {song.videoId}</legend>
          {!existing ? <label className="check"><input type="checkbox" disabled={nameConflict} checked={choice.add} onChange={event => changeChoice(song.videoId, { add: event.target.checked })} />新規追加候補{nameConflict ? '（同名・同アーティストあり。重複防止のため追加不可）' : ''}</label> : <>
            <label className="check"><input type="checkbox" checked={choice.metadata} onChange={event => changeChoice(song.videoId, { metadata: event.target.checked })} />曲情報を上書き（現在: {existing.title} / {existing.artist}）</label>
            {environments.filter(service => song.profiles[service]).map(service => <label className="check" key={service}><input type="checkbox" checked={choice.profiles[service]} onChange={event => changeChoice(song.videoId, { profiles: { ...choice.profiles, [service]: event.target.checked } })} />{environmentLabels[service]}設定を{existing.profiles[service] ? '上書き' : '追加'}</label>)}
          </>}
          <details><summary>設定の比較</summary><pre>{JSON.stringify({ current: existing ?? null, incoming: song }, null, 2)}</pre></details>
        </fieldset>;
      })}
      <div className="actions"><button disabled={disabled} onClick={() => {
        if (!store) return;
        try {
          if (JSON.stringify(library) !== preview.base) throw new Error('プレビュー後に曲リストが変わりました。読み直してください');
          const merged = mergeImport(library, preview.data.library, preview.choices);
          props.onChanged(store.commit(merged)); props.onRestored(); setPreview(undefined); setMessage('選択内容を一括復元しました。旧データ・従来設定は変更していません。曲を選び直してください');
        } catch (error) { setMessage(`復元できません（既存データは保持）: ${String(error)}`); }
      }}>選択内容で復元（チェックした上書きに同意）</button><button onClick={() => setPreview(undefined)}>復元を取り消す</button></div>
    </div>}
    <p role="status">{message}</p>
    </div></details>
  </div>;
}
