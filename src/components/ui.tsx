import type { ReactNode } from 'react';
import type { PlayerData } from '../data/types';
import { useApp } from '../AppContext';

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function InjuryBadge({ p }: { p: PlayerData }) {
  const { ctx } = useApp();
  const o = ctx.overrides[p.id];
  if (o?.status === 'out') return <span className="badge out" title="Marked out">OUT</span>;
  if (o?.status === 'healthy' || !p.injury) return null;
  return (
    <span className={`badge ${p.injury.status}`} title={p.injury.note}>
      {p.injury.status === 'out' ? 'OUT' : 'DTD'}
    </span>
  );
}

/** Player name with team/position; opens the player sheet. */
export function PlayerName({ p, extra }: { p: PlayerData; extra?: ReactNode }) {
  const { openPlayer, ctx } = useApp();
  const elig = ctx.overrides[p.id]?.elig ?? p.elig;
  return (
    <button type="button" className="link pname" onClick={() => openPlayer(p.id)}>
      <span className="n">{p.name}</span>
      <span className="meta">
        {p.team} · {elig.join(',')}
        {p.rookie && <span className="badge rookie">R</span>}
        <InjuryBadge p={p} />
        {extra}
      </span>
    </button>
  );
}

/** Horizontal split bar: my win probability (blue) vs the opponent's (orange). */
export function ProbBar({ p, label }: { p: number; label?: string }) {
  return (
    <div className="probbar" role="img" aria-label={label ?? `${Math.round(p * 100)}% chance to win`}>
      <span style={{ width: `${Math.max(0, Math.min(1, p)) * 100}%` }} />
    </div>
  );
}

export const pct = (p: number) => `${Math.round(p * 100)}%`;

export function Delta({ v, digits = 2, suffix = '' }: { v: number; digits?: number; suffix?: string }) {
  if (Math.abs(v) < 10 ** -digits / 2) return <span className="muted">±0{suffix}</span>;
  return (
    <span className={v > 0 ? 'delta-up' : 'delta-down'}>
      {v > 0 ? '▲ +' : '▼ '}
      {v.toFixed(digits)}
      {suffix}
    </span>
  );
}

/** Diverging background for a z-score cell (blue good, red bad, gray neutral). */
export function zStyle(z: number): React.CSSProperties {
  const a = Math.min(0.55, Math.abs(z) * 0.22);
  if (Math.abs(z) < 0.15) return {};
  return { background: `rgba(var(${z > 0 ? '--pos' : '--neg'}), ${a})` };
}

export const Icon = {
  draft: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3l8.5 6.2-3.2 10H6.7L3.5 9.2z" />
      <path d="M12 8l3.6 2.6-1.4 4.2H9.8L8.4 10.6z" />
    </svg>
  ),
  matchup: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 7h7M4 12h11M4 17h5" />
      <path d="M20 7h-3M20 12h-1M20 17h-7" />
    </svg>
  ),
  league: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z" />
      <path d="M7 6H4v2a3 3 0 0 0 3 3M17 6h3v2a3 3 0 0 1-3 3" />
    </svg>
  ),
  stream: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 17l5-5 4 4 7-8" />
      <path d="M15 8h5v5" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="10" cy="12" r="2" />
      <circle cx="18" cy="18" r="2" />
    </svg>
  ),
  close: (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  ),
};
