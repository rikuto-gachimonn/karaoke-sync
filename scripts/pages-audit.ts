import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { resolve, relative, extname } from 'node:path';
const rootNames = new Set(['index.html','youtube-probe.html','karaoke_sync_test.html','404.html','_headers']);
/** HTTPヘッダーに依存せず、配信HTMLのhead内のrobots指定を検査する。 */
export function hasSearchExclusion(html:string):boolean {
  const head=html.replace(/<!--[\s\S]*?-->/g,'').match(/<head\b[^>]*>([\s\S]*?)<\/head\s*>/i)?.[1]??'';
  const robots=(head.match(/<meta\b[^>]*>/gi)??[]).map(tag=>{
    const attributes=new Map([...tag.matchAll(/([\w-]+)\s*=\s*(["'])(.*?)\2/g)].map(match=>[match[1]!.toLowerCase(),match[3]!.toLowerCase()]));
    return attributes.get('name')==='robots'?attributes.get('content'):undefined;
  }).filter((value):value is string=>value!==undefined);
  if(robots.length!==1)return false;
  const directives=robots[0]!.split(/[\s,]+/);
  return directives.includes('noindex')&&directives.includes('nofollow')&&!directives.includes('index')&&!directives.includes('follow');
}
export function allowedArtifactPath(name:string) {
  if(name.includes('\\')||name.split('/').some(part=>!part||part==='.'||part==='..'||part.startsWith('.')))return false;
  return name==='guide/synclab-guide.png'||rootNames.has(name)||/^assets\/[\w.-]+\.(?:js|css|svg|png|jpe?g|webp|ico|woff2?)$/.test(name);
}
export function secretRules(text:string):string[] {
  const rules:Record<string,RegExp>={
    'private-key':/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    'aws-access-key':/\bAKIA[0-9A-Z]{16}\b/,
    'github-token':/\b(?:ghp_|github_pat_)[A-Za-z0-9_]{30,}\b/,
    'openai-key':/\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}/,
    'assigned-credential':/(?:api[_-]?key|client[_-]?secret|CLOUDFLARE_API_TOKEN)\s*[=:]\s*["'][A-Za-z0-9_-]{16,}["']/i,
  };
  return Object.entries(rules).filter(([,rule])=>rule.test(text)).map(([name])=>name);
}
export function readTree(root:string):Map<string,string> {
  const files=new Map<string,string>();
  function visit(dir:string) {
    for(const name of readdirSync(dir)) {
      const path=resolve(dir,name);const info=lstatSync(path);
      if(info.isSymbolicLink())throw new Error('シンボリックリンクは検査・配信しません');
      if(info.isDirectory())visit(path);else files.set(relative(root,path).replaceAll('\\','/'),readFileSync(path,'utf8'));
    }
  }
  visit(resolve(root));return files;
}
export function inspectArtifact(files:Map<string,string>, base='/') {
  const problems:string[]=[];
  for(const name of rootNames)if(!files.has(name))problems.push('missing: '+name);
  for(const [name,text]of files) {
    if(!allowedArtifactPath(name))problems.push('unexpected-file: '+name);
    for(const rule of secretRules(text))problems.push('secret-pattern: '+name+' / '+rule);
    if(name.endsWith('.html')) {
      for(const match of text.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
        const path=match[1]!;
        if(!path.startsWith('/')||path.startsWith('//')||!path.includes('/assets/'))continue;
        if(!path.startsWith(base+'assets/'))problems.push('wrong-base-asset: '+name);
        else if(!files.has(path.slice(base.length)))problems.push('missing-asset: '+name);
      }
      if(/\/src\/|@vite\/client/.test(text))problems.push('development-reference: '+name);
    }
  }
  const headers=files.get('_headers')??'';
  if(!/^\/\*\s*$/m.test(headers)||!/^\s+Referrer-Policy: strict-origin-when-cross-origin\s*$/m.test(headers)||!/^\s+X-Content-Type-Options: nosniff\s*$/m.test(headers))problems.push('required-headers');
  if(/Content-Security-Policy|Permissions-Policy|Cross-Origin-Embedder-Policy/i.test(headers))problems.push('unreviewed-media-policy');
  const main=files.get('index.html')??'';
  if(!main.includes('strict-origin-when-cross-origin'))problems.push('youtube-referrer');
  return problems;
}
/** 現在使用する/*ルールだけを検査用に適用。Cloudflareの完全エミュレーターではない。 */
export function staticResponse(files:Map<string,string>, requestUrl:string, base='/', binaryFiles:Map<string,Uint8Array>=new Map()) {
  let pathname:string;
  try { pathname=decodeURIComponent(requestUrl.split('?')[0]!); } catch {return {status:400,headers:{'Content-Type':'text/plain'},body:'Bad request'};}
  const mounted=pathname.startsWith(base);
  const relativePath=mounted?pathname.slice(base.length):'';
  const name=!mounted?'':relativePath===''?'index.html':relativePath==='youtube-probe'?'youtube-probe.html':relativePath;
  const exists=allowedArtifactPath(name)&&name!=='_headers'&&files.has(name);
  const file=exists?name:'404.html';
  const type=extname(file)==='.js'?'text/javascript':extname(file)==='.css'?'text/css':extname(file)==='.html'?'text/html':'application/octet-stream';
  const headers:Record<string,string>={'Content-Type':extname(file)==='.png'?'image/png':type+'; charset=utf-8'};
  for(const line of (files.get('_headers')??'').split(/\r?\n/)) {const match=line.match(/^\s+([\w-]+):\s*(.+)$/);if(match)headers[match[1]!]=match[2]!;}
  return {status:exists?200:404,headers,body:binaryFiles.get(file)??files.get(file)??'Not found'};
}
