import { createElement } from 'react';
import { createHash } from 'node:crypto';
import { allowedArtifactPath, staticResponse } from '../scripts/pages-audit';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../src/ui/App';
import { createApp } from '../src/app/createApp';
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
it.each(['/karaoke-sync/','/'])('ベース%sのガイド画像を別タブへ開くリンクをアプリ名の近くに表示し保存しない',base=>{
 vi.stubEnv('BASE_URL',base);
 const setItem=vi.fn();vi.stubGlobal('localStorage',{getItem:()=>null,setItem});
 const html=renderToStaticMarkup(createElement(App,createApp('simulation')));
 const header=html.slice(html.indexOf('<header'),html.indexOf('</header>'));
 expect(header).toContain('<h1>SyncLab</h1>');
 expect(header).toContain(`href="${base}guide/synclab-guide.png"`);
 expect(header).toContain('target="_blank"');expect(header).toContain('rel="noopener noreferrer"');
 expect(header).toContain('aria-label="使い方ガイド（画像を別タブで開きます）"');
 expect(header.match(/class="guide-link"/g)).toHaveLength(1);
 expect(setItem).not.toHaveBeenCalled();
});
it('提供されたPNG原本のバイト列と寸法を保持する',async()=>{
 const {readFile}=await import('node:fs/promises');const {createHash}=await import('node:crypto');
 const image=await readFile(new URL('../public/guide/synclab-guide.png',import.meta.url));
 expect(createHash('sha256').update(image).digest('hex')).toBe('5935b30c8e2af43dffd2867b8404394b6178db03802e65d1a422d207534b549e');
 expect(image.subarray(0,8).toString('hex')).toBe('89504e470d0a1a0a');
 expect([image.readUInt32BE(16),image.readUInt32BE(20)]).toEqual([1054,1492]);
});
it('配信検査でもガイドだけを公開対象にしPNGをバイナリのまま返す',async()=>{
 const {readFile}=await import('node:fs/promises');const image=await readFile(new URL('../public/guide/synclab-guide.png',import.meta.url));
 const files=new Map([['guide/synclab-guide.png','binary'],['404.html','Not found']]);
 const response=staticResponse(files,'/karaoke-sync/guide/synclab-guide.png','/karaoke-sync/',new Map([['guide/synclab-guide.png',image]]));
 expect(response.status).toBe(200);expect(response.headers['Content-Type']).toBe('image/png');expect(createHash('sha256').update(response.body).digest('hex')).toBe('5935b30c8e2af43dffd2867b8404394b6178db03802e65d1a422d207534b549e');
 expect(allowedArtifactPath('guide/synclab-guide.png')).toBe(true);expect(allowedArtifactPath('guide/other.png')).toBe(false);
});

it('検知・再生中にはガイド遷移を無効にし背景移行で同期を中断させない',()=>{
 vi.stubGlobal('localStorage',{getItem:()=>null,setItem:vi.fn()});const app=createApp('simulation');
 vi.spyOn(app.controller,'getSnapshot').mockReturnValue({...app.controller.getSnapshot(),phase:'playing',canPrepare:false});
 const html=renderToStaticMarkup(createElement(App,app));const link=html.match(/<a class="guide-link"[^>]*>/)?.[0];
 expect(link).toContain('aria-disabled="true"');expect(link).toContain('tabindex="-1"');expect(link).not.toContain('href=');
});
