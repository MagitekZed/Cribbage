(function (root) {
  'use strict';

  // Cribbage.EngineTests.run(options) -> { passed, failed, results }
  // Driven by both tools/run-tests.js (Node) and tests.html (browser), so it must not
  // assume either environment. options: { games, verbose, log }
  //
  // Scoring is verified to death by js/tests.js. Everything here is about FLOW: the go /
  // last-card accounting, the series reset and next-leader rule, the counting order, and
  // the award gate that ends the game the instant somebody reaches the target.

  // ---------------------------------------------------------------- assertions ---
  // Same shape as the Suite in js/tests.js; deliberately duplicated so the two suites
  // stay independent of one another.

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

  Suite.prototype.deepEq = function (name, actual, expected, detail) {
    var a = JSON.stringify(actual);
    var e = JSON.stringify(expected);
    return this.record(name, a === e, expected, actual, detail);
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

  // mulberry32 — the fuzz run must be reproducible from its seed alone, so nothing here
  // ever touches Math.random.
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

  function add(sink, events) {
    for (var i = 0; i < events.length; i++) sink.push(events[i]);
    return sink;
  }

  function ofType(events, type) {
    var out = [];
    for (var i = 0; i < events.length; i++) if (events[i].type === type) out.push(events[i]);
    return out;
  }

  function typeSequence(events) {
    var out = [];
    for (var i = 0; i < events.length; i++) out.push(events[i].type);
    return out;
  }

  function pointsFor(events, player) {
    var sum = 0;
    for (var i = 0; i < events.length; i++) {
      if (events[i].type === 'score' && events[i].player === player) sum += events[i].points;
    }
    return sum;
  }

  function reasons(events) {
    var out = [];
    for (var i = 0; i < events.length; i++) {
      if (events[i].type === 'score') out.push(events[i].reason);
    }
    return out;
  }

  // Builds a 52-card deck whose first thirteen cards are exactly the hand we want: the
  // deal alternates starting with the non-dealer, so the pone takes the even indices, the
  // dealer the odd ones, and the starter is the next card off the top.
  function stackedDeck(poneSix, dealerSix, starterName) {
    var C = root.Cribbage.Cards;
    var p = C.parseCards(poneSix);
    var d = C.parseCards(dealerSix);
    if (p.length !== 6 || d.length !== 6) {
      throw new Error('stackedDeck: each player needs exactly 6 cards');
    }
    var out = [];
    for (var i = 0; i < 6; i++) {
      out.push(p[i]);
      out.push(d[i]);
    }
    out.push(C.parseCard(starterName));
    var used = {};
    for (i = 0; i < out.length; i++) used[out[i].id] = true;
    for (var id = 0; id < 52; id++) if (!used[id]) out.push(C.cardFromId(id));
    return out;
  }

  // Deals a rigged hand, makes both discards and turns the starter. Returns the game
  // sitting at the top of the play (or at game over, if heels won it there and then).
  function startPlay(cfg) {
    var Engine = root.Cribbage.Engine;
    var game = Engine.createGame({
      targetScore: cfg.targetScore || 121,
      rng: mulberry32(cfg.seed || 1),
      dealer: cfg.dealer,
      scores: cfg.scores,
      deck: stackedDeck(cfg.poneSix, cfg.dealerSix, cfg.starter)
    });
    var events = [];
    add(events, game.advance());
    add(events, game.apply({ type: 'discard', cards: root.Cribbage.Cards.parseCards(cfg.poneDiscard) }));
    add(events, game.apply({ type: 'discard', cards: root.Cribbage.Cards.parseCards(cfg.dealerDiscard) }));
    add(events, game.advance());
    return { game: game, events: events };
  }

  // Runs engine-driven beats (goes, series ends) until a card decision is pending or the
  // play is over. Never advances past the play.
  function pump(game, sink) {
    var PHASES = root.Cribbage.Engine.PHASES;
    var guard = 0;
    while (!game.isOver() && game.pendingActor() === null &&
        game.getState().phase === PHASES.PLAY) {
      if (++guard > 100) throw new Error('pump: the play would not settle');
      add(sink, game.advance());
    }
    return sink;
  }

  function playCard(game, name, sink) {
    add(sink, game.apply({ type: 'play', card: name }));
    pump(game, sink);
    return sink;
  }

  // Advances an engine-driven stretch (the show, the end of a hand) until a decision is
  // pending, the game is over, or the given phase is reached.
  function advanceUntil(game, phase, sink) {
    var guard = 0;
    while (!game.isOver() && game.getState().phase !== phase && game.pendingActor() === null) {
      if (++guard > 400) throw new Error('advanceUntil: never reached ' + phase);
      add(sink, game.advance());
    }
    return sink;
  }

  // ------------------------------------------------------- setup / deal / discard ---

  function testSetup(S) {
    var Engine = root.Cribbage.Engine;
    var PHASES = Engine.PHASES;

    var game = Engine.createGame({ rng: mulberry32(7), dealer: 0 });
    var st = game.getState();
    S.eq('setup: an explicit dealer skips the cut', st.phase, PHASES.DEAL);
    S.eq('setup: dealer is as given', st.dealer, 0);
    S.eq('setup: target score defaults to 121', st.targetScore, 121);
    S.deepEq('setup: scores start at zero', st.scores, [0, 0]);
    S.eq('setup: no player action is pending before the deal', game.pendingActor(), null);
    S.deepEq('setup: no legal actions while the engine has the move', game.legalActions(), []);
    S.eq('setup: the game is not over', game.isOver(), false);

    var dealEvents = game.advance();
    S.deepEq('deal: event sequence', typeSequence(dealEvents), ['deal', 'phase']);
    st = game.getState();
    S.eq('deal: non-dealer holds six', st.hands[1].length, 6);
    S.eq('deal: dealer holds six', st.hands[0].length, 6);
    S.eq('deal: forty cards remain undealt', st.cardsRemaining, 40);
    S.eq('deal: phase is discard', st.phase, PHASES.DISCARD);
    S.eq('deal: the non-dealer discards first', game.pendingActor(), 1);
    S.eq('discard: fifteen ways to choose two of six', game.legalActions().length, 15);

    S.throws('discard: advance() refuses while a decision is pending', function () {
      game.advance();
    });
    S.throws('discard: a card the player does not hold is rejected', function () {
      game.apply({ type: 'discard', cards: [st.hands[0][0], st.hands[1][0]] });
    });
    S.throws('discard: one card is rejected', function () {
      game.apply({ type: 'discard', cards: [st.hands[1][0]] });
    });
    S.throws('discard: three cards are rejected', function () {
      game.apply({ type: 'discard', cards: [st.hands[1][0], st.hands[1][1], st.hands[1][2]] });
    });
    S.throws('discard: the same card twice is rejected', function () {
      game.apply({ type: 'discard', cards: [st.hands[1][0], st.hands[1][0]] });
    });
    S.throws('discard: acting out of turn is rejected', function () {
      game.apply({ type: 'discard', player: 0, cards: [st.hands[0][0], st.hands[0][1]] });
    });
    S.throws('discard: a play action is rejected in the discard phase', function () {
      game.apply({ type: 'play', card: st.hands[1][0] });
    });
    S.throws('discard: an unknown action type is rejected', function () {
      game.apply({ type: 'shuffle' });
    });

    var first = game.apply({ type: 'discard', cards: [st.hands[1][0], st.hands[1][1]] });
    S.deepEq('discard: the first discard is a single beat', typeSequence(first), ['discard']);
    S.eq('discard: the dealer discards second', game.pendingActor(), 0);
    st = game.getState();
    S.eq('discard: the crib has two cards after one discard', st.crib.length, 2);
    S.eq('discard: the discarding hand is down to four', st.hands[1].length, 4);

    var second = game.apply({ type: 'discard', cards: [st.hands[0][0], st.hands[0][1]] });
    S.deepEq('discard: completing the crib emits cribComplete then the phase change',
      typeSequence(second), ['discard', 'cribComplete', 'phase']);
    st = game.getState();
    S.eq('discard: the crib ends with exactly four cards', st.crib.length, 4);
    S.eq('discard: both hands are down to four', st.hands[0].length + st.hands[1].length, 8);
    S.eq('discard: phase is cut starter', st.phase, PHASES.CUT_STARTER);
    S.eq('cut starter: no player decision is pending', game.pendingActor(), null);

    var cut = game.advance();
    S.eq('cut starter: a starter event is emitted', ofType(cut, 'starter').length, 1);
    st = game.getState();
    S.ok('cut starter: the starter is a real card', st.starter !== null &&
      typeof st.starter.id === 'number');
    S.eq('cut starter: thirty-nine cards remain undealt', st.cardsRemaining, 39);
    S.eq('cut starter: phase is play', st.phase, PHASES.PLAY);
    S.eq('play: the non-dealer leads', st.play.toMove, 1);
    S.eq('play: the non-dealer is on the move', game.pendingActor(), 1);
    S.eq('play: the count starts at zero', st.play.count, 0);
    S.eq('play: every card in hand is legal at a count of zero',
      game.legalActions().length, 4);

    S.throws('play: a card the player does not hold is rejected', function () {
      game.apply({ type: 'play', card: st.hands[0][0] });
    });

    // Legality is by value against the room left, all the way through the play.
    var legalityBad = 0;
    var g2 = Engine.createGame({ rng: mulberry32(99), dealer: 1 });
    g2.advance();
    g2.apply({ type: 'discard', cards: g2.getState().hands[0].slice(0, 2) });
    g2.apply({ type: 'discard', cards: g2.getState().hands[1].slice(0, 2) });
    g2.advance();
    var guard = 0;
    while (!g2.isOver() && g2.getState().phase === PHASES.PLAY && guard++ < 60) {
      var actor = g2.pendingActor();
      if (actor === null) {
        g2.advance();
        continue;
      }
      var s2 = g2.getState();
      var acts = g2.legalActions();
      for (var i = 0; i < acts.length; i++) {
        if (acts[i].card.value > 31 - s2.play.count) legalityBad++;
        var held = false;
        for (var h = 0; h < s2.hands[actor].length; h++) {
          if (s2.hands[actor][h].id === acts[i].card.id) held = true;
        }
        if (!held) legalityBad++;
      }
      if (s2.play.count > 31) legalityBad++;
      g2.apply(acts[0]);
    }
    S.eq('play: legalActions only ever offers held cards that fit under 31', legalityBad, 0);
    S.ok('play: a whole play phase completes', g2.getState().phase !== PHASES.PLAY ||
      g2.isOver());
  }

  function testCutForDeal(S) {
    var Engine = root.Cribbage.Engine;
    var PHASES = Engine.PHASES;

    var game = Engine.createGame({ rng: mulberry32(3) });
    S.eq('cut for deal: a null dealer starts at the cut', game.getState().phase,
      PHASES.CUT_FOR_DEAL);
    S.eq('cut for deal: the dealer is unknown', game.getState().dealer, null);
    S.deepEq('cut for deal: the only legal action is to cut',
      game.legalActions().map(function (a) { return a.type; }), ['cutForDeal']);
    S.throws('cut for deal: advance() refuses while the cut is pending', function () {
      game.advance();
    });

    // Property check over many seeds: the low card always deals, a tie never does, and a
    // tie leaves the game sitting in the cut phase waiting to be cut again.
    var wrongDealer = 0;
    var ties = 0;
    var tieLeftPhase = 0;
    var resolved = 0;
    for (var seed = 1; seed <= 400; seed++) {
      var g = Engine.createGame({ rng: mulberry32(seed) });
      var guard = 0;
      while (g.getState().phase === PHASES.CUT_FOR_DEAL && guard++ < 40) {
        var ev = g.apply({ type: 'cutForDeal' });
        var cut = ofType(ev, 'cutForDeal')[0];
        var a = cut.cuts[0];
        var b = cut.cuts[1];
        if (a.rank === b.rank) {
          ties++;
          if (cut.dealer !== null) wrongDealer++;
          if (g.getState().phase !== PHASES.CUT_FOR_DEAL) tieLeftPhase++;
        } else {
          var expected = a.rank < b.rank ? 0 : 1;
          if (cut.dealer !== expected) wrongDealer++;
          if (g.getState().dealer !== expected) wrongDealer++;
          if (g.getState().phase !== PHASES.DEAL) wrongDealer++;
          resolved++;
        }
      }
    }
    S.eq('cut for deal: the lower card always deals, over 400 seeded cuts', wrongDealer, 0);
    S.eq('cut for deal: every game resolved to a dealer', resolved, 400);
    S.ok('cut for deal: ties happened and were re-cut', ties > 0, ties + ' ties seen');
    S.eq('cut for deal: a tie never leaves the cut phase', tieLeftPhase, 0);
  }

  // ------------------------------------------------------------ go / last card ---

  function testGoAndLastCard(S) {
    var PHASES = root.Cribbage.Engine.PHASES;

    // Pone keeps 10S 2S 4S AS, dealer keeps four kings. The dealer is stuck from a count
    // of 22 onward, so the pone plays out alone and takes exactly one for the last card.
    var setup = startPlay({
      dealer: 1,
      poneSix: '10S 2S 4S AS 9H 9D',
      poneDiscard: '9H 9D',
      dealerSix: 'KS KH KD KC 7H 7D',
      dealerDiscard: '7H 7D',
      starter: '6C'
    });
    var game = setup.game;
    var ev = [];
    var st = game.getState();
    S.eq('go: the pone leads the first series', st.play.toMove, 0);

    playCard(game, '10S', ev);
    playCard(game, 'KS', ev);
    S.eq('go: the count is twenty after two cards', game.getState().play.count, 20);

    playCard(game, '2S', ev);
    var goes = ofType(ev, 'go');
    S.eq('go: the stuck dealer says go exactly once', goes.length, 1);
    S.eq('go: the go belongs to the dealer', goes.length ? goes[0].player : -1, 1);
    S.eq('go: the turn comes back to the player who can still play',
      game.getState().play.toMove, 0);

    playCard(game, '4S', ev);
    S.eq('go: a go is not repeated while the same series runs on',
      ofType(ev, 'go').length, 1);

    // The pone empties their hand while the dealer still holds three cards.
    add(ev, game.apply({ type: 'play', card: 'AS' }));
    st = game.getState();
    S.eq('go: the pone has run out of cards', st.hands[0].length, 0);
    S.eq('go: the dealer still holds three', st.hands[1].length, 3);
    S.eq('go: the count sits at twenty-seven', st.play.count, 27);
    pump(game, ev);

    var lastCards = ev.filter(function (e) {
      return e.type === 'score' && e.reason === 'Last card';
    });
    S.eq('go: exactly one last-card award for the series', lastCards.length, 1);
    S.eq('go: the last card is worth exactly one', lastCards[0].points, 1);
    S.eq('go: the last card goes to the player who played it', lastCards[0].player, 0);
    S.eq('go: the pone has one point', game.getState().scores[0], 1);
    var resets = ofType(ev, 'seriesReset');
    S.eq('go: one series has ended', resets.length, 1);
    S.eq('go: the player who did not play the last card leads next',
      resets[0].nextLeader, 1);
    st = game.getState();
    S.eq('go: the count resets to zero', st.play.count, 0);
    S.eq('go: the series empties', st.play.series.length, 0);
    S.eq('go: the new leader is on the move', st.play.toMove, 1);

    // Second series: the pone is empty, so the dealer plays out alone. An empty hand is
    // simply always unable to play — it must not swallow the go accounting.
    playCard(game, 'KH', ev);
    S.eq('go: an empty hand does not announce a go', ofType(ev, 'go').length, 1);
    playCard(game, 'KD', ev);
    playCard(game, 'KC', ev);

    S.eq('go: two series were completed', ofType(ev, 'seriesReset').length, 2);
    S.eq('go: exactly one last-card award per completed series',
      ev.filter(function (e) { return e.type === 'score' && e.reason === 'Last card'; }).length, 2);
    S.eq('go: the pone pegged one', game.getState().scores[0], 1);
    S.eq('go: the dealer pegged nine (pair, pair royal, last card)',
      game.getState().scores[1], 9);
    S.eq('go: all eight cards were played', game.getState().play.pile.length, 8);
    S.eq('go: the play hands the game on to the show', game.getState().phase,
      PHASES.SHOW_PONE);
  }

  function testThirtyOneAndLoneLeader(S) {
    var PHASES = root.Cribbage.Engine.PHASES;

    // Pone keeps 10S 10H 2S AS, dealer keeps KS QS 10D 10C.
    //   series 1  10,K,10,A -> exactly 31 (two points, and no go point on top)
    //   series 2  Q,2,10     -> the pone empties, the dealer takes the last card
    //   series 3  the nominated leader is out of cards, so the dealer plays on alone
    var setup = startPlay({
      dealer: 0,
      poneSix: '10S 10H 2S AS 9H 9D',
      poneDiscard: '9H 9D',
      dealerSix: 'KS QS 10D 10C 7H 7D',
      dealerDiscard: '7H 7D',
      starter: '6C'
    });
    var game = setup.game;
    var ev = [];

    playCard(game, '10S', ev);
    playCard(game, 'KS', ev);
    playCard(game, '10H', ev);
    S.eq('thirty-one: the dealer is stuck at thirty', ofType(ev, 'go').length, 1);
    S.deepEq('thirty-one: the forced play is the only card that fits',
      game.legalActions().map(function (a) { return root.Cribbage.Cards.cardName(a.card); }),
      ['AS']);

    var before = ev.length;
    playCard(game, 'AS', ev);
    var seriesEnd = ev.slice(before);
    S.eq('thirty-one: reaching 31 scores two', pointsFor(seriesEnd, 1), 2);
    S.deepEq('thirty-one: and nothing else — no go point on top', reasons(seriesEnd),
      ['Thirty-one for two']);
    S.eq('thirty-one: no last-card award when the series ends on 31',
      seriesEnd.filter(function (e) {
        return e.type === 'score' && e.reason === 'Last card';
      }).length, 0);
    S.eq('thirty-one: nobody announces a go at a dead count',
      ofType(seriesEnd, 'go').length, 0);
    S.eq('thirty-one: the series ends', ofType(seriesEnd, 'seriesReset').length, 1);
    S.eq('thirty-one: the pone total for that series is two, not three',
      game.getState().scores[1], 2);
    S.eq('thirty-one: the other player leads next',
      ofType(seriesEnd, 'seriesReset')[0].nextLeader, 0);
    S.eq('thirty-one: the count is reset', game.getState().play.count, 0);

    playCard(game, 'QS', ev);
    playCard(game, '2S', ev);
    before = ev.length;
    playCard(game, '10D', ev);
    var second = ev.slice(before);
    S.eq('lone leader: the dealer takes the last card of the second series',
      second.filter(function (e) {
        return e.type === 'score' && e.reason === 'Last card' && e.player === 0;
      }).length, 1);
    var reset2 = ofType(second, 'seriesReset')[0];
    S.eq('lone leader: the empty-handed pone is nominated to lead', reset2.nextLeader, 1);
    var st = game.getState();
    S.eq('lone leader: the nominated leader holds nothing', st.hands[1].length, 0);
    S.eq('lone leader: the dealer still holds a card', st.hands[0].length, 1);
    S.eq('lone leader: the lead passes straight back to the only player who can play',
      st.play.toMove, 0);
    S.eq('lone leader: an empty hand still announces nothing',
      ofType(second, 'go').length, 0);

    before = ev.length;
    playCard(game, '10C', ev);
    var third = ev.slice(before);
    S.eq('lone leader: the dealer plays on alone and still scores the last card',
      third.filter(function (e) {
        return e.type === 'score' && e.reason === 'Last card' && e.player === 0;
      }).length, 1);

    S.eq('lone leader: three series were played', ofType(ev, 'seriesReset').length, 3);
    S.deepEq('lone leader: next leaders across the hand',
      ofType(ev, 'seriesReset').map(function (e) { return e.nextLeader; }), [0, 1, 1]);
    S.eq('lone leader: the pone pegged two (the thirty-one)', game.getState().scores[1], 2);
    S.eq('lone leader: the dealer pegged two (two last cards)',
      game.getState().scores[0], 2);
    S.eq('lone leader: all eight cards were played', game.getState().play.pile.length, 8);
    S.eq('lone leader: the play is over', game.getState().phase, PHASES.SHOW_PONE);
  }

  // --------------------------------------------------- counting order and the show ---

  function testCountingOrder(S) {
    var PHASES = root.Cribbage.Engine.PHASES;
    var setup = startPlay({
      dealer: 1,
      poneSix: '10S 2S 4S AS 9H 9D',
      poneDiscard: '9H 9D',
      dealerSix: 'KS KH KD KC 7H 7D',
      dealerDiscard: '7H 7D',
      starter: '6C'
    });
    var game = setup.game;
    var ev = [];
    var script = ['10S', 'KS', '2S', '4S', 'AS', 'KH', 'KD', 'KC'];
    for (var i = 0; i < script.length; i++) playCard(game, script[i], ev);

    var showEvents = [];
    advanceUntil(game, PHASES.DEAL, showEvents);

    var starts = ofType(showEvents, 'showStart');
    S.eq('show: three counts happen', starts.length, 3);
    S.deepEq('show: non-dealer first, then dealer, then the crib',
      starts.map(function (e) { return e.player + ':' + e.source; }),
      ['0:hand', '1:hand', '1:crib']);
    S.eq('show: the pone counts a six-point hand', starts[0].handTotal, 6);
    S.eq('show: the dealer counts four kings for twelve', starts[1].handTotal, 12);
    S.eq('show: the crib counts eight', starts[2].handTotal, 8);
    S.eq('show: showStart carries the four cards being counted', starts[0].cards.length, 4);
    S.ok('show: showStart carries the starter',
      starts[0].starter && starts[0].starter.id === root.Cribbage.Cards.parseCard('6C').id);

    // Every scoring source appears in the right block of the event stream.
    var order = [];
    for (i = 0; i < showEvents.length; i++) {
      var e = showEvents[i];
      if (e.type === 'showStart') order.push('start:' + e.player + ':' + e.source);
      if (e.type === 'score') order.push('score:' + e.player + ':' + e.source);
    }
    // The pone counts a fifteen and a four-card flush; the dealer counts four kings as a
    // single double-pair-royal beat; the crib counts two fifteens and two pairs.
    S.deepEq('show: one score event per breakdown entry, in counting order', order, [
      'start:0:hand', 'score:0:hand', 'score:0:hand',
      'start:1:hand', 'score:1:hand',
      'start:1:crib', 'score:1:crib', 'score:1:crib', 'score:1:crib', 'score:1:crib'
    ]);
    S.deepEq('show: the crib counts its fifteens then its pairs',
      ofType(showEvents, 'score').slice(3).map(function (x) { return x.reason; }),
      ['Fifteen two', 'Fifteen four', 'Pair of sevens', 'Pair of nines']);
    S.deepEq('show: the pone counts fifteens then the flush',
      ofType(showEvents, 'score').slice(0, 2).map(function (x) { return x.reason; }),
      ['Fifteen two', 'Flush (4)']);

    S.eq('hand end: the pone finished on seven', game.getState().scores[0], 7);
    S.eq('hand end: the dealer finished on twenty-nine', game.getState().scores[1], 29);
    var ends = ofType(showEvents, 'handEnd');
    S.eq('hand end: exactly one handEnd event', ends.length, 1);
    S.eq('hand end: it names the dealer of the hand that just ended', ends[0].dealer, 1);
    var st = game.getState();
    S.eq('hand end: the deal rotates', st.dealer, 0);
    S.eq('hand end: the next hand is ready to deal', st.phase, PHASES.DEAL);
    S.eq('hand end: the cards are collected', st.hands[0].length + st.hands[1].length +
      st.crib.length + st.play.pile.length, 0);
    S.eq('hand end: the starter is cleared', st.starter, null);

    // ... and a second hand deals cleanly with the dealer swapped.
    var again = [];
    add(again, game.advance());
    st = game.getState();
    S.eq('hand two: six cards each again', st.hands[0].length + st.hands[1].length, 12);
    S.eq('hand two: the new non-dealer discards first', game.pendingActor(), 1);
  }

  // ------------------------------------------------------------ the award gate ---

  function testImmediateWinInTheShow(S) {
    var PHASES = root.Cribbage.Engine.PHASES;
    // The pone keeps 4S 5S 6S 7S with 8S turned: two fifteens, a run of five and a
    // five-card flush, in that breakdown order. Sitting at 113 after the play, the run
    // takes them past 121 on the third combination — the flush must never be awarded,
    // the dealer must never count, and the crib must never be counted at all.
    var setup = startPlay({
      dealer: 1,
      scores: [112, 0],
      poneSix: '4S 5S 6S 7S 2H 2D',
      poneDiscard: '2H 2D',
      dealerSix: 'KH KD QH QD 3H 3D',
      dealerDiscard: '3H 3D',
      starter: '8S'
    });
    var game = setup.game;
    var ev = [];
    var script = ['4S', 'KH', '5S', 'KD', '6S', 'QH', '7S', 'QD'];
    for (var i = 0; i < script.length; i++) playCard(game, script[i], ev);
    S.eq('mid-count win: the pone pegged one', game.getState().scores[0], 113);
    S.eq('mid-count win: the dealer pegged two', game.getState().scores[1], 2);
    S.eq('mid-count win: nobody has won yet', game.isOver(), false);

    var show = [];
    var guard = 0;
    while (!game.isOver() && guard++ < 50) add(show, game.advance());

    var starts = ofType(show, 'showStart');
    S.eq('mid-count win: only the pone ever starts a count', starts.length, 1);
    S.eq('mid-count win: and it is the non-dealer', starts[0].player, 0);
    S.eq('mid-count win: the full hand was worth fourteen', starts[0].handTotal, 14);
    var scores = ofType(show, 'score');
    S.eq('mid-count win: exactly three combinations are awarded', scores.length, 3);
    S.deepEq('mid-count win: and the fourth (the flush) never fires',
      scores.map(function (e) { return e.reason; }),
      ['Fifteen two', 'Fifteen four', 'Run of five']);
    S.eq('mid-count win: the dealer never counts',
      show.filter(function (e) {
        return (e.type === 'showStart' || e.type === 'score') && e.player === 1;
      }).length, 0);
    S.eq('mid-count win: the crib is never counted',
      show.filter(function (e) { return e.source === 'crib'; }).length, 0);
    S.eq('mid-count win: the game is over', game.isOver(), true);
    var over = ofType(show, 'gameOver');
    S.eq('mid-count win: exactly one gameOver event', over.length, 1);
    S.eq('mid-count win: the non-dealer wins', over[0].winner, 0);
    S.eq('mid-count win: the recorded score is clamped to the target',
      game.getState().scores[0], 121);
    S.eq('mid-count win: the winning award still reports its true value',
      scores[2].points, 5);
    S.eq('mid-count win: the score event total matches the clamped score',
      scores[2].total, 121);
    S.eq('mid-count win: the loser was double skunked', over[0].skunk, 'double');
    S.eq('mid-count win: phase is game over', game.getState().phase, PHASES.GAME_OVER);
    S.eq('mid-count win: nobody is on the move', game.pendingActor(), null);
    S.deepEq('mid-count win: there are no legal actions', game.legalActions(), []);
    S.throws('mid-count win: advance() refuses after the game is over', function () {
      game.advance();
    });
    S.throws('mid-count win: apply() refuses after the game is over', function () {
      game.apply({ type: 'play', card: '4S' });
    });
  }

  function testHeelsWin(S) {
    var PHASES = root.Cribbage.Engine.PHASES;
    var setup = startPlay({
      dealer: 0,
      scores: [119, 95],
      poneSix: '4S 5S 6S 7S 2H 2D',
      poneDiscard: '2H 2D',
      dealerSix: 'KH KD QH QD 3H 3D',
      dealerDiscard: '3H 3D',
      starter: 'JS'
    });
    var game = setup.game;
    var ev = setup.events;
    var st = game.getState();
    S.eq('heels: the game ended at the cut', game.isOver(), true);
    var scores = ofType(ev, 'score');
    S.eq('heels: exactly one award', scores.length, 1);
    S.eq('heels: two points', scores[0].points, 2);
    S.eq('heels: to the dealer', scores[0].player, 0);
    S.eq('heels: tagged as heels', scores[0].source, 'heels');
    S.eq('heels: the dealer is on 121', st.scores[0], 121);
    S.eq('heels: no play phase ever happened',
      ev.filter(function (e) { return e.type === 'phase' && e.to === PHASES.PLAY; }).length, 0);
    S.eq('heels: the phase went straight from the cut to game over', st.phase,
      PHASES.GAME_OVER);
    S.eq('heels: both players still hold their cards',
      st.hands[0].length + st.hands[1].length, 8);
    S.eq('heels: nobody ever counted a hand', ofType(ev, 'showStart').length, 0);
    S.eq('heels: the loser was not skunked', ofType(ev, 'gameOver')[0].skunk, 'none');
    S.throws('heels: advance() refuses after the game is over', function () {
      game.advance();
    });

    // Skunk boundaries, decided by the loser's score at the moment of the win.
    var cases = [[95, 'none'], [91, 'none'], [90, 'skunk'], [61, 'skunk'], [60, 'double'],
      [0, 'double']];
    for (var i = 0; i < cases.length; i++) {
      var g = startPlay({
        dealer: 0,
        scores: [119, cases[i][0]],
        poneSix: '4S 5S 6S 7S 2H 2D',
        poneDiscard: '2H 2D',
        dealerSix: 'KH KD QH QD 3H 3D',
        dealerDiscard: '3H 3D',
        starter: 'JS'
      });
      S.eq('heels: a loser on ' + cases[i][0] + ' is "' + cases[i][1] + '"',
        ofType(g.events, 'gameOver')[0].skunk, cases[i][1]);
    }

    // The skunk lines are 30 and 60 holes from home, so they must scale with the target.
    // Absolute 90/60 thresholds make EVERY 61-point game a double skunk — the loser's
    // score cannot exceed 60 — including the closest possible 61-60 finish.
    var shortCases = [[60, 'none'], [31, 'none'], [30, 'skunk'], [1, 'skunk'],
      [0, 'double']];
    for (var j = 0; j < shortCases.length; j++) {
      var sg = startPlay({
        dealer: 0,
        targetScore: 61,
        scores: [59, shortCases[j][0]],
        poneSix: '4S 5S 6S 7S 2H 2D',
        poneDiscard: '2H 2D',
        dealerSix: 'KH KD QH QD 3H 3D',
        dealerDiscard: '3H 3D',
        starter: 'JS'
      });
      var sover = ofType(sg.events, 'gameOver')[0];
      S.eq('heels at 61: a loser on ' + shortCases[j][0] + ' is "' + shortCases[j][1] + '"',
        sover.skunk, shortCases[j][1]);
    }
    S.eq('heels at 61: the winning score is the 61-point target',
      ofType(startPlay({
        dealer: 0, targetScore: 61, scores: [59, 60],
        poneSix: '4S 5S 6S 7S 2H 2D', poneDiscard: '2H 2D',
        dealerSix: 'KH KD QH QD 3H 3D', dealerDiscard: '3H 3D', starter: 'JS'
      }).events, 'gameOver')[0].scores[0], 61);
  }

  function testPeggingWin(S) {
    var PHASES = root.Cribbage.Engine.PHASES;
    // The pone sits at 119 and plays the third five for fifteen: the fifteen is the first
    // breakdown entry and wins outright, so the pair royal behind it is never awarded.
    var setup = startPlay({
      dealer: 0,
      scores: [0, 119],
      poneSix: '5H 5D 9H 9C 2H 2C',
      poneDiscard: '2H 2C',
      dealerSix: '5S 8D 8H 8C 3D 3C',
      dealerDiscard: '3D 3C',
      starter: '7D'
    });
    var game = setup.game;
    var ev = [];
    playCard(game, '5H', ev);
    playCard(game, '5S', ev);
    S.eq('pegging win: the dealer pegs a pair', game.getState().scores[0], 2);
    S.eq('pegging win: still live', game.isOver(), false);

    var last = game.apply({ type: 'play', card: '5D' });
    var scores = ofType(last, 'score');
    S.eq('pegging win: exactly one award fires', scores.length, 1);
    S.eq('pegging win: it is the fifteen', scores[0].reason, 'Fifteen two');
    S.eq('pegging win: the pair royal behind it is never awarded',
      scores.filter(function (e) { return e.points === 6; }).length, 0);
    S.eq('pegging win: the pone is on 121', scores[0].total, 121);
    S.eq('pegging win: the game is over', game.isOver(), true);
    S.eq('pegging win: gameOver names the pone', ofType(last, 'gameOver')[0].winner, 1);
    var st = game.getState();
    S.eq('pegging win: the game ended mid-play', st.phase, PHASES.GAME_OVER);
    S.eq('pegging win: the pone still holds two cards', st.hands[1].length, 2);
    S.eq('pegging win: the dealer still holds three cards', st.hands[0].length, 3);
    S.eq('pegging win: the final score never exceeds the target', st.scores[1], 121);
    S.throws('pegging win: apply() refuses afterwards', function () {
      game.apply({ type: 'play', card: '9H' });
    });
    S.throws('pegging win: advance() refuses afterwards', function () { game.advance(); });

    // A short game is just a different target through the same gate.
    var short = startPlay({
      dealer: 0,
      targetScore: 61,
      scores: [0, 59],
      poneSix: '5H 5D 9H 9C 2H 2C',
      poneDiscard: '2H 2C',
      dealerSix: '5S 8D 8H 8C 3D 3C',
      dealerDiscard: '3D 3C',
      starter: '7D'
    });
    var ev2 = [];
    playCard(short.game, '5H', ev2);
    playCard(short.game, '5S', ev2);
    add(ev2, short.game.apply({ type: 'play', card: '5D' }));
    S.eq('pegging win: a 61-point game ends at 61', short.game.getState().scores[1], 61);
    S.eq('pegging win: and names its winner', ofType(ev2, 'gameOver')[0].winner, 1);
  }

  // ------------------------------------------------------------- state hygiene ---

  function testStateIsInert(S) {
    var Engine = root.Cribbage.Engine;
    var game = Engine.createGame({ rng: mulberry32(11), dealer: 0 });
    game.advance();
    var st = game.getState();

    S.ok('state: the snapshot is frozen', Object.isFrozen(st));
    S.ok('state: nested arrays are frozen', Object.isFrozen(st.hands) &&
      Object.isFrozen(st.hands[0]) && Object.isFrozen(st.scores));
    S.ok('state: cards are frozen', Object.isFrozen(st.hands[0][0]));

    var expected = JSON.stringify(st);
    var pendingBefore = game.pendingActor();
    var legalBefore = game.legalActions().length;

    // Strict mode makes each of these throw; the point is that none of them lands.
    var attempts = [
      function () { st.scores[0] = 120; },
      function () { st.scores.push(99); },
      function () { st.phase = 'GAME_OVER'; },
      function () { st.dealer = 1; },
      function () { st.hands[0].pop(); },
      function () { st.hands[1].push(st.hands[0][0]); },
      function () { st.hands[0][0].rank = 13; },
      function () { st.crib.push(st.hands[0][0]); },
      function () { st.play.count = 31; },
      function () { st.winner = 0; }
    ];
    for (var i = 0; i < attempts.length; i++) {
      try {
        attempts[i]();
      } catch (err) {
        // Expected: frozen snapshots reject writes loudly under strict mode.
      }
    }

    S.deepEq('state: mutating a snapshot changes nothing',
      JSON.parse(JSON.stringify(game.getState())), JSON.parse(expected));
    S.eq('state: the engine still knows who is on the move', game.pendingActor(),
      pendingBefore);
    S.eq('state: the engine still offers the same actions', game.legalActions().length,
      legalBefore);

    // Successive snapshots are independent objects, not the same one handed back twice.
    var a = game.getState();
    var b = game.getState();
    S.ok('state: each call returns a fresh snapshot', a !== b);
    S.ok('state: and a fresh hands array', a.hands !== b.hands);

    // A hand dealt out of the engine cannot be smuggled back in doctored.
    var hand = game.getState().hands[1];
    S.throws('state: a card the engine never dealt is rejected', function () {
      game.apply({ type: 'discard', cards: [hand[0], { id: 51, rank: 13, suit: 3, value: 10 }] });
    });

    // And the game still plays out normally after all of that.
    game.apply({ type: 'discard', cards: game.getState().hands[1].slice(0, 2) });
    game.apply({ type: 'discard', cards: game.getState().hands[0].slice(0, 2) });
    game.advance();
    var after = game.getState();
    S.eq('state: the engine plays on unharmed — the crib still filled', after.crib.length, 4);
    S.eq('state: ... the starter still turned', after.cardsRemaining, 39);
    S.eq('state: ... and the play still starts with the non-dealer', after.play.toMove, 1);
  }

  // ------------------------------------------------------------------- the fuzz ---

  function testFuzz(S, gameCount, log) {
    var Engine = root.Cribbage.Engine;
    var PHASES = Engine.PHASES;
    var STEP_CAP = 20000;

    var problems = [];
    var seedsFailed = {};
    function fail(seed, message) {
      seedsFailed[seed] = true;
      if (problems.length < 15) problems.push('seed ' + seed + ': ' + message);
    }

    var totalSteps = 0;
    var totalHands = 0;
    var totalSeries = 0;
    var totalGames = 0;
    var capHit = 0;
    var winners = [0, 0];
    var firstDealerWins = 0;
    var skunks = { none: 0, skunk: 0, double: 0 };
    // Reported per target score. Averaging 121- and 61-point games together produces a
    // hands-per-game figure that describes neither, and these numbers are the sanity check
    // that simulated games look like real cribbage.
    var byTarget = {
      121: { games: 0, hands: 0, margin: 0, skunk: 0, double: 0 },
      61: { games: 0, hands: 0, margin: 0, skunk: 0, double: 0 }
    };
    var startedAt = Date.now();

    for (var gi = 0; gi < gameCount; gi++) {
      var seed = gi + 1;
      // Every fourth game is a 61-point game: a shorter target hits the win gate far more
      // often, and the clamp has to behave the same at either length.
      var target = gi % 4 === 3 ? 61 : 121;
      var rng = mulberry32(seed);
      var choose = mulberry32(seed ^ 0x5f356495);
      var game = Engine.createGame({ targetScore: target, rng: rng, dealer: null });

      var steps = 0;
      var lastScores = [0, 0];
      // The scores the event stream says the players should be on. Every point in the
      // game is supposed to arrive as a 'score' event, so this must track the state
      // exactly — if it drifts, some award skipped the gate.
      var running = [0, 0];
      var handsSeen = 0;
      // handEnd deliberately does not fire for the deciding hand — the game stops the
      // instant someone pegs out — so counting handEnd undercounts every game by one.
      // Deals are the honest measure of how many hands were actually played.
      var dealsSeen = 0;
      var firstDealer = null;
      var seriesSeen = 0;
      var dealerHistory = [];
      var gameOverSeen = 0;
      // Per-series go/last-card accounting.
      var lastPlayCount = 0;
      var lastPlayPlayer = null;
      var lastCardAwards = 0;
      var thirtyOneAwards = 0;
      var pendingLeader = null;
      var expectHandsAtPlay = false;
      var expectPlayDone = false;
      var expectCribFull = false;
      var showOrder = [];

      while (!game.isOver()) {
        if (++steps > STEP_CAP) {
          fail(seed, 'hit the ' + STEP_CAP + '-step cap without finishing');
          capHit++;
          break;
        }
        var st = game.getState();

        // --- invariants that hold at every single step ---
        var ids = {};
        var total = 0;
        var duplicated = false;
        // showHands and play.series are views of cards counted elsewhere (the four kept
        // cards, and the tail of the pile), so only these five places are counted.
        var pileCards = [];
        for (var pi = 0; pi < st.play.pile.length; pi++) pileCards.push(st.play.pile[pi].card);
        var groups = [st.hands[0], st.hands[1], st.crib, pileCards, st.deck];
        if (st.starter) groups.push([st.starter]);
        for (var gj = 0; gj < groups.length; gj++) {
          for (var ci = 0; ci < groups[gj].length; ci++) {
            var id = groups[gj][ci].id;
            if (ids[id]) duplicated = true;
            ids[id] = true;
            total++;
          }
        }
        if (duplicated) fail(seed, 'a card was in two places at once in ' + st.phase);
        if (total !== 0 && total !== 52) {
          fail(seed, 'cards do not add up in ' + st.phase + ': ' + total + ' of 52');
        }
        if (st.scores[0] < lastScores[0] || st.scores[1] < lastScores[1]) {
          fail(seed, 'a score went down: ' + lastScores + ' -> ' + st.scores);
        }
        if (st.scores[0] > target || st.scores[1] > target) {
          fail(seed, 'a score passed the target: ' + st.scores);
        }
        lastScores = st.scores;
        if (st.scores[0] !== running[0] || st.scores[1] !== running[1]) {
          fail(seed, 'the score ' + st.scores + ' does not match the events ' + running);
        }
        if (st.play.count > 31 || st.play.count < 0) {
          fail(seed, 'the count reached ' + st.play.count);
        }
        if (st.phase === PHASES.PLAY && st.play.series.length) {
          var seriesValue = 0;
          for (var si = 0; si < st.play.series.length; si++) {
            seriesValue += st.play.series[si].value;
          }
          if (seriesValue !== st.play.count) fail(seed, 'the count does not match the series');
        }
        if (expectHandsAtPlay) {
          if (st.hands[0].length !== 4 || st.hands[1].length !== 4) {
            fail(seed, 'the play began with ' + st.hands[0].length + '/' +
              st.hands[1].length + ' cards in hand');
          }
          if (st.play.pile.length !== 0) fail(seed, 'the play began with a non-empty pile');
          expectHandsAtPlay = false;
        }
        if (expectPlayDone) {
          if (st.play.pile.length !== 8) {
            fail(seed, 'the play ended with ' + st.play.pile.length + ' cards played');
          }
          if (st.hands[0].length || st.hands[1].length) {
            fail(seed, 'the play ended with cards still in hand');
          }
          expectPlayDone = false;
        }
        if (expectCribFull) {
          if (st.crib.length !== 4) fail(seed, 'the crib held ' + st.crib.length + ' cards');
          expectCribFull = false;
        }
        if (pendingLeader !== null) {
          if (st.play.toMove !== pendingLeader) {
            fail(seed, 'the next series was led by ' + st.play.toMove + ', not ' +
              pendingLeader);
          }
          pendingLeader = null;
        }

        // --- take a step ---
        var actor = game.pendingActor();
        var events;
        if (actor === null) {
          if (st.toMove !== null && st.phase !== PHASES.PLAY) {
            fail(seed, 'toMove is set but no actor is pending in ' + st.phase);
          }
          events = game.advance();
        } else {
          var actions = game.legalActions();
          if (!actions.length) {
            fail(seed, 'player ' + actor + ' is on the move with no legal action in ' +
              st.phase);
            break;
          }
          var action = actions[Math.floor(choose() * actions.length)];
          if (action.player !== actor) fail(seed, 'a legal action named the wrong player');
          if (action.type === 'play') {
            var held = false;
            for (var hi = 0; hi < st.hands[actor].length; hi++) {
              if (st.hands[actor][hi].id === action.card.id) held = true;
            }
            if (!held) fail(seed, 'was offered a card player ' + actor + ' does not hold');
            if (action.card.value > 31 - st.play.count) {
              fail(seed, 'was offered a card that busts 31');
            }
          }
          if (action.type === 'discard' && action.cards.length !== 2) {
            fail(seed, 'a discard action did not name two cards');
          }
          events = game.apply(action);
        }

        // --- read the events ---
        for (var ei = 0; ei < events.length; ei++) {
          var e = events[ei];
          if (e.type === 'play') {
            lastPlayCount = e.count;
            lastPlayPlayer = e.player;
          } else if (e.type === 'score') {
            if (e.reason === 'Last card') lastCardAwards++;
            if (e.reason === 'Thirty-one for two') thirtyOneAwards++;
            if (!(e.points > 0)) fail(seed, 'a score event awarded ' + e.points);
            running[e.player] = Math.min(running[e.player] + e.points, target);
            if (e.total !== running[e.player]) {
              fail(seed, 'a score event reported ' + e.total + ', expected ' +
                running[e.player]);
            }
          } else if (e.type === 'seriesReset') {
            seriesSeen++;
            if (lastPlayCount === 31) {
              if (lastCardAwards !== 0) {
                fail(seed, 'a series that ended on 31 also paid a go point');
              }
              if (thirtyOneAwards !== 1) {
                fail(seed, 'a series ended on 31 without the two for thirty-one');
              }
            } else if (lastCardAwards !== 1) {
              fail(seed, 'a series ending on ' + lastPlayCount + ' paid ' + lastCardAwards +
                ' last-card awards');
            }
            if (lastPlayPlayer !== null && e.nextLeader !== 1 - lastPlayPlayer) {
              fail(seed, 'the wrong player was nominated to lead the next series');
            }
            pendingLeader = e.nextLeader;
            lastCardAwards = 0;
            thirtyOneAwards = 0;
            lastPlayCount = 0;
            lastPlayPlayer = null;
          } else if (e.type === 'deal') {
            dealsSeen++;
            if (firstDealer === null) firstDealer = e.dealer;
          } else if (e.type === 'cribComplete') {
            expectCribFull = true;
          } else if (e.type === 'showStart') {
            showOrder.push(e.source + ':' + (e.player === game.getState().dealer ? 'D' : 'P'));
          } else if (e.type === 'handEnd') {
            handsSeen++;
            dealerHistory.push(e.dealer);
            if (showOrder.length && showOrder.join(',') !== 'hand:P,hand:D,crib:D') {
              fail(seed, 'the counting order was ' + showOrder.join(','));
            }
            showOrder = [];
          } else if (e.type === 'phase') {
            if (e.to === PHASES.PLAY) expectHandsAtPlay = true;
            if (e.from === PHASES.PLAY && e.to === PHASES.SHOW_PONE) expectPlayDone = true;
          } else if (e.type === 'gameOver') {
            gameOverSeen++;
            var final = game.getState();
            if (final.scores[e.winner] !== target) {
              fail(seed, 'the winner did not finish on the target: ' + final.scores);
            }
            if (final.scores[1 - e.winner] >= target) fail(seed, "both players reached the target");
            if (e.winner !== 0 && e.winner !== 1) fail(seed, 'gameOver named ' + e.winner);
            winners[e.winner]++;
            skunks[e.skunk]++;
            // Dealer advantage is real in cribbage (the dealer owns the crib), so this is
            // a sanity check on the simulation rather than idle curiosity.
            if (e.winner === firstDealer) firstDealerWins++;
            var bt = byTarget[target];
            bt.games++;
            bt.margin += target - final.scores[1 - e.winner];
            if (e.skunk === 'skunk') bt.skunk++;
            if (e.skunk === 'double') bt.double++;
          }
        }
      }

      if (!game.isOver()) {
        if (steps <= STEP_CAP) fail(seed, 'the game stopped without a winner');
      } else {
        if (gameOverSeen !== 1) fail(seed, gameOverSeen + ' gameOver events');
        var end = game.getState();
        if (end.phase !== PHASES.GAME_OVER) fail(seed, 'ended in phase ' + end.phase);
        if (end.winner === null) fail(seed, 'ended with no winner recorded');
        var threw = false;
        try {
          game.advance();
        } catch (err) {
          threw = true;
        }
        if (!threw) fail(seed, 'advance() worked after the game was over');
        threw = false;
        try {
          game.apply({ type: 'cutForDeal' });
        } catch (err2) {
          threw = true;
        }
        if (!threw) fail(seed, 'apply() worked after the game was over');
      }

      // The deal alternates every hand, all game long.
      for (var di = 1; di < dealerHistory.length; di++) {
        if (dealerHistory[di] === dealerHistory[di - 1]) {
          fail(seed, 'the deal did not rotate after hand ' + di);
          break;
        }
      }

      totalSteps += steps;
      totalHands += dealsSeen;
      totalSeries += seriesSeen;
      totalGames++;
      byTarget[target].hands += dealsSeen;
    }

    var elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);
    S.eq('fuzz: every game played to a winner', totalGames, gameCount);
    S.eq('fuzz: no game hit the step cap', capHit, 0);
    S.ok('fuzz: no invariant was violated in ' + gameCount + ' games',
      problems.length === 0, problems.join('\n          '));
    S.eq('fuzz: no seed failed', Object.keys(seedsFailed).length, 0);
    S.ok('fuzz: both players won games', winners[0] > 0 && winners[1] > 0,
      'dealer-first wins ' + winners[0] + ', other ' + winners[1]);
    S.ok('fuzz: hands were actually played', totalHands > gameCount);
    S.ok('fuzz: series were actually completed', totalSeries > totalHands);

    if (log) {
      log('  fuzz: ' + gameCount + ' games, ' + totalHands + ' hands, ' + totalSeries +
        ' series, ' + totalSteps + ' steps in ' + elapsed + 's');
      log('        player 0 won ' + winners[0] + ', player 1 won ' + winners[1] +
        '   first dealer won ' + (100 * firstDealerWins / gameCount).toFixed(1) + '%' +
        '   (' + (totalSteps / gameCount).toFixed(0) + ' steps/game)');
      [121, 61].forEach(function (t) {
        var b = byTarget[t];
        if (!b.games) return;
        log('        ' + t + '-point: ' + b.games + ' games, ' +
          (b.hands / b.games).toFixed(1) + ' hands/game, ' +
          'mean margin ' + (b.margin / b.games).toFixed(1) + ', ' +
          'skunks ' + (100 * b.skunk / b.games).toFixed(1) + '%, ' +
          'doubles ' + (100 * b.double / b.games).toFixed(1) + '%');
      });
    }
  }

  // ---------------------------------------------------------------------- run ---

  function run(options) {
    options = options || {};
    var S = new Suite(options);
    var log = options.log || function () {};

    if (!root.Cribbage || !root.Cribbage.Cards || !root.Cribbage.Scoring ||
        !root.Cribbage.Engine) {
      S.ok('modules loaded (cards.js, scoring.js, engine.js)', false);
      return { passed: S.passed, failed: S.failed, results: S.results };
    }

    // A group that throws is a failure like any other, but it must not take the rest of
    // the suite down with it.
    function section(name, fn) {
      try {
        fn(S);
      } catch (err) {
        S.record(name + ': the group threw', false, 'no throw',
          (err && err.message) || String(err), (err && err.stack) || '');
      }
    }

    section('setup', testSetup);
    section('cut for deal', testCutForDeal);
    section('go / last card', testGoAndLastCard);
    section('thirty-one / lone leader', testThirtyOneAndLoneLeader);
    section('counting order', testCountingOrder);
    section('win mid-count', testImmediateWinInTheShow);
    section('heels', testHeelsWin);
    section('pegging win', testPeggingWin);
    section('state hygiene', testStateIsInert);

    var games = options.games === undefined || options.games === null ? 2000 : options.games;
    if (games > 0) {
      section('fuzz', function (suite) { testFuzz(suite, games, log); });
    }

    return { passed: S.passed, failed: S.failed, results: S.results };
  }

  root.Cribbage = root.Cribbage || {};
  root.Cribbage.EngineTests = { run: run };
})(typeof window !== 'undefined' ? window : globalThis);
