import type { SessionState } from '../session/state';
/** Explicit settings roots only. Song lists, live actions and player/notifications are excluded. */
export function collapseSettings(page: Document = document) {
  for (const panel of page.querySelectorAll<HTMLDetailsElement>('#audio-settings, #correction-panel, #correction-panel details, #advanced-settings, #advanced-settings details, .volume-meter details')) panel.open = false;
}
export function preparationAccepted(before: Pick<SessionState, 'generation' | 'phase'>, after: Pick<SessionState, 'generation' | 'phase' | 'canPrepare'>) {
  return !after.canPrepare && after.phase !== 'error' && (after.generation !== before.generation || before.phase === 'micReady' && after.phase === 'preparing');
}
