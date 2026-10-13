// Everything the player sees and touches. The rules live in game.js; this
// file draws the current game object and turns taps and keys into actions.

import { RANKS, SUITS, rank, suit, isRed, cardName } from './cards.js';
import { summarize } from './scoring.js';
import { newGame, discard, playCard, go, advanceShow, legalCards, skunk } from './game.js';
import { pickDiscard, pickPlay, hint } from './ai.js';
import { emptyStats, loadStats, recordGame } from './stats.js';
import { playSound, setMuted, unlockSound } from './sound.js';

// Shown in the About box. Bump both with every release: a browser still
// running a cached copy of this file then shows the old number.
const VERSION = '1.3.1';
const RELEASED = '13 October 2026';

const AI = 1; // the computer always sits in seat 1
const AI_DELAY = 900;
const SHUFFLE_MS = 560; // two riffles of the deck, as timed in the stylesheet
const DEAL_GAP_MS = 60; // between one card leaving the deck and the next
const FLIGHT_MS = 240; // a card's trip from the deck to a hand
const COUNT_STEP_MS = 700; // each scoring combination stays up this long...
const COUNT_MAX_MS = 4500; // ...unless a big hand would make the whole count drag
const SETTINGS_KEY = 'cribbage.settings';
const GAME_KEY = 'cribbage.game';
const STATS_KEY = 'cribbage.stats';

const $ = id => document.getElementById(id);

function load(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function store(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be switched off (private browsing); the game still plays.
  }
}

// Menu buttons carry their value as text: "true", "121", "hard".
function parseValue(text) {
  if (text === 'true' || text === 'false') return text === 'true';
  return /^\d+$/.test(text) ? Number(text) : text;
}

// Saved settings are only accepted if the menu offers that value.
function loadSettings() {
  const settings = { mode: 'ai', difficulty: 'medium', target: 121, hints: true, sound: true };
  const saved = load(SETTINGS_KEY);
  for (const group of document.querySelectorAll('.choice')) {
    const key = group.dataset.setting;
    const offered = [...group.children].map(button => parseValue(button.dataset.value));
    if (offered.includes(saved?.[key])) settings[key] = saved[key];
  }
  return settings;
}

const settings = loadSettings();
const stats = loadStats(load(STATS_KEY));
let game = null;
let selected = []; // cards picked in the hand
let tip = null; // { cards, text } from the last hint
let messages = []; // what the last action did, in words
let revealedTo = null; // two-player mode: the seat whose hand is face-up
let pileShown = 0; // pile cards already drawn, so only new ones animate
let starterShown = false; // likewise for the starter, which turns over once
let dealing = false; // the shuffle-and-deal animation is running
let counting = null; // while a hand is counted out: { done, pace, held, timer }
let skipClick = false; // the tap that skipped an animation should do nothing else
let turnUp = false; // the next redraw turns the bottom hand face-up
let resetArmed = false;
let aiTimer = 0;
let dealTimer = 0;

setMuted(!settings.sound);

// ---- Who is who ---------------------------------------------------------

const isAi = seat => game.mode === 'ai' && seat === AI;
const name = seat => (game.mode === 'ai' ? ['You', 'Computer'][seat] : `Player ${seat + 1}`);
const owner = seat => (name(seat) === 'You' ? 'Your' : `${name(seat)}'s`);
const does = (seat, verb) => `${name(seat)} ${verb}${name(seat) === 'You' ? '' : 's'}`;
const capital = text => text[0].toUpperCase() + text.slice(1);

// The seat that must act now, or null while hands are being counted.
function actor() {
  if (game.phase === 'discard') return game.discards[0].length ? 1 : 0;
  if (game.phase === 'play') return game.turn;
  return null;
}

// The seat shown at the bottom of the screen.
const viewer = () => (game.mode === 'ai' ? 0 : actor() ?? revealedTo ?? 0);

// Two players share one screen, so a hand stays hidden until its owner asks.
const covered = () => game.mode === '2p' && actor() !== null && actor() !== revealedTo;
const canAct = () => actor() !== null && !isAi(actor()) && !covered() && !dealing;

// ---- Drawing ------------------------------------------------------------

const BACK = '<span class="card back"></span>';

// The text variation selector (U+FE0E) asks for the plain glyph, so phones do
// not swap in a colour emoji.
const TEXT_STYLE = String.fromCharCode(0xfe0e);
const suitGlyph = card => SUITS[suit(card)] + TEXT_STYLE;

function cardHtml(card, classes = '', asButton = false) {
  const tag = asButton ? 'button' : 'span';
  const attributes = asButton ? ` data-card="${card}" aria-label="${cardName(card)}"` : '';
  return (
    `<${tag} class="card${isRed(card) ? ' red' : ''} ${classes}"${attributes}>` +
    `<span class="corner">${RANKS[rank(card)]}<br>${suitGlyph(card)}</span>` +
    `<span class="pip">${suitGlyph(card)}</span></${tag}>`
  );
}

// Pegboard geometry in SVG units: three streets of holes, walked left to
// right, right to left, then left to right again to the finish.
const BOARD = { width: 360, height: 88, left: 28, right: 336, top: 15, street: 26, lane: 8 };

function holeXY(seat, hole) {
  const perStreet = (game.target - 1) / 3;
  const y = BOARD.top + seat * BOARD.lane;
  if (hole < 1) return [16 + hole * 8, y]; // the two starting holes, -1 and 0
  if (hole >= game.target) return [BOARD.width - 9, BOARD.top + 2 * BOARD.street + BOARD.lane / 2];
  const street = Math.floor((hole - 1) / perStreet);
  const step = (hole - 1) % perStreet;
  const column = street % 2 ? perStreet - 1 - step : step;
  // Holes sit in groups of five with half a step between groups.
  const pitch = (BOARD.right - BOARD.left) / (perStreet - 1 + (perStreet / 5 - 1) / 2);
  return [BOARD.left + (column + Math.floor(column / 5) / 2) * pitch, y + street * BOARD.street];
}

function pegTransform(seat, hole) {
  const [x, y] = holeXY(seat, hole);
  return `translate(${x.toFixed(2)}px, ${y}px)`;
}

// `from` is the game, or the scores and pegs held from before a count.
const pegHoles = (seat, from = game) => [['back', from.back[seat]], ['front', from.scores[seat]]];

function drawBoard() {
  let holes = '';
  let pegs = '';
  for (const seat of [0, 1]) {
    for (let hole = -1; hole < game.target; hole++) {
      const [x, y] = holeXY(seat, hole);
      holes += `<circle cx="${x.toFixed(2)}" cy="${y}" r="2"/>`;
    }
    for (const [which, hole] of pegHoles(seat)) {
      pegs += `<circle class="peg seat${seat} ${which}" r="3.3" style="transform: ${pegTransform(seat, hole)}"/>`;
    }
  }
  const [finishX, finishY] = holeXY(0, game.target);
  const streets = [0, 1, 2]
    .map(i => `<rect x="${BOARD.left - 7}" y="${BOARD.top + i * BOARD.street - 6}" width="${BOARD.right - BOARD.left + 14}" height="${BOARD.lane + 12}" rx="10"/>`)
    .join('');
  $('board').innerHTML =
    `<svg viewBox="0 0 ${BOARD.width} ${BOARD.height}" role="img" aria-label="Cribbage board">` +
    `<g class="streets">${streets}</g>` +
    `<g class="holes">${holes}<circle cx="${finishX}" cy="${finishY}" r="2.8"/></g>${pegs}</svg>`;
}

function playHtml(me) {
  const old = game.pile.length - game.stack.length; // cards from counts already finished
  const pile = game.pile
    .map(({ card, player }, i) => {
      const classes = [player === me ? 'mine' : 'theirs', i < old && 'old', i >= pileShown && 'fresh'];
      return cardHtml(card, classes.filter(Boolean).join(' '));
    })
    .join('');
  const cut = game.starter !== null;
  const deck = `<span class="card back deck${dealing ? ' shuffling' : ''}"></span>`;
  return `
    <div class="side">
      <figure>${cut ? cardHtml(game.starter, starterShown ? '' : 'turn') : deck}<figcaption>${cut ? 'Starter' : 'Deck'}</figcaption></figure>
      <figure>${game.crib.length ? BACK : '<span class="card empty"></span>'}<figcaption>${owner(game.dealer)} crib</figcaption></figure>
    </div>
    <div class="pile">${pile}</div>
    <div class="count${game.phase === 'play' ? '' : ' idle'}"><small>Count</small><b>${game.count}</b></div>`;
}

// The counting panel. While a hand is being counted out it shows only the
// combinations reached so far, with the cards of the latest one lit. Every
// line is in place from the start (the unreached ones hidden) so the panel
// does not jump as it fills.
function tallyHtml() {
  const { player, kind, cards, items } = game.show;
  const done = counting ? counting.done : items.length;
  const latest = counting ? items[done - 1] : null;
  // Nobs is the Jack matching the starter's suit, so light the starter with it.
  const lit = latest && [...latest.cards, ...(latest.type === 'nobs' ? [game.starter] : [])];
  const light = card => (lit ? (lit.includes(card) ? 'lit' : 'unlit') : '');

  const reached = summarize(items.slice(0, done));
  const lines = summarize(items)
    .map((line, i) => {
      const { label, points } = reached[i] ?? line;
      const state = !reached[i] ? 'pending' : counting && i === reached.length - 1 ? 'now' : '';
      return `<li class="${state}"><span>${label}</span><b>${points}</b></li>`;
    })
    .join('');
  const total = reached.reduce((sum, line) => sum + line.points, 0);
  return `
    <div class="tally">
      <h2>${owner(player)} ${kind}</h2>
      <div class="tally-cards">${cards.map(card => cardHtml(card, light(card))).join('')}<span class="plus">+</span>${cardHtml(game.starter, light(game.starter))}</div>
      <ul>${lines || '<li><span>Nothing scores</span><b>–</b></li>'}<li class="total"><span>Total</span><b>${total}</b></li></ul>
    </div>`;
}

function promptText(me, acting) {
  if (dealing) return 'Shuffling and dealing…';
  if (counting) return 'Counting. Tap to skip.';
  if (game.phase === 'discard' && acting) {
    return `Choose two cards for ${game.dealer === me ? 'your own' : `${name(game.dealer)}'s`} crib.`;
  }
  if (game.phase === 'play') {
    if (isAi(game.turn)) return 'Computer is thinking…';
    if (acting && !legalCards(game, me).length) return 'None of your cards fits under 31. Press Go.';
    if (acting) return selected.length ? 'Tap it again, or press Play.' : 'Your turn. Choose a card to play.';
  }
  if (game.phase === 'show' && !game.show) return 'All the cards are played. Time to count the hands.';
  return '';
}

function mainButton(acting) {
  if (game.phase === 'show') return [['Count hands', 'Next hand', 'Count crib', 'Next deal'][game.showStep + 1], !counting];
  if (game.phase === 'discard') return ['Send to crib', acting && selected.length === 2];
  if (game.phase === 'play') {
    if (acting && !legalCards(game, actor()).length) return ['Go', true];
    return [selected.length ? `Play ${cardName(selected[0])}` : 'Play', acting && selected.length === 1];
  }
  return ['Game over', false];
}

function gameOverHtml() {
  const title = name(game.winner) === 'You' ? 'You win!' : `${name(game.winner)} wins`;
  const skunked = ['', 'Skunk!', 'Double skunk!'][skunk(game)];
  const rows = [0, 1]
    .map(seat => {
      const tally = game.tally[seat];
      return `<tr><th>${name(seat)}</th><td>${game.scores[seat]}</td><td>${tally.pegging}</td><td>${tally.hand.points}</td><td>${tally.crib.points}</td></tr>`;
    })
    .join('');
  const row = game.mode === 'ai' ? stats.ai[game.difficulty] : null;
  return `
    <h2>${title}</h2>
    ${skunked ? `<p class="skunk">${skunked}</p>` : ''}
    <table class="grid">
      <thead><tr><th></th><th>Score</th><th>Pegging</th><th>Hands</th><th>Cribs</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${row ? `<p class="muted">${capital(game.difficulty)} computer: ${row.wins} won of ${row.games} played.</p>` : ''}
    <button class="btn primary" data-do="again">Play again</button>
    <div class="row">
      <button class="btn" data-do="stats">Statistics</button>
      <button class="btn" data-do="menu">Menu</button>
    </div>`;
}

function statsHtml() {
  const percent = (part, whole) => (whole ? `${Math.round((100 * part) / whole)}%` : '–');
  const average = (points, count) => (count ? (points / count).toFixed(1) : '–');
  const total = key => Object.values(stats.ai).reduce((sum, row) => sum + row[key], 0);
  const rows = Object.entries(stats.ai)
    .map(([level, row]) =>
      `<tr><th>${capital(level)}</th><td>${row.games}</td><td>${row.wins}</td>` +
      `<td>${percent(row.wins, row.games)}</td><td>${row.streak}</td><td>${row.bestStreak}</td></tr>`)
    .join('');
  const { totals, records, twoPlayer } = stats;
  return `
    <h3>Against the computer</h3>
    <table class="grid">
      <thead><tr><th></th><th>Played</th><th>Won</th><th>Win&nbsp;%</th><th>Streak</th><th>Best</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <dl class="facts">
      <dt>Best hand</dt><dd>${records.hand || '–'}</dd>
      <dt>Best crib</dt><dd>${records.crib || '–'}</dd>
      <dt>Biggest win</dt><dd>${records.margin ? `by ${records.margin}` : '–'}</dd>
      <dt>Skunks given / taken</dt><dd>${total('skunks')} / ${total('skunked')}</dd>
      <dt>Average hand</dt><dd>${average(totals.hand.points, totals.hand.count)}</dd>
      <dt>Average crib</dt><dd>${average(totals.crib.points, totals.crib.count)}</dd>
      <dt>Pegging per deal</dt><dd>${average(totals.pegging, totals.deals)}</dd>
    </dl>
    <h3>Two players</h3>
    <p>${twoPlayer.games ? `Player 1 has won ${twoPlayer.wins[0]}, Player 2 has won ${twoPlayer.wins[1]}.` : 'No games finished yet.'}</p>
    <p class="muted">Finished games are saved in this browser, on this device.</p>`;
}

function render() {
  const me = viewer();
  const them = 1 - me;
  const hidden = covered();
  const acting = canAct();
  $('table').dataset.phase = game.phase;

  // While a hand is counted out, the board waits at the scores from before it.
  const board = counting ? counting.held : game;
  for (const seat of [0, 1]) {
    const score = document.querySelector(`.score[data-seat="${seat}"]`);
    score.querySelector('.name').textContent = name(seat);
    score.querySelector('.points').textContent = board.scores[seat];
    score.classList.toggle('active', actor() === seat);
    for (const [which, hole] of pegHoles(seat, board)) {
      $('board').querySelector(`.peg.seat${seat}.${which}`).style.transform = pegTransform(seat, hole);
    }
  }

  const label = seat => `${name(seat)}${game.dealer === seat ? ' · dealer' : ''}`;
  $('top-label').textContent = label(them);
  $('bottom-label').textContent = label(me);
  $('top-hand').innerHTML = BACK.repeat(game.hands[them].length);

  const legal = game.phase === 'play' && acting ? legalCards(game, me) : null;
  const turning = turnUp && !hidden && !dealing;
  turnUp = false;
  $('bottom-hand').innerHTML = game.hands[me]
    .map(card => {
      if (hidden || dealing) return BACK;
      const classes = [selected.includes(card) && 'selected', tip?.cards.includes(card) && 'tip', legal && !legal.includes(card) && 'dim', turning && 'turn'];
      return cardHtml(card, classes.filter(Boolean).join(' '), true);
    })
    .join('');
  if (turning) [...$('bottom-hand').children].forEach((card, i) => card.style.setProperty('--i', i));

  $('center').innerHTML = game.show ? tallyHtml() : playHtml(me);
  pileShown = game.pile.length;
  starterShown = game.starter !== null;

  $('events').textContent = messages.join(' ');
  $('prompt').textContent = tip ? tip.text : promptText(me, acting);
  $('prompt').classList.toggle('tip', Boolean(tip));

  const [text, enabled] = mainButton(acting);
  $('btn-main').textContent = text;
  $('btn-main').disabled = !enabled;
  $('btn-hint').hidden = !settings.hints;
  $('btn-hint').disabled = !acting;
  $('btn-sound').setAttribute('aria-pressed', settings.sound);

  // The cover waits for the deal to finish: the cards arrive face-down anyway.
  $('cover').hidden = !hidden || dealing;
  if (hidden) {
    $('cover-title').textContent = `Pass the device to ${name(actor())}`;
    $('cover-text').textContent = messages.join(' ');
    $('btn-reveal').textContent = `Show ${name(actor())}'s cards`;
  }

  // A game won on a count is announced once the count has been shown.
  $('gameover').hidden = game.phase !== 'over' || Boolean(counting);
  if (game.phase === 'over') $('gameover-body').innerHTML = gameOverHtml();
}

// ---- Actions ------------------------------------------------------------

function describe(events) {
  return events
    .map(event => {
      if (event.type === 'cut') return `The starter is ${cardName(event.card)}.`;
      if (event.type === 'play') return `${does(event.player, 'play')} ${cardName(event.card)} for ${event.count}.`;
      if (event.type === 'go') return `${does(event.player, 'say')} go.`;
      // Hands and cribs are spelled out in the counting panel instead.
      if (event.reason === 'Hand' || event.reason === 'Crib') return '';
      return `${does(event.player, 'score')} ${event.points}: ${event.reason.toLowerCase()}.`;
    })
    .filter(Boolean);
}

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// One sound for each thing that just happened, spaced so they do not pile up.
function soundEvents(events) {
  let delay = 0;
  for (const event of events) {
    if (event.type === 'play') playSound('place');
    else if (event.type === 'cut') playSound('flip', (delay += 0.15));
    else if (event.type === 'score') playSound('peg', (delay += 0.18));
  }
  if (game.phase === 'over') playSound(isAi(game.winner) ? 'lose' : 'win', delay + 0.35);
}

// Shows a fresh deal: the deck riffles, then twelve cards fly to the two hands
// in dealing order. The cards are already in their final places in the page;
// each is only drawn as if it started at the deck.
function dealCards() {
  playSound('shuffle');
  if (reducedMotion()) {
    render();
    return;
  }

  dealing = true;
  render();
  const deck = $('center').querySelector('.deck').getBoundingClientRect();
  const hands = [$('bottom-hand'), $('top-hand')];
  const first = viewer() === game.dealer ? 1 : 0; // the non-dealer is dealt to first
  for (let i = 0; i < 12; i++) {
    const card = hands[(first + i) % 2].children[Math.floor(i / 2)];
    const box = card.getBoundingClientRect();
    const dx = deck.left + deck.width / 2 - box.left - box.width / 2;
    const dy = deck.top + deck.height / 2 - box.top - box.height / 2;
    const delay = SHUFFLE_MS + i * DEAL_GAP_MS;
    // Invisible while it waits its turn, then out from the deck to its place.
    card.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) scale(${deck.width / box.width})`, opacity: 0 },
        { opacity: 1, offset: 0.1 },
        { transform: 'none', opacity: 1 },
      ],
      { duration: FLIGHT_MS, delay, easing: 'ease-out', fill: 'backwards' },
    );
    playSound('deal', delay / 1000);
  }
  dealTimer = setTimeout(endDeal, SHUFFLE_MS + 11 * DEAL_GAP_MS + FLIGHT_MS);
}

// Also called early, when a tap or key skips the animation.
function endDeal() {
  if (!dealing) return;
  clearTimeout(dealTimer);
  dealing = false;
  turnUp = true;
  render();
}

// Counts a hand out one scoring combination at a time. `held` is the scores
// and pegs from before the count; the board shows them until it is finished.
function countOut(held) {
  const steps = game.show.items.length;
  counting = { done: 0, pace: Math.min(COUNT_STEP_MS, COUNT_MAX_MS / steps), held, timer: 0 };
  countNext();
}

function countNext() {
  if (counting.done === game.show.items.length) {
    endCount();
    return;
  }
  counting.done++;
  playSound('count');
  render();
  counting.timer = setTimeout(countNext, counting.pace);
}

// Also called early, when a tap or key skips the animation. Only now do the
// pegs move, and with them the sounds for the score and for a game won on it.
function endCount() {
  if (!counting) return;
  clearTimeout(counting.timer);
  counting = null;
  soundEvents(game.events);
  render();
}

// Runs one game action, then saves and redraws.
function commit(action) {
  const held = { scores: [...game.scores], back: [...game.back] };
  const stepBefore = game.showStep;
  action();
  selected = [];
  tip = null;
  messages = describe(game.events);
  const dealt = game.phase === 'discard' && !game.crib.length;
  const counted = Boolean(game.show) && game.showStep !== stepBefore; // a hand or crib was just scored
  if (dealt) revealedTo = null; // new deal: hide both hands again
  if (game.phase === 'over') {
    recordGame(stats, game);
    store(STATS_KEY, stats);
    store(GAME_KEY, null);
  } else {
    store(GAME_KEY, game);
  }

  if (counted && game.show.items.length && !reducedMotion()) {
    countOut(held);
  } else {
    soundEvents(game.events);
    if (dealt) dealCards();
    else render();
  }
  scheduleAi();
}

// The computer's turn, after a pause: a card if one fits, otherwise go.
function scheduleAi() {
  clearTimeout(aiTimer);
  if (game.phase !== 'play' || !isAi(game.turn)) return;
  aiTimer = setTimeout(() => {
    commit(() => {
      if (legalCards(game, AI).length) playCard(game, AI, pickPlay(game, AI));
      else go(game, AI);
    });
  }, AI_DELAY);
}

function onCard(card) {
  if (!canAct()) return;
  if (game.phase === 'discard') {
    selected = selected.includes(card) ? selected.filter(c => c !== card) : [...selected, card].slice(-2);
  } else if (legalCards(game, actor()).includes(card)) {
    if (selected[0] === card) {
      onMain();
      return;
    }
    selected = [card];
  }
  render();
}

function onMain() {
  if (counting) return;
  if (game.phase === 'show') {
    commit(() => advanceShow(game));
    return;
  }
  if (!canAct()) return;
  const seat = actor();
  if (game.phase === 'discard' && selected.length === 2) {
    playSound('slide');
    playSound('slide', 0.09);
    commit(() => {
      discard(game, seat, selected);
      if (isAi(1 - seat)) discard(game, AI, pickDiscard(game, AI));
    });
  } else if (game.phase === 'play' && !legalCards(game, seat).length) {
    commit(() => go(game, seat));
  } else if (game.phase === 'play' && selected.length === 1) {
    commit(() => playCard(game, seat, selected[0]));
  }
}

function onHint() {
  if (!settings.hints || !canAct()) return;
  tip = hint(game, actor());
  render();
}

function reveal() {
  revealedTo = actor();
  turnUp = true;
  render();
}

function toggleSound() {
  settings.sound = !settings.sound;
  store(SETTINGS_KEY, settings);
  setMuted(!settings.sound);
  unlockSound();
  playSound('peg'); // heard only when sound has just come back on
  $('btn-sound').setAttribute('aria-pressed', settings.sound);
}

// ---- Screens ------------------------------------------------------------

function showMenu() {
  clearTimeout(aiTimer);
  clearTimeout(dealTimer);
  clearTimeout(counting?.timer);
  dealing = false;
  counting = null;
  for (const group of document.querySelectorAll('.choice')) {
    for (const button of group.children) {
      button.setAttribute('aria-pressed', parseValue(button.dataset.value) === settings[group.dataset.setting]);
    }
  }
  $('row-difficulty').hidden = settings.mode !== 'ai';

  const saved = load(GAME_KEY);
  const canResume = saved?.v === 1 && saved.phase !== 'over';
  $('btn-resume').hidden = !canResume;
  if (canResume) $('btn-resume').textContent = `Resume game (${saved.scores[0]}–${saved.scores[1]})`;
  $('btn-new').classList.toggle('primary', !canResume);

  for (const id of ['table', 'cover', 'gameover']) $(id).hidden = true;
  $('menu').hidden = false;
}

function start(saved = null) {
  game = saved ?? newGame(settings);
  selected = [];
  tip = null;
  messages = [];
  revealedTo = null;
  pileShown = game.pile.length;
  starterShown = game.starter !== null;
  drawBoard();
  $('menu').hidden = true;
  $('table').hidden = false;
  store(GAME_KEY, game);
  if (saved) render();
  else dealCards();
  scheduleAi();
}

function showStats() {
  resetArmed = false;
  $('btn-reset').textContent = 'Reset statistics';
  $('stats-body').innerHTML = statsHtml();
  $('stats').hidden = false;
}

// ---- Wiring -------------------------------------------------------------

$('menu').addEventListener('click', event => {
  const button = event.target.closest('.choice button');
  if (!button) return;
  settings[button.parentElement.dataset.setting] = parseValue(button.dataset.value);
  store(SETTINGS_KEY, settings);
  setMuted(!settings.sound);
  showMenu();
});

$('btn-new').addEventListener('click', () => start());
$('btn-resume').addEventListener('click', () => start(load(GAME_KEY)));
$('btn-stats').addEventListener('click', showStats);
$('btn-rules').addEventListener('click', () => {
  $('rules').hidden = false;
});
$('about-version').textContent = `Version ${VERSION} · ${RELEASED}`;
$('btn-about').addEventListener('click', () => {
  $('about').hidden = false;
});
$('btn-menu').addEventListener('click', showMenu);
$('btn-main').addEventListener('click', onMain);
$('btn-hint').addEventListener('click', onHint);
$('btn-sound').addEventListener('click', toggleSound);
$('btn-reveal').addEventListener('click', reveal);

$('bottom-hand').addEventListener('click', event => {
  const card = event.target.closest('[data-card]');
  if (card) onCard(Number(card.dataset.card));
});

$('gameover').addEventListener('click', event => {
  const action = event.target.dataset.do;
  if (action === 'again') start();
  else if (action === 'stats') showStats();
  else if (action === 'menu') showMenu();
});

// The first press arms the button, the second erases.
$('btn-reset').addEventListener('click', () => {
  if (!resetArmed) {
    resetArmed = true;
    $('btn-reset').textContent = 'Tap again to erase';
    return;
  }
  Object.assign(stats, emptyStats());
  store(STATS_KEY, stats);
  showStats();
});

for (const button of document.querySelectorAll('[data-close]')) {
  button.addEventListener('click', () => {
    button.closest('.overlay').hidden = true;
  });
}

// Browsers only allow sound once the page has been tapped or typed at, so every
// tap and key wakes the audio. Either one also skips an animation in progress,
// and then does nothing else: it must not also pick a card or press a button.
for (const type of ['pointerdown', 'keydown']) {
  document.addEventListener(
    type,
    event => {
      unlockSound();
      skipClick = dealing || Boolean(counting);
      if (!skipClick) return;
      endDeal();
      endCount();
      if (type === 'keydown') {
        event.stopPropagation();
        // Stop Enter or Space pressing the focused button, but leave browser
        // shortcuts such as reload alone.
        if (event.key === 'Enter' || event.key === ' ') event.preventDefault();
      }
    },
    true,
  );
}

// The click that follows a skipping tap is dropped before anything sees it.
document.addEventListener(
  'click',
  event => {
    if (!skipClick) return;
    skipClick = false;
    event.stopPropagation();
    event.preventDefault();
  },
  true,
);

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    for (const id of ['rules', 'stats', 'about']) $(id).hidden = true;
    return;
  }
  const busy = !game || $('table').hidden || !$('rules').hidden || !$('stats').hidden || game.phase === 'over';
  if (busy || event.ctrlKey || event.metaKey || event.altKey) return;

  if (event.key === 'Enter' && event.target !== $('btn-menu')) {
    event.preventDefault(); // Enter always confirms, whichever button has focus
    if (covered()) reveal();
    else onMain();
  } else if (event.key.toLowerCase() === 'h') {
    onHint();
  } else if (event.key.toLowerCase() === 'm') {
    toggleSound();
  } else if (/^[1-6]$/.test(event.key) && !covered()) {
    const card = game.hands[viewer()][event.key - 1];
    if (card !== undefined) onCard(card);
  }
});

showMenu();
