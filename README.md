# Cribbage

Two-handed cribbage for the browser. Play against the computer (easy, medium or hard) or pass one device between two players. Works with touch, mouse and keyboard, on phones and desktops.

It is a static page: plain HTML, CSS and JavaScript modules, with no build step and no dependencies.

## Play

- Tap a card to choose it. When discarding, choose two and press **Send to crib**. During the play, tap the chosen card again or press **Play**.
- When none of your cards fits under 31, the button becomes **Go** and you press it to pass.
- **Hint** highlights the strongest move and says why. It can be switched off on the menu.
- Each new hand is shuffled and dealt with a short animation, and each hand is counted out one scoring combination at a time. Tap anywhere to skip either.
- Sound effects can be muted with the speaker button, the Sound setting on the menu, or `M`.
- Keyboard: `1`–`6` choose a card, `Enter` confirms, `H` asks for a hint, `M` mutes.
- Scores are counted for you, with a breakdown of every hand and crib.
- The **i** button on the menu shows which version is running.

Settings, the game in progress and your statistics are kept in the browser's `localStorage`, so they stay on that device and browser and disappear if its site data is cleared.

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
| `js/board.js` | Pegboard geometry: where each hole sits along the S-shaped track |
| `js/stats.js` | Lifetime statistics |
| `js/sound.js` | Sound effects, generated with the Web Audio API (no audio files) |
| `js/ui.js` | Drawing, input, animation and storage |
| `tests.html` | Tests for scoring, rules, the opponent, statistics and sound |
