// Computer opponent and hints. Every function sees only what that seat could
// know: its own cards, the starter and the cards already played.

import { rank, suit, value, cardName, JACK } from './cards.js';
import { rankPoints, handPoints, pegScore } from './scoring.js';

const choose = (n, k) => {
  let result = 1;
  for (let i = 0; i < k; i++) result = (result * (n - i)) / (i + 1);
  return n < k ? 0 : result;
};

// The fifteen ways to split six cards into four kept and two thrown.
function splits(hand) {
  const result = [];
  for (let i = 0; i < hand.length; i++) {
    for (let j = i + 1; j < hand.length; j++) {
      result.push({ toss: [hand[i], hand[j]], keep: hand.filter((_, k) => k !== i && k !== j) });
    }
  }
  return result;
}

// Expected crib score for two thrown cards, treating the opponent's two cards
// and the starter as equally likely draws from the 46 cards we cannot see.
// Fifteens, pairs and runs only depend on ranks, so it is enough to walk the
// 455 rank triples, each weighted by how many ways it can be drawn.
function cribAverage(toss, hand) {
  const rankLeft = new Array(13).fill(4);
  const suitLeft = new Array(4).fill(13);
  for (const c of hand) {
    rankLeft[rank(c)]--;
    suitLeft[suit(c)]--;
  }
  const counts = new Array(13).fill(0);
  for (const c of toss) counts[rank(c)]++;

  let total = 0;
  for (let a = 0; a < 13; a++) {
    for (let b = a; b < 13; b++) {
      for (let c = b; c < 13; c++) {
        let ways;
        if (a === c) ways = choose(rankLeft[a], 3);
        else if (a === b) ways = choose(rankLeft[a], 2) * rankLeft[c];
        else if (b === c) ways = rankLeft[a] * choose(rankLeft[b], 2);
        else ways = rankLeft[a] * rankLeft[b] * rankLeft[c];
        if (!ways) continue;
        counts[a]++; counts[b]++; counts[c]++;
        total += ways * rankPoints(counts);
        counts[a]--; counts[b]--; counts[c]--;
      }
    }
  }
  const draws = choose(46, 3);
  let average = total / draws;

  // A crib flush needs all five cards in one suit.
  if (suit(toss[0]) === suit(toss[1])) average += (5 * choose(suitLeft[suit(toss[0])], 3)) / draws;

  // Nobs: a Jack in the crib matching the starter's suit.
  for (let s = 0; s < 4; s++) {
    const jack = s * 13 + JACK;
    if (toss.includes(jack)) average += suitLeft[s] / 46;
    else if (!hand.includes(jack)) average += ((suitLeft[s] - 1) / 46) * (2 / 45);
  }
  return average;
}

// Every discard option, best first. `hand` is the average score of the kept
// cards over all 46 possible starters; `crib` is the expected crib score.
export function rateDiscards(hand, isDealer) {
  const unseen = [];
  for (let c = 0; c < 52; c++) if (!hand.includes(c)) unseen.push(c);

  return splits(hand)
    .map(({ keep, toss }) => {
      const average = unseen.reduce((sum, starter) => sum + handPoints(keep, starter), 0) / unseen.length;
      const crib = cribAverage(toss, hand);
      return { keep, toss, now: handPoints(keep, null), hand: average, crib, value: average + (isDealer ? crib : -crib) };
    })
    .sort((a, b) => b.value - a.value);
}

// How the weaker levels fall short. `randomToss` is the chance of throwing two
// cards without looking; otherwise they keep the four that seem to score most,
// misjudging each option by up to `tossNoise` points. `takePoints` is the
// chance of noticing points on offer in the play. Neither level thinks about
// the starter, the crib or what a card gives away.
const LEVELS = {
  easy: { randomToss: 0.4, tossNoise: 5, takePoints: 0.2 },
  medium: { randomToss: 0.05, tossNoise: 3, takePoints: 0.75 },
};

const pickAny = list => list[Math.floor(Math.random() * list.length)];

export function pickDiscard(game, player, level = game.difficulty) {
  const hand = game.hands[player];
  if (level === 'hard') return rateDiscards(hand, game.dealer === player)[0].toss;

  const { randomToss, tossNoise } = LEVELS[level] ?? LEVELS.medium;
  const options = splits(hand);
  if (Math.random() < randomToss) return pickAny(options).toss;

  let best = null;
  let bestScore = -Infinity;
  for (const { keep, toss } of options) {
    const score = handPoints(keep, null) + Math.random() * tossNoise;
    if (score > bestScore) {
      bestScore = score;
      best = toss;
    }
  }
  return best;
}

function unseenCards(game, player) {
  const seen = new Set([...game.kept[player], ...game.discards[player], game.starter, ...game.pile.map(p => p.card)]);
  const unseen = [];
  for (let c = 0; c < 52; c++) if (!seen.has(c)) unseen.push(c);
  return unseen;
}

// With the opponent out of cards, the most points the remaining cards can peg,
// trying every order.
function soloBest(hand, stack, count) {
  if (!hand.length) return 0;
  const legal = hand.filter(c => count + value(c) <= 31);
  if (!legal.length) return 1 + soloBest(hand, [], 0); // go, then a new count
  let best = 0;
  for (const card of legal) best = Math.max(best, soloPlay(hand, stack, count, card));
  return best;
}

function soloPlay(hand, stack, count, card) {
  const rest = hand.filter(c => c !== card);
  const next = [...stack, card];
  const total = count + value(card);
  const points = pegScore(next).points;
  if (total === 31) return points + soloBest(rest, [], 0);
  if (!rest.length) return points + 1; // last card
  return points + soloBest(rest, next, total);
}

// Every legal card, best first. A card is worth what it scores now, minus what
// the opponent can be expected to score in reply, plus a share of what we
// could then score back.
export function ratePlays(game, player) {
  const hand = game.hands[player];
  const unseen = unseenCards(game, player);
  const opponentCards = game.hands[1 - player].length;

  return hand
    .filter(c => game.count + value(c) <= 31)
    .map(card => {
      const stack = [...game.stack, card];
      const count = game.count + value(card);
      const rest = hand.filter(c => c !== card);
      const { points, items } = pegScore(stack);
      let worth = points;

      if (!opponentCards) {
        worth = soloPlay(hand, game.stack, game.count, card);
      } else if (count < 31) {
        let risk = 0;
        let comeback = 0;
        let replies = 0;
        for (const reply of unseen) {
          if (count + value(reply) > 31) continue;
          replies++;
          const after = [...stack, reply];
          risk += pegScore(after).points;
          let best = 0;
          for (const mine of rest) {
            if (count + value(reply) + value(mine) <= 31) best = Math.max(best, pegScore([...after, mine]).points);
          }
          comeback += best;
        }
        worth -= (opponentCards / unseen.length) * risk;
        if (replies) worth += (0.5 * comeback) / replies;
        // Chance the opponent cannot answer at all, which hands us the go.
        worth += (1 - replies / unseen.length) ** opponentCards;
      }

      worth += value(card) * 0.01; // all else equal, shed high cards first
      return { card, points, items, value: worth };
    })
    .sort((a, b) => b.value - a.value);
}

export function pickPlay(game, player, level = game.difficulty) {
  if (level === 'hard') return ratePlays(game, player)[0].card;

  const legal = game.hands[player].filter(c => game.count + value(c) <= 31);
  let best = pickAny(legal);
  if (Math.random() >= (LEVELS[level] ?? LEVELS.medium).takePoints) return best;

  // Having noticed, play whichever card scores most right now.
  let bestPoints = 0;
  for (const card of legal) {
    const points = pegScore([...game.stack, card]).points;
    if (points > bestPoints) {
      bestPoints = points;
      best = card;
    }
  }
  return best;
}

// The strongest move for a seat, with a short explanation. Shares the hard
// opponent's evaluation, so the two never disagree.
export function hint(game, player) {
  if (game.phase === 'discard') {
    const isDealer = game.dealer === player;
    const best = rateDiscards(game.hands[player], isDealer)[0];
    return {
      cards: best.toss,
      text:
        `Throw ${best.toss.map(cardName).join(' and ')}. You keep ${best.now} ` +
        `(about ${best.hand.toFixed(1)} after the cut) and ` +
        `${isDealer ? 'your' : 'their'} crib gains about ${best.crib.toFixed(1)}.`,
    };
  }

  const plays = ratePlays(game, player);
  if (!plays.length) return { cards: [], text: 'None of your cards fits under 31, so say go.' };
  const best = plays[0];
  const card = cardName(best.card);
  let text;
  if (plays.length === 1) text = `${card} is the only card you can play.`;
  else if (best.points) text = `Play ${card} for ${best.points}: ${best.items.map(item => item.label.toLowerCase()).join(' and ')}.`;
  else if (!game.stack.length) text = `Lead ${card}. It gives the least away.`;
  else text = `Play ${card}. Nothing scores now, and it gives the least away.`;
  return { cards: [best.card], text };
}
