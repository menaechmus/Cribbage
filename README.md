# Cribbage

Cribbage for the browser. Play against the computer (easy, medium or hard), pass one device between two, three or four people, or play on your own phones over Wi-Fi. Works with touch, mouse and keyboard, on phones and desktops.

It is a static page: plain HTML, CSS and JavaScript modules, with no build step. Its one library, PeerJS, is kept in `js/vendor/` and loaded only for Wi-Fi games.

## Play

- **People** on the menu is for two, three or four people sharing one device. Each can type a name. A cover asks to pass the device whenever someone else must act, and their cards stay face-down until they show them.
- Three players each get five cards and throw one to the crib, which also gets one card from the deck; the board has a third lane. Four players play as two partnerships, players 1 and 3 against 2 and 4, each pair sharing a score and a lane.
- **Wi-Fi** on the menu lets two to four people play on their own phones (see [Wi-Fi games](#wi-fi-games)). Each types their name. One taps **Host a game**, and a four-letter code appears. The others tap **Join a game** and type it, or open the link that **Share link** sends. The host can also add computer players, and taps **Start** when everyone is in.
- Tap a card to choose it. When discarding, choose two (one with three or four players) and press **Send to crib**. During the play, tap the chosen card again or press **Play**.
- When none of your cards fits under 31, the button becomes **Go** and you press it to pass.
- **Hint** highlights the strongest move and says why. It can be switched off on the menu.
- Each new hand is shuffled and dealt with a short animation, and each hand is counted out one scoring combination at a time. Tap anywhere to skip either.
- A win is celebrated with fireworks, confetti and a brass fanfare before the final scores appear, and a skunk walks by after a skunk win. Tap to skip it.
- Sound effects can be muted with the speaker button, the Sound setting on the menu, or `M`.
- Keyboard: `1`–`6` choose a card, `Enter` confirms, `H` asks for a hint, `M` mutes.
- Scores are counted for you, with a breakdown of every hand and crib.
- **Statistics** keeps your record against each computer level, and games between people by name.
- The **i** button on the menu shows which version is running.

Settings, the game in progress and your statistics are kept in the browser's `localStorage`, so they stay on that device and browser and disappear if its site data is cleared.

## Wi-Fi games

Each person plays on their own phone, and one phone, the host's, keeps the game. It deals, checks every move and keeps the score. The other phones send it their moves, and it sends each of them the game as that player may see it: their own cards, but only how many the others hold, and nothing of the crib or the card still to be cut.

- A browser cannot run a server or find other devices on a network by itself. So, for a few seconds at the start, a free public service, the [PeerJS](https://peerjs.com) cloud server, passes the connection details between the phones. After that the phones are linked directly (WebRTC), and moves go straight across the Wi-Fi. This needs the internet at the start. Everyone has it anyway, because the game itself loads from the web.
- On a Wi-Fi network that keeps devices apart (guest and hotel networks often do), PeerJS's free relay carries the moves instead. If the PeerJS service is down, Wi-Fi games cannot start, but the other modes are not affected.
- Two to four players, as on one device: four play as partnerships in the order they joined, the host and the third against the second and the fourth. The lobby shows who partners whom.
- The host can add computer players in the lobby: **Add the computer** seats one at the level tapped (Easy, Medium or Hard), named after that level, and **×** takes it out again. They play from the host's phone, count towards the four players, and keep playing while the host looks at the menu. Statistics leave them out of "Between people".
- Everyone throws their cards to the crib at once, then the play goes round the table. Any phone can move the show on from one hand to the next.
- The host's game length and Hints apply to everyone in that game. Sound is set on each phone.
- Screens stay on during a Wi-Fi game, because a phone that goes to sleep drops out.
- A phone that drops out (it slept, switched apps, reloaded, or lost the Wi-Fi) reconnects by itself and takes back its seat and its cards. While it is gone, its score is dimmed on the other phones. When it is that player's turn (or they have still to throw), the host's main button can let the computer choose for them, after asking, so the game need not wait.
- If the host's page reloads, it reopens the same game under the same code, and the other phones come back by themselves.
- When it becomes your turn in the play, and with each new deal, your phone chimes, and buzzes if it can.
- At the end each phone records the game in its own **Statistics**, under "Between people". Only the host can start another game.
- A phone running an older copy of the game is asked to reload.
- PeerJS 1.5.5 (MIT licence, see `js/vendor/LICENSE-peerjs.txt`) is the unchanged `peerjs.min.js` from <https://github.com/peers/peerjs>.

## Run locally

Browsers will not load JavaScript modules from `file://`, so serve the folder:

```
python -m http.server 8000
```

Then open <http://localhost:8000/>. The tests run in the browser at <http://localhost:8000/tests.html>.

## Deploy to GitHub Pages

Push to GitHub, then in the repository go to **Settings → Pages**, choose **Deploy from a branch**, and select `main` and `/ (root)`. The game is served at `https://<user>.github.io/<repository>/`.

## Releasing

Before pushing a change, raise `VERSION` and `RELEASED` at the top of `js/ui.js`. The About box shows them, which makes it easy to tell when a browser is still running a cached copy of an earlier release.

## Layout

| File | What it holds |
|---|---|
| `index.html`, `css/style.css` | The page and its styles |
| `js/cards.js` | Cards and the deck |
| `js/scoring.js` | Scoring for hands, cribs and the play |
| `js/game.js` | The rules, as a plain game object and the actions that change it |
| `js/ai.js` | The computer opponent and hints |
| `js/board.js` | Pegboard geometry: where each hole sits along the S-shaped track, in two lanes or three |
| `js/stats.js` | Lifetime statistics |
| `js/sound.js` | Sound effects, generated with the Web Audio API (no audio files) |
| `js/fanfare.js` | The win fanfare: an original tune for a generated brass ensemble with timpani, in a generated hall |
| `js/celebrate.js` | Fireworks and confetti for a win, simulated and drawn on a canvas |
| `js/net.js` | Connections between phones for a Wi-Fi game: a room under a four-letter code, and links that carry messages (through PeerJS, or between the tabs of one browser for testing) |
| `js/wifi.js` | A Wi-Fi game between phones: seats, what each phone may see, and the messages between the host and the others |
| `js/vendor/` | PeerJS, and its licence |
| `js/ui.js` | Drawing, input, animation, Wi-Fi games and storage |
| `tests.html` | Tests for scoring, rules, the opponent, statistics, the board, Wi-Fi games, the celebration and sound |
