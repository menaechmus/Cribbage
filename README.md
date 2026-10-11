# Cribbage

Two-handed cribbage for the browser. Play against the computer (easy, medium or hard) or pass one device between two players. Works with touch, mouse and keyboard, on phones and desktops.

It is a static page: plain HTML, CSS and JavaScript modules, with no build step and no dependencies.

## Play

- Tap a card to choose it. When discarding, choose two and press **Send to crib**. During the play, tap the chosen card again or press **Play**.
- **Hint** highlights the strongest move and says why. It can be switched off on the menu.
- Keyboard: `1`–`6` choose a card, `Enter` confirms, `H` asks for a hint.
- Scores are counted for you, with a line-by-line breakdown of every hand and crib.

Settings, the game in progress and your statistics are kept in the browser's `localStorage`, so they stay on that device and browser and disappear if its site data is cleared.

## Run locally

Browsers will not load JavaScript modules from `file://`, so serve the folder:

```
python -m http.server 8000
```

Then open <http://localhost:8000/>. The tests run in the browser at <http://localhost:8000/tests.html>.

## Deploy to GitHub Pages

Push to GitHub, then in the repository go to **Settings → Pages**, choose **Deploy from a branch**, and select `main` and `/ (root)`. The game is served at `https://<user>.github.io/<repository>/`.

## Layout

| File | What it holds |
|---|---|
| `index.html`, `css/style.css` | The page and its styles |
| `js/cards.js` | Cards and the deck |
| `js/scoring.js` | Scoring for hands, cribs and the play |
| `js/game.js` | The rules, as a plain game object and the actions that change it |
| `js/ai.js` | The computer opponent and hints |
| `js/stats.js` | Lifetime statistics |
| `js/ui.js` | Drawing, input and storage |
| `tests.html` | Tests for scoring, rules, the opponent and statistics |
