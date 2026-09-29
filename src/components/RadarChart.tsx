import { useEffect, useRef, useState } from 'react';

export interface RadarSeries {
  key: 'mine' | 'other';
  label: string;
  /** 0–100 per axis key. */
  values: Record<string, number>;
  /** Optional text per axis for the tooltip (e.g. the underlying stat). */
  detail?: Record<string, string>;
}

interface Props {
  axes: { key: string; label: string; muted?: boolean }[];
  series: RadarSeries[];
  /** Accessible summary. */
  title: string;
}

const SIZE = 320;
const C = SIZE / 2;
const R = 112;
const RINGS = [25, 50, 75, 100];

const reduceMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Tween numeric values toward their targets so the polygon glides as the team changes. */
function useTween(target: number[], ms = 380): number[] {
  const [cur, setCur] = useState(target);
  const from = useRef(target);
  const raf = useRef(0);
  const key = target.map((v) => v.toFixed(2)).join(',');
  useEffect(() => {
    if (reduceMotion() || from.current.length !== target.length) {
      from.current = target;
      setCur(target);
      return;
    }
    const start = performance.now();
    const a = from.current;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / ms);
      const e = 1 - (1 - k) ** 3;
      const next = target.map((v, i) => a[i] + (v - a[i]) * e);
      from.current = next;
      setCur(next);
      if (k < 1) raf.current = requestAnimationFrame(step);
    };
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return cur;
}

const point = (i: number, n: number, v: number) => {
  const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
  const r = (R * Math.max(0, Math.min(100, v))) / 100;
  return [C + r * Math.cos(a), C + r * Math.sin(a)] as const;
};

function Poly({ values, n, kind }: { values: number[]; n: number; kind: 'mine' | 'other' }) {
  const pts = values.map((v, i) => point(i, n, v));
  return (
    <g>
      <polygon className={`poly-${kind}`} points={pts.map((p) => p.join(',')).join(' ')} />
      {pts.map(([x, y], i) => (
        <circle key={i} className={`pt-${kind}`} cx={x} cy={y} r={4} />
      ))}
    </g>
  );
}

export function RadarChart({ axes, series, title }: Props) {
  const n = axes.length;
  const mine = series.find((s) => s.key === 'mine');
  const other = series.find((s) => s.key === 'other');
  const mineVals = useTween(axes.map((a) => mine?.values[a.key] ?? 50));
  const otherTarget = axes.map((a) => other?.values[a.key] ?? mine?.values[a.key] ?? 50);
  const otherVals = useTween(otherTarget);
  const [hover, setHover] = useState<number | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  if (n < 3) return <div className="empty">Pick at least three categories to draw the chart.</div>;

  const hv = hover !== null ? point(hover, n, 108) : null;

  return (
    <div className="radar" ref={wrap} style={{ position: 'relative' }}>
      <svg viewBox={`-34 -8 ${SIZE + 68} ${SIZE + 16}`} role="img" aria-label={title}>
        {RINGS.map((ring) => (
          <polygon
            key={ring}
            className={`ring${ring === 50 ? ' mid' : ''}`}
            points={axes.map((_, i) => point(i, n, ring).join(',')).join(' ')}
          />
        ))}
        {axes.map((_, i) => {
          const [x, y] = point(i, n, 100);
          return <line key={i} className="spoke" x1={C} y1={C} x2={x} y2={y} />;
        })}
        {other && <Poly values={otherVals} n={n} kind="other" />}
        {mine && <Poly values={mineVals} n={n} kind="mine" />}
        {axes.map((a, i) => {
          const [x, y] = point(i, n, 124);
          const anchor = Math.abs(x - C) < 6 ? 'middle' : x > C ? 'start' : 'end';
          return (
            <g key={a.key}>
              <text className="axis-label" x={x} y={y} textAnchor={anchor} dominantBaseline="middle" opacity={a.muted ? 0.45 : 1}>
                {a.label}
              </text>
              <text className="axis-val" x={x} y={y + 13} textAnchor={anchor} dominantBaseline="middle">
                {Math.round(mineVals[i])}
              </text>
            </g>
          );
        })}
        {/* Wedge-shaped hover targets, larger than the marks. */}
        {axes.map((a, i) => {
          const p1 = point(i - 0.5, n, 118);
          const p2 = point(i + 0.5, n, 118);
          return (
            <polygon
              key={`hit-${a.key}`}
              className="hit"
              points={`${C},${C} ${p1.join(',')} ${point(i, n, 130).join(',')} ${p2.join(',')}`}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              onClick={() => setHover((h) => (h === i ? null : i))}
            />
          );
        })}
      </svg>
      {hover !== null && hv && (
        <div
          className="tooltip"
          style={{
            left: `${((hv[0] + 34) / (SIZE + 68)) * 100}%`,
            top: `${((hv[1] + 8) / (SIZE + 16)) * 100}%`,
            transform: `translate(${hv[0] > C + 10 ? '-100%' : hv[0] < C - 10 ? '0' : '-50%'}, ${hv[1] > C ? '-110%' : '10%'})`,
          }}
        >
          <div style={{ fontWeight: 650, marginBottom: 2 }}>{axes[hover].label}</div>
          {series.map((s) => (
            <div key={s.key} className="row" style={{ gap: 6 }}>
              <span className={`dot ${s.key}`} />
              <span>{s.label}</span>
              <span className="spacer" />
              <b className="num">{Math.round(s.values[axes[hover].key] ?? 0)}</b>
              {s.detail?.[axes[hover].key] && <span className="muted">· {s.detail[axes[hover].key]}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
