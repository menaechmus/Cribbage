// Everything the player sees and touches. The rules live in game.js; this
// file draws the current game object and turns taps and keys into actions.

import { RANKS, SUITS, rank, suit, isRed, cardName } from './cards.js';
import { summarize } from './scoring.js';
import { newGame, upgradeGame, discard, playCard, go, advanceShow, legalCards, skunk, skunkOf, sideOf, sideCount, seatsOf, tossCount } from './game.js';
import { pickDiscard, pickPlay, hint } from './ai.js';
import { emptyStats, loadStats, recordGame } from './stats.js';
import { playSound, setMuted, unlockSound } from './sound.js';
import { boardFor, holeXY, trackPath } from './board.js';
import { startParty } from './celebrate.js';

// Shown in the About box. Bump both with every release: a browser still
// running a cached copy of this file then shows the old number.
const VERSION = '1.6.0';
const RELEASED = '20 October 2026';

const AI_DELAY = 900;
const SHUFFLE_MS = 560; // two riffles of the deck, as timed in the stylesheet
const DEAL_MS = 660; // from the first card leaving the deck to the last, whatever the table
const DEAL_GAP_MS = 60; // ...but no more than this between one card and the next
const FLIGHT_MS = 240; // a card's trip from the deck to a hand
const COUNT_STEP_MS = 1050; // each scoring combination stays up this long...
const COUNT_MAX_MS = 6750; // ...unless a big hand would make the whole count drag
const CHEER_MS = 3500; // fireworks and confetti before the game-over box appears
const SKUNK_AT_MS = 600; // after a skunk win a skunk sets off across the screen,
const SKUNK_PACE = 260; // walking this many pixels a second,
const SKUNK_MIN_MS = 3000; // but taking no less than this
const SKUNK_MAX_MS = 4500; // and no more than this
const NAME_LENGTH = 12;
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

// Saved settings are only accepted if the menu offers that value. Before
// 1.6.0 two people on one device was its own mode.
function loadSettings() {
  const settings = { mode: 'ai', difficulty: 'medium', players: 2, names: ['', '', '', ''], target: 121, hints: true, sound: true };
  const saved = load(SETTINGS_KEY);
  if (saved?.mode === '2p') saved.mode = 'local';
  for (const group of document.querySelectorAll('.choice[data-setting]')) {
    const key = group.dataset.setting;
    const offered = [...group.children].map(button => parseValue(button.dataset.value));
    if (offered.includes(saved?.[key])) settings[key] = saved[key];
  }
  if (Array.isArray(saved?.names)) {
    settings.names = settings.names.map((name, i) => (typeof saved.names[i] === 'string' ? saved.names[i].slice(0, NAME_LENGTH) : name));
  }
  return settings;
}

// Names are typed in, so they are escaped before going into the page.
const escapeHtml = text => String(text).replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);

const settings = loadSettings();
const stats = loadStats(load(STATS_KEY));
let game = null;
let selected = []; // cards picked in the hand
let tip = null; // { cards, text } from the last hint
let messages = []; // what the last action did, in words
let revealedTo = null; // people sharing a device: the seat whose hand is face-up
let pileShown = 0; // pile cards already drawn, so only new ones animate
let starterShown = false; // likewise for the starter, which turns over once
let dealing = false; // the shuffle-and-deal animation is running
let counting = null; // while a hand is counted out: { done, pace, held, timer }
let celebrating = 0; // timer while a win is celebrated and the game-over box waits
let party = null; // the fireworks and confetti, which outlast the celebration a little
let skipClick = false; // the tap that skipped an animation should do nothing else
let turnUp = false; // the next redraw turns the bottom hand face-up
let resetArmed = false;
let aiTimer = 0;
let dealTimer = 0;

setMuted(!settings.sound);

// ---- Who is who ---------------------------------------------------------

const seats = () => game.players.map((_, seat) => seat);
const nameOf = seat => game.players[seat].name;
const isAi = seat => game.players[seat].ai;
const isYou = seat => nameOf(seat) === 'You';
const owner = seat => (isYou(seat) ? 'Your' : `${nameOf(seat)}'s`);
const does = (seat, verb) => `${nameOf(seat)} ${verb}${isYou(seat) ? '' : 's'}`;
const capital = text => text[0].toUpperCase() + text.slice(1);
const side = seat => sideOf(game, seat);
// A side's name: a player's own, or a partnership's, "Ann & Cy".
const sideName = s => seatsOf(game, s).map(nameOf).join(' & ');
// Whether a person (not the computer) is on the winning side.
const personWon = () => seatsOf(game, game.winner).some(seat => !isAi(seat));

// The seat that must act now, or null while hands are being counted. In the
// discard, people take turns round the table from the dealer's left; the
// computer throws its cards along with the person's.
function actor() {
  if (game.phase === 'discard') {
    const count = game.players.length;
    for (let steps = 1; steps <= count; steps++) {
      const seat = (game.dealer + steps) % count;
      if (!game.discards[seat].length && !isAi(seat)) return seat;
    }
    return null;
  }
  if (game.phase === 'play') return game.turn;
  return null;
}

// The seat shown at the bottom of the screen: against the computer always
// the person; between people whoever must act.
const viewer = () => (game.mode === 'ai' ? 0 : actor() ?? revealedTo ?? 0);

// People share one screen, so a hand stays hidden until its owner asks.
const covered = () => game.mode === 'local' && actor() !== null && actor() !== revealedTo;
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

// One lane on the board for each side: two, or three for three players.
const lanes = () => sideCount(game);

function pegTransform(s, hole) {
  const [x, y] = holeXY(game.target, s, hole, lanes());
  return `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`;
}

// `from` is the game, or the scores and pegs held from before a count.
const pegHoles = (s, from = game) => [['back', from.back[s]], ['front', from.scores[s]]];

function drawBoard() {
  const shape = boardFor(lanes());
  let holes = '';
  let pegs = '';
  for (let s = 0; s < lanes(); s++) {
    for (let hole = -1; hole < game.target; hole++) {
      const [x, y] = holeXY(game.target, s, hole, lanes());
      holes += `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="2"/>`;
    }
    for (const [which, hole] of pegHoles(s)) {
      pegs += `<circle class="peg side${s} ${which}" r="3.3" style="transform: ${pegTransform(s, hole)}"/>`;
    }
  }
  const [finishX, finishY] = holeXY(game.target, 0, game.target, lanes());
  $('board').innerHTML =
    `<svg viewBox="0 0 ${shape.width} ${shape.height}" role="img" aria-label="Cribbage board">` +
    `<path class="track" d="${trackPath(game.target, lanes())}" stroke-width="${shape.track}"/>` +
    `<g class="holes">${holes}<circle cx="${finishX.toFixed(2)}" cy="${finishY}" r="2.8"/></g>${pegs}</svg>`;
  $('scores').innerHTML = game.scores
    .map((_, s) => `<div class="score" data-side="${s}"><i></i><span class="name"></span><b class="points"></b></div>`)
    .join('');
}

// The other players, in turn order from the one at the bottom: each with
// their name and their cards face-down.
function othersHtml(me) {
  const count = game.players.length;
  return Array.from({ length: count - 1 }, (_, i) => (me + 1 + i) % count)
    .map(seat => {
      const notes = [game.dealer === seat && 'dealer', count === 4 && side(seat) === side(me) && 'partner'].filter(Boolean);
      const label = [nameOf(seat), ...notes].join(' · ');
      return `<div class="other" data-seat="${seat}"><div class="seat-label">${escapeHtml(label)}</div><div class="hand hand-small">${BACK.repeat(game.hands[seat].length)}</div></div>`;
    })
    .join('');
}

function playHtml(me) {
  const old = game.pile.length - game.stack.length; // cards from counts already finished
  const marked = game.players.length > 2; // with more players, a dot says whose card it is
  const pile = game.pile
    .map(({ card, player }, i) => {
      const classes = [side(player) === side(me) ? 'mine' : 'theirs', marked && `marked side${side(player)}`, i < old && 'old', i >= pileShown && 'fresh'];
      return cardHtml(card, classes.filter(Boolean).join(' '));
    })
    .join('');
  const cut = game.starter !== null;
  const deck = `<span class="card back deck${dealing ? ' shuffling' : ''}"></span>`;
  return `
    <div class="side">
      <figure>${cut ? cardHtml(game.starter, starterShown ? '' : 'turn') : deck}<figcaption>${cut ? 'Starter' : 'Deck'}</figcaption></figure>
      <figure class="crib">${game.crib.length ? BACK : '<span class="card empty"></span>'}<figcaption>${escapeHtml(owner(game.dealer))} crib</figcaption></figure>
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
      <h2>${escapeHtml(owner(player))} ${kind}</h2>
      <div class="tally-cards">${cards.map(card => cardHtml(card, light(card))).join('')}<span class="plus">+</span>${cardHtml(game.starter, light(game.starter))}</div>
      <ul>${lines || '<li><span>Nothing scores</span><b>–</b></li>'}<li class="total"><span>Total</span><b>${total}</b></li></ul>
    </div>`;
}

function promptText(me, acting) {
  if (dealing) return 'Shuffling and dealing…';
  if (counting) return 'Counting. Tap to skip.';
  if (game.phase === 'discard' && acting) {
    const cards = tossCount(game) === 2 ? 'two cards' : 'a card';
    return `Choose ${cards} for ${game.dealer === me ? 'your own' : `${nameOf(game.dealer)}'s`} crib.`;
  }
  if (game.phase === 'play') {
    if (isAi(game.turn)) return `${nameOf(game.turn)} is thinking…`;
    if (acting && !legalCards(game, me).length) return 'None of your cards fits under 31. Press Go.';
    if (acting) return selected.length ? 'Tap it again, or press Play.' : 'Your turn. Choose a card to play.';
  }
  if (game.phase === 'show' && !game.show) return 'All the cards are played. Time to count the hands.';
  return '';
}

// The show steps through every hand, then the crib.
function showLabel() {
  const step = game.showStep; // the step on show, -1 before the first
  const hands = game.players.length;
  if (step < 0) return 'Count hands';
  if (step < hands - 1) return 'Next hand';
  return step === hands - 1 ? 'Count crib' : 'Next deal';
}

function mainButton(acting) {
  if (game.phase === 'show') return [showLabel(), !counting];
  if (game.phase === 'discard') return ['Send to crib', acting && selected.length === tossCount(game)];
  if (game.phase === 'play') {
    if (acting && !legalCards(game, actor()).length) return ['Go', true];
    return [selected.length ? `Play ${cardName(selected[0])}` : 'Play', acting && selected.length === 1];
  }
  return ['Game over', false];
}

// Who was skunked, in words. With two sides only the margin matters.
function skunkText() {
  if (sideCount(game) === 2) return ['', 'Skunk!', 'Double skunk!'][skunk(game)];
  return game.scores
    .map((_, s) => [s, skunkOf(game, s)])
    .filter(([, level]) => level)
    .map(([s, level]) => `${level === 2 ? 'Double skunk' : 'Skunk'} for ${sideName(s)}!`)
    .join(' ');
}

function gameOverHtml() {
  const winners = seatsOf(game, game.winner);
  const title = game.mode === 'ai' ? (game.winner === 0 ? 'You win!' : 'Computer wins') : `${sideName(game.winner)} win${winners.length > 1 ? '' : 's'}`;
  const skunked = skunkText();
  // A row for each player, or for each partnership.
  const rows = game.scores
    .map((score, s) => {
      const members = seatsOf(game, s).map(seat => game.tally[seat]);
      const sum = pick => members.reduce((total, tally) => total + pick(tally), 0);
      return (
        `<tr><th>${escapeHtml(sideName(s))}</th><td>${score}</td><td>${sum(t => t.pegging)}</td>` +
        `<td>${sum(t => t.hand.points)}</td><td>${sum(t => t.crib.points)}</td></tr>`
      );
    })
    .join('');
  const row = game.mode === 'ai' ? stats.ai[game.difficulty] : null;
  return `
    <h2>${escapeHtml(title)}</h2>
    ${skunked ? `<p class="skunk">${escapeHtml(skunked)}</p>` : ''}
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
  const people = Object.values(stats.people)
    .filter(person => person.games)
    .sort((a, b) => b.games - a.games || a.name.localeCompare(b.name))
    .map(person => `<tr><th>${escapeHtml(person.name)}</th><td>${person.games}</td><td>${person.wins}</td><td>${percent(person.wins, person.games)}</td></tr>`)
    .join('');
  const { totals, records } = stats;
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
    <h3>Between people</h3>
    ${
      people
        ? `<table class="grid"><thead><tr><th></th><th>Played</th><th>Won</th><th>Win&nbsp;%</th></tr></thead><tbody>${people}</tbody></table>`
        : '<p>No games finished yet.</p>'
    }
    <p class="muted">Finished games are saved in this browser, on this device.</p>`;
}

function render() {
  const me = viewer();
  const hidden = covered();
  const acting = canAct();
  const table = $('table');
  table.dataset.phase = game.phase;
  table.dataset.players = game.players.length;
  table.dataset.lanes = lanes();

  // While a hand is counted out, the board waits at the scores from before it.
  const board = counting ? counting.held : game;
  const now = actor();
  game.scores.forEach((_, s) => {
    const score = document.querySelector(`.score[data-side="${s}"]`);
    score.querySelector('.name').textContent = sideName(s);
    score.querySelector('.points').textContent = board.scores[s];
    score.classList.toggle('active', now !== null && side(now) === s);
    for (const [which, hole] of pegHoles(s, board)) {
      $('board').querySelector(`.peg.side${s}.${which}`).style.transform = pegTransform(s, hole);
    }
  });

  $('others').innerHTML = othersHtml(me);
  $('bottom-label').textContent = `${nameOf(me)}${game.dealer === me ? ' · dealer' : ''}`;

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
    $('cover-title').textContent = `Pass the device to ${nameOf(now)}`;
    $('cover-text').textContent = messages.join(' ');
    $('btn-reveal').textContent = `Show ${nameOf(now)}'s cards`;
  }

  // A game won on a count is announced once the count has been shown, and a
  // win once it has been celebrated.
  $('gameover').hidden = game.phase !== 'over' || Boolean(counting);
  $('gameover').classList.toggle('party', Boolean(celebrating));
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
  if (game.phase === 'over') playSound(personWon() ? 'win' : 'lose', delay + 0.35);
}

// Shows a fresh deal: the deck riffles, then the cards fly out one at a time
// round the table from the dealer's left, and with three players one more to
// the crib. The cards are already in their final places in the page; each is
// only drawn as if it started at the deck.
function dealCards() {
  playSound('shuffle');
  if (reducedMotion()) {
    render();
    return;
  }

  dealing = true;
  render();
  const me = viewer();
  const count = game.players.length;
  const handOf = seat => (seat === me ? $('bottom-hand') : $('others').querySelector(`[data-seat="${seat}"] .hand`));
  const flights = [];
  for (let i = 0; i < count * game.hands[0].length; i++) {
    const seat = (game.dealer + 1 + (i % count)) % count;
    flights.push(handOf(seat).children[Math.floor(i / count)]);
  }
  if (game.crib.length) flights.push($('center').querySelector('.crib .card'));

  const deck = $('center').querySelector('.deck').getBoundingClientRect();
  const gap = Math.min(DEAL_GAP_MS, DEAL_MS / (flights.length - 1));
  flights.forEach((card, i) => {
    const box = card.getBoundingClientRect();
    const dx = deck.left + deck.width / 2 - box.left - box.width / 2;
    const dy = deck.top + deck.height / 2 - box.top - box.height / 2;
    const delay = SHUFFLE_MS + i * gap;
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
  });
  dealTimer = setTimeout(endDeal, SHUFFLE_MS + (flights.length - 1) * gap + FLIGHT_MS);
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
  celebrate();
  render();
}

// A win by a person is celebrated before the game-over box appears: fireworks
// and confetti, and on a skunk a skunk walking by. A win for the computer goes
// straight to the box. Called just before the redraw that shows the end.
function celebrate() {
  if (game.phase !== 'over' || !personWon() || reducedMotion()) return;
  party = startParty($('party'), () => playSound('firework'));
  let wait = CHEER_MS;
  if (skunk(game)) wait = Math.max(wait, SKUNK_AT_MS + walkSkunk() + 200);
  celebrating = setTimeout(() => endCelebration(), wait);
}

// Sends the skunk across the bottom of the screen and says how long it takes.
function walkSkunk() {
  const walker = $('skunk-walk');
  const distance = innerWidth + 150; // the screen and about the skunk's own length
  const ms = Math.min(SKUNK_MAX_MS, Math.max(SKUNK_MIN_MS, (1000 * distance) / SKUNK_PACE));
  walker.style.setProperty('--walk', `${ms}ms`);
  walker.style.setProperty('--delay', `${SKUNK_AT_MS}ms`);
  walker.hidden = false;
  return ms;
}

// Shows the game-over box. Also called early, when a tap or key skips the
// celebration; then the fireworks stop too, instead of fading out behind it.
function endCelebration(skipped = false) {
  if (!celebrating) return;
  clearTimeout(celebrating);
  celebrating = 0;
  if (skipped) stopParty();
  render();
}

function stopParty() {
  clearTimeout(celebrating);
  celebrating = 0;
  party?.stop();
  party = null;
  $('skunk-walk').hidden = true;
}

// Runs one game action, then saves and shows what it did.
function commit(action) {
  const before = { scores: [...game.scores], back: [...game.back], step: game.showStep, deals: game.deals };
  action();
  settle(before);
}

// Shows the game as it now is, after `before`: the deal, the count or the
// end of the game, with their sounds, and saves it.
function settle(before) {
  selected = [];
  tip = null;
  messages = describe(game.events);
  const dealt = game.deals !== before.deals;
  const counted = Boolean(game.show) && game.showStep !== before.step; // a hand or crib was just scored
  if (dealt) revealedTo = null; // new deal: hide every hand again
  if (game.phase === 'over') {
    recordGame(stats, game);
    store(STATS_KEY, stats);
    store(GAME_KEY, null);
  } else {
    store(GAME_KEY, game);
  }

  if (counted && game.show.items.length && !reducedMotion()) {
    countOut(before);
  } else {
    soundEvents(game.events);
    celebrate();
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
    const seat = game.turn;
    commit(() => {
      if (legalCards(game, seat).length) playCard(game, seat, pickPlay(game, seat));
      else go(game, seat);
    });
  }, AI_DELAY);
}

function onCard(card) {
  if (!canAct()) return;
  if (game.phase === 'discard') {
    selected = selected.includes(card) ? selected.filter(c => c !== card) : [...selected, card].slice(-tossCount(game));
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
  if (game.phase === 'discard' && selected.length === tossCount(game)) {
    selected.forEach((_, i) => playSound('slide', i * 0.09));
    commit(() => {
      discard(game, seat, selected);
      // The computer throws its cards along with the person's.
      for (const other of seats()) {
        if (isAi(other) && game.phase === 'discard' && !game.discards[other].length) discard(game, other, pickDiscard(game, other));
      }
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

// The players for a new game from the menu. Two people typing the same name
// become "Ann" and "Ann 2", so that every message names one person.
function playersFor() {
  if (settings.mode === 'ai') return [{ name: 'You' }, { name: 'Computer', ai: true, level: settings.difficulty }];
  const players = [];
  settings.names.slice(0, settings.players).forEach((typed, i) => {
    const wanted = typed.replace(/\s+/g, ' ').trim() || `Player ${i + 1}`;
    let name = wanted;
    for (let n = 2; players.some(other => other.name.toLowerCase() === name.toLowerCase()); n++) {
      name = `${wanted.slice(0, NAME_LENGTH - String(n).length - 1)} ${n}`;
    }
    players.push({ name });
  });
  return players;
}

function showMenu() {
  clearTimeout(aiTimer);
  clearTimeout(dealTimer);
  clearTimeout(counting?.timer);
  dealing = false;
  counting = null;
  stopParty();
  for (const group of document.querySelectorAll('.choice[data-setting]')) {
    for (const button of group.children) {
      button.setAttribute('aria-pressed', parseValue(button.dataset.value) === settings[group.dataset.setting]);
    }
  }
  const people = settings.mode === 'local';
  $('menu').dataset.mode = settings.mode;
  $('row-difficulty').hidden = settings.mode !== 'ai';
  $('row-players').hidden = !people;
  $('row-names').hidden = !people;
  $('row-partners').hidden = !people || settings.players !== 4;
  for (const field of document.querySelectorAll('[data-name]')) {
    const i = Number(field.dataset.name);
    field.hidden = i >= settings.players;
    field.value = settings.names[i];
  }

  const saved = upgradeGame(load(GAME_KEY));
  const canResume = saved?.v === 2 && saved.phase !== 'over';
  $('btn-resume').hidden = !canResume;
  if (canResume) $('btn-resume').textContent = `Resume game (${saved.scores.join('–')})`;
  $('btn-new').classList.toggle('primary', !canResume);

  for (const id of ['table', 'cover', 'gameover']) $(id).hidden = true;
  $('menu').hidden = false;
}

function start(saved = null) {
  stopParty();
  game = upgradeGame(saved) ?? newGame({ mode: settings.mode, difficulty: settings.difficulty, target: settings.target, players: playersFor() });
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

for (const field of document.querySelectorAll('[data-name]')) {
  field.addEventListener('input', () => {
    settings.names[Number(field.dataset.name)] = field.value.slice(0, NAME_LENGTH);
    store(SETTINGS_KEY, settings);
  });
}

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

$('skunk-walk').addEventListener('animationend', event => {
  if (event.animationName === 'walk') event.currentTarget.hidden = true;
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
      skipClick = dealing || Boolean(counting) || Boolean(celebrating);
      if (!skipClick) return;
      endCelebration(true); // first, as a count that wins the game starts one
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
