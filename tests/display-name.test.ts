import {describe,expect,it,vi,afterEach} from 'vitest';
import {readFileSync} from 'node:fs';
import {createElement} from 'react';import {renderToStaticMarkup} from 'react-dom/server';
import {App} from '../src/ui/App';import {createApp} from '../src/app/createApp';
import {parseImport} from '../src/library/backup';
afterEach(()=>vi.unstubAllGlobals());
describe('SyncLabの表示名と既存データ互換性',()=>{
 it.each(['index.html','karaoke_sync_test.html','youtube-probe.html'])('%sのタブとホーム画面用名をSyncLabにする',path=>{const html=readFileSync(path,'utf8');expect(html).toContain('<title>SyncLab</title>');expect(html).toContain('name="application-name" content="SyncLab"');expect(html).toContain('name="apple-mobile-web-app-title" content="SyncLab"');expect(html).toContain('name="robots" content="noindex, nofollow"');});
 it('Reactのヘッダーを表示名だけ変更する',()=>{vi.stubGlobal('localStorage',{getItem:()=>null,setItem:vi.fn()});const html=renderToStaticMarkup(createElement(App,createApp('simulation')));expect(html).toContain('<h1>SyncLab</h1>');expect(html).not.toContain('<h1>KaraokeSync</h1>');});
 it('旧HTMLの表示とバックアップ識別子を区別する',()=>{const html=readFileSync('karaoke_sync_test.html','utf8');expect(html).toContain('<h2>SyncLab</h2>');expect(html).toContain('appName: "Karaoke Sync"');expect(html).toContain('"karaoke-sync-backup-"');});
 it('旧名のバックアップを引き続き読み込む',()=>{const data=parseImport(JSON.stringify({appName:'Karaoke Sync',backupVersion:'0.6',songs:[{videoId:'M7lc1UVf-VE',savedSec:15,songInfo:{title:'曲',artist:'歌手',service:'DAM'},detectSettings:{threshold:.035,offset:0}}]}));expect(data.library.songs[0]!.profiles.DAM!.input.savedPositionSec).toBe(15);});
 it('検証ページは表示だけ変更しスキーマ名を維持する',()=>{expect(readFileSync('src/youtube-probe/main.ts','utf8')).toContain('<h1>SyncLab</h1>');expect(readFileSync('src/youtube-probe/probe.ts','utf8')).toContain("schema: 'karaokesync-youtube-probe-v1'");});
 it('404の表示名を変更して公開URLは維持する',()=>{const html=readFileSync('public/404.html','utf8');expect(html).toContain('<title>SyncLab — ページが見つかりません</title>');expect(html).toContain('href="/karaoke-sync/">SyncLabへ戻る');});
});
