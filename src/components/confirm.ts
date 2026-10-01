import type { ReactNode } from 'react';
import { create } from 'zustand';

export interface ConfirmRequest {
  title: string;
  /** Short explanation under the title. */
  message?: ReactNode;
  /** Lines listed in a box above the message, e.g. every move in a trade. */
  details?: ReactNode[];
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive: the confirm button is red and focus starts on Cancel. */
  danger?: boolean;
}

interface Pending extends ConfirmRequest {
  resolve: (ok: boolean) => void;
}

/** Requests waiting for an answer; the first one is on screen (ConfirmHost). */
export const useConfirms = create<{ queue: Pending[] }>(() => ({ queue: [] }));

/** Ask the user to confirm in the app's own dialog (never the browser's). Resolves true when they confirm. */
export function confirmAction(request: ConfirmRequest): Promise<boolean> {
  return new Promise((resolve) => useConfirms.setState((s) => ({ queue: [...s.queue, { ...request, resolve }] })));
}

/** Answer the dialog on screen. */
export function answerConfirm(ok: boolean) {
  const [current, ...rest] = useConfirms.getState().queue;
  if (!current) return;
  useConfirms.setState({ queue: rest });
  current.resolve(ok);
}
