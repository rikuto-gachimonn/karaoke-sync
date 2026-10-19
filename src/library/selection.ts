import type { SessionController } from '../session/controller';
import type { SyncProfile } from '../app/preferences';
import { defaultProfile, validProfile, type Service, type Song } from './model';

/** 前曲の終了を確認してから設定を返す。資源解放待ちなら選択を適用しない。 */
export async function selectSong(controller: Pick<SessionController, 'stop' | 'getSnapshot'>, song: Song, service: Service,
  mode: 'real' | 'simulation', fallback?: () => SyncProfile | undefined): Promise<SyncProfile> {
  if (!controller.getSnapshot().canPrepare) await controller.stop();
  if (!controller.getSnapshot().canPrepare) throw new Error('前の曲の資源解放が未完了です。すべて停止・復旧操作後に再選択してください');
  const profile = song.profiles[service] ?? fallback?.() ?? defaultProfile(song.videoId, service, mode);
  return validProfile(profile, song.videoId, service);
}
