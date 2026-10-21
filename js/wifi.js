// A Wi-Fi game between phones, without the page: who sits where, what each
// phone may see, and the messages between the host and the others. The host
// keeps the real game (game.js), and the page runs every move through it;
// this file only checks who sent what, and passes it on. The links come
// from net.js, or from its linkPair() in the tests. The same as WordGame's,
// apart from the moves and what each phone may see.
//
// Messages are objects { t, ... }:
//   guest to host   hello { name, token, version }, discard { cards },
//                   play { card }, go, next { step }, bye
//   host to guest   lobby { seat, players }, state { seat, game, away },
//                   refused { message }, denied { why, version },
//                   closed { why }

export const MAX_PLAYERS = 4;
export const NAME_LENGTH = 12;
export const HIDDEN = -1; // a card this phone may not see

// A name as typed: single spaces, trimmed, no longer than the menu allows.
export const cleanName = text => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_LENGTH);

// "Alex" a second time becomes "Alex 2", so that every score, message and
// statistic names one person.
function uniqueName(name, taken) {
  const used = new Set(taken.map(other => other.toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) {
    const candidate = `${name.slice(0, NAME_LENGTH - String(n).length - 1)} ${n}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

const isCard = card => Number.isInteger(card) && card >= 0 && card < 52;

// A guest's move rebuilt from only what it should hold, or null. The game's
// own checks (game.js) then decide whether it is allowed. `next` carries the
// show step the phone was looking at, so that two phones pressing at once
// move the show on only one step.
export function cleanMove(message) {
  const { t, cards, card, step } = message ?? {};
  if (t === 'discard') return Array.isArray(cards) && cards.length >= 1 && cards.length <= 2 && cards.every(isCard) ? { t, cards: [...cards] } : null;
  if (t === 'play') return isCard(card) ? { t, card } : null;
  if (t === 'go') return { t };
  if (t === 'next') return Number.isInteger(step) && step >= -1 && step <= 4 ? { t, step } : null;
  return null;
}

// What `seat` may see of the game. Every other hand, every other player's
// thrown and kept cards, the crib and the card still to be cut become HIDDEN,
// so how many there are still shows. A hand is seen when it is counted, as
// the show carries its cards. The host's notes on the seats stay with it.
export function seatView(game, seat) {
  const view = JSON.parse(JSON.stringify(game));
  const hide = cards => cards.map(() => HIDDEN);
  for (const key of ['hands', 'kept', 'discards']) view[key] = view[key].map((cards, i) => (i === seat ? cards : hide(cards)));
  view.crib = hide(view.crib);
  view.cut = HIDDEN;
  delete view.net;
  return view;
}

// Whether a state from the host is one this phone has already. It is sent
// again when someone joins, comes back or drops out, so that every phone
// knows who is there.
export const sameState = (game, next) => Boolean(game) && JSON.stringify(game) === JSON.stringify(next);

// Why the host turned this phone away, in words.
export function deniedText({ why, version }, ours) {
  if (why === 'version') return `This phone has version ${ours} of the game and the host's has ${version}. Reload the page on the older one, then join again.`;
  if (why === 'full') return `That game already has ${MAX_PLAYERS} players.`;
  if (why === 'started') return 'That game has already started.';
  return 'Type your name first.';
}

// ---- The host -------------------------------------------------------------

// The host is seat 0, and the others sit in the order they joined. The host
// may also seat computer players, { ai: true, level }, which play from the
// host's phone and so are always there. `seats` are a saved game's, as
// `saved()` gave them, when the game is reopened: its people then count as
// away until they come back.
//
// onmove(seat, move) hears each guest's move (cleaned, see cleanMove); the
// page runs it, then calls share() or refuse(). onchange({ seat, joined })
// hears of anyone joining, coming back or dropping out.
export function createHost({ name, version, seats = null, onmove, onchange = () => {} }) {
  let started = Boolean(seats);
  let ended = false;
  let list = (seats ?? [{ name, token: null }]).map(seat => ({
    name: cleanName(seat.name) || 'Host',
    token: seat.token ?? null,
    link: null,
    ...(seat.ai ? { ai: true, level: seat.level } : {}),
  }));

  const here = i => i === 0 || Boolean(list[i].ai) || Boolean(list[i].link);
  // A person's seat, which a returning phone may take back.
  const theirs = (seat, i) => i > 0 && !seat.ai;
  const seatOf = link => list.findIndex(seat => seat.link === link);

  function sendLobby() {
    const players = host.players();
    list.forEach((seat, i) => seat.link?.send({ t: 'lobby', seat: i, players }));
  }

  // The guest hangs up once it has read why; this is in case it does not.
  function deny(link, why) {
    link.send({ t: 'denied', why, version });
    setTimeout(() => link.close(), 3000);
  }

  // A returning player is known by the token its tab keeps, or else, once
  // the game has started, by its name on a seat whose phone has gone.
  function hello(link, message) {
    const name = cleanName(message.name);
    const token = typeof message.token === 'string' ? message.token.slice(0, 40) : '';
    if (message.version !== version) return deny(link, 'version');
    if (!name || !token) return deny(link, 'name');
    let seat = list.findIndex((other, i) => theirs(other, i) && other.token === token);
    if (seat < 0 && started) seat = list.findIndex((other, i) => theirs(other, i) && !other.link && other.name.toLowerCase() === name.toLowerCase());
    if (seat < 0) {
      if (started) return deny(link, 'started');
      if (list.length >= MAX_PLAYERS) return deny(link, 'full');
      list.push({ name: uniqueName(name, list.map(other => other.name)), token, link: null });
      seat = list.length - 1;
    }
    const old = list[seat].link;
    Object.assign(list[seat], { link, token });
    if (old && old !== link) {
      old.onclose = null;
      old.close();
    }
    link.onmessage = next => heard(link, next);
    if (!started) sendLobby();
    onchange({ seat, joined: true });
  }

  function heard(link, message) {
    const seat = seatOf(link);
    if (seat < 0 || ended) return;
    if (message.t === 'bye') {
      link.close();
      return;
    }
    const move = started ? cleanMove(message) : null;
    if (move) onmove(seat, move);
  }

  // In the lobby a player who drops out loses the seat; in a game it is kept
  // for them.
  function dropped(link) {
    const seat = seatOf(link);
    if (seat < 0) return;
    list[seat].link = null;
    if (!started) {
      list.splice(seat, 1);
      sendLobby();
    }
    onchange({ seat, joined: false });
  }

  const host = {
    get started() {
      return started;
    },
    // A link from net.js. The guest says hello first. Once the game has
    // ended, nobody new is let in.
    attach(link) {
      if (ended) {
        link.close();
        return;
      }
      link.onmessage = message => {
        if (message.t === 'hello' && !ended) hello(link, message);
      };
      link.onclose = () => dropped(link);
    },
    players: () => list.map((seat, i) => ({ name: seat.name, here: here(i), ...(seat.ai ? { ai: true, level: seat.level } : {}) })),
    away: () => list.map((seat, i) => !here(i)),
    // A computer player, in the lobby, named after its level: "Hard", or
    // "Hard 2" for a second one. False when there is no room.
    addComputer(level) {
      if (started || list.length >= MAX_PLAYERS) return false;
      const name = uniqueName(`${level[0].toUpperCase()}${level.slice(1)}`, list.map(seat => seat.name));
      list.push({ name, token: null, link: null, ai: true, level });
      sendLobby();
      onchange({ seat: list.length - 1, joined: true });
      return true;
    },
    // Takes a computer player out of the lobby again.
    removeComputer(seat) {
      if (started || !list[seat]?.ai) return false;
      list.splice(seat, 1);
      sendLobby();
      onchange({ seat, joined: false });
      return true;
    },
    // Back to the lobby, for another game: whoever has gone loses their
    // seat, and new players may join again.
    reopen() {
      list = list.filter((seat, i) => here(i));
      started = false;
      sendLobby();
    },
    // Starts the game with everyone in the lobby, as newGame() takes them.
    begin() {
      list = list.filter((seat, i) => here(i));
      started = true;
      return list.map(({ name, ai, level }) => (ai ? { name, ai, level } : { name }));
    },
    // For the saved game, so that it can be reopened: names and tokens, and
    // the computers' levels.
    saved: () => list.map(({ name, token, ai, level }) => (ai ? { name, token, ai, level } : { name, token })),
    // Each guest's own view of the game, and who is there.
    share(game) {
      const away = host.away();
      list.forEach((seat, i) => seat.link?.send({ t: 'state', seat: i, game: seatView(game, i), away }));
    },
    refuse(seat, message) {
      list[seat]?.link?.send({ t: 'refused', message });
    },
    // Ends the Wi-Fi game for everyone.
    close(why = 'ended') {
      ended = true;
      for (const seat of list) {
        const { link } = seat;
        if (!link) continue;
        seat.link = null;
        link.onclose = null;
        link.send({ t: 'closed', why });
        setTimeout(() => link.close(), 500);
      }
    },
  };
  return host;
}

// ---- A guest ----------------------------------------------------------------

// connect() gives a link to the host: net.js joinRoom, or a test's. join()
// resolves when the host first answers (with the lobby or the game), or
// rejects with an error whose message can be shown. After that a lost link
// is dialled again every `retryMs`, until it is back or the host says no.
//
// onmessage(message) hears lobby, state, refused, denied and closed, and
// onlink(up) hears the link go and come back.
export function createGuest({ name, token, version, connect, onmessage = () => {}, onlink = () => {}, retryMs = 3000 }) {
  let link = null;
  let up = false;
  let stopped = false;
  let retry = 0;
  let waiting = null; // join()'s promise, until the host first answers

  const answered = (error = null) => {
    if (!waiting) return;
    const { resolve, reject } = waiting;
    waiting = null;
    if (error) {
      guest.stop();
      reject(error);
    } else resolve();
  };

  const again = () => {
    clearTimeout(retry);
    if (!stopped) retry = setTimeout(dial, retryMs);
  };

  function hear(message) {
    if (message.t === 'lobby' || message.t === 'state') {
      if (!up) {
        up = true;
        onlink(true);
      }
      answered();
    } else if (message.t === 'denied' || message.t === 'closed') {
      const first = Boolean(waiting);
      answered(new Error(message.t === 'denied' ? deniedText(message, version) : 'The host ended the game.'));
      guest.stop();
      if (first) return;
    }
    onmessage(message);
  }

  async function dial() {
    clearTimeout(retry);
    if (stopped) return;
    let next;
    try {
      next = await connect();
    } catch (error) {
      if (waiting) answered(error);
      else again();
      return;
    }
    if (stopped) {
      next.close();
      return;
    }
    link = next;
    link.onmessage = hear;
    link.onclose = () => {
      if (link !== next) return;
      link = null;
      if (up) {
        up = false;
        onlink(false);
      }
      if (waiting) answered(new Error('Lost touch with the host. Try again.'));
      else again();
    };
    link.send({ t: 'hello', name, token, version });
  }

  const guest = {
    get connected() {
      return up;
    },
    join() {
      return new Promise((resolve, reject) => {
        waiting = { resolve, reject };
        dial();
      });
    },
    // False when there is no link to send it on.
    send(message) {
      if (!up || !link) return false;
      link.send(message);
      return true;
    },
    // No more dialling, and the link hung up.
    stop() {
      stopped = true;
      clearTimeout(retry);
      const old = link;
      link = null;
      up = false;
      if (old) {
        old.onclose = null;
        old.close();
      }
    },
    leave() {
      link?.send({ t: 'bye' });
      guest.stop();
    },
  };
  return guest;
}
