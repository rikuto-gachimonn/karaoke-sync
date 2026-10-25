import type { SessionState } from '../session/state';
type ScrollView = Pick<Window, 'requestAnimationFrame' | 'cancelAnimationFrame' | 'matchMedia'> & Partial<Pick<Window, 'scrollTo' | 'scrollX' | 'scrollY' | 'innerHeight' | 'visualViewport'>>;
const queues = new WeakMap<ScrollView, ReturnType<typeof createScrollQueue>>();
function createScrollQueue(view: ScrollView) {
  let version = 0, moving = false; let frame: number | undefined;
  const cancel = (ticket?: number) => {
    if (ticket !== undefined && ticket !== version) return;
    ++version;
    if (frame !== undefined) view.cancelAnimationFrame(frame);
    frame = undefined;
    if (moving) view.scrollTo?.({ top: view.scrollY ?? 0, left: view.scrollX ?? 0, behavior: 'auto' });
    moving = false;
  };
  return { cancel, reserve() { cancel(); return version; }, current: (ticket: number) => ticket === version,
    schedule(ticket: number, action: () => void) { if (ticket !== version) return; frame = view.requestAnimationFrame(() => { frame = undefined; if (ticket === version) action(); }); },
    moved(ticket: number) { if (ticket === version) moving = true; },
  };
}
function queue(view: ScrollView = window) { let value = queues.get(view); if (!value) { value = createScrollQueue(view); queues.set(view, value); } return value; }
export function cancelAutomaticScroll(view?: ScrollView) { queue(view).cancel(); }

/** 折りたたみはDOMを保持したまま開く。YouTubeホストには触らない。 */
export function openPanel(id: string, page: Document = document) {
  const panel = page.getElementById(id) as HTMLDetailsElement | null;
  if (!panel || panel.tagName !== 'DETAILS') return;
  let ancestor = panel.parentElement;
  while (ancestor) {
    if (ancestor.tagName === 'DETAILS') (ancestor as HTMLDetailsElement).open = true;
    ancestor = ancestor.parentElement;
  }
  if (page.defaultView) cancelAutomaticScroll(page.defaultView);
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
  let ticket: number | undefined;
  const clearFrame = () => { if (ticket !== undefined) queue(view).cancel(ticket); ticket = undefined; };
  return {
    async select(operation: () => Promise<void | boolean>, closePicker = false) {
      if (selecting) return;
      clearFrame();
      const request = ++generation;
      const scrolls = queue(view); const reservation = scrolls.reserve(); ticket = reservation;
      selecting = true;
      try {
        const result = await operation();
        if (result === false || request !== generation) return;
        const browser = view ?? window;
        afterCommit(() => {
          if (request !== generation || !scrolls.current(reservation)) return;
          scrolls.schedule(reservation, () => {
            if (request !== generation) return;
            const document = page ?? window.document;
            const button = document.getElementById('detection-start') as HTMLButtonElement | null;
            if (!button || !button.isConnected || button.hidden || button.disabled) return;
            if (closePicker) {
              const picker = document.getElementById('song-picker') as HTMLDetailsElement | null;
              if (picker) picker.open = false;
            }
            button.focus({ preventScroll: true });
            scrolls.moved(reservation);
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

/** Observe the session's confirmed playing phase, never a raw detector or preview event. */
export function createPlaybackNavigator(page?: Document, view?: ScrollView,
  current?: () => Pick<SessionState, 'generation' | 'phase'>, previewBusy: () => boolean = () => false) {
  let generation: number | undefined, consumed = false, ticket: number | undefined;
  const cancel = () => { if (ticket !== undefined) queue(view).cancel(ticket); ticket = undefined; };
  return {
    observe(state: Pick<SessionState, 'generation' | 'phase'>) {
      if (generation === undefined) { generation = state.generation; consumed = state.phase === 'playing'; return; }
      if (generation !== state.generation) { cancel(); generation = state.generation; consumed = false; }
      if (state.phase !== 'playing' || previewBusy()) { cancel(); return; }
      if (consumed) return;
      consumed = true;
      const browser = view ?? window, scrolls = queue(browser), reservation = scrolls.reserve(); ticket = reservation;
      scrolls.schedule(reservation, () => {
        const latest = current?.() ?? state;
        if (latest.generation !== state.generation || latest.phase !== 'playing' || previewBusy()) return;
        const document = page ?? window.document;
        if (document.hidden) return;
        const target = document.getElementById('playback-area');
        if (!target || !target.isConnected || target.hidden) return;
        const rect = target.getBoundingClientRect(), top = (browser.visualViewport?.offsetTop ?? 0) + 80;
        const bottom = (browser.visualViewport?.offsetTop ?? 0) + (browser.visualViewport?.height ?? browser.innerHeight ?? 768) - 16;
        if (rect.top >= top && rect.bottom <= bottom) return;
        target.focus({ preventScroll: true }); scrolls.moved(reservation);
        target.scrollIntoView({ behavior: browser.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ? 'auto' : 'smooth', block: 'center', inline: 'nearest' });
      });
    },
    cancel,
  };
}
