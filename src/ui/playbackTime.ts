import type { PlaybackObservation } from '../session/ports';

/** Display precision only: IFrame API time is not an audible timing measurement. */
export function formatPlaybackTime(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '--:--.--';
  const hundredths = Math.round(seconds * 100);
  const minutes = Math.floor(hundredths / 6000);
  const remainder = hundredths % 6000;
  return `${String(minutes).padStart(2, '0')}:${String(Math.floor(remainder / 100)).padStart(2, '0')}.${String(remainder % 100).padStart(2, '0')}`;
}

export interface PlaybackTimeValue { position: number | undefined; interpolated: boolean }
/** Display only: 20Hz while playing, 4Hz while paused. Extrapolation is capped at 250ms. */
export function observePlaybackTime(read: () => Promise<PlaybackObservation | undefined>, publish: (value: PlaybackTimeValue) => void,
  visibility: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'> = document,
  now: () => number = () => performance.now()) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let epoch = 0;
  let anchor: { position: number; time: number; rate: number } | undefined;
  let disposed = false;
  const sample = async (generation: number) => {
    let playing = false;
    try {
      const value = await read();
      if (disposed || generation !== epoch || visibility.hidden) return;
      if (!value || !Number.isFinite(value.position) || value.position < 0 || !Number.isFinite(value.rate) || value.rate <= 0) {
        anchor = undefined; publish({ position: undefined, interpolated: false });
      } else {
        playing = value.playing;
        const time = now();
        let position = value.position;
        let interpolated = false;
        if (playing && anchor && anchor.position === position && anchor.rate === value.rate) {
          const elapsed = Math.max(0, Math.min(250, time - anchor.time));
          position += elapsed * value.rate / 1000;
          if (value.duration !== undefined) position = Math.min(value.duration, position);
          interpolated = position !== value.position;
        } else anchor = playing ? { position, time, rate: value.rate } : undefined;
        publish({ position, interpolated });
      }
    } catch {
      if (disposed || generation !== epoch || visibility.hidden) return;
      anchor = undefined; publish({ position: undefined, interpolated: false });
    }
    if (!disposed && generation === epoch && !visibility.hidden) timer = setTimeout(() => { void sample(generation); }, playing ? 50 : 250);
  };
  const update = () => {
    clearTimeout(timer); timer = undefined; anchor = undefined;
    const generation = ++epoch;
    if (!visibility.hidden && !disposed) void sample(generation);
  };
  visibility.addEventListener('visibilitychange', update);
  update();
  return () => { disposed = true; ++epoch; clearTimeout(timer); visibility.removeEventListener('visibilitychange', update); };
}
