import { describe, expect, it } from 'vitest';
import { allowedArtifactPath, inspectArtifact, secretRules, staticResponse } from '../scripts/pages-audit';
const fixture=()=>new Map([
  ['index.html','<meta name="referrer" content="strict-origin-when-cross-origin"><script src="/assets/app-abc.js"></script>'],
  ['youtube-probe.html','<script src="/assets/app-abc.js"></script>'],['assets/app-abc.js','console.log("test")'],
  ['404.html','Not found'],['_headers','/*\n  Referrer-Policy: strict-origin-when-cross-origin\n  X-Content-Type-Options: nosniff\n  X-Robots-Tag: noindex, nofollow\n  Cache-Control: no-cache\n'],
]);
describe('Pages配信物の安全な範囲と設定',()=>{
  it('既存の2ページと静的アセットを検査する',()=>expect(inspectArtifact(fixture())).toEqual([]));
  it.each(['.env','.git/config','.local-https/server.json','README.md','tatus','karaoke_sync_test.html','backup.json','assets/app.js.map','assets/../package.json'])('配信対象外%sを拒否する',name=>expect(allowedArtifactPath(name)).toBe(false));
  it('秘密鍵と代表的なキー形式は値を報告せず検出する',()=>{
    expect(secretRules('-----BEGIN PRIVATE KEY-----')).toContain('private-key');expect(secretRules('AKIA'+'A'.repeat(16))).toContain('aws-access-key');expect(secretRules('ghp_'+'A'.repeat(36))).toContain('github-token');expect(secretRules('api_key="'+'A'.repeat(20)+'"')).toContain('assigned-credential');
  });
  it('存在しないビルドアセット参照を検出する',()=>{const files=fixture();files.delete('assets/app-abc.js');expect(inspectArtifact(files)).toContain('missing-asset: index.html');});
  it('dev参照・媒体を止める未検証ポリシーを検出する',()=>{const files=fixture();files.set('index.html','<script src="/src/main.tsx"></script>');files.set('_headers',files.get('_headers')+'  Permissions-Policy: microphone=()\n');expect(inspectArtifact(files)).toContain('development-reference: index.html');expect(inspectArtifact(files)).toContain('unreviewed-media-policy');});
  it('手動画面遷移・query・probeは既存の静的ページへ解決する',()=>{for(const path of ['/','/?mode=simulation','/youtube-probe.html','/youtube-probe'])expect(staticResponse(fixture(),path).status).toBe(200);});
  it('未知URLと非配信ファイルはSPAへ黙って戻さず404にする',()=>{for(const path of ['/unknown','/_headers','/.env','/assets/%2e%2e%2fpackage.json'])expect(staticResponse(fixture(),path).status).toBe(404);});
  it('Referrerを保持しCSP/Permissionsによるマイク・YouTube制限を追加しない',()=>{const {headers}=staticResponse(fixture(),'/');expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');expect(headers['Content-Security-Policy']).toBeUndefined();expect(headers['Permissions-Policy']).toBeUndefined();});
});
