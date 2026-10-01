import { useState } from 'react';
import { useApp } from '../AppContext';
import { eligOf } from '../engine/context';
import { addMove } from '../engine/roster';
import { useLeague, useStore } from '../state/store';
import { InjuryBadge, UnsignedBadge } from './ui';

/**
 * Bring a player onto a team under the league's rules. A free agent with room on the roster is added right away;
 * anything else waits in `pending` for a choice in <MovePicker>: whom to drop from a full roster, or whom to send back
 * in a trade. `start` returns true when the player was added right away.
 */
export function useRosterMove() {
  const { ctx } = useApp();
  const slots = useLeague((l) => l.settings.slots);
  const rosters = useLeague((l) => l.rosters);
  const addPlayer = useStore((s) => s.addPlayer);
  const [pending, setPending] = useState<{ team: number; pid: string } | null>(null);
  const start = (team: number, pid: string) => {
    const move = addMove(ctx, slots, rosters, team, pid);
    if (move.kind === 'add') addPlayer(team, pid);
    setPending(move.kind === 'drop' || move.kind === 'trade' ? { team, pid } : null);
    return move.kind === 'add';
  };
  return { pending, start, cancel: () => setPending(null) };
}

/** Pick who leaves `team` so `pid` can join: dropped to waivers, or sent to the team `pid` comes from. */
export function MovePicker({ team, pid, onDone, onCancel }: { team: number; pid: string; onDone: () => void; onCancel: () => void }) {
  const { ctx, ownerOf, rosterOf } = useApp();
  const teamNames = useLeague((l) => l.settings.teamNames);
  const addPlayer = useStore((s) => s.addPlayer);
  const tradePlayers = useStore((s) => s.tradePlayers);
  const [out, setOut] = useState<string | null>(null);
  const incoming = ctx.byId.get(pid);
  const partner = ownerOf.get(pid);
  if (!incoming || partner === team) return null;
  const trade = partner !== undefined;
  const roster = rosterOf(team);
  const leaving = out !== null ? ctx.byId.get(out) : undefined;

  const confirm = () => {
    if (!out) return;
    if (trade) tradePlayers(team, pid, out);
    else addPlayer(team, pid, out);
    onDone();
  };

  return (
    <div className="move-picker" role="group" aria-label={trade ? `Trade for ${incoming.name}` : `Add ${incoming.name}`}>
      <div className="small">
        {trade ? (
          <>
            <b>{incoming.name}</b> is on {teamNames[partner]}, so he comes over in a trade. Pick who {teamNames[team]} sends back.
          </>
        ) : (
          <>
            {teamNames[team]}'s roster is full. Pick who to drop for <b>{incoming.name}</b>.
          </>
        )}
      </div>
      {roster.length ? (
        <div className="check-list">
          {roster.map((p) => (
            <label key={p.id} className="row check" style={{ padding: '3px 0' }}>
              <input type="radio" name={`leaving-${team}-${pid}`} checked={out === p.id} onChange={() => setOut(p.id)} />
              <span className="pname">
                <span className="n">{p.name}</span>
                <span className="meta">
                  {p.team} · {eligOf(ctx, p).join(',')}
                  <UnsignedBadge p={p} />
                  <InjuryBadge p={p} />
                </span>
              </span>
            </label>
          ))}
        </div>
      ) : (
        <div className="small muted">{teamNames[team]} has no players to trade.</div>
      )}
      <div className="row wrap">
        <button className="btn small primary" disabled={!leaving} onClick={confirm}>
          {!leaving ? (trade ? 'Pick who to send' : 'Pick who to drop') : trade ? `Trade ${leaving.name} for ${incoming.name}` : `Drop ${leaving.name}, add ${incoming.name}`}
        </button>
        <button className="btn small ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
