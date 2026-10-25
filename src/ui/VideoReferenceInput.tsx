import { useId, type ReactNode } from 'react';
import { parseVideoReference } from '../youtube/videoReference';
export function VideoReferenceInput({value,onChange,action}:{value:string;onChange:(value:string)=>void;action?:ReactNode}) {
  const hint=useId();let videoId='';let error='';
  if(value.trim())try{videoId=parseVideoReference(value);}catch(failure){error=(failure as Error).message;}
  return <><label>YouTube URLまたは動画ID<input required maxLength={2048} autoCapitalize="none" autoCorrect="off" spellCheck={false} value={value} aria-describedby={hint} aria-invalid={!!error} onChange={event=>onChange(event.target.value)} /></label>
    {action}
    <p id={hint} className="video-reference-hint" aria-live="polite">{error|| (videoId?'確認した動画ID: '+videoId:'YouTubeの共有URL・動画URL、または11文字の動画IDを貼り付けてください。')}</p>
    <small>形式のみを確認します。動画の実在・再生・埋め込み可否は保証しません。共有・再生リスト・時刻パラメーターは開始位置に取り込みません。</small></>;
}
