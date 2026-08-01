(function (root) {
  'use strict';

  // A second, deliberately INDEPENDENT implementation of scoring, used only for
  // differential testing against scoring.js. It shares no code with scoring.js and
  // reaches its answers by different structures on purpose:
  //
  // scoreHandTotal (the show):
  //   fifteens -> depth-first include/exclude recursion over the five values
  //               (scoring.js walks a precomputed table of index subsets)
  //   pairs    -> rank frequency histogram, c*(c-1) per rank
  //               (scoring.js walks every unordered pair)
  //   runs     -> enumerate all 32 bitmask subsets, find the LARGEST subset size that
  //               forms a run and count how many subsets of that size do
  //               (scoring.js splits the ranks into maximal consecutive blocks)
  //   flush    -> suit frequency histogram
  //               (scoring.js compares suits directly)
  //
  // scorePlayTotal (the play):
  //   pairs    -> forward scan that restarts the trailing equal-rank block on every rank
  //               change, then a double loop counting unordered pairs inside it
  //               (scoring.js scans backwards and uses the closed form n*(n-1))
  //   runs     -> window lengths walked UPWARD from 3, each window sorted and required to
  //               step by exactly +1, keeping the LAST length that qualified
  //               (scoring.js walks downward and uses a distinctness bitmask plus max-min)
  //
  // A bug shared by two structures this different is unlikely. Never call into
  // scoring.js from here, and never copy its logic here.

  function fifteenPaths(values, i, sum) {
    if (i === 5) return sum === 15 ? 1 : 0;
    // exclude values[i], then include it
    return fifteenPaths(values, i + 1, sum) + fifteenPaths(values, i + 1, sum + values[i]);
  }

  var POPCOUNT = (function () {
    var t = [];
    for (var m = 0; m < 32; m++) {
      var c = 0;
      for (var b = 0; b < 5; b++) if (m & (1 << b)) c++;
      t.push(c);
    }
    return t;
  })();

  function scoreHandTotal(fourCards, starter, isCrib) {
    var ranks = [
      fourCards[0].rank, fourCards[1].rank, fourCards[2].rank, fourCards[3].rank,
      starter.rank
    ];
    var values = [
      fourCards[0].value, fourCards[1].value, fourCards[2].value, fourCards[3].value,
      starter.value
    ];
    var suits = [
      fourCards[0].suit, fourCards[1].suit, fourCards[2].suit, fourCards[3].suit,
      starter.suit
    ];

    var score = 0;
    var k, b;

    // Fifteens. The empty selection sums to 0 and a single card tops out at 10, so any
    // path landing on 15 necessarily used at least two cards; no size filter needed.
    score += 2 * fifteenPaths(values, 0, 0);

    // Pairs. c cards of one rank yield C(c,2) pairs worth 2 each, i.e. c*(c-1).
    var rankFreq = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (k = 0; k < 5; k++) rankFreq[ranks[k]]++;
    for (var r = 1; r <= 13; r++) {
      score += rankFreq[r] * (rankFreq[r] - 1);
    }

    // Runs. Walk subset sizes 5 -> 4 -> 3; the first size that yields any run is the
    // only size that scores, and every subset of that size that is a run scores it.
    var picked = [0, 0, 0, 0, 0];
    for (var size = 5; size >= 3; size--) {
      var runs = 0;
      for (var mask = 0; mask < 32; mask++) {
        if (POPCOUNT[mask] !== size) continue;
        var m = 0;
        for (b = 0; b < 5; b++) {
          if (mask & (1 << b)) picked[m++] = ranks[b];
        }
        // insertion sort, m <= 5
        for (var i = 1; i < m; i++) {
          var v = picked[i];
          var j = i - 1;
          while (j >= 0 && picked[j] > v) {
            picked[j + 1] = picked[j];
            j--;
          }
          picked[j + 1] = v;
        }
        var consecutive = true;
        for (var p = 1; p < m; p++) {
          if (picked[p] !== picked[p - 1] + 1) { consecutive = false; break; }
        }
        if (consecutive) runs++;
      }
      if (runs > 0) {
        score += size * runs;
        break;
      }
    }

    // Flush. Four-card crib flushes are worth nothing; only five cards count in the crib.
    var suitFreq = [0, 0, 0, 0];
    for (k = 0; k < 4; k++) suitFreq[suits[k]]++;
    for (var s = 0; s < 4; s++) {
      if (suitFreq[s] === 4) {
        if (suits[4] === s) score += 5;
        else if (!isCrib) score += 4;
      }
    }

    // Nobs: a Jack among the four hand/crib cards whose suit matches the starter.
    for (k = 0; k < 4; k++) {
      if (ranks[k] === 11 && suits[k] === suits[4]) {
        score += 1;
        break;
      }
    }

    return score;
  }

  // Play scoring. `series` is the cards already down in the CURRENT series, not including
  // playedCard. Only the exact running count matters for 15 and 31 — subsets never do —
  // and hitting 31 does NOT suppress the pair or run the same card also makes.
  function scorePlayTotal(series, playedCard) {
    var n = series.length + 1;
    var i;

    var count = playedCard.value;
    for (i = 0; i < series.length; i++) count += series[i].value;

    function rankAt(k) {
      return k < series.length ? series[k].rank : playedCard.rank;
    }

    var score = 0;
    if (count === 15) score += 2;
    if (count === 31) score += 2;

    // Pairs. Find where the trailing block of equal ranks begins by scanning forward and
    // restarting at every rank change, then award 2 for each unordered pair inside it.
    var blockStart = 0;
    for (i = 1; i < n; i++) {
      if (rankAt(i) !== rankAt(i - 1)) blockStart = i;
    }
    for (var a = blockStart; a < n; a++) {
      for (var b = a + 1; b < n; b++) score += 2;
    }

    // Runs. Try every trailing window from the shortest legal one upward and remember the
    // last length that formed a run; only that longest window scores, and it scores its
    // own length. Sorting means the order the cards were laid in is irrelevant, and equal
    // ranks fail the strict +1 step, so a duplicate inside a window kills it.
    var best = 0;
    var runWindow = [];
    for (var L = 3; L <= n; L++) {
      var m = 0;
      for (var k = n - L; k < n; k++) {
        // insertion sort as we go, L <= 8
        var v = rankAt(k);
        var j = m - 1;
        while (j >= 0 && runWindow[j] > v) {
          runWindow[j + 1] = runWindow[j];
          j--;
        }
        runWindow[j + 1] = v;
        m++;
      }
      var consecutive = true;
      for (var p = 1; p < L; p++) {
        if (runWindow[p] !== runWindow[p - 1] + 1) { consecutive = false; break; }
      }
      if (consecutive) best = L;
    }
    score += best;

    return score;
  }

  root.Cribbage = root.Cribbage || {};
  root.Cribbage.ScoringNaive = {
    scoreHandTotal: scoreHandTotal,
    scorePlayTotal: scorePlayTotal
  };
})(typeof window !== 'undefined' ? window : globalThis);
