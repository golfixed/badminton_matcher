import type { Player, AppSettings, Match, Round, Schedule, PlayerStats } from './types';

const RANK_SCORE: Record<string, number> = {
  beginner: 1,
  intermediate: 2,
  pro: 3,
};

function pairKey(a: string, b: string): string {
  return a < b ? `${a}~${b}` : `${b}~${a}`;
}

function inc(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function get(map: Map<string, number>, key: string): number {
  return map.get(key) ?? 0;
}

function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function generateSchedule(players: Player[], settings: AppSettings): Schedule {
  const { courts, hours, minutesPerMatch, useRankMatching = true } = settings;
  const totalRounds = Math.floor((hours * 60) / minutesPerMatch);
  const generatedAt = Date.now();

  if (players.length < 4) {
    return { rounds: [], players, settings, generatedAt: Date.now() };
  }

  const scoreOf = new Map(players.map(p => [p.id, RANK_SCORE[p.rank]]));

  // Stagger offset: spread court start times evenly within a round
  // e.g. 2 courts, 15-min games → court 2 starts 7 min after court 1
  const staggerMin = courts > 1 ? Math.floor(minutesPerMatch / courts) : 0;

  // Frequency tracking across all rounds
  const togetherFreq = new Map<string, number>();
  const againstFreq = new Map<string, number>();
  const gamesPlayed = new Map<string, number>();
  // Consecutive rounds played (reset on rest, capped at 2 to force a break)
  const consecutivePlayed = new Map<string, number>();
  players.forEach(p => {
    gamesPlayed.set(p.id, 0);
    consecutivePlayed.set(p.id, 0);
  });

  const rounds: Round[] = [];

  for (let r = 0; r < totalRounds; r++) {
    // Players who played last round MUST rest this round (prevents blocking —
    // a player shouldn't start a new match while their current one may still be running)
    const mustRest = new Set(
      players.filter(p => (consecutivePlayed.get(p.id) ?? 0) >= 1).map(p => p.id)
    );

    // Build eligible pool — exclude forced-rest players
    // Safety fallback: if forcing rest leaves fewer players than needed to fill
    // all courts, let the least-consecutive forced-rest players back in
    let eligibleIds = players.map(p => p.id).filter(id => !mustRest.has(id));
    const needed = courts * 4;
    if (eligibleIds.length < needed) {
      const sorted = [...mustRest].sort(
        (a, b) => (consecutivePlayed.get(a) ?? 0) - (consecutivePlayed.get(b) ?? 0)
      );
      while (eligibleIds.length < needed && sorted.length > 0) {
        eligibleIds.push(sorted.shift()!);
      }
    }

    const available = new Set(eligibleIds);
    const roundMatches: Match[] = [];

    for (let c = 0; c < courts && available.size >= 4; c++) {
      // Sort available by games played ascending (prefer rested players)
      const avArr = Array.from(available).sort(
        (a, b) => (gamesPlayed.get(a) ?? 0) - (gamesPlayed.get(b) ?? 0)
      );

      let bestScore = Infinity;
      let bestT1: [string, string] | null = null;
      let bestT2: [string, string] | null = null;
      let bestSkillDiff = 0;

      // Limit search space for large groups: consider at most top 16 players
      const candidates = avArr.slice(0, Math.min(avArr.length, 16));

      for (let i = 0; i < candidates.length - 3; i++) {
        for (let j = i + 1; j < candidates.length - 2; j++) {
          for (let k = j + 1; k < candidates.length - 1; k++) {
            for (let l = k + 1; l < candidates.length; l++) {
              const four = [candidates[i], candidates[j], candidates[k], candidates[l]];
              const splits: [[string, string], [string, string]][] = [
                [[four[0], four[1]], [four[2], four[3]]],
                [[four[0], four[2]], [four[1], four[3]]],
                [[four[0], four[3]], [four[1], four[2]]],
              ];

              for (const [t1, t2] of splits) {
                const s1 = (scoreOf.get(t1[0]) ?? 1) + (scoreOf.get(t1[1]) ?? 1);
                const s2 = (scoreOf.get(t2[0]) ?? 1) + (scoreOf.get(t2[1]) ?? 1);
                const skillDiff = Math.abs(s1 - s2);

                const repeatPenalty =
                  get(togetherFreq, pairKey(t1[0], t1[1])) * 3 +
                  get(togetherFreq, pairKey(t2[0], t2[1])) * 3 +
                  get(againstFreq, pairKey(t1[0], t2[0])) +
                  get(againstFreq, pairKey(t1[0], t2[1])) +
                  get(againstFreq, pairKey(t1[1], t2[0])) +
                  get(againstFreq, pairKey(t1[1], t2[1]));

                // Penalize unequal rest distribution
                const playSum =
                  (gamesPlayed.get(four[0]) ?? 0) +
                  (gamesPlayed.get(four[1]) ?? 0) +
                  (gamesPlayed.get(four[2]) ?? 0) +
                  (gamesPlayed.get(four[3]) ?? 0);

                const score = (useRankMatching ? skillDiff * 4 : 0) + repeatPenalty * 2 + playSum * 0.5;

                if (score < bestScore) {
                  bestScore = score;
                  bestT1 = t1;
                  bestT2 = t2;
                  bestSkillDiff = skillDiff;
                }
              }
            }
          }
        }
      }

      if (bestT1 && bestT2) {
        const courtStartMin = r * minutesPerMatch + c * staggerMin;
        const match: Match = {
          id: `${generatedAt}_r${r + 1}_c${c + 1}`,
          court: c + 1,
          team1: bestT1,
          team2: bestT2,
          skillDiff: bestSkillDiff,
          courtStartTime: minutesToTime(courtStartMin),
        };
        roundMatches.push(match);

        const all = [...bestT1, ...bestT2];
        all.forEach(id => {
          available.delete(id);
          inc(gamesPlayed, id);
        });

        inc(togetherFreq, pairKey(bestT1[0], bestT1[1]));
        inc(togetherFreq, pairKey(bestT2[0], bestT2[1]));
        for (const a of bestT1) {
          for (const b of bestT2) {
            inc(againstFreq, pairKey(a, b));
          }
        }
      }
    }

    // Update consecutive-play counters for next round
    const playedThisRound = new Set(roundMatches.flatMap(m => [...m.team1, ...m.team2]));
    for (const p of players) {
      if (playedThisRound.has(p.id)) {
        consecutivePlayed.set(p.id, (consecutivePlayed.get(p.id) ?? 0) + 1);
      } else {
        consecutivePlayed.set(p.id, 0); // reset on any rest
      }
    }

    // Resting = any player not assigned to a match this round
    const resting = players.filter(p => !playedThisRound.has(p.id)).map(p => p.id);
    rounds.push({
      roundNumber: r + 1,
      startTime: minutesToTime(r * minutesPerMatch),
      matches: roundMatches,
      resting,
    });
  }

  return { rounds, players, settings, generatedAt };
}

export function computePlayerStats(schedule: Schedule): Map<string, PlayerStats> {
  const statsMap = new Map<string, PlayerStats>(
    schedule.players.map(p => [
      p.id,
      {
        id: p.id,
        matchesPlayed: 0,
        restRounds: 0,
        partners: new Map(),
        opponents: new Map(),
      },
    ])
  );

  for (const round of schedule.rounds) {
    const playing = new Set<string>();

    for (const match of round.matches) {
      const [a, b] = match.team1;
      const [c, d] = match.team2;
      [a, b, c, d].forEach(id => {
        playing.add(id);
        const s = statsMap.get(id);
        if (s) s.matchesPlayed++;
      });

      const addPartner = (id: string, pid: string) => {
        const s = statsMap.get(id);
        if (s) inc(s.partners, pid);
      };
      const addOpponent = (id: string, oid: string) => {
        const s = statsMap.get(id);
        if (s) inc(s.opponents, oid);
      };

      addPartner(a, b); addPartner(b, a);
      addPartner(c, d); addPartner(d, c);

      for (const t1p of [a, b]) {
        for (const t2p of [c, d]) {
          addOpponent(t1p, t2p);
          addOpponent(t2p, t1p);
        }
      }
    }

    for (const p of schedule.players) {
      if (!playing.has(p.id)) {
        const s = statsMap.get(p.id);
        if (s) s.restRounds++;
      }
    }
  }

  return statsMap;
}

export function countUniquePairs(schedule: Schedule): { played: number; total: number } {
  const n = schedule.players.length;
  const total = (n * (n - 1)) / 2;
  const seen = new Set<string>();

  for (const round of schedule.rounds) {
    for (const match of round.matches) {
      const all = [...match.team1, ...match.team2];
      for (let i = 0; i < all.length - 1; i++) {
        for (let j = i + 1; j < all.length; j++) {
          seen.add(pairKey(all[i], all[j]));
        }
      }
    }
  }

  return { played: seen.size, total };
}
