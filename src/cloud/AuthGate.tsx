import { useEffect, type ReactNode } from 'react';
import { LoginView, SetPasswordView } from '../views/LoginView';
import { useAuth } from './auth';
import { startSync } from './sync';

/** The sign-in screen until an account is open (or right away without accounts), then the app, kept in sync. */
export function AuthGate({ children }: { children: ReactNode }) {
  const phase = useAuth((a) => a.phase);
  const accountId = useAuth((a) => a.account?.id ?? null);
  const recovering = useAuth((a) => a.recovering);

  useEffect(() => (accountId ? startSync(accountId) : undefined), [accountId]);

  if (phase === 'loading') return <div className="loading">Loading…</div>;
  if (phase === 'signed-out') return <LoginView />;
  if (recovering) return <SetPasswordView />;
  return children;
}
