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

/** User-initiated list selection only. Wait for React's commit, then scroll once; never retry a user's scroll. */
export function createSongSelectionNavigator(page?: Document,
  view?: Pick<Window, 'requestAnimationFrame' | 'cancelAnimationFrame' | 'matchMedia'>,
  afterCommit: (schedule: () => void) => void = schedule => schedule()) {
  let generation = 0;
  let selecting = false;
  let frame: number | undefined;
  const clearFrame = () => {
    if (frame !== undefined) (view ?? window).cancelAnimationFrame(frame);
    frame = undefined;
  };
  return {
    async select(operation: () => Promise<void | boolean>, closePicker = false) {
      if (selecting) return;
      clearFrame();
      const request = ++generation;
      selecting = true;
      try {
        const result = await operation();
        if (result === false || request !== generation) return;
        const browser = view ?? window;
        afterCommit(() => {
          if (request !== generation) return;
          frame = browser.requestAnimationFrame(() => {
            frame = undefined;
            if (request !== generation) return;
            const document = page ?? window.document;
            const button = document.getElementById('detection-start') as HTMLButtonElement | null;
            if (!button || !button.isConnected || button.hidden || button.disabled) return;
            if (closePicker) {
              const picker = document.getElementById('song-picker') as HTMLDetailsElement | null;
              if (picker) picker.open = false;
            }
            button.focus({ preventScroll: true });
            button.scrollIntoView({ behavior: browser.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ? 'auto' : 'smooth', block: 'center', inline: 'nearest' });
          });
        });
      } catch {
        // Selection owns its error notification. A failed selection must not move the viewport.
      } finally {
        if (request === generation) selecting = false;
      }
    },
    cancel() { ++generation; selecting = false; clearFrame(); },
  };
}
