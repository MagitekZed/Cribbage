(function (root) {
  'use strict';

  // scoring.js is PURE: no DOM, no shared mutable state, no randomness, no I/O.
  // It never mutates its arguments. Everything in the game funnels through here,
  // so a bug in this file is a bug in every other phase.

  var RANK_PLURALS = [
    'aces', 'twos', 'threes', 'fours', 'fives', 'sixes', 'sevens',
    'eights', 'nines', 'tens', 'jacks', 'queens', 'kings'
  ];

  var COUNT_WORDS = [
    'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
    'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen'
  ];

  function countWord(n) {
    return COUNT_WORDS[n] !== undefined ? COUNT_WORDS[n] : String(n);
  }

  // Same-rank cards are announced as a single unit at a table — "pair royal of fives is
  // six", never "two, four, six". Shared by scoreHand and scorePlay so the show and the
  // play read identically.
  function pairLabel(n, rank) {
    var plural = RANK_PLURALS[rank - 1];
    if (n === 2) return 'Pair of ' + plural;
    if (n === 3) return 'Pair royal of ' + plural;
    return 'Double pair royal of ' + plural;
  }

  // rank -> array of cards of that rank, indices 1..13. Drives both pairs and runs.
  function bucketByRank(cards) {
    var buckets = [];
    for (var r = 0; r <= 13; r++) buckets.push(null);
    for (var i = 0; i < cards.length; i++) {
      var rk = cards[i].rank;
      if (buckets[rk] === null) buckets[rk] = [];
      buckets[rk].push(cards[i]);
    }
    return buckets;
  }

  // All index subsets of size 2..n, ordered by size then lexicographically. Precomputed
  // once because scoreHand runs ~26 million times in the exhaustive verification pass.
  var SUBSETS = (function () {
    function combinations(n, k) {
      var out = [];
      var idx = new Array(k);
      (function rec(start, depth) {
        if (depth === k) {
          out.push(idx.slice());
          return;
        }
        for (var i = start; i <= n - (k - depth); i++) {
          idx[depth] = i;
          rec(i + 1, depth + 1);
        }
      })(0, 0);
      return out;
    }
    var table = [];
    for (var n = 0; n <= 6; n++) {
      var list = [];
      for (var size = 2; size <= n; size++) {
        var combos = combinations(n, size);
        for (var i = 0; i < combos.length; i++) list.push(combos[i]);
      }
      table[n] = list;
    }
    return table;
  })();

  function countValue(cards) {
    var sum = 0;
    for (var i = 0; i < cards.length; i++) sum += cards[i].value;
    return sum;
  }

  // His heels: a turned Jack pays the DEALER 2 at cut time. Deliberately not part of
  // scoreHand — the starter Jack is nobody's hand card, so it can never double with nobs.
  function scoreHeels(starter) {
    return starter && starter.rank === 11 ? 2 : 0;
  }

  function pick(cards, idx) {
    var out = new Array(idx.length);
    for (var i = 0; i < idx.length; i++) out[i] = cards[idx[i]];
    return out;
  }

  /**
   * scoreHand(fourCards, starter, isCrib) -> { total, breakdown }
   * breakdown order is fixed: fifteens, pairs, runs, flush, nobs. That order drives
   * the on-screen counting animation, so it must be complete and stable.
   */
  function scoreHand(fourCards, starter, isCrib) {
    var cards = fourCards.slice();
    if (starter) cards.push(starter);
    var n = cards.length;

    var breakdown = [];
    var total = 0;

    // --- 1. Fifteens: every subset of size >= 2 whose .value sum is exactly 15. ---
    var subsets = SUBSETS[n] || [];
    var fifteenRunning = 0;
    for (var s = 0; s < subsets.length; s++) {
      var idx = subsets[s];
      var sum = 0;
      for (var i = 0; i < idx.length; i++) sum += cards[idx[i]].value;
      if (sum === 15) {
        fifteenRunning += 2;
        breakdown.push({
          type: 'fifteen',
          points: 2,
          cards: pick(cards, idx),
          // Fifteens are announced cumulatively, exactly as they are counted at a table.
          label: 'Fifteen ' + countWord(fifteenRunning)
        });
      }
    }
    total += fifteenRunning;

    var buckets = bucketByRank(cards);

    // --- 2. Pairs: c cards of a rank are worth c*(c-1), emitted as ONE entry so the
    // counting animation gives a pair royal a single six-point beat rather than three
    // two-point beats. Two distinct pairs still yield two entries, as they should. ---
    for (var pr = 1; pr <= 13; pr++) {
      var group = buckets[pr];
      if (group === null || group.length < 2) continue;
      var pairPts = group.length * (group.length - 1);
      total += pairPts;
      breakdown.push({
        type: 'pair',
        points: pairPts,
        cards: group.slice(),
        label: pairLabel(group.length, pr)
      });
    }

    // --- 3. Runs: maximal consecutive rank blocks of length >= 3, multiplied by
    // duplicate counts. Emitted as one entry per distinct run so each animation beat
    // highlights an actual run; the entries still sum to L * product(counts). ---
    var rank = 1;
    while (rank <= 13) {
      if (buckets[rank] === null) {
        rank++;
        continue;
      }
      var start = rank;
      while (rank + 1 <= 13 && buckets[rank + 1] !== null) rank++;
      var end = rank;
      var length = end - start + 1;
      if (length >= 3) {
        // Cartesian product over the block: one run instance per choice of duplicate.
        var instances = [[]];
        for (var rr = start; rr <= end; rr++) {
          var next = [];
          for (var p = 0; p < instances.length; p++) {
            for (var q = 0; q < buckets[rr].length; q++) {
              next.push(instances[p].concat([buckets[rr][q]]));
            }
          }
          instances = next;
        }
        for (var ins = 0; ins < instances.length; ins++) {
          total += length;
          breakdown.push({
            type: 'run',
            points: length,
            cards: instances[ins],
            label: 'Run of ' + countWord(length)
          });
        }
      }
      rank++;
    }

    // --- 4. Flush. The crib rule (a four-card crib flush scores ZERO) is the single
    // most commonly mis-implemented rule in cribbage. ---
    if (fourCards.length === 4) {
      var suit = fourCards[0].suit;
      var allFour = fourCards[1].suit === suit && fourCards[2].suit === suit &&
        fourCards[3].suit === suit;
      if (allFour) {
        if (starter && starter.suit === suit) {
          total += 5;
          breakdown.push({
            type: 'flush',
            points: 5,
            cards: fourCards.slice().concat([starter]),
            label: 'Flush (5)'
          });
        } else if (!isCrib) {
          total += 4;
          breakdown.push({
            type: 'flush',
            points: 4,
            cards: fourCards.slice(),
            label: 'Flush (4)'
          });
        }
      }
    }

    // --- 5. Nobs: a Jack in the HAND/CRIB matching the starter's suit. At most once. ---
    if (starter) {
      for (var j = 0; j < fourCards.length; j++) {
        if (fourCards[j].rank === 11 && fourCards[j].suit === starter.suit) {
          total += 1;
          breakdown.push({
            type: 'nobs',
            points: 1,
            cards: [fourCards[j]],
            label: 'His nob'
          });
          break;
        }
      }
    }

    return { total: total, breakdown: breakdown };
  }

  /**
   * scorePlay(series, playedCard) -> { points, breakdown }
   * `series` holds the cards already played in the CURRENT series (since the count last
   * reset), not including playedCard. Only the running count matters for 15/31 — subsets
   * are irrelevant during the play.
   */
  function scorePlay(series, playedCard) {
    var all = series.concat([playedCard]);
    var n = all.length;
    var count = countValue(all);

    var breakdown = [];
    var points = 0;

    if (count === 15) {
      points += 2;
      breakdown.push({ type: 'fifteen', points: 2, cards: all.slice(), label: 'Fifteen two' });
    }
    if (count === 31) {
      points += 2;
      breakdown.push({
        type: 'thirtyone', points: 2, cards: all.slice(), label: 'Thirty-one for two'
      });
    }

    // Pairs are evaluated on the TRAILING block of equal ranks only, which is why
    // 5,6,5,5 scores a plain pair on the last card rather than a pair royal.
    var runLen = 1;
    for (var i = n - 2; i >= 0 && all[i].rank === playedCard.rank; i--) runLen++;
    if (runLen >= 2) {
      var pairPoints = runLen * (runLen - 1);
      points += pairPoints;
      breakdown.push({
        type: 'pair',
        points: pairPoints,
        cards: all.slice(n - runLen),
        label: pairLabel(runLen, playedCard.rank)
      });
    }

    // Runs: longest trailing window wins, order within the window is irrelevant.
    // A trailing pair makes every window non-distinct, so pair and run never coexist.
    for (var L = n; L >= 3; L--) {
      var lo = 14;
      var hi = 0;
      var seen = 0;
      var distinct = true;
      for (var k = n - L; k < n; k++) {
        var rk = all[k].rank;
        var bit = 1 << rk;
        if (seen & bit) {
          distinct = false;
          break;
        }
        seen |= bit;
        if (rk < lo) lo = rk;
        if (rk > hi) hi = rk;
      }
      if (distinct && hi - lo === L - 1) {
        points += L;
        breakdown.push({
          type: 'run',
          points: L,
          cards: all.slice(n - L),
          label: 'Run of ' + countWord(L)
        });
        break;
      }
    }

    return { points: points, breakdown: breakdown };
  }

  root.Cribbage = root.Cribbage || {};
  root.Cribbage.Scoring = {
    scoreHand: scoreHand,
    scorePlay: scorePlay,
    scoreHeels: scoreHeels,
    countValue: countValue
  };
})(typeof window !== 'undefined' ? window : globalThis);
