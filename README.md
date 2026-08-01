# Cribbage

A complete two-player cribbage game (you vs. the computer) that runs entirely in the browser.
No build step, no dependencies, no server.

**[▶ Play it](https://magitekzed.github.io/Cribbage/)**

## Features

- Full standard rules — 6 cards dealt, 2 to the crib, cut for the starter, pegging, and the
  show counted in the proper order (non-dealer → dealer → crib). First to 121 wins.
- Complete scoring, including the rules that are easy to get wrong: his heels, his nobs,
  double pair royal, the go point, exactly-31 superseding the go, and the crib flush that only
  counts at five cards.
- The game ends the instant a player reaches the target score — even mid-count.
- Three difficulty levels, from a beatable casual opponent to one that evaluates every possible
  discard against every possible cut.
- Classic wooden serpentine board with two leapfrogging pegs per player, drawn entirely in SVG
  and CSS. No image files anywhere.
- Statistics kept locally: best hand, best crib, biggest win margin, win/loss record, streaks,
  and skunks.

## Running it

Open `index.html` in any modern browser. That's it.

## Tests

```bash
node tools/run-tests.js
```

Or open `tests.html` in a browser for the same suite plus the exhaustive verification pass
over all 2,598,960 possible five-card hands.

## Design

See [DESIGN.md](DESIGN.md) for the full design plan and specification.
