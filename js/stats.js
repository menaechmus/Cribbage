// Lifetime statistics. The UI keeps this object in localStorage; nothing here
// touches storage, so it can be tested directly. Only finished games count.
// Hand, crib and pegging figures are the human's (seat 0) against the computer.

import { skunk } from './game.js';

export function emptyStats() {
  const row = () => ({ games: 0, wins: 0, streak: 0, bestStreak: 0, skunks: 0, skunked: 0 });
  return {
    ai: { easy: row(), medium: row(), hard: row() },
    twoPlayer: { games: 0, wins: [0, 0] },
    totals: { deals: 0, pegging: 0, hand: { count: 0, points: 0 }, crib: { count: 0, points: 0 } },
    records: { hand: 0, crib: 0, margin: 0 },
  };
}

// Pours saved data into the current shape, so a missing or damaged entry
// falls back to zero instead of breaking the page.
function fill(shape, saved) {
  if (Array.isArray(shape)) return shape.map((item, i) => fill(item, saved?.[i]));
  if (typeof shape === 'object') {
    return Object.fromEntries(Object.entries(shape).map(([key, item]) => [key, fill(item, saved?.[key])]));
  }
  return Number.isFinite(saved) ? saved : shape;
}

export const loadStats = saved => fill(emptyStats(), saved);

export function recordGame(stats, game) {
  if (game.mode !== 'ai') {
    stats.twoPlayer.games++;
    stats.twoPlayer.wins[game.winner]++;
    return;
  }

  const row = stats.ai[game.difficulty];
  const won = game.winner === 0;
  row.games++;
  if (won) {
    row.wins++;
    row.streak++;
    row.bestStreak = Math.max(row.bestStreak, row.streak);
  } else {
    row.streak = 0;
  }
  if (skunk(game)) row[won ? 'skunks' : 'skunked']++;

  const mine = game.tally[0];
  const { totals, records } = stats;
  totals.deals += game.deals;
  totals.pegging += mine.pegging;
  for (const kind of ['hand', 'crib']) {
    totals[kind].count += mine[kind].count;
    totals[kind].points += mine[kind].points;
    records[kind] = Math.max(records[kind], mine[kind].best);
  }
  if (won) records.margin = Math.max(records.margin, game.scores[0] - game.scores[1]);
}
