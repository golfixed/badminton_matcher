import type { Player, AppSettings, Schedule, Session } from './types';
import { dbRead, dbWrite, dbDelete } from './db';

const DEFAULT_SETTINGS: AppSettings = {
  courts: 2,
  hours: 2,
  minutesPerMatch: 15,
  useRankMatching: true,
};

export const storage = {
  loadPlayers:   (): Player[]   => dbRead<Player[]>('bm_players', []),
  savePlayers:   (players: Player[]): void => dbWrite('bm_players', players),

  loadSettings:  (): AppSettings => dbRead<AppSettings>('bm_settings', DEFAULT_SETTINGS),
  saveSettings:  (settings: AppSettings): void => dbWrite('bm_settings', settings),

  loadSchedule:  (): Schedule | null => dbRead<Schedule | null>('bm_schedule', null),
  saveSchedule:  (schedule: Schedule): void => dbWrite('bm_schedule', schedule),
  clearSchedule: (): void => dbDelete('bm_schedule'),

  loadResults:   (): Record<string, 1 | 2> => dbRead<Record<string, 1 | 2>>('bm_results', {}),
  saveResults:   (results: Record<string, 1 | 2>): void => dbWrite('bm_results', results),
  clearResults:  (): void => dbDelete('bm_results'),

  loadSessions:  (): Session[] => dbRead<Session[]>('bm_sessions', []),
  saveSessions:  (sessions: Session[]): void => dbWrite('bm_sessions', sessions),
};
