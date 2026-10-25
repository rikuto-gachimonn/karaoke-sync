import { useEffect, useState } from 'react';
import type { SessionController } from '../session/controller';
import type { Phase } from '../session/state';
import { formatPlaybackTime, observePlaybackTime } from './playbackTime';

export function PlaybackTime({ controller, phase }: { controller: SessionController; phase: Phase }) {
  const [position, setPosition] = useState<number>();
  useEffect(() => {
    if (['idle', 'stopping', 'error', 'ended'].includes(phase)) { setPosition(undefined); return; }
    return observePlaybackTime(() => controller.displayPlaybackPosition(), setPosition);
  }, [controller, phase]);
  return <div className="playback-time">
    <span>現在の再生位置</span><output aria-label="YouTube現在再生時刻" aria-live="off">{formatPlaybackTime(position)}</output>
    <small>0.01秒は表示の桁数で、測定精度・実際の発音時刻を保証しません。</small>
  </div>;
}
