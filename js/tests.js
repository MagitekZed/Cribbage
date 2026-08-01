(function (root) {
  'use strict';

  // Cribbage.Tests.run(options) -> { passed, failed, results, histogram }
  // Driven by both tools/run-tests.js (Node) and tests.html (browser), so it must not
  // assume either environment. options: { exhaustive, verbose, log, onProgress }

  // ---------------------------------------------------------------- assertions ---

  function Suite(options) {
    this.options = options || {};
    this.log = this.options.log || function () {};
    this.passed = 0;
    this.failed = 0;
    this.results = [];
    this.histogram = null;
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

  Suite.prototype.deepEq = function (name, actual, expected, detail) {
    var a = JSON.stringify(actual);
    var e = JSON.stringify(expected);
    return this.record(name, a === e, expected, actual, detail);
  };

  // ------------------------------------------------------------------ helpers ---

  var PERMS_4 = (function () {
    var out = [];
    var base = [0, 1, 2, 3];
    (function permute(prefix, rest) {
      if (rest.length === 0) {
        out.push(prefix.slice());
        return;
      }
      for (var i = 0; i < rest.length; i++) {
        var next = rest.slice();
        next.splice(i, 1);
        permute(prefix.concat([rest[i]]), next);
      }
    })([], base);
    return out;
  })();

  function snapshot(cards, starter) {
    return JSON.stringify(cards) + '|' + JSON.stringify(starter);
  }

  function pointsOfType(breakdown, type) {
    var sum = 0;
    for (var i = 0; i < breakdown.length; i++) {
      if (breakdown[i].type === type) sum += breakdown[i].points;
    }
    return sum;
  }

  function totalPoints(breakdown) {
    var sum = 0;
    for (var i = 0; i < breakdown.length; i++) sum += breakdown[i].points;
    return sum;
  }

  // A tiny deterministic PRNG so shuffle() can be tested reproducibly.
  function seededRng(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  // ------------------------------------------------------------- cards module ---

  function testCards(S) {
    var C = root.Cribbage.Cards;

    S.eq('cards: makeCard(1,0).id (ace of spades)', C.makeCard(1, 0).id, 0);
    S.eq('cards: makeCard(13,3).id (king of clubs)', C.makeCard(13, 3).id, 51);
    S.eq('cards: makeCard(5,1).id', C.makeCard(5, 1).id, 17);
    S.eq('cards: ace value is 1', C.makeCard(1, 0).value, 1);
    S.eq('cards: nine value is 9', C.makeCard(9, 0).value, 9);
    S.eq('cards: ten value is 10', C.makeCard(10, 0).value, 10);
    S.eq('cards: jack value is 10', C.makeCard(11, 0).value, 10);
    S.eq('cards: queen value is 10', C.makeCard(12, 0).value, 10);
    S.eq('cards: king value is 10', C.makeCard(13, 0).value, 10);
    S.eq('cards: jack rank is 11', C.makeCard(11, 0).rank, 11);
    S.eq('cards: king rank is 13', C.makeCard(13, 0).rank, 13);

    var idRoundTrip = true;
    var nameRoundTrip = true;
    for (var id = 0; id < 52; id++) {
      var card = C.cardFromId(id);
      if (card.id !== id) idRoundTrip = false;
      if (C.parseCard(C.cardName(card)).id !== id) nameRoundTrip = false;
    }
    S.ok('cards: cardFromId round-trips all 52 ids', idRoundTrip);
    S.ok('cards: cardName/parseCard round-trip all 52 cards', nameRoundTrip);

    var deck = C.makeDeck();
    S.eq('cards: deck has 52 cards', deck.length, 52);
    var seen = {};
    var ordered = true;
    for (var i = 0; i < deck.length; i++) {
      if (deck[i].id !== i) ordered = false;
      seen[deck[i].id] = true;
    }
    S.ok('cards: deck is ordered by id', ordered);
    S.eq('cards: deck has 52 distinct ids', Object.keys(seen).length, 52);

    var before = JSON.stringify(deck);
    var shuffled = C.shuffle(deck, seededRng(12345));
    S.eq('cards: shuffle does not mutate the source deck', JSON.stringify(deck), before);
    S.ok('cards: shuffle returns a new array', shuffled !== deck);
    S.eq('cards: shuffled deck has 52 cards', shuffled.length, 52);
    var ids = shuffled.map(function (c) { return c.id; }).sort(function (a, b) { return a - b; });
    var isPermutation = true;
    for (var k = 0; k < 52; k++) if (ids[k] !== k) isPermutation = false;
    S.ok('cards: shuffle is a permutation of the deck', isPermutation);
    S.ok('cards: shuffle actually reorders', JSON.stringify(shuffled) !== before);
    S.eq('cards: shuffle is deterministic for a given rng',
      JSON.stringify(C.shuffle(deck, seededRng(12345))), JSON.stringify(shuffled));

    S.eq('cards: rankName(1)', C.rankName(1), 'A');
    S.eq('cards: rankName(10)', C.rankName(10), '10');
    S.eq('cards: rankName(11)', C.rankName(11), 'J');
    S.eq('cards: rankName(13)', C.rankName(13), 'K');
    S.eq('cards: suitName(0)', C.suitName(0), 'spades');
    S.eq('cards: suitName(1)', C.suitName(1), 'hearts');
    S.eq('cards: suitName(2)', C.suitName(2), 'diamonds');
    S.eq('cards: suitName(3)', C.suitName(3), 'clubs');
    S.eq('cards: suitSymbol(0)', C.suitSymbol(0), '♠');
    S.eq('cards: suitSymbol(1)', C.suitSymbol(1), '♥');
    S.eq('cards: suitSymbol(2)', C.suitSymbol(2), '♦');
    S.eq('cards: suitSymbol(3)', C.suitSymbol(3), '♣');
    S.eq('cards: cardName(5H)', C.cardName(C.makeCard(5, 1)), '5H');
    S.eq('cards: parseCard("5H") id', C.parseCard('5H').id, C.makeCard(5, 1).id);
    S.eq('cards: parseCard("10D") id', C.parseCard('10D').id, C.makeCard(10, 2).id);
    S.eq('cards: parseCard("TD") is an alias for 10D', C.parseCard('TD').id, C.parseCard('10D').id);
    S.eq('cards: parseCard is case-insensitive', C.parseCard('as').id, C.parseCard('AS').id);
    S.eq('cards: parseCards splits on whitespace', C.parseCards('AS 5H 10D KC').length, 4);
    S.ok('cards: isRed(hearts)', C.isRed(C.makeCard(5, 1)));
    S.ok('cards: isRed(diamonds)', C.isRed(C.makeCard(5, 2)));
    S.ok('cards: !isRed(spades)', !C.isRed(C.makeCard(5, 0)));
    S.ok('cards: !isRed(clubs)', !C.isRed(C.makeCard(5, 3)));
  }

  // ------------------------------------------------------- countValue / heels ---

  function testCountValueAndHeels(S) {
    var C = root.Cribbage.Cards;
    var Sc = root.Cribbage.Scoring;

    S.eq('countValue: empty', Sc.countValue([]), 0);
    S.eq('countValue: KS 5H AD uses value not rank',
      Sc.countValue(C.parseCards('KS 5H AD')), 16);
    S.eq('countValue: four face cards', Sc.countValue(C.parseCards('JS QH KD 10C')), 40);
    S.eq('countValue: A 2 3 4 5', Sc.countValue(C.parseCards('AS 2H 3D 4C 5S')), 15);

    S.eq('heels: starter jack scores 2', Sc.scoreHeels(C.parseCard('JH')), 2);
    S.eq('heels: starter jack of spades scores 2', Sc.scoreHeels(C.parseCard('JS')), 2);
    S.eq('heels: starter jack of diamonds scores 2', Sc.scoreHeels(C.parseCard('JD')), 2);
    S.eq('heels: starter jack of clubs scores 2', Sc.scoreHeels(C.parseCard('JC')), 2);
    S.eq('heels: starter five scores 0', Sc.scoreHeels(C.parseCard('5S')), 0);
    S.eq('heels: starter queen scores 0', Sc.scoreHeels(C.parseCard('QS')), 0);
    S.eq('heels: starter ten scores 0', Sc.scoreHeels(C.parseCard('10S')), 0);
    // The starter jack is nobody's hand card, so heels and nobs can never double up.
    var res = Sc.scoreHand(C.parseCards('2H 5S 9D 8C'), C.parseCard('JH'), false);
    S.eq('heels: scoreHand never awards heels for a starter jack',
      pointsOfType(res.breakdown, 'nobs'), 0);
  }

  // -------------------------------------------------------------- show cases ---

  // [hand, starter, isCrib, expectedTotal, expectedParts?]
  // expectedParts is { fifteen, pair, run, flush, nobs }; omitted keys mean zero.
  var SHOW_CASES = [
    // --- worked examples straight out of the rules block ---
    ['3S 4H 5D 9C', 'KS', false, 5, { fifteen: 2, run: 3 }],
    ['AS 2H 3D 4C', '5S', false, 7, { fifteen: 2, run: 5 }],
    ['4S 5H 5D 6C', 'KS', false, 16, { fifteen: 8, pair: 2, run: 6 }],
    ['4S 4H 5D 5C', '6S', false, 24, { fifteen: 8, pair: 4, run: 12 }],
    ['2S 3H 4D 4C', '5S', false, 12, { fifteen: 2, pair: 2, run: 8 }],
    ['3S 4H 5D JC', 'QS', false, 7, { fifteen: 4, run: 3 }],
    ['10S JH QD KC', 'AS', false, 4, { run: 4 }],
    ['AS 2H KD QC', 'JS', false, 3, { run: 3 }],

    // --- maxima ---
    ['JS 5H 5D 5C', '5S', false, 29, { fifteen: 16, pair: 12, nobs: 1 }],
    ['JS 5H 5D 5C', '5S', true, 29, { fifteen: 16, pair: 12, nobs: 1 }],
    ['JH 5H 5D 5C', '5S', false, 28, { fifteen: 16, pair: 12 }],
    ['5S 5H 5D 5C', 'KH', false, 28, { fifteen: 16, pair: 12 }],
    ['5S 5H 5D 5C', '10H', false, 28, { fifteen: 16, pair: 12 }],
    ['5S 5H 5D 5C', 'JH', false, 28, { fifteen: 16, pair: 12 }],

    // --- the 24-hand family ---
    ['7S 7H 8D 8C', '9S', false, 24, { fifteen: 8, pair: 4, run: 12 }],
    ['5S 5H 6D 6C', '4S', false, 24, { fifteen: 8, pair: 4, run: 12 }],
    ['4S 4H 5D 6C', '6H', false, 24, { fifteen: 8, pair: 4, run: 12 }],
    ['4S 4H 4D 4C', '7S', false, 24, { fifteen: 12, pair: 12 }],
    ['6S 6H 6D 6C', '3S', false, 24, { fifteen: 12, pair: 12 }],
    ['7S 7H 7D 7C', 'AS', false, 24, { fifteen: 12, pair: 12 }],
    ['6S 7H 8D 9C', '6H', false, 16, { fifteen: 6, pair: 2, run: 8 }],
    ['6S 7H 8D 9C', '5S', false, 9, { fifteen: 4, run: 5 }],

    // --- run multiplicity shapes ---
    ['5S 5H 5D 6C', '7S', false, 17, { fifteen: 2, pair: 6, run: 9 }],
    ['3S 4H 5D 5C', '5H', false, 17, { fifteen: 2, pair: 6, run: 9 }],
    ['2S 3H 4D 5C', '6S', false, 9, { fifteen: 4, run: 5 }],
    ['3S 4H 5D 6C', '7S', false, 9, { fifteen: 4, run: 5 }],
    ['4S 5H 6D 7C', '8S', false, 9, { fifteen: 4, run: 5 }],
    ['5S 6H 7D 8C', '9S', false, 9, { fifteen: 4, run: 5 }],
    ['9S 10H JD QC', 'KS', false, 5, { run: 5 }],
    ['8S 9H 10D JC', 'QS', false, 5, { run: 5 }],
    ['8S 9H 10D JC', 'KS', false, 4, { run: 4 }],
    ['8S 8H 9D 10C', 'JS', false, 10, { pair: 2, run: 8 }],
    ['8S 8H 9D 9C', '10S', false, 16, { pair: 4, run: 12 }],
    ['8S 8H 9D 10C', '10H', false, 16, { pair: 4, run: 12 }],
    ['8S 9H 9D 9C', '10S', false, 15, { pair: 6, run: 9 }],
    ['8S 8H 8D 9C', '10S', false, 15, { pair: 6, run: 9 }],
    ['8S 8H 8D 8C', '9S', false, 12, { pair: 12 }],
    ['10S 10H JD QC', 'KS', false, 10, { pair: 2, run: 8 }],
    ['QS QH KD KC', 'JS', false, 16, { pair: 4, run: 12 }],
    ['10S 10H 10D JC', 'QS', false, 15, { pair: 6, run: 9 }],
    ['KS QH JD 10C', '9S', false, 5, { run: 5 }],
    ['KS KH KD KC', 'QS', false, 12, { pair: 12 }],
    ['10S 10H 10D 10C', 'JS', false, 12, { pair: 12 }],
    ['8S 10H QD KC', '9S', false, 3, { run: 3 }],
    ['8S 9H QD KC', 'JS', false, 3, { run: 3 }],
    ['8S 8H QD QC', 'KS', false, 4, { pair: 4 }],
    ['AS AH 2D 2C', '3S', false, 16, { pair: 4, run: 12 }],
    ['AS 2H 3D 4C', '2S', false, 10, { pair: 2, run: 8 }],
    ['AS 2H 3D 4C', '4S', false, 10, { pair: 2, run: 8 }],
    ['AS 2H 3D 4C', 'KS', false, 8, { fifteen: 4, run: 4 }],
    ['2S 3H 4D 5C', '3S', false, 12, { fifteen: 2, pair: 2, run: 8 }],
    ['2S 2H 3D 3C', '4S', false, 16, { pair: 4, run: 12 }],
    ['3S 3H 4D 4C', '5S', false, 20, { fifteen: 4, pair: 4, run: 12 }],
    ['6S 6H 7D 7C', '8S', false, 20, { fifteen: 4, pair: 4, run: 12 }],
    ['9S 9H 10D 10C', 'JS', false, 16, { pair: 4, run: 12 }],
    ['6S 6H 7D 8C', '9S', false, 16, { fifteen: 6, pair: 2, run: 8 }],
    ['4S 5H 6D 7C', '4H', false, 16, { fifteen: 6, pair: 2, run: 8 }],
    ['7S 8H 9D 10C', 'JS', false, 7, { fifteen: 2, run: 5 }],
    ['7S 8H 9D 10C', '6S', false, 9, { fifteen: 4, run: 5 }],

    // --- flushes: hand vs crib, four cards vs five ---
    ['2S 4S 6S 8S', '10H', false, 4, { flush: 4 }],
    ['2S 4S 6S 8S', '10H', true, 0, {}],
    ['2S 4S 6S 8S', '10S', false, 5, { flush: 5 }],
    ['2S 4S 6S 8S', '10S', true, 5, { flush: 5 }],
    ['2H 4H 6H 8H', '10S', false, 4, { flush: 4 }],
    ['2H 4H 6H 8H', '10S', true, 0, {}],
    ['2D 4D 6D 8D', '10S', false, 4, { flush: 4 }],
    ['2D 4D 6D 8D', '10S', true, 0, {}],
    ['2C 4C 6C 8C', '10S', false, 4, { flush: 4 }],
    ['2C 4C 6C 8C', '10S', true, 0, {}],
    // Five-card flushes in every suit. Suit-specific typos in the flush branch are
    // otherwise invisible to the hand-written cases.
    ['2H 4H 6H 8H', '10H', false, 5, { flush: 5 }],
    ['2H 4H 6H 8H', '10H', true, 5, { flush: 5 }],
    ['2D 4D 6D 8D', '10D', false, 5, { flush: 5 }],
    ['2D 4D 6D 8D', '10D', true, 5, { flush: 5 }],
    ['2C 4C 6C 8C', '10C', false, 5, { flush: 5 }],
    ['2C 4C 6C 8C', '10C', true, 5, { flush: 5 }],
    ['2S 3S 4S 9S', 'KH', false, 11, { fifteen: 4, run: 3, flush: 4 }],
    ['2S 3S 4S 9S', 'KH', true, 7, { fifteen: 4, run: 3 }],
    ['2S 4S 6S 9S', '10S', false, 9, { fifteen: 4, flush: 5 }],
    ['2S 4S 6S 9S', '10S', true, 9, { fifteen: 4, flush: 5 }],
    ['2S 4S 6S 9S', '10H', false, 8, { fifteen: 4, flush: 4 }],
    ['2S 4S 6S 9S', '10H', true, 4, { fifteen: 4 }],
    ['2H 5H 8H JH', '10H', false, 12, { fifteen: 6, flush: 5, nobs: 1 }],
    ['2H 5H 8H JH', '10H', true, 12, { fifteen: 6, flush: 5, nobs: 1 }],
    ['2H 5H 8H JH', '10S', false, 10, { fifteen: 6, flush: 4 }],
    ['2H 5H 8H JH', '10S', true, 6, { fifteen: 6 }],
    // Four of the five cards share a suit but the HAND does not — no flush at all.
    ['2S 4S 6S 8H', '10S', false, 0, {}],
    ['2S 4S 6S 8H', '10S', true, 0, {}],

    // --- nobs ---
    ['2H 5S 9D JC', '7C', false, 3, { fifteen: 2, nobs: 1 }],
    ['2H 5S 9D JC', '7C', true, 3, { fifteen: 2, nobs: 1 }],
    ['2H 5S 9D JC', '7H', false, 2, { fifteen: 2 }],
    ['2H 5S 9D JC', 'JH', false, 6, { fifteen: 4, pair: 2 }],
    ['2H 5S JH JC', '3H', false, 11, { fifteen: 8, pair: 2, nobs: 1 }],
    ['JS JH JD JC', '5S', false, 21, { fifteen: 8, pair: 12, nobs: 1 }],
    ['JS JH JD JC', '5H', false, 21, { fifteen: 8, pair: 12, nobs: 1 }],
    ['JS QH KD 10C', '9S', false, 6, { run: 5, nobs: 1 }],
    ['JS QH KD 10C', '9H', false, 5, { run: 5 }],
    ['JS QH KD 10C', '9S', true, 6, { run: 5, nobs: 1 }],

    // --- genuine zero hands ---
    ['AS 2H 6D 10C', 'KS', false, 0, {}],
    ['AS 2H 6D 10C', 'KS', true, 0, {}],
    ['2S 4H 7D 10C', 'KH', false, 0, {}],
    ['AS 3H 7D 10C', 'KH', false, 0, {}],
    ['AS 2H 7D 10C', 'KH', false, 0, {}],
    ['4S 8H QD KC', '2H', false, 0, {}],

    // --- runs must not wrap past the king ---
    ['QS KH AD 5C', '9S', false, 6, { fifteen: 6 }],
    ['KS AH 2D 7C', '9S', false, 0, {}],
    ['QS KH AD 2C', '7S', false, 0, {}],
    ['KS QH AD 3C', '8S', false, 0, {}],
    ['AS 2H QD KC', '7S', false, 0, {}],

    // --- fives and ten-cards: easy-to-verify fifteen counts ---
    ['5S 10H JD QC', 'KS', false, 12, { fifteen: 8, run: 4 }],
    ['5S 5H 10D JC', 'QS', false, 17, { fifteen: 12, pair: 2, run: 3 }],
    ['5S 5H 5D 10C', 'JS', false, 20, { fifteen: 14, pair: 6 }],
    ['5S 5H 5D KC', 'KS', false, 22, { fifteen: 14, pair: 8 }],
    ['5S 5H KD KC', 'KH', false, 20, { fifteen: 12, pair: 8 }],
    ['5S KS KH KD', 'KC', false, 20, { fifteen: 8, pair: 12 }],
    ['9S 9H 9D 9C', '6S', false, 20, { fifteen: 8, pair: 12 }],
    ['AS AH AD AC', '2S', false, 12, { pair: 12 }],
    ['4S 4H 4D 4C', 'KS', false, 12, { pair: 12 }],
    ['2S 2H 2D 2C', 'KS', false, 12, { pair: 12 }],
    ['3S 3H 3D 3C', '6S', false, 20, { fifteen: 8, pair: 12 }],
    ['8S 8H 8D 8C', 'KS', false, 12, { pair: 12 }],
    ['7S 8H JD QC', 'KS', false, 5, { fifteen: 2, run: 3 }],
    ['6S 9H 10D KC', '5S', false, 6, { fifteen: 6 }],

    // --- crib versions of non-flush hands must be identical to hand scoring ---
    ['3S 4H 5D 9C', 'KS', true, 5, { fifteen: 2, run: 3 }],
    ['4S 4H 5D 5C', '6S', true, 24, { fifteen: 8, pair: 4, run: 12 }],
    ['4S 5H 5D 6C', 'KS', true, 16, { fifteen: 8, pair: 2, run: 6 }],
    ['7S 7H 8D 8C', '9S', true, 24, { fifteen: 8, pair: 4, run: 12 }],
    ['AS 2H 3D 4C', '5S', true, 7, { fifteen: 2, run: 5 }],
    ['10S JH QD KC', 'AS', true, 4, { run: 4 }],
    ['5S 5H 5D 5C', 'KH', true, 28, { fifteen: 16, pair: 12 }],
    ['QS KH AD 5C', '9S', true, 6, { fifteen: 6 }]
  ];

  function testShow(S) {
    var C = root.Cribbage.Cards;
    var Sc = root.Cribbage.Scoring;
    var Naive = root.Cribbage.ScoringNaive;

    for (var i = 0; i < SHOW_CASES.length; i++) {
      var tc = SHOW_CASES[i];
      var handStr = tc[0];
      var starterStr = tc[1];
      var isCrib = tc[2];
      var expected = tc[3];
      var parts = tc[4];

      var hand = C.parseCards(handStr);
      var starter = C.parseCard(starterStr);
      var label = (isCrib ? 'crib' : 'hand') + ' [' + handStr + '] + ' + starterStr;
      var detail = 'cards: ' + handStr + ' starter ' + starterStr +
        ' (' + (isCrib ? 'crib' : 'hand') + ')';

      var before = snapshot(hand, starter);
      var res = Sc.scoreHand(hand, starter, isCrib);

      S.eq('show: ' + label + ' total', res.total, expected, detail);
      S.eq('show: ' + label + ' breakdown sums to total',
        totalPoints(res.breakdown), res.total, detail);
      S.eq('show: ' + label + ' leaves its arguments untouched',
        snapshot(hand, starter), before, detail);

      // Breakdown must be ordered fifteens -> pairs -> runs -> flush -> nobs.
      var order = { fifteen: 0, pair: 1, run: 2, flush: 3, nobs: 4 };
      var ordered = true;
      var last = -1;
      for (var b = 0; b < res.breakdown.length; b++) {
        var rank = order[res.breakdown[b].type];
        if (rank === undefined || rank < last) ordered = false;
        else last = rank;
        if (!res.breakdown[b].label) ordered = false;
        if (!res.breakdown[b].cards || !res.breakdown[b].cards.length) ordered = false;
      }
      S.ok('show: ' + label + ' breakdown is well-formed and ordered', ordered,
        detail + ' -> ' + JSON.stringify(res.breakdown.map(function (e) {
          return e.type + ':' + e.points;
        })));

      if (parts) {
        var types = ['fifteen', 'pair', 'run', 'flush', 'nobs'];
        for (var t = 0; t < types.length; t++) {
          var want = parts[types[t]] || 0;
          S.eq('show: ' + label + ' ' + types[t] + ' points',
            pointsOfType(res.breakdown, types[t]), want, detail);
        }
      }

      // The independent implementation must agree on every hand-written case too.
      S.eq('show: ' + label + ' matches scoring-naive.js',
        Naive.scoreHandTotal(hand, starter, isCrib), res.total, detail);

      // Order of the four hand cards must never matter.
      var permOk = true;
      var permBad = '';
      for (var p = 0; p < PERMS_4.length; p++) {
        var perm = [hand[PERMS_4[p][0]], hand[PERMS_4[p][1]],
          hand[PERMS_4[p][2]], hand[PERMS_4[p][3]]];
        var permTotal = Sc.scoreHand(perm, starter, isCrib).total;
        if (permTotal !== expected) {
          permOk = false;
          permBad = C.cardNames(perm) + ' -> ' + permTotal;
          break;
        }
      }
      S.ok('show: ' + label + ' is invariant under permutation of the hand', permOk,
        permBad ? detail + ' (' + permBad + ')' : detail);
    }

    // A hand can hold at most eight fifteens; confirm we actually count all eight.
    var maxFifteens = Sc.scoreHand(C.parseCards('JS 5H 5D 5C'), C.parseCard('5S'), false);
    S.eq('show: the 29 hand contains exactly eight fifteens',
      pointsOfType(maxFifteens.breakdown, 'fifteen') / 2, 8);
    S.eq('show: the 29 hand contains exactly six pairs',
      pointsOfType(maxFifteens.breakdown, 'pair') / 2, 6);
    S.eq('show: fifteens are labelled cumulatively',
      maxFifteens.breakdown[0].label + '/' + maxFifteens.breakdown[7].label,
      'Fifteen two/Fifteen sixteen');
    S.eq('show: the 29 hand is the documented maximum', maxFifteens.total, 29);
    S.eq('show: nobs is labelled "His nob"',
      maxFifteens.breakdown[maxFifteens.breakdown.length - 1].label, 'His nob');

    // Flush labels carry their size, which the counting animation reads.
    S.eq('show: four-card flush label',
      Sc.scoreHand(C.parseCards('2S 4S 6S 8S'), C.parseCard('10H'), false)
        .breakdown[0].label, 'Flush (4)');
    S.eq('show: five-card flush label',
      Sc.scoreHand(C.parseCards('2S 4S 6S 8S'), C.parseCard('10S'), false)
        .breakdown[0].label, 'Flush (5)');
    S.eq('show: five-card flush entry lists all five cards',
      Sc.scoreHand(C.parseCards('2S 4S 6S 8S'), C.parseCard('10S'), false)
        .breakdown[0].cards.length, 5);
    S.eq('show: four-card flush entry lists four cards',
      Sc.scoreHand(C.parseCards('2S 4S 6S 8S'), C.parseCard('10H'), false)
        .breakdown[0].cards.length, 4);
    S.eq('show: run label reads "Run of four"',
      Sc.scoreHand(C.parseCards('10S JH QD KC'), C.parseCard('AS'), false)
        .breakdown[0].label, 'Run of four');
    var pairHand = Sc.scoreHand(C.parseCards('5S 5H 2D 9C'), C.parseCard('KS'), false);
    var firstPair = pairHand.breakdown.filter(function (e) { return e.type === 'pair'; })[0];
    S.eq('show: pair label names the rank', firstPair.label, 'Pair of fives');
    S.eq('show: pair entry lists both cards', firstPair.cards.length, 2);
    var kingPair = Sc.scoreHand(C.parseCards('KS KH 2D 9C'), C.parseCard('7S'), false);
    S.eq('show: pair label pluralises kings',
      kingPair.breakdown.filter(function (e) { return e.type === 'pair'; })[0].label,
      'Pair of kings');

    // Same-rank cards must collapse into ONE breakdown entry, so the counting animation
    // gives a pair royal a single six-point beat instead of three two-point beats.
    function pairEntries(res) {
      return res.breakdown.filter(function (e) { return e.type === 'pair'; });
    }
    var royal = Sc.scoreHand(C.parseCards('5S 5H 5D 9C'), C.parseCard('KS'), false);
    S.eq('show: pair royal is a single breakdown entry', pairEntries(royal).length, 1);
    S.eq('show: pair royal entry is worth six', pairEntries(royal)[0].points, 6);
    S.eq('show: pair royal entry lists all three cards',
      pairEntries(royal)[0].cards.length, 3);
    S.eq('show: pair royal label', pairEntries(royal)[0].label, 'Pair royal of fives');

    var dblRoyal = Sc.scoreHand(C.parseCards('5S 5H 5D 5C'), C.parseCard('KS'), false);
    S.eq('show: double pair royal is a single breakdown entry',
      pairEntries(dblRoyal).length, 1);
    S.eq('show: double pair royal entry is worth twelve',
      pairEntries(dblRoyal)[0].points, 12);
    S.eq('show: double pair royal label', pairEntries(dblRoyal)[0].label,
      'Double pair royal of fives');

    // Two distinct pairs must stay as two entries — they are announced separately.
    var twoPair = Sc.scoreHand(C.parseCards('5S 5H KD KC'), C.parseCard('9S'), false);
    S.eq('show: two distinct pairs stay as two entries', pairEntries(twoPair).length, 2);
    S.deepEq('show: two distinct pairs are labelled separately',
      pairEntries(twoPair).map(function (e) { return e.label; }),
      ['Pair of fives', 'Pair of kings']);

    // The 29 hand's four fives must be one twelve-point entry, not six two-point ones.
    S.eq('show: the 29 hand has a single pair entry', pairEntries(maxFifteens).length, 1);
    S.eq('show: the 29 hand pair entry is worth twelve',
      pairEntries(maxFifteens)[0].points, 12);

    // Every breakdown entry must sum to the reported total — the animation walks these
    // entries, so a total that disagrees with them would peg the wrong number of holes.
    var sumOk = true;
    var sumBad = '';
    for (var sc = 0; sc < SHOW_CASES.length; sc++) {
      var scase = SHOW_CASES[sc];
      var sres = Sc.scoreHand(C.parseCards(scase[0]), C.parseCard(scase[1]), scase[2]);
      var esum = sres.breakdown.reduce(function (acc, e) { return acc + e.points; }, 0);
      if (esum !== sres.total) {
        sumOk = false;
        sumBad = scase[0] + ' + ' + scase[1] + ': entries ' + esum +
          ' vs total ' + sres.total;
        break;
      }
    }
    S.ok('show: breakdown entries always sum to the total', sumOk, sumBad);

    // A double run emits one entry per actual run so each animation beat is a real run.
    var doubleRun = Sc.scoreHand(C.parseCards('4S 5H 5D 6C'), C.parseCard('KS'), false);
    var runEntries = doubleRun.breakdown.filter(function (e) { return e.type === 'run'; });
    S.eq('show: a double run emits two run entries', runEntries.length, 2);
    S.eq('show: each double-run entry is worth three', runEntries[0].points, 3);
    S.eq('show: each double-run entry lists three cards', runEntries[0].cards.length, 3);
  }

  // -------------------------------------------------------------- play cases ---

  // [name, sequence, expectedPointsPerCard]
  var PLAY_CASES = [
    // The rules-block worked examples. Note 5-4-6 also totals fifteen, so the third
    // card is worth 2 (fifteen) + 3 (run) = 5.
    ['5,4,6 -> run of three plus fifteen', '5H 4S 6D', [0, 0, 5]],
    ['5,4,7,6 -> run of four', '5H 4S 7D 6C', [0, 0, 0, 4]],
    ['3,5,4,7,6 -> run of three then run of five', '3H 5S 4D 7C 6H', [0, 0, 3, 0, 5]],
    ['5,4,5,6 -> run of three only, never four', '5H 4S 5D 6C', [0, 0, 0, 3]],
    ['3,3,4,5 -> pair, nothing, then run of three at fifteen', '3H 3S 4D 5C', [0, 2, 0, 5]],

    // Pairs, pair royal, double pair royal.
    ['5,5,5,5 -> pair ladder (third five also makes fifteen)', '5H 5S 5D 5C', [0, 2, 8, 12]],
    ['3,3,3,3 -> pair ladder', '3H 3S 3D 3C', [0, 2, 6, 12]],
    ['A,A,A,A -> pair ladder', 'AH AS AD AC', [0, 2, 6, 12]],
    ['7,7 -> plain pair', '7H 7S', [0, 2]],
    ['5,6,5,5 -> trailing pair only, not pair royal', '5H 6S 5D 5C', [0, 0, 0, 2]],
    ['4,4,5,6 -> pair then run of three', '4H 4S 5D 6C', [0, 2, 0, 3]],

    // Exact fifteen and exact thirty-one.
    ['9,6 -> fifteen two', '9H 6S', [0, 2]],
    ['10,5 -> fifteen two', '10H 5S', [0, 2]],
    ['5,10 -> fifteen two', '5H 10S', [0, 2]],
    ['J,5 -> fifteen two (jack counts ten)', 'JH 5S', [0, 2]],
    ['6,9 -> fifteen two', '6H 9S', [0, 2]],
    ['single card can never score', '5H', [0]],
    ['10,10,10,A -> pair royal then thirty-one', '10H 10S 10D AC', [0, 2, 6, 2]],
    ['9,9,K,3 -> pair then thirty-one', '9H 9S KD 3C', [0, 2, 0, 2]],
    ['7,8,J,6 -> fifteen then thirty-one', '7H 8S JD 6C', [0, 2, 0, 2]],
    ['6,7,8,10 -> run of three then thirty-one', '6H 7S 8D 10C', [0, 0, 3, 2]],

    // Thirty-one does NOT swallow whatever else the same card scores. Reaching 31 ends
    // the series, but the card that got there still takes its pair or its run on top of
    // the two. Every combination of 31 with another category is pinned down here; without
    // these rows an "if (count === 31) return" short-circuit passes the whole suite.
    ['K,6,4,5,6 -> thirty-one plus a run of three', 'KH 6S 4D 5H 6C', [0, 0, 0, 3, 5]],
    ['K,5,8,8 -> thirty-one plus a pair', 'KH 5S 8D 8C', [0, 2, 0, 4]],
    ['7,8,8,8 -> thirty-one plus a pair royal', '7H 8S 8D 8C', [0, 2, 2, 8]],
    ['3,7,7,7,7 -> thirty-one plus a double pair royal', '3H 7S 7D 7C 7H',
      [0, 0, 2, 6, 14]],
    ['A,6,7,8,9 -> thirty-one plus a run of four', 'AH 6S 7D 8C 9H', [0, 0, 0, 3, 6]],
    ['A,4,5,6,7,8 -> thirty-one plus a run of five', 'AH 4S 5D 6C 7H 8S',
      [0, 0, 0, 3, 4, 7]],
    ['K,A,2,3,4,5,6 -> thirty-one plus a run of six', 'KH AS 2D 3C 4H 5S 6D',
      [0, 0, 0, 3, 4, 5, 8]],
    ['3,A,2,3,4,5,6,7 -> thirty-one plus a run of seven', '3H AS 2D 3C 4H 5S 6D 7C',
      [0, 0, 3, 3, 4, 5, 6, 9]],
    // The matching fifteen combinations, for symmetry with the thirty-one rows above.
    ['2,9,A,A,A,A -> fifteen plus a double pair royal', '2H 9S AH AS AD AC',
      [0, 0, 0, 2, 6, 14]],
    ['2,3,A,2,3,4 -> fifteen plus a run of four', '2H 3S AD 2C 3H 4S', [0, 0, 3, 3, 3, 6]],

    // A card that scores a pair AND a fifteen at once.
    ['4,3,4,4 -> fifteen and a pair on the last card', '4H 3S 4D 4C', [0, 0, 0, 4]],
    ['7,7,A -> pair then fifteen', '7H 7S AD', [0, 2, 2]],

    // A card that scores a run AND a fifteen at once.
    ['6,4,5 -> fifteen and run of three', '6H 4S 5D', [0, 0, 5]],
    ['4,5,6 -> fifteen and run of three', '4H 5S 6D', [0, 0, 5]],
    ['2,4,3,6 -> run of three then fifteen', '2H 4S 3D 6C', [0, 0, 3, 2]],

    // Runs are order-independent inside the trailing window.
    ['7,9,8 -> run of three out of order', '7H 9S 8D', [0, 0, 3]],
    ['A,3,2 -> run of three out of order', 'AH 3S 2D', [0, 0, 3]],
    ['2,3,A,4 -> run of three then four', '2H 3S AD 4C', [0, 0, 3, 4]],
    ['A,2,3,4 -> run of three then four', 'AH 2S 3D 4C', [0, 0, 3, 4]],
    ['A,2,3,4,5 -> ladder up to a run of five at fifteen', 'AH 2S 3D 4C 5H',
      [0, 0, 3, 4, 7]],
    ['A..7 -> ladder up to a run of seven', 'AH 2S 3D 4C 5H 6D 7C',
      [0, 0, 3, 4, 7, 6, 7]],
    ['4,5,6,7,8 -> ladder of runs', '4H 5S 6D 7C 8H', [0, 0, 5, 4, 5]],
    ['9,8,7,6 -> descending run', '9H 8S 7D 6C', [0, 0, 3, 4]],
    ['2,2,3,4,5 -> pair breaks the window, then runs resume', '2H 2S 3D 4C 5H',
      [0, 2, 0, 3, 4]],
    ['7,8 then 9 -> fifteen then run of three', '7H 8S 9D', [0, 2, 3]],
    ['8,7,8 -> fifteen then nothing', '8H 7S 8D', [0, 2, 0]],
    ['J,Q,K -> run of three on face cards', 'JH QS KD', [0, 0, 3]],

    // Runs must not wrap past the king during the play either.
    ['Q,K,A -> no wrap', 'QH KS AD', [0, 0, 0]],
    ['K,A,2 -> no wrap', 'KH AS 2D', [0, 0, 0]],
    ['A,K,2,Q -> no wrap', 'AH KS 2D QC', [0, 0, 0, 0]]
  ];

  // A compact description of WHICH categories fired on a played card and for how much,
  // e.g. 'thirtyone2+run3'. Hand-written play cases are only as good as the set of
  // signatures they reach: PLAY_CASES once contained four sequences that hit 31 and in
  // every one of them the 31 card scored nothing else, so "reaching 31 ends the series,
  // therefore nothing else scores" was consistent with a fully green suite.
  function playSignature(res) {
    if (!res.breakdown.length) return 'none';
    var parts = [];
    for (var i = 0; i < res.breakdown.length; i++) {
      parts.push(res.breakdown[i].type + res.breakdown[i].points);
    }
    return parts.join('+');
  }

  function playCaseSignatures() {
    var C = root.Cribbage.Cards;
    var Sc = root.Cribbage.Scoring;
    var seen = {};
    for (var i = 0; i < PLAY_CASES.length; i++) {
      var cards = C.parseCards(PLAY_CASES[i][1]);
      var series = [];
      for (var j = 0; j < cards.length; j++) {
        seen[playSignature(Sc.scorePlay(series, cards[j]))] = true;
        series.push(cards[j]);
      }
    }
    return seen;
  }

  // Streams every deck-legal play situation whose series holds at most maxCards cards.
  // scorePlay reads only .rank and .value, so suits cannot affect the answer and one card
  // object per rank is enough; what does matter is that no rank appears more than four
  // times and that the running count never passes 31. A two-player series tops out at
  // eight cards, four from each hand, so maxCards = 8 is the whole reachable space.
  // visit(series, playedCard, count) fires once per situation; series is reused, so a
  // visitor that wants to keep it must copy it.
  function enumeratePlaySituations(maxCards, visit) {
    var C = root.Cribbage.Cards;
    var byRank = [];
    var used = [];
    for (var r = 1; r <= 13; r++) {
      byRank.push(C.makeCard(r, 0));
      used.push(0);
    }
    var series = [];
    var visited = 0;
    (function rec(count) {
      for (var i = 0; i < 13; i++) {
        if (used[i] >= 4) continue;
        var card = byRank[i];
        var next = count + card.value;
        if (next > 31) continue;
        visited++;
        visit(series, card, next);
        if (series.length + 1 < maxCards) {
          used[i]++;
          series.push(card);
          rec(next);
          series.pop();
          used[i]--;
        }
      }
    })(0);
    return visited;
  }

  // Differential verification of the play, the counterpart of the C(52,5) show pass:
  // enumerate every reachable situation, check scoring.js against the independent
  // scoring-naive.js, and confirm the hand-written table reaches every combination the
  // enumeration proves is possible.
  function checkPlayEnumeration(S, maxCards, expectedSituations, expectedCombos, label) {
    var Cards = root.Cribbage.Cards;
    var Sc = root.Cribbage.Scoring;
    var Naive = root.Cribbage.ScoringNaive;

    var disagreements = [];
    var sumViolations = [];
    var reachable = {};

    var visited = enumeratePlaySituations(maxCards, function (series, card) {
      var res = Sc.scorePlay(series, card);
      var naive = Naive.scorePlayTotal(series, card);
      if (res.points !== naive && disagreements.length < 5) {
        disagreements.push(Cards.cardNames(series) + ' + ' + Cards.cardName(card) +
          ': scoring.js=' + res.points + ' scoring-naive.js=' + naive);
      }
      if (totalPoints(res.breakdown) !== res.points && sumViolations.length < 5) {
        sumViolations.push(Cards.cardNames(series) + ' + ' + Cards.cardName(card) +
          ': points=' + res.points + ' breakdown=' + totalPoints(res.breakdown));
      }
      reachable[playSignature(res)] = true;
    });

    var reachableKeys = Object.keys(reachable).sort();
    var covered = playCaseSignatures();
    var uncovered = reachableKeys.filter(function (k) { return !covered[k]; });

    S.eq(label + ': play situations enumerated', visited, expectedSituations);
    S.ok(label + ': scoring.js and scoring-naive.js agree on all ' + visited +
      ' play situations', disagreements.length === 0,
      disagreements.join('\n          '));
    S.ok(label + ': every play breakdown sums to its points',
      sumViolations.length === 0, sumViolations.join('\n          '));
    S.eq(label + ': distinct scoring-category combinations reachable',
      reachableKeys.length, expectedCombos, reachableKeys.join(', '));
    S.ok(label + ': PLAY_CASES exercises every reachable category combination',
      uncovered.length === 0, 'not exercised by any hand-written sequence: ' +
      uncovered.join(', '));

    return reachableKeys;
  }

  function testPlay(S) {
    var C = root.Cribbage.Cards;
    var Sc = root.Cribbage.Scoring;

    for (var i = 0; i < PLAY_CASES.length; i++) {
      var name = PLAY_CASES[i][0];
      var cards = C.parseCards(PLAY_CASES[i][1]);
      var expected = PLAY_CASES[i][2];
      var series = [];
      for (var j = 0; j < cards.length; j++) {
        var before = snapshot(series, cards[j]);
        var res = Sc.scorePlay(series, cards[j]);
        S.eq('play: ' + name + ' | card ' + (j + 1) + ' (' + C.cardName(cards[j]) + ')',
          res.points, expected[j],
          'series so far: ' + (C.cardNames(series) || '(empty)') +
          ', count now ' + Sc.countValue(series.concat([cards[j]])));
        S.eq('play: ' + name + ' | card ' + (j + 1) + ' breakdown sums to points',
          totalPoints(res.breakdown), res.points);
        S.eq('play: ' + name + ' | card ' + (j + 1) + ' leaves arguments untouched',
          snapshot(series, cards[j]), before);
        series.push(cards[j]);
      }
    }

    // Breakdown shape / types.
    var r1 = Sc.scorePlay(C.parseCards('5H 4S'), C.parseCard('6D'));
    S.deepEq('play: 5,4,6 breakdown types', r1.breakdown.map(function (e) { return e.type; }),
      ['fifteen', 'run']);
    S.eq('play: fifteen label', r1.breakdown[0].label, 'Fifteen two');
    S.eq('play: run label', r1.breakdown[1].label, 'Run of three');
    S.eq('play: run entry lists the three run cards', r1.breakdown[1].cards.length, 3);

    var r2 = Sc.scorePlay(C.parseCards('10H 10S 10D'), C.parseCard('AC'));
    S.deepEq('play: thirty-one breakdown types',
      r2.breakdown.map(function (e) { return e.type; }), ['thirtyone']);
    S.eq('play: thirty-one label', r2.breakdown[0].label, 'Thirty-one for two');

    var r3 = Sc.scorePlay(C.parseCards('5H 5S'), C.parseCard('5D'));
    S.eq('play: pair royal is worth six', pointsOfType(r3.breakdown, 'pair'), 6);
    S.eq('play: pair royal plus the fifteen totals eight', r3.points, 8);
    S.eq('play: pair royal label',
      r3.breakdown[pointsOfType(r3.breakdown, 'fifteen') ? 1 : 0].label,
      'Pair royal of fives');

    var r4 = Sc.scorePlay(C.parseCards('5H 5S 5D'), C.parseCard('5C'));
    S.eq('play: double pair royal is worth twelve', pointsOfType(r4.breakdown, 'pair'), 12);
    S.eq('play: double pair royal label', r4.breakdown[0].label,
      'Double pair royal of fives');

    // Pairs during the play never span a broken block, so a run and a pair can never
    // be scored by the same card.
    var bothOk = true;
    var seqs = ['5H 4S 6D', '5H 6S 5D 5C', '3H 3S 4D 5C', '4H 4S 5D 6C'];
    for (var q = 0; q < seqs.length; q++) {
      var cs = C.parseCards(seqs[q]);
      var ser = [];
      for (var w = 0; w < cs.length; w++) {
        var rr = Sc.scorePlay(ser, cs[w]);
        if (pointsOfType(rr.breakdown, 'pair') > 0 && pointsOfType(rr.breakdown, 'run') > 0) {
          bothOk = false;
        }
        ser.push(cs[w]);
      }
    }
    S.ok('play: a single card never scores both a pair and a run', bothOk);

    // The empty-series case: leading a card can only ever score zero.
    var leadOk = true;
    var deck = C.makeDeck();
    for (var d = 0; d < deck.length; d++) {
      if (Sc.scorePlay([], deck[d]).points !== 0) leadOk = false;
    }
    S.ok('play: leading any card into an empty series scores nothing', leadOk);

    // Reaching 31 never suppresses the rest of the card's score. Pinned separately from
    // PLAY_CASES because this is the exact misconception the table used to miss.
    var thirtyOnePair = Sc.scorePlay(C.parseCards('KH 5S 8D'), C.parseCard('8C'));
    S.eq('play: thirty-one plus a pair scores four', thirtyOnePair.points, 4);
    S.deepEq('play: thirty-one and a pair both appear in the breakdown',
      thirtyOnePair.breakdown.map(function (e) { return e.type; }), ['thirtyone', 'pair']);
    var thirtyOneRun = Sc.scorePlay(C.parseCards('KH 6S 4D 5H'), C.parseCard('6C'));
    S.eq('play: thirty-one plus a run of three scores five', thirtyOneRun.points, 5);
    S.deepEq('play: thirty-one and a run both appear in the breakdown',
      thirtyOneRun.breakdown.map(function (e) { return e.type; }), ['thirtyone', 'run']);
    S.eq('play: the run scored alongside thirty-one is the longest valid trailing window',
      thirtyOneRun.breakdown[1].cards.length, 3);

    // Bounded differential against scoring-naive.js: every deck-legal situation whose
    // series holds at most five cards. The --exhaustive pass extends this to all eight.
    checkPlayEnumeration(S, 5, 182587, 19, 'play');
  }

  // ------------------------------------------------------------- exhaustive ---

  function runExhaustive(S, options) {
    var Cards = root.Cribbage.Cards;
    var Scoring = root.Cribbage.Scoring;
    var Naive = root.Cribbage.ScoringNaive;
    var log = options.log || function () {};
    var onProgress = options.onProgress || function () {};

    var TOTAL_COMBOS = 2598960;
    var TOTAL_PAIRS = TOTAL_COMBOS * 5;
    var IMPOSSIBLE = { 19: true, 25: true, 26: true, 27: true };

    var deck = Cards.makeDeck();
    var histHand = [];
    var histCrib = [];
    for (var z = 0; z <= 40; z++) { histHand.push(0); histCrib.push(0); }

    var badScores = [];
    var disagreements = [];
    var diffViolations = [];
    var outOfRange = [];
    var bestHands = [];
    var maxHandScore = -1;
    var maxCribScore = -1;
    var pairsChecked = 0;
    var combosChecked = 0;

    var progressStep = Math.floor(TOTAL_COMBOS / 10);
    var nextProgress = progressStep;
    var started = Date.now();

    // Streamed: only five card references and a four-slot hand buffer are ever live.
    var combo = [null, null, null, null, null];
    var hand = [null, null, null, null];

    for (var i0 = 0; i0 < 48; i0++) {
      combo[0] = deck[i0];
      for (var i1 = i0 + 1; i1 < 49; i1++) {
        combo[1] = deck[i1];
        for (var i2 = i1 + 1; i2 < 50; i2++) {
          combo[2] = deck[i2];
          for (var i3 = i2 + 1; i3 < 51; i3++) {
            combo[3] = deck[i3];
            for (var i4 = i3 + 1; i4 < 52; i4++) {
              combo[4] = deck[i4];
              combosChecked++;

              for (var s = 0; s < 5; s++) {
                var m = 0;
                for (var t = 0; t < 5; t++) {
                  if (t !== s) hand[m++] = combo[t];
                }
                var starter = combo[s];

                var handScore = Scoring.scoreHand(hand, starter, false).total;
                var cribScore = Scoring.scoreHand(hand, starter, true).total;
                var naiveHand = Naive.scoreHandTotal(hand, starter, false);
                var naiveCrib = Naive.scoreHandTotal(hand, starter, true);
                pairsChecked++;

                // (a) impossible scores
                if (IMPOSSIBLE[handScore] && badScores.length < 5) {
                  badScores.push('hand ' + Cards.cardNames(hand) + ' + ' +
                    Cards.cardName(starter) + ' scored ' + handScore);
                }
                if (IMPOSSIBLE[cribScore] && badScores.length < 5) {
                  badScores.push('crib ' + Cards.cardNames(hand) + ' + ' +
                    Cards.cardName(starter) + ' scored ' + cribScore);
                }

                // (c) differential agreement with the independent implementation
                if (handScore !== naiveHand && disagreements.length < 5) {
                  disagreements.push('HAND ' + Cards.cardNames(hand) + ' + ' +
                    Cards.cardName(starter) + ': scoring.js=' + handScore +
                    ' scoring-naive.js=' + naiveHand);
                }
                if (cribScore !== naiveCrib && disagreements.length < 5) {
                  disagreements.push('CRIB ' + Cards.cardNames(hand) + ' + ' +
                    Cards.cardName(starter) + ': scoring.js=' + cribScore +
                    ' scoring-naive.js=' + naiveCrib);
                }

                // (d) hand and crib may differ only on an unextended four-card flush
                var suit0 = hand[0].suit;
                var fourFlush = hand[1].suit === suit0 && hand[2].suit === suit0 &&
                  hand[3].suit === suit0;
                var expectedDiff = (fourFlush && starter.suit !== suit0) ? 4 : 0;
                if (handScore - cribScore !== expectedDiff && diffViolations.length < 5) {
                  diffViolations.push(Cards.cardNames(hand) + ' + ' +
                    Cards.cardName(starter) + ': hand=' + handScore + ' crib=' + cribScore +
                    ' expected difference ' + expectedDiff);
                }

                // (b) maximum, plus the histogram
                if (handScore < 0 || handScore > 40 || cribScore < 0 || cribScore > 40) {
                  if (outOfRange.length < 5) {
                    outOfRange.push(Cards.cardNames(hand) + ' + ' + Cards.cardName(starter));
                  }
                } else {
                  histHand[handScore]++;
                  histCrib[cribScore]++;
                }
                if (handScore > maxHandScore) {
                  maxHandScore = handScore;
                  bestHands.length = 0;
                }
                if (handScore === maxHandScore && bestHands.length < 8) {
                  bestHands.push(Cards.cardNames(hand) + ' + ' + Cards.cardName(starter));
                }
                if (cribScore > maxCribScore) maxCribScore = cribScore;
              }

              if (combosChecked >= nextProgress) {
                var pct = Math.round((combosChecked / TOTAL_COMBOS) * 100);
                var msg = '    ' + pct + '%  ' + combosChecked + ' / ' + TOTAL_COMBOS +
                  ' combinations  (' + ((Date.now() - started) / 1000).toFixed(1) + 's)';
                log(msg);
                onProgress(combosChecked, TOTAL_COMBOS);
                nextProgress += progressStep;
              }
            }
          }
        }
      }
    }

    log('    done in ' + ((Date.now() - started) / 1000).toFixed(1) + 's');

    S.eq('exhaustive: five-card combinations enumerated', combosChecked, TOTAL_COMBOS);
    S.eq('exhaustive: (hand, starter) pairs scored', pairsChecked, TOTAL_PAIRS);
    S.ok('exhaustive: every score landed in a sane range', outOfRange.length === 0,
      outOfRange.join(' | '));
    S.ok('exhaustive: no hand or crib ever scores 19, 25, 26 or 27',
      badScores.length === 0, badScores.join(' | '));
    S.eq('exhaustive: maximum hand score', maxHandScore, 29);
    S.eq('exhaustive: maximum crib score', maxCribScore, 29);
    S.eq('exhaustive: exactly four (hand, starter) pairs score 29', histHand[29], 4,
      bestHands.join(' | '));
    S.ok('exhaustive: scoring.js and scoring-naive.js agree on all ' + TOTAL_PAIRS +
      ' cases (hand and crib)', disagreements.length === 0, disagreements.join('\n          '));
    S.ok('exhaustive: hand and crib scores differ only on unextended four-card flushes, ' +
      'and then by exactly 4', diffViolations.length === 0,
      diffViolations.join('\n          '));

    S.histogram = { hand: histHand.slice(0, 30), crib: histCrib.slice(0, 30) };

    log('');
    log('  Hand score histogram over all ' + TOTAL_PAIRS + ' (hand, starter) pairs:');
    log('    score            hand count        crib count');
    for (var sc = 0; sc <= 29; sc++) {
      log('      ' + String(sc).padStart(2, ' ') + '   ' +
        String(histHand[sc]).padStart(18, ' ') + String(histCrib[sc]).padStart(18, ' '));
    }
    log('');
    log('  The four 29 hands: ' + bestHands.join(', '));

    // The play half of the exhaustive pass: every deck-legal situation, all eight cards
    // deep. The show side has C(52,5); this is its equivalent, and without it the only
    // verification the play ever had was the hand-written PLAY_CASES table.
    log('');
    log('  Enumerating every deck-legal play situation (up to 8 cards, count <= 31)...');
    var playStarted = Date.now();
    var combos = checkPlayEnumeration(S, 8, 12892167, 25, 'exhaustive');
    log('    done in ' + ((Date.now() - playStarted) / 1000).toFixed(1) + 's');
    log('');
    log('  Reachable scoring-category combinations during the play (' + combos.length + '):');
    log('    ' + combos.join(', '));
  }

  // ---------------------------------------------------------------------- run ---

  function run(options) {
    options = options || {};
    var S = new Suite(options);

    if (!root.Cribbage || !root.Cribbage.Cards || !root.Cribbage.Scoring ||
        !root.Cribbage.ScoringNaive) {
      S.ok('modules loaded (cards.js, scoring.js, scoring-naive.js)', false);
      return { passed: S.passed, failed: S.failed, results: S.results, histogram: null };
    }

    testCards(S);
    testCountValueAndHeels(S);
    testShow(S);
    testPlay(S);

    if (options.exhaustive) {
      (options.log || function () {})('');
      (options.log || function () {})('  Running exhaustive verification over all ' +
        'C(52,5) = 2,598,960 combinations...');
      runExhaustive(S, options);
    }

    return {
      passed: S.passed,
      failed: S.failed,
      results: S.results,
      histogram: S.histogram
    };
  }

  root.Cribbage = root.Cribbage || {};
  root.Cribbage.Tests = {
    run: run,
    showCaseCount: SHOW_CASES.length,
    playCaseCount: PLAY_CASES.length
  };
})(typeof window !== 'undefined' ? window : globalThis);
