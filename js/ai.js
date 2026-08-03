(function (root) {
  'use strict';

  // ai.js is the opponent.
  //
  // THE RULE THAT SHAPES THIS WHOLE FILE: it must not cheat. It may use only what a
  // human sitting in its seat can see — its own cards, the cards it put in the crib,
  // the starter, everything played so far, the count, the scores and who deals.
  //
  // That is enforced structurally rather than remembered. Exactly ONE function,
  // narrowView(), ever touches an engine snapshot, and it copies out a fixed short
  // list of fields. Every strategy function below takes that view and is never
  // handed the state at all, so there is no code path from "choose a card" to
  // state.hands[opponent], state.showHands, state.crib or state.deck. Deleting the
  // view and passing the snapshot through would be a visible, reviewable change
  // rather than a quiet one.
  //
  // The file is otherwise pure: no DOM, no timers, and no Math.random anywhere —
  // every random draw comes from the injected rng, so a tournament or a test replays
  // exactly from its seed.

  var Cards = root.Cribbage && root.Cribbage.Cards;
  var Scoring = root.Cribbage && root.Cribbage.Scoring;

  var LEVELS = ['easy', 'normal', 'hard'];
  var DECK_SIZE = 52;
  var MAX_COUNT = 31;
  var KEEP_SIZE = 4;
  var DEAL_SIZE = 6;

  // Monte Carlo sample count for the hard tier's crib EV. 2000 samples across 15
  // candidates is 30000 five-card cribs, which fastScore below counts in 3.1ms —
  // median, worst 3.5ms warm, 6.2ms on the very first call before the JIT has seen
  // it. The budget is 150ms a lay-away, so this leaves a factor of twenty in hand
  // for a phone.
  //
  // Honesty about what the count buys: measured against copies of this tier that
  // differ in nothing else, over 3000 mirrored games each, 2000 samples beat 500 by
  // 0.2% +/- 0.9 and 250 by 0.5% +/- 0.9 — which is to say, not at all. The common
  // random numbers in drawTriples are doing the work, not the sample count. 2000 is
  // kept because at 3ms it is free and it takes sampling out of the argument
  // entirely, not because 250 was measurably worse.
  var CRIB_SAMPLES = 2000;

  // One canonical card per id. The engine hands out its own frozen cards and the AI
  // hands them straight back; these are only ever used to stand in for cards the AI
  // has NOT seen (candidate starters, sampled crib fillers, hypothetical replies).
  var DECK = (function () {
    if (!Cards) return null;
    var out = Cards.makeDeck();
    for (var i = 0; i < out.length; i++) Object.freeze(out[i]);
    return out;
  })();

  var EMPTY = {};

  function requireModules() {
    if (!Cards || !Scoring) {
      throw new Error('Cribbage.AI: cards.js and scoring.js must be loaded first');
    }
  }

  // ------------------------------------------------------------------ plumbing ---

  // mulberry32. The opponent never calls Math.random: an injectable rng is the only
  // source of chance, so easy's wobble and hard's sampling are both reproducible.
  function makeRng(seed) {
    var a = (seed >>> 0) || 0x9e3779b9;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function emptyIdSet() {
    var set = new Array(DECK_SIZE);
    for (var i = 0; i < DECK_SIZE; i++) set[i] = false;
    return set;
  }

  function markIds(set, cards) {
    if (!cards) return set;
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      if (card && typeof card.id === 'number') set[card.id] = true;
    }
    return set;
  }

  function copyCards(cards) {
    var out = [];
    if (!cards) return out;
    for (var i = 0; i < cards.length; i++) {
      if (cards[i]) out.push(cards[i]);
    }
    return out;
  }

  function normalizeLevel(level) {
    var name = String(level === undefined || level === null ? 'normal' : level).toLowerCase();
    if (LEVELS.indexOf(name) < 0) {
      throw new Error('Cribbage.AI.create: level must be one of ' + LEVELS.join(', ') +
        ', got ' + level);
    }
    return name;
  }

  // All 15 index pairs of a six-card hand, in a fixed order so that ties break the
  // same way on every machine and every run.
  var DISCARD_PAIRS = (function () {
    var out = [];
    for (var i = 0; i < DEAL_SIZE; i++) {
      for (var j = i + 1; j < DEAL_SIZE; j++) out.push([i, j]);
    }
    return out;
  })();

  // ---------------------------------------------------------------- hand value ---

  // ------------------------------------------------------- the five-card total ---

  // Two scratch buffers. The file is synchronous and fastScore calls nothing that
  // could re-enter it, so they are never live across two calls; the rank counts are
  // cleared before the function returns rather than on the way in, which is what
  // makes the clear five writes instead of fourteen.
  var SUBSET_SUMS = new Int32Array(32);
  var RANK_COUNTS = new Int32Array(15);

  /**
   * fastScore(four, starter, isCrib) -> exactly what Scoring.scoreHand(...).total
   * returns, and nothing else.
   *
   * scoring.js remains the authority: everything a player ever sees is counted
   * there, and this is never substituted for it anywhere the breakdown is shown.
   * It exists for one reason. A hard lay-away scores thirty thousand imaginary
   * cribs and eleven thousand imaginary hands, and for every one of them scoreHand
   * builds a breakdown — an object, a label and an array of cards per fifteen —
   * that is read for its total and thrown away. Skipping that is worth about four
   * times the speed, which is the difference between a lay-away a phone can afford
   * and one it cannot.
   *
   * ai-tests.js pins it to scoreHand over a large random sweep and over the cases
   * that are easy to get wrong: the four-card flush that pays nothing in a crib,
   * nobs, double pair royal, and runs multiplied by duplicate ranks.
   */
  function fastScore(four, starter, isCrib) {
    var c0 = four[0];
    var c1 = four[1];
    var c2 = four[2];
    var c3 = four[3];
    var total = 0;

    // --- fifteens. Sums are built up one bit at a time, so all 31 non-empty subsets
    // cost one addition each. A single card is worth at most ten and so can never be
    // fifteen, which is why no subset size has to be checked. ---
    var sums = SUBSET_SUMS;
    var v0 = c0.value;
    var v1 = c1.value;
    var v2 = c2.value;
    var v3 = c3.value;
    var v4 = starter.value;
    sums[1] = v0;
    sums[2] = v1;
    sums[4] = v2;
    sums[8] = v3;
    sums[16] = v4;
    for (var m = 3; m < 32; m++) {
      var low = m & -m;
      if (low === m) continue;
      var s = sums[m ^ low] + sums[low];
      sums[m] = s;
      if (s === 15) total += 2;
    }

    // --- pairs. c cards of a rank are worth c*(c-1), which is exactly two points per
    // unordered pair, so ten comparisons cover every case up to double pair royal. ---
    var r0 = c0.rank;
    var r1 = c1.rank;
    var r2 = c2.rank;
    var r3 = c3.rank;
    var r4 = starter.rank;
    if (r0 === r1) total += 2;
    if (r0 === r2) total += 2;
    if (r0 === r3) total += 2;
    if (r0 === r4) total += 2;
    if (r1 === r2) total += 2;
    if (r1 === r3) total += 2;
    if (r1 === r4) total += 2;
    if (r2 === r3) total += 2;
    if (r2 === r4) total += 2;
    if (r3 === r4) total += 2;

    // --- runs. Each maximal block of consecutive ranks of length three or more pays
    // its length once per way of choosing the duplicates in it. ---
    var counts = RANK_COUNTS;
    counts[r0]++;
    counts[r1]++;
    counts[r2]++;
    counts[r3]++;
    counts[r4]++;
    var rank = 1;
    while (rank <= 13) {
      if (counts[rank] === 0) {
        rank++;
        continue;
      }
      var len = 1;
      var mult = counts[rank];
      while (rank < 13 && counts[rank + 1] > 0) {
        rank++;
        len++;
        mult *= counts[rank];
      }
      if (len >= 3) total += len * mult;
      rank++;
    }
    counts[r0] = 0;
    counts[r1] = 0;
    counts[r2] = 0;
    counts[r3] = 0;
    counts[r4] = 0;

    // --- flush. A four-card crib flush pays nothing; only all five do. ---
    var suit = c0.suit;
    if (c1.suit === suit && c2.suit === suit && c3.suit === suit) {
      if (starter.suit === suit) total += 5;
      else if (!isCrib) total += 4;
    }

    // --- nobs, at most once. ---
    var ss = starter.suit;
    if ((r0 === 11 && c0.suit === ss) || (r1 === 11 && c1.suit === ss) ||
      (r2 === 11 && c2.suit === ss) || (r3 === 11 && c3.suit === ss)) total += 1;

    return total;
  }

  /**
   * handEV(kept, knownIds) -> expected show value of `kept`, exactly.
   *
   * The starter is equally likely to be any card that is not one of the six dealt,
   * so the expectation is a plain average over those 46 — no sampling, no error.
   * 15 candidates x 46 starters = 690 scoreHand calls per lay-away decision, which
   * is why every tier can afford the exact number.
   */
  function handEV(kept, knownIds) {
    var total = 0;
    var n = 0;
    for (var id = 0; id < DECK_SIZE; id++) {
      if (knownIds[id]) continue;
      total += fastScore(kept, DECK[id], false);
      n++;
    }
    return n === 0 ? 0 : total / n;
  }

  // Public form: handEV(kept, known) where `known` is the cards already accounted
  // for (normally the six dealt). Exported so a test can check it against a value
  // derived by hand.
  function handEVPublic(kept, known) {
    requireModules();
    var set = emptyIdSet();
    markIds(set, known && known.length ? known : kept);
    markIds(set, kept);
    return handEV(kept, set);
  }

  // ---------------------------------------------------------------- crib value ---

  /**
   * cribHeuristic(a, b) -> what these two cards are worth sitting in a crib, before
   * we decide whose crib it is. Used by the NORMAL tier.
   *
   * Two cards land in a crib with two unknown cards from the other player and the
   * starter on top, so even a wide unrelated pair is not worth nothing — the four
   * strangers around it still make the odd fifteen. The published averages run from
   * about 4.0 for the worst throws to 8.8 for 5-5, and the clauses below are the
   * pieces of club knowledge that move a pair around inside that range:
   *
   *   5-5           the best throw there is: a pair, a fifteen with any of the
   *                 sixteen ten-cards, and a pair royal whenever a third five lands.
   *   5 + ten-card  already a fifteen before anything else arrives.
   *   a lone 5      the single most valuable card in a crib; sixteen cards make it
   *                 a fifteen on their own.
   *   sum 15        the same fifteen, made without a five.
   *   sum 5         a fifteen waiting on any ten-card, and ten-cards are the
   *                 commonest thing in the deck.
   *   a pair        two guaranteed points, and live for a pair royal.
   *   touching      a run needs one card; a gap of two needs one specific rank;
   *                 a gap of three needs two. Beyond that the run is dead.
   *   same suit     a crib flush needs all five, so this is worth very little.
   *   a jack        nobs pays whenever the starter matches its suit: 12 of the 46
   *                 unseen cards, so a quarter of a point.
   *
   * A wide unrelated pair (K-2, 9-K, 4-J) therefore gets the base and nothing else,
   * which is exactly the throw a player wants to give the enemy's crib.
   */
  function cribHeuristic(a, b) {
    var hi = a.rank > b.rank ? a.rank : b.rank;
    var lo = a.rank > b.rank ? b.rank : a.rank;
    var gap = hi - lo;
    var sum = a.value + b.value;
    var bothFives = a.rank === 5 && b.rank === 5;
    var oneFive = !bothFives && (a.rank === 5 || b.rank === 5);
    var v = 4.4;

    if (bothFives) {
      v += 4.4;
    } else if (oneFive && (a.value === 10 || b.value === 10)) {
      v += 2.8;
    } else {
      if (oneFive) v += 1.0;
      if (sum === 15) v += 2.0;
      else if (sum === 5) v += 0.9;
    }
    // The pair bonus is deliberately not applied on top of 5-5, which is already
    // priced as the best throw in the game.
    if (!bothFives && a.rank === b.rank) v += 2.0;
    if (gap === 1) v += 1.6;
    else if (gap === 2) v += 0.8;
    else if (gap === 3) v += 0.2;
    if (a.suit === b.suit) v += 0.5;
    if (a.rank === 11) v += 0.25;
    if (b.rank === 11) v += 0.25;
    return v;
  }

  /**
   * drawTriples(m, n, rng) -> a flat array of 3n indices into an m-card pool, three
   * distinct indices per sample.
   *
   * Drawn ONCE per lay-away decision and reused for all 15 candidates. That is
   * common random numbers, and it matters more than the sample count does: the
   * decision only ever compares candidates, and giving every candidate the same
   * imagined opponent discards and the same imagined starters cancels almost all of
   * the sampling noise out of the differences between them.
   */
  function drawTriples(m, n, rng) {
    var pool = new Array(m);
    var i;
    for (i = 0; i < m; i++) pool[i] = i;
    var out = new Array(n * 3);
    for (var s = 0; s < n; s++) {
      // A three-step partial Fisher-Yates. The pool stays a permutation of 0..m-1
      // afterwards, so the next sample draws freshly from the whole of it.
      for (var d = 0; d < 3; d++) {
        var j = d + Math.floor(rng() * (m - d));
        var t = pool[d];
        pool[d] = pool[j];
        pool[j] = t;
        out[s * 3 + d] = pool[d];
      }
    }
    return out;
  }

  /**
   * cribMonteCarlo(a, b, unseen, triples, buf) -> estimated crib value. HARD tier.
   *
   * The crib holds these two cards, two cards the other player threw, and the
   * starter. Only the first two are known, so the rest is sampled uniformly from the
   * 46 cards this seat has not seen.
   *
   * Two things make this cheap enough to do exactly where it counts. The starter
   * used here need not be the starter used by handEV — expectations add, so
   * E[hand] + E[crib] is E[hand + crib] whether or not the two terms share a
   * starter. And the triples are shared across candidates (see drawTriples), so
   * 1200 samples buy a far steadier ordering than 1200 independent samples would.
   *
   * The known approximation: a real player does not throw uniformly, they throw
   * crib-friendly cards to their own crib and rubbish to yours. Modelling that would
   * need a model of the opponent, and getting it wrong is worse than not having it.
   */
  function cribMonteCarlo(a, b, unseen, triples, buf) {
    var total = 0;
    var n = triples.length / 3;
    buf[0] = a;
    buf[1] = b;
    for (var s = 0; s < triples.length; s += 3) {
      buf[2] = unseen[triples[s]];
      buf[3] = unseen[triples[s + 1]];
      total += fastScore(buf, unseen[triples[s + 2]], true);
    }
    return n === 0 ? 0 : total / n;
  }

  // ------------------------------------------------------------- the lay-away ---

  /**
   * evaluateDiscards(hand, isOwnCrib, level, rng, samples) -> ranked candidates
   *
   * Each entry is { discard, kept, handEV, cribEV, score }, best first.
   *
   *     score = handEV  +  (isOwnCrib ? +1 : -1) * cribEV
   *
   * THE SIGN IS THE WHOLE GAME. The crib belongs to the dealer: cards thrown into
   * your own crib come back to you and count for you, cards thrown into the enemy's
   * crib count for them. Add when it is yours, subtract when it is theirs. Get it
   * backwards and you have built an opponent that feeds its enemy fives, which looks
   * like a personality rather than a bug — hence the test that pins it.
   */
  function evaluateDiscards(hand, isOwnCrib, level, rng, samples) {
    requireModules();
    if (!hand || hand.length !== DEAL_SIZE) {
      throw new Error('Cribbage.AI: a lay-away needs exactly 6 cards, got ' +
        (hand ? hand.length : hand));
    }
    var lvl = normalizeLevel(level);
    var sign = isOwnCrib ? 1 : -1;

    var known = markIds(emptyIdSet(), hand);
    var unseen = [];
    var id;
    for (id = 0; id < DECK_SIZE; id++) {
      if (!known[id]) unseen.push(DECK[id]);
    }

    var triples = null;
    var buf = null;
    if (lvl === 'hard') {
      var n = samples === undefined || samples === null ? CRIB_SAMPLES : samples;
      triples = drawTriples(unseen.length, n, rng);
      buf = new Array(KEEP_SIZE);
    }

    var out = [];
    for (var p = 0; p < DISCARD_PAIRS.length; p++) {
      var pair = DISCARD_PAIRS[p];
      var a = hand[pair[0]];
      var b = hand[pair[1]];
      var kept = [];
      for (var k = 0; k < hand.length; k++) {
        if (k !== pair[0] && k !== pair[1]) kept.push(hand[k]);
      }
      var hev = handEV(kept, known);
      var cev = 0;
      if (lvl === 'normal') cev = cribHeuristic(a, b);
      else if (lvl === 'hard') cev = cribMonteCarlo(a, b, unseen, triples, buf);
      out.push({
        discard: [a, b],
        kept: kept,
        handEV: hev,
        cribEV: cev,
        score: hev + sign * cev
      });
    }

    // Ties break on card id, so two runs of the same position always agree even if
    // the host's sort is not stable.
    out.sort(function (x, y) {
      if (y.score !== x.score) return y.score - x.score;
      var dx = x.discard[0].id * 64 + x.discard[1].id;
      var dy = y.discard[0].id * 64 + y.discard[1].id;
      return dx - dy;
    });
    return out;
  }

  // Easy draws from the SECOND through SIXTH ranked lay-away. Averaged over 3000
  // deals the fifteen candidates are worth 8.4, 7.1, 6.7, 6.0, 5.6, 5.3, 4.8, 4.6,
  // 4.3, 4.1, 3.8, 3.4, 3.1, 2.7, 2.5 points of hand, so this band keeps about 6.1
  // where the best keeps 8.4: a real mistake nearly every deal, of the size a casual
  // player actually makes.
  //
  // It used to draw from the middle third — ranks 5 through 10 — which kept 5.0. That
  // is not casual play, it is nonsense: three and a half points of hand thrown away
  // every deal, and it showed. Easy lost 97.6% of games to normal and was skunked in
  // 63.5% of them, which is not an opponent a human learns anything from.
  var EASY_FIRST = 1;
  var EASY_LAST = 5;

  /**
   * easyPick(ranked, isOwnCrib, rng) -> a candidate from the weaker part of the field.
   *
   * Easy still computes the exact hand EV — it is cheap and it keeps easy from
   * playing absurdly — and then deliberately does not take the best answer.
   *
   * Two floors keep "casual" from turning into "silly", because a beginner does not
   * do these either:
   *   - never hand a five to the ENEMY's crib while any five-free throw exists;
   *   - never keep four ten-cards, which is a hand that cannot peg at all.
   */
  function easyPick(ranked, isOwnCrib, rng) {
    var pool = ranked;
    var filtered;

    if (!isOwnCrib) {
      filtered = pool.filter(function (c) {
        return c.discard[0].rank !== 5 && c.discard[1].rank !== 5;
      });
      if (filtered.length) pool = filtered;
    }

    filtered = pool.filter(function (c) {
      for (var i = 0; i < c.kept.length; i++) {
        if (c.kept[i].value < 10) return true;
      }
      return false;
    });
    if (filtered.length) pool = filtered;

    var n = pool.length;
    var hi = EASY_LAST < n - 1 ? EASY_LAST : n - 1;
    var lo = EASY_FIRST < hi ? EASY_FIRST : hi;
    var idx = lo + Math.floor(rng() * (hi - lo + 1));
    if (idx > hi) idx = hi;
    return pool[idx];
  }

  // ------------------------------------------------------------------ the view ---

  /**
   * narrowView(state, seatHint, memory) -> view
   *
   * THE ONLY function in this file that reads an engine snapshot.
   *
   * It reads exactly, and nothing else:
   *     toMove, dealer, handNumber, starter,
   *     play.count, play.series, play.pile,
   *     hands[seat]                 <- its OWN hand. Never hands[1 - seat].
   *
   * It never touches crib, deck, cardsRemaining, showHands, or the other seat's
   * hand — the four places where the answers are. Everything downstream sees only
   * what comes back from here, which is why the no-cheating test can be a real test
   * rather than a comment: put a recording proxy in front of the snapshot at every
   * decision of a whole game, every tier, both seats, and read off the list. Whole
   * games and both seats are the load-bearing part. A peek gated on `seat === 0`, or
   * on the second deal, or on a series two cards deep is invisible to any single
   * hand-made position, and those are the shapes a peek naturally takes.
   *
   * `memory` carries the two cards this opponent itself threw into the crib. That is
   * knowledge a player at the table plainly has, and it is remembered rather than
   * read out of state.crib, which also holds the other player's two.
   */
  function narrowView(state, seatHint, memory) {
    var s = state || EMPTY;
    var seat = s.toMove === 0 || s.toMove === 1 ? s.toMove : seatHint;
    var dealer = s.dealer === 0 || s.dealer === 1 ? s.dealer : null;
    var handNumber = typeof s.handNumber === 'number' ? s.handNumber : -1;
    var starter = s.starter || null;

    var play = s.play || EMPTY;
    var count = typeof play.count === 'number' ? play.count : 0;
    var series = copyCards(play.series);

    var pile = play.pile || [];
    var mine = [];
    var theirs = [];
    for (var i = 0; i < pile.length; i++) {
      var entry = pile[i];
      if (!entry || !entry.card) continue;
      if (entry.player === seat) mine.push(entry.card);
      else theirs.push(entry.card);
    }

    // The seat's own hand, by explicit index. There is no expression anywhere in
    // this file that indexes hands with anything but `seat`.
    var myHand = [];
    if (seat === 0 || seat === 1) {
      var hands = s.hands;
      var own = hands ? hands[seat] : null;
      if (own) myHand = copyCards(own);
    }

    var myDiscards = [];
    if (memory && memory.cards && memory.handNumber === handNumber) {
      myDiscards = memory.cards.slice();
    }

    // Nothing of the other seat's appears below, not even the things they said out
    // loud. A go IS public, and hard did once deduce from it that nothing small was
    // left in their hand — a sound deduction, and measured against a copy of itself
    // over 8000 mirrored games it was worth 50.1% +/- 0.8, which is to say nothing.
    // It went, because "the view contains nothing of theirs" is a promise worth more
    // than an unmeasurable refinement is, and a promise with one exception in it is
    // a promise somebody has to remember.
    return {
      seat: seat === 0 || seat === 1 ? seat : null,
      dealer: dealer,
      handNumber: handNumber,
      starter: starter,
      count: count,
      room: MAX_COUNT - count,
      series: series,
      myPlayed: mine,
      theirPlayed: theirs,
      myHand: myHand,
      myDiscards: myDiscards
    };
  }

  // Everything this seat cannot account for. The other player's remaining cards are
  // drawn from here, and so is every card that could still turn up.
  function unseenFrom(view, legal) {
    var known = emptyIdSet();
    markIds(known, view.myHand);
    markIds(known, legal);
    markIds(known, view.myPlayed);
    markIds(known, view.theirPlayed);
    markIds(known, view.myDiscards);
    if (view.starter) known[view.starter.id] = true;
    var out = [];
    for (var id = 0; id < DECK_SIZE; id++) {
      if (!known[id]) out.push(DECK[id]);
    }
    return out;
  }

  // ------------------------------------------------------------------- the play ---

  // How likely the other player is to hold at least one card of a given value, as a
  // fixed table rather than a calculation over the current position — the normal
  // tier is explicit tactics, not search. Sixteen of the fifty-two cards are worth
  // ten, which is the single most important number in pegging.
  var HOLDS_TEN = 0.72;   // 1 - C(36,4)/C(52,4)
  var HOLDS_RANK = 0.28;  // 1 - C(48,4)/C(52,4)

  function holdsValue(v) {
    if (v < 1 || v > 10) return 0;
    return v === 10 ? HOLDS_TEN : HOLDS_RANK;
  }

  /**
   * dangerAt(after) -> expected points handed over by leaving the count here.
   *
   * The count you leave behind is the part of pegging most players get wrong. Leave
   * 5 and any ten-card makes fifteen; leave 21 and any ten-card makes thirty-one.
   * Sixteen cards are worth ten, so the other player holds one about 72% of the
   * time and those two counts cost about 1.4 points each — an enormous number next
   * to the two points a pair is worth. Every other reachable count needs a specific
   * rank (four cards, ~28%) and costs about a quarter of that. Leaving 15, or 4, or
   * anything from which no single card reaches 15 or 31, costs nothing at all,
   * which is precisely why the classic lead is a four.
   */
  function dangerAt(after) {
    if (after >= MAX_COUNT) return 0;
    return 2 * holdsValue(15 - after) + 2 * holdsValue(MAX_COUNT - after);
  }

  // Two cards within two ranks of each other invite a run from the card that fills
  // or extends them. Explicit and local: it looks only at the card just played.
  function runThreat(series, card) {
    if (!series.length) return 0;
    var prev = series[series.length - 1];
    var gap = Math.abs(prev.rank - card.rank);
    if (gap === 0) return 0;
    return gap <= 2 ? 0.6 : 0;
  }

  function containsAll(cards, wanted) {
    for (var i = 0; i < wanted.length; i++) {
      var found = false;
      for (var j = 0; j < cards.length && !found; j++) {
        if (cards[j].id === wanted[i].id) found = true;
      }
      if (!found) return false;
    }
    return true;
  }

  function holdsAnotherOfRank(hand, card) {
    for (var i = 0; i < hand.length; i++) {
      if (hand[i].id !== card.id && hand[i].rank === card.rank) return true;
    }
    return false;
  }

  /**
   * Hard rules shared by normal and hard, applied before anything is weighed. Both
   * are filters rather than weights, so no amount of arithmetic below can outvote
   * them:
   *   - take thirty-one whenever it is there. Two points, the series dies, and the
   *     other player never gets the go point.
   *   - never lead a five. Sixteen cards are worth ten; leading a five is handing
   *     over two points nearly three times in four.
   *
   * The five rule is an absolute at a real table. The thirty-one rule is very
   * nearly one, and it is worth being honest about the exception: a card that makes
   * a run of three or more scores more than the two that thirty-one pays, and the
   * count it leaves may be one the other player cannot reach anyway. Taking
   * thirty-one is still the rule here — it is never bad, it ends the series safely,
   * and a predictable opponent is easier to trust than a clever one — but this is
   * the one place the tactics knowingly leave a fraction of a point on the table.
   */
  function applyHardRules(view, legal) {
    var pool = legal;
    var thirtyOne = pool.filter(function (c) {
      return view.count + c.value === MAX_COUNT;
    });
    if (thirtyOne.length) return thirtyOne;

    if (view.series.length === 0) {
      var notFive = pool.filter(function (c) { return c.rank !== 5; });
      if (notFive.length) return notFive;
    }
    return pool;
  }

  /**
   * tacticalScore(series, count, hand, card) -> NORMAL's weighing of one candidate.
   *
   * Points are weighted to dominate everything else — two on the table beats any
   * positional worry — and below them sit the count this leaves behind, the run it
   * invites, what to lead, and the two things no static rule can see because they
   * are about the series AFTER this one:
   *   - lead FROM a pair, not away from it. Holding the mate is the reason the lead
   *     is safe: if they pair it for 2 the third one is still in hand and pays 6, a
   *     net four points for offering the bait. Two of that rank are still out among
   *     the cards this seat cannot see, so they can take it about one time in six —
   *     worth something like two thirds of a point, which is the order of magnitude
   *     of the bonus below. This used to be a PENALTY, on the reasoning that leading
   *     half a pair "spends" it; that is exactly backwards, and it cost the normal
   *     tier two and a half points of win rate against an otherwise identical copy
   *     of itself (47.5% +/- 0.8 over 3000 mirrored games, twice, on two seeds).
   *   - keep the low cards. Whoever still holds a two or a three when the count is
   *     at 28 takes the last card, and often the go with it.
   *
   * Written against loose arguments rather than a view because the hard tier calls
   * it a few thousand times per decision inside its rollouts. That sharing is the
   * point: hard's search is a policy improvement over precisely the game normal
   * plays, so the two tiers cannot drift apart into unrelated opponents.
   */
  function tacticalScore(series, count, hand, card) {
    var pts = Scoring.scorePlay(series, card).points;
    var after = count + card.value;
    var s = pts * 10;

    if (after === MAX_COUNT) s += 3;
    s -= dangerAt(after);
    s -= runThreat(series, card);
    if (series.length === 0) {
      // A four or lower leaves a count no single card can reach fifteen from, which
      // is the whole reason the classic lead is a low card.
      s += card.rank <= 4 ? 0.9 : (card.rank <= 9 ? 0.3 : 0);
      if (holdsAnotherOfRank(hand, card)) s += 1;
    } else {
      // Kept small on purpose: the widest this term can swing a decision is half a
      // point, so it can break a tie but can never outvote the count left at 5.
      s += card.value * 0.05;
    }
    return s;
  }

  function normalPlay(view, legal) {
    var pool = applyHardRules(view, legal);
    var best = pool[0];
    var bestScore = -Infinity;
    for (var i = 0; i < pool.length; i++) {
      var s = tacticalScore(view.series, view.count, view.myHand, pool[i]);
      if (s > bestScore) {
        bestScore = s;
        best = pool[i];
      }
    }
    return best;
  }

  /**
   * easyPlay — take an obvious score, otherwise play more or less at random.
   *
   * No danger table, no lookahead: easy leaves the count at 5, walks into pairs and
   * gives away the odd go. That is what a casual player does, and it is what makes
   * easy beatable. It is never illegal and never refuses free points, so it still
   * plays a recognisable game.
   */
  function easyPlay(view, legal, rng) {
    var best = -1;
    var pool = [];
    for (var i = 0; i < legal.length; i++) {
      var pts = Scoring.scorePlay(view.series, legal[i]).points;
      if (pts > best) {
        best = pts;
        pool = [legal[i]];
      } else if (pts === best) {
        pool.push(legal[i]);
      }
    }
    return pool[Math.floor(rng() * pool.length)] || legal[0];
  }

  // ---------------------------------------------- the hard tier's play search ---

  /**
   * How many opposing hands hard imagines before it commits to a card.
   *
   * Measured, by playing this tier against copies of itself that differ in nothing
   * but this number, over 3000 mirrored games each:
   *
   *     384 against 128   50.3% +/- 0.9
   *     128 against  48   50.0% +/- 1.0
   *     128 against  32   50.8% +/- 1.0
   *
   * — that is, above about thirty-two samples the count stops buying anything at
   * all, because the candidates are all judged against the SAME imagined hands and
   * it is only the difference between them that has to be right. Sixteen is visibly
   * too few (it drops four points of win rate against normal). 128 is chosen for
   * headroom rather than need: it costs 0.41ms a decision, worst case 1.7ms, which
   * is nothing beside the lay-away, so there is no reason to sail closer to the wind.
   */
  var PLAY_SAMPLES = 128;

  function canPlayFrom(hand, room) {
    for (var i = 0; i < hand.length; i++) {
      if (hand[i].value <= room) return true;
    }
    return false;
  }

  // normal's tactics, chosen without allocating: the same two hard rules and the
  // same weighing, so a rollout plays exactly the game normalPlay plays.
  function rolloutPick(series, count, hand) {
    var room = MAX_COUNT - count;
    var i;
    var has31 = false;
    var lead = series.length === 0;
    var otherThanFive = false;
    for (i = 0; i < hand.length; i++) {
      if (count + hand[i].value === MAX_COUNT) has31 = true;
      else if (lead && hand[i].rank !== 5 && hand[i].value <= room) otherThanFive = true;
    }
    var best = null;
    var bestScore = -Infinity;
    for (i = 0; i < hand.length; i++) {
      var card = hand[i];
      if (card.value > room) continue;
      if (has31 && count + card.value !== MAX_COUNT) continue;
      if (!has31 && lead && otherThanFive && card.rank === 5) continue;
      var s = tacticalScore(series, count, hand, card);
      if (s > bestScore) {
        bestScore = s;
        best = card;
      }
    }
    return best;
  }

  function removeCard(hand, card) {
    for (var i = 0; i < hand.length; i++) {
      if (hand[i].id === card.id) {
        hand.splice(i, 1);
        return;
      }
    }
  }

  /**
   * rollout(series, count, hands, toMove, lastPlayed) -> [pointsToSeat0, pointsToSeat1]
   *
   * Plays the rest of the hand out with both sides on normal's tactics and returns
   * what each pegs. A faithful miniature of the engine's own play loop — gos, the
   * last card, the dead count at thirty-one, the rule that the player who did NOT
   * lay the last card leads the next series. `hands` is consumed.
   *
   * `lastPlayed` is who laid the card on top of `series`, and it is not optional
   * bookkeeping: it is who the go or the last card belongs to if neither side can
   * follow. Omit it (or pass null) only for a series that has not been started —
   * count 0, empty series. hardPlay always enters mid-series, one card in, so it
   * passes its own index; leaving it null there credited that point to NOBODY, which
   * quietly docked a point from exactly the candidates that shut a series down in the
   * AI's own favour.
   *
   * Faithful is a claim, so ai-tests.js proves it: it deals real hands, plays them
   * through the REAL engine with normal on both sides, and asserts this returns the
   * identical pegging totals — from the lead, AND from every mid-series position the
   * hand passes through, which is the shape hardPlay actually calls. If the miniature
   * ever drifts from the engine, hard is optimising the wrong game and nothing else
   * in the file would notice.
   */
  function rollout(series, count, hands, toMove, lastPlayed) {
    var scores = [0, 0];
    var s = series.slice();
    var c = count;
    var lastPlayer = lastPlayed === 0 || lastPlayed === 1 ? lastPlayed : null;
    var guard = 0;
    while (hands[0].length || hands[1].length || s.length) {
      // Eight cards is the most that can be left, and each pass either plays one or
      // ends a series; the guard is for a future edit that gets the reset wrong, not
      // for anything reachable today.
      if (++guard > 64) break;
      var room = MAX_COUNT - c;
      if (canPlayFrom(hands[toMove], room)) {
        var card = rolloutPick(s, c, hands[toMove]);
        removeCard(hands[toMove], card);
        scores[toMove] += Scoring.scorePlay(s, card).points;
        s.push(card);
        c += card.value;
        lastPlayer = toMove;
        toMove = 1 - toMove;
        continue;
      }
      if (canPlayFrom(hands[1 - toMove], room)) {
        toMove = 1 - toMove;
        continue;
      }
      // Neither can add a card. At thirty-one the count is already paid for.
      if (c !== MAX_COUNT && lastPlayer !== null) scores[lastPlayer] += 1;
      toMove = lastPlayer === null ? toMove : 1 - lastPlayer;
      lastPlayer = null;
      c = 0;
      s = [];
    }
    return scores;
  }

  /**
   * hardPlay — imagine the hand they might hold, play the rest of the hand out, and
   * take the card that nets the most.
   *
   * This is the whole difference between the tiers at the peg. Normal weighs the
   * count it is about to leave against a fixed table of how often a ten-card turns
   * up. Hard samples an actual opposing hand from the cards it has not seen, plays
   * the remainder of the hand out against it with both sides using normal's tactics,
   * and scores the result — so it prices, rather than approximates, the things the
   * table cannot express at all: who wins the go, who is left holding a card nobody
   * can follow, whether a pair is worth offering because the third one is in hand,
   * and how many cards the other player actually has left.
   *
   * Because it evaluates every candidate against the SAME imagined hands (common
   * random numbers), the differences between candidates carry almost no sampling
   * noise even though each estimate individually does.
   *
   * The uniform draw is the model's one soft spot: the other player's four cards are
   * not a uniform sample of the unseen, they are what is left after a lay-away.
   * Modelling that needs a model of them, and a wrong one is worse than none.
   */
  function hardPlay(view, legal, rng, samples) {
    var pool = applyHardRules(view, legal);
    if (pool.length === 1) return pool[0];

    var unseen = unseenFrom(view, legal);
    var oppLeft = KEEP_SIZE - view.theirPlayed.length;
    if (oppLeft < 0) oppLeft = 0;

    if (oppLeft > unseen.length) oppLeft = unseen.length;

    // Per candidate, everything that does not change from sample to sample.
    var n = pool.length;
    var mine = new Array(n);
    var rest = new Array(n);
    var series = new Array(n);
    var counts = new Array(n);
    var totals = new Array(n);
    var i;
    for (i = 0; i < n; i++) {
      var card = pool[i];
      mine[i] = Scoring.scorePlay(view.series, card).points;
      counts[i] = view.count + card.value;
      series[i] = view.series.concat([card]);
      var keep = [];
      for (var k = 0; k < view.myHand.length; k++) {
        if (view.myHand[k].id !== card.id) keep.push(view.myHand[k]);
      }
      rest[i] = keep;
      totals[i] = 0;
    }

    // With their hand already empty there is nothing to imagine: one play-out
    // answers the question exactly, and repeating it would only cost time.
    var draws = oppLeft === 0 ? 1 : (samples || PLAY_SAMPLES);
    var order = new Array(unseen.length);
    for (i = 0; i < unseen.length; i++) order[i] = i;
    var oppHand = new Array(oppLeft);

    for (var d = 0; d < draws; d++) {
      // One imagined hand, dealt by partial Fisher-Yates so the pool stays a
      // permutation and the next draw is fresh over the whole of it.
      for (var j = 0; j < oppLeft; j++) {
        var pick = j + Math.floor(rng() * (unseen.length - j));
        var swap = order[j];
        order[j] = order[pick];
        order[pick] = swap;
        oppHand[j] = unseen[order[j]];
      }
      for (i = 0; i < n; i++) {
        // Index 0 is this seat, and it has just laid pool[i] on top of series[i] —
        // so 0 is the player owed the go if neither side can follow it.
        var got = rollout(series[i], counts[i], [rest[i].slice(), oppHand.slice()], 1, 0);
        totals[i] += mine[i] + got[0] - got[1];
      }
    }

    var best = pool[0];
    var bestScore = -Infinity;
    for (i = 0; i < n; i++) {
      if (totals[i] > bestScore) {
        bestScore = totals[i];
        best = pool[i];
      }
    }
    return best;
  }

  // -------------------------------------------------------------------- create ---

  /**
   * AI.create(level, opts) -> opponent
   *
   *   level          'easy' | 'normal' | 'hard'
   *   opts.rng       () -> [0,1). Injected so a game, a tournament or a test replays
   *                  exactly. Defaults to a mulberry32 seeded from the clock — never
   *                  Math.random, which cannot be reproduced.
   *   opts.seed      a seed for the default rng, if you would rather not build one.
   *   opts.cribSamples  hard's crib sample count at the lay-away. Default CRIB_SAMPLES.
   *   opts.playSamples  hard's imagined-hand count at the peg. Default PLAY_SAMPLES.
   *
   * The returned object is the seam js/game.js already drives:
   *   name
   *   chooseDiscard(hand, isOwnCrib, state) -> [cardA, cardB]
   *   choosePlay(legalCards, state)         -> one of legalCards
   * Both synchronous, both returning the very card objects they were handed.
   */
  function create(level, opts) {
    requireModules();
    var lvl = normalizeLevel(level);
    opts = opts || {};

    var rng = opts.rng;
    if (rng === undefined || rng === null) {
      var seed = typeof opts.seed === 'number' ? opts.seed
        : ((Date.now() >>> 0) ^ 0x5bf03635);
      rng = makeRng(seed);
    }
    if (typeof rng !== 'function') {
      throw new Error('Cribbage.AI.create: opts.rng must be a function');
    }
    var cribSamples = typeof opts.cribSamples === 'number' ? opts.cribSamples : CRIB_SAMPLES;
    var playSamples = typeof opts.playSamples === 'number' ? opts.playSamples : PLAY_SAMPLES;

    // The two cards this opponent threw into the crib, keyed by the hand they were
    // thrown in. A player at the table knows this; state.crib would also hand over
    // the other player's two, so it is never read.
    var memory = { handNumber: -2, cards: null };

    function chooseDiscard(hand, isOwnCrib, state) {
      var cards = copyCards(hand);
      // The lay-away needs nothing from the state but the hand number, which is how
      // the crib memory below knows which deal it belongs to.
      var view = narrowView(state, null, null);
      var ranked = evaluateDiscards(cards, !!isOwnCrib, lvl, rng, cribSamples);
      var pick = lvl === 'easy' ? easyPick(ranked, !!isOwnCrib, rng) : ranked[0];
      memory.handNumber = view.handNumber;
      memory.cards = pick.discard.slice();
      return pick.discard.slice();
    }

    function choosePlay(legalCards, state) {
      var legal = copyCards(legalCards);
      if (!legal.length) return null;
      var view = narrowView(state, null, memory);
      // The seat came from state.toMove, so hands[seat] is this opponent's own hand.
      // Trust it only if it really does hold everything the caller just offered:
      // if a caller ever mislabelled the seat, that hand belongs to somebody else
      // and must be dropped rather than read. With nothing to go on the view still
      // knows the count and the series, which is all the tactics need.
      if (!view.myHand.length || !containsAll(view.myHand, legal)) view.myHand = legal.slice();
      if (lvl === 'easy') return easyPlay(view, legal, rng);
      if (lvl === 'hard') return hardPlay(view, legal, rng, playSamples);
      return normalPlay(view, legal);
    }

    return {
      name: lvl,
      level: lvl,
      chooseDiscard: chooseDiscard,
      choosePlay: choosePlay
    };
  }

  root.Cribbage = root.Cribbage || {};
  root.Cribbage.AI = {
    create: create,
    LEVELS: LEVELS,
    CRIB_SAMPLES: CRIB_SAMPLES,
    PLAY_SAMPLES: PLAY_SAMPLES,
    makeRng: makeRng,
    handEV: handEVPublic,
    cribHeuristic: cribHeuristic,
    evaluateDiscards: evaluateDiscards,
    narrowView: narrowView,
    dangerAt: dangerAt,
    // Exported for the tests that pin the two fast paths to the code they stand in
    // for: the rollout to the engine's play loop, fastScore to scoring.js.
    rollout: rollout,
    fastScore: fastScore
  };
})(typeof window !== 'undefined' ? window : globalThis);
