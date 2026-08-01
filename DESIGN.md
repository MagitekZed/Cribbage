# Cribbage — Design Plan

**Status:** Draft for review · **Target:** Two-player (You vs. Computer) cribbage, 121 points

---

# Part 1 — The Plain English Overview

## What we're building

A complete, polished game of cribbage that runs entirely in a web browser. You open a file,
you get a wooden cribbage board and a hand of cards, and you play a full game against a
computer opponent that actually knows what it's doing. No install, no accounts, no internet
required after you have the files.

It plays *real* cribbage — six cards each, discard two to the crib, cut the starter, peg out
the play, count the hands in the proper order, first to 121 wins. Every scoring rule is
implemented, including the fussy ones people forget: his heels, his nobs, the crib flush that
only counts at five cards, double pair royal during the play, the go point, and the fact that
the game ends the *instant* someone hits 121 even if it's in the middle of counting a hand.

## What it looks like

Warm and familiar — like the board that lives in a drawer at a pub. A wood-grain serpentine
board runs down one side with drilled holes in groups of five and two brass pegs per player
that leapfrog each other, so at a glance you can see both your score and what your last score
was. The table is green felt. The cards are classic red-and-blue-backed with clean, readable
pips.

Everything is drawn with CSS and SVG — no image files at all. That keeps it one tidy,
shareable bundle and means the cards stay razor sharp at any size.

## What it feels like to play

Cards deal out in a quick staggered arc from the deck. You click two cards to send to the
crib; they slide over and stack face-down. The starter card lifts off the deck and flips over
with a little 3D turn. During the play, cards slide into a row in the middle with the running
count ticking up beside them.

When anyone scores, three things happen together: the cards responsible for the points **light
up**, a small label floats up saying what it was (`FIFTEEN TWO`, `RUN OF FOUR`, `PAIR ROYAL`),
and the **peg walks up the board** hole by hole. Counting a hand isn't a number appearing —
it's a short sequence where each combination gets its moment. That's the part that makes a
digital cribbage game feel good instead of feeling like a spreadsheet, and it's also how you
learn to count faster.

## The opponent

Three difficulty levels, and the difference between them is real, not cosmetic:

- **Easy** — plays sensibly but makes the mistakes a casual player makes. Beatable.
- **Normal** — discards using an actual expected-value calculation over every possible cut,
  and pegs with solid tactical rules. A genuinely decent club player.
- **Hard** — full expected-value analysis of all fifteen possible discards including what the
  crib is likely to become, and looks a move ahead during the play. Will punish you.

## What gets remembered

The game keeps a small record on your machine (local storage — never leaves your computer):

- **Best hand ever** — the score and the actual five cards, so you can gloat
- **Best crib**
- **Biggest blowout** — the most you've ever beaten the computer by
- **Win/loss record**, per difficulty, plus current and longest win streak
- **Skunks given and taken**
- An **in-progress game**, so closing the tab doesn't lose your position

## Deliberate design choices worth flagging

- **No muggins.** Hands are counted for you, correctly, every time. Muggins (stealing points
  your opponent failed to claim) punishes you for the computer's arithmetic, not your skill.
  Listed as an optional mode in the stretch section if you want it.
- **Counting is a sequence, not a total.** Slower by a second or two per hand, but it's the
  single biggest contributor to the game feeling like cribbage.
- **The game ends mid-count if someone pegs out.** This is a real rule that a lot of digital
  cribbage games get wrong, and it's why the counting order (non-dealer, dealer, crib) matters.

## How it gets built

Seven phases. The rules engine gets built and proven correct *first*, against a test suite
plus an exhaustive check over all 2.6 million possible hands, before a single card is drawn on
screen. Everything after that is UI on top of an engine we already trust.

---

# Part 2 — The Detailed Design Spec

## 2.1 Technology & file layout

Plain HTML/CSS/JavaScript. **No build step, no dependencies, no bundler.** Scripts are loaded
as classic `<script>` tags (not ES modules) specifically so the game works when opened directly
from the filesystem via `file://` — double-click `index.html` and it runs.

```
Cribbage/
├── index.html          # markup shell, SVG symbol defs (suits, board)
├── css/
│   ├── theme.css       # design tokens: colors, wood/felt gradients, spacing, timing
│   ├── cards.css       # card faces, backs, pip layout grid, 3D flip
│   ├── board.css       # board, holes, pegs, peg travel animation
│   └── layout.css      # page layout, panels, responsive breakpoints
├── js/
│   ├── cards.js        # card model, deck, shuffle
│   ├── scoring.js      # ★ pure scoring engine — zero DOM, zero state
│   ├── engine.js       # game state machine, rules of flow, event emission
│   ├── ai.js           # discard evaluation + pegging strategy, 3 tiers
│   ├── render.js       # DOM construction, card/board drawing
│   ├── animate.js      # animation queue & primitives
│   ├── storage.js      # localStorage: stats, settings, game resume
│   └── main.js         # wiring, input handling, boot
├── tests.html          # standalone test runner page
├── js/tests.js         # assertions + exhaustive verification
└── DESIGN.md
```

Everything can be concatenated into a single `index.html` at the end if you want one file to
share. Splitting during development just keeps it navigable.

**Deployment:** works as-is from `file://`, and drops onto GitHub Pages with zero changes.

---

## 2.2 Core data model

```js
// A card is an integer 0–51 plus derived properties.
// rank: 1..13  (1=A, 11=J, 12=Q, 13=K)   — used for pairs, runs, nobs
// suit: 0..3   (0=♠ 1=♥ 2=♦ 3=♣)
// value: min(rank, 10)                    — used for fifteens and the play count
Card = { id, rank, suit, value }
```

Two distinct notions of "rank" that must never be conflated:

| Concept | Used for | A | 10 | J | Q | K |
|---|---|---|---|---|---|---|
| `value` | fifteens, the running count | 1 | 10 | 10 | 10 | 10 |
| `rank`  | pairs, runs, nobs | 1 | 10 | 11 | 12 | 13 |

Runs use `rank` and **do not wrap** — Q‑K‑A is not a run.

### Game state

```js
state = {
  phase,                    // see state machine below
  dealer: 0 | 1,            // 0 = human, 1 = computer
  scores: [0, 0],
  pegs: [[-1,-1], [-1,-1]], // [rearHole, frontHole] per player; -1 = start
  deck: [],                 // remaining undealt cards
  hands: [[], []],          // current 4-card hands (6 during discard)
  crib: [],
  starter: null,
  play: {
    count: 0,               // running total, 0..31
    series: [],             // cards in the current sub-31 series, in play order
    pile: [],               // all cards played this hand, with owner
    lastPlayer: null,       // who played the most recent card
    goSaid: [false, false], // who has declared "go" in this series
    turn: 0                 // whose turn to play
  },
  settings: { difficulty, targetScore, fourColorDeck, animSpeed, sound, hints },
  stats: { ... }            // mirrored to localStorage
}
```

---

## 2.3 The scoring engine (`scoring.js`)

This is the heart of the correctness requirement. It is **pure**: it takes cards, returns
numbers and explanations. No DOM, no game state, no randomness. That's what makes it testable.

### API

```js
scoreHand(fourCards, starter, isCrib) → {
  total: Number,
  breakdown: [ { type, points, cards: [Card], label } ]
}

scorePlay(series, playedCard) → {
  points: Number,
  breakdown: [ { type, points, cards, label } ]
}

scoreHeels(starterCard) → 2 | 0
```

`breakdown` is what drives the counting animation and the on-screen explanation. Every point
scored anywhere in the game is attributable to a labeled combination and a set of cards.

### Show scoring — the five categories

**1. Fifteens — 2 points each.**
Enumerate all 2⁵ = 32 subsets of the five cards; every subset whose `value` sum is exactly 15
scores 2. Subsets of size 2 through 5 all count. A hand can contain up to eight fifteens.

**2. Pairs — 2 points each.**
Every unordered pair of equal-`rank` cards. Naturally yields the traditional values, no special
cases needed:

| Same-rank cards | Pairs formed | Points |
|---|---|---|
| 2 (pair) | 1 | 2 |
| 3 (pair royal) | 3 | 6 |
| 4 (double pair royal) | 6 | 12 |

**3. Runs — 1 point per card, multiplied by duplicates.**
Algorithm: build a rank→count map. Walk the distinct sorted ranks and split them into maximal
consecutive blocks. For each block of length L ≥ 3, score `L × (product of the counts of each
rank in the block)`. Blocks shorter than 3 score nothing, and a run of 4 does **not** also
score its contained runs of 3.

| Hand | Blocks | Score |
|---|---|---|
| 3‑4‑5‑9‑K | [3,4,5] | 3 |
| A‑2‑3‑4‑5 | [A..5] len 5 | 5 |
| 4‑5‑5‑6‑K | [4,5,6] ×2 | 6 |
| 4‑4‑5‑5‑6 | [4,5,6] ×2×2 | 12 |
| 2‑3‑4‑4‑5 | [2,3,4,5] ×2 | 8 |
| 3‑4‑5‑J‑Q | [3,4,5] only | 3 |

**4. Flush.**
- **Hand:** all four hand cards same suit → **4**; if the starter matches too → **5**.
- **Crib:** only a five-card flush counts. All four crib cards *and* the starter → **5**.
  A four-card crib flush scores **0**. This is the rule most often implemented wrong.

**5. Nobs — 1 point.**
A Jack in the hand (or crib) whose suit matches the starter's suit. One point, at most once.
Distinct from heels.

**Heels (his heels) — 2 points.** If the starter is a Jack, the **dealer** scores 2 the moment
it's turned. Scored at cut time, not during the show, and it can win the game outright.

**Impossible scores:** 19, 25, 26, 27. A hand scoring 0 is displayed as "a nineteen hand" — a
small nod that cribbage players will appreciate. These impossibilities double as test
assertions.

**Maximum hand:** 29 — J‑5‑5‑5 with the fifth 5 as the starter matching the Jack's suit.
(Sixteen for the fifteens, twelve for the double pair royal, one for nobs.)

### Play (pegging) scoring

Evaluated against the current *series* — the cards played since the count last reset — after
each card:

| Event | Points | Detection |
|---|---|---|
| Count = 15 | 2 | running total |
| Count = 31 | 2 | running total |
| Pair / royal / double royal | 2 / 6 / 12 | trailing cards of equal rank, `n×(n−1)` |
| Run of N (N ≥ 3) | N | see below |
| Go / last card | 1 | nobody can play, count < 31 |

**Run detection during play** is order-independent within the trailing window. For L from
`series.length` down to 3: take the last L cards; if their ranks are all distinct and
`max − min === L − 1`, that's a run of L — score L and stop. Only the longest counts.

- `5, 4, 6` → run of 3
- `5, 4, 7, 6` → run of 4 (ranks 4‑5‑6‑7)
- `3, 5, 4, 7, 6` → run of 5
- `5, 4, 5, 6` → last four contain a duplicate; last three (4‑5‑6) → run of 3
- `3, 3, 4, 5` → the pair scored 2 on the second 3; then 3‑4‑5 → run of 3

**Go and the 31 interaction.** When a player cannot play without exceeding 31, they say "go."
The opponent then plays every card they legally can. Then:

- If the count reached **exactly 31** → that player scores **2**, and *not* an additional go
  point. 31 supersedes the go.
- Otherwise → the last player to have played a card scores **1** for last card.

The count then resets to 0, the series is cleared, and **the player who did not play the last
card leads the new series.** If they have no cards left, the other player continues alone.

The final card of the entire play scores its go/last-card point the same way. Play continues
until all eight cards are gone.

### Central scoring gate

Every point in the game — pegging, heels, show, crib — flows through one function:

```js
award(player, points, reason, cards) {
  // 1. update score & peg positions (front peg leapfrogs from old front + points)
  // 2. enqueue animation: highlight cards, float label, walk peg
  // 3. if scores[player] >= targetScore → transition to GAME_OVER immediately
}
```

Because the win check lives here, "the game ends the instant someone reaches 121" is
structurally guaranteed rather than remembered case by case. A hand's count that crosses 121
on its third combination stops there; the remaining combinations are never awarded.

---

## 2.4 Game flow & state machine

```
        NEW_GAME
           ↓
      CUT_FOR_DEAL ──── low card deals first; re-cut on tie
           ↓
   ┌──→  DEAL           6 cards each, alternating, animated
   │       ↓
   │   DISCARD          both players send 2 to the dealer's crib
   │       ↓
   │  CUT_STARTER       → heels: dealer +2 (can win here)
   │       ↓
   │     PLAY  ⇄ { AWAIT_HUMAN · AI_THINKING · SCORE_PLAY · GO · RESET_SERIES }
   │       ↓
   │   SHOW_PONE        non-dealer counts first  ← order matters
   │       ↓
   │   SHOW_DEALER
   │       ↓
   │   SHOW_CRIB        dealer's crib, crib flush rules apply
   │       ↓
   │    HAND_END        rotate dealer, collect cards, reshuffle
   └───────┘
           ↓
       GAME_OVER  (reachable from any scoring point above)
```

**Counting order is load-bearing.** Non-dealer counts first specifically so that a non-dealer
sitting at 115 can win before the dealer ever counts a 24-hand. The state machine enforces it.

**Turn/legality rules enforced during PLAY:**
- A player must play if they have any card with `value ≤ 31 − count`.
- Saying "go" is automatic, not a button — if you have no legal card, the game announces it.
- Having no cards left is treated the same as having no legal card.

**End of game:**
- Win at `targetScore` (121 default, 61 selectable).
- **Skunk** — loser has ≤ 90. **Double skunk** — loser has ≤ 60. Both recorded in stats and
  called out on the game-over screen.

---

## 2.5 The computer opponent (`ai.js`)

### Discard (choosing 2 of 6)

There are exactly C(6,2) = 15 candidate discards. For each, we compute:

```
EV(discard) = E[hand score over all 46 possible starters]
            ± E[crib score]        (+ if it's our crib, − if it's theirs)
```

**Hand EV** is exact and cheap: 15 candidates × 46 possible starters = 690 hand evaluations.
Instant.

**Crib EV** is the expensive half, because the crib also contains two unknown cards from the
opponent. Approach per tier:

| Tier | Hand EV | Crib EV | Pegging | Feel |
|---|---|---|---|---|
| **Easy** | exact, but a random one of the top 5 discards is chosen | ignored | scores when it can; otherwise random legal | Makes real mistakes. Winnable. |
| **Normal** | exact | heuristic table (5s and adjacent pairs are good in your own crib, poison in theirs) | full tactical ruleset, no lookahead | Solid club player. |
| **Hard** | exact | Monte Carlo: ~400 sampled (opponent-discard, starter) combinations per candidate | tactical rules + 1-ply expectimax over unseen cards | Sharp. Punishes loose discards. |

Hard's Monte Carlo is ~6,000 hand evaluations, comfortably under 100 ms. If profiling says
otherwise, we swap in a precomputed 91-entry crib-value table (one per rank pair, suited and
unsuited) baked in as a constant — same accuracy, zero runtime cost.

The AI always gets a short artificial "thinking" delay (~500–700 ms) regardless of actual
compute time, so its pace feels human and readable rather than instantaneous.

### Pegging

**Leading a new series:**
- Prefer 4 or lower — safe from a 15 reply.
- Never lead a 5 (a ten-card reply makes 15 far too often).
- Avoid leading from a pair you hold (invites a pair, and you can't always answer royal).

**Responding:**
1. Enumerate legal plays and their immediate score.
2. Take a play that reaches exactly 31 whenever available.
3. Otherwise prefer the highest immediate score…
4. …but subtract the danger of the resulting count. **Avoid leaving the count at 5 or 21** —
   ten-cards are 16 of 52, so a huge share of opponent holdings make 15 or 31 off those.
   Leaving 26–30 with a live low card in their hand is similarly bad.
5. Tie-break toward keeping flexible cards (low cards and cards that extend runs) for later
   series.

**Hard adds** a one-ply search: for each candidate play, enumerate the opponent's plausible
responses weighted uniformly over all cards not yet seen (their hand is unknown, but the deck,
our hand, the crib we contributed to, the starter, and everything already played are known),
and pick the play maximizing `ourPoints − E[theirBestReply]`.

**Card-counting honesty:** the AI reasons only from information a human player also has. It
never looks at the human's hand or the undealt deck order.

---

## 2.6 Visual design

### Design tokens (`theme.css`)

| Token | Value | Use |
|---|---|---|
| `--felt` | `#1f5136` → `#173d29` radial | table surface |
| `--wood-light` / `--wood-dark` | `#c08a4e` / `#6b4423` | board grain gradient |
| `--brass` | `#c9a227` | pegs, accents, score highlights |
| `--card-face` | `#fdfbf5` | warm off-white, not pure white |
| `--suit-red` / `--suit-black` | `#c1272d` / `#1b1b1b` | pips |
| `--ink` | `#2b2119` | text on light |
| `--glow` | `rgba(255,214,102,.85)` | scoring highlight |

Type: a serif for the score numerals and card corner indices (feels traditional), a clean sans
for UI chrome. System font stacks only — no web font downloads, keeps the bundle self-contained.

### The cards

Drawn entirely in HTML/CSS with inline SVG suit symbols. Each card is a `<div class="card">`
with a front and back face and `transform-style: preserve-3d` for flipping.

- **Pips:** a 4×3 CSS grid with a fixed classical layout per rank (the standard playing-card
  arrangement — the 7's offset pip, the 10's split column, and so on). Lower pips are rotated
  180° as on real cards.
- **Court cards:** a large centered rank letter in the serif face with a suit emblem and a
  simple symmetric border ornament. Not attempting illustrated court cards — a clean
  typographic treatment looks intentional and stays sharp at every size.
- **Backs:** a woven cross-hatch pattern via layered `repeating-linear-gradient`, classic red
  (yours) and blue (opponent's).
- **Four-color deck** is a settings toggle (♠ black, ♥ red, ♦ blue, ♣ green) for clarity.

Cards are absolutely positioned and moved with `transform: translate3d()` — the layout never
reflows during animation, which keeps everything at 60fps.

### The board

An inline SVG, generated programmatically from a path so hole spacing is exact.

- **Serpentine track:** three straightaways joined by two rounded 180° turns, matching the
  familiar 121-hole board shape.
- **Holes:** 121 per player (plus a start hole), grouped visually in **fives** with slightly
  wider gaps between groups — this is how you read a real board at a glance, and it makes
  "I'm two holes from the corner" meaningful.
- **Two pegs per player, leapfrogging.** The rear peg jumps ahead of the front peg to the new
  total. The gap between your pegs *is* your last score, exactly like the real thing. This is
  a small detail that does a disproportionate amount of work for authenticity.
- **Peg travel** is animated hole-to-hole with a slight arc (lift, travel, drop) and a soft
  click. For large scores the peg visibly walks, so a 24-hand *feels* like 24.
- Skunk line marked at 91, double-skunk line at 61.
- Wood grain is layered CSS gradients with a subtle noise overlay via an inline SVG
  `feTurbulence` filter — no image files.

### Layout (desktop, ≥1024px)

```
┌──────────────────────────────────────────────────────┬─────────┐
│  ● Computer   [🂠][🂠][🂠][🂠]              score 47   │         │
│                                                      │  BOARD  │
│              ┌─ deck ─┐  ┌ starter ┐   crib 🂠🂠      │         │
│              │  🂠🂠   │  │   9♥    │                 │ (tall   │
│              └────────┘  └─────────┘                 │  serpen-│
│                                                      │  tine   │
│      play:  5♣  7♦  3♠           count: 15           │  track) │
│                                                      │         │
│  ── status: "Your turn — play a card" ──             │  47–52  │
│                                                      │         │
│  ● You        [5♥][8♠][J♦][Q♣]           score 52    │         │
└──────────────────────────────────────────────────────┴─────────┘
```

- Board is a fixed-width right rail, always visible — you never lose sight of the score.
- Play row builds left to right in the center; completed series fade back and stack.
- A persistent status line states exactly what's expected of you right now.
- A collapsible side panel shows the running score breakdown for the current hand.

### Responsive (desktop-first, mobile-usable)

- **< 1024px:** board rotates to a horizontal track across the top, hands stay top/bottom.
- **< 640px:** cards scale down, hand fans with slight overlap and lifts the selected card;
  hit targets stay ≥ 44px; the score-breakdown panel becomes a bottom sheet.
- Touch: tap to select, tap again to confirm (no drag required, no hover dependency).

---

## 2.7 Animation system (`animate.js`)

A **serial queue**. Game logic emits events; the queue plays them in order; input is locked
while it drains. This guarantees the visuals can never desync from state and that a six-part
hand count reads as six distinct beats.

```js
anim.queue([
  { type: 'highlight', cards: [c1,c2],  label: 'Fifteen two',  hold: 400 },
  { type: 'peg',       player: 0, from: 47, to: 49 },
  { type: 'highlight', cards: [c3,c4],  label: 'Fifteen four', hold: 400 },
  { type: 'peg',       player: 0, from: 49, to: 51 },
  ...
])
```

| Animation | Technique | Duration |
|---|---|---|
| Deal | staggered `translate3d` + slight rotation, 60ms apart | 400ms total |
| Flip | `rotateY(180deg)`, `backface-visibility: hidden` | 300ms |
| Discard to crib | slide + scale down + fade to face-down stack | 350ms |
| Cut starter | lift off deck, flip, settle | 500ms |
| Play a card | slide from hand to play row | 250ms |
| Score highlight | box-shadow glow pulse on contributing cards | 400ms hold |
| Score label | float up + fade | 700ms |
| Peg walk | per-hole hop, ~35ms/hole, capped so a 29-hand ≈ 1s | variable |
| Win | peg slams home, brass shimmer sweep, confetti burst | 1.2s |

**Speed control:** `instant / fast / normal` in settings, implemented as a single CSS
`--anim-scale` multiplier so one knob changes everything consistently.

**`prefers-reduced-motion`** collapses all movement to simple cross-fades automatically.

**Sound (optional, off by default):** generated with the Web Audio API — no audio files. Soft
peg click, card whoosh, a chime on scoring. Keeps the bundle self-contained.

---

## 2.8 UX details

**Discard phase.** Click a card to raise it; click again to lower. A "Discard to crib" button
enables at exactly two selections, and the crib area is labeled **"your crib"** / **"their
crib"** in unmistakable language — knowing whose crib it is changes the correct discard, and
it's the single most common source of confusion for newer players.

**During the play.** Illegal cards (would exceed 31) dim and become unclickable, with a tooltip
explaining why. The running count is large and adjacent to the play row. If you have no legal
card, the game announces "Go" for you and continues — no dead-end clicking.

**Counting.** Each combination highlights its cards and names itself. A `Skip` button (and the
spacebar) fast-forwards the whole count for players who don't need the ceremony. Setting to
auto-skip permanently.

**Hand history.** A scrollable log of every scoring event this game: `Hand 4 — You (crib): 12
— two runs of three, two fifteens, a pair`.

**Accessibility.**
- Full keyboard control: `←/→` move card selection, `Space/Enter` play or select, `Esc`
  deselect, `S` skip animation.
- ARIA live region announces phase changes, scores, and the count. The game is playable by ear.
- Visible focus rings; all interactive elements are real buttons.
- Suits distinguished by shape as well as color; four-color deck available.
- Contrast targets WCAG AA against the felt and wood backgrounds.

**Settings panel:** difficulty · target score (121/61) · animation speed · four-color deck ·
sound · auto-skip counting · reset statistics.

---

## 2.9 Persistence (`storage.js`)

Namespaced under a single key, `cribbage.v1`, with a version field so the schema can migrate
cleanly later.

```js
{
  version: 1,
  settings: { difficulty, targetScore, fourColorDeck, animSpeed, sound, hints, autoSkip },
  stats: {
    gamesPlayed, wins, losses,
    byDifficulty: { easy: {w,l}, normal: {w,l}, hard: {w,l} },
    currentStreak, longestStreak,
    skunksGiven, skunksTaken, doubleSkunksGiven, doubleSkunksTaken,
    bestHand:   { score, cards: [...], starter, date },
    bestCrib:   { score, cards: [...], starter, date },
    biggestWinMargin:  { margin, finalScores, difficulty, date },
    biggestLossMargin: { margin, finalScores, difficulty, date },
    highestPegCount,          // most points from a single played card
    totalPointsPegged, totalHandsCounted   // → lifetime average hand
  },
  savedGame: { ...full state snapshot, or null }
}
```

**Resume:** the full state is snapshotted at each phase boundary. Reopening mid-game offers
"Resume game" or "New game." The snapshot is deliberately taken at phase boundaries only, never
mid-animation, so a resumed game is always in a clean, consistent state.

All writes are wrapped in try/catch — private-browsing or a full quota degrades to a
memory-only session rather than breaking the game.

---

## 2.10 Testing & correctness

This is where the "scoring properly in all permutations" requirement gets satisfied concretely.
`tests.html` is a standalone page that loads the engine and runs everything.

**1. Unit assertions (~150 hand-written cases)** covering:
- The 29 hand; the 28; the 24-hand family
- Every run multiplicity shape: `4‑5‑5‑6`, `4‑4‑5‑5‑6`, `2‑3‑4‑4‑5`, `A‑2‑3‑4‑5`
- Four-card hand flush = 4, five-card = 5, **crib four-card flush = 0**, crib five-card = 5
- Nobs present / nobs suit-mismatch / Jack-as-starter (heels, and nobs not double-counted)
- Zero-point hands
- All 8-fifteen hands
- Runs that must not wrap: `Q‑K‑A`, `K‑A‑2`

**2. Pegging sequence tests** — scripted card-by-card sequences asserting the score after each
card:
- `5,4,6` → run 3 · `5,4,7,6` → run 4 · `3,5,4,7,6` → run 5
- `5,5,5,5` → 2, then 6, then 12
- `5,4,5,6` → run 3 only, not 4
- Go handling: opponent stuck, you play out, correct 1-point award
- Exactly 31 → 2 points, **no** additional go point
- Series reset and correct lead after a go
- One player exhausts their hand; the other plays alone to the end

**3. Exhaustive engine verification.** A button that enumerates **all C(52,5) = 2,598,960
five-card combinations**, scores each as both a hand and a crib, and asserts:
- No score is ever 19, 25, 26, or 27
- Maximum is exactly 29, and exactly four hands achieve it (one per Jack suit)
- The full frequency distribution matches the published cribbage hand-score distribution
- Crib scoring differs from hand scoring **only** on four-card flushes

This runs in a few seconds in a browser and is a near-proof of engine correctness rather than a
spot check.

**4. Game-flow tests** — headless full games, AI vs. AI, run 1,000 times, asserting: scores are
monotonically non-decreasing, no score exceeds the target after game end, exactly one winner,
all 8 cards get played every hand, the crib always ends with exactly 4 cards, the dealer
alternates correctly, and no state ever contains a duplicated card.

**5. Manual QA checklist** — animation interruption, rapid clicking, resize mid-hand, browser
back/refresh mid-game, localStorage disabled, reduced-motion on, keyboard-only playthrough.

---

## 2.11 Build phases

| # | Phase | Deliverable | Notes |
|---|---|---|---|
| 0 | Scaffolding | File tree, theme tokens, empty modules | — |
| 1 | **Rules engine** | `cards.js`, `scoring.js`, `tests.js` — all tests green including exhaustive verification | **Gate: nothing proceeds until this is provably correct** |
| 2 | Game loop | `engine.js` state machine, playable end-to-end with unstyled DOM | Ugly but complete and correct |
| 3 | Visual design | Cards, board, layout, felt/wood theme | The game starts looking like the mockup |
| 4 | Animation | Queue + all card and peg motion, the counting sequence | The game starts *feeling* good |
| 5 | AI tiers | Easy/Normal/Hard discard + pegging, AI-vs-AI validation | Tuned by playtesting win rates |
| 6 | Persistence & polish | Stats, settings, resume, hints, history log, accessibility | — |
| 7 | QA & docs | Full checklist, README, responsive pass, optional single-file bundle | — |

Phases 1 and 2 are where the difficulty actually lives. Phases 3–4 are the ones you'll want to
iterate on visually.

---

## 2.12 Explicitly out of scope (candidates for later)

- Muggins mode (claim your opponent's missed points; requires manual counting UI)
- Three/four-player and partners cribbage
- Online multiplayer
- Cut-throat variants, five-card cribbage, Auction cribbage
- Illustrated court cards
- Achievements / unlockable board skins
- Full undo (the animation queue plus phase snapshots would support it, but the interaction
  design for "un-peg a score" is genuinely fiddly)

---

## 2.13 Resolved decisions

| Question | Decision |
|---|---|
| Board orientation | **Vertical right rail.** Opponent on top, player on the bottom, play area between them on the left. |
| Hint system | **Cut.** Not built. |
| Muggins | **Cut.** Scoring is automatic and awarded to the player on their own actions. |
| Sound | **Conditional.** Prototype in phase 6 with Web Audio; ship only if it sounds genuinely good. Cut if it lands as beeps and boops. |
| Repo | Public, `MagitekZed/Cribbage`, GitHub Pages served from `main`. |
| File layout | Multi-file as specced — no single-file bundle. |

Still open, low stakes, defaulting as noted unless you say otherwise:

1. **Cut for deal** — currently included as an opening ceremony. Alternative: just alternate the
   starting dealer between games.
2. **Skunk stakes** — currently display-plus-stats only. Alternative: count skunks as double
   games and double-skunks as quadruple in the lifetime record.
3. **Default difficulty** — currently Normal on first launch, no first-run prompt.
