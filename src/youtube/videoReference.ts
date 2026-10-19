const idPattern=/^[A-Za-z0-9_-]{11}$/;
const hosts=new Set(['youtube.com','www.youtube.com','m.youtube.com']);
export function parseVideoReference(value:string):string {
  const text=value.trim();
  if(idPattern.test(text))return text;
  if(!text||text.length>2048)throw new Error('YouTube URLまたは11文字の動画IDを入力してください');
  let url:URL;
  try {url=new URL(text);} catch {throw new Error('有効なYouTube URLまたは11文字の動画IDを入力してください');}
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.port||(!hosts.has(url.hostname)&&url.hostname!=='youtu.be'))throw new Error('YouTube公式ホストのURLを入力してください');
  let id:string|undefined;
  if(url.hostname==='youtu.be')id=url.pathname.match(/^\/([A-Za-z0-9_-]{11})\/?$/)?.[1];
  else if(url.pathname==='/watch'&&url.searchParams.getAll('v').length===1)id=url.searchParams.get('v')??undefined;
  else id=url.pathname.match(/^\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{11})\/?$/)?.[1];
  if(!id||!idPattern.test(id))throw new Error('URLから11文字の動画IDを取得できません。共有URLまたは動画IDを確認してください');
  return id;
}
