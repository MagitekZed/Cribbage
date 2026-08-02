(function (root) {
  'use strict';

  // engine.js owns the rules of FLOW. Scoring is already solved in scoring.js and is
  // consumed here, never re-implemented.
  //
  // The engine is UI-agnostic and player-agnostic: no DOM, no timers, no async, no AI.
  // It is a pure state machine driven from outside by three calls — apply() for a player
  // decision, advance() for an engine-driven beat, getState() to look. The UI and the AI
  // are both just callers, which is what makes the whole thing testable at volume and
  // lets the animation layer own pacing.
  //
  // Every point in the game flows through award(). The win check lives there and nowhere
  // else, so "the game ends the instant someone reaches the target" is structural rather
  // than remembered case by case.

  var Cards = root.Cribbage && root.Cribbage.Cards;
  var Scoring = root.Cribbage && root.Cribbage.Scoring;

  // Phase names match the state machine in DESIGN.md 2.4.
  var PHASES = {
    CUT_FOR_DEAL: 'CUT_FOR_DEAL',
    DEAL: 'DEAL',
    DISCARD: 'DISCARD',
    CUT_STARTER: 'CUT_STARTER',
    PLAY: 'PLAY',
    SHOW_PONE: 'SHOW_PONE',
    SHOW_DEALER: 'SHOW_DEALER',
    SHOW_CRIB: 'SHOW_CRIB',
    HAND_END: 'HAND_END',
    GAME_OVER: 'GAME_OVER'
  };

  var HAND_SIZE = 6;
  var MAX_COUNT = 31;

  // ------------------------------------------------------------------ helpers ---

  // Cards are immutable value objects, so a snapshot can hand out the very same frozen
  // card the engine holds without any risk of a caller mutating engine internals. That
  // keeps getState() cheap enough to call on every step of a 2000-game fuzz run.
  function freezeCards(cards) {
    for (var i = 0; i < cards.length; i++) Object.freeze(cards[i]);
    return cards;
  }

  function freshDeck() {
    return freezeCards(Cards.makeDeck());
  }

  // Accepts a card object, a 0..51 id, or a name like '5H' / 'TD'. Always returns a card
  // the engine minted itself, so callers can never smuggle a doctored object in.
  function toCard(input) {
    if (typeof input === 'number') return Cards.cardFromId(input);
    if (typeof input === 'string') return Cards.cardFromId(Cards.parseCard(input).id);
    if (input && typeof input === 'object' && typeof input.id === 'number') {
      return Cards.cardFromId(input.id);
    }
    throw new Error('engine: cannot read a card from ' + JSON.stringify(input));
  }

  function indexOfCard(cards, card) {
    for (var i = 0; i < cards.length; i++) {
      if (cards[i].id === card.id) return i;
    }
    return -1;
  }

  function deepFreeze(value) {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.freeze(value);
    var keys = Object.keys(value);
    for (var i = 0; i < keys.length; i++) deepFreeze(value[keys[i]]);
    return value;
  }

  function normalizeDeck(input) {
    if (!Array.isArray(input) || input.length !== 52) {
      throw new Error('engine: a supplied deck must be an array of 52 cards');
    }
    var seen = {};
    var out = [];
    for (var i = 0; i < input.length; i++) {
      var card = toCard(input[i]);
      if (seen[card.id]) throw new Error('engine: supplied deck repeats ' + Cards.cardName(card));
      seen[card.id] = true;
      out.push(card);
    }
    return freezeCards(out);
  }

  // ---------------------------------------------------------------- the game ---

  /**
   * createGame(options) -> game
   *   targetScore  121 (default) or 61
   *   rng          () -> [0,1). Injectable so tests and replays are deterministic.
   *   dealer       null (cut for deal) | 0 | 1 (skip the cut)
   *   scores       optional [a, b] starting scores — for restoring a saved game and for
   *                tests that need to sit a player just under the target
   *   deck         optional fixed 52-card order used for the DEAL instead of shuffling,
   *                or a function (handNumber) -> 52 cards. A test/replay seam; the cut
   *                for deal always shuffles.
   */
  function createGame(options) {
    if (!Cards || !Scoring) {
      throw new Error('Cribbage.Engine: cards.js and scoring.js must be loaded first');
    }
    options = options || {};

    var targetScore = options.targetScore === undefined || options.targetScore === null
      ? 121 : options.targetScore;
    if (typeof targetScore !== 'number' || (targetScore | 0) !== targetScore || targetScore < 1) {
      throw new Error('createGame: targetScore must be a positive integer, got ' +
        options.targetScore);
    }

    var rng = options.rng === undefined || options.rng === null ? Math.random : options.rng;
    if (typeof rng !== 'function') throw new Error('createGame: rng must be a function');

    var dealerOption = options.dealer === undefined ? null : options.dealer;
    if (dealerOption !== null && dealerOption !== 0 && dealerOption !== 1) {
      throw new Error('createGame: dealer must be null, 0 or 1, got ' + options.dealer);
    }

    var deckOption = options.deck === undefined ? null : options.deck;
    if (deckOption !== null && typeof deckOption !== 'function') deckOption = normalizeDeck(deckOption);

    var startScores = [0, 0];
    if (options.scores !== undefined && options.scores !== null) {
      if (!Array.isArray(options.scores) || options.scores.length !== 2) {
        throw new Error('createGame: scores must be a [a, b] pair');
      }
      for (var s = 0; s < 2; s++) {
        var v = options.scores[s];
        if (typeof v !== 'number' || (v | 0) !== v || v < 0 || v >= targetScore) {
          throw new Error('createGame: score ' + s + ' must be an integer 0..' +
            (targetScore - 1) + ', got ' + v);
        }
        startScores[s] = v;
      }
    }

    var state = {
      phase: dealerOption === null ? PHASES.CUT_FOR_DEAL : PHASES.DEAL,
      dealer: dealerOption,
      scores: startScores,
      prevScores: [startScores[0], startScores[1]],
      hands: [[], []],
      // The four cards each player held when the play began. The play empties hands[]
      // into the pile, and the show still has to count what they kept.
      showHands: [[], []],
      crib: [],
      starter: null,
      deck: [],
      discarded: [false, false],
      play: {
        count: 0,
        series: [],
        pile: [],
        lastPlayer: null,
        goSaid: [false, false],
        toMove: null
      },
      show: { index: -1, breakdown: null, total: 0 },
      winner: null,
      skunk: 'none',
      handNumber: 0
    };

    function pone() {
      return 1 - state.dealer;
    }

    // --------------------------------------------------------- the award gate ---

    // The ONE place points are ever added. Returns true while the game is still live,
    // so every caller that awards in a loop can simply stop when it returns false.
    function award(events, player, points, reason, cards, source) {
      if (state.winner !== null) return false;
      if (!(points > 0)) return true;
      var before = state.scores[player];
      var after = before + points;
      if (after > targetScore) after = targetScore;
      state.prevScores[player] = before;
      state.scores[player] = after;
      events.push({
        type: 'score',
        player: player,
        points: points,
        reason: reason,
        cards: cards ? cards.slice() : [],
        source: source,
        total: after
      });
      if (after >= targetScore) endGame(events, player);
      return state.winner === null;
    }

    function endGame(events, winner) {
      state.winner = winner;
      var loserScore = state.scores[1 - winner];
      // The skunk lines sit 30 and 60 holes from home — 91 and 61 on a 121-point board.
      // They must scale with targetScore rather than being hardcoded: at 61 points the
      // loser's score can never exceed 60, so absolute thresholds would report every
      // single 61-point game as a double skunk, including a 61-60 finish.
      var skunkLine = targetScore - 30;
      var doubleLine = targetScore - 60;
      state.skunk = loserScore < doubleLine ? 'double'
        : (loserScore < skunkLine ? 'skunk' : 'none');
      setPhase(events, PHASES.GAME_OVER);
      events.push({
        type: 'gameOver',
        winner: winner,
        scores: state.scores.slice(),
        skunk: state.skunk
      });
    }

    function setPhase(events, to) {
      events.push({ type: 'phase', from: state.phase, to: to });
      state.phase = to;
    }

    // ------------------------------------------------------------ play helpers ---

    function canPlay(player) {
      if (player === null) return false;
      var hand = state.hands[player];
      var room = MAX_COUNT - state.play.count;
      for (var i = 0; i < hand.length; i++) {
        if (hand[i].value <= room) return true;
      }
      return false;
    }

    function playIsComplete() {
      return state.hands[0].length === 0 && state.hands[1].length === 0 &&
        state.play.series.length === 0;
    }

    // ----------------------------------------------------------------- queries ---

    function pendingActor() {
      switch (state.phase) {
        case PHASES.CUT_FOR_DEAL:
          // The cut is a single joint beat; player 0 is the nominal actor that drives it.
          return 0;
        case PHASES.DISCARD:
          if (!state.discarded[pone()]) return pone();
          if (!state.discarded[state.dealer]) return state.dealer;
          return null;
        case PHASES.PLAY:
          // A player who cannot play is not a decision — the engine says "go" for them.
          return canPlay(state.play.toMove) ? state.play.toMove : null;
        default:
          return null;
      }
    }

    function legalActions() {
      var actor = pendingActor();
      if (actor === null) return [];
      var out = [];
      var i;
      var j;
      if (state.phase === PHASES.CUT_FOR_DEAL) {
        out.push({ type: 'cutForDeal', player: actor });
        return out;
      }
      if (state.phase === PHASES.DISCARD) {
        var hand = state.hands[actor];
        for (i = 0; i < hand.length; i++) {
          for (j = i + 1; j < hand.length; j++) {
            out.push({ type: 'discard', player: actor, cards: [hand[i], hand[j]] });
          }
        }
        return out;
      }
      if (state.phase === PHASES.PLAY) {
        var room = MAX_COUNT - state.play.count;
        var playable = state.hands[actor];
        for (i = 0; i < playable.length; i++) {
          if (playable[i].value <= room) out.push({ type: 'play', player: actor, card: playable[i] });
        }
        return out;
      }
      return out;
    }

    function getState() {
      var pile = state.play.pile;
      var pileOut = new Array(pile.length);
      for (var i = 0; i < pile.length; i++) pileOut[i] = pile[i];
      return deepFreeze({
        phase: state.phase,
        dealer: state.dealer,
        // Whose turn it is in the current phase. During the play this is the player to
        // move even when their only move is a go, which is why it is not pendingActor().
        toMove: state.phase === PHASES.PLAY ? state.play.toMove : pendingActor(),
        scores: state.scores.slice(),
        prevScores: state.prevScores.slice(),
        hands: [state.hands[0].slice(), state.hands[1].slice()],
        showHands: [state.showHands[0].slice(), state.showHands[1].slice()],
        crib: state.crib.slice(),
        starter: state.starter,
        // The undealt remainder. Exposed for persistence and tests; the AI must not read it.
        deck: state.deck.slice(),
        cardsRemaining: state.deck.length,
        discarded: state.discarded.slice(),
        play: {
          count: state.play.count,
          series: state.play.series.slice(),
          pile: pileOut,
          lastPlayer: state.play.lastPlayer,
          goSaid: state.play.goSaid.slice(),
          toMove: state.play.toMove
        },
        winner: state.winner,
        skunk: state.skunk,
        targetScore: targetScore,
        handNumber: state.handNumber
      });
    }

    function isOver() {
      return state.winner !== null;
    }

    // ----------------------------------------------------------------- actions ---

    function apply(action) {
      if (state.winner !== null) {
        throw new Error('apply: the game is over; no further actions are accepted');
      }
      if (!action || typeof action.type !== 'string') {
        throw new Error('apply: an action must be an object with a type');
      }
      var actor = pendingActor();
      if (actor === null) {
        throw new Error('apply: no player action is pending in phase ' + state.phase +
          '; call advance()');
      }
      if (action.player !== undefined && action.player !== null && action.player !== actor) {
        throw new Error('apply: it is player ' + actor + "'s turn, not player " +
          action.player + "'s");
      }
      switch (action.type) {
        case 'cutForDeal':
          if (state.phase !== PHASES.CUT_FOR_DEAL) {
            throw new Error('apply: cutForDeal is not legal in phase ' + state.phase);
          }
          return applyCutForDeal();
        case 'discard':
          if (state.phase !== PHASES.DISCARD) {
            throw new Error('apply: discard is not legal in phase ' + state.phase);
          }
          return applyDiscard(actor, action.cards);
        case 'play':
          if (state.phase !== PHASES.PLAY) {
            throw new Error('apply: play is not legal in phase ' + state.phase);
          }
          return applyPlay(actor, action.card);
        default:
          throw new Error('apply: unknown action type "' + action.type + '"');
      }
    }

    function applyCutForDeal() {
      var events = [];
      var deck = Cards.shuffle(freshDeck(), rng);
      var a = deck[0];
      var b = deck[1];
      if (a.rank === b.rank) {
        // A tie is a real beat: the cut is shown, nobody deals, and the caller cuts again.
        events.push({ type: 'cutForDeal', cuts: [a, b], dealer: null });
        return events;
      }
      var dealer = a.rank < b.rank ? 0 : 1;
      state.dealer = dealer;
      events.push({ type: 'cutForDeal', cuts: [a, b], dealer: dealer });
      setPhase(events, PHASES.DEAL);
      return events;
    }

    function applyDiscard(actor, cards) {
      if (!Array.isArray(cards) || cards.length !== 2) {
        throw new Error('apply: a discard must name exactly 2 cards');
      }
      var first = toCard(cards[0]);
      var second = toCard(cards[1]);
      if (first.id === second.id) {
        throw new Error('apply: cannot discard the same card twice (' +
          Cards.cardName(first) + ')');
      }
      var hand = state.hands[actor];
      var iFirst = indexOfCard(hand, first);
      var iSecond = indexOfCard(hand, second);
      if (iFirst < 0 || iSecond < 0) {
        throw new Error('apply: player ' + actor + ' does not hold ' +
          Cards.cardName(iFirst < 0 ? first : second));
      }
      var events = [];
      var chosen = [hand[iFirst], hand[iSecond]];
      state.hands[actor] = hand.filter(function (c) {
        return c.id !== first.id && c.id !== second.id;
      });
      state.crib.push(chosen[0], chosen[1]);
      state.discarded[actor] = true;
      events.push({ type: 'discard', player: actor, cards: chosen.slice() });
      if (state.discarded[0] && state.discarded[1]) {
        events.push({ type: 'cribComplete' });
        setPhase(events, PHASES.CUT_STARTER);
      }
      return events;
    }

    function applyPlay(actor, cardInput) {
      var card = toCard(cardInput);
      var hand = state.hands[actor];
      var idx = indexOfCard(hand, card);
      if (idx < 0) {
        throw new Error('apply: player ' + actor + ' does not hold ' + Cards.cardName(card));
      }
      var held = hand[idx];
      if (state.play.count + held.value > MAX_COUNT) {
        throw new Error('apply: ' + Cards.cardName(held) + ' would take the count to ' +
          (state.play.count + held.value));
      }
      var events = [];
      var before = state.play.series.slice();
      hand.splice(idx, 1);
      state.play.series.push(held);
      state.play.pile.push(Object.freeze({ player: actor, card: held }));
      state.play.count += held.value;
      state.play.lastPlayer = actor;
      events.push({ type: 'play', player: actor, card: held, count: state.play.count });

      var scored = Scoring.scorePlay(before, held);
      for (var i = 0; i < scored.breakdown.length; i++) {
        var entry = scored.breakdown[i];
        if (!award(events, actor, entry.points, entry.label, entry.cards, 'play')) return events;
      }

      state.play.toMove = 1 - actor;
      return events;
    }

    // ------------------------------------------------------ engine-driven beats ---

    function advance() {
      if (state.winner !== null) {
        throw new Error('advance: the game is over; there is nothing left to step');
      }
      if (pendingActor() !== null) {
        throw new Error('advance: player ' + pendingActor() + ' has a decision pending in ' +
          'phase ' + state.phase + '; call apply()');
      }
      switch (state.phase) {
        case PHASES.DEAL: return doDeal();
        case PHASES.CUT_STARTER: return doCutStarter();
        case PHASES.PLAY: return doPlayBeat();
        case PHASES.SHOW_PONE:
        case PHASES.SHOW_DEALER:
        case PHASES.SHOW_CRIB: return doShowBeat();
        case PHASES.HAND_END: return doHandEnd();
        default:
          throw new Error('advance: nothing to advance in phase ' + state.phase);
      }
    }

    function nextDeck() {
      if (deckOption === null) return Cards.shuffle(freshDeck(), rng);
      if (typeof deckOption === 'function') return normalizeDeck(deckOption(state.handNumber));
      return deckOption.slice();
    }

    function doDeal() {
      var events = [];
      state.handNumber++;
      var deck = nextDeck();
      var hands = [[], []];
      var lead = pone();
      // Dealt one at a time, alternating, starting with the non-dealer.
      for (var i = 0; i < HAND_SIZE * 2; i++) {
        hands[i % 2 === 0 ? lead : state.dealer].push(deck[i]);
      }
      state.hands = hands;
      state.deck = deck.slice(HAND_SIZE * 2);
      state.crib = [];
      state.starter = null;
      state.discarded = [false, false];
      state.showHands = [[], []];
      events.push({
        type: 'deal',
        hands: [hands[0].slice(), hands[1].slice()],
        dealer: state.dealer
      });
      setPhase(events, PHASES.DISCARD);
      return events;
    }

    function doCutStarter() {
      var events = [];
      var card = state.deck.shift();
      state.starter = card;
      events.push({ type: 'starter', card: card });
      // His heels pays the dealer 2 at cut time, and can win the game outright — which is
      // why it goes through award() like everything else instead of touching scores here.
      var heels = Scoring.scoreHeels(card);
      if (heels > 0) {
        if (!award(events, state.dealer, heels, 'His heels', [card], 'heels')) return events;
      }
      state.showHands = [state.hands[0].slice(), state.hands[1].slice()];
      state.play = {
        count: 0,
        series: [],
        pile: [],
        lastPlayer: null,
        goSaid: [false, false],
        toMove: pone()
      };
      setPhase(events, PHASES.PLAY);
      return events;
    }

    // One beat of the play that is NOT a card: a go, or the end of a series.
    function doPlayBeat() {
      var events = [];
      if (playIsComplete()) {
        setPhase(events, PHASES.SHOW_PONE);
        return events;
      }

      var stuck = state.play.toMove;
      var other = 1 - stuck;

      // A player with no cards left is simply always unable to play. The accounting below
      // does not special-case them; only the cosmetic 'go' event is suppressed, because a
      // player with an empty hand has nothing to declare.
      function announceGo() {
        if (state.hands[stuck].length > 0 && !state.play.goSaid[stuck]) {
          events.push({ type: 'go', player: stuck });
        }
        state.play.goSaid[stuck] = true;
      }

      if (canPlay(other)) {
        announceGo();
        state.play.toMove = other;
        return events;
      }

      // Neither player can add a card: the series is over.
      // At 31 the count is dead — nobody declares a go and nobody takes the go point,
      // because the 2 for thirty-one already went through award() when the card was played.
      var last = state.play.lastPlayer;
      if (state.play.count !== MAX_COUNT) {
        announceGo();
        state.play.goSaid[other] = true;
        var lastCard = state.play.series[state.play.series.length - 1];
        if (last !== null) {
          if (!award(events, last, 1, 'Last card', [lastCard], 'play')) return events;
        }
      } else {
        state.play.goSaid[0] = true;
        state.play.goSaid[1] = true;
      }

      // The player who did NOT play the last card leads the next series. If they are out
      // of cards they simply cannot play, and the next beat hands the lead straight back.
      var nextLeader = last === null ? stuck : 1 - last;
      state.play.count = 0;
      state.play.series = [];
      state.play.lastPlayer = null;
      state.play.goSaid = [false, false];
      state.play.toMove = nextLeader;
      events.push({ type: 'seriesReset', nextLeader: nextLeader });
      return events;
    }

    // Non-dealer's hand, then dealer's hand, then the dealer's crib. The order is
    // load-bearing: a pone at 115 must be able to win before the dealer ever counts.
    function showSpec() {
      if (state.phase === PHASES.SHOW_PONE) {
        return {
          player: pone(),
          source: 'hand',
          isCrib: false,
          cards: state.showHands[pone()],
          next: PHASES.SHOW_DEALER
        };
      }
      if (state.phase === PHASES.SHOW_DEALER) {
        return {
          player: state.dealer,
          source: 'hand',
          isCrib: false,
          cards: state.showHands[state.dealer],
          next: PHASES.SHOW_CRIB
        };
      }
      return {
        player: state.dealer,
        source: 'crib',
        isCrib: true,
        cards: state.crib,
        next: PHASES.HAND_END
      };
    }

    // One combination per beat — each breakdown entry is one beat of the counting
    // animation, and the award gate stops the count dead the moment it wins.
    function doShowBeat() {
      var events = [];
      var spec = showSpec();
      if (state.show.breakdown === null) {
        var scored = Scoring.scoreHand(spec.cards, state.starter, spec.isCrib);
        state.show.breakdown = scored.breakdown;
        state.show.total = scored.total;
        state.show.index = 0;
        events.push({
          type: 'showStart',
          player: spec.player,
          source: spec.source,
          cards: spec.cards.slice(),
          starter: state.starter,
          handTotal: scored.total
        });
        return events;
      }
      if (state.show.index < state.show.breakdown.length) {
        var entry = state.show.breakdown[state.show.index];
        state.show.index++;
        award(events, spec.player, entry.points, entry.label, entry.cards, spec.source);
        return events;
      }
      state.show.breakdown = null;
      state.show.index = -1;
      state.show.total = 0;
      setPhase(events, spec.next);
      return events;
    }

    function doHandEnd() {
      var events = [];
      // dealer here is the dealer of the hand that just ended.
      events.push({ type: 'handEnd', dealer: state.dealer });
      state.dealer = 1 - state.dealer;
      state.hands = [[], []];
      state.showHands = [[], []];
      state.crib = [];
      state.starter = null;
      state.deck = [];
      state.discarded = [false, false];
      state.play = {
        count: 0,
        series: [],
        pile: [],
        lastPlayer: null,
        goSaid: [false, false],
        toMove: null
      };
      state.show = { index: -1, breakdown: null, total: 0 };
      setPhase(events, PHASES.DEAL);
      return events;
    }

    return {
      getState: getState,
      pendingActor: pendingActor,
      legalActions: legalActions,
      apply: apply,
      advance: advance,
      isOver: isOver
    };
  }

  root.Cribbage = root.Cribbage || {};
  root.Cribbage.Engine = {
    createGame: createGame,
    PHASES: PHASES
  };
})(typeof window !== 'undefined' ? window : globalThis);
