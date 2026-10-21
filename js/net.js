// Connections between phones for a Wi-Fi game. One phone opens a room under
// a four-letter code and the others join it. Each connection is a *link*
// that carries plain objects both ways as JSON. Nothing here knows the game.
//
// The phones find each other through PeerJS (js/vendor/peerjs.min.js, MIT
// licence): its free cloud server passes the connection details between
// them, and the messages then go straight from phone to phone over WebRTC.
// The library is loaded the first time a room is opened or joined. With
// ?net=local in the address, rooms run over a BroadcastChannel instead,
// between the tabs and frames of one browser: the tests and the driver use
// that, and it needs no internet.

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O, too like 1 and 0
export const CODE_LENGTH = 4;
const PREFIX = 'cribbage-menaechmus-'; // keeps our ids apart on the shared server
const PING_MS = 5000; // each side says something at least this often
const LOST_MS = 15000; // and a link that hears nothing for this long is lost
const JOIN_MS = 20000; // a join that has not connected by then fails

const local = new URLSearchParams(location.search).get('net') === 'local';

export const newCode = (random = Math.random) =>
  Array.from({ length: CODE_LENGTH }, () => LETTERS[Math.floor(random() * LETTERS.length)]).join('');

// What someone typed, as a code: capitals only, the right length at most.
export const cleanCode = text => String(text).toUpperCase().replace(/[^A-Z]/g, '').slice(0, CODE_LENGTH);

const parse = text => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// A link over any carrier: `post(text)` sends, `end()` hangs up. The owner
// sets onmessage(message) and onclose(). `receive(text)` is the carrier's
// way in. Both sides ping, so a link that goes quiet is closed rather than
// left hanging; `ping: false` is for the tests' links.
function makeLink(post, end, { ping = true } = {}) {
  let heard = Date.now();
  const link = {
    open: true,
    onmessage: null,
    onclose: null,
    send(message) {
      if (link.open) post(JSON.stringify(message));
    },
    receive(text) {
      heard = Date.now();
      const message = parse(text);
      if (link.open && message && message.t !== 'ping') link.onmessage?.(message);
    },
    close() {
      if (!link.open) return;
      link.open = false;
      clearInterval(timer);
      live.delete(link);
      end();
      link.onclose?.();
    },
  };
  const timer = ping
    ? setInterval(() => {
        if (Date.now() - heard > LOST_MS) link.close();
        else post('{"t":"ping"}');
      }, PING_MS)
    : 0;
  live.add(link);
  return link;
}

// Every link still open, so that leaving the page hangs them all up at once
// and the other phones hear of it straight away.
const live = new Set();
addEventListener('pagehide', () => {
  for (const link of [...live]) link.close();
});

// Two links joined to each other, for the tests. Messages arrive a moment
// after they are sent, as they would over a network.
export function linkPair() {
  let a = null;
  let b = null;
  const later = fn => setTimeout(fn, 0);
  a = makeLink(text => later(() => b.open && b.receive(text)), () => later(() => b.close()), { ping: false });
  b = makeLink(text => later(() => a.open && a.receive(text)), () => later(() => a.close()), { ping: false });
  return [a, b];
}

const failure = message => Object.assign(new Error(message), { friendly: true });
const NO_GAME = "No game has that code. Check the letters on the host's screen.";
const NO_SERVER = 'Could not reach the server that connects phones. Check the internet connection.';
const NO_HOST = "Could not reach the host's phone. Check you are both on the same Wi-Fi, and try again.";

// Opens a room for others to join, under `code` (reopening a saved game) or
// else a new one. onlink(link) hears of each phone that joins. Resolves to
// { code, close() } once phones can find it.
export async function openRoom({ code = null, onlink }) {
  const attempts = code ? 8 : 5;
  for (let attempt = 1; ; attempt++) {
    const tried = code ?? newCode();
    try {
      return await (local ? localRoom : peerRoom)(tried, onlink);
    } catch (error) {
      if (error.taken && attempt < attempts) {
        // A new code: just pick another. A saved one is probably still held
        // by this phone's own page from before the reload: give it a moment.
        if (code) await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      }
      throw error.friendly ? error : failure(error.taken ? "That game's code is still in use. Try again in a minute." : NO_SERVER);
    }
  }
}

// Joins the room with `code`. Resolves to a link once connected, or rejects
// with an error whose message can be shown as it is.
export function joinRoom(code) {
  return (local ? localJoin : peerJoin)(code);
}

// ---- PeerJS ---------------------------------------------------------------

let library = null;

// A classic script, which leaves window.peerjs behind.
function loadPeerJs() {
  library ??= new Promise((resolve, reject) => {
    if (window.peerjs?.Peer) {
      resolve(window.peerjs.Peer);
      return;
    }
    const script = document.createElement('script');
    script.src = new URL('./vendor/peerjs.min.js', import.meta.url).href;
    script.onload = () => (window.peerjs?.Peer ? resolve(window.peerjs.Peer) : reject(failure(NO_SERVER)));
    script.onerror = () => {
      library = null;
      reject(failure('The connection code did not load. Check the internet connection, then reload.'));
    };
    document.head.append(script);
  });
  return library;
}

const peerFailure = error => {
  if (error?.type === 'unavailable-id') return Object.assign(new Error(error.message), { taken: true });
  if (error?.type === 'peer-unavailable') return failure(NO_GAME);
  if (error?.type === 'browser-incompatible') return failure('This browser cannot connect phones. Try another, such as Chrome or Safari.');
  if (error?.type === 'timeout') return failure(NO_HOST);
  return failure(NO_SERVER);
};

// Messages travel as text ("raw"): PeerJS's own JSON channel refuses
// anything over 16 KB.
function wire(conn, onclosed = () => {}) {
  const link = makeLink(
    text => conn.send(text),
    () => {
      conn.close();
      onclosed();
    },
  );
  conn.on('data', text => typeof text === 'string' && link.receive(text));
  conn.on('close', () => link.close());
  conn.on('error', () => link.close());
  return link;
}

async function peerRoom(code, onlink) {
  const Peer = await loadPeerJs();
  const peer = await new Promise((resolve, reject) => {
    const peer = new Peer(PREFIX + code, { debug: 0 });
    const refused = error => {
      peer.destroy();
      reject(peerFailure(error));
    };
    peer.once('error', refused);
    peer.once('open', () => {
      peer.off('error', refused);
      resolve(peer);
    });
  });
  peer.on('connection', conn => {
    if (conn.serialization !== 'raw') {
      conn.close();
      return;
    }
    conn.once('open', () => onlink(wire(conn)));
  });
  // Losing the server leaves the phones already joined connected, but no
  // phone could find the game again: keep trying to get it back.
  let retry = 0;
  const reconnect = () => {
    clearTimeout(retry);
    retry = setTimeout(() => {
      if (peer.destroyed || !peer.disconnected) return;
      peer.reconnect();
      reconnect();
    }, 3000);
  };
  peer.on('disconnected', reconnect);
  peer.on('error', () => {
    if (peer.disconnected) reconnect();
  });
  return {
    code,
    close() {
      clearTimeout(retry);
      peer.destroy();
    },
  };
}

async function peerJoin(code) {
  const Peer = await loadPeerJs();
  return new Promise((resolve, reject) => {
    const peer = new Peer({ debug: 0 });
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      peer.destroy();
      reject(peerFailure(error));
    };
    const timer = setTimeout(() => fail({ type: 'timeout' }), JOIN_MS);
    peer.on('error', fail);
    peer.once('open', () => {
      const conn = peer.connect(PREFIX + code, { reliable: true, serialization: 'raw' });
      conn.once('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        peer.off('error', fail);
        peer.on('error', () => {});
        // The link is direct now; the server is not needed until the next join.
        peer.disconnect();
        resolve(wire(conn, () => peer.destroy()));
      });
    });
  });
}

// ---- BroadcastChannel ------------------------------------------------------

const someId = () => Math.random().toString(36).slice(2, 10);

// Each room is a channel named after its code. A new room first asks whether
// that code is taken; a guest knocks, the host lets it in, and from then on
// each message names who sent it and who it is for.
function localRoom(code, onlink) {
  return new Promise((resolve, reject) => {
    const me = someId();
    const channel = new BroadcastChannel(`cribbage-room-${code}`);
    const links = new Map(); // guest's id -> link
    let listening = false;
    const say = data => channel.postMessage(data);
    channel.onmessage = ({ data }) => {
      if (!listening) {
        if (data.kind === 'taken' && data.to === me) {
          channel.close();
          reject(Object.assign(new Error('taken'), { taken: true }));
        }
        return;
      }
      if (data.kind === 'probe') say({ kind: 'taken', to: data.from });
      else if (data.kind === 'knock') {
        const guest = data.from;
        const link = makeLink(
          text => say({ kind: 'msg', from: me, to: guest, text }),
          () => {
            links.delete(guest);
            say({ kind: 'close', from: me, to: guest });
          },
        );
        links.set(guest, link);
        say({ kind: 'welcome', from: me, to: guest });
        onlink(link);
      } else if (data.to === me) {
        const link = links.get(data.from);
        if (data.kind === 'msg') link?.receive(data.text);
        else if (data.kind === 'close') link?.close();
      }
    };
    say({ kind: 'probe', from: me });
    setTimeout(() => {
      if (listening) return;
      listening = true;
      resolve({
        code,
        close() {
          for (const link of [...links.values()]) link.close();
          channel.close();
        },
      });
    }, 200);
  });
}

function localJoin(code) {
  return new Promise((resolve, reject) => {
    const me = someId();
    const channel = new BroadcastChannel(`cribbage-room-${code}`);
    let host = null;
    let link = null;
    const timer = setTimeout(() => {
      channel.close();
      reject(failure(NO_GAME));
    }, 1500);
    channel.onmessage = ({ data }) => {
      if (data.to !== me) return;
      if (data.kind === 'welcome' && !link) {
        clearTimeout(timer);
        host = data.from;
        link = makeLink(
          text => channel.postMessage({ kind: 'msg', from: me, to: host, text }),
          () => {
            channel.postMessage({ kind: 'close', from: me, to: host });
            channel.close();
          },
        );
        resolve(link);
      } else if (link && data.from === host) {
        if (data.kind === 'msg') link.receive(data.text);
        else if (data.kind === 'close') link.close();
      }
    };
    channel.postMessage({ kind: 'knock', from: me });
  });
}
