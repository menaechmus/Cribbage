import { rank, suit, value, JACK } from './cards.js';

// Itemised score for four cards plus the starter. A crib only scores a flush
// when all five cards match.
export function scoreHand(hand, starter, isCrib = false) {
  const all = [...hand, starter];
  const items = [];
  const subsets = [];
  for (let mask = 1; mask < 1 << all.length; mask++) {
    subsets.push(all.filter((_, i) => mask & (1 << i)));
  }

  for (const cards of subsets) {
    if (cards.reduce((sum, c) => sum + value(c), 0) === 15) items.push({ type: 'fifteen', points: 2, cards });
  }

  for (const cards of subsets) {
    if (cards.length === 2 && rank(cards[0]) === rank(cards[1])) items.push({ type: 'pair', points: 2, cards });
  }

  // Only the longest runs count: a run of four is not also two runs of three.
  for (let length = all.length; length >= 3; length--) {
    const runs = subsets.filter(cards => cards.length === length && isRun(cards));
    for (const cards of runs) items.push({ type: 'run', points: length, cards });
    if (runs.length) break;
  }

  if (hand.every(c => suit(c) === suit(hand[0]))) {
    if (suit(starter) === suit(hand[0])) items.push({ type: 'flush', points: 5, cards: all });
    else if (!isCrib) items.push({ type: 'flush', points: 4, cards: hand });
  }

  const nob = hand.find(c => rank(c) === JACK && suit(c) === suit(starter));
  if (nob !== undefined) items.push({ type: 'nobs', points: 1, cards: [nob] });

  return { total: items.reduce((sum, item) => sum + item.points, 0), items };
}

function isRun(cards) {
  const ranks = cards.map(rank).sort((a, b) => a - b);
  return ranks.every((r, i) => i === 0 || r === ranks[i - 1] + 1);
}

// Collapses itemised scores into display lines such as "3 fifteens — 6".
export function summarize(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.type === 'run' ? `run${item.points}` : item.type;
    const group = groups.get(key) ?? { item, count: 0, points: 0 };
    group.count++;
    group.points += item.points;
    groups.set(key, group);
  }
  return [...groups.values()].map(({ item, count, points }) => {
    const many = count > 1;
    const label = {
      fifteen: many ? `${count} fifteens` : 'Fifteen',
      pair: many ? `${count} pairs` : 'Pair',
      run: many ? `${count} runs of ${item.points}` : `Run of ${item.points}`,
      flush: 'Flush',
      nobs: 'Nobs (Jack of the starter suit)',
    }[item.type];
    return { label, points };
  });
}

// Fifteens, pairs and runs depend only on ranks, so they can be scored from a
// rank histogram (counts[0..12]). The AI uses this to average over thousands
// of possible hands without building card lists.
const CHOOSE = [[1], [1, 1], [1, 2, 1], [1, 3, 3, 1], [1, 4, 6, 4, 1]];
const waysToSum = new Int32Array(16);

export function rankPoints(counts) {
  let points = 0;
  let run = 0;
  let copies = 1;
  for (let r = 0; r <= 13; r++) {
    const n = r < 13 ? counts[r] : 0;
    points += n * (n - 1); // two points for each pair among n cards
    if (n) {
      run++;
      copies *= n;
    } else {
      if (run >= 3) points += run * copies;
      run = 0;
      copies = 1;
    }
  }

  waysToSum.fill(0);
  waysToSum[0] = 1;
  for (let r = 0; r < 13; r++) {
    const n = counts[r];
    if (!n) continue;
    const v = Math.min(r + 1, 10);
    for (let sum = 15; sum >= v; sum--) {
      for (let k = 1; k <= n && k * v <= sum; k++) waysToSum[sum] += CHOOSE[n][k] * waysToSum[sum - k * v];
    }
  }
  return points + 2 * waysToSum[15];
}

// Total only, same rules as scoreHand. Pass starter = null to score four cards
// before the cut.
export function handPoints(hand, starter, isCrib = false) {
  const counts = new Array(13).fill(0);
  for (const c of hand) counts[rank(c)]++;
  let points = 0;
  if (starter !== null) {
    counts[rank(starter)]++;
    if (hand.some(c => rank(c) === JACK && suit(c) === suit(starter))) points++;
  }
  if (hand.every(c => suit(c) === suit(hand[0]))) {
    if (starter !== null && suit(starter) === suit(hand[0])) points += 5;
    else if (!isCrib) points += 4;
  }
  return points + rankPoints(counts);
}

// Points for the card just played. `stack` holds the cards of the current
// count in play order, newest last.
export function pegScore(stack) {
  const items = [];
  let count = 0;
  for (const c of stack) count += value(c);
  if (count === 15) items.push({ label: 'Fifteen', points: 2 });
  if (count === 31) items.push({ label: 'Thirty-one', points: 2 });

  const last = stack.length - 1;
  let same = 1;
  while (same <= last && rank(stack[last - same]) === rank(stack[last])) same++;
  if (same > 1) items.push({ label: ['Pair', 'Pair royal', 'Double pair royal'][same - 2], points: same * (same - 1) });

  // Walk back from the newest card. The last `length` cards form a run when
  // their ranks are all different and span exactly `length`; a repeated rank
  // rules out every longer run as well.
  let seen = 0;
  let low = 13;
  let high = -1;
  let run = 0;
  for (let i = last; i >= 0; i--) {
    const r = rank(stack[i]);
    if (seen & (1 << r)) break;
    seen |= 1 << r;
    low = Math.min(low, r);
    high = Math.max(high, r);
    const length = last - i + 1;
    if (length >= 3 && high - low === length - 1) run = length;
  }
  if (run) items.push({ label: `Run of ${run}`, points: run });

  let points = 0;
  for (const item of items) points += item.points;
  return { points, items };
}
