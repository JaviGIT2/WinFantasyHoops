import { useEffect, useRef } from 'react';
import { answerConfirm, useConfirms } from './confirm';

const icons = {
  danger: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3.5 2.8 19.5h18.4z" />
      <path d="M12 10v4.5M12 17.2v.1" />
    </svg>
  ),
  confirm: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12.5 2.7 2.7L16.2 9.5" />
    </svg>
  ),
};

/**
 * The app's confirmation dialog, shown for confirmAction() requests one at a time. Escape or a click outside
 * cancels; focus stays inside while it's open and goes back where it was afterwards.
 */
export function ConfirmHost() {
  const request = useConfirms((s) => s.queue[0]);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!request) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Destructive actions start on the safe choice.
    (request.danger ? cancelRef : okRef).current?.focus();
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        answerConfirm(false);
      } else if (e.key === 'Tab') {
        const buttons = [cancelRef.current, okRef.current].filter((b): b is HTMLButtonElement => !!b);
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
        e.preventDefault();
        buttons[(at + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, [request]);

  if (!request) return null;
  return (
    <div className="confirm-backdrop" onMouseDown={(e) => e.target === e.currentTarget && answerConfirm(false)}>
      <div className="confirm" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-body">
        <div className={`confirm-icon${request.danger ? ' danger' : ''}`}>{request.danger ? icons.danger : icons.confirm}</div>
        <div className="confirm-text">
          <h2 id="confirm-title">{request.title}</h2>
          <div id="confirm-body">
            {request.details?.length ? (
              <ul className="confirm-details">
                {request.details.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            ) : null}
            {request.message && <p>{request.message}</p>}
          </div>
        </div>
        <div className="confirm-actions">
          <button ref={cancelRef} className="btn" onClick={() => answerConfirm(false)}>
            {request.cancelLabel ?? 'Cancel'}
          </button>
          <button ref={okRef} className={`btn ${request.danger ? 'danger' : 'primary'}`} onClick={() => answerConfirm(true)}>
            {request.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}
