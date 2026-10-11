// Rules of two-handed, six-card cribbage. No DOM here: the game is one plain
// object that survives JSON.stringify, changed only through the exported
// actions. Each action leaves a list of what happened in game.events.

import { shuffledDeck, sortCards, rank, value, JACK } from './cards.js';
import { scoreHand, pegScore } from './scoring.js';

function check(ok, message) {
  if (!ok) throw new Error(message);
}

// Where a seat's points came from, for the end-of-game summary and statistics.
const newTally = () => ({
  pegging: 0,
  hand: { count: 0, points: 0, best: 0 },
  crib: { count: 0, points: 0, best: 0 },
});

export function newGame({ mode = 'ai', difficulty = 'medium', target = 121 } = {}) {
  const game = {
    v: 1,
    mode,
    difficulty,
    target,
    dealer: Math.random() < 0.5 ? 0 : 1,
    scores: [0, 0],
    back: [-1, -1], // trailing pegs; -1 is the second starting hole
    winner: null,
    deals: 0,
    tally: [newTally(), newTally()],
  };
  deal(game);
  return game;
}

// Starts a hand. Tests pass a stacked deck: six cards for seat 0, six for
// seat 1, then the card that will be cut as the starter.
export function deal(game, deck = shuffledDeck()) {
  game.deals++;
  Object.assign(game, {
    phase: 'discard',
    hands: [sortCards(deck.slice(0, 6)), sortCards(deck.slice(6, 12))],
    cut: deck[12],
    kept: [[], []],
    discards: [[], []],
    crib: [],
    starter: null,
    count: 0,
    stack: [], // cards in the current count
    pile: [], // every card played this hand: { card, player }
    goCalled: false,
    turn: 1 - game.dealer,
    showStep: -1,
    show: null,
    events: [],
  });
}

function award(game, player, points, reason) {
  if (points <= 0 || game.phase === 'over') return;
  game.back[player] = game.scores[player];
  game.scores[player] = Math.min(game.target, game.scores[player] + points);
  game.events.push({ type: 'score', player, points, reason });
  if (game.scores[player] >= game.target) {
    game.phase = 'over';
    game.winner = player;
  }
}

// Points scored outside the show: his heels, the play, go and last card.
function peg(game, player, points, reason) {
  game.tally[player].pegging += points;
  award(game, player, points, reason);
}

export function discard(game, player, cards) {
  check(game.phase === 'discard' && game.discards[player].length === 0, 'Not time to discard');
  check(cards.length === 2 && cards[0] !== cards[1] && cards.every(c => game.hands[player].includes(c)), 'Pick two cards from the hand');
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
  game.events.push({ type: 'play', player, card, count: game.count });

  const { points, items } = pegScore(game.stack);
  peg(game, player, points, items.map(item => item.label).join(' and '));
  if (game.phase !== 'over') passTurn(game, player);
}

// Decides who plays next after `last` laid a card, calling "go" and resetting
// the count as needed.
function passTurn(game, last) {
  const other = 1 - last;
  const canPlay = player => game.hands[player].some(c => game.count + value(c) <= 31);

  if (game.count < 31) {
    if (canPlay(other)) {
      game.turn = other;
      return;
    }
    if (game.hands[other].length && !game.goCalled) {
      game.goCalled = true;
      game.events.push({ type: 'go', player: other });
    }
    if (canPlay(last)) {
      game.turn = last;
      return;
    }
    const handsEmpty = !game.hands[0].length && !game.hands[1].length;
    peg(game, last, 1, handsEmpty ? 'Last card' : 'Go');
    if (game.phase === 'over') return;
  }

  game.count = 0;
  game.stack = [];
  game.goCalled = false;
  if (game.hands[other].length) game.turn = other;
  else if (game.hands[last].length) game.turn = last;
  else game.phase = 'show';
}

// Steps through the show: non-dealer's hand, dealer's hand, dealer's crib,
// then the next deal.
export function advanceShow(game) {
  check(game.phase === 'show', 'Nothing to count yet');
  game.events = [];
  game.showStep++;
  if (game.showStep === 3) {
    game.dealer = 1 - game.dealer;
    deal(game);
    return;
  }
  const player = game.showStep === 0 ? 1 - game.dealer : game.dealer;
  const kind = game.showStep === 2 ? 'crib' : 'hand';
  const cards = kind === 'crib' ? sortCards(game.crib) : game.kept[player];
  game.show = { player, kind, cards, ...scoreHand(cards, game.starter, kind === 'crib') };

  const tally = game.tally[player][kind];
  tally.count++;
  tally.points += game.show.total;
  tally.best = Math.max(tally.best, game.show.total);
  award(game, player, game.show.total, kind === 'crib' ? 'Crib' : 'Hand');
}

// How badly the loser was beaten: 0 = not skunked, 1 = skunk, 2 = double skunk.
export function skunk(game) {
  const loser = game.scores[1 - game.winner];
  if (game.target === 121) return loser < 61 ? 2 : loser < 91 ? 1 : 0;
  return loser < 31 ? 1 : 0;
}
