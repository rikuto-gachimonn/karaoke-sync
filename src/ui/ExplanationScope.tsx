import { useId, useState, type CSSProperties, type ReactNode } from 'react';

/** Only supplemental prose changes visibility; controls and drafts stay mounted. */
export function ExplanationScope({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <div className="explanation-scope" style={{ '--supplementary-display': open ? 'block' : 'none' } as CSSProperties}>
    <button type="button" className="explanation-toggle" aria-label={`${label}の${open ? '説明を閉じる' : '説明を見る'}`} aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>{open ? '説明を閉じる' : '説明を見る'}</button>
    <div id={id} className="explanation-content">{children}</div>
  </div>;
}
