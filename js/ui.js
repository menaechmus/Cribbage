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
import { openRoom, joinRoom, cleanCode, CODE_LENGTH } from './net.js';
import { createHost, createGuest, cleanName, sameState, deniedText, MAX_PLAYERS, NAME_LENGTH } from './wifi.js';

// Shown in the About box. Bump both with every release: a browser still
// running a cached copy of this file then shows the old number.
const VERSION = '1.7.0';
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
const SETTINGS_KEY = 'cribbage.settings';
const GAME_KEY = 'cribbage.game';
const STATS_KEY = 'cribbage.stats';
const RECORDED_KEY = 'cribbage.recorded'; // the last Wi-Fi game in this phone's statistics
const WIFI_KEY = 'cribbage.wifi'; // per tab: this tab's part in a Wi-Fi game, for a reload
const TOKEN_KEY = 'cribbage.token'; // per tab: how the host knows this tab again

const $ = id => document.getElementById(id);

// ?store=NAME keeps this page's storage under keys of its own, so that the
// test driver's two frames can be two phones. `tab` storage (sessionStorage)
// lasts as long as the tab, through reloads.
const STORE = new URLSearchParams(location.search).get('store');
const keyed = key => (STORE ? `${key}:${STORE}` : key);

function load(key, tab = false) {
  try {
    return JSON.parse((tab ? sessionStorage : localStorage).getItem(keyed(key)));
  } catch {
    return null;
  }
}

function store(key, value, tab = false) {
  try {
    const place = tab ? sessionStorage : localStorage;
    if (value === null) place.removeItem(keyed(key));
    else place.setItem(keyed(key), JSON.stringify(value));
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
  const settings = { mode: 'ai', difficulty: 'medium', players: 2, names: ['', '', '', ''], wifiName: '', target: 121, hints: true, sound: true };
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
  if (typeof saved?.wifiName === 'string') settings.wifiName = saved.wifiName.slice(0, NAME_LENGTH);
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
let notice = ''; // why the host refused this phone's last move
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
let confirmed = null; // what the confirm box's button does
let aiTimer = 0;
let dealTimer = 0;
// A Wi-Fi game (see the section of that name below).
let session = null; // this phone's part: { role: 'host', host, room, code, trouble } or { role: 'guest', guest, code, players }
let me = 0; // this phone's seat in it
let away = []; // seats whose phones are out of touch
let sent = false; // a guest's move is with the host, and not yet answered
let inbox = []; // moves and states that came during the deal or a count
let wifiBox = null; // what the Wi-Fi box shows: 'host', 'join' or 'ended'
let wifiNote = { text: '', warn: false }; // its status line
let waitingCode = ''; // a shared link's code, while the name is still to type

setMuted(!settings.sound);

// ---- Who is who ---------------------------------------------------------

const wifiGame = () => game?.mode === 'net';
const isHost = () => wifiGame() && session?.role === 'host';
const isGuest = () => wifiGame() && session?.role === 'guest';
const liveWifi = () => Boolean(session) && wifiGame();
// A guest whose link to the host has gone can only wait for it to come back.
const linkDown = () => isGuest() && !session.guest.connected;

const seats = () => game.players.map((_, seat) => seat);
const isAi = seat => game.players[seat].ai;
// In a Wi-Fi game each phone calls its own player "You".
const nameOf = seat => (wifiGame() && seat === me ? 'You' : game.players[seat].name);
const isYou = seat => nameOf(seat) === 'You';
const owner = seat => (isYou(seat) ? 'Your' : `${nameOf(seat)}'s`);
const does = (seat, verb) => `${nameOf(seat)} ${verb}${isYou(seat) ? '' : 's'}`;
const capital = text => text[0].toUpperCase() + text.slice(1);
const listText = items => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const side = seat => sideOf(game, seat);
// A side's name: a player's own, or a partnership's, "Ann & Cy".
const sideName = s => seatsOf(game, s).map(nameOf).join(' & ');
// Whether a person is on the winning side; in a Wi-Fi game, this phone's
// person.
const personWon = () => (wifiGame() ? side(me) === game.winner : seatsOf(game, game.winner).some(seat => !isAi(seat)));
// Hints: in a Wi-Fi game the host's choice, for everyone; otherwise the menu's.
const hintsOn = () => (wifiGame() && game.rules ? game.rules.hints : settings.hints);

// The seat that must act now, or null while hands are being counted. In the
// discard, people take turns round the table from the dealer's left; the
// computer throws its cards along with the person's; and in a Wi-Fi game
// every phone throws at once, so it is this phone's player until done.
function actor() {
  if (game.phase === 'discard') {
    if (wifiGame()) return game.discards[me].length ? null : me;
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
// the person, on Wi-Fi this phone's player, between people on one device
// whoever must act.
const viewer = () => (game.mode === 'ai' ? 0 : wifiGame() ? me : actor() ?? revealedTo ?? 0);

// People sharing one screen keep their cards hidden until their owner asks.
const covered = () => game.mode === 'local' && actor() !== null && actor() !== revealedTo;
const canAct = () =>
  actor() !== null && !isAi(actor()) && !covered() && !dealing && (!wifiGame() || (actor() === me && !sent && !linkDown()));

// The seat the host may act for: a person whose phone is out of touch, on
// their turn in the play or still to throw in the discard.
function standIn() {
  if (!isHost() || counting || dealing) return null;
  const gone = seat => seat !== me && Boolean(away[seat]) && !isAi(seat);
  if (game.phase === 'play') return gone(game.turn) ? game.turn : null;
  if (game.phase === 'discard') return seats().find(seat => gone(seat) && !game.discards[seat].length) ?? null;
  return null;
}

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

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
function othersHtml(bottom) {
  const count = game.players.length;
  return Array.from({ length: count - 1 }, (_, i) => (bottom + 1 + i) % count)
    .map(seat => {
      const notes = [game.dealer === seat && 'dealer', count === 4 && side(seat) === side(bottom) && 'partner'].filter(Boolean);
      const label = [nameOf(seat), ...notes].join(' · ');
      return `<div class="other" data-seat="${seat}"><div class="seat-label">${escapeHtml(label)}</div><div class="hand hand-small">${BACK.repeat(game.hands[seat].length)}</div></div>`;
    })
    .join('');
}

function playHtml(bottom) {
  const old = game.pile.length - game.stack.length; // cards from counts already finished
  const marked = game.players.length > 2; // with more players, a dot says whose card it is
  const pile = game.pile
    .map(({ card, player }, i) => {
      const classes = [side(player) === side(bottom) ? 'mine' : 'theirs', marked && `marked side${side(player)}`, i < old && 'old', i >= pileShown && 'fresh'];
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

// What the prompt says, and whether as a warning.
function promptText(bottom, acting) {
  if (dealing) return ['Shuffling and dealing…', false];
  if (counting) return ['Counting. Tap to skip.', false];
  if (wifiGame() && game.phase !== 'over') {
    const host = game.players[0].name;
    if (linkDown()) return [`Lost touch with ${host}'s phone. Trying again…`, true];
    if (sent) return ['Sent. Waiting for the host…', false];
    if (isHost() && !session.room) return session.trouble ? [`${session.trouble} Trying again…`, true] : ['Opening the game to the other phones…', false];
    if (notice) return [notice, true];
    const standing = standIn();
    if (standing !== null) return [`${nameOf(standing)}'s phone is out of touch. Wait for it, or press the button to let the computer choose for ${nameOf(standing)}.`, true];
    if (game.phase === 'discard' && !acting) {
      const waiting = seats().filter(seat => !game.discards[seat].length).map(seat => `${nameOf(seat)}${away[seat] ? ' (out of touch)' : ''}`);
      return [`Waiting for ${listText(waiting)} to choose for the crib.`, false];
    }
    if (game.phase === 'play' && game.turn !== me && !isAi(game.turn)) {
      return [away[game.turn] ? `${nameOf(game.turn)}'s turn, but ${nameOf(game.turn)}'s phone is out of touch.` : `${nameOf(game.turn)}'s turn.`, false];
    }
  }
  if (game.phase === 'discard' && acting) {
    const cards = tossCount(game) === 2 ? 'two cards' : 'a card';
    return [`Choose ${cards} for ${game.dealer === bottom ? 'your own' : `${nameOf(game.dealer)}'s`} crib.`, false];
  }
  if (game.phase === 'play') {
    if (isAi(game.turn)) return [`${nameOf(game.turn)} is thinking…`, false];
    if (acting && !legalCards(game, bottom).length) return ['None of your cards fits under 31. Press Go.', false];
    if (acting) return [selected.length ? 'Tap it again, or press Play.' : 'Your turn. Choose a card to play.', false];
  }
  if (game.phase === 'show' && !game.show) return ['All the cards are played. Time to count the hands.', false];
  return ['', false];
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
  if (game.phase === 'show') return [showLabel(), !counting && !sent && !linkDown()];
  const standing = acting ? null : standIn();
  if (game.phase === 'discard') {
    if (standing !== null) return [`Throw for ${nameOf(standing)}`, true];
    return ['Send to crib', acting && selected.length === tossCount(game)];
  }
  if (game.phase === 'play') {
    if (standing !== null) return [`${legalCards(game, standing).length ? 'Play' : 'Go'} for ${nameOf(standing)}`, true];
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
  const names = sideName(game.winner);
  const many = seatsOf(game, game.winner).length > 1;
  const title = game.mode === 'ai' ? (game.winner === 0 ? 'You win!' : 'Computer wins') : names === 'You' ? 'You win!' : `${names} win${many ? '' : 's'}`;
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
  // Only the host of a Wi-Fi game can start the next one.
  const again = isGuest()
    ? `<p class="muted">Waiting for ${escapeHtml(game.players[0].name)} to start another game.</p>`
    : '<button class="btn primary" data-do="again">Play again</button>';
  return `
    <h2>${escapeHtml(title)}</h2>
    ${skunked ? `<p class="skunk">${escapeHtml(skunked)}</p>` : ''}
    <table class="grid">
      <thead><tr><th></th><th>Score</th><th>Pegging</th><th>Hands</th><th>Cribs</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${row ? `<p class="muted">${capital(game.difficulty)} computer: ${row.wins} won of ${row.games} played.</p>` : ''}
    ${again}
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
  const bottom = viewer();
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
    // A Wi-Fi player whose phone is out of touch is dimmed; on a guest's
    // phone, the host when the link to it has gone.
    const gone = wifiGame() && seatsOf(game, s).some(seat => away[seat] || (seat === 0 && linkDown()));
    score.querySelector('.name').textContent = sideName(s);
    score.querySelector('.points').textContent = board.scores[s];
    score.classList.toggle('active', now !== null && side(now) === s);
    score.classList.toggle('away', gone);
    for (const [which, hole] of pegHoles(s, board)) {
      $('board').querySelector(`.peg.side${s}.${which}`).style.transform = pegTransform(s, hole);
    }
  });

  $('others').innerHTML = othersHtml(bottom);
  $('bottom-label').textContent = `${nameOf(bottom)}${game.dealer === bottom ? ' · dealer' : ''}`;

  const legal = game.phase === 'play' && acting ? legalCards(game, bottom) : null;
  const turning = turnUp && !hidden && !dealing;
  turnUp = false;
  $('bottom-hand').innerHTML = game.hands[bottom]
    .map(card => {
      if (hidden || dealing) return BACK;
      const classes = [selected.includes(card) && 'selected', tip?.cards.includes(card) && 'tip', legal && !legal.includes(card) && 'dim', turning && 'turn'];
      return cardHtml(card, classes.filter(Boolean).join(' '), true);
    })
    .join('');
  if (turning) [...$('bottom-hand').children].forEach((card, i) => card.style.setProperty('--i', i));

  $('center').innerHTML = game.show ? tallyHtml() : playHtml(bottom);
  pileShown = game.pile.length;
  starterShown = game.starter !== null;

  $('events').textContent = messages.join(' ');
  const [prompt, warn] = tip ? [tip.text, false] : promptText(bottom, acting);
  $('prompt').textContent = prompt;
  $('prompt').classList.toggle('tip', Boolean(tip));
  $('prompt').classList.toggle('warn', warn);

  const [text, enabled] = mainButton(acting);
  $('btn-main').textContent = text;
  $('btn-main').disabled = !enabled;
  $('btn-hint').hidden = !hintsOn();
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
  const bottom = viewer();
  const count = game.players.length;
  const handOf = seat => (seat === bottom ? $('bottom-hand') : $('others').querySelector(`[data-seat="${seat}"] .hand`));
  const flights = [];
  for (let i = 0; i < count * game.hands[0].length; i++) {
    const seat = (game.dealer + 1 + (i % count)) % count;
    flights.push(handOf(seat).children[Math.floor(i / count)]);
  }
  if (game.crib.length) flights.push($('center').querySelector('.crib .card'));

  const deck = $('center').querySelector('.deck').getBoundingClientRect();
  const gap = Math.min(DEAL_GAP_MS, DEAL_MS / (flights.length - 1));
  flights.forEach((card, i) => {
    if (!card) return;
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
  drainInbox();
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
  drainInbox();
}

// A win by a person is celebrated before the game-over box appears: fireworks
// and confetti, and on a skunk a skunk walking by. A win for the computer goes
// straight to the box. Called just before the redraw that shows the end.
function celebrate() {
  if (game.phase !== 'over' || !personWon() || reducedMotion() || $('table').hidden) return;
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

// What the game looked like before a change, for what settle() shows.
const snapshot = () => ({ scores: [...game.scores], back: [...game.back], step: game.showStep, deals: game.deals, phase: game.phase, turn: game.turn });

// Runs one game action, then shows what it did.
function commit(action) {
  const before = snapshot();
  action();
  settle(before);
}

// Everything that follows a change to the game, made here or, on a guest's
// phone in a Wi-Fi game, by the host: what it says, saving, statistics,
// sending it to the other phones, sounds, the deal or the count, and the
// next turn. While the host looks at the menu its game goes on unseen.
function settle(before) {
  selected = [];
  tip = null;
  notice = '';
  messages = describe(game.events);
  const dealt = game.deals !== before.deals;
  const counted = Boolean(game.show) && game.showStep !== before.step; // a hand or crib was just scored
  if (dealt) revealedTo = null; // new deal: hide every hand again
  if (!isGuest()) store(GAME_KEY, game.phase === 'over' ? null : game);
  if (game.phase === 'over') record();
  if (isHost()) session.host.share(game);

  if ($('table').hidden) {
    render();
  } else if (counted && game.show.items.length && !reducedMotion()) {
    countOut(before);
  } else {
    soundEvents(game.events);
    celebrate();
    if (dealt) dealCards();
    else render();
  }
  if (wifiGame()) alertTurn(before, dealt);
  scheduleAi();
}

// A finished game counts once in this phone's statistics, though the last
// state of a Wi-Fi game can reach a phone more than once.
function record() {
  if (wifiGame()) {
    if (load(RECORDED_KEY) === game.id) return;
    store(RECORDED_KEY, game.id);
  }
  recordGame(stats, game);
  store(STATS_KEY, stats);
}

// The computer's move, after a pause: in the play a card if one fits,
// otherwise go; in a Wi-Fi game's discard, each computer throws in turn. The
// computers of a Wi-Fi game play on the host's phone, even while its menu
// is up; the other phones only see their moves arrive.
function scheduleAi() {
  clearTimeout(aiTimer);
  if (!game || isGuest() || (!isHost() && $('table').hidden)) return;
  if (game.phase === 'discard' && wifiGame()) {
    const seat = seats().find(other => isAi(other) && !game.discards[other].length);
    if (seat !== undefined) aiTimer = setTimeout(() => whenIdle(() => commit(() => discard(game, seat, pickDiscard(game, seat)))), AI_DELAY);
    return;
  }
  if (game.phase !== 'play' || !isAi(game.turn)) return;
  aiTimer = setTimeout(() => {
    whenIdle(() => {
      const seat = game.turn;
      if (game.phase !== 'play' || !isAi(seat)) return;
      commit(() => {
        if (legalCards(game, seat).length) playCard(game, seat, pickPlay(game, seat));
        else go(game, seat);
      });
    });
  }, AI_DELAY);
}

// A move by this phone's player: run here, or on a guest's phone in a Wi-Fi
// game sent to the host, whose answer comes back as the next state or as a
// refusal.
function act(move) {
  if (isGuest()) {
    notice = '';
    sent = session.guest.send(move);
    render();
    return;
  }
  const seat = actor();
  commit(() => apply(seat, move));
}

// A move made by `seat`, from this phone or (on the host's) another.
// Against the computer, it throws its cards along with the person's. `next`
// moves the show on only from the step the phone was looking at.
function apply(seat, move) {
  if (move.t === 'next') {
    if (move.step === game.showStep) advanceShow(game);
  } else if (move.t === 'discard') {
    discard(game, seat, move.cards);
    if (game.mode === 'ai') {
      for (const other of seats()) {
        if (isAi(other) && game.phase === 'discard' && !game.discards[other].length) discard(game, other, pickDiscard(game, other));
      }
    }
  } else if (move.t === 'play') {
    playCard(game, seat, move.card);
  } else {
    go(game, seat);
  }
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
  if (counting || dealing) return;
  if (game.phase === 'show') {
    if (!sent && !linkDown()) act({ t: 'next', step: game.showStep });
    return;
  }
  if (!canAct()) {
    const seat = standIn();
    if (seat !== null) playFor(seat);
    return;
  }
  const seat = actor();
  if (game.phase === 'discard' && selected.length === tossCount(game)) {
    selected.forEach((_, i) => playSound('slide', i * 0.09));
    act({ t: 'discard', cards: [...selected] });
  } else if (game.phase === 'play' && !legalCards(game, seat).length) {
    act({ t: 'go' });
  } else if (game.phase === 'play' && selected.length === 1) {
    act({ t: 'play', card: selected[0] });
  }
}

// On the host's phone, the main button also moves for a Wi-Fi player whose
// phone is out of touch: the computer's best choice, after asking.
function playFor(seat) {
  const name = nameOf(seat);
  const verb = game.phase === 'discard' ? 'Throw' : legalCards(game, seat).length ? 'Play' : 'Go';
  confirmFirst(`${verb} for ${name}?`, `${name}'s phone is out of touch. The computer makes its best choice for ${name}.`, verb, () => {
    if (standIn() !== seat) return;
    commit(() => {
      if (game.phase === 'discard') discard(game, seat, pickDiscard(game, seat, 'hard'));
      else if (legalCards(game, seat).length) playCard(game, seat, pickPlay(game, seat, 'hard'));
      else go(game, seat);
    });
  });
}

function onHint() {
  if (!hintsOn() || !canAct()) return;
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

function confirmFirst(title, text, button, action) {
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  $('btn-confirm').textContent = button;
  confirmed = action;
  $('confirm').hidden = false;
}

// ---- Wi-Fi games ------------------------------------------------------------

// Each person plays on their own phone. The host's phone keeps the real game
// and runs every move; the others send theirs and get back their own view
// of it (wifi.js), over direct links between the phones (net.js).

// Moves and states that arrive during the deal or a count wait until it is
// over, as the computer does.
function whenIdle(task) {
  if (counting || dealing) inbox.push(task);
  else task();
}

function drainInbox() {
  while (inbox.length && !counting && !dealing) inbox.shift()();
}

// This phone's turn: a chime, and a buzz where the phone can. It comes when
// the play reaches this phone's player, and with each new deal.
function alertTurn(before, dealt) {
  const mine = game.phase === 'play' && game.turn === me && !(before.phase === 'play' && before.turn === me);
  if (!mine && !(dealt && game.phase === 'discard')) return;
  playSound('turn', dealt ? 1.2 : 0.2);
  try {
    navigator.vibrate?.(120);
  } catch {
    // no buzz, then
  }
}

// The screen stays on while this phone is in a Wi-Fi game, as a phone that
// sleeps drops out. The browser lets the lock go whenever the page is
// hidden, so it is asked for again each time the page comes back.
let wakeLock = null;
let askingLock = false;
async function keepAwake(on) {
  if (!on) {
    const lock = wakeLock;
    wakeLock = null;
    lock?.release().catch(() => {});
    return;
  }
  if (wakeLock || askingLock || document.visibilityState !== 'visible' || !navigator.wakeLock) return;
  askingLock = true;
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (session) {
      wakeLock = lock;
      lock.addEventListener('release', () => {
        if (wakeLock === lock) wakeLock = null;
      });
    } else lock.release().catch(() => {});
  } catch {
    // Refused (on low battery, say): the game goes on without it.
  }
  askingLock = false;
}

document.addEventListener('visibilitychange', () => keepAwake(Boolean(session)));

// Hosting and joining need a name, which the others see.
function needName() {
  $('wifi-name').classList.add('want');
  $('wifi-name').focus();
}

// The host knows this tab again by its token, which lasts as long as the tab.
function wifiToken() {
  let token = load(TOKEN_KEY, true);
  if (typeof token !== 'string' || !token) {
    token = `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    store(TOKEN_KEY, token, true);
  }
  return token;
}

// What this tab is doing in a Wi-Fi game, so that a reload goes back to it.
function storeWifi() {
  store(WIFI_KEY, session ? { role: session.role, code: session.code } : null, true);
}

// Ends this phone's part in the Wi-Fi game. The host's ends it for everyone;
// a guest gives up its seat, which the host keeps in case it comes back.
function endWifi() {
  if (!session) return;
  const ending = session;
  session = null;
  storeWifi();
  if (ending.role === 'host') {
    clearTimeout(aiTimer); // its computers stop playing
    // The room outlasts the goodbye a moment: closing it hangs up at once.
    ending.host.close('ended');
    setTimeout(() => ending.room?.close(), 1000);
  } else {
    ending.guest.leave();
    if (wifiGame()) game = null;
  }
  away = [];
  sent = false;
  inbox = [];
  keepAwake(false);
}

// Runs `action` once this phone has left its Wi-Fi game, asking first while
// that game is being played.
function leaving(action) {
  const playing = liveWifi() && game.phase !== 'over';
  if (!playing) {
    endWifi();
    action();
    return;
  }
  const hosting = session.role === 'host';
  confirmFirst(
    hosting ? 'End the Wi-Fi game?' : 'Leave the Wi-Fi game?',
    hosting ? 'The other phones will be told that it has ended.' : 'Your seat is kept: join again with the same name to take it back.',
    hosting ? 'End it' : 'Leave',
    () => {
      endWifi();
      action();
    },
  );
}

// Host a game: a room under a new code, and the box that shows the code and
// who has joined, where Start begins the game.
function hostGame() {
  const name = cleanName(settings.wifiName);
  if (!name) {
    needName();
    return;
  }
  leaving(() => {
    const host = createHost({ name, version: VERSION, onmove: hostMove, onchange: hostChanged });
    session = { role: 'host', host, room: null, code: '', trouble: '' };
    keepAwake(true);
    showWifi('host');
    reopen(session);
  });
}

// Opens the room for `attempt`, a host's session: under its code when it has
// one (a saved game), otherwise a new one. During a game a failure is tried
// again; in the box, Try again does that.
async function reopen(attempt) {
  try {
    const room = await openRoom({ code: attempt.code || null, onlink: link => attempt.host.attach(link) });
    if (session !== attempt) {
      room.close();
      return;
    }
    Object.assign(attempt, { room, code: room.code, trouble: '' });
    if (wifiGame() && game.net) game.net.code = room.code;
    storeWifi();
  } catch (error) {
    if (session !== attempt) return;
    attempt.trouble = error.message;
    if (wifiGame() && attempt.host.started) setTimeout(() => session === attempt && reopen(attempt), 5000);
  }
  drawWifi();
  if (game && !$('table').hidden) render();
}

// A Wi-Fi game saved on the host's phone: its code is opened again, and the
// other phones, which keep trying, come back by themselves.
function resumeHosting(saved) {
  const seated = saved.net?.seats ?? saved.players.map(player => ({ name: player.name, token: null }));
  const host = createHost({ name: saved.players[0].name, version: VERSION, seats: seated, onmove: hostMove, onchange: hostChanged });
  session = { role: 'host', host, room: null, code: saved.net?.code ?? '', trouble: '' };
  me = 0;
  away = host.away();
  start(saved);
  storeWifi();
  reopen(session);
}

// Someone joined, came back or dropped out. The lobby shows it; in a game,
// every phone is sent the game again, so that the one that came back has it
// and the others' scores dim or light up.
function hostChanged() {
  if (session?.role !== 'host') return;
  if (wifiGame() && session.host.started) {
    away = session.host.away();
    game.net = { code: session.code, seats: session.host.saved() };
    if (game.phase !== 'over') store(GAME_KEY, game);
    session.host.share(game);
    if (!$('table').hidden) render();
  }
  drawWifi();
}

// A guest's move, run here as the host's own are, after any deal or count
// that is under way. A press of Next from a phone that is a step behind
// (someone else was quicker) is let go.
function hostMove(seat, move) {
  if (!isHost() || !session.host.started) return;
  const attempt = session;
  whenIdle(() => {
    if (session !== attempt || !wifiGame()) return;
    if (move.t === 'next' && (game.phase !== 'show' || move.step !== game.showStep)) return;
    const before = snapshot();
    try {
      apply(seat, move);
    } catch (error) {
      session.host.refuse(seat, error.message);
      return;
    }
    settle(before);
  });
}

// Start, in the host's box: a game for everyone in the lobby, with the host's
// game length and hints.
function startWifiGame() {
  if (session?.role !== 'host' || !session.room || session.host.players().length < 2) return;
  const players = session.host.begin();
  const next = newGame({ mode: 'net', target: settings.target, players });
  next.rules = { hints: settings.hints };
  next.net = { code: session.code, seats: session.host.saved() };
  me = 0;
  away = session.host.away();
  hideWifi();
  start(next, true);
}

// Play again, on the host's phone: back to the lobby with whoever is still
// there, which others may join as well.
function hostAgain() {
  session.host.reopen();
  showWifi('host');
}

// Join a game: the box asks for the code. A shared link brings its code,
// and then joins straight away.
function openJoin(code = '') {
  if (!cleanName(settings.wifiName)) {
    waitingCode = code;
    needName();
    return;
  }
  waitingCode = '';
  leaving(() => {
    showWifi('join');
    $('join-code').value = cleanCode(code);
    if (code) joinGame();
  });
}

async function joinGame() {
  if (session) return;
  const code = cleanCode($('join-code').value);
  if (code.length !== CODE_LENGTH) {
    wifiStatus(`A code has ${CODE_LENGTH} letters.`, true);
    return;
  }
  const guest = createGuest({
    name: cleanName(settings.wifiName),
    token: wifiToken(),
    version: VERSION,
    connect: () => joinRoom(code),
    onmessage: guestHeard,
    onlink: guestLink,
  });
  const attempt = { role: 'guest', guest, code, players: null };
  session = attempt;
  keepAwake(true);
  wifiStatus('');
  try {
    await guest.join();
  } catch (error) {
    if (session !== attempt) return;
    session = null;
    storeWifi(); // a reload no longer tries this game
    keepAwake(false);
    wifiStatus(error.message, true);
    return;
  }
  if (session === attempt) storeWifi();
}

// What the host sends a guest.
function guestHeard(message) {
  if (session?.role !== 'guest') return;
  if (message.t === 'lobby') {
    session.players = message.players;
    // After a game, its results stay on screen (with this phone's old seat)
    // until the host starts the next one.
    if (wifiGame()) return;
    me = message.seat;
    if (!wifiBox) showWifi('join');
    drawWifi();
  } else if (message.t === 'state') {
    const attempt = session;
    session.players = message.game.players.map((player, seat) => ({ name: player.name, here: !message.away[seat] }));
    whenIdle(() => session === attempt && guestState(message));
  } else if (message.t === 'refused') {
    sent = false;
    notice = message.message;
    if (game && !$('table').hidden) render();
  } else {
    // The host ended the game, or would not take this phone back.
    const owner = session.players?.[0]?.name ?? 'The host';
    endWifi();
    showMenu();
    showWifi('ended', message.t === 'closed' ? `${owner} ended the game.` : deniedText(message, VERSION));
  }
}

// The game as the host sends it. A new one starts here, with its deal; the
// one already here moves on as if the move were made on this phone; one this
// phone has already only says who is there.
function guestState({ seat, game: next, away: gone }) {
  me = seat;
  away = gone;
  if (!wifiGame() || game.id !== next.id) {
    hideWifi();
    start(next, next.phase === 'discard' && !next.discards.some(cards => cards.length));
    return;
  }
  if (sameState(game, next)) {
    if (!$('table').hidden) render();
    return;
  }
  const before = snapshot();
  game = next;
  sent = false;
  settle(before);
}

// The link to the host went, or came back. A move sent just before it went
// may never be answered: the next state will tell.
function guestLink(up) {
  if (!up) sent = false;
  if (game && !$('table').hidden) render();
  drawWifi();
}

// Resume on the menu: back to the Wi-Fi game this phone is in, or else the
// saved game, which for a Wi-Fi game's host opens its code again.
function resume() {
  if (liveWifi()) {
    $('menu').hidden = true;
    $('table').hidden = false;
    render();
    keepAwake(true);
    scheduleAi();
    return;
  }
  const saved = upgradeGame(load(GAME_KEY));
  if (saved?.mode === 'net') resumeHosting(saved);
  else start(saved);
}

// The address that opens this game's Join box, sent with the phone's own
// Share sheet, or else copied.
async function shareLink() {
  if (session?.role !== 'host' || !session.code) return;
  const url = new URL(location.pathname, location.origin);
  url.searchParams.set('join', session.code);
  const net = new URLSearchParams(location.search).get('net');
  if (net) url.searchParams.set('net', net);
  try {
    if (navigator.share) await navigator.share({ title: 'Cribbage', text: `Join my cribbage game: the code is ${session.code}.`, url: url.href });
    else {
      await navigator.clipboard.writeText(url.href);
      wifiStatus('Link copied. Paste it into a message to the others.');
    }
  } catch (error) {
    if (error?.name !== 'AbortError') wifiStatus(url.href);
  }
}

// The Wi-Fi box: the host's code and lobby, a guest's join and wait, or why
// a Wi-Fi game ended.
function showWifi(kind, text = '') {
  wifiBox = kind;
  wifiNote = { text, warn: kind === 'ended' };
  $('wifi').hidden = false;
  drawWifi();
  if (kind === 'join' && !session && matchMedia('(pointer: fine)').matches) $('join-code').focus();
}

function hideWifi() {
  wifiBox = null;
  $('wifi').hidden = true;
}

function wifiStatus(text, warn = false) {
  wifiNote = { text, warn };
  drawWifi();
}

// Cancel (or Leave) gives up the lobby and goes to the menu; after a Wi-Fi
// game has ended, OK goes there too.
function cancelWifi() {
  const ended = wifiBox === 'ended';
  hideWifi();
  if (!ended) endWifi();
  showMenu();
}

// Which side a seat will play for once the game starts with `count` players:
// its own, or with four the partnership of seats 0 and 2 or of 1 and 3.
const lobbySide = (seat, count) => (count === 4 ? seat % 2 : seat);

function drawWifi() {
  if (!wifiBox) return;
  const hosting = wifiBox === 'host' && session?.role === 'host';
  const guest = wifiBox === 'join' && session?.role === 'guest' ? session.guest : null;
  const players = hosting ? session.host.players() : guest ? session.players : null;
  const owner = players?.[0]?.name ?? 'the host';
  let title = 'Wi-Fi game';
  let text = '';
  let { text: status, warn } = wifiNote;
  let goLabel = null;
  let cancel = 'Cancel';
  let listed = false;
  if (wifiBox === 'ended') {
    goLabel = 'OK';
    cancel = null;
  } else if (wifiBox === 'host') {
    title = 'Host a game';
    if (hosting && session.room) {
      text = 'On the other phones, choose Wi-Fi, tap Join a game and enter:';
      listed = true;
      goLabel = 'Start';
      if (!status) status = players.length < 2 ? 'Waiting for the others to join…' : players.length < MAX_PLAYERS ? 'Start when everyone is in.' : `${MAX_PLAYERS} players: the game is full.`;
    } else if (hosting && session.trouble) {
      [status, warn] = [session.trouble, true];
      goLabel = 'Try again';
    } else if (hosting) text = 'Opening a game…';
  } else {
    title = 'Join a game';
    if (!guest) {
      text = "Enter the code on the host's screen.";
      goLabel = 'Join';
    } else if (guest.connected && players) {
      text = `You are in ${owner}'s game.`;
      listed = true;
      cancel = 'Leave';
      if (!status) status = `Waiting for ${owner} to start…`;
    } else if (players) {
      text = `Lost touch with ${owner}'s phone. Trying again…`;
      listed = true;
      cancel = 'Leave';
    } else text = `Connecting to game ${session.code}…`;
  }
  $('wifi-title').textContent = title;
  $('wifi-text').textContent = text;
  $('wifi-text').hidden = !text;
  const code = hosting && session.room ? session.code : '';
  $('wifi-code').hidden = !code;
  $('wifi-code').innerHTML = [...code].map(letter => `<span class="card">${letter}</span>`).join('');
  $('wifi-code').setAttribute('aria-label', `Code ${[...code].join(' ')}`);
  $('btn-share').hidden = !code;
  $('join-code').hidden = !(wifiBox === 'join' && !guest);
  $('wifi-players').hidden = !listed;
  // Computers are marked as such, and the host can take them out again.
  const mine = hosting ? 0 : me;
  const count = players?.length ?? 0;
  const entry = (player, seat) => {
    const label = seat === mine ? '(you)' : player.ai ? 'computer' : '';
    const remove = hosting && player.ai ? `<button class="remove" data-remove="${seat}" aria-label="Take out ${escapeHtml(player.name)}">×</button>` : '';
    return `<li${player.here ? '' : ' class="away"'}><i class="side${lobbySide(seat, count)}"></i><span class="who">${escapeHtml(player.name)}${label ? ` <span class="muted">${label}</span>` : ''}</span>${remove}</li>`;
  };
  $('wifi-players').innerHTML = listed ? players.map(entry).join('') : '';
  // With four, who partners whom follows the order of joining.
  const pairs = listed && count === 4 ? `Partners: ${escapeHtml(players[0].name)} & ${escapeHtml(players[2].name)} against ${escapeHtml(players[1].name)} & ${escapeHtml(players[3].name)}.` : '';
  $('wifi-partners').hidden = !pairs;
  $('wifi-partners').innerHTML = pairs;
  $('wifi-computers').hidden = !(hosting && session.room && count < MAX_PLAYERS);
  $('wifi-status').textContent = status;
  $('wifi-status').classList.toggle('warn', warn);
  $('btn-wifi-go').hidden = !goLabel;
  $('btn-wifi-go').textContent = goLabel ?? '';
  $('btn-wifi-go').disabled = goLabel === 'Start' && count < 2;
  $('btn-wifi-cancel').hidden = !cancel;
  $('btn-wifi-cancel').textContent = cancel ?? '';
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

// A Wi-Fi game goes on while its host looks at the menu: its computers keep
// playing, and the others' moves keep coming. Anything being shown (the
// deal, a count) is cut short.
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
  const { mode } = settings;
  const people = mode === 'local';
  $('menu').dataset.mode = mode;
  $('row-difficulty').hidden = mode !== 'ai';
  $('row-players').hidden = !people;
  $('row-names').hidden = !people;
  $('row-partners').hidden = !people || settings.players !== 4;
  $('row-wifi-name').hidden = mode !== 'net';
  $('row-wifi').hidden = mode !== 'net';
  $('btn-new').hidden = mode === 'net';
  for (const field of document.querySelectorAll('[data-name]')) {
    const i = Number(field.dataset.name);
    field.hidden = i >= settings.players;
    field.value = settings.names[i];
  }
  $('wifi-name').value = settings.wifiName;

  // Resume goes back to a Wi-Fi game this phone is in, or else to the saved game.
  const saved = liveWifi() ? null : upgradeGame(load(GAME_KEY));
  const canResume = liveWifi() ? game.phase !== 'over' : saved?.v === 2 && saved.phase !== 'over';
  $('btn-resume').hidden = !canResume;
  if (liveWifi()) $('btn-resume').textContent = `Back to the Wi-Fi game (${game.scores.join('–')})`;
  else if (canResume) $('btn-resume').textContent = `Resume ${saved.mode === 'net' ? 'Wi-Fi game' : 'game'} (${saved.scores.join('–')})`;
  for (const id of ['btn-new', 'btn-host', 'btn-join']) $(id).classList.toggle('primary', !canResume);

  for (const id of ['table', 'cover', 'gameover', 'confirm']) $(id).hidden = true;
  $('menu').hidden = false;
  drainInbox();
  if (isHost()) scheduleAi();
}

// `fresh` is a game just begun, whose deal is shown.
function start(saved = null, fresh = !saved) {
  stopParty();
  game = upgradeGame(saved) ?? newGame({ mode: settings.mode, difficulty: settings.difficulty, target: settings.target, players: playersFor() });
  if (!wifiGame()) {
    me = 0;
    away = [];
  }
  selected = [];
  tip = null;
  notice = '';
  messages = [];
  sent = false;
  inbox = [];
  revealedTo = null;
  pileShown = game.pile.length;
  starterShown = game.starter !== null;
  drawBoard();
  $('menu').hidden = true;
  $('table').hidden = false;
  if (!isGuest()) store(GAME_KEY, game);
  if (isHost()) session.host.share(game);
  if (fresh) dealCards();
  else render();
  scheduleAi();
  keepAwake(Boolean(session));
  if (wifiGame()) alertTurn({ phase: null, turn: null }, fresh);
}

// Play again, after a game on this device: the same players, at the same
// length and level, whatever the menu now says.
function playAgain() {
  const { mode, difficulty, target, players } = game;
  start(newGame({ mode, difficulty, target, players: players.map(({ name, ai, level }) => ({ name, ai, level })) }), true);
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

$('wifi-name').addEventListener('input', event => {
  event.target.classList.remove('want');
  settings.wifiName = event.target.value.slice(0, NAME_LENGTH);
  store(SETTINGS_KEY, settings);
});

$('btn-new').addEventListener('click', () => leaving(() => start()));
$('btn-resume').addEventListener('click', resume);
$('btn-host').addEventListener('click', hostGame);
$('btn-join').addEventListener('click', () => openJoin(waitingCode));
$('btn-share').addEventListener('click', shareLink);
// The host seats a computer player at the level tapped, or takes one out.
$('wifi-computers').addEventListener('click', event => {
  const button = event.target.closest('[data-level]');
  if (button && session?.role === 'host') session.host.addComputer(button.dataset.level);
});
$('wifi-players').addEventListener('click', event => {
  const button = event.target.closest('[data-remove]');
  if (button && session?.role === 'host') session.host.removeComputer(Number(button.dataset.remove));
});
$('btn-wifi-cancel').addEventListener('click', cancelWifi);
$('btn-wifi-go').addEventListener('click', () => {
  if (wifiBox === 'ended') cancelWifi();
  else if (wifiBox === 'join') joinGame();
  else if (session?.role === 'host' && !session.room) {
    session.trouble = '';
    drawWifi();
    reopen(session);
  } else startWifiGame();
});
$('join-code').addEventListener('input', event => {
  event.target.value = cleanCode(event.target.value);
  if (wifiNote.warn) wifiStatus('');
});
$('join-code').addEventListener('keydown', event => {
  if (event.key === 'Enter') joinGame();
});
$('btn-confirm').addEventListener('click', () => {
  $('confirm').hidden = true;
  const action = confirmed;
  confirmed = null;
  action?.();
});

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
  if (action === 'again') {
    if (isHost()) hostAgain();
    else playAgain();
  } else if (action === 'stats') showStats();
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
    if (!$('wifi').hidden) cancelWifi();
    else for (const id of ['rules', 'stats', 'about', 'confirm']) $(id).hidden = true;
    return;
  }
  if (event.target.matches?.('input')) return;
  const busy = !game || $('table').hidden || !$('rules').hidden || !$('stats').hidden || !$('confirm').hidden || game.phase === 'over';
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

// A tab that was in a Wi-Fi game (reloaded, or brought back by the browser)
// goes straight back to it. A shared link opens the Join box with its code.
{
  const was = load(WIFI_KEY, true);
  const saved = upgradeGame(load(GAME_KEY));
  const address = new URL(location.href);
  const code = cleanCode(address.searchParams.get('join') ?? '');
  if (address.searchParams.has('join')) {
    address.searchParams.delete('join');
    history.replaceState(null, '', address.href);
  }
  if (was?.role === 'host' && saved?.mode === 'net' && saved.phase !== 'over') resumeHosting(saved);
  else if (was?.role === 'guest' && was.code) openJoin(was.code);
  else if (code) {
    settings.mode = 'net';
    store(SETTINGS_KEY, settings);
    showMenu();
    openJoin(code);
  }
}
