import { closeSettingsPanel } from './navigation';
export function CloseSettingsButton({ onClose }: { onClose?: () => void }) {
  return <button type="button" className="close-settings" onClick={event => {
    const panel = event.currentTarget.closest('details');
    if (!panel) return;
    onClose?.();
    closeSettingsPanel(panel);
  }}>この設定欄を閉じる</button>;
}
