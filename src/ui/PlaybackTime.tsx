import { useEffect, useState } from 'react';
import type { SessionController } from '../session/controller';
import type { Phase } from '../session/state';
import { formatPlaybackTime, observePlaybackTime, type PlaybackTimeValue } from './playbackTime';

export function PlaybackTime({ controller, phase }: { controller: SessionController; phase: Phase }) {
  const [value, setValue] = useState<PlaybackTimeValue>({ position: undefined, interpolated: false });
  useEffect(() => {
    if (['idle', 'stopping', 'error', 'ended'].includes(phase)) { setValue({ position: undefined, interpolated: false }); return; }
    return observePlaybackTime(() => controller.displayPlaybackObservation(), next => {
      setValue(previous => previous.position === next.position && previous.interpolated === next.interpolated ? previous : next);
    });
  }, [controller, phase]);
  return <div className="playback-time">
    <span>現在の再生位置</span><output aria-label="YouTube現在再生時刻" aria-live="off">{formatPlaybackTime(value.position)}</output>
    <small>{value.interpolated ? '補間表示（参考値）。' : 'API取得値。'}再生中は取得値の間を最大0.25秒分補間します。0.01秒は表示の桁数で、測定精度・実際の発音時刻を保証しません。</small>
  </div>;
}
