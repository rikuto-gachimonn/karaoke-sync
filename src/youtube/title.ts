import { libraryLimits } from '../library/model';
export async function fetchYouTubeTitle(videoId:string, signal?:AbortSignal, request:typeof fetch=fetch):Promise<string> {
  if(!/^[A-Za-z0-9_-]{11}$/.test(videoId))throw new Error('動画IDが不正です');
  const url=new URL('https://www.youtube.com/oembed');
  url.search=new URLSearchParams({url:'https://www.youtube.com/watch?v='+videoId,format:'json'}).toString();
  const abort=new AbortController();
  let rejectCancelled!:(reason:Error)=>void;
  const cancelled=new Promise<never>((_,reject)=>{rejectCancelled=reject;});
  const cancel=()=>{abort.abort();rejectCancelled(new Error('タイトル取得を中断しました'));};
  signal?.addEventListener('abort',cancel,{once:true});
  const timer=setTimeout(cancel,8000);
  try {
    if(signal?.aborted)cancel();
    const result=await Promise.race([(async()=>{
      if(abort.signal.aborted)throw new Error('タイトル取得を中断しました');
      const response=await request(url,{method:'GET',mode:'cors',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:abort.signal});
      if(!response.ok)throw new Error('oEmbed HTTP '+response.status);
      const value:unknown=await response.json();
      if(!value||typeof value!=='object'||!('title' in value)||typeof value.title!=='string'||!value.title.trim()||value.title.length>libraryLimits.textLength)throw new Error('タイトルの形式または長さが不正です');
      return value.title;
    })(),cancelled]);
    return result;
  } finally {clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
}
