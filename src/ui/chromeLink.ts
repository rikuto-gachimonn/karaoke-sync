export function chromeLink(href: string, userAgent: string) {
  const url = new URL(href);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('通常のページURLを使用してください');
  const alreadyChrome = /CriOS\/|(?:Chrome|Chromium)\//.test(userAgent) && !/Edg\/|EdgiOS\/|OPR\//.test(userAgent);
  const ios = /iPhone|iPad|iPod/.test(userAgent);
  return { url: url.href, alreadyChrome, launch: ios && !alreadyChrome ? url.href.replace(/^https?:/, url.protocol === 'https:' ? 'googlechromes:' : 'googlechrome:') : undefined };
}
