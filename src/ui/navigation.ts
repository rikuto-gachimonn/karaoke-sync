/** 折りたたみはDOMを保持したまま開く。YouTubeホストには触らない。 */
export function openPanel(id: string, page: Document = document) {
  const panel = page.getElementById(id) as HTMLDetailsElement | null;
  if (!panel || panel.tagName !== 'DETAILS') return;
  let ancestor = panel.parentElement;
  while (ancestor) {
    if (ancestor.tagName === 'DETAILS') (ancestor as HTMLDetailsElement).open = true;
    ancestor = ancestor.parentElement;
  }
  panel.open = true;
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  panel.querySelector<HTMLInputElement>('input[type="search"]')?.focus({ preventScroll: true });
}
