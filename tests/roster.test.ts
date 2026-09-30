import { describe, expect, it } from 'vitest';
import { createContext } from '../src/engine/context';
import { DEFAULT_SLOTS } from '../src/engine/lineup';
import { addMove, rosterCapacity } from '../src/engine/roster';
import { makeBundle } from './fixtures';

describe('roster rules', () => {
  const { bundle } = makeBundle();
  const ids = bundle.players.map((p) => p.id);
  const slots = DEFAULT_SLOTS; // 10 active + 3 bench, 1 IL
  const full = ids.slice(0, 13);
  const players = (ctx: ReturnType<typeof createContext>, list: string[]) => list.map((id) => ctx.byId.get(id)!);

  it('holds the active and bench slots, plus IL slots for players who are out', () => {
    const ctx = createContext(bundle);
    expect(rosterCapacity(ctx, slots, players(ctx, full))).toBe(13);
    const oneOut = createContext(bundle, { [full[0]]: { status: 'out' } });
    expect(rosterCapacity(oneOut, slots, players(oneOut, full))).toBe(14);
    const twoOut = createContext(bundle, { [full[0]]: { status: 'out' }, [full[1]]: { status: 'out' } });
    expect(rosterCapacity(twoOut, slots, players(twoOut, full))).toBe(14);
  });

  it('counts listed injuries unless marked healthy, and not day-to-day ones', () => {
    const injured = (status: 'out' | 'dtd') => ({
      ...bundle,
      players: bundle.players.map((p, i) => (i === 0 ? { ...p, injury: { date: '2026-11-01', note: 'knee', status } } : p)),
    });
    const out = createContext(injured('out'));
    expect(rosterCapacity(out, slots, players(out, full))).toBe(14);
    const cleared = createContext(injured('out'), { [full[0]]: { status: 'healthy' } });
    expect(rosterCapacity(cleared, slots, players(cleared, full))).toBe(13);
    const dtd = createContext(injured('dtd'));
    expect(rosterCapacity(dtd, slots, players(dtd, full))).toBe(13);
  });

  it('says what adding a player takes', () => {
    const ctx = createContext(bundle);
    const rosters = [full, [ids[20]], []];
    expect(addMove(ctx, slots, rosters, 0, full[3])).toEqual({ kind: 'on-team' });
    expect(addMove(ctx, slots, rosters, 0, ids[30])).toEqual({ kind: 'drop' });
    expect(addMove(ctx, slots, rosters, 1, ids[30])).toEqual({ kind: 'add' });
    expect(addMove(ctx, slots, rosters, 0, ids[20])).toEqual({ kind: 'trade', partner: 1 });
    expect(addMove(ctx, slots, rosters, 2, ids[20])).toEqual({ kind: 'trade', partner: 1 });
    // An injured player's IL slot makes room on a full roster.
    const hurt = createContext(bundle, { [full[0]]: { status: 'out' } });
    expect(addMove(hurt, slots, rosters, 0, ids[30])).toEqual({ kind: 'add' });
  });
});
