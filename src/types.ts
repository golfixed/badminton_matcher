export type Rank = 'beginner' | 'intermediate' | 'pro';
export type TabId = 'setup' | 'schedule' | 'summary' | 'history' | 'help';

export interface Player {
  id: string;
  name: string;
  rank: Rank;
}

export interface AppSettings {
  courts: number;
  hours: number;
  minutesPerMatch: number;
  useRankMatching: boolean;
}

export interface Match {
  id: string;
  court: number;
  team1: [string, string];
  team2: [string, string];
  skillDiff: number;
  courtStartTime?: string; // staggered start time for this specific court
}

export interface MatchResult {
  matchId: string;
  winner: 1 | 2;
  recordedAt: number;
}

export interface Round {
  roundNumber: number;
  startTime: string;
  matches: Match[];
  resting: string[];
}

export interface Schedule {
  rounds: Round[];
  players: Player[];
  settings: AppSettings;
  generatedAt: number;
}

export interface Session {
  id: string;
  date: string;       // 'YYYY-MM-DD'
  label: string;      // optional user note
  schedule: Schedule;
  results: Record<string, 1 | 2>;
  savedAt: number;
}

export interface PlayerStats {
  id: string;
  matchesPlayed: number;
  restRounds: number;
  partners: Map<string, number>;
  opponents: Map<string, number>;
}
