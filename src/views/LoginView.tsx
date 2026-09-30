import { useState, type FormEvent, type ReactNode } from 'react';
import { sendPasswordReset, setNewPassword, signIn, signUp, skipNewPassword, useAuth } from '../cloud/auth';
import { Segmented } from '../components/ui';

type Mode = 'signin' | 'signup' | 'reset';

function AuthCard({ children, onSubmit }: { children: ReactNode; onSubmit: (e: FormEvent) => void }) {
  return (
    <div className="auth-page">
      <form className="card stack auth-card" onSubmit={onSubmit}>
        <div className="auth-brand">
          <img src={`${import.meta.env.BASE_URL}icons/icon.svg`} alt="" />
          <div>
            <h1>Win Fantasy Hoops</h1>
            <p className="small secondary">Your leagues, rosters and settings on every device.</p>
          </div>
        </div>
        {children}
      </form>
    </div>
  );
}

function Messages({ error, info }: { error: string | null; info: string | null }) {
  return (
    <>
      {error && <div className="notice error" role="alert">{error}</div>}
      {info && <div className="notice" role="status">{info}</div>}
    </>
  );
}

export function LoginView() {
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(() => useAuth.getState().message);
  const [info, setInfo] = useState<string | null>(null);

  const switchMode = (m: Mode) => {
    setMode(m);
    setError(null);
    setInfo(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    // Once signed in, the app replaces this screen after loading the account's leagues; stay busy until then.
    let signedIn = false;
    try {
      if (mode === 'signin') {
        const err = await signIn(email, password);
        setError(err);
        signedIn = !err;
      } else if (mode === 'signup') {
        const r = await signUp(email, password);
        setError(r.error);
        if (r.confirm) setInfo(`Check ${email} for a link to confirm your address, then sign in.`);
        signedIn = !r.error && !r.confirm;
      } else {
        const err = await sendPasswordReset(email);
        setError(err);
        if (!err) setInfo(`If ${email} has an account, a link to choose a new password is on its way.`);
      }
    } finally {
      if (!signedIn) setBusy(false);
    }
  };

  const label = { signin: 'Sign in', signup: 'Create account', reset: 'Send reset link' }[mode];
  return (
    <AuthCard onSubmit={submit}>
      {mode === 'reset' ? (
        <div>
          <h2>Reset your password</h2>
          <p className="small secondary" style={{ margin: '4px 0 0' }}>We'll email you a link to choose a new one.</p>
        </div>
      ) : (
        <Segmented
          label="Account"
          value={mode}
          onChange={switchMode}
          options={[
            { value: 'signin', label: 'Sign in' },
            { value: 'signup', label: 'Create account' },
          ]}
        />
      )}
      <label className="field">
        Email
        <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value.trim())} />
      </label>
      {mode !== 'reset' && (
        <label className="field">
          Password
          <input
            type="password"
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            required
            minLength={mode === 'signup' ? 8 : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {mode === 'signup' && <span className="small muted">At least 8 characters.</span>}
        </label>
      )}
      <Messages error={error} info={info} />
      <button className="btn primary block" disabled={busy}>
        {busy ? 'One moment…' : label}
      </button>
      {mode === 'signin' && (
        <button type="button" className="textlink" onClick={() => switchMode('reset')}>
          Forgot your password?
        </button>
      )}
      {mode === 'reset' && (
        <button type="button" className="textlink" onClick={() => switchMode('signin')}>
          Back to sign in
        </button>
      )}
    </AuthCard>
  );
}

/** Shown after following a password-reset email. */
export function SetPasswordView() {
  const email = useAuth((a) => a.account?.email);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(await setNewPassword(password));
    setBusy(false);
  };

  return (
    <AuthCard onSubmit={submit}>
      <div>
        <h2>Choose a new password</h2>
        {email && <p className="small secondary" style={{ margin: '4px 0 0' }}>For {email}</p>}
      </div>
      <label className="field">
        New password
        <input type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
        <span className="small muted">At least 8 characters.</span>
      </label>
      <Messages error={error} info={null} />
      <button className="btn primary block" disabled={busy}>
        {busy ? 'One moment…' : 'Save password'}
      </button>
      <button type="button" className="textlink" onClick={skipNewPassword}>
        Not now
      </button>
    </AuthCard>
  );
}
