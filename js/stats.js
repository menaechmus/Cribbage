// Lifetime statistics. The UI keeps this object in localStorage; nothing here
// touches storage, so it can be tested directly. Only finished games count.
// Hand, crib and pegging figures are the person's (seat 0) against the
// computer; games between people count each person's games and wins, by name.

import { skunk, sideOf } from './game.js';

const levelRow = () => ({ games: 0, wins: 0, streak: 0, bestStreak: 0, skunks: 0, skunked: 0 });
const personRow = () => ({ name: '', games: 0, wins: 0 });

export function emptyStats() {
  return {
    ai: { easy: levelRow(), medium: levelRow(), hard: levelRow() },
    people: {}, // by name, lower case: { name, games, wins }
    totals: { deals: 0, pegging: 0, hand: { count: 0, points: 0 }, crib: { count: 0, points: 0 } },
    records: { hand: 0, crib: 0, margin: 0 },
  };
}

// Pours saved data into the current shape, so a missing or damaged entry
// falls back to zero instead of breaking the page.
function fill(shape, saved) {
  if (typeof shape === 'string') return typeof saved === 'string' ? saved.slice(0, 40) : shape;
  if (Array.isArray(shape)) return shape.map((item, i) => fill(item, saved?.[i]));
  if (typeof shape === 'object') {
    return Object.fromEntries(Object.entries(shape).map(([key, item]) => [key, fill(item, saved?.[key])]));
  }
  return Number.isFinite(saved) ? saved : shape;
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keyOf = name => name.toLowerCase().slice(0, 40);

export function loadStats(saved) {
  const stats = fill(emptyStats(), saved);
  if (isObject(saved?.people)) {
    for (const [key, person] of Object.entries(saved.people).slice(0, 200)) {
      if (isObject(person)) stats.people[key.slice(0, 40)] = fill(personRow(), person);
    }
  }
  // Before 1.6.0 two people on one device were only "Player 1" and "Player 2".
  const old = saved?.twoPlayer;
  if (isObject(old) && Number.isFinite(old.games) && old.games > 0) {
    ['Player 1', 'Player 2'].forEach((name, seat) => {
      const person = (stats.people[keyOf(name)] ??= { ...personRow(), name });
      person.games += old.games;
      person.wins += Number.isFinite(old.wins?.[seat]) ? old.wins[seat] : 0;
    });
  }
  return stats;
}

export function recordGame(stats, game) {
  if (game.mode !== 'ai') {
    game.players.forEach(({ name, ai }, seat) => {
      if (ai) return;
      const person = (stats.people[keyOf(name)] ??= { ...personRow(), name });
      person.name = name;
      person.games++;
      if (sideOf(game, seat) === game.winner) person.wins++;
    });
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
