// Everything the player sees and touches. The rules live in game.js; this
// file draws the current game object and turns taps and keys into actions.

import { RANKS, SUITS, rank, suit, isRed, cardName } from './cards.js';
import { summarize } from './scoring.js';
import { newGame, discard, playCard, advanceShow, legalCards, skunk } from './game.js';
import { pickDiscard, pickPlay, hint } from './ai.js';
import { emptyStats, loadStats, recordGame } from './stats.js';

const AI = 1; // the computer always sits in seat 1
const AI_DELAY = 900;
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
  const settings = { mode: 'ai', difficulty: 'medium', target: 121, hints: true };
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
let resetArmed = false;
let aiTimer = 0;

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
const canAct = () => actor() !== null && !isAi(actor()) && !covered();

// ---- Drawing ------------------------------------------------------------

const BACK = '<span class="card back"></span>';

// U+FE0E asks for the plain glyph, so phones do not swap in a colour emoji.
const suitGlyph = card => `${SUITS[suit(card)]}︎`;

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

const pegHoles = seat => [['back', game.back[seat]], ['front', game.scores[seat]]];

function drawBoard() {
  let holes = '';
  let pegs = '';
  for (const seat of [0, 1]) {
    for (let hole = -1; hole < game.target; hole++) {
      const [x, y] = holeXY(seat, hole);
      holes += `<circle cx="${x.toFixed(2)}" cy="${y}" r="2"/>`;
    }
    for (const [which, hole] of pegHoles(seat)) {
      pegs +=`<circle class="peg seat${seat} ${which}" r="3.3" style="transform: ${pegTransform(seat, hole)}"/>`;
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
  return `
    <div class="side">
      <figure>${cut ? cardHtml(game.starter) : BACK}<figcaption>${cut ? 'Starter' : 'Deck'}</figcaption></figure>
      <figure>${game.crib.length ? BACK : '<span class="card empty"></span>'}<figcaption>${owner(game.dealer)} crib</figcaption></figure>
    </div>
    <div class="pile">${pile}</div>
    <div class="count${game.phase === 'play' ? '' : ' idle'}"><small>Count</small><b>${game.count}</b></div>`;
}

function tallyHtml() {
  const { player, kind, cards, items, total } = game.show;
  const lines = summarize(items)
    .map(line => `<li><span>${line.label}</span><b>${line.points}</b></li>`)
    .join('');
  return `
    <div class="tally">
      <h2>${owner(player)} ${kind}</h2>
      <div class="tally-cards">${cards.map(card => cardHtml(card)).join('')}<span class="plus">+</span>${cardHtml(game.starter)}</div>
      <ul>${lines || '<li><span>Nothing scores</span><b>–</b></li>'}<li class="total"><span>Total</span><b>${total}</b></li></ul>
    </div>`;
}

function promptText(me, acting) {
  if (game.phase === 'discard' && acting) {
    return `Choose two cards for ${game.dealer === me ? 'your own' : `${name(game.dealer)}'s`} crib.`;
  }
  if (game.phase === 'play') {
    if (isAi(game.turn)) return 'Computer is thinking…';
    if (acting) return selected.length ? 'Tap it again, or press Play.' : 'Your turn. Choose a card to play.';
  }
  if (game.phase === 'show' && !game.show) return 'All the cards are played. Time to count the hands.';
  return '';
}

function mainButton(acting) {
  if (game.phase === 'show') return [['Count the hands', 'Next hand', 'Count the crib', 'Next deal'][game.showStep + 1], true];
  if (game.phase === 'discard') return ['Send to crib', acting && selected.length === 2];
  if (game.phase === 'play') return [selected.length ? `Play ${cardName(selected[0])}` : 'Play', acting && selected.length === 1];
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

  for (const seat of [0, 1]) {
    const score = document.querySelector(`.score[data-seat="${seat}"]`);
    score.querySelector('.name').textContent = name(seat);
    score.querySelector('.points').textContent = game.scores[seat];
    score.classList.toggle('active', actor() === seat);
    for (const [which, hole] of pegHoles(seat)) {
      $('board').querySelector(`.peg.seat${seat}.${which}`).style.transform = pegTransform(seat, hole);
    }
  }

  const label = seat => `${name(seat)}${game.dealer === seat ? ' · dealer' : ''}`;
  $('top-label').textContent = label(them);
  $('bottom-label').textContent = label(me);
  $('top-hand').innerHTML = BACK.repeat(game.hands[them].length);

  const legal = game.phase === 'play' && acting ? legalCards(game, me) : null;
  $('bottom-hand').innerHTML = game.hands[me]
    .map(card => {
      if (hidden) return BACK;
      const classes = [selected.includes(card) && 'selected', tip?.cards.includes(card) && 'tip', legal && !legal.includes(card) && 'dim'];
      return cardHtml(card, classes.filter(Boolean).join(' '), true);
    })
    .join('');

  $('center').innerHTML = game.show ? tallyHtml() : playHtml(me);
  pileShown = game.pile.length;

  $('events').textContent = messages.join(' ');
  $('prompt').textContent = tip ? tip.text : promptText(me, acting);
  $('prompt').classList.toggle('tip', Boolean(tip));

  const [text, enabled] = mainButton(acting);
  $('btn-main').textContent = text;
  $('btn-main').disabled = !enabled;
  $('btn-hint').hidden = !settings.hints;
  $('btn-hint').disabled = !acting;

  $('cover').hidden = !hidden;
  if (hidden) {
    $('cover-title').textContent = `Pass the device to ${name(actor())}`;
    $('cover-text').textContent = messages.join(' ');
    $('btn-reveal').textContent = `Show ${name(actor())}'s cards`;
  }

  $('gameover').hidden = game.phase !== 'over';
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

// Runs one game action, then saves and redraws.
function commit(action) {
  action();
  selected = [];
  tip = null;
  messages = describe(game.events);
  if (game.phase === 'discard' && !game.crib.length) revealedTo = null; // new deal: hide both hands again
  if (game.phase === 'over') {
    recordGame(stats, game);
    store(STATS_KEY, stats);
    store(GAME_KEY, null);
  } else {
    store(GAME_KEY, game);
  }
  render();
  scheduleAi();
}

function scheduleAi() {
  clearTimeout(aiTimer);
  if (game.phase === 'play' && isAi(game.turn)) {
    aiTimer = setTimeout(() => commit(() => playCard(game, AI, pickPlay(game, AI))), AI_DELAY);
  }
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
  if (game.phase === 'show') {
    commit(() => advanceShow(game));
    return;
  }
  if (!canAct()) return;
  const seat = actor();
  if (game.phase === 'discard' && selected.length === 2) {
    commit(() => {
      discard(game, seat, selected);
      if (isAi(1 - seat)) discard(game, AI, pickDiscard(game, AI));
    });
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
  render();
}

// ---- Screens ------------------------------------------------------------

function showMenu() {
  clearTimeout(aiTimer);
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
  drawBoard();
  $('menu').hidden = true;
  $('table').hidden = false;
  store(GAME_KEY, game);
  render();
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
  showMenu();
});

$('btn-new').addEventListener('click', () => start());
$('btn-resume').addEventListener('click', () => start(load(GAME_KEY)));
$('btn-stats').addEventListener('click', showStats);
$('btn-rules').addEventListener('click', () => {
  $('rules').hidden = false;
});
$('btn-menu').addEventListener('click', showMenu);
$('btn-main').addEventListener('click', onMain);
$('btn-hint').addEventListener('click', onHint);
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

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    $('rules').hidden = true;
    $('stats').hidden = true;
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
  } else if (/^[1-6]$/.test(event.key) && !covered()) {
    const card = game.hands[viewer()][event.key - 1];
    if (card !== undefined) onCard(card);
  }
});

showMenu();
