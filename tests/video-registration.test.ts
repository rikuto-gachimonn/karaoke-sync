import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseVideoReference } from '../src/youtube/videoReference';
import { prepareSongDraft, DuplicateVideoError } from '../src/library/songDraft';
import { defaultProfile, emptyLibrary, upsertSong, SongLibrary } from '../src/library/model';
import { parseImport } from '../src/library/backup';
import { youtubeErrorMessage } from '../src/youtube/errors';
import { YouTubeErrorHelp } from '../src/ui/YouTubeErrorHelp';
import { ManualVideoInput } from '../src/ui/ManualVideoInput';
import { VideoReferenceInput } from '../src/ui/VideoReferenceInput';
import { App } from '../src/ui/App';
import { createApp } from '../src/app/createApp';
const id='wVYBpKEVLxQ';
const draft={videoId:id,title:'登録曲',artist:'歌手',accompanimentRef:''};
const item=()=>({...draft,profiles:{DAM:defaultProfile(id,'DAM'),JOYSOUND:defaultProfile(id,'JOYSOUND'),HOME:defaultProfile(id,'HOME')}});
const formats=[id,' https://youtu.be/'+id+'?si=xxxxx ', 'https://www.youtube.com/watch?v='+id+'&list=PLsample&index=2&t=30','https://m.youtube.com/watch?v='+id,'https://www.youtube.com/embed/'+id,'https://www.youtube.com/shorts/'+id,'https://www.youtube.com/live/'+id,'https://youtube.com/watch?list=PLtest&v='+id];
afterEach(()=>vi.unstubAllGlobals());
describe('YouTube URLの厳密な正規化',()=>{
  it.each(formats)('%sから同じ11文字IDを得る',value=>expect(parseVideoReference(value)).toBe(id));
  it.each(['','short','wVYBpKEVLx!','https://evil.test/watch?v='+id,'https://www.youtube.com.evil.test/watch?v='+id,'https://youtube.com@evil.test/watch?v='+id,'https://evil.test@youtube.com/watch?v='+id,'https://youtube.com:8443/watch?v='+id,'javascript:alert(1)','ftp://youtube.com/watch?v='+id,'https://youtube.com/playlist?list=PLtest','https://youtube.com/watch?v=short','https://youtube.com/watch?v='+id+'&v=dQw4w9WgXcQ','https://youtu.be/'+id+'/extra','https://youtube.com/redirect?q=https://youtu.be/'+id,'https://youtubе.com/watch?v='+id])('不正入力%sを拒否する',value=>expect(()=>parseVideoReference(value)).toThrow());
  it('抽出IDを表示するが実在・埋め込み可否は保証しない',()=>{
    const html=renderToStaticMarkup(createElement(VideoReferenceInput,{value:formats[2]!,onChange:vi.fn()}));expect(html).toContain('確認した動画ID: '+id);expect(html).toContain('実在・再生・埋め込み可否は保証しません');expect(html).toContain('aria-invalid="false"');
  });
  it('不正URLを入力エラーとして日本語表示する',()=>{const html=renderToStaticMarkup(createElement(VideoReferenceInput,{value:'https://evil.test/watch?v='+id,onChange:vi.fn()}));expect(html).toContain('aria-invalid="true"');expect(html).toContain('YouTube公式ホスト');});
});
describe('新規登録・編集・重複通知',()=>{
  it('URLをIDへ正規化し登録用プロファイルにもIDだけを渡す',()=>{
    const initial=vi.fn(()=>({}));const {song,videoChanged}=prepareSongDraft(emptyLibrary(),{...draft,videoId:formats[2]!},undefined,initial);expect(song.videoId).toBe(id);expect(initial).toHaveBeenCalledExactlyOnceWith(id);expect(videoChanged).toBe(false);
  });
  it('曲名を変えた同一動画でも登録前に登録済み曲名を通知する',()=>{
    const library=upsertSong(emptyLibrary(),item());const before=structuredClone(library);const initial=vi.fn();let failure:unknown;
    try{prepareSongDraft(library,{...draft,title:'違う曲名',videoId:'https://youtu.be/'+id},undefined,initial);}catch(error){failure=error;}
    expect(failure).toBeInstanceOf(DuplicateVideoError);expect((failure as Error).message).toContain('このYouTube動画はすでに登録されています');expect((failure as Error).message).toContain('登録曲');expect(initial).not.toHaveBeenCalled();expect(library).toEqual(before);
  });
  it('既存曲の同一ID編集は新規重複と取り違えず各環境設定を維持する',()=>{
    const old=item();old.profiles.HOME.input.startTrigger='cue';old.profiles.HOME.input.cuePositionSec=20;old.profiles.HOME.input.startAdjustmentMs=50;
    const library=upsertSong(emptyLibrary(),old);const result=prepareSongDraft(library,{...draft,title:'変更後',videoId:'https://www.youtube.com/live/'+id},id,vi.fn());expect(result.videoChanged).toBe(false);expect(result.song.profiles).toEqual(old.profiles);expect(upsertSong(library,result.song,id).songs).toHaveLength(1);
  });
  it('動画を別IDへ変更した編集は設定の帰属だけを変更し開始位置を保持する',()=>{
    const library=upsertSong(emptyLibrary(),item());const result=prepareSongDraft(library,{...draft,videoId:'https://youtu.be/dQw4w9WgXcQ'},id,vi.fn());expect(result.videoChanged).toBe(true);for(const profile of Object.values(result.song.profiles))expect(profile.input.videoId).toBe('dQw4w9WgXcQ');expect(upsertSong(library,result.song,id).songs).toHaveLength(1);
  });
  it('編集先が他の登録動画なら上書きせず拒否する',()=>{const library=upsertSong(upsertSong(emptyLibrary(),item()),{videoId:'dQw4w9WgXcQ',title:'別曲',artist:'',profiles:{}});expect(()=>prepareSongDraft(library,{...draft,videoId:'https://youtu.be/dQw4w9WgXcQ'},id,vi.fn())).toThrow('すでに登録');});
  it('編集対象消失を新規作成に変更しない',()=>expect(()=>prepareSongDraft(emptyLibrary(),draft,id,vi.fn())).toThrow('編集対象'));
  it('不正URLでは保存候補・プロファイルを作らない',()=>{const initial=vi.fn();expect(()=>prepareSongDraft(emptyLibrary(),{...draft,videoId:'bad'},undefined,initial)).toThrow();expect(initial).not.toHaveBeenCalled();});
  it('保存・JSON復元形式にURL文字列や新フィールドを追加しない',()=>{
    const data=new Map<string,string>();const store=new SongLibrary({getItem:key=>data.get(key)??null,setItem:(key,value)=>{data.set(key,value);}},3);
    const {song}=prepareSongDraft(emptyLibrary(),{...draft,videoId:formats[2]!},undefined,()=>item().profiles);store.commit(upsertSong(store.snapshot(),song));const restored=parseImport(store.export());expect(restored.library.songs[0]!.videoId).toBe(id);expect(store.export()).not.toContain('youtu.be');expect(restored.library.songs[0]!.profiles.HOME).toEqual(item().profiles.HOME);
  });
});
describe('YouTubeエラーの説明とリンク',()=>{
  it.each([2,5,100,101,150,153])('エラー%sでIDと元動画・次の操作を表示する',code=>{
    const message=youtubeErrorMessage(code);const html=renderToStaticMarkup(createElement(YouTubeErrorHelp,{message,videoId:id}));expect(message).toContain('YouTube '+code+':');expect(html).toContain('https://www.youtube.com/watch?v='+id);expect(html).toContain('すべて停止');expect(html).toContain('埋め込み再生は保証されません');
    if(code===101||code===150)expect(html).toContain('動画所有者側の設定');expect(html).not.toContain('Netlifyの不具合です');
  });
  it('非YouTubeエラーに別原因の説明を付けない',()=>expect(renderToStaticMarkup(createElement(YouTubeErrorHelp,{message:'マイク拒否',videoId:id}))).toBe(''));
  it('不正IDを外部リンクへ出さない',()=>{const html=renderToStaticMarkup(createElement(YouTubeErrorHelp,{message:youtubeErrorMessage(150),videoId:'<script>'}));expect(html).not.toContain('href=');expect(html).toContain('&lt;script&gt;');});
});
describe('簡素化したメイン画面',()=>{
  function render(){vi.stubGlobal('localStorage',{getItem:()=>null,setItem:vi.fn()});return renderToStaticMarkup(createElement(App,createApp('real')));}
  it('開始前は準備と停止を表示し一時停止・再生の重複を置かない',()=>{
    const html=render();const start=html.indexOf('class="session-card"');const session=html.slice(start,html.indexOf('</section>',start));expect(session).toContain('検知を開始');expect(session).toContain('すべてを停止');expect(session).not.toContain('>一時停止</button>');expect(session).not.toContain('>再生</button>');const dev=html.slice(html.indexOf('id="developer-settings"'));expect(dev).not.toContain('>一時停止</button>');expect(dev).not.toContain('>再生</button>');expect(html.match(/id="youtube-host"/g)).toHaveLength(1);expect(html).toContain('YouTube内の▶をタップ');
  });
  it('調整は初期収納しサマリーの現在値と4段階の入力を同じDOMに保持する',()=>{
    const html=render();const panel=html.match(/<details id="correction-panel"[^>]*>/)![0];expect(panel).not.toMatch(/\bopen(?:=|\s|>)/);const start=html.indexOf('id="correction-panel"');const summary=html.slice(start,html.indexOf('</summary>',start));expect(summary).toContain('実効開始位置の調整');expect(summary).toContain('0.200 秒');for(const step of [5000,1000,100,10])expect(html).toContain('開始位置を'+step+'ms進める');expect(localStorage.setItem).not.toHaveBeenCalled();
  });
  it('音声検知設定を優先し、曲選択・管理への導線は動画直後、補正欄より前に置く',()=>{const html=render();const nav=html.indexOf('class="tool-links"');expect(nav).toBeLessThan(html.indexOf('id="correction-panel"'));expect(html.indexOf('id="audio-settings"')).toBeLessThan(nav);expect(html).toContain('aria-controls="song-picker"');expect(html).toContain('aria-controls="song-management"');});
});

it('エラー案内には画面の未確定値ではなく失敗した試行の動画IDを使う',async()=>{
  vi.stubGlobal('localStorage',{getItem:()=>null,setItem:vi.fn()});const app=createApp('simulation');
  await app.controller.prepare({...defaultProfile(id,'DAM').input,playbackMode:'preplay'});
  vi.spyOn(app.controller,'getSnapshot').mockReturnValue({...app.controller.getSnapshot(),phase:'error',message:youtubeErrorMessage(150),canPrepare:true});
  const html=renderToStaticMarkup(createElement(App,app));expect(html).toContain('https://www.youtube.com/watch?v='+id);expect(html).toContain('動画所有者側の設定');await app.stopAll();
});


it('詳細設定の動画入力は形式を表示し、確定操作なしに動画を変更しない',()=>{
  const apply=vi.fn();const html=renderToStaticMarkup(createElement(ManualVideoInput,{videoId:id,onApply:apply}));expect(html).toContain('この動画を使用');expect(html).toContain('使用中の動画ID');expect(html).toContain(id);expect(apply).not.toHaveBeenCalled();
});
it('詳細設定でも不正な動画入力の確定操作を無効にする',()=>{
  const apply=vi.fn();const html=renderToStaticMarkup(createElement(ManualVideoInput,{videoId:'invalid',onApply:apply}));expect(html).toMatch(/<button[^>]*disabled=""[^>]*>この動画を使用/);expect(apply).not.toHaveBeenCalled();
});
