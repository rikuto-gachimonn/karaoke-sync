export interface YouTubeHandle {
  cueVideoById(options: { videoId: string; startSeconds: number }): void;
  playVideo(): void;
  pauseVideo(): void;
  getPlayerState(): number;
  getVideoData(): { video_id?: string };
  destroy(): void;
}
export interface YouTubeOptions {
  width: string;
  height: string;
  playerVars: { autoplay: number; playsinline: number; origin: string };
  events: {
    onReady(event: { target: YouTubeHandle }): void;
    onStateChange(event: { data: number }): void;
    onError(event: { data: number }): void;
    onAutoplayBlocked(): void;
  };
}
export interface YouTubeApi { Player: new (element: HTMLElement, options: YouTubeOptions) => YouTubeHandle }
declare global {
  interface Window { YT?: YouTubeApi; onYouTubeIframeAPIReady?: () => void }
}

let loading: Promise<YouTubeApi> | undefined;
export function loadYouTubeApi(timeoutMs = 15_000): Promise<YouTubeApi> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (loading) return loading;
  const attempt = new Promise<YouTubeApi>((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    const script = document.createElement('script');
    const cleanup = () => {
      clearTimeout(timer);
      script.onerror = null;
      if (window.onYouTubeIframeAPIReady === ready) window.onYouTubeIframeAPIReady = previous;
    };
    const fail = () => { cleanup(); script.remove(); reject(new Error('YouTube APIの取得に失敗しました。回線・制限を確認してください')); };
    const ready = () => {
      cleanup();
      if (window.YT?.Player) resolve(window.YT); else reject(new Error('YouTube Player APIが見つかりません'));
      previous?.();
    };
    const timer = setTimeout(fail, timeoutMs);
    window.onYouTubeIframeAPIReady = ready;
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.onerror = fail;
    document.head.appendChild(script);
  });
  loading = attempt;
  void attempt.catch(() => { if (loading === attempt) loading = undefined; });
  return attempt;
}
