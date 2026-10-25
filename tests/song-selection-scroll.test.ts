import { describe, expect, it, vi } from 'vitest';
import { createSongSelectionNavigator } from '../src/ui/navigation';
function setup(reduce = false) {
  const callbacks = new Map<number, FrameRequestCallback>(); let next = 0;
  const button = { hidden: false, disabled: false, isConnected: true, focus: vi.fn(), scrollIntoView: vi.fn() };
  const picker = { open: true };
  const page = { getElementById: vi.fn((id: string) => id === 'detection-start' ? button : id === 'song-picker' ? picker : null) };
  const view = { requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => { callbacks.set(++next, callback); return next; }),
    cancelAnimationFrame: vi.fn((id: number) => { callbacks.delete(id); }), matchMedia: vi.fn(() => ({ matches: reduce })) };
  const navigation = createSongSelectionNavigator(page as unknown as Document, view as unknown as Window);
  const paint = () => { const pending = [...callbacks.values()]; callbacks.clear(); pending.forEach(callback => callback(0)); };
  return { navigation, button, picker, page, view, paint, callbacks };
}
describe('曲選択成功後だけ操作ボタンへ移動', () => {
  it('生成・初回表示相当ではDOM照会もスクロールもせず、成功後の描画フレームに1回だけ移動', async () => {
    const s = setup(); expect(s.page.getElementById).not.toHaveBeenCalled(); expect(s.view.requestAnimationFrame).not.toHaveBeenCalled();
    let finish!: (value: boolean) => void; const operation = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
    const selecting = s.navigation.select(operation); s.paint(); expect(s.button.scrollIntoView).not.toHaveBeenCalled();
    finish(true); await selecting; expect(s.button.scrollIntoView).not.toHaveBeenCalled(); s.paint();
    expect(operation).toHaveBeenCalledTimes(1); expect(s.button.scrollIntoView).toHaveBeenCalledExactlyOnceWith({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    expect(s.button.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true }); s.paint(); expect(s.button.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(s.picker.open).toBe(true);
  });
  it('選択処理の成功だけでなくReact描画完了を待ってから予約する', async () => {
    const s = setup(); let commit: (() => void) | undefined;
    const navigation = createSongSelectionNavigator(s.page as unknown as Document, s.view as unknown as Window, schedule => { commit = schedule; });
    s.button.disabled = true; await navigation.select(async () => true);
    expect(s.view.requestAnimationFrame).not.toHaveBeenCalled();
    s.button.disabled = false; commit!(); s.paint(); expect(s.button.scrollIntoView).toHaveBeenCalledTimes(1);
  });
  it('描画待ちの古い成功は新しい選択や破棄後にスクロールしない', async () => {
    const s = setup(); const commits: (() => void)[] = [];
    const navigation = createSongSelectionNavigator(s.page as unknown as Document, s.view as unknown as Window, schedule => { commits.push(schedule); });
    await navigation.select(async () => true); await navigation.select(async () => false); commits[0]!(); s.paint();
    expect(s.button.scrollIntoView).not.toHaveBeenCalled();
    await navigation.select(async () => true); navigation.cancel(); commits[1]!(); s.paint(); expect(s.button.scrollIntoView).not.toHaveBeenCalled();
  });
  it('検索リストは成功時だけ閉じ、undefinedの成功結果にも対応', async () => { const s = setup(); await s.navigation.select(async () => undefined, true); s.paint(); expect(s.picker.open).toBe(false); expect(s.button.scrollIntoView).toHaveBeenCalledTimes(1); });
  it.each([false, 'reject'])('失敗%sでは閉じず、スクロールもフォーカスもしない', async failure => {
    const s = setup(); await s.navigation.select(async () => { if (failure === 'reject') throw Error('failed'); return false; }, true); s.paint();
    expect(s.view.requestAnimationFrame).not.toHaveBeenCalled(); expect(s.button.scrollIntoView).not.toHaveBeenCalled(); expect(s.button.focus).not.toHaveBeenCalled(); expect(s.picker.open).toBe(true);
  });
  it('動きを減らす指定では即時のautoスクロールを使う', async () => { const s = setup(true); await s.navigation.select(async () => true); s.paint(); expect(s.view.matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)'); expect(s.button.scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'auto' })); });
  it('切替中の連打は同じ選択とスクロールを重複実行しない', async () => { const s = setup(); let finish!: () => void; const operation = vi.fn(() => new Promise<void>(resolve => { finish = resolve; })); const first = s.navigation.select(operation); await s.navigation.select(operation); expect(operation).toHaveBeenCalledTimes(1); finish(); await first; s.paint(); expect(s.button.scrollIntoView).toHaveBeenCalledTimes(1); });
  it('次の選択開始時に未実行の古いスクロールを取り消す', async () => { const s = setup(); await s.navigation.select(async () => true); await s.navigation.select(async () => false); s.paint(); expect(s.view.cancelAnimationFrame).toHaveBeenCalledTimes(1); expect(s.button.scrollIntoView).not.toHaveBeenCalled(); });
  it('破棄後の遅着成功と予約済みフレームはスクロールしない', async () => {
    const s = setup(); let finish!: () => void; const pending = s.navigation.select(() => new Promise<void>(resolve => { finish = resolve; })); s.navigation.cancel(); finish(); await pending; s.paint(); expect(s.button.scrollIntoView).not.toHaveBeenCalled();
    await s.navigation.select(async () => true); s.navigation.cancel(); s.paint(); expect(s.button.scrollIntoView).not.toHaveBeenCalled();
  });
  it.each(['hidden', 'disabled', 'isConnected'] as const)('対象ボタンが使用できない%s状態では移動しない', async key => { const s = setup(); s.button[key] = key !== 'isConnected'; await s.navigation.select(async () => true); s.paint(); expect(s.button.scrollIntoView).not.toHaveBeenCalled(); });
  it('対象ボタンがない場合も安全に終了する', async () => { const s = setup(); s.page.getElementById.mockReturnValue(null); await s.navigation.select(async () => true); s.paint(); expect(s.button.scrollIntoView).not.toHaveBeenCalled(); });
});
