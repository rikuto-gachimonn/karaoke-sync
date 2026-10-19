import {describe,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {inspectArtifact,staticResponse} from '../scripts/pages-audit';
const base='/karaoke-sync/';
const fixture=()=>new Map([
 ['index.html','<meta name="referrer" content="strict-origin-when-cross-origin"><script src="/karaoke-sync/assets/app.js"></script>'],
 ['youtube-probe.html','<script src="/karaoke-sync/assets/app.js"></script>'],
 ['karaoke_sync_test.html','legacy unchanged'],['assets/app.js','test'],['404.html','Not found'],
 ['_headers','/*\n  Referrer-Policy: strict-origin-when-cross-origin\n  X-Content-Type-Options: nosniff\n'],
]);
describe('GitHub Pagesのサブパスと旧版共存',()=>{
 it('React・検証ページ・旧版を含む配信物を検査する',()=>expect(inspectArtifact(fixture(),base)).toEqual([]));
 it.each(['','?mode=simulation','youtube-probe.html','karaoke_sync_test.html','assets/app.js'])('%sをプロジェクト配下で配信する',path=>{expect(staticResponse(fixture(),base+path,base).status).toBe(200);});
 it('旧HTMLをReactのフォールバックにせず元の内容で返す',()=>{expect(staticResponse(fixture(),base+'karaoke_sync_test.html',base)).toMatchObject({status:200,body:'legacy unchanged'});});
 it.each(['/','/assets/app.js','/karaoke-sync-other/','/karaoke-sync/tatus','/karaoke-sync/README.md','/karaoke-sync/.git/config'])('公開範囲外%sは404とする',path=>{expect(staticResponse(fixture(),path,base).status).toBe(404);});
 it('誤ってルートに向いたアセット参照を検出する',()=>{const files=fixture();files.set('index.html',files.get('index.html')!.replace('/karaoke-sync/assets/','/assets/'));expect(inspectArtifact(files,base)).toContain('wrong-base-asset: index.html');});
 it('サブパスに正しい参照でもアセット欠落を検出する',()=>{const files=fixture();files.delete('assets/app.js');expect(inspectArtifact(files,base)).toContain('missing-asset: index.html');});
 it('サブパスの未知URLはReactへ黙って書き換えない',()=>{expect(staticResponse(fixture(),base+'unknown',base)).toMatchObject({status:404,body:'Not found'});});
 it('404からの戻り先もプロジェクトURLを指す',()=>{expect(readFileSync('public/404.html','utf8')).toContain('href="/karaoke-sync/"');});
 it('Viteのbaseとアプリ内切替リンクを維持する',()=>{expect(readFileSync('vite.config.ts','utf8')).toContain("base: '/karaoke-sync/'");expect(readFileSync('src/ui/App.tsx','utf8')).toContain('`${import.meta.env.BASE_URL}?mode=simulation`');});
 it('公開処理はmain限定、検証成功後にdistだけを送る',()=>{const workflow=readFileSync('.github/workflows/pages.yml','utf8');expect(workflow).toContain('branches: [main]');expect(workflow.match(/if: github.ref == 'refs\/heads\/main'/g)).toHaveLength(2);expect(workflow).toContain('needs: build');expect(workflow).toContain('pnpm install --frozen-lockfile');for(const command of ['pnpm test','pnpm typecheck','pnpm build','scripts/check-pages.ts'])expect(workflow).toContain(command);expect(workflow).toMatch(/Upload only dist[\s\S]*path: dist/);expect(workflow).toContain('pages: write');expect(workflow).toContain('id-token: write');expect(workflow).not.toContain('pull_request_target');});
});
