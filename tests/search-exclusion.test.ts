import {describe,expect,it} from 'vitest';
import {existsSync,readFileSync} from 'node:fs';
import {hasSearchExclusion} from '../scripts/pages-audit';
describe('テスト公開HTMLの検索除外指定',()=>{
 it.each(['index.html','karaoke_sync_test.html','youtube-probe.html','public/404.html'])('%sのheadにnoindex,nofollowを設定する',path=>{expect(hasSearchExclusion(readFileSync(path,'utf8'))).toBe(true);});
 it('属性順・引用符・大文字小文字が違っても確認する',()=>{expect(hasSearchExclusion("<HEAD><META CONTENT='NOINDEX, NOFOLLOW' NAME='ROBOTS'></HEAD>")).toBe(true);});
 it.each(['noindex','nofollow','noindex, nofollow, index','noindex-other, nofollow'])('不十分・矛盾した指定%sは拒否する',content=>{expect(hasSearchExclusion('<head><meta name="robots" content="'+content+'"></head>')).toBe(false);});
 it('body中の指定はheadの代わりにしない',()=>{expect(hasSearchExclusion('<head></head><body><meta name="robots" content="noindex, nofollow"></body>')).toBe(false);});
 it('コメント化された指定は有効と判定しない',()=>{expect(hasSearchExclusion('<head><!-- <meta name="robots" content="noindex, nofollow"> --></head>')).toBe(false);});
 it('重複したrobots指定は拒否する',()=>{expect(hasSearchExclusion('<head><meta name="robots" content="noindex, nofollow"><meta name="robots" content="index"></head>')).toBe(false);});
 it('クロールを遮断するrobots.txtを追加しない',()=>{expect(existsSync('public/robots.txt')).toBe(false);expect(existsSync('robots.txt')).toBe(false);});
});
