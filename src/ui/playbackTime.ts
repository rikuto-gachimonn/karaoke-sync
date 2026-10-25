/** Display precision only: IFrame API time is not an audible timing measurement. */
export function formatPlaybackTime(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '--:--.--';
  const hundredths = Math.round(seconds * 100);
  const minutes = Math.floor(hundredths / 6000);
  const remainder = hundredths % 6000;
  return `${String(minutes).padStart(2, '0')}:${String(Math.floor(remainder / 100)).padStart(2, '0')}.${String(remainder % 100).padStart(2, '0')}`;
}

/** Two reads/second also catch IFrame seeks while paused. No extrapolated clock. */
export function observePlaybackTime(read: () => number | undefined, publish: (value: number | undefined) => void,
  visibility: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'> = document) {
  let timer: ReturnType<typeof setInterval> | undefined;
  const sample = () => {
    try {
      const value = read();
      publish(value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined);
    } catch { publish(undefined); }
  };
  const update = () => {
    clearInterval(timer); timer = undefined;
    if (!visibility.hidden) { sample(); timer = setInterval(sample, 500); }
  };
  visibility.addEventListener('visibilitychange', update);
  update();
  return () => { clearInterval(timer); visibility.removeEventListener('visibilitychange', update); };
}
