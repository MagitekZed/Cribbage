(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // game.js — the controller.
  //
  // It is the only file that knows about all four of the engine, the renderer,
  // the animator and the keyboard. Everything else stays ignorant of the others,
  // which is what has let each of them be tested on its own.
  //
  // THE ONE RULE: the display is never mutated in response to input. A click is
  // turned into an engine action; the engine returns EVENTS and a new snapshot;
  // the animator plays the events and the renderer paints the snapshot. So the
  // screen can only ever show something the rules actually produced — a bug can
  // make the game wrong, but it cannot make the game LIE.
  //
  // The loop is a trampoline rather than a recursive promise chain. `pump()`
  // steps until it hits something it must wait for, and each wait re-enters via
  // a bare call from inside .then() — never `return step()` — so a 400-beat game
  // does not build a 400-deep promise adoption chain.
  //
  // Two guards keep it honest under a fast clicker and a New Game mid-animation:
  //
  //   `awaiting`    is true only while a human decision is genuinely pending.
  //                 Every input path tests it AND anim.isBusy(). Nothing else
  //                 gates input; CSS pointer-events is a courtesy, not the lock.
  //   `generation`  is bumped by newGame() and destroy(). Every asynchronous
  //                 continuation compares the token it captured against it and
  //                 returns if they differ, so a torn-down session can never
  //                 paint over a fresh one.
  // ---------------------------------------------------------------------------

  var Cards = root.Cribbage && root.Cribbage.Cards;
  var Scoring = root.Cribbage && root.Cribbage.Scoring;

  // How long the opponent "thinks" before a decision. Long enough to read as a
  // person considering, short enough not to be a wait. It scales with the
  // animation speed, so at --anim-scale 0 the whole game is instant.
  var THINK_MS = 550;

  function noop() {}

  function isFn(f) {
    return typeof f === 'function';
  }

  function el(doc, tag, cls, text) {
    var node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function noSleep() {
    return Promise.resolve();
  }

  // =========================================================================
  // The opponent seam.
  //
  // Phase 5 replaces the OBJECT below and nothing else moves. The contract is
  // exactly two methods, both synchronous, both handed frozen engine data:
  //
  //   chooseDiscard(hand, isOwnCrib, state) -> [cardA, cardB]
  //   choosePlay(legalCards, state)         -> one of legalCards
  //
  // `hand` and `legalCards` are the engine's own frozen card objects, so an
  // implementation can return them straight back. `state` is a getState()
  // snapshot — note that it carries `deck`, which an honest opponent must not
  // read. The controller validates whatever comes back and falls back to a
  // legal move rather than trusting it, so a broken tier cannot wedge the game.
  //
  // What is below is a PLACEHOLDER. It is deliberately shallow — no starter
  // enumeration, no crib EV, no lookahead — and exists only so the game is
  // playable end to end this phase.
  // =========================================================================

  // How much a two-card lay-away is worth sitting IN a crib, before we decide
  // whose crib it is. Weights are eyeballed, not derived; the real numbers are
  // Phase 5's job.
  function layAwayValue(a, b) {
    var v = 0;
    if (a.rank === 5 || b.rank === 5) v += 2.5;
    if (a.rank === b.rank) v += 2;
    if (a.value + b.value === 15) v += 2;
    var gap = Math.abs(a.rank - b.rank);
    if (gap === 1) v += 1.2;
    else if (gap === 2) v += 0.6;
    if (a.suit === b.suit) v += 0.4;
    return v;
  }

  function createPlaceholderOpponent() {
    return {
      name: 'placeholder',

      chooseDiscard: function (hand, isOwnCrib) {
        var pairs = [];
        var i;
        var j;
        for (i = 0; i < hand.length; i++) {
          for (j = i + 1; j < hand.length; j++) pairs.push([hand[i], hand[j]]);
        }

        // A hard rule, not a weighting: a five in the opponent's crib is the
        // single worst lay-away in the game, and no heuristic score should ever
        // be allowed to outvote it. Four fives is the most anyone can hold, so
        // there is always at least one five-free pair to fall back to.
        if (!isOwnCrib) {
          var safe = pairs.filter(function (p) {
            return p[0].rank !== 5 && p[1].rank !== 5;
          });
          if (safe.length) pairs = safe;
        }

        var best = pairs[0];
        var bestScore = -Infinity;
        for (i = 0; i < pairs.length; i++) {
          var pair = pairs[i];
          var kept = hand.filter(function (c) {
            return c.id !== pair[0].id && c.id !== pair[1].id;
          });
          // No starter: a floor on the kept hand rather than its expectation.
          var score = Scoring.scoreHand(kept, null, false).total;
          score += (isOwnCrib ? 1 : -1) * layAwayValue(pair[0], pair[1]);
          if (score > bestScore) {
            bestScore = score;
            best = pair;
          }
        }
        return best;
      },

      choosePlay: function (legal, state) {
        var series = state.play.series;
        var count = state.play.count;
        var best = legal[0];
        var bestScore = -Infinity;
        for (var i = 0; i < legal.length; i++) {
          var card = legal[i];
          var points = Scoring.scorePlay(series, card).points;
          var after = count + card.value;
          var score = points * 10;
          if (after === 31) score += 6;
          // Sixteen of fifty-two cards are worth ten, so leaving the count at 5
          // or 21 hands over a fifteen or a thirty-one far too often.
          if (after === 5 || after === 21) score -= 4;
          if (count === 0 && card.rank === 5) score -= 5;
          // All else equal, get the big cards out early and keep the low ones
          // for the awkward end of a series.
          score -= card.value * 0.1;
          if (score > bestScore) {
            bestScore = score;
            best = card;
          }
        }
        return best;
      }
    };
  }

  // =========================================================================
  // The controller
  // =========================================================================

  /**
   * create(rootEl, opts) -> controller
   *
   *   opts.me           which seat the human takes. 0 (default) or 1.
   *   opts.labels       ['You', 'Opponent'] indexed by player number.
   *   opts.targetScore  121 (default) or 61.
   *   opts.opponent     the AI seam. Defaults to the placeholder above.
   *   opts.thinkMs      the opponent's artificial pause. Default 550.
   *   opts.speed        an explicit --anim-scale. OMITTED BY DEFAULT, so the
   *                     prefers-reduced-motion floor in theme.css holds unless
   *                     something actually asks for a speed.
   *   opts.rng          injectable shuffle source, for a reproducible game.
   *   opts.dealer       0 | 1 to skip the cut for deal. Default null: cut.
   *   opts.fourColor    start with the four-colour deck.
   */
  function create(rootEl, opts) {
    if (!Cards || !Scoring) {
      throw new Error('Cribbage.Game: cards.js and scoring.js must load first');
    }
    var Engine = root.Cribbage && root.Cribbage.Engine;
    var Render = root.Cribbage && root.Cribbage.Render;
    var Animate = root.Cribbage && root.Cribbage.Animate;
    if (!Engine || !Render || !Animate) {
      throw new Error('Cribbage.Game: engine.js, render.js and animate.js must load first');
    }
    if (!rootEl) throw new Error('Cribbage.Game.create: no root element');

    opts = opts || {};
    var doc = rootEl.ownerDocument || root.document;
    var me = opts.me === 1 ? 1 : 0;
    var them = 1 - me;
    var labels = opts.labels || (me === 0 ? ['You', 'Opponent'] : ['Opponent', 'You']);
    var targetScore = opts.targetScore === 61 ? 61 : 121;
    var opponent = opts.opponent || createPlaceholderOpponent();
    var thinkMs = typeof opts.thinkMs === 'number' ? opts.thinkMs : THINK_MS;
    // null means "cut for deal". Held locally rather than read back off opts,
    // because newGame() may change it and the caller's object is theirs.
    var dealer = opts.dealer === 0 || opts.dealer === 1 ? opts.dealer : null;

    // Bumped by newGame() and destroy(). Everything asynchronous carries a copy.
    var generation = 0;
    var session = null;

    // ---------------------------------------------------------------- speed ---

    // The controller keeps its own copy so the think delay can scale with it.
    // create() deliberately does NOT write --anim-scale: animate.js reads the
    // cascade, and writing a 1 here would stamp on the reduced-motion floor.
    var speed = 1;

    function readSpeed() {
      if (!isFn(root.getComputedStyle) || !doc.documentElement) return;
      try {
        var raw = root.getComputedStyle(doc.documentElement)
          .getPropertyValue('--anim-scale');
        var n = parseFloat(raw);
        if (isFinite(n) && n >= 0) speed = n;
      } catch (err) {
        // A styleless document is not a reason to refuse to run.
      }
    }

    readSpeed();

    // -------------------------------------------------------- session build ---

    function build() {
      var view = Render.mount(rootEl, {
        me: me,
        labels: labels,
        targetScore: targetScore,
        fourColor: !!opts.fourColor,
        interactive: true
      });

      var anim = Animate.create(view, {});
      if (typeof opts.speed === 'number') speed = anim.setSpeed(opts.speed);

      var game = Engine.createGame({
        targetScore: targetScore,
        rng: opts.rng,
        dealer: dealer
      });

      return {
        view: view,
        anim: anim,
        game: game,
        unbind: [],
        // Per-hand scoring, bucketed for the history log. Reset on every deal.
        ledger: newLedger(),
        handNumber: 0,
        // The count panel's live rows.
        tally: { total: 0, totalRow: null, totalValue: null }
      };
    }

    function newLedger() {
      return [
        { peg: 0, hand: 0, crib: 0, heels: 0, total: 0 },
        { peg: 0, hand: 0, crib: 0, heels: 0, total: 0 }
      ];
    }

    // ------------------------------------------------------------ ui state ---

    var awaiting = false;      // a human decision is genuinely pending
    var selection = [];        // card ids raised during the lay-away
    var controls = null;       // the controls bar this file owns
    var announcer = null;      // the append-only live region
    var thinking = null;       // the opponent's pause, held so skip can cut it short

    // The opponent's artificial pause. Held rather than fired and forgotten,
    // because a bare setTimeout is the one thing Skip cannot reach: pressing S
    // while the opponent "thinks" would sit there doing nothing, which reads as
    // a broken button in exactly the moment a player reaches for it.
    //
    // Cutting the pause that is already running is not enough on its own. Every
    // opponent turn asks for a fresh one, so while fast-forward is armed the
    // pause must not happen at all — otherwise a skipped count still stops dead
    // for half a second at each of the opponent's plays.
    function think(duration) {
      if (!(duration >= 1)) return noSleep();
      if (session && session.anim.isSkipping()) return noSleep();
      return new Promise(function (resolve) {
        var entry = { timer: 0 };
        entry.done = function () {
          if (thinking !== entry) return;
          thinking = null;
          clearTimeout(entry.timer);
          resolve();
        };
        entry.timer = setTimeout(entry.done, duration);
        thinking = entry;
      });
    }

    function state() {
      return session.game.getState();
    }

    function busy() {
      return !!session && session.anim.isBusy();
    }

    // "The game is doing something and it is not your turn." Wider than busy():
    // it also covers the opponent's pause, which is a wait the player can skip
    // and therefore a wait the Skip button has to admit to.
    function waiting() {
      return busy() || !!thinking;
    }

    function cribWord(snapshot) {
      return snapshot.dealer === me ? 'your crib' : 'their crib';
    }

    // ---------------------------------------------------------------- hints ---

    // The one thing an engine snapshot cannot say is which of the human's cards
    // are legal, so the controller works it out and hands it to render.js. It is
    // supplied ONLY while the human may actually act: dimming a whole hand every
    // time it is not your turn is noise, not information.
    function hintsFor(snapshot) {
      var playable = null;
      if (awaiting && snapshot.phase === 'PLAY' && snapshot.toMove === me) {
        playable = session.game.legalActions().map(function (a) { return a.card.id; });
      }
      return { selected: selection.slice(), playable: playable };
    }

    // ------------------------------------------------------------- painting ---

    // Everything the controller adds on top of a render.js paint. It must run
    // after EVERY paint, because render.js rewrites aria-label from the card's
    // own data-label on each tune and would otherwise wipe the reason.
    function decorate(snapshot) {
      var cards = session.view.handCards(me);
      var live = awaiting && snapshot.phase === 'PLAY' && snapshot.toMove === me;
      var room = 31 - snapshot.play.count;
      for (var i = 0; i < cards.length; i++) {
        var node = cards[i];
        var id = Number(node.getAttribute('data-card-id'));
        var value = isNaN(id) ? 0 : Cards.cardFromId(id).value;
        if (live && value > room) {
          // A disabled button is not tab-reachable, so `title` alone would leave
          // keyboard and screen-reader users without the reason. Folding it into
          // the accessible name is what actually makes it available.
          var why = 'would make ' + (snapshot.play.count + value) + ', over 31';
          node.setAttribute('title', 'Unplayable — ' + why + '.');
          node.setAttribute('aria-label',
            (node.getAttribute('data-label') || 'Card') + ' — unplayable, ' + why);
        } else {
          node.removeAttribute('title');
        }
      }
    }

    function statusNote(snapshot) {
      if (!awaiting || snapshot.phase !== 'DISCARD') return null;
      if (selection.length === 2) {
        return 'Two cards chosen — lay them away to ' + cribWord(snapshot) + '.';
      }
      if (selection.length === 1) {
        return 'One more card for ' + cribWord(snapshot) + '.';
      }
      return null;   // render.js's own sentence is already exactly right
    }

    function repaint() {
      if (!session) return;
      var snapshot = state();
      var note = statusNote(snapshot);
      session.view.setStatus(note, note ? 'mine' : 'none');
      session.view.renderState(snapshot, hintsFor(snapshot));
      decorate(snapshot);
      updateControls(snapshot);
    }

    // ------------------------------------------------------------- controls ---

    function buildControls(view) {
      var bar = el(doc, 'div', 'controls');
      bar.setAttribute('role', 'group');
      bar.setAttribute('aria-label', 'Game controls');

      var confirm = el(doc, 'button', 'btn controls__confirm', 'Lay away');
      confirm.type = 'button';
      confirm.hidden = true;
      confirm.addEventListener('click', onConfirm);

      var hint = el(doc, 'span', 'controls__hint', '');

      var right = el(doc, 'div', 'controls__right');

      var skip = el(doc, 'button', 'btn btn--quiet controls__skip', '');
      skip.type = 'button';
      skip.appendChild(doc.createTextNode('Skip '));
      var skipKey = el(doc, 'kbd', 'btn__key', 'S');
      skip.appendChild(skipKey);
      skip.title = 'Fast-forward the animation (S or space)';
      skip.addEventListener('click', function () { skipAnimation(); });

      var fresh = el(doc, 'button', 'btn btn--quiet controls__new', 'New game');
      fresh.type = 'button';
      fresh.addEventListener('click', function () { newGame(); });

      right.appendChild(skip);
      right.appendChild(fresh);

      bar.appendChild(confirm);
      bar.appendChild(hint);
      bar.appendChild(right);
      view.el.game.appendChild(bar);

      return { bar: bar, confirm: confirm, hint: hint, skip: skip, fresh: fresh };
    }

    function updateControls(snapshot) {
      if (!controls) return;
      var discarding = awaiting && snapshot.phase === 'DISCARD';
      controls.confirm.hidden = !discarding;
      controls.confirm.disabled = selection.length !== 2;
      controls.confirm.textContent = 'Lay away 2 to ' + cribWord(snapshot);

      var hint = '';
      if (discarding) hint = selection.length + ' of 2 chosen';
      else if (snapshot.phase === 'GAME_OVER') {
        hint = snapshot.winner === me ? 'You won.' : labels[snapshot.winner] + ' won.';
      }
      controls.hint.textContent = hint;

      // Left enabled at all times on purpose: a button that disables itself
      // between beats throws focus away mid-keypress. Pressing it with nothing
      // in flight is simply a no-op.
      controls.skip.setAttribute('data-active', waiting() ? 'true' : 'false');
      controls.fresh.textContent = snapshot.phase === 'GAME_OVER' ? 'Play again' : 'New game';
      controls.fresh.className = snapshot.phase === 'GAME_OVER'
        ? 'btn controls__new' : 'btn btn--quiet controls__new';

      session.view.el.app.setAttribute('data-busy', waiting() ? 'true' : 'false');
      session.view.el.app.setAttribute('data-awaiting', awaiting ? 'true' : 'false');
    }

    // ------------------------------------------------------------ announcer ---

    // An append-only live region. The status line is a live region too, but a
    // polite region that is rewritten every beat gets coalesced down to whatever
    // it happens to be holding when the reader catches up — so the sentence that
    // matters most (a score) is exactly the one most likely to be swallowed.
    // role="log" is announced in order, addition by addition, and loses nothing.
    function buildAnnouncer(view) {
      var box = el(doc, 'div', 'visually-hidden announcer');
      box.setAttribute('role', 'log');
      box.setAttribute('aria-live', 'polite');
      box.setAttribute('aria-relevant', 'additions text');
      view.el.app.appendChild(box);
      return box;
    }

    function announce(text) {
      if (!announcer || !text) return;
      announcer.appendChild(el(doc, 'p', null, text));
      while (announcer.children.length > 40) {
        announcer.removeChild(announcer.firstChild);
      }
    }

    // -------------------------------------------------------- the count panel ---

    function tallyClear() {
      var list = session.view.el.breakdownList;
      while (list.firstChild) list.removeChild(list.firstChild);
      session.view.el.breakdownEmpty.hidden = false;
      session.tally.total = 0;
      session.tally.totalRow = null;
      session.tally.totalValue = null;
    }

    function buildTallyRow(cls, labelText, pointsText) {
      var li = el(doc, 'li', cls);
      li.appendChild(el(doc, 'span', 'tally__label', labelText));
      if (pointsText !== null) li.appendChild(el(doc, 'span', 'tally__points', pointsText));
      return li;
    }

    // Rows always land ABOVE the total, which is created up front and stays
    // last — so the total ticks up as the count proceeds instead of appearing
    // from nowhere at the end.
    function tallyInsert(row) {
      var list = session.view.el.breakdownList;
      var total = session.tally.totalRow;
      if (total && total.parentNode === list) list.insertBefore(row, total);
      else list.appendChild(row);
      session.view.el.breakdownEmpty.hidden = true;
      return row;
    }

    function tallyStart(ev) {
      tallyClear();
      var who = ev.player === me ? 'Your ' : labels[ev.player] + "'s ";
      tallyInsert(buildTallyRow('tally__row tally__row--head',
        who + (ev.source === 'crib' ? 'crib' : 'hand'), null));

      session.tally.totalRow = buildTallyRow('tally__row', 'Total', '0');
      session.tally.totalRow.setAttribute('data-total', 'true');
      session.tally.totalValue = session.tally.totalRow.lastChild;
      tallyInsert(session.tally.totalRow);

      // A hand that scores nothing emits no score events at all, so without
      // this the panel would sit on an empty "Total 0" and look broken.
      if (ev.handTotal === 0) {
        tallyInsert(buildTallyRow('tally__row tally__row--nil', 'Nothing scores', '0'));
      }
      session.view.setPanelOpen('breakdown', true);
    }

    function tallyScore(ev) {
      if (ev.source !== 'hand' && ev.source !== 'crib') return;
      tallyInsert(buildTallyRow('tally__row', ev.reason, '+' + ev.points));
      session.tally.total += ev.points;
      if (session.tally.totalValue) {
        session.tally.totalValue.textContent = String(session.tally.total);
      }
    }

    // ------------------------------------------------------ the history log ---

    function ledgerAdd(ev) {
      var slot = session.ledger[ev.player];
      if (ev.source === 'crib') slot.crib += ev.points;
      else if (ev.source === 'hand') slot.hand += ev.points;
      else if (ev.source === 'heels') slot.heels += ev.points;
      else slot.peg += ev.points;
      slot.total += ev.points;
    }

    function partsOf(slot) {
      var parts = [];
      if (slot.peg) parts.push('pegging ' + slot.peg);
      if (slot.heels) parts.push('his heels ' + slot.heels);
      if (slot.hand) parts.push('hand ' + slot.hand);
      if (slot.crib) parts.push('crib ' + slot.crib);
      return parts.length ? parts.join(' · ') : 'nothing';
    }

    function logHand(snapshot) {
      if (!session.ledger[0].total && !session.ledger[1].total && !session.handNumber) return;
      var list = session.view.el.historyList;
      var li = el(doc, 'li', 'log__row');

      var head = el(doc, 'span', 'log__head');
      head.appendChild(el(doc, 'span', 'log__who', 'Hand ' + session.handNumber));
      head.appendChild(el(doc, 'span', 'log__points',
        snapshot.scores[me] + '–' + snapshot.scores[them]));
      li.appendChild(head);

      for (var p = 0; p < 2; p++) {
        var slot = session.ledger[p];
        var line = el(doc, 'span', 'log__line');
        line.appendChild(el(doc, 'span', 'log__name',
          (p === me ? 'You' : labels[p]) + ' +' + slot.total));
        line.appendChild(doc.createTextNode(' — ' + partsOf(slot)));
        li.appendChild(line);
      }

      // Newest first: the panel is a narrow column, and the hand you have just
      // finished is the one you want to read without scrolling. Every row is
      // numbered, so the order is never ambiguous.
      list.insertBefore(li, list.firstChild);
      session.view.el.historyEmpty.hidden = true;
      session.ledger = newLedger();
    }

    // ------------------------------------------------------------ the beats ---

    // One handler for every visible moment. It runs BEFORE the beat's motion,
    // so the panel row, the spoken line and the card that lights up all land
    // together. It is presentation only: nothing here can change the game.
    function onBeat(beat) {
      if (!session) return;
      if (beat.label) session.view.setStatus(beat.label, 'none');
      var ev = beat.event;

      switch (beat.kind) {
        case 'deal':
          session.handNumber++;
          session.ledger = newLedger();
          tallyClear();
          if (isPhone()) session.view.setPanelOpen('breakdown', false);
          announce('Hand ' + session.handNumber + '. ' +
            (ev.dealer === me ? 'Your deal.' : labels[ev.dealer] + ' deals.'));
          break;
        case 'starter':
          announce('The cut is ' + Cards.cardName(ev.card) + '.');
          break;
        case 'score':
          ledgerAdd(ev);
          tallyScore(ev);
          announce((ev.player === me ? 'You score ' : labels[ev.player] + ' scores ') +
            ev.points + ' for ' + ev.reason.toLowerCase() + '. Now ' + ev.total + '.');
          break;
        case 'showStart':
          tallyStart(ev);
          announce('Counting ' + (ev.player === me ? 'your ' : labels[ev.player] + "'s ") +
            (ev.source === 'crib' ? 'crib.' : 'hand.'));
          break;
        case 'go':
          announce(ev.player === me ? 'You say go.' : labels[ev.player] + ' says go.');
          break;
        case 'handEnd':
          logHand(state());
          break;
        case 'gameOver':
          logHand(state());
          announce(beat.label);
          break;
        default:
          break;
      }
    }

    function isPhone() {
      return !!(root.matchMedia && root.matchMedia('(max-width: 639.98px)').matches);
    }

    // ---------------------------------------------------------------- the loop ---

    // The single place events reach the screen. Nothing else calls anim.play().
    function runEvents(events) {
      var token = generation;
      awaiting = false;
      var snapshot = state();
      var hints = hintsFor(snapshot);
      var done = session.anim.play(events, snapshot, hints);
      // AFTER play(), never before: isBusy() only becomes true once the job is
      // queued, so asking first paints "idle" for the whole drain and the busy
      // lock and the Skip light never come on.
      updateControls(snapshot);
      return done.then(function () {
        if (token !== generation || !session) return;
        session.view.setStatus(null);
        repaint();
      });
    }

    var pumping = false;

    /**
     * pump() — run the game forward until it needs something it cannot supply.
     *
     * It stops on exactly three things: the human's turn, the end of the game,
     * and each asynchronous wait (an animation drain or the opponent's pause),
     * which re-enters it from inside a .then().
     */
    function pump() {
      if (pumping || !session) return;
      pumping = true;
      var token = generation;
      stepOnce();

      function again() {
        if (token !== generation || !session) { pumping = false; return; }
        stepOnce();
      }

      function stop() {
        pumping = false;
      }

      function stepOnce() {
        if (token !== generation || !session) return stop();
        var game = session.game;
        if (game.isOver()) {
          stop();
          awaiting = false;
          // Nothing is left to be made to wait for, so the mode ends here too.
          session.anim.resume();
          repaint();
          return;
        }

        var actor = game.pendingActor();

        if (actor === null) {
          runEvents(game.advance()).then(again, again);
          return;
        }

        // The cut for deal is a "decision" with exactly one legal action and no
        // information in it. Making the player click it would be ceremony, not
        // agency, so the controller takes it and the animation still shows it.
        if (game.getState().phase === 'CUT_FOR_DEAL') {
          runEvents(game.apply({ type: 'cutForDeal' })).then(again, again);
          return;
        }

        if (actor === me) {
          stop();
          armHuman();
          return;
        }

        stop();
        var pause = think(thinkMs * speed);
        // think() registers itself synchronously, so this paints the pause as a
        // wait the Skip control can act on.
        updateControls(state());
        pause.then(function () {
          if (token !== generation || !session) return;
          var events;
          try {
            events = session.game.apply(opponentAction());
          } catch (err) {
            reportError('the opponent produced an illegal move', err);
            return;
          }
          runEvents(events).then(function () {
            if (token !== generation || !session) return;
            pump();
          });
        });
      }
    }

    // Whatever the seam hands back is checked against the engine's own list of
    // legal actions before it is applied. Phase 5's tiers get to be wrong
    // without being able to wedge the game.
    function opponentAction() {
      var game = session.game;
      var legal = game.legalActions();
      var snapshot = game.getState();

      if (snapshot.phase === 'DISCARD') {
        var chosen = null;
        try {
          chosen = opponent.chooseDiscard(snapshot.hands[them].slice(),
            snapshot.dealer === them, snapshot);
        } catch (err) {
          reportError('the opponent threw while choosing a lay-away', err);
        }
        var match = chosen && chosen.length === 2 ? findDiscard(legal, chosen) : null;
        return match || legal[0];
      }

      var cards = legal.map(function (a) { return a.card; });
      var card = null;
      try {
        card = opponent.choosePlay(cards, snapshot);
      } catch (err) {
        reportError('the opponent threw while choosing a card', err);
      }
      for (var i = 0; i < legal.length; i++) {
        if (card && legal[i].card.id === card.id) return legal[i];
      }
      return legal[0];
    }

    function findDiscard(legal, pair) {
      var a = pair[0] && pair[0].id;
      var b = pair[1] && pair[1].id;
      for (var i = 0; i < legal.length; i++) {
        var ids = [legal[i].cards[0].id, legal[i].cards[1].id];
        if ((ids[0] === a && ids[1] === b) || (ids[0] === b && ids[1] === a)) return legal[i];
      }
      return null;
    }

    function reportError(what, err) {
      if (typeof console !== 'undefined' && console.error) {
        console.error('[cribbage] ' + what + ': ' + ((err && err.message) || err));
      }
    }

    // ------------------------------------------------------------ human input ---

    // Where fast-forward ends. "Skip" means "stop making me wait", and the wait
    // is over the moment it is the player's turn — so one press carries them
    // through the rest of the count, the hand end and the next deal, and hands
    // the table back animating normally. Anything narrower puts the player back
    // to pressing the key once per beat, which is the whole complaint.
    function armHuman() {
      session.anim.resume();
      awaiting = true;
      selection = [];
      repaint();
    }

    function accepting() {
      return !!session && awaiting && !busy();
    }

    function onHandClick(event) {
      var node = event.target && event.target.closest
        ? event.target.closest('.card') : null;
      if (!node || !node.hasAttribute('data-card-id')) return;
      if (!accepting()) return;
      var id = Number(node.getAttribute('data-card-id'));
      if (isNaN(id)) return;
      var snapshot = state();
      if (snapshot.phase === 'DISCARD') toggleSelection(id);
      else if (snapshot.phase === 'PLAY' && snapshot.toMove === me) playCard(id);
    }

    function toggleSelection(id) {
      var at = selection.indexOf(id);
      if (at !== -1) selection.splice(at, 1);
      else {
        selection.push(id);
        // Already holding two and reaching for a third: drop the older choice
        // rather than refusing the click. Silently doing nothing is the reading
        // of "it is stuck" that costs a player thirty seconds.
        while (selection.length > 2) selection.shift();
      }
      repaint();
    }

    function playCard(id) {
      var legal = session.game.legalActions();
      for (var i = 0; i < legal.length; i++) {
        if (legal[i].card.id === id) {
          submit(legal[i]);
          return;
        }
      }
    }

    function onConfirm() {
      if (!accepting() || selection.length !== 2) return;
      if (state().phase !== 'DISCARD') return;
      submit({
        type: 'discard',
        cards: [Cards.cardFromId(selection[0]), Cards.cardFromId(selection[1])]
      });
    }

    // The one door input goes through. It disarms FIRST, so a second click
    // arriving in the same tick as the first finds the door already shut.
    function submit(action) {
      if (!accepting()) return;
      awaiting = false;
      selection = [];
      var events;
      try {
        events = session.game.apply(action);
      } catch (err) {
        reportError('a move was refused', err);
        awaiting = true;
        repaint();
        return;
      }
      var token = generation;
      runEvents(events).then(function () {
        if (token !== generation || !session) return;
        pump();
      });
    }

    // -------------------------------------------------------------- keyboard ---

    function isCardEl(node) {
      return !!(node && node.classList && node.classList.contains('card'));
    }

    function inControls(node) {
      return !!(node && node.closest && node.closest('.controls'));
    }

    function focusableCards() {
      var all = session.view.handCards(me);
      var out = [];
      for (var i = 0; i < all.length; i++) {
        if (all[i].tagName === 'BUTTON' && !all[i].disabled) out.push(all[i]);
      }
      return out;
    }

    // Wraps at both ends: a hand is a ring of at most six, and running off the
    // edge into nothing is a worse surprise than coming back round.
    function moveCursor(delta) {
      var cards = focusableCards();
      if (!cards.length) return false;
      var at = cards.indexOf(doc.activeElement);
      var next = at === -1
        ? (delta > 0 ? 0 : cards.length - 1)
        : (at + delta + cards.length) % cards.length;
      cards[next].focus();
      return true;
    }

    function onKeyDown(event) {
      if (!session) return;
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      var active = doc.activeElement;
      var tag = active && active.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      var key = event.key;

      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        if (moveCursor(key === 'ArrowRight' ? 1 : -1)) event.preventDefault();
        return;
      }

      if (key === 'Escape') {
        if (selection.length) {
          selection = [];
          repaint();
          event.preventDefault();
        }
        return;
      }

      if (key === 's' || key === 'S') {
        skipAnimation();
        event.preventDefault();
        return;
      }

      // Space is BOTH "skip" and "select", and the tie is broken by whether
      // anything is actually animating — which is exactly what "fast-forward the
      // current animation" means when there is no current animation. Real
      // controls are left alone in either case: a button must stay a button, or
      // Space on New Game would skip instead of starting one.
      if (key === ' ' || key === 'Spacebar' || key === 'Enter') {
        if (inControls(active)) return;
        var space = key !== 'Enter';
        if (space && busy()) {
          skipAnimation();
          event.preventDefault();
          return;
        }
        if (isCardEl(active)) return;   // let the button activate itself
        // Nothing focused in the hand yet: the first press brings the cursor
        // into it rather than guessing which card was meant.
        if (accepting()) moveCursor(1);
        // Space scrolls the page by default, and there is nothing here worth
        // scrolling to; swallowing it keeps the table still.
        if (space) event.preventDefault();
      }
    }

    // Skip means "stop making me wait", and the opponent's pause is a wait like
    // any other — so it is cut short here as well as the animation queue.
    //
    // waiting() is read BEFORE the pause is cut, because cutting it clears the
    // very flag being tested. The test is what keeps the mode from being armed
    // by a press made while it is already the player's turn: there is nothing to
    // fast-forward then, and arming it would silently swallow the animation of
    // whatever they did next.
    function skipAnimation() {
      if (!session) return;
      var live = waiting();
      if (thinking) thinking.done();
      if (live) session.anim.skip();
    }

    // ---------------------------------------------------------------- wiring ---

    // Delegated to the hand container, which survives every repaint — the cards
    // inside it do not, so a listener per card would leak one per deal.
    function bind() {
      var hand = session.view.el.hands[me];
      hand.addEventListener('click', onHandClick);
      doc.addEventListener('keydown', onKeyDown);
      var offBeat = session.anim.onBeat(onBeat);
      session.unbind.push(function () {
        hand.removeEventListener('click', onHandClick);
        doc.removeEventListener('keydown', onKeyDown);
        offBeat();
      });
    }

    function teardown() {
      if (thinking) thinking.done();
      if (!session) return;
      for (var i = 0; i < session.unbind.length; i++) session.unbind[i]();
      session.unbind.length = 0;
      session.anim.destroy();
      session.view.destroy();
      session = null;
      controls = null;
      announcer = null;
    }

    function start() {
      awaiting = false;
      selection = [];
      pumping = false;
      session = build();
      controls = buildControls(session.view);
      announcer = buildAnnouncer(session.view);
      bind();
      repaint();
      pump();
      return api;
    }

    /**
     * newGame() — a full teardown and remount rather than a reset.
     *
     * The animator's queue, the renderer's card pool and the board's peg
     * positions are all stateful, and half-resetting three things is how a
     * previous hand's card ends up on a new table. Bumping `generation` first
     * makes every in-flight continuation from the old session a no-op.
     */
    function newGame(overrides) {
      generation++;
      if (overrides) {
        if (overrides.targetScore === 61 || overrides.targetScore === 121) {
          targetScore = overrides.targetScore;
        }
        if (overrides.opponent) opponent = overrides.opponent;
        if (overrides.dealer === 0 || overrides.dealer === 1 || overrides.dealer === null) {
          dealer = overrides.dealer;
        }
      }
      teardown();
      return start();
    }

    function setSpeed(value) {
      if (!session) return speed;
      speed = session.anim.setSpeed(value);
      return speed;
    }

    function destroy() {
      generation++;
      teardown();
    }

    var api = {
      newGame: newGame,
      skip: skipAnimation,
      setSpeed: setSpeed,
      destroy: destroy,
      isAwaitingInput: function () { return accepting(); },
      isBusy: busy,
      selection: function () { return selection.slice(); },
      // Read-only handles. Everything the game does to itself goes through the
      // methods above; these are for the console and for the Phase 7 harness.
      engine: function () { return session && session.game; },
      view: function () { return session && session.view; },
      anim: function () { return session && session.anim; },
      opponent: function () { return opponent; }
    };

    return start();
  }

  root.Cribbage = root.Cribbage || {};
  root.Cribbage.Game = {
    create: create,
    createPlaceholderOpponent: createPlaceholderOpponent
  };
})(typeof window !== 'undefined' ? window : globalThis);
