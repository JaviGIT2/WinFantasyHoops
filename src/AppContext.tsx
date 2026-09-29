import { createContext, useContext } from 'react';
import type { DataBundle, PlayerData } from './data/types';
import type { EngineCtx } from './engine/context';
import type { FantasyWeek } from './engine/schedule';

export interface AppValue {
  data: DataBundle;
  ctx: EngineCtx;
  weeks: FantasyWeek[];
  /** Planning date: real today unless overridden in settings. */
  today: string;
  openPlayer: (id: string) => void;
  /** Team index owning each rostered player. */
  ownerOf: Map<string, number>;
  rosterOf: (team: number) => PlayerData[];
  freeAgents: PlayerData[];
}

export const AppContext = createContext<AppValue | null>(null);

export function useApp(): AppValue {
  const v = useContext(AppContext);
  if (!v) throw new Error('useApp outside provider');
  return v;
}
