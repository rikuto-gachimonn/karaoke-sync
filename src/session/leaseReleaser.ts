import type { AudioLease } from './ports';

// タイムアウトは呼出し側の待機期限であり、release自体の取消ではない。
// 失敗した試行は明示再試行まで維持し、未完了試行には常に相乗りする。
export class LeaseReleaser {
  private attempts = new WeakMap<AudioLease, { promise: Promise<void>; status: 'pending' | 'failed' | 'released' }>();

  release(lease: AudioLease): Promise<void> {
    const existing = this.attempts.get(lease);
    if (existing) return existing.promise;
    const attempt = { promise: Promise.resolve(), status: 'pending' as 'pending' | 'failed' | 'released' };
    attempt.promise = Promise.resolve().then(() => lease.release()).then(() => {
      attempt.status = 'released';
    }, error => {
      attempt.status = 'failed';
      throw error;
    });
    this.attempts.set(lease, attempt);
    return attempt.promise;
  }

  retryFailed(lease: AudioLease): void {
    if (this.attempts.get(lease)?.status === 'failed') this.attempts.delete(lease);
  }
}
