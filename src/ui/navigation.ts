/** 折りたたみはDOMを保持したまま開く。YouTubeホストには触らない。 */
export function openPanel(id: string, page: Document = document) {
  const panel = page.getElementById(id) as HTMLDetailsElement | null;
  if (!panel || panel.tagName !== 'DETAILS') return;
  panel.open = true;
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  panel.querySelector<HTMLInputElement>('input[type="search"]')?.focus({ preventScroll: true });
}
