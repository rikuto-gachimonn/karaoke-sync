import { useEffect, useState } from 'react';
import { parseVideoReference } from '../youtube/videoReference';
import { VideoReferenceInput } from './VideoReferenceInput';
export function ManualVideoInput({videoId,onApply}:{videoId:string;onApply:(id:string)=>void}) {
  const [draft,setDraft]=useState(videoId);
  useEffect(()=>setDraft(videoId),[videoId]);
  let parsed:string|undefined;try{parsed=parseVideoReference(draft);}catch{/* 確定操作は無効 */}
  return <div><VideoReferenceInput value={draft} onChange={setDraft}/>
    <button type="button" disabled={!parsed} onClick={()=>{if(parsed)onApply(parsed);}}>この動画を使用</button>
    <p>使用中の動画ID: <code>{videoId}</code>。手入力動画はボタンで確定します。確定前は選択中の動画・設定を変更しません。</p>
  </div>;
}
