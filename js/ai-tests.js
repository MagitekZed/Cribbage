(function (root) {
  'use strict';

  // Cribbage.AITests.run(options) -> { passed, failed, results }
  // Driven by both tools/run-tests.js (Node) and tests.html (browser), so it must not
  // assume either environment. options: { games, verbose, log }
  //
  // The suite is about three things, in order of how much they matter:
  //
  //   1. THE OPPONENT DOES NOT CHEAT. testNoCheating puts a recording proxy in front
  //      of a real position and reads back every property the AI touched, then does
  //      it again with the forbidden properties replaced by getters that throw. An
  //      opponent that plays well by peeking is worthless and the bug hides for
  //      months, so this is the test the file exists for.
  //      testNoCheatingUnderRealPlay then does the same thing across WHOLE GAMES —
  //      every tier, both seats, every deal, every count — because a spot check at
  //      one position can only catch an unconditional peek, and a peek gated on the
  //      seat, the deal or the length of the series walks straight past it.
  //   2. It is always legal. Whatever a tier decides, the engine must accept it.
  //   3. It knows what it is doing: the crib sign, the exact hand EV, the pegging
  //      rules that are worth real points.

  // ---------------------------------------------------------------- assertions ---
  // Same shape as the Suite in js/tests.js and js/engine-tests.js; deliberately
  // duplicated so the suites stay independent of one another.

  function Suite(options) {
    this.options = options || {};
    this.log = this.options.log || function () {};
    this.passed = 0;
    this.failed = 0;
    this.results = [];
  }

  Suite.prototype.record = function (name, ok, expected, actual, detail) {
    var entry = {
      name: name,
      ok: !!ok,
      expected: expected,
      actual: actual,
      detail: detail || ''
    };
    this.results.push(entry);
    if (ok) {
      this.passed++;
      if (this.options.verbose) this.log('  PASS  ' + name);
    } else {
      this.failed++;
      this.log('  FAIL  ' + name +
        '\n          expected: ' + JSON.stringify(expected) +
        '\n          actual:   ' + JSON.stringify(actual) +
        (detail ? '\n          ' + detail : ''));
    }
    return entry;
  };

  Suite.prototype.eq = function (name, actual, expected, detail) {
    return this.record(name, actual === expected, expected, actual, detail);
  };

  Suite.prototype.ok = function (name, cond, detail) {
    return this.record(name, !!cond, true, !!cond, detail);
  };

  Suite.prototype.near = function (name, actual, expected, tol, detail) {
    var ok = Math.abs(actual - expected) <= tol;
    return this.record(name, ok, expected, actual, detail || ('tolerance ' + tol));
  };

  Suite.prototype.throws = function (name, fn, detail) {
    var threw = false;
    var message = '';
    try {
      fn();
    } catch (err) {
      threw = true;
      message = (err && err.message) || String(err);
    }
    return this.record(name, threw, 'throws', threw ? 'threw: ' + message : 'no throw', detail);
  };

  // ------------------------------------------------------------------ helpers ---

  var Cards = null;
  var Scoring = null;
  var Engine = null;
  var AI = null;

  // mulberry32, exactly as the engine suite has it: nothing in this file may reach
  // for Math.random, because one of the tests below proves the AI does not either.
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function names(cards) {
    return cards && cards.length ? Cards.cardNames(cards) : '(none)';
  }

  function hasId(cards, card) {
    for (var i = 0; i < cards.length; i++) {
      if (cards[i].id === card.id) return true;
    }
    return false;
  }

  function dealSix(rng) {
    return Cards.shuffle(Cards.makeDeck(), rng).slice(0, 6);
  }

  function canFollow(hand, room) {
    for (var i = 0; i < hand.length; i++) {
      if (hand[i].value <= room) return true;
    }
    return false;
  }

  // A snapshot-shaped plain object. The engine's own getState() is deep-frozen,
  // which a recording Proxy cannot wrap (a proxy may not lie about a frozen own
  // property), so the tests that need to watch the AI build their own.
  function fakeState(spec) {
    var seat = spec.seat === undefined ? 1 : spec.seat;
    return {
      phase: spec.phase || 'PLAY',
      dealer: spec.dealer === undefined ? 0 : spec.dealer,
      toMove: seat,
      scores: spec.scores || [0, 0],
      prevScores: [0, 0],
      hands: spec.hands || [[], []],
      showHands: spec.showHands || [[], []],
      crib: spec.crib || [],
      starter: spec.starter || null,
      deck: spec.deck || [],
      cardsRemaining: (spec.deck || []).length,
      discarded: [false, false],
      play: {
        count: spec.count || 0,
        series: spec.series || [],
        pile: spec.pile || [],
        lastPlayer: spec.lastPlayer === undefined ? null : spec.lastPlayer,
        goSaid: [false, false],
        toMove: seat
      },
      winner: null,
      skunk: 'none',
      targetScore: 121,
      handNumber: spec.handNumber === undefined ? 1 : spec.handNumber
    };
  }

  // A position for the play: `hand` belongs to seat 1, everything else is filled in
  // so the state is internally consistent.
  function playState(handStr, countAndSeries) {
    var hand = Cards.parseCards(handStr);
    var series = countAndSeries.series ? Cards.parseCards(countAndSeries.series) : [];
    var count = countAndSeries.count;
    if (count === undefined) count = Scoring.countValue(series);
    var pile = [];
    for (var i = 0; i < series.length; i++) {
      pile.push({ player: i % 2 === 0 ? 0 : 1, card: series[i] });
    }
    return {
      hand: hand,
      legal: hand.filter(function (c) { return count + c.value <= 31; }),
      state: fakeState({
        seat: 1,
        hands: [[], hand],
        series: series,
        count: count,
        pile: pile,
        starter: countAndSeries.starter ? Cards.parseCard(countAndSeries.starter) : null
      })
    };
  }

  function eachLevel(fn) {
    AI.LEVELS.forEach(fn);
  }

  // =========================================================================
  // 1. The lay-away
  // =========================================================================

  function testHandEV(S) {
    // Hand-derived value. Keep A♠ 2♥ 8♦ K♣ out of the six A♠ 2♥ 8♦ K♣ 4♠ 6♥, so
    // 46 starters remain. Working it out by hand, once:
    //   fifteens  the kept values are 1, 2, 8, 10 and none of their subsets makes
    //             15, so every fifteen must use the starter. Subsets summing to
    //             13, 12, 11, 10, 9, 8 exist in 1, 1, 2, 2, 1, 1 ways, which pays a
    //             starter of 2, 3, 4, 5, 6 and 7 exactly 2, 2, 4, 4, 2 and 2.
    //   pairs     a starting A, 2, 8 or K pairs for 2.
    //   runs      only a 3 makes one: A-2-3, for 3.
    //   flush     four different suits, never.
    //   nobs      no jack in the hand, never.
    // Multiply by how many of each rank are left (3 aces, 3 twos, 4 threes, 3 fours,
    // 4 fives, 3 sixes, 4 sevens, 3 eights, 3 kings, and nothing for 9 through Q):
    //   3*2 + 3*4 + 4*5 + 3*4 + 4*4 + 3*2 + 4*2 + 3*2 + 3*2
    //   =  6 +  12 +  20 +  12 +  16 +   6 +   8 +   6 +   6  = 92
    // 92 / 46 = exactly 2.
    var kept = Cards.parseCards('AS 2H 8D KC');
    var six = Cards.parseCards('AS 2H 8D KC 4S 6H');
    S.near('hand EV of A 2 8 K (from that six) is exactly 2', AI.handEV(kept, six), 2, 1e-12,
      'derived by hand in the comment above this assertion');

    // And an independent brute force, written differently: walk a fresh deck,
    // skip the six, average. If handEV ever starts sampling instead of enumerating,
    // this and the line above both break.
    var deck = Cards.makeDeck();
    var total = 0;
    var n = 0;
    for (var i = 0; i < deck.length; i++) {
      if (hasId(six, deck[i])) continue;
      total += Scoring.scoreHand(kept, deck[i], false).total;
      n++;
    }
    S.eq('the brute force sees 46 starters', n, 46);
    S.near('handEV matches an independent brute force', AI.handEV(kept, six), total / n, 1e-12);

    // A second position, brute-forced the same way, to be sure the first was not a
    // lucky round number: the perfect hand, whose EV is famously high.
    var perfect = Cards.parseCards('5S 5H 5D JC');
    var sixP = Cards.parseCards('5S 5H 5D JC 2H 9D');
    total = 0;
    n = 0;
    for (i = 0; i < deck.length; i++) {
      if (hasId(sixP, deck[i])) continue;
      total += Scoring.scoreHand(perfect, deck[i], false).total;
      n++;
    }
    S.near('handEV matches the brute force for 5 5 5 J', AI.handEV(perfect, sixP),
      total / n, 1e-12, 'EV ' + (total / n).toFixed(4));
    S.ok('5 5 5 J is worth more than 14 on average', AI.handEV(perfect, sixP) > 14);
  }

  /**
   * fastScore stands in for Scoring.scoreHand everywhere the AI needs a five-card
   * total and nothing else — which is every one of the forty thousand imaginary
   * hands and cribs a hard lay-away counts. It is a second implementation of the
   * rules, so it is a second place for them to be wrong, and a quiet disagreement
   * would not make the AI illegal or slow, only bad.
   *
   * The full space is C(52,4) x 48 starters x two crib flags, which is 25,989,600
   * positions; that was swept offline and matched exactly. Here it is a large random
   * sweep plus the cases that are easy to get wrong on purpose.
   */
  function testFastScore(S) {
    var rng = mulberry32(24680);
    var deck = Cards.makeDeck();
    var mismatches = 0;
    var detail = '';
    var scored = 0;
    var trials = 20000;
    for (var t = 0; t < trials; t++) {
      var shuffled = Cards.shuffle(deck, rng);
      var four = shuffled.slice(0, 4);
      var starter = shuffled[4];
      var isCrib = t % 2 === 0;
      var want = Scoring.scoreHand(four, starter, isCrib).total;
      var got = AI.fastScore(four, starter, isCrib);
      if (want > 0) scored++;
      if (want !== got) {
        mismatches++;
        if (!detail) {
          detail = names(four) + ' + ' + Cards.cardName(starter) + ' crib=' + isCrib +
            ': scoreHand ' + want + ', fastScore ' + got;
        }
      }
    }
    S.eq('fastScore agrees with scoring.js over ' + trials + ' random five-card deals',
      mismatches, 0, detail);
    S.ok('and the sweep was mostly positions that actually score', scored > trials * 0.8,
      scored + ' of ' + trials);

    // The rules a second implementation gets wrong.
    function check(name, fourStr, starterStr, isCrib) {
      var four = Cards.parseCards(fourStr);
      var starter = Cards.parseCard(starterStr);
      var want = Scoring.scoreHand(four, starter, isCrib).total;
      S.eq(name, AI.fastScore(four, starter, isCrib), want,
          fourStr + ' + ' + starterStr + (isCrib ? ' (crib)' : ' (hand)'));
    }
    // A four-card flush pays four in a hand and NOTHING in a crib — the single most
    // commonly mis-implemented rule in the game, and one a random sweep hits rarely.
    check('a four-card flush in a hand', '2S 5S 9S KS', '7H', false);
    check('the same four cards in a crib', '2S 5S 9S KS', '7H', true);
    check('a five-card flush in a crib', '2S 5S 9S KS', '7S', true);
    check('nobs', '2H 5C JS 9D', '7S', false);
    check('nobs in a crib', '2H 5C JS 9D', '7S', true);
    check('his nob does not double as a jack pair', 'JS JH 2C 3D', '7S', false);
    check('double pair royal', '5S 5H 5D 5C', 'TS', false);
    check('the twenty-nine', '5S 5H 5D JC', '5C', false);
    check('a run of five with a duplicate', '3S 4H 5D 6C', '4C', false);
    check('a triple run', '4S 4H 4D 5C', '6C', false);
    check('a double double run', '4S 4H 5D 5C', '6C', false);
    check('nothing at all', '2S 4H 9D KC', '7S', false);
    check('fifteens only', '5S TH 9D 6C', 'KS', false);
  }

  function testCribSign(S) {
    // The structural half: whatever the crib term is, it is ADDED for its own crib
    // and SUBTRACTED for the enemy's. Checked on every candidate of a random hand,
    // at both levels that use a crib term at all.
    var rng = mulberry32(20260803);
    var mismatches = 0;
    var checked = 0;
    for (var h = 0; h < 12; h++) {
      var hand = dealSix(rng);
      ['normal', 'hard'].forEach(function (level) {
        [true, false].forEach(function (own) {
          var ranked = AI.evaluateDiscards(hand, own, level, mulberry32(7 + h), 300);
          for (var i = 0; i < ranked.length; i++) {
            var c = ranked[i];
            var want = c.handEV + (own ? 1 : -1) * c.cribEV;
            checked++;
            if (Math.abs(c.score - want) > 1e-9) mismatches++;
          }
        });
      });
    }
    S.eq('score is handEV + cribEV for its own crib and handEV - cribEV for theirs',
      mismatches, 0, checked + ' candidates checked');

    // The behavioural half: a hand where the right throw plainly depends on whose
    // crib it is. A♠ 2♥ 3♦ 5♣ 5♥ 10♠ — 5-5 is the best pair of cards that can go
    // into a crib, and the worst thing to hand the other player.
    var probe = Cards.parseCards('AS 2H 3D 5C 5H TS');
    ['normal', 'hard'].forEach(function (level) {
      var mine = AI.evaluateDiscards(probe, true, level, mulberry32(31), 600)[0];
      var theirs = AI.evaluateDiscards(probe, false, level, mulberry32(31), 600)[0];
      S.ok(level + ' throws 5-5 into its OWN crib',
        mine.discard[0].rank === 5 && mine.discard[1].rank === 5, names(mine.discard));
      S.ok(level + ' keeps the fives out of the ENEMY crib',
        theirs.discard[0].rank !== 5 && theirs.discard[1].rank !== 5, names(theirs.discard));
      S.ok(level + ': the choice flips with isOwnCrib',
        mine.discard[0].id !== theirs.discard[0].id ||
        mine.discard[1].id !== theirs.discard[1].id,
        names(mine.discard) + ' vs ' + names(theirs.discard));
      S.ok(level + ': the own-crib throw is the more generous of the two',
        mine.cribEV > theirs.cribEV,
        mine.cribEV.toFixed(2) + ' vs ' + theirs.cribEV.toFixed(2));
    });

    // The sign inverted would show up as an opponent that feeds the enemy crib, so
    // check the whole population rather than one hand: over many random hands the
    // enemy's crib must get the poorer cards on average.
    var rng2 = mulberry32(99);
    var ownTotal = 0;
    var foeTotal = 0;
    var hands = 40;
    for (var k = 0; k < hands; k++) {
      var six = dealSix(rng2);
      ownTotal += AI.evaluateDiscards(six, true, 'normal')[0].cribEV;
      foeTotal += AI.evaluateDiscards(six, false, 'normal')[0].cribEV;
    }
    S.ok('across ' + hands + ' hands, normal gives its own crib more than the enemy',
      ownTotal / hands > foeTotal / hands + 0.5,
      'own ' + (ownTotal / hands).toFixed(2) + ' vs enemy ' + (foeTotal / hands).toFixed(2));
  }

  function testCribHeuristic(S) {
    function crib(str) {
      var c = Cards.parseCards(str);
      return AI.cribHeuristic(c[0], c[1]);
    }
    // The orderings the heuristic exists to encode.
    S.ok('5-5 is the best pair in the table',
      crib('5S 5H') > crib('7S 8H') && crib('5S 5H') > crib('KS KH'));
    S.ok('a five with a ten-card beats a wide unrelated pair', crib('5S TH') > crib('KS 2H'));
    S.ok('two cards making fifteen beat two that make nothing', crib('7S 8H') > crib('9S KH'));
    S.ok('touching cards beat a wide gap', crib('6S 7H') > crib('6S JH'));
    S.ok('a pair beats no pair', crib('8S 8H') > crib('8S JH'));
    S.ok('a jack is worth a little more than a plain ten-card',
      crib('4S JH') > crib('4S TH'));
    S.ok('the worst throws sit near the bottom of the published range',
      crib('KS 2H') < 4.6 && crib('9S KH') < 4.6);
    S.ok('5-5 sits near the top of the published range', crib('5S 5H') > 8.5);

    // The Monte Carlo estimate is the ground truth the heuristic is standing in for,
    // so the two must at least agree about which throws are good.
    var rng = mulberry32(4242);
    var pairs = ['5S 5H', '7S 8H', 'KS KH', 'KS 2H', '2S 3H', '9S KH', '5S TH', 'AS 4H'];
    var worst = 0;
    for (var i = 0; i < pairs.length; i++) {
      var cs = Cards.parseCards(pairs[i]);
      // Six cards must be off the table for evaluateDiscards, so pad with cards that
      // cannot collide, then read the candidate that throws exactly this pair.
      var mc = monteCarloCrib(cs, rng, 4000);
      var diff = Math.abs(mc - AI.cribHeuristic(cs[0], cs[1]));
      if (diff > worst) worst = diff;
    }
    S.ok('every heuristic value is within 1.5 of a 4000-sample simulation',
      worst <= 1.5, 'worst gap ' + worst.toFixed(2));
  }

  // An independent crib simulator: nothing but scoreHand, so it does not share a
  // line of code with the AI's own sampler.
  function monteCarloCrib(pair, rng, samples) {
    var pool = [];
    var deck = Cards.makeDeck();
    for (var i = 0; i < deck.length; i++) {
      if (!hasId(pair, deck[i])) pool.push(deck[i]);
    }
    var total = 0;
    for (var s = 0; s < samples; s++) {
      var shuffled = Cards.shuffle(pool, rng);
      total += Scoring.scoreHand([pair[0], pair[1], shuffled[0], shuffled[1]],
        shuffled[2], true).total;
    }
    return total / samples;
  }

  function testDiscardIsLegal(S, hands) {
    var rng = mulberry32(1337);
    var bad = 0;
    var detail = '';
    var checked = 0;
    for (var h = 0; h < hands; h++) {
      var six = dealSix(rng);
      var own = h % 2 === 0;
      eachLevel(function (level) {
        var ai = AI.create(level, { rng: mulberry32(500 + h) });
        var pick = ai.chooseDiscard(six.slice(), own, fakeState({ phase: 'DISCARD', seat: 0 }));
        checked++;
        var ok = pick && pick.length === 2 &&
          pick[0].id !== pick[1].id &&
          hasId(six, pick[0]) && hasId(six, pick[1]);
        if (!ok) {
          bad++;
          if (!detail) detail = level + ' threw ' + names(pick || []) + ' from ' + names(six);
        }
      });
    }
    S.eq('every tier throws exactly 2 distinct cards it actually holds (' + checked +
      ' decisions)', bad, 0, detail);
  }

  function testEasyIsWeakButNotSilly(S) {
    var rng = mulberry32(24680);
    var fiveToEnemy = 0;
    var unplayable = 0;
    var optimal = 0;
    var hands = 120;
    for (var h = 0; h < hands; h++) {
      var six = dealSix(rng);
      var ai = AI.create('easy', { rng: mulberry32(900 + h) });
      var pick = ai.chooseDiscard(six.slice(), false, fakeState({ phase: 'DISCARD', seat: 0 }));
      if (pick[0].rank === 5 || pick[1].rank === 5) {
        // Only forgivable when the hand leaves no five-free throw at all.
        var free = 0;
        for (var i = 0; i < 6; i++) {
          for (var j = i + 1; j < 6; j++) {
            if (six[i].rank !== 5 && six[j].rank !== 5) free++;
          }
        }
        if (free > 0) fiveToEnemy++;
      }
      var kept = six.filter(function (c) { return !hasId(pick, c); });
      var low = kept.filter(function (c) { return c.value < 10; }).length;
      if (low === 0) {
        var anyLow = six.filter(function (c) { return c.value < 10; }).length;
        if (anyLow >= 1) unplayable++;
      }
      var best = AI.evaluateDiscards(six, false, 'easy')[0];
      if (best.discard[0].id === pick[0].id && best.discard[1].id === pick[1].id) optimal++;
    }
    S.eq('easy never hands a five to the enemy crib when it has a choice', fiveToEnemy, 0);
    S.eq('easy never keeps a hand of nothing but ten-cards', unplayable, 0);
    S.ok('easy usually does NOT find the best lay-away — it is meant to be beatable',
      optimal < hands * 0.25, optimal + '/' + hands + ' were optimal');

    // The calibration, pinned. Easy draws from the second through sixth ranked
    // lay-away, which keeps about 6.1 points of hand against the best keep's 8.4.
    // Both ends of this band matter and neither is arbitrary: above it easy stops
    // being beatable, and below it easy stops being a cribbage player. It used to sit
    // at 5.0, which is three and a half points of hand thrown away every single deal
    // — nobody plays that badly, and it made the tier useless to learn against.
    var evRng = mulberry32(13579);
    var easyEV = 0;
    var bestEV = 0;
    var deals = 150;
    for (var d = 0; d < deals; d++) {
      var six2 = dealSix(evRng);
      var ai2 = AI.create('easy', { rng: mulberry32(400 + d) });
      var chose = ai2.chooseDiscard(six2.slice(), d % 2 === 0, fakeState({ phase: 'DISCARD' }));
      var keeps = six2.filter(function (c) { return !hasId(chose, c); });
      easyEV += AI.handEV(keeps, six2);
      bestEV += AI.evaluateDiscards(six2, d % 2 === 0, 'easy')[0].handEV;
    }
    easyEV /= deals;
    bestEV /= deals;
    S.ok('easy keeps a hand a casual player would recognise, not a nonsense one',
      easyEV > 5.6 && easyEV < 7.0,
      easyEV.toFixed(2) + ' points of hand a deal (the best keep averages ' +
      bestEV.toFixed(2) + ')');
    S.ok('and it is still clearly worse than taking the best keep',
      bestEV - easyEV > 1.5, (bestEV - easyEV).toFixed(2) + ' points a deal behind');
  }

  function testTierStrength(S) {
    // Not a tournament — that lives outside the suite — but the ordering that
    // matters has to hold: on the same hands, normal and hard keep more than easy.
    var rng = mulberry32(555);
    var totals = { easy: 0, normal: 0, hard: 0 };
    var hands = 30;
    for (var h = 0; h < hands; h++) {
      var six = dealSix(rng);
      eachLevel(function (level) {
        var ai = AI.create(level, { rng: mulberry32(4000 + h) });
        var pick = ai.chooseDiscard(six.slice(), true, fakeState({ phase: 'DISCARD', seat: 0 }));
        var kept = six.filter(function (c) { return !hasId(pick, c); });
        totals[level] += AI.handEV(kept, six);
      });
    }
    S.ok('normal keeps a better hand than easy on average',
      totals.normal > totals.easy,
      (totals.normal / hands).toFixed(2) + ' vs ' + (totals.easy / hands).toFixed(2));
    S.ok('hard keeps a better hand than easy on average',
      totals.hard > totals.easy,
      (totals.hard / hands).toFixed(2) + ' vs ' + (totals.easy / hands).toFixed(2));
  }

  // =========================================================================
  // 2. The play
  // =========================================================================

  function testPlayIsLegal(S, hands) {
    var rng = mulberry32(8642);
    var illegal = 0;
    var notHeld = 0;
    var checked = 0;
    var detail = '';
    for (var h = 0; h < hands; h++) {
      // Build a genuine mid-series position: four cards, a random count, a random
      // series under it.
      var shuffled = Cards.shuffle(Cards.makeDeck(), rng);
      var hand = shuffled.slice(0, 4);
      var seriesLen = Math.floor(rng() * 3);
      var series = [];
      var count = 0;
      for (var i = 0; i < seriesLen; i++) {
        var c = shuffled[4 + i];
        if (count + c.value > 31) break;
        series.push(c);
        count += c.value;
      }
      var legal = hand.filter(function (card) { return count + card.value <= 31; });
      if (!legal.length) continue;
      var pile = [];
      for (i = 0; i < series.length; i++) pile.push({ player: 0, card: series[i] });
      var state = fakeState({
        seat: 1,
        hands: [[], hand],
        series: series,
        count: count,
        pile: pile,
        starter: shuffled[10]
      });
      eachLevel(function (level) {
        var ai = AI.create(level, { rng: mulberry32(70000 + h) });
        var card = ai.choosePlay(legal.slice(), state);
        checked++;
        if (!card || count + card.value > 31) {
          illegal++;
          if (!detail) {
            detail = level + ' played ' + (card ? Cards.cardName(card) : 'nothing') +
              ' at count ' + count;
          }
        } else if (!hasId(hand, card)) {
          notHeld++;
          if (!detail) detail = level + ' played ' + Cards.cardName(card) + ', not in hand';
        }
      });
    }
    S.eq('every tier plays a card within 31 - count (' + checked + ' decisions)', illegal, 0,
      detail);
    S.eq('every tier plays a card it actually holds', notHeld, 0, detail);
  }

  function testNeverLeadsAFive(S) {
    var led = { normal: 0, hard: 0 };
    var detail = { normal: '', hard: '' };
    var checked = 0;
    var rng = mulberry32(11235);
    for (var h = 0; h < 300; h++) {
      var shuffled = Cards.shuffle(Cards.makeDeck(), rng);
      var hand = shuffled.slice(0, 4);
      var fives = hand.filter(function (c) { return c.rank === 5; }).length;
      if (!fives || fives === hand.length) continue;
      var state = fakeState({ seat: 1, hands: [[], hand], series: [], count: 0 });
      checked++;
      ['normal', 'hard'].forEach(function (level) {
        var card = AI.create(level, { rng: mulberry32(3) }).choosePlay(hand.slice(), state);
        if (card.rank === 5) {
          led[level]++;
          if (!detail[level]) {
            detail[level] = 'led ' + Cards.cardName(card) + ' from ' + names(hand);
          }
        }
      });
    }
    S.ok('the sample found hands with a five and an alternative', checked > 30,
      checked + ' such hands');
    S.eq('normal never leads a five when it holds anything else', led.normal, 0,
      detail.normal);
    S.eq('hard never leads a five either', led.hard, 0, detail.hard);

    // The case that proves the rule is a rule: a hand where the five wins on the
    // weights and must lose to the filter anyway. A five leaves the worst count in
    // the game, but it is also half a pair — the bait the tactics like — while both
    // kings are lone ten-cards that leave 21 wanting only a ten. Weighed up, 5♠
    // comes out ahead of either king. The five rule is a filter, not a weight, so it
    // never gets the chance.
    var ugly = Cards.parseCards('5S 5H KD QC');
    ['normal', 'hard'].forEach(function (level) {
      var card = AI.create(level, { rng: mulberry32(3) })
        .choosePlay(ugly.slice(), fakeState({ seat: 1, hands: [[], ugly], count: 0 }));
      S.ok(level + ' leads a ten-card from 5-5-K-Q even though the five scores better',
        card.value === 10,
        'led ' + Cards.cardName(card) + ' — the pair of fives is the tempting lead here');
    });
    var kings = Cards.parseCards('5S KH KD KC');
    ['normal', 'hard'].forEach(function (level) {
      var card = AI.create(level, { rng: mulberry32(3) })
        .choosePlay(kings.slice(), fakeState({ seat: 1, hands: [[], kings], count: 0 }));
      S.ok(level + ' leads a king from 5-K-K-K rather than the five', card.rank === 13,
        'led ' + Cards.cardName(card));
    });

    // ...but both must still play one when a five is all there is.
    var allFives = Cards.parseCards('5S 5H 5D 5C');
    ['normal', 'hard'].forEach(function (level) {
      var only = AI.create(level, { rng: mulberry32(3) })
        .choosePlay(allFives.slice(), fakeState({ seat: 1, hands: [[], allFives] }));
      S.eq(level + ' with nothing but fives leads one rather than freezing', only.rank, 5);
    });
  }

  /**
   * Leading FROM a pair, which is the other half of what to lead.
   *
   * If they pair the lead they take 2 and the third card of the rank — still in hand
   * — takes 6 back. Offering that is a standard club play, and the tactics used to
   * have the term BACKWARDS: holding the mate was a penalty, on the reasoning that
   * leading half a pair spends it. Nothing else in this file noticed, because the
   * card it led instead was perfectly legal and perfectly sensible-looking. It cost
   * the normal tier two and a half points of win rate against an identical copy of
   * itself with the sign corrected.
   *
   * So the sign is pinned behaviourally, and pinned so that card order cannot
   * rescue it: every one of the 24 orderings of 2-4-4-K must lead a four. On the old
   * sign none of them did — the four scored 0.9 - 1 and the two scored 0.9, in every
   * ordering. The control says the four has no such edge on its own: strip the mate
   * out and the two and the four are judged exactly equal, so the ordering decides.
   */
  function permutations(cards) {
    if (cards.length <= 1) return [cards.slice()];
    var out = [];
    cards.forEach(function (card, i) {
      permutations(cards.slice(0, i).concat(cards.slice(i + 1))).forEach(function (rest) {
        out.push([card].concat(rest));
      });
    });
    return out;
  }

  function leadsOver(level, handStr) {
    var tally = {};
    permutations(Cards.parseCards(handStr)).forEach(function (hand) {
      var card = AI.create(level, { rng: mulberry32(7) })
        .choosePlay(hand.slice(), fakeState({ seat: 1, hands: [[], hand], count: 0 }));
      var key = String(card.rank);
      tally[key] = (tally[key] || 0) + 1;
    });
    return tally;
  }

  function testLeadsFromAPair(S) {
    // 2-4-4-K. The two and the four are equally safe leads — no single card reaches
    // fifteen or thirty-one from either — so the mate is the only thing between them.
    ['normal', 'hard'].forEach(function (level) {
      var tally = leadsOver(level, '2D 4S 4H KC');
      S.eq(level + ' leads from its pair in all 24 orderings of 2-4-4-K',
        tally['4'] || 0, 24, 'by rank: ' + JSON.stringify(tally));
    });

    // The control. Swap one four for a nine and the remaining four stops being
    // special: normal now splits its 24 orderings between the two and the four,
    // which is what "judged equal" looks like from outside.
    var control = leadsOver('normal', '2D 4S 9H KC');
    S.ok('without the mate the four has no edge over the two at all',
      (control['4'] || 0) > 0 && (control['2'] || 0) > 0,
      'by rank: ' + JSON.stringify(control));
    S.eq('and the nine and the king are never led over either of them',
      (control['9'] || 0) + (control['13'] || 0), 0, 'by rank: ' + JSON.stringify(control));

    // The pair bonus is a tie-breaker, not a licence: it must never outweigh the
    // count a lead leaves behind. A pair of nines leaves 22, one ten-card short of
    // thirty-one; the lone three leaves a count nothing reaches anything from.
    ['normal', 'hard'].forEach(function (level) {
      var tally = leadsOver(level, '3D 9S 9H KC');
      S.eq(level + ' still leads the safe three over a pair of nines',
        tally['3'] || 0, 24, 'by rank: ' + JSON.stringify(tally));
    });
  }

  function testTakesThirtyOne(S) {
    var positions = [
      { hand: '5S 3H 2D KC', count: 26, series: 'KH TS 6D', want: 5 },
      { hand: '9S 4H QD', count: 27, series: 'TS 8H 9D', want: 4 },
      { hand: 'AS 7H KD', count: 30, series: 'TS TH TD', want: 1 },
      { hand: '2S 8H 3D', count: 23, series: 'JS 9H 4D', want: 8 }
    ];
    positions.forEach(function (p) {
      var built = playState(p.hand, { count: p.count, series: p.series });
      ['normal', 'hard'].forEach(function (level) {
        var ai = AI.create(level, { rng: mulberry32(17) });
        var card = ai.choosePlay(built.legal.slice(), built.state);
        S.eq(level + ' takes thirty-one at count ' + p.count + ' from ' + p.hand,
          card.rank, p.want, 'played ' + Cards.cardName(card));
        S.eq(level + ' really did reach 31 there', p.count + card.value, 31);
      });
    });

    // The position that proves it is a RULE and not a by-product of counting points.
    // At 21 with 4-9-8 behind, the jack makes thirty-one for two and the seven makes
    // a run of three for three. Weighing the two would take the seven; the rule says
    // take the thirty-one, and the rule is what is being tested.
    var built = playState('JC 7H', { count: 21, series: '4S 9D 8H' });
    S.eq('the jack really does pay only two',
      Scoring.scorePlay(Cards.parseCards('4S 9D 8H'), Cards.parseCard('JC')).points, 2);
    S.eq('the seven really does pay three',
      Scoring.scorePlay(Cards.parseCards('4S 9D 8H'), Cards.parseCard('7H')).points, 3);
    ['normal', 'hard'].forEach(function (level) {
      var card = AI.create(level, { rng: mulberry32(17) })
        .choosePlay(built.legal.slice(), built.state);
      S.eq(level + ' takes thirty-one even when a run would score more',
        Cards.cardName(card), 'JC');
    });
  }

  // A count nothing can reach fifteen or thirty-one from is the definition of safe,
  // computed here rather than borrowed from the AI so the test does not grade the
  // implementation against itself.
  function isSafeCount(after) {
    if (after >= 31) return true;
    var toFifteen = 15 - after;
    var toThirtyOne = 31 - after;
    var reachable = function (need) { return need >= 1 && need <= 10; };
    return !reachable(toFifteen) && !reachable(toThirtyOne);
  }

  function testAvoidsFiveAndTwentyOne(S) {
    // A hand-built case first, so a failure is readable.
    var built = playState('5S 3D 9C', { count: 16, series: 'TS 6H' });
    var card = AI.create('normal', { rng: mulberry32(5) })
      .choosePlay(built.legal.slice(), built.state);
    S.ok('normal does not leave the count at 21 when 19 is available',
      16 + card.value !== 21, 'played ' + Cards.cardName(card));

    built = playState('3D 8C QH', { count: 2, series: '2S' });
    card = AI.create('normal', { rng: mulberry32(5) }).choosePlay(built.legal.slice(), built.state);
    S.ok('normal does not leave the count at 5 when it has another card',
      2 + card.value !== 5, 'played ' + Cards.cardName(card));

    // Then at volume, over random positions that are unambiguous: one option leaves
    // 5 or 21, another leaves a count no single card can score on, and NOTHING on
    // offer pegs any points — so there is no excuse for the dangerous card.
    var rng = mulberry32(24601);
    var trials = 0;
    var bad = 0;
    var detail = '';
    for (var h = 0; h < 4000 && trials < 60; h++) {
      var shuffled = Cards.shuffle(Cards.makeDeck(), rng);
      var hand = shuffled.slice(0, 4);
      var series = [shuffled[4]];
      var count = series[0].value;
      if (rng() < 0.5 && count + shuffled[5].value <= 20) {
        series.push(shuffled[5]);
        count += shuffled[5].value;
      }
      var legal = hand.filter(function (c) { return count + c.value <= 31; });
      if (legal.length < 2) continue;

      var scoresSomething = false;
      var dangerous = [];
      var safe = [];
      for (var i = 0; i < legal.length; i++) {
        if (Scoring.scorePlay(series, legal[i]).points > 0) scoresSomething = true;
        var after = count + legal[i].value;
        if (after === 5 || after === 21) dangerous.push(legal[i]);
        else if (isSafeCount(after)) safe.push(legal[i]);
      }
      if (scoresSomething || !dangerous.length || !safe.length) continue;

      var pile = [];
      for (i = 0; i < series.length; i++) pile.push({ player: 0, card: series[i] });
      var state = fakeState({
        seat: 1, hands: [[], hand], series: series, count: count, pile: pile
      });
      var chosen = AI.create('normal', { rng: mulberry32(9) }).choosePlay(legal.slice(), state);
      trials++;
      if (hasId(dangerous, chosen)) {
        bad++;
        if (!detail) {
          detail = 'count ' + count + ' series ' + names(series) + ' hand ' + names(hand) +
            ' -> ' + Cards.cardName(chosen);
        }
      }
    }
    S.ok('the sweep found enough unambiguous positions', trials >= 30, trials + ' positions');
    S.eq('normal never leaves the count at 5 or 21 with a safe alternative and no points',
      bad, 0, detail);
  }

  function testTakesPointsWhenOffered(S) {
    // Fifteen-two is on the table and the alternatives are worthless.
    var built = playState('5S 3D 9C', { count: 10, series: 'TS' });
    ['normal', 'hard'].forEach(function (level) {
      var card = AI.create(level, { rng: mulberry32(2) })
        .choosePlay(built.legal.slice(), built.state);
      S.eq(level + ' takes fifteen-two when it is there', Cards.cardName(card), '5S');
    });
    // Easy is allowed to be bad, but not to walk past free points.
    var card = AI.create('easy', { rng: mulberry32(2) })
      .choosePlay(built.legal.slice(), built.state);
    S.eq('easy takes the obvious fifteen too', Cards.cardName(card), '5S');

    // Two points on the table beat any positional worry: pairing here leaves the
    // count at 30, which the danger table dislikes, and it is still correct.
    built = playState('7S 4D 2C', { count: 23, series: 'KS 6H 7H' });
    var normal = AI.create('normal', { rng: mulberry32(2) })
      .choosePlay(built.legal.slice(), built.state);
    S.eq('normal pairs for two rather than playing safe', Cards.cardName(normal), '7S');

    // And it counts runs properly rather than reaching for the pair: 6-7-8-9 is
    // four points and a pair of sevens is two.
    built = playState('7S 4D 9C', { count: 21, series: '8S 6H 7H' });
    normal = AI.create('normal', { rng: mulberry32(2) })
      .choosePlay(built.legal.slice(), built.state);
    S.eq('normal takes the run of four over the pair', Cards.cardName(normal), '9C',
      'scorePlay pays 4 for 6-7-8-9 and 2 for the sevens');
  }

  function testHardSearchIsSharperThanTheTable(S) {
    // The one-ply search must actually be doing something, and the cleanest proof is
    // a position where the danger table is simply wrong. Seat 1 has shown all four
    // of its cards, so there is nobody left to punish a count of 21 — and seat 0
    // would rather keep the four than the nine for the series it has to play alone.
    // Normal cannot see that; it only knows that 21 is a bad number.
    var hand = Cards.parseCards('9C 4H');
    var series = Cards.parseCards('KS 2H');
    var pile = [
      // an earlier series, then the current one
      { player: 1, card: Cards.parseCard('JD') },
      { player: 0, card: Cards.parseCard('QC') },
      { player: 1, card: Cards.parseCard('9S') },
      { player: 1, card: Cards.parseCard('8D') },
      { player: 1, card: series[0] },
      { player: 0, card: series[1] }
    ];
    var state = fakeState({
      seat: 0, hands: [hand, []], series: series, count: 12, pile: pile,
      starter: Cards.parseCard('5D')
    });
    // Seat 1 has played J, 9, 8, K — its whole hand. Seat 0 has played Q and 2 and
    // holds two, which is the position the AI has to work out for itself.
    var legal = hand.slice();
    S.eq('nothing on offer scores, so only the count is at stake',
      Scoring.scorePlay(series, hand[0]).points + Scoring.scorePlay(series, hand[1]).points, 0);
    var normal = AI.create('normal', { rng: mulberry32(1) }).choosePlay(legal.slice(), state);
    S.eq('normal follows the table and refuses to leave 21', Cards.cardName(normal), '4H');
    var hard = AI.create('hard', { rng: mulberry32(1) }).choosePlay(legal.slice(), state);
    S.eq('hard counts the other hand out and keeps the four back',
      Cards.cardName(hard), '9C',
      'seat 1 has played all four of its cards, so 21 cannot be punished');
  }

  // =========================================================================
  // 3. Determinism
  // =========================================================================

  function testDeterminism(S) {
    var rng = mulberry32(31415);
    var discardDiffs = 0;
    var playDiffs = 0;
    for (var h = 0; h < 10; h++) {
      var six = dealSix(rng);
      var state = fakeState({ phase: 'DISCARD', seat: 0 });
      eachLevel(function (level) {
        var a = AI.create(level, { rng: mulberry32(2718 + h) })
          .chooseDiscard(six.slice(), h % 2 === 0, state);
        var b = AI.create(level, { rng: mulberry32(2718 + h) })
          .chooseDiscard(six.slice(), h % 2 === 0, state);
        if (a[0].id !== b[0].id || a[1].id !== b[1].id) discardDiffs++;
      });

      var hand = six.slice(0, 4);
      var playState2 = fakeState({ seat: 1, hands: [[], hand], series: [], count: 0 });
      eachLevel(function (level) {
        var a = AI.create(level, { rng: mulberry32(161 + h) })
          .choosePlay(hand.slice(), playState2);
        var b = AI.create(level, { rng: mulberry32(161 + h) })
          .choosePlay(hand.slice(), playState2);
        if (a.id !== b.id) playDiffs++;
      });
    }
    S.eq('the same seed and position always produce the same lay-away', discardDiffs, 0);
    S.eq('the same seed and position always produce the same card', playDiffs, 0);

    // Seeding is what makes that true, so a different seed must be able to differ:
    // if easy always agreed with itself regardless of seed, the rng would be dead.
    var six2 = dealSix(mulberry32(777));
    var varied = false;
    var first = AI.create('easy', { rng: mulberry32(1) })
      .chooseDiscard(six2.slice(), true, fakeState({ phase: 'DISCARD' }));
    for (var s = 2; s < 40 && !varied; s++) {
      var other = AI.create('easy', { rng: mulberry32(s) })
        .chooseDiscard(six2.slice(), true, fakeState({ phase: 'DISCARD' }));
      if (other[0].id !== first[0].id || other[1].id !== first[1].id) varied = true;
    }
    S.ok('easy actually uses the rng it was given', varied);

    // And nothing may reach for Math.random behind the injected rng's back.
    var realRandom = Math.random;
    var reached = 0;
    Math.random = function () {
      reached++;
      return 0.5;
    };
    try {
      var six3 = dealSix(mulberry32(5150));
      eachLevel(function (level) {
        var ai = AI.create(level, { rng: mulberry32(11) });
        var pick = ai.chooseDiscard(six3.slice(), true, fakeState({ phase: 'DISCARD' }));
        var kept = six3.filter(function (c) { return !hasId(pick, c); });
        ai.choosePlay(kept.slice(), fakeState({ seat: 1, hands: [[], kept] }));
      });
      // create() without an rng must seed itself without Math.random either.
      AI.create('hard').chooseDiscard(six3.slice(), true, fakeState({ phase: 'DISCARD' }));
    } finally {
      Math.random = realRandom;
    }
    S.eq('no tier ever calls Math.random', reached, 0,
      'an unseeded rng cannot be replayed, so a tournament could not be reproduced');
  }

  // =========================================================================
  // 4. NO CHEATING — the test this file exists for
  // =========================================================================

  // Every property the AI touches, as a dotted path. Cards are handed back whole
  // rather than wrapped: they are the values being passed around, and wrapping them
  // would say nothing about which fields of the STATE were read.
  function watch(target, path, log) {
    return new Proxy(target, {
      get: function (t, prop) {
        if (typeof prop === 'symbol') return t[prop];
        var full = path ? path + '.' + String(prop) : String(prop);
        log.push(full);
        var v = t[prop];
        if (v && typeof v === 'object' && typeof v.id !== 'number' &&
          !(v instanceof Function)) {
          return watch(v, full, log);
        }
        return v;
      },
      // Object.keys() or a JSON.stringify() of the snapshot would sweep up
      // everything without a single get trap naming a forbidden field, so the
      // enumeration itself counts as a read.
      ownKeys: function (t) {
        log.push((path ? path + '.' : '') + '(enumerated)');
        return Reflect.ownKeys(t);
      }
    });
  }

  // The properties of a snapshot a player in `seat` cannot see. showHands is on the
  // list because the engine fills it in at the cut, and showHands[other] is the
  // other player's whole hand.
  function forbiddenPaths(seat) {
    var other = 1 - seat;
    return ['crib', 'deck', 'cardsRemaining', 'showHands',
      'hands.' + other, 'hands.(enumerated)'];
  }

  var ALLOWED_TOP_LEVEL = ['toMove', 'dealer', 'handNumber', 'starter', 'play', 'hands',
    'scores', 'targetScore', 'phase'];

  // The allowlist above is on TOP-LEVEL keys, so anything reached through `play`
  // would get in without a second look — and `play` is where the other seat's spoken
  // gos live. The count, the current series and the pile of played cards are on the
  // table for anyone to see; goSaid and lastPlayer are not on this list, because the
  // AI is meant to touch nothing of the other seat's at all, not even the things
  // they said out loud.
  var PLAY_ALLOWED = ['play.count', 'play.series', 'play.pile', 'play.(enumerated)'];

  // Everything `reads` contains that a player in `seat` had no business seeing.
  function offencesIn(reads, seat) {
    var banned = forbiddenPaths(seat);
    return reads.filter(function (p) {
      for (var i = 0; i < banned.length; i++) {
        if (p === banned[i] || p.indexOf(banned[i] + '.') === 0) return true;
      }
      return false;
    });
  }

  // Top-level keys read that nobody agreed to.
  function offListTopLevel(reads) {
    var out = [];
    reads.forEach(function (p) {
      var top = p.split('.')[0];
      if (ALLOWED_TOP_LEVEL.indexOf(top) < 0 && out.indexOf(top) < 0) out.push(top);
    });
    return out;
  }

  // Paths under `play` read that nobody agreed to.
  function offListUnderPlay(reads) {
    var out = [];
    reads.forEach(function (p) {
      if (p.indexOf('play.') !== 0 || out.indexOf(p) >= 0) return;
      for (var i = 0; i < PLAY_ALLOWED.length; i++) {
        if (p === PLAY_ALLOWED[i] || p.indexOf(PLAY_ALLOWED[i] + '.') === 0) return;
      }
      out.push(p);
    });
    return out;
  }

  /**
   * thaw(snapshot) -> the same snapshot built out of plain, mutable objects.
   *
   * The engine's getState() is deep-frozen, and a Proxy is not allowed to hand back
   * anything but the frozen value for a non-configurable, non-writable own property
   * — so a recorder cannot simply be put in front of a real snapshot. This rebuilds
   * one that a recorder CAN wrap, stopping at cards (anything with a numeric id),
   * which are passed through by identity: they are the values being moved around,
   * not fields of the state, and the AI is expected to hand the very same objects
   * back to the engine.
   */
  function thaw(value) {
    if (!value || typeof value !== 'object') return value;
    if (typeof value.id === 'number') return value;
    if (Array.isArray(value)) {
      var arr = [];
      for (var i = 0; i < value.length; i++) arr.push(thaw(value[i]));
      return arr;
    }
    var out = {};
    Object.keys(value).forEach(function (k) { out[k] = thaw(value[k]); });
    return out;
  }

  function testNoCheating(S) {
    // A real, fully-populated position: the human's hand, the crib, the rest of the
    // deck and both show hands are all sitting in the snapshot, exactly as they are
    // in the live game. If the AI reads any of them, it shows up below.
    var deck = Cards.shuffle(Cards.makeDeck(), mulberry32(60607));
    var seat = 1;
    var mine = deck.slice(0, 6);
    var theirs = deck.slice(6, 12);
    var starter = deck[12];

    var reads = [];
    var discardState = watch(fakeState({
      phase: 'DISCARD',
      seat: seat,
      hands: [theirs, mine],
      deck: deck.slice(12),
      crib: [],
      starter: null
    }), '', reads);

    eachLevel(function (level) {
      var ai = AI.create(level, { rng: mulberry32(808) });
      ai.chooseDiscard(mine.slice(), true, discardState);
    });

    var playReads = [];
    var keep = mine.slice(0, 4);
    var theirKeep = theirs.slice(0, 4);
    var series = [theirKeep[0]];
    var playSpy = watch(fakeState({
      phase: 'PLAY',
      seat: seat,
      hands: [theirKeep.slice(1), keep],
      showHands: [theirKeep, keep],
      // The crib holds the AI's own two discards AND the other player's two: reading
      // it would hand over half of what it must not know.
      crib: [mine[4], mine[5], theirs[4], theirs[5]],
      deck: deck.slice(13),
      starter: starter,
      series: series,
      count: series[0].value,
      pile: [{ player: 0, card: series[0] }]
    }), '', playReads);

    eachLevel(function (level) {
      var ai = AI.create(level, { rng: mulberry32(909) });
      var legal = keep.filter(function (c) { return series[0].value + c.value <= 31; });
      ai.choosePlay(legal.slice(), playSpy);
    });

    var all = reads.concat(playReads);
    S.ok('the recorder actually saw the AI read the state', all.length > 0,
      all.length + ' property reads recorded');

    // (a) nothing forbidden, anywhere, at any depth.
    var offences = offencesIn(all, seat);
    S.eq('the AI never reads the crib, the deck, showHands or the other hand',
      offences.length, 0, offences.slice(0, 8).join(', '));

    // (b) the whitelist. A field nobody thought about is a field nobody checked, so
    // anything new at the top level fails until it is deliberately allowed.
    var unexpected = offListTopLevel(all);
    S.eq('the AI reads nothing outside the agreed list of visible fields',
      unexpected.length, 0, 'unexpected: ' + unexpected.join(', '));

    var underPlay = [];
    all.forEach(function (p) {
      if (p.indexOf('play.') !== 0 || underPlay.indexOf(p) >= 0) return;
      underPlay.push(p);
    });
    var strayed = offListUnderPlay(all);
    S.eq('nothing under play is read but the count and the cards already on the table',
      strayed.length, 0, 'unexpected: ' + strayed.join(', '));
    S.ok('the play fields it does read are not vacuous', underPlay.length >= 2,
      'recorded: ' + underPlay.join(', '));

    // (c) the test must be capable of failing. If nothing ever indexes hands, then
    // "it never reads hands[other]" is true for the wrong reason — so prove the AI
    // does look at its OWN hand, and prove the recorder distinguishes the two.
    S.ok('the AI does read its own hand, so the check above is not vacuous',
      playReads.indexOf('hands.' + seat) >= 0,
      'recorded: ' + playReads.filter(function (p) { return p.indexOf('hands') === 0; })
        .slice(0, 4).join(', '));
    var proof = [];
    var probe = watch({ hands: [['a'], ['b']] }, '', proof);
    var ignored = probe.hands[1 - seat];
    S.ok('the recorder would have caught a read of the other hand',
      proof.indexOf('hands.' + (1 - seat)) >= 0, 'read ' + ignored);

    // (d) a second, independent mechanism: landmines. Same positions, but the
    // forbidden fields are getters that throw. Recording could in principle miss
    // something; a thrown error cannot be missed.
    function landmine(base, seat2) {
      var state = fakeState(base);
      var hit = null;
      ['crib', 'deck', 'showHands', 'cardsRemaining'].forEach(function (key) {
        Object.defineProperty(state, key, {
          get: function () {
            hit = key;
            throw new Error('the opponent read state.' + key);
          }
        });
      });
      var hands = state.hands;
      var real = hands[1 - seat2];
      Object.defineProperty(hands, String(1 - seat2), {
        get: function () {
          hit = 'hands[' + (1 - seat2) + ']';
          throw new Error('the opponent read the other hand');
        }
      });
      return { state: state, hit: function () { return hit; }, real: real };
    }

    // Both seats, an opening deal and a later one, a fresh series and one already
    // two cards deep. A peek written as `if (seat === 0)` or `if (handNumber > 1)`
    // or `if (series.length >= 2)` is invisible to a single hand-made position, and
    // those are the shapes a peek most naturally takes — so the landmines are laid
    // across all three axes rather than at one point.
    var trapped = 0;
    var trapDetail = '';
    [0, 1].forEach(function (mineSeat) {
      var ours = mineSeat === 1 ? mine : theirs;
      var yours = mineSeat === 1 ? theirs : mine;
      var ourKeep = ours.slice(0, 4);
      var yourKeep = yours.slice(0, 4);
      [1, 4].forEach(function (handNo) {
        eachLevel(function (level) {
          var hands = [];
          hands[mineSeat] = ours.slice();
          hands[1 - mineSeat] = yours.slice();
          var mineTrap = landmine({
            phase: 'DISCARD', seat: mineSeat, handNumber: handNo, hands: hands
          }, mineSeat);
          try {
            AI.create(level, { rng: mulberry32(4) })
              .chooseDiscard(ours.slice(), false, mineTrap.state);
          } catch (err) {
            trapped++;
            if (!trapDetail) {
              trapDetail = level + ' seat ' + mineSeat + ' hand ' + handNo +
                ' (lay-away): ' + err.message;
            }
          }

          // A two-card series, laid by the other seat and then by this one, so the
          // pile carries a card of each and the count is well past a lead.
          var laid = [yourKeep[0], ourKeep[0]];
          var count = laid[0].value + laid[1].value;
          var held = ourKeep.slice(1);
          var playHands = [];
          playHands[mineSeat] = held.slice();
          playHands[1 - mineSeat] = yourKeep.slice(1);
          var playTrap = landmine({
            phase: 'PLAY',
            seat: mineSeat,
            handNumber: handNo,
            hands: playHands,
            starter: starter,
            series: laid,
            count: count,
            pile: [{ player: 1 - mineSeat, card: laid[0] },
              { player: mineSeat, card: laid[1] }]
          }, mineSeat);
          try {
            var legal = held.filter(function (c) { return count + c.value <= 31; });
            if (!legal.length) legal = [held[0]];
            AI.create(level, { rng: mulberry32(4) }).choosePlay(legal.slice(), playTrap.state);
          } catch (err2) {
            trapped++;
            if (!trapDetail) {
              trapDetail = level + ' seat ' + mineSeat + ' hand ' + handNo +
                ' (play): ' + err2.message;
            }
          }
        });
      });
    });
    S.eq('no tier trips a landmine on the crib, the deck or the other hand', trapped, 0,
      trapDetail);

    // (e) and the landmines are live: reading one really does throw.
    var proofTrap = landmine({ phase: 'PLAY', seat: seat, hands: [theirKeep, keep] }, seat);
    S.throws('a landmine fires when the crib is read', function () {
      return proofTrap.state.crib;
    });
    S.throws('a landmine fires when the other hand is read', function () {
      return proofTrap.state.hands[1 - seat];
    });

    // (f) the narrow view itself carries nothing it should not, whatever it was
    // handed. This is the structural half of the promise.
    var view = AI.narrowView(fakeState({
      seat: seat,
      hands: [theirKeep, keep],
      showHands: [theirKeep, keep],
      crib: [mine[4], mine[5], theirs[4], theirs[5]],
      deck: deck.slice(13),
      starter: starter,
      series: series,
      count: series[0].value,
      pile: [{ player: 0, card: series[0] }]
    }), null, null);
    var leaked = [];
    var forbiddenCards = theirKeep.slice(1).concat([mine[4], mine[5], theirs[4], theirs[5]])
      .concat(deck.slice(14));
    JSON.stringify(view, function (key, value) {
      if (value && typeof value.id === 'number') {
        for (var i = 0; i < forbiddenCards.length; i++) {
          if (forbiddenCards[i].id === value.id && leaked.indexOf(value.id) < 0) {
            leaked.push(value.id);
          }
        }
      }
      return value;
    });
    S.eq('the narrow view contains no card the seat has not seen', leaked.length, 0,
      leaked.map(function (id) { return Cards.cardName(Cards.cardFromId(id)); }).join(' '));
    S.ok('the narrow view does carry what the seat CAN see',
      view.myHand.length === keep.length && view.starter === starter &&
      view.series.length === 1);
  }

  /**
   * The same audit, but driven by REAL GAMES instead of by hand-made positions.
   *
   * This exists because the hand-made version above, on its own, only catches an
   * UNCONDITIONAL peek. Every position it builds sits at one point of the space: one
   * seat, the first hand, a series nought or one card long. A peek written
   *
   *     if (seat === 0) PEEK = state.hands[1];
   *     if (series.length >= 2) PEEK = state.hands[1 - seat];
   *     var PEEK = handNumber > 1 ? state.crib : null;
   *
   * reads the other player's hand for most of every game and sails through it — the
   * banned list is only ever evaluated with seat 1, so 'hands.1' never appears on it,
   * and no position two cards into a series or from a later deal is ever presented.
   * All three were tried against the old file and all three passed 140 of 140.
   *
   * So: play whole games, every tier, both seats, and put a recorder in front of an
   * unfrozen mirror of the ACTUAL engine snapshot at every single decision — first
   * deal and last, lay-away and peg, count 0 and count 30, series one card deep and
   * four. Coverage is asserted rather than assumed: if a future edit stops the sweep
   * reaching both seats, or a second hand, or a series two cards deep, the coverage
   * assertions fail and say so, instead of the audit quietly narrowing back down to
   * the spot check it replaced.
   */
  function testNoCheatingUnderRealPlay(S) {
    var offences = [];
    var offList = [];
    var strayUnderPlay = [];
    var seatDecisions = [0, 0];
    var ownHandReads = [0, 0];
    var handNumbers = {};
    var seriesLengths = {};
    var phasesSeen = {};
    var counts = { max: 0 };
    var decisions = 0;

    function note(where, reads, seat) {
      decisions++;
      seatDecisions[seat]++;
      var bad = offencesIn(reads, seat);
      for (var i = 0; i < bad.length && offences.length < 6; i++) {
        offences.push(bad[i] + ' @ ' + where);
      }
      offListTopLevel(reads).forEach(function (p) {
        if (offList.length < 6) offList.push(p + ' @ ' + where);
      });
      offListUnderPlay(reads).forEach(function (p) {
        if (strayUnderPlay.length < 6) strayUnderPlay.push(p + ' @ ' + where);
      });
      if (reads.indexOf('hands.' + seat) >= 0) ownHandReads[seat]++;
    }

    function auditGame(level, seed, target) {
      var game = Engine.createGame({
        rng: mulberry32(seed),
        targetScore: target,
        dealer: 0,
        deck: function (handNumber) {
          return Cards.shuffle(Cards.makeDeck(), mulberry32(Math.imul(seed, 7919) + handNumber));
        }
      });
      var ais = [
        AI.create(level, { rng: mulberry32(seed + 11) }),
        AI.create(level, { rng: mulberry32(seed + 22) })
      ];
      var guard = 0;
      while (!game.isOver() && ++guard < 20000) {
        var actor = game.pendingActor();
        if (actor === null) {
          game.advance();
          continue;
        }
        var snap = game.getState();
        var where = level + ' hand ' + snap.handNumber + ' ' + snap.phase +
          ' seat ' + actor + ' count ' + snap.play.count +
          ' series ' + snap.play.series.length;
        phasesSeen[snap.phase] = true;
        handNumbers[snap.handNumber] = true;
        seriesLengths[snap.play.series.length] = true;
        if (snap.play.count > counts.max) counts.max = snap.play.count;

        var reads = [];
        // The AI is handed a recorder over a mirror of the real snapshot — not a
        // fake one — so every field the live game actually fills in is on offer.
        var spy = watch(thaw(snap), '', reads);
        if (snap.phase === 'DISCARD') {
          var pair = ais[actor].chooseDiscard(snap.hands[actor].slice(),
            snap.dealer === actor, spy);
          note(where, reads, actor);
          game.apply({ type: 'discard', player: actor, cards: pair });
          continue;
        }
        var legal = game.legalActions().map(function (a) { return a.card; });
        var card = ais[actor].choosePlay(legal, spy);
        note(where, reads, actor);
        game.apply({ type: 'play', player: actor, card: card });
      }
    }

    // Three games a tier at 121 and one at 61: enough deals that both seats deal,
    // both seats lay away into both cribs, and the play runs from lead to last card
    // many times over.
    eachLevel(function (level) {
      auditGame(level, 31337, 121);
      auditGame(level, 8675309, 121);
      auditGame(level, 1618033, 121);
      auditGame(level, 424242, 61);
    });

    // --- coverage. An audit that never reached seat 0 could not see a seat-0 peek. ---
    S.ok('the sweep is large enough to be called an audit', decisions >= 800,
      decisions + ' decisions watched');
    S.ok('both seats decided, so both halves of the banned list were exercised',
      seatDecisions[0] >= 100 && seatDecisions[1] >= 100, seatDecisions.join(' / '));
    S.ok('both seats were caught reading their OWN hand, so neither check is vacuous',
      ownHandReads[0] > 0 && ownHandReads[1] > 0, ownHandReads.join(' / '));
    S.ok('decisions were taken in later hands, not just the first',
      Object.keys(handNumbers).length >= 4, 'hand numbers: ' +
      Object.keys(handNumbers).join(' '));
    S.ok('decisions were taken well into a series, not just at the lead',
      seriesLengths[2] && seriesLengths[3], 'series lengths: ' +
      Object.keys(seriesLengths).join(' '));
    S.ok('the count got high enough for the end of a series to matter',
      counts.max >= 20, 'highest count decided at: ' + counts.max);
    S.ok('both the lay-away and the peg were audited',
      !!phasesSeen.DISCARD && !!phasesSeen.PLAY,
      'phases: ' + Object.keys(phasesSeen).join(' '));

    // --- and the thing itself. ---
    S.eq('over whole games, no tier in either seat ever reads the crib, the deck, ' +
      'showHands or the other hand', offences.length, 0, offences.join(' | '));
    S.eq('over whole games, nothing outside the agreed list of visible fields is read',
      offList.length, 0, offList.join(' | '));
    S.eq('over whole games, nothing under play but the count and the cards on the table',
      strayUnderPlay.length, 0, strayUnderPlay.join(' | '));
  }

  // =========================================================================
  // 5. Against the real engine
  // =========================================================================

  function playGame(ais, rng, target, deckFn) {
    // With a deck sequence supplied the game is fully determined: seat 0 deals first
    // and every hand comes off the same seeded shuffle, which is what lets the same
    // cards be played twice with the seats swapped.
    var game = Engine.createGame({
      rng: rng,
      targetScore: target,
      dealer: deckFn ? 0 : null,
      deck: deckFn || undefined
    });
    var problems = [];
    var guard = 0;
    while (!game.isOver()) {
      if (++guard > 20000) {
        problems.push('the game never ended');
        break;
      }
      var actor = game.pendingActor();
      if (actor === null) {
        game.advance();
        continue;
      }
      var snapshot = game.getState();
      var legal = game.legalActions();
      if (snapshot.phase === 'CUT_FOR_DEAL') {
        game.apply({ type: 'cutForDeal', player: actor });
        continue;
      }
      if (snapshot.phase === 'DISCARD') {
        // Handed exactly what game.js hands it: its own hand, whose crib it is, and
        // the snapshot.
        var pair = ais[actor].chooseDiscard(snapshot.hands[actor].slice(),
          snapshot.dealer === actor, snapshot);
        var matched = false;
        for (var i = 0; i < legal.length && !matched; i++) {
          var ids = [legal[i].cards[0].id, legal[i].cards[1].id];
          if ((ids[0] === pair[0].id && ids[1] === pair[1].id) ||
            (ids[1] === pair[0].id && ids[0] === pair[1].id)) matched = true;
        }
        if (!matched) problems.push('illegal lay-away ' + names(pair));
        game.apply({ type: 'discard', player: actor, cards: pair });
        continue;
      }
      var cards = legal.map(function (a) { return a.card; });
      var card = ais[actor].choosePlay(cards, snapshot);
      if (!card || !hasId(cards, card)) {
        problems.push('illegal play ' + (card ? Cards.cardName(card) : 'null') +
          ' at count ' + snapshot.play.count);
        card = cards[0];
      }
      game.apply({ type: 'play', player: actor, card: card });
    }
    return { state: game.getState(), problems: problems };
  }

  /**
   * The hard tier decides every card by playing the rest of the hand out in its head.
   * If that miniature disagrees with the engine, hard is optimising a game nobody is
   * playing — and nothing else in this file would notice, because every card it
   * returns would still be perfectly legal.
   *
   * So: deal real hands, play them through the REAL engine with normal on both
   * seats, and demand that AI.rollout, handed the same four-and-four, returns the
   * identical pegging totals. Normal's tactics are what the rollout uses as its
   * policy, so the two must agree card for card, go for go, last card for last card.
   *
   * AND — this is the part that was missing — the same demand from every MID-SERIES
   * position the hand passes through, which is the only mode hardPlay ever uses. It
   * calls rollout one card into a series, never from a clean lead, and a rollout
   * from a clean lead cannot exercise the state that distinguishes the two: who laid
   * the card already on the table, and therefore who is owed the point if nobody can
   * follow it. That was hardcoded to "nobody" and the sweep below, which only ever
   * started from an empty series, could not see it. So the probes are taken the way
   * hardPlay takes them: immediately after a card is played, with the count and the
   * series it leaves and the seat that laid it.
   */
  function testRolloutMatchesTheEngine(S) {
    var rng = mulberry32(90210);
    var checked = 0;
    var mismatches = 0;
    var nonZero = 0;
    var detail = '';
    // Mid-series probes: { series, count, hands, toMove, lastPlayer, peggedSoFar }.
    var probes = [];
    var probeMismatches = 0;
    var probeDetail = '';
    var probesEndingSeries = 0;
    for (var h = 0; h < 60; h++) {
      var game = Engine.createGame({
        dealer: h % 2,
        deck: Cards.shuffle(Cards.makeDeck(), rng),
        targetScore: 121,
        rng: function () { return 0.5; }
      });
      var ais = [
        AI.create('normal', { rng: mulberry32(1) }),
        AI.create('normal', { rng: mulberry32(2) })
      ];
      var pegged = [0, 0];
      var start = null;
      var mine = [];
      var guard = 0;
      while (!game.isOver() && ++guard < 400) {
        var snap = game.getState();
        // One hand only: the moment the play is over there is nothing left to model.
        if (snap.phase === 'SHOW_PONE') break;
        var actor = game.pendingActor();
        var events;
        var played = false;
        if (actor === null) {
          events = game.advance();
        } else if (snap.phase === 'DISCARD') {
          events = game.apply({
            type: 'discard',
            player: actor,
            cards: ais[actor].chooseDiscard(snap.hands[actor].slice(),
              snap.dealer === actor, snap)
          });
        } else {
          var legal = game.legalActions().map(function (a) { return a.card; });
          events = game.apply({
            type: 'play', player: actor, card: ais[actor].choosePlay(legal, snap)
          });
          played = true;
        }
        for (var e = 0; e < events.length; e++) {
          var ev = events[e];
          if (ev.type === 'starter') {
            var at = game.getState();
            if (at.showHands[0].length === 4) {
              start = {
                hands: [at.showHands[0].slice(), at.showHands[1].slice()],
                lead: 1 - at.dealer
              };
            }
          } else if (ev.type === 'score' && ev.source === 'play') {
            pegged[ev.player] += ev.points;
          }
        }
        // Exactly hardPlay's shape: a card has just gone down, the count and series
        // include it, and the go it may be owed has not been resolved yet — the
        // engine settles that on the next beat.
        if (played) {
          var after = game.getState();
          if (after.phase === 'PLAY' && after.play.series.length) {
            mine.push({
              series: after.play.series.slice(),
              count: after.play.count,
              hands: [after.hands[0].slice(), after.hands[1].slice()],
              toMove: after.play.toMove,
              lastPlayer: after.play.lastPlayer,
              soFar: pegged.slice()
            });
            if (!canFollow(after.hands[0], 31 - after.play.count) &&
              !canFollow(after.hands[1], 31 - after.play.count)) probesEndingSeries++;
          }
        }
      }
      if (!start) continue;
      checked++;
      // The rest of the hand from each probe is whatever the engine went on to peg.
      for (var m = 0; m < mine.length; m++) {
        var p = mine[m];
        p.rest = [pegged[0] - p.soFar[0], pegged[1] - p.soFar[1]];
        probes.push(p);
      }
      if (pegged[0] + pegged[1] > 2) nonZero++;
      var got = AI.rollout([], 0, [start.hands[0].slice(), start.hands[1].slice()],
        start.lead);
      if (got[0] !== pegged[0] || got[1] !== pegged[1]) {
        mismatches++;
        if (!detail) {
          detail = names(start.hands[0]) + ' / ' + names(start.hands[1]) +
            ' lead ' + start.lead + ': engine ' + pegged.join('-') +
            ', rollout ' + got.join('-');
        }
      }
    }
    S.ok('the equivalence sweep played real hands', checked >= 50, checked + ' hands');
    S.ok('and they were hands where pegging actually happened', nonZero >= 40,
      nonZero + ' of ' + checked + ' pegged more than two points');
    S.eq("hard's rollout scores a hand exactly as the engine does", mismatches, 0, detail);

    // --- the same sweep, from where hardPlay actually stands ---
    for (var q = 0; q < probes.length; q++) {
      var pr = probes[q];
      var mid = AI.rollout(pr.series, pr.count,
        [pr.hands[0].slice(), pr.hands[1].slice()], pr.toMove, pr.lastPlayer);
      if (mid[0] !== pr.rest[0] || mid[1] !== pr.rest[1]) {
        probeMismatches++;
        if (!probeDetail) {
          probeDetail = 'after ' + names(pr.series) + ' at ' + pr.count +
            ' (played by ' + pr.lastPlayer + '), ' + names(pr.hands[0]) + ' / ' +
            names(pr.hands[1]) + ': engine ' + pr.rest.join('-') +
            ', rollout ' + mid.join('-');
        }
      }
    }
    S.ok('the mid-series sweep found positions to check', probes.length >= 300,
      probes.length + ' positions, one after every card played');
    S.ok('and some of them were positions where the series died on that card',
      probesEndingSeries >= 40,
      probesEndingSeries + ' of ' + probes.length + ' left nobody able to follow');
    S.eq("hard's rollout scores the REST of a hand exactly as the engine does, from " +
      'mid-series — the only way hardPlay ever calls it', probeMismatches, 0, probeDetail);

    // The comparison must be capable of failing: a rollout that ignored the last
    // card, or leaked a go, would still return two plausible-looking numbers.
    var one = AI.rollout([], 0,
      [Cards.parseCards('AS 2H 3D 4C'), Cards.parseCards('KS QH JD TC')], 0);
    S.eq('a rollout of four low against four ten-cards pays the low hand the go',
      one[0] > one[1], true, 'got ' + one.join('-'));
    var empty = AI.rollout([], 0, [[], []], 0);
    S.eq('a rollout of nothing scores nothing', empty.join('-'), '0-0');

    // And the go point itself, in the smallest position that has one. Seat 0 has
    // just laid the 2♣ to take the count to 22; neither king fits, so seat 0 takes
    // the go, seat 1 then leads its king, seat 0 pairs it for 2 and takes the last
    // card for 1. Four points, and every one of them belongs to seat 0.
    var stuck = Cards.parseCards('KS TH 2C');
    S.eq('the seat that laid the last card takes the go, when it is named',
      AI.rollout(stuck, 22, [Cards.parseCards('KD'), Cards.parseCards('KH')], 1, 0).join('-'),
      '4-0');
    S.eq('and the mirror image pays the other seat',
      AI.rollout(stuck, 22, [Cards.parseCards('KH'), Cards.parseCards('KD')], 0, 1).join('-'),
      '0-4');
    // Left unnamed there is no way to know whose it is, so nobody gets it. That is
    // the right answer for a position nobody started, and the wrong answer for the
    // one hardPlay is in — which is why hardPlay names it.
    S.eq('unnamed, the go belongs to nobody',
      AI.rollout(stuck, 22, [Cards.parseCards('KD'), Cards.parseCards('KH')], 1).join('-'),
      '3-0');

    // End to end: the point has to reach hard's decision, not merely its evaluator.
    // At 20 after T-K, holding 5-10-J, a ten-card leaves 30 and only an ace can
    // follow it — the series dies and the go is hard's. The five leaves 25, which
    // more than half the deck can follow and a six turns into thirty-one. Docking
    // hard the go point it just won reverses that: it played the five instead, in
    // every one of these seeds.
    var deadEnd = fakeState({
      seat: 1,
      hands: [[], Cards.parseCards('5S TC JC')],
      series: Cards.parseCards('TS KS'),
      count: 20,
      pile: [{ player: 0, card: Cards.parseCards('TS')[0] },
        { player: 1, card: Cards.parseCards('KS')[0] }]
    });
    var fives = 0;
    for (var sd = 1; sd <= 6; sd++) {
      var pick = AI.create('hard', { rng: mulberry32(sd), playSamples: 1500 })
        .choosePlay(Cards.parseCards('5S TC JC'), deadEnd);
      if (pick.rank === 5) fives++;
    }
    S.eq('hard shuts the series down for the go rather than playing a five to 25',
      fives, 0, fives + ' of 6 seeds played the five');
  }

  // =========================================================================
  // 5b. The tiers must rank
  // =========================================================================

  // A miniature of tools/tournament.js. Mirrored pairs: one seeded sequence of decks
  // played twice with the seats swapped, so each side gets the identical cards in the
  // identical role and what is left over the pair is the play.
  function deckSequence(seed) {
    return function (handNumber) {
      return Cards.shuffle(Cards.makeDeck(), mulberry32(Math.imul(seed, 7919) + handNumber));
    };
  }

  function miniTournament(levels, pairs, seed, target) {
    var wins = [0, 0];
    var margin = 0;
    var games = 0;
    for (var p = 0; p < pairs; p++) {
      var deckFn = deckSequence(seed + p);
      for (var side = 0; side < 2; side++) {
        var roleOfSeat = side === 0 ? [0, 1] : [1, 0];
        var ais = [
          AI.create(levels[roleOfSeat[0]], { rng: mulberry32(seed + p * 131 + side * 17 + 1) }),
          AI.create(levels[roleOfSeat[1]], { rng: mulberry32(seed + p * 131 + side * 17 + 2) })
        ];
        var result = playGame(ais, mulberry32(seed), target, deckFn);
        games++;
        if (result.state.winner === null) continue;
        wins[roleOfSeat[result.state.winner]]++;
        margin += roleOfSeat[0] === 0
          ? result.state.scores[0] - result.state.scores[1]
          : result.state.scores[1] - result.state.scores[0];
      }
    }
    return { wins: wins, games: games, margin: margin / (games || 1) };
  }

  // One hand through the REAL engine with both sides laying away by the same fixed
  // rule, so the four cards each seat keeps depend on the deal and nothing else.
  // What is left to measure is purely the play.
  function pegOneHand(ais, deck) {
    var game = Engine.createGame({
      dealer: 0, deck: deck, targetScore: 121, rng: function () { return 0.5; }
    });
    var pegged = [0, 0];
    var guard = 0;
    while (!game.isOver() && ++guard < 200) {
      var snap = game.getState();
      if (snap.phase === 'SHOW_PONE') break;
      var actor = game.pendingActor();
      var events;
      if (actor === null) {
        events = game.advance();
      } else if (snap.phase === 'DISCARD') {
        events = game.apply(game.legalActions()[0]);
      } else {
        var legal = game.legalActions().map(function (a) { return a.card; });
        events = game.apply({
          type: 'play', player: actor, card: ais[actor].choosePlay(legal, snap)
        });
      }
      for (var e = 0; e < events.length; e++) {
        if (events[e].type === 'score' && events[e].source === 'play') {
          pegged[events[e].player] += events[e].points;
        }
      }
    }
    return pegged;
  }

  /**
   * peggingDuel(levels, deals, seed, samples) -> points pegged by each level.
   *
   * Whole games cannot resolve the gap between hard and normal in the second or two
   * a test suite may spend — a cribbage game is mostly cards, and forty-eight of
   * them carry an interval of plus or minus fourteen points of win rate. So this
   * isolates the half of the game the two tiers actually play differently and pairs
   * it: every deal is pegged twice with the seats swapped, so each side plays the
   * identical four cards from the identical side of the table.
   */
  function peggingDuel(levels, deals, seed, samples) {
    var got = [0, 0];
    for (var d = 0; d < deals; d++) {
      var deck = Cards.shuffle(Cards.makeDeck(), mulberry32(seed + d));
      for (var side = 0; side < 2; side++) {
        var roleOfSeat = side === 0 ? [0, 1] : [1, 0];
        var pegged = pegOneHand([
          AI.create(levels[roleOfSeat[0]],
            { rng: mulberry32(seed + d * 17 + 1), playSamples: samples }),
          AI.create(levels[roleOfSeat[1]],
            { rng: mulberry32(seed + d * 17 + 2), playSamples: samples })
        ], deck);
        got[roleOfSeat[0]] += pegged[0];
        got[roleOfSeat[1]] += pegged[1];
      }
    }
    return got;
  }

  /**
   * layAwayQuality(levels, deals, seed) -> mean value of each tier's chosen throw,
   * judged by a yardstick none of them share: the exact hand EV plus or minus a crib
   * simulated here out of scoreHand alone. Every tier is handed the same six cards
   * and the same imagined cribs on a given deal, so what separates them is the
   * choice and not the judge's own sampling.
   */
  function layAwayQuality(levels, deals, seed) {
    var rng = mulberry32(seed);
    var totals = [];
    var i;
    for (i = 0; i < levels.length; i++) totals.push(0);
    for (var d = 0; d < deals; d++) {
      var six = dealSix(rng);
      var own = d % 2 === 0;
      for (i = 0; i < levels.length; i++) {
        var pick = AI.create(levels[i], { rng: mulberry32(seed + d) })
          .chooseDiscard(six.slice(), own);
        var kept = six.filter(function (c) { return !hasId(pick, c); });
        totals[i] += AI.handEV(kept, six) +
          (own ? 1 : -1) * monteCarloCrib(pick, mulberry32(seed + d * 7919), 200);
      }
    }
    for (i = 0; i < levels.length; i++) totals[i] /= deals;
    return totals;
  }

  /**
   * The ordering hard > normal > easy, as a fast fixed-seed tripwire.
   *
   * tools/tournament.js is where the real measurement lives — thousands of mirrored
   * games and a confidence interval. This is here so that gutting a tier fails
   * `node tools/run-tests.js` without anybody having to remember to run one. Every
   * seed is fixed, so none of it is a sample: it either passes or it does not, and a
   * generous threshold therefore costs nothing and cannot flake.
   *
   * The small tournament carries the two gaps that are wide enough for it to see.
   * The gap between hard and normal is worth about four points a game, which
   * forty-eight games cannot resolve, so it is measured where it actually lives
   * instead: paired pegging, and the value of the lay-away.
   */
  function testStrengthOrdering(S, log) {
    var target = 61;
    var hn = miniTournament(['hard', 'normal'], 24, 4242, target);
    var ne = miniTournament(['normal', 'easy'], 10, 909, target);
    var he = miniTournament(['hard', 'easy'], 8, 606, target);
    var peg = peggingDuel(['hard', 'normal'], 300, 51015, 48);
    var lay = layAwayQuality(['hard', 'normal', 'easy'], 60, 8080);

    log('        tiers rank: hard out-pegs normal by ' +
      ((peg[0] - peg[1]) / 600).toFixed(2) + ' a hand over 600 paired hands (' +
      peg[0] + '-' + peg[1] + '); lay-away worth hard ' + lay[0].toFixed(2) +
      ', normal ' + lay[1].toFixed(2) + ', easy ' + lay[2].toFixed(2));
    log('        small tournament: normal-easy ' + ne.wins.join('-') + ', hard-easy ' +
      he.wins.join('-') + ', hard-normal ' + hn.wins.join('-') +
      ' (48 games cannot resolve hard vs normal — tools/tournament.js puts it at ' +
      '54.4% +/- 1.1 over 3000)');

    // --- the two gaps a small tournament can see ---
    S.ok('normal beats easy decisively', ne.wins[0] >= ne.games * 0.70,
      ne.wins.join('-') + ' over ' + ne.games + ' games, mean margin ' +
      ne.margin.toFixed(1));
    S.ok('hard beats easy decisively', he.wins[0] >= he.games * 0.70,
      he.wins.join('-') + ' over ' + he.games + ' games, mean margin ' +
      he.margin.toFixed(1));
    S.ok('easy is beatable without being a walkover in reverse',
      ne.wins[1] < ne.games * 0.30 && ne.margin < 40,
      'easy took ' + ne.wins[1] + ' of ' + ne.games + ', losing by ' +
      ne.margin.toFixed(1) + ' a game');
    // Generous on purpose, and it has to be. Hard takes 54.4% of games from normal,
    // which over 48 games is 26 wins give or take 7 — this particular seeded set
    // happens to come out 23-25 the other way, which is exactly why the ordering is
    // not asserted from it. What a floor of 40% catches is a tier that has stopped
    // working: gut hard's search and it drops to easy's level, not to 48%.
    S.ok('hard has not collapsed against normal over a fixed set of mirrored deals',
      hn.wins[0] >= hn.games * 0.40,
      hn.wins.join('-') + ' over ' + hn.games + ' games, mean margin ' +
      hn.margin.toFixed(1));

    // --- and the gap it cannot: measured where hard and normal actually differ ---
    S.ok('hard out-pegs normal on identical cards from identical seats',
      peg[0] > peg[1],
      'hard ' + peg[0] + ' to normal ' + peg[1] + ' over 600 paired hands (' +
      ((peg[0] - peg[1]) / 600).toFixed(2) + ' points a hand)');
    S.ok('hard lays away better than normal', lay[0] > lay[1],
      lay[0].toFixed(3) + ' vs ' + lay[1].toFixed(3) + ' points a deal');
    S.ok('normal lays away better than easy', lay[1] > lay[2],
      lay[1].toFixed(3) + ' vs ' + lay[2].toFixed(3) + ' points a deal');
    S.ok('easy is weaker than normal at the lay-away by a wide margin',
      lay[1] - lay[2] > 1, (lay[1] - lay[2]).toFixed(2) + ' points a deal');
  }

  function testAgainstTheEngine(S, games) {
    var problems = [];
    var finished = 0;
    var rng = mulberry32(1024);
    var pairings = [['normal', 'easy'], ['hard', 'normal'], ['easy', 'hard'],
      ['normal', 'normal']];
    for (var g = 0; g < games; g++) {
      var pairing = pairings[g % pairings.length];
      var ais = [
        AI.create(pairing[0], { rng: mulberry32(6000 + g) }),
        AI.create(pairing[1], { rng: mulberry32(7000 + g) })
      ];
      var result = playGame(ais, rng, g % 3 === 0 ? 61 : 121);
      problems = problems.concat(result.problems);
      if (result.state.winner !== null) finished++;
    }
    S.eq('every decision the engine was offered was legal, over ' + games + ' full games',
      problems.length, 0, problems.slice(0, 5).join(' | '));
    S.eq('every game reached a winner', finished, games);
  }

  // =========================================================================
  // 6. Cost
  // =========================================================================

  function testTiming(S, log) {
    var rng = mulberry32(2024);
    var hands = [];
    for (var i = 0; i < 12; i++) hands.push(dealSix(rng));
    var timings = {};
    eachLevel(function (level) {
      var ai = AI.create(level, { rng: mulberry32(64) });
      ai.chooseDiscard(hands[0].slice(), true, fakeState({ phase: 'DISCARD' }));
      var started = Date.now();
      for (var h = 0; h < hands.length; h++) {
        ai.chooseDiscard(hands[h].slice(), h % 2 === 0, fakeState({ phase: 'DISCARD' }));
      }
      timings[level] = (Date.now() - started) / hands.length;
    });
    log('        lay-away: easy ' + timings.easy.toFixed(1) + 'ms, normal ' +
      timings.normal.toFixed(1) + 'ms, hard ' + timings.hard.toFixed(1) + 'ms   (' +
      AI.CRIB_SAMPLES + ' crib samples)');
    // The budget is 150ms. The bar here is deliberately loose so a slow machine does
    // not fail the suite, but a tier that started enumerating the whole crib space
    // would blow straight through it.
    S.ok('the hard lay-away stays inside the 150ms budget with room to spare',
      timings.hard < 150, timings.hard.toFixed(1) + 'ms per decision');
    S.ok('normal costs almost nothing', timings.normal < 25,
      timings.normal.toFixed(1) + 'ms per decision');
  }

  // =========================================================================

  function testApi(S) {
    S.ok('AI.create exists', typeof AI.create === 'function');
    S.throws('an unknown level is refused', function () { AI.create('brutal'); });
    S.throws('a non-function rng is refused', function () {
      AI.create('normal', { rng: 7 });
    });
    S.throws('a lay-away of the wrong size is refused', function () {
      AI.create('normal', { rng: mulberry32(1) })
        .chooseDiscard(Cards.parseCards('AS 2H 3D'), true, fakeState({}));
    });
    eachLevel(function (level) {
      var ai = AI.create(level, { rng: mulberry32(1) });
      S.eq(level + ' reports its name', ai.name, level);
      S.eq(level + ' exposes chooseDiscard', typeof ai.chooseDiscard, 'function');
      S.eq(level + ' exposes choosePlay', typeof ai.choosePlay, 'function');
    });
    // The seam in game.js defaults `state` to a snapshot, but a caller that hands it
    // nothing at all must still get a legal answer rather than an exception.
    var six = dealSix(mulberry32(3));
    eachLevel(function (level) {
      var ai = AI.create(level, { rng: mulberry32(2) });
      var pair = ai.chooseDiscard(six.slice(), true);
      S.ok(level + ' survives being called with no state', pair.length === 2 &&
        hasId(six, pair[0]) && hasId(six, pair[1]));
      var card = ai.choosePlay(six.slice(0, 4));
      S.ok(level + ' plays a card with no state either', hasId(six, card));
    });
  }

  // ---------------------------------------------------------------------- run ---

  function run(options) {
    options = options || {};
    var S = new Suite(options);
    var log = options.log || function () {};

    if (!root.Cribbage || !root.Cribbage.Cards || !root.Cribbage.Scoring ||
      !root.Cribbage.Engine || !root.Cribbage.AI) {
      S.ok('modules loaded (cards.js, scoring.js, engine.js, ai.js)', false);
      return { passed: S.passed, failed: S.failed, results: S.results };
    }
    Cards = root.Cribbage.Cards;
    Scoring = root.Cribbage.Scoring;
    Engine = root.Cribbage.Engine;
    AI = root.Cribbage.AI;

    function section(name, fn) {
      try {
        fn(S);
      } catch (err) {
        S.record(name + ': the group threw', false, 'no throw',
          (err && err.message) || String(err), (err && err.stack) || '');
      }
    }

    var games = options.games === undefined || options.games === null ? 8 : options.games;

    section('no cheating', testNoCheating);
    section('no cheating under real play', testNoCheatingUnderRealPlay);
    section('api', testApi);
    section('the fast five-card total', testFastScore);
    section('hand EV', testHandEV);
    section('crib sign', testCribSign);
    section('crib heuristic', testCribHeuristic);
    section('legal lay-aways', function (s) { testDiscardIsLegal(s, 60); });
    section('easy', testEasyIsWeakButNotSilly);
    section('tier strength', testTierStrength);
    section('legal plays', function (s) { testPlayIsLegal(s, 250); });
    section('leading', testNeverLeadsAFive);
    section('leading from a pair', testLeadsFromAPair);
    section('thirty-one', testTakesThirtyOne);
    section('danger counts', testAvoidsFiveAndTwentyOne);
    section('taking points', testTakesPointsWhenOffered);
    section('the one-ply search', testHardSearchIsSharperThanTheTable);
    section('determinism', testDeterminism);
    section('the rollout matches the engine', testRolloutMatchesTheEngine);
    section('the tiers rank', function (s) { testStrengthOrdering(s, log); });
    if (games > 0) {
      section('full games', function (s) { testAgainstTheEngine(s, games); });
    }
    section('timing', function (s) { testTiming(s, log); });

    return { passed: S.passed, failed: S.failed, results: S.results };
  }

  root.Cribbage = root.Cribbage || {};
  root.Cribbage.AITests = { run: run };
})(typeof window !== 'undefined' ? window : globalThis);
