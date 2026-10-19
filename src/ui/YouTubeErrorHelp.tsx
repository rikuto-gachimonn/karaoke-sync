import { youtubeErrorMessage } from '../youtube/errors';
export function YouTubeErrorHelp({message,videoId}:{message:string;videoId:string}) {
  const match=message.match(/YouTube (\d+):/);if(!match)return null;
  return <aside className="youtube-error-help" aria-label="YouTube再生エラーの対処">
    <p>{youtubeErrorMessage(Number(match[1]))}</p><p>エラー時の動画ID: <code>{videoId}</code></p>
    {/^[A-Za-z0-9_-]{11}$/.test(videoId)&&<p><a href={'https://www.youtube.com/watch?v='+videoId} target="_blank" rel="noopener noreferrer">元のYouTube動画を開く（別タブ）</a></p>}
    <p>元のYouTubeで再生できても、アプリ内の埋め込み再生は保証されません。エラーだけで入力ミスや配信サービスの不具合とは断定できません。</p>
    <p>「すべて停止」後に再読み込み・動画の再選択を試すか、埋め込み可能な別動画を選んでください。</p>
  </aside>;
}
