import { createServer } from 'node:http';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readTree, inspectArtifact, secretRules, staticResponse } from './pages-audit.ts';

const files=readTree(resolve('dist'));
const problems=inspectArtifact(files);
// 内容・値は表示せず、検出したファイルとルール名だけを報告する。
for(const [path,text]of readTree(resolve('src')))for(const rule of secretRules(text))problems.push('source-secret-pattern: src/'+path+' / '+rule);
for(const path of ['index.html','youtube-probe.html','vite.config.ts','package.json'])for(const rule of secretRules(readFileSync(path,'utf8')))problems.push('source-secret-pattern: '+path+' / '+rule);
assert.deepEqual(problems,[],'配信物またはソースの検査に失敗しました');
const server=createServer((request,response)=>{const result=staticResponse(files,request.url??'/');response.writeHead(result.status,result.headers);response.end(request.method==='HEAD'?'':result.body);});
try {
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address();assert(address&&typeof address!=='string');const origin='http://127.0.0.1:'+address.port;
  const checks=['/','/?mode=simulation','/youtube-probe.html','/youtube-probe','/404.html',...([...files.keys()].filter(name=>name.startsWith('assets/')).map(name=>'/'+name))];
  for(const path of checks){const response=await fetch(origin+path);assert.equal(response.status,200,path);assert.equal(response.headers.get('referrer-policy'),'strict-origin-when-cross-origin');assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.equal(response.headers.get('content-security-policy'),null);assert.equal(response.headers.get('permissions-policy'),null);await response.arrayBuffer();}
  for(const path of ['/unknown-route','/.env','/.git/config','/.local-https/server.json','/README.md','/karaoke_sync_test.html','/tatus','/_headers','/assets/not-found.js','/assets/%2e%2e%2fpackage.json']){const response=await fetch(origin+path);assert.equal(response.status,404,path);await response.arrayBuffer();}
  console.log(JSON.stringify({artifact:'dist',files:files.size,staticHttpChecks:checks.length+10,secretPatternFindings:0,server:'127.0.0.1 only; stopped after verification',scope:'Local artifact/HTTP/header emulation only. Not a Cloudflare, Access, YouTube, microphone or iPhone integration test.'},null,2));
} finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
