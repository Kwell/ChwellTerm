import { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';
export function Dialog({ title, onClose, children, wide = false, closeDisabled = false }: { title: string; onClose?: () => void; children: React.ReactNode; wide?: boolean; closeDisabled?: boolean }) {
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = dialog.current?.querySelector<HTMLElement>('input, textarea, select') || dialog.current?.querySelector<HTMLElement>('button'); first?.focus();
    function trap(e: KeyboardEvent) {
      if (dialog.current?.closest('[hidden]')) return;
      if (e.key !== 'Tab') return;
      const elements = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled)') || [])];
      const first = elements[0], last = elements[elements.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
    document.addEventListener('keydown', trap); return () => { document.removeEventListener('keydown', trap); previous?.focus(); };
  }, []);
  return <div className="dialog-overlay"><div className={`dialog ${wide ? 'dialog-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialog}><div className="dialog-heading"><strong id={titleId}>{title}</strong>{onClose && <button disabled={closeDisabled} onClick={onClose} aria-label="关闭对话框"><X size={17} /></button>}</div><div className="dialog-body">{children}</div></div></div>;
}
