import { useEffect, useState } from 'react';
import { chromeLink } from './chromeLink';

export function ChromeOpen() {
  const [links, setLinks] = useState<ReturnType<typeof chromeLink>>();
  const [message, setMessage] = useState('');
  useEffect(() => { try { setLinks(chromeLink(window.location.href, navigator.userAgent)); } catch { setMessage('ページURLを確認できません'); } }, []);
  return <details className="tool-panel browser-help"><summary>Google Chromeで開く</summary><div className="panel-body">
    <p>ブラウザを切り替えると曲リストや設定は自動共有されません。必要な曲データは先に曲管理からJSONバックアップを保存し、切替先で復元してください。</p>
    {links?.alreadyChrome ? <p>すでにGoogle Chromeで表示しています。切り替えは不要です。</p> : links?.launch ?
      <a className="button-link" href={links.launch}>Google Chromeで開く</a> : <p>Chromeで開くには、下のURLをコピーしてChromeのアドレス欄に貼り付けてください。</p>}
    <p>Chromeが未インストール、または起動できない場合も、URLコピーや通常リンクを利用できます。アプリの起動成功はこのページから判定できません。</p>
    {links && <>
      <a href={links.url}>現在のページを通常リンクで開く</a>
      <label>このページのURL<input readOnly value={links.url} onFocus={event => event.currentTarget.select()} /></label>
      <button onClick={async () => {
        try {
          if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
          await navigator.clipboard.writeText(links.url);
          setMessage('URLをコピーしました');
        } catch { setMessage('コピーできませんでした。URL欄を長押ししてコピーしてください'); }
      }}>URLをコピー</button>
    </>}
    <p role="status">{message}</p>
    <p>YouTube Premiumは、このブラウザのYouTubeに加入アカウントでログインしていても、埋込み動画で広告なしになるとは保証できません。</p>
    <a href="https://support.google.com/youtube/answer/7437519?hl=ja" target="_blank" rel="noopener noreferrer">YouTube公式のPremium・広告に関する案内</a>
  </div></details>;
}
