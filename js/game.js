// Rules of cribbage for two, three or four players. Two are dealt six cards
// each; three or four are dealt five. Three play each for themselves; four
// play as two partnerships, partners sitting opposite (seats 0 and 2 against
// 1 and 3) and sharing a score. No DOM here: the game is one plain object
// that survives JSON.stringify, changed only through the exported actions.
// Each action leaves a list of what happened in game.events.

import { shuffledDeck, sortCards, value, rank, JACK } from './cards.js';
import { scoreHand, pegScore } from './scoring.js';

function check(ok, message) {
  if (!ok) throw new Error(message);
}

// Scores, pegs and wins belong to sides: each player's own, or with four
// players each partnership's. Seats take turns round the table in order.
export const sideOf = (game, seat) => (game.players.length === 4 ? seat % 2 : seat);
export const sideCount = game => (game.players.length === 4 ? 2 : game.players.length);
export const seatsOf = (game, side) => game.players.map((_, seat) => seat).filter(seat => sideOf(game, seat) === side);
export const tossCount = game => (game.players.length === 2 ? 2 : 1);
const nextSeat = (game, seat, steps = 1) => (seat + steps) % game.players.length;

// Where a seat's points came from, for the end-of-game summary and statistics.
const newTally = () => ({
  pegging: 0,
  hand: { count: 0, points: 0, best: 0 },
  crib: { count: 0, points: 0, best: 0 },
});

// Tells one game from the next, for the phones of a Wi-Fi game. Not drawn
// from Math.random, so a seeded test deals as it always has.
let made = 0;
const newId = () => `${Date.now().toString(36)}${(made++).toString(36)}`;

const defaultPlayers = (mode, difficulty) =>
  mode === 'ai' ? [{ name: 'You' }, { name: 'Computer', ai: true, level: difficulty }] : [{ name: 'Player 1' }, { name: 'Player 2' }];

const seated = ({ name, ai = false, level }, difficulty) => ({ name, ai, ...(ai ? { level: level ?? difficulty } : {}) });

// `players` is a list of { name, ai, level }: two to four of them. A computer
// plays at its own `level`, which against the computer alone is `difficulty`.
export function newGame({ mode = 'ai', difficulty = 'medium', target = 121, players = defaultPlayers(mode, difficulty) } = {}) {
  check(players.length >= 2 && players.length <= 4, 'A game needs two to four players');
  const sides = players.length === 4 ? 2 : players.length;
  const game = {
    v: 2,
    id: newId(),
    mode,
    difficulty,
    target,
    players: players.map(player => seated(player, difficulty)),
    dealer: Math.floor(Math.random() * players.length),
    scores: new Array(sides).fill(0),
    back: new Array(sides).fill(-1), // trailing pegs; -1 is the second starting hole
    winner: null, // the side that wins
    deals: 0,
    tally: players.map(newTally),
  };
  deal(game);
  return game;
}

// A game saved by version 1 (two players, before names) as this version
// keeps it, so that a game in progress survives an update.
export function upgradeGame(saved) {
  if (saved?.v !== 1) return saved;
  const { goCalled, ...rest } = saved;
  const last = saved.stack?.length ? saved.pile.at(-1).player : null;
  const said = [false, false];
  if (goCalled && last !== null) said[1 - last] = true;
  return {
    ...rest,
    v: 2,
    id: newId(),
    mode: saved.mode === 'ai' ? 'ai' : 'local',
    players: defaultPlayers(saved.mode === 'ai' ? 'ai' : 'local', saved.difficulty).map(player => seated(player, saved.difficulty)),
    said,
    last,
  };
}

// Starts a hand. Tests pass a stacked deck: each seat's cards in turn from
// seat 0 (six each for two players, five for three or four), then with
// three players one card for the crib, then the card that will be cut.
export function deal(game, deck = shuffledDeck()) {
  const count = game.players.length;
  const size = count === 2 ? 6 : 5;
  game.deals++;
  let next = count * size;
  const crib = count === 3 ? [deck[next++]] : [];
  Object.assign(game, {
    phase: 'discard',
    hands: game.players.map((_, seat) => sortCards(deck.slice(seat * size, (seat + 1) * size))),
    cut: deck[next],
    kept: game.players.map(() => []),
    discards: game.players.map(() => []),
    crib,
    starter: null,
    count: 0,
    stack: [], // cards in the current count
    pile: [], // every card played this hand: { card, player }
    said: game.players.map(() => false), // who has said go in this count
    last: null, // who laid the latest card in this count
    turn: nextSeat(game, game.dealer),
    showStep: -1,
    show: null,
    events: [],
  });
}

function award(game, seat, points, reason) {
  if (points <= 0 || game.phase === 'over') return;
  const side = sideOf(game, seat);
  game.back[side] = game.scores[side];
  game.scores[side] = Math.min(game.target, game.scores[side] + points);
  game.events.push({ type: 'score', player: seat, side, points, reason });
  if (game.scores[side] >= game.target) {
    game.phase = 'over';
    game.winner = side;
  }
}

// Points scored outside the show: his heels, the play, go and last card.
function peg(game, seat, points, reason) {
  game.tally[seat].pegging += points;
  award(game, seat, points, reason);
}

export function discard(game, player, cards) {
  const toss = tossCount(game);
  check(game.phase === 'discard' && game.discards[player].length === 0, 'Not time to discard');
  check(
    cards.length === toss && new Set(cards).size === toss && cards.every(c => game.hands[player].includes(c)),
    toss === 2 ? 'Pick two cards from the hand' : 'Pick a card from the hand',
  );
  game.events = [];
  game.hands[player] = game.hands[player].filter(c => !cards.includes(c));
  game.discards[player] = [...cards];
  game.crib.push(...cards);
  if (game.crib.length < 4) return;

  game.kept = game.hands.map(hand => [...hand]);
  game.starter = game.cut;
  game.phase = 'play';
  game.events.push({ type: 'cut', card: game.starter });
  if (rank(game.starter) === JACK) peg(game, game.dealer, 2, 'His heels');
}

export function legalCards(game, player) {
  if (game.phase !== 'play') return [];
  return game.hands[player].filter(c => game.count + value(c) <= 31);
}

export function playCard(game, player, card) {
  check(game.phase === 'play' && game.turn === player, 'Not this player\'s turn');
  check(legalCards(game, player).includes(card), 'That card cannot be played');
  game.events = [];
  game.hands[player] = game.hands[player].filter(c => c !== card);
  game.stack.push(card);
  game.pile.push({ card, player });
  game.count += value(card);
  game.last = player;
  game.events.push({ type: 'play', player, card, count: game.count });

  const { points, items } = pegScore(game.stack);
  peg(game, player, points, items.map(item => item.label).join(' and '));
  if (game.phase !== 'over') passTurn(game, player);
}

// A player holding cards, none of which fits under 31, has to say go, and
// sits out the rest of that count.
export function go(game, player) {
  check(game.phase === 'play' && game.turn === player, 'Not this player\'s turn');
  check(game.hands[player].length > 0 && !legalCards(game, player).length, 'A card can still be played');
  game.events = [];
  game.said[player] = true;
  game.events.push({ type: 'go', player });
  passTurn(game, player);
}

// Decides who acts next after `from` laid a card or said go. Play goes round
// the table, skipping anyone out of cards or who has said go this count;
// each player it reaches must play or say go. Once it comes back to whoever
// laid the latest card and they cannot play, they take the point for the go
// (or the last card), and the next player round from them starts a new count.
function passTurn(game, from) {
  const { last } = game;
  const holds = seat => game.hands[seat].length > 0;
  const canPlay = seat => game.hands[seat].some(c => game.count + value(c) <= 31);

  if (game.count < 31) {
    for (let steps = 1; steps <= game.players.length; steps++) {
      const seat = nextSeat(game, from, steps);
      if (!holds(seat) || game.said[seat]) continue;
      if (seat !== last || canPlay(seat)) {
        game.turn = seat;
        return;
      }
      break;
    }
    const handsEmpty = game.hands.every(hand => !hand.length);
    peg(game, last, 1, handsEmpty ? 'Last card' : 'Go');
    if (game.phase === 'over') return;
  }

  game.count = 0;
  game.stack = [];
  game.said = game.said.map(() => false);
  game.last = null;
  for (let steps = 1; steps <= game.players.length; steps++) {
    const seat = nextSeat(game, last, steps);
    if (holds(seat)) {
      game.turn = seat;
      return;
    }
  }
  game.phase = 'show';
}

// Steps through the show: each hand in turn from the dealer's left, the
// dealer's last, then the dealer's crib, then the next deal.
export function advanceShow(game) {
  check(game.phase === 'show', 'Nothing to count yet');
  const count = game.players.length;
  game.events = [];
  game.showStep++;
  if (game.showStep === count + 1) {
    game.dealer = nextSeat(game, game.dealer);
    deal(game);
    return;
  }
  const isCrib = game.showStep === count;
  const player = isCrib ? game.dealer : nextSeat(game, game.dealer, game.showStep + 1);
  const kind = isCrib ? 'crib' : 'hand';
  const cards = isCrib ? sortCards(game.crib) : game.kept[player];
  game.show = { player, kind, cards, ...scoreHand(cards, game.starter, isCrib) };

  const tally = game.tally[player][kind];
  tally.count++;
  tally.points += game.show.total;
  tally.best = Math.max(tally.best, game.show.total);
  award(game, player, game.show.total, isCrib ? 'Crib' : 'Hand');
}

// How badly a losing side was beaten: 0 = not skunked, 1 = skunk, 2 = double
// skunk. With three players each loser is judged on their own.
export function skunkOf(game, side) {
  if (side === game.winner) return 0;
  const score = game.scores[side];
  if (game.target === 121) return score < 61 ? 2 : score < 91 ? 1 : 0;
  return score < 31 ? 1 : 0;
}

// The worst skunk any loser took.
export const skunk = game => Math.max(...game.scores.map((_, side) => skunkOf(game, side)));
