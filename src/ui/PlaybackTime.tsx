import { useEffect, useState, type ReactNode } from 'react';
import type { SessionController } from '../session/controller';
import type { Phase } from '../session/state';
import { formatPlaybackTime, observePlaybackTime, type PlaybackTimeValue } from './playbackTime';

export function PlaybackTime({ controller, phase, stopAction }: { controller: SessionController; phase: Phase; stopAction?: ReactNode }) {
  const [value, setValue] = useState<PlaybackTimeValue>({ position: undefined, interpolated: false });
  useEffect(() => {
    if (['idle', 'stopping', 'error', 'ended'].includes(phase)) { setValue({ position: undefined, interpolated: false }); return; }
    return observePlaybackTime(() => controller.displayPlaybackObservation(), next => {
      setValue(previous => previous.position === next.position && previous.interpolated === next.interpolated ? previous : next);
    });
  }, [controller, phase]);
  return <div className="playback-time">
    <div className="playback-time-main"><div className="playback-time-value"><span>現在の再生位置</span><output aria-label="YouTube現在再生時刻" aria-live="off">{formatPlaybackTime(value.position)}</output></div>{stopAction}</div>
    <small>{value.interpolated ? '補間表示（参考値）' : 'API取得値（参考値）'}</small>
  </div>;
}
