(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // render.js — the composition layer.
  //
  // It builds the game screen out of two finished components (RenderCards and
  // RenderBoard) and paints an Engine getState() snapshot into it. It holds NO
  // rules: it never decides what is legal, never scores anything, never mutates
  // the state it is handed, and never animates. Everything it knows about the
  // game it reads off the snapshot.
  //
  // The two places that come closest to the line, and why they are not over it:
  //
  //   statusFor()   maps phase + toMove onto one English sentence. That is copy,
  //                 not rules — it asks the state who is to move rather than
  //                 working it out. Anything it cannot know (which cards are
  //                 legal) arrives as a hint from the caller.
  //   renderState() takes an optional `hints` argument for exactly that reason:
  //                 the caller passes the legal card ids, so this file never has
  //                 to know that a card is unplayable when count + value > 31.
  //
  // Phase names are written out as literals rather than read from
  // Cribbage.Engine, so this file has no script-order dependency on the engine
  // and can be mounted against a hand-built snapshot. render-cards.js takes the
  // same approach with its rank and suit tables.
  // ---------------------------------------------------------------------------

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var seq = 0;

  // Phases in which the hands are on the table face up and the pile has been
  // gathered back in — i.e. the count and everything after it.
  var SHOWING = {
    SHOW_PONE: true,
    SHOW_DEALER: true,
    SHOW_CRIB: true,
    HAND_END: true,
    GAME_OVER: true
  };

  // --------------------------------------------------------------- DOM helpers ---

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function setText(node, text) {
    if (node && node.textContent !== text) node.textContent = text;
  }

  function has(list, id) {
    return !!list && list.indexOf(id) !== -1;
  }

  // Reconcile a container's children against an ordered list of specs, matching
  // on data-key. Elements that survive keep their DOM identity, which is what
  // lets a focused card stay focused across a re-render and gives Phase 4 a
  // stable element to hand to a FLIP.
  function syncRow(container, specs) {
    var kept = Object.create(null);
    var stale = [];
    var i;
    var kids = container.children;
    for (i = 0; i < kids.length; i++) {
      var key = kids[i].getAttribute('data-key');
      if (key && !kept[key]) kept[key] = kids[i];
      else stale.push(kids[i]);
    }

    var wanted = [];
    for (i = 0; i < specs.length; i++) {
      var spec = specs[i];
      var node = kept[spec.key];
      if (node) {
        delete kept[spec.key];
      } else {
        node = spec.make();
        node.setAttribute('data-key', spec.key);
      }
      if (spec.tune) spec.tune(node);
      wanted.push(node);
    }

    for (var k in kept) stale.push(kept[k]);
    for (i = 0; i < stale.length; i++) {
      if (stale[i].parentNode === container) container.removeChild(stale[i]);
    }

    // insertBefore moves an element that is already in the tree, so this both
    // inserts the new nodes and reorders the surviving ones in one pass.
    for (i = 0; i < wanted.length; i++) {
      if (container.children[i] !== wanted[i]) {
        container.insertBefore(wanted[i], container.children[i] || null);
      }
    }
  }

  // The felt's nap. Turbulence rather than a tiled gradient: any repeat gives
  // away its period across a table this wide. Static, so it is generated once.
  function napLayer(uid) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'table__nap');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.innerHTML =
      '<defs>' +
        '<filter id="' + uid + '-nap" x="0" y="0" width="100%" height="100%" ' +
          'color-interpolation-filters="sRGB">' +
          '<feTurbulence type="fractalNoise" baseFrequency="0.82" numOctaves="2" seed="23"/>' +
          '<feColorMatrix type="saturate" values="0"/>' +
          '<feComponentTransfer><feFuncA type="linear" slope="0.7"/></feComponentTransfer>' +
        '</filter>' +
      '</defs>' +
      '<rect width="100%" height="100%" filter="url(#' + uid + '-nap)"/>';
    return svg;
  }

  // ------------------------------------------------------------------- copy ---

  // One sentence saying what is expected right now. Reads the snapshot; decides
  // nothing. `hints.playable` is the caller's list of legal card ids and is the
  // only thing that lets this distinguish "your turn" from "you must say go".
  function statusFor(state, me, labels, hints) {
    var them = 1 - me;
    var mine = state.toMove === me;
    var theirName = labels[them];

    switch (state.phase) {
      case 'CUT_FOR_DEAL':
        return { text: 'Cut the deck to see who deals.', turn: mine ? 'mine' : 'none' };

      case 'DEAL':
        if (state.dealer === null) return { text: 'Dealing.', turn: 'none' };
        return {
          text: (state.dealer === me ? 'Your deal' : theirName + ' deals') + ' — six cards each.',
          turn: 'none'
        };

      // The lay-away is sequential — the pone goes first — so whose turn it is
      // comes off toMove, not off who still has six cards.
      case 'DISCARD':
        if (mine) {
          return {
            text: 'Choose two cards to lay away — it is ' +
              (state.dealer === me ? 'your crib.' : theirName + "'s crib."),
            turn: 'mine'
          };
        }
        if (state.toMove === them) {
          return { text: 'Waiting for ' + theirName + ' to lay away.', turn: 'none' };
        }
        return { text: 'Both hands are laid away.', turn: 'none' };

      case 'CUT_STARTER':
        return { text: 'Cut for the starter.', turn: 'none' };

      case 'PLAY':
        if (!mine) return { text: theirName + ' to play.', turn: 'none' };
        if (hints && hints.playable && hints.playable.length === 0) {
          return { text: 'Nothing you hold fits under 31 — say go.', turn: 'mine' };
        }
        return { text: 'Your turn — play a card.', turn: 'mine' };

      case 'SHOW_PONE':
      case 'SHOW_DEALER': {
        var counter = state.phase === 'SHOW_PONE' ? 1 - state.dealer : state.dealer;
        return {
          text: 'Counting ' + (counter === me ? 'your hand.' : theirName + "'s hand."),
          turn: 'none'
        };
      }

      case 'SHOW_CRIB':
        return {
          text: 'Counting ' + (state.dealer === me ? 'your crib.' : theirName + "'s crib."),
          turn: 'none'
        };

      case 'HAND_END':
        return { text: 'Hand over.', turn: 'none' };

      case 'GAME_OVER': {
        var won = state.winner === me;
        var tail = state.skunk === 'double' ? ' A double skunk.'
          : (state.skunk === 'skunk' ? ' A skunk.' : '');
        return {
          text: (won ? 'You win, ' : theirName + ' wins, ') +
            state.scores[state.winner] + '–' + state.scores[1 - state.winner] + '.' + tail,
          turn: 'none'
        };
      }

      default:
        return { text: '', turn: 'none' };
    }
  }

  function cribLabelFor(state, me) {
    if (state.dealer === null) return 'Crib';
    return state.dealer === me ? 'Your crib' : 'Their crib';
  }

  // ------------------------------------------------------------------ mount ---

  /**
   * mount(rootEl, opts) -> view
   *
   *   rootEl        the element to build the screen inside. Emptied first.
   *   opts.me       which player number the human is. Default 0.
   *   opts.labels   ['You', 'Opponent'] indexed by PLAYER NUMBER, not by side.
   *   opts.targetScore  121 or 61. Passed straight to RenderBoard.
   *   opts.fourColor    start with the four-colour deck on.
   *   opts.interactive  make the human's hand cards real buttons. Default true.
   */
  function mount(rootEl, opts) {
    var RC = root.Cribbage && root.Cribbage.RenderCards;
    var RB = root.Cribbage && root.Cribbage.RenderBoard;
    if (!RC || !RB) {
      throw new Error('Cribbage.Render: render-cards.js and render-board.js must load first');
    }
    if (!rootEl) throw new Error('Cribbage.Render.mount: no root element');

    opts = opts || {};
    var me = opts.me === 1 ? 1 : 0;
    var them = 1 - me;
    var labels = opts.labels || (me === 0 ? ['You', 'Opponent'] : ['Opponent', 'You']);
    var interactive = opts.interactive !== false;
    var uid = 'cr' + (++seq);

    // One physical deck, so the deck, the crib and the starter all share a back.
    // The opponent's held cards take the other back, which is the fastest way to
    // tell their hand from the stock at a glance.
    var DECK_BACK = 'red';
    var OPP_BACK = 'blue';

    while (rootEl.firstChild) rootEl.removeChild(rootEl.firstChild);

    // ---- structure ---------------------------------------------------------

    var app = el('div', 'app');
    app.setAttribute('data-four-color', opts.fourColor ? 'true' : 'false');

    var table = el('div', 'table');
    table.appendChild(napLayer(uid));

    var game = el('div', 'game');
    table.appendChild(game);

    // -- seats
    function buildSeat(player, side) {
      var seat = el('section', 'seat seat--' + side);
      seat.setAttribute('data-player', String(player));
      seat.setAttribute('data-peg', player === 0 ? 'brass' : 'pewter');

      var bar = el('div', 'seat__bar');
      var pip = el('span', 'seat__pip');
      pip.setAttribute('aria-hidden', 'true');
      var name = el('h2', 'seat__name', labels[player]);
      var badge = el('span', 'seat__badge', 'Dealer');
      badge.hidden = true;
      var score = el('span', 'seat__score');
      var num = el('span', 'seat__score-num', '0');
      var of = el('span', 'seat__score-of', '');
      score.appendChild(num);
      score.appendChild(of);
      bar.appendChild(pip);
      bar.appendChild(name);
      bar.appendChild(badge);
      bar.appendChild(score);

      var hand = el('div', 'hand hand--' + side);
      hand.setAttribute('role', 'group');
      hand.setAttribute('aria-label', labels[player] + "'s hand");

      seat.appendChild(bar);
      seat.appendChild(hand);
      return { seat: seat, name: name, badge: badge, num: num, of: of, hand: hand };
    }

    var seatThem = buildSeat(them, 'opponent');
    var seatMe = buildSeat(me, 'player');
    game.appendChild(seatThem.seat);
    game.appendChild(seatMe.seat);

    // -- supply row
    var supply = el('div', 'supply');

    function buildSlot(kind, labelText) {
      var slot = el('div', 'slot slot--' + kind);
      var label = el('span', 'slot__label', labelText);
      var body = el('div', 'slot__body');
      var note = el('span', 'slot__note', '');
      slot.appendChild(label);
      slot.appendChild(body);
      slot.appendChild(note);
      return { slot: slot, label: label, body: body, note: note };
    }

    var deckSlot = buildSlot('deck', 'Deck');
    var deckStack = el('div', 'deck');
    deckSlot.body.appendChild(deckStack);

    var starterSlot = buildSlot('starter', 'Starter');

    var cribSlot = buildSlot('crib', 'Crib');
    var cribPile = el('div', 'crib-pile');
    cribSlot.body.appendChild(cribPile);

    supply.appendChild(deckSlot.slot);
    supply.appendChild(starterSlot.slot);
    supply.appendChild(cribSlot.slot);
    game.appendChild(supply);

    // -- play area
    var play = el('div', 'play');
    var pile = el('ol', 'pile');
    pile.setAttribute('aria-label', 'Cards played');
    var pileEmpty = el('p', 'pile__empty', 'No cards on the table.');
    var pileWrap = el('div', 'play__lane');
    pileWrap.appendChild(pile);
    pileWrap.appendChild(pileEmpty);

    var count = el('div', 'count');
    var countLabel = el('span', 'count__label', 'Count');
    var countNum = el('span', 'count__num', '0');
    count.appendChild(countLabel);
    count.appendChild(countNum);

    play.appendChild(pileWrap);
    play.appendChild(count);
    game.appendChild(play);

    // -- status line
    var status = el('div', 'status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    var statusMark = el('span', 'status__mark');
    statusMark.setAttribute('aria-hidden', 'true');
    var statusText = el('p', 'status__text', '');
    status.appendChild(statusMark);
    status.appendChild(statusText);
    game.appendChild(status);

    // -- notes column: reserved for Phase 4, built and styled, left empty
    var notes = el('aside', 'notes');

    function buildPanel(kind, titleText, emptyText, listTag, listCls) {
      var panel = el('section', 'panel panel--' + kind);
      panel.setAttribute('data-open', 'true');

      var toggle = el('button', 'panel__toggle');
      toggle.type = 'button';
      toggle.setAttribute('aria-expanded', 'true');
      var title = el('h3', 'panel__title', titleText);
      var caret = el('span', 'panel__caret');
      caret.setAttribute('aria-hidden', 'true');
      toggle.appendChild(title);
      toggle.appendChild(caret);

      var body = el('div', 'panel__body');
      var list = el(listTag, listCls);
      var empty = el('p', 'panel__empty', emptyText);
      body.appendChild(list);
      body.appendChild(empty);

      panel.appendChild(toggle);
      panel.appendChild(body);

      toggle.addEventListener('click', function () {
        var open = panel.getAttribute('data-open') !== 'true';
        panel.setAttribute('data-open', open ? 'true' : 'false');
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      });

      return { panel: panel, toggle: toggle, list: list, empty: empty };
    }

    var breakdown = buildPanel('breakdown', 'The count',
      'Nothing is being counted yet. Each combination will appear here as it is scored.',
      'ol', 'tally');
    var history = buildPanel('history', 'Hand history',
      'No hands have been played yet.',
      'ol', 'log');

    notes.appendChild(breakdown.panel);
    notes.appendChild(history.panel);
    game.appendChild(notes);

    // -- the board rail
    var board = RB.create({
      targetScore: opts.targetScore === 61 ? 61 : 121,
      labels: labels
    });
    var rail = el('div', 'rail');
    var railMount = el('div', 'rail__mount');
    railMount.appendChild(board.el);
    rail.appendChild(railMount);
    table.appendChild(rail);

    app.appendChild(table);
    rootEl.appendChild(app);

    // The compact board is the same board rotated a quarter turn, so its HEIGHT
    // has to equal the mount's WIDTH. CSS cannot read one axis of an ancestor
    // into the other, so it is measured here and written back as a length.
    // Harmless at desktop widths, where the rule that consumes it is not live.
    function syncBand() {
      var w = railMount.clientWidth;
      if (w > 0) app.style.setProperty('--band-w', w + 'px');
    }

    var bandObserver = null;
    if (typeof ResizeObserver === 'function') {
      bandObserver = new ResizeObserver(syncBand);
      bandObserver.observe(railMount);
    } else if (typeof window !== 'undefined') {
      window.addEventListener('resize', syncBand);
    }
    syncBand();

    // ---- card pool ---------------------------------------------------------

    // Card elements are kept and reused so that a given card holds one DOM
    // identity for as long as it stays in one container. Interactivity is baked
    // in at construction (a button cannot become a div), so it is part of the
    // key: a card moving from the hand into the pile deliberately gets the
    // static element, and the button is parked for the next deal.
    var pool = Object.create(null);

    function poolCard(card, isInteractive, back) {
      var key = (isInteractive ? 'b' : 'd') + card.id;
      var node = pool[key];
      if (!node) {
        node = RC.createCard(card, { interactive: isInteractive, back: back || DECK_BACK });
        pool[key] = node;
      }
      return node;
    }

    function cardSpec(card, isInteractive, back, tune) {
      return {
        key: 'card' + card.id,
        make: function () { return poolCard(card, isInteractive, back); },
        tune: tune
      };
    }

    // Face-down cards the player is not entitled to see are built WITHOUT an
    // identity — createBack, not a real card turned over — so the opponent's
    // hand is not sitting in the DOM waiting to be read out of devtools.
    function backSpec(key, back) {
      return {
        key: key,
        make: function () { return RC.createBack(back); }
      };
    }

    // An empty slot keeps its footprint. A deck, a starter and a crib that
    // collapse to nothing make the whole supply row jump about as a hand runs.
    function wellSpec(key) {
      return {
        key: key,
        make: function () { return el('div', 'well'); }
      };
    }

    // ---- painting ----------------------------------------------------------

    var lastState = null;
    var lastHints = {};
    var statusOverride = null;

    function paintSeat(seat, player, state) {
      setText(seat.num, String(state.scores[player]));
      setText(seat.of, '/ ' + state.targetScore);
      seat.badge.hidden = state.dealer !== player;
    }

    function paintHand(container, player, state, showing, hints) {
      var cards = showing
        ? (state.showHands[player].length ? state.showHands[player] : state.hands[player])
        : state.hands[player];

      var specs = [];
      var i;

      if (player === me) {
        var live = interactive && !showing;
        for (i = 0; i < cards.length; i++) {
          specs.push(cardSpec(cards[i], live, DECK_BACK, tuneMine(cards[i], hints, live)));
        }
      } else if (showing) {
        for (i = 0; i < cards.length; i++) {
          specs.push(cardSpec(cards[i], false, OPP_BACK, tuneTheirs(cards[i], hints)));
        }
      } else {
        for (i = 0; i < cards.length; i++) specs.push(backSpec('back' + i, OPP_BACK));
      }
      syncRow(container, specs);
    }

    function tuneMine(card, hints, live) {
      return function (node) {
        RC.setFaceDown(node, false);
        RC.setSelected(node, has(hints.selected, card.id));
        RC.setHighlighted(node, has(hints.highlighted, card.id));
        // A null `playable` means the caller has not told us, so nothing is
        // dimmed. An empty array means nothing is legal, which is different.
        RC.setDisabled(node, !!(live && hints.playable && !has(hints.playable, card.id)));
      };
    }

    function tuneTheirs(card, hints) {
      return function (node) {
        RC.setFaceDown(node, false);
        RC.setHighlighted(node, has(hints.highlighted, card.id));
      };
    }

    function paintDeck(state) {
      var n = state.cardsRemaining;
      var specs = [];
      // A stack, not 34 elements: three shims for thickness and one real back on
      // top. The count is spelled out underneath, which is the honest way to say
      // "thirty-four" without drawing thirty-four cards.
      var shims = n > 3 ? 3 : Math.max(0, n - 1);
      for (var i = 0; i < shims; i++) {
        specs.push({
          key: 'shim' + i,
          make: function () { return el('div', 'deck__shim'); },
          tune: (function (idx) {
            return function (node) {
              var off = (shims - idx) * 1.5;
              node.style.transform = 'translate(' + (-off) + 'px, ' + (-off) + 'px)';
            };
          })(i)
        });
      }
      if (n > 0) specs.push(backSpec('top', DECK_BACK));
      else specs.push(wellSpec('deck-well'));
      syncRow(deckStack, specs);
      setText(deckSlot.note, n === 1 ? '1 card left' : n + ' cards left');
    }

    function paintStarter(state, hints) {
      var specs = [];
      if (state.starter) {
        specs.push(cardSpec(state.starter, false, DECK_BACK, function (node) {
          RC.setFaceDown(node, false);
          RC.setHighlighted(node, has(hints.highlighted, state.starter.id));
        }));
      } else {
        specs.push(wellSpec('starter-well'));
      }
      syncRow(starterSlot.body, specs);
      setText(starterSlot.note, state.starter ? 'Cut' : 'Not cut yet');
    }

    function paintCrib(state, showing, hints) {
      var revealed = showing && (state.phase === 'SHOW_CRIB' || state.phase === 'HAND_END' ||
        state.phase === 'GAME_OVER');
      var specs = [];
      var i;
      if (revealed) {
        for (i = 0; i < state.crib.length; i++) {
          specs.push(cardSpec(state.crib[i], false, DECK_BACK, (function (c) {
            return function (node) {
              RC.setFaceDown(node, false);
              RC.setHighlighted(node, has(hints.highlighted, c.id));
            };
          })(state.crib[i])));
        }
      } else {
        for (i = 0; i < state.crib.length; i++) specs.push(backSpec('crib' + i, DECK_BACK));
      }
      if (!specs.length) specs.push(wellSpec('crib-well'));
      syncRow(cribPile, specs);
      setText(cribSlot.label, cribLabelFor(state, me));
      setText(cribSlot.note, state.crib.length + ' of 4');
    }

    function paintPile(state, showing, hints) {
      // Once the count starts the pile has been gathered back into the two hands,
      // exactly as at a real table, so it empties rather than duplicating cards
      // that are now being shown.
      var entries = showing ? [] : state.play.pile;
      var live = state.play.series.length;
      var firstLive = entries.length - live;
      var specs = [];

      for (var i = 0; i < entries.length; i++) {
        specs.push((function (entry, idx) {
          return {
            key: 'pile' + entry.card.id,
            make: function () {
              var item = el('li', 'pile__item');
              var owner = el('span', 'pile__owner');
              owner.setAttribute('aria-hidden', 'true');
              item.appendChild(poolCard(entry.card, false, DECK_BACK));
              item.appendChild(owner);
              return item;
            },
            tune: function (item) {
              item.setAttribute('data-player', String(entry.player));
              item.setAttribute('data-side', entry.player === me ? 'mine' : 'theirs');
              item.setAttribute('data-peg', entry.player === 0 ? 'brass' : 'pewter');
              item.setAttribute('data-spent', idx < firstLive ? 'true' : 'false');
              item.setAttribute('data-series-start', idx === firstLive ? 'true' : 'false');
              var card = item.querySelector('.card');
              if (card) {
                RC.setFaceDown(card, false);
                RC.setHighlighted(card, has(hints.highlighted, entry.card.id));
              }
            }
          };
        })(entries[i], i));
      }

      syncRow(pile, specs);
      // "No cards on the table" is only true before the play starts. Once the
      // pile has been gathered for the count the field is simply clear, and
      // saying otherwise contradicts the eight cards lying in the two hands.
      pileEmpty.hidden = entries.length > 0 || showing;
      setText(countNum, String(state.play.count));
      count.setAttribute('data-count', String(state.play.count));
      count.setAttribute('data-full', state.play.count === 31 ? 'true' : 'false');
      // Only the play has a running count. Showing a dead "0" through the deal,
      // the lay-away and the count is noise the player has to learn to ignore.
      count.hidden = state.phase !== 'PLAY';
    }

    function paintStatus(state, hints) {
      var s = statusOverride || statusFor(state, me, labels, hints);
      setText(statusText, s.text);
      status.setAttribute('data-turn', s.turn || 'none');
    }

    /**
     * renderState(state, hints)
     *
     *   state  an Engine getState() snapshot. Never mutated, never stored past
     *          the call except as `view.state` for Phase 4's convenience.
     *   hints  optional presentation hints the snapshot cannot carry:
     *            playable    array of card ids the human may legally play. Cards
     *                        outside it are dimmed and disabled. Omit or pass
     *                        null to dim nothing.
     *            selected    array of card ids drawn raised.
     *            highlighted array of card ids drawn with the scoring glow.
     */
    function renderState(state, hints) {
      if (!state) throw new Error('Render.renderState: no state');
      // Normalised into a copy: the caller's object is theirs, and defaulting
      // fields onto it in place is the kind of surprise that costs an hour.
      var src = hints || {};
      hints = {
        playable: src.playable || null,
        selected: src.selected || [],
        highlighted: src.highlighted || []
      };

      var showing = !!SHOWING[state.phase];

      paintSeat(seatThem, them, state);
      paintSeat(seatMe, me, state);
      paintHand(seatThem.hand, them, state, showing, hints);
      paintHand(seatMe.hand, me, state, showing, hints);
      paintDeck(state);
      paintStarter(state, hints);
      paintCrib(state, showing, hints);
      paintPile(state, showing, hints);
      paintStatus(state, hints);

      // prevScores is the score before the most recent award, which is exactly
      // where the rear peg stands. The board does the leapfrog itself.
      board.setPegs(0, state.prevScores[0], state.scores[0]);
      board.setPegs(1, state.prevScores[1], state.scores[1]);

      lastState = state;
      lastHints = hints;
      view.state = state;
      return view;
    }

    // ---- imperative surface ------------------------------------------------

    // Phase 4 talks over the status line during the count. Passing null hands it
    // back to whatever the snapshot says.
    function setStatus(text, turn) {
      statusOverride = text === null || text === undefined
        ? null
        : { text: text, turn: turn || 'none' };
      if (lastState) paintStatus(lastState, lastHints);
      else if (statusOverride) {
        setText(statusText, statusOverride.text);
        status.setAttribute('data-turn', statusOverride.turn);
      }
      return view;
    }

    function setFourColor(on) {
      app.setAttribute('data-four-color', on ? 'true' : 'false');
      return view;
    }

    function setPanelOpen(which, open) {
      var p = which === 'history' ? history : breakdown;
      p.panel.setAttribute('data-open', open ? 'true' : 'false');
      p.toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      return view;
    }

    // Wherever the card currently lives — hand, pile, crib or starter slot.
    function findCard(id) {
      return table.querySelector('.card[data-card-id="' + Number(id) + '"]');
    }

    function handCards(player) {
      var container = player === me ? seatMe.hand : seatThem.hand;
      return Array.prototype.slice.call(container.querySelectorAll('.card'));
    }

    function destroy() {
      if (bandObserver) bandObserver.disconnect();
      else if (typeof window !== 'undefined') window.removeEventListener('resize', syncBand);
      if (phone && phone.removeEventListener) phone.removeEventListener('change', syncSheet);
      else if (phone && phone.removeListener) phone.removeListener(syncSheet);
      board.destroy();
      while (rootEl.firstChild) rootEl.removeChild(rootEl.firstChild);
    }

    /* ------------------------------------------------------------------------
       view.el — the resolved element references Phase 4 depends on.

       Everything indexed by player is indexed by PLAYER NUMBER (0 or 1), never
       by which side of the table it is on, so `el.hands[state.dealer]` is always
       right regardless of which seat the human took.

         root         the element mount() was given
         app          the themed root; carries [data-four-color]
         table        the felt surface. Full-bleed effects (a win sweep,
                      confetti) belong here, and it is the offsetParent to
                      measure card flights against.
         game         the five-row game grid
         seats[p]     the <section> for a player
         names[p]     the name element
         scores[p]    the score numeral span
         badges[p]    the 'Dealer' tag (hidden when they are not)
         hands[p]     the hand container. Cards are its direct children; the
                      human's are <button class="card">, the opponent's are
                      anonymous backs with no card identity in the DOM.
         deck         the stacked-deck container
         deckNote     the 'n cards left' line
         starter      the starter slot body; holds one card or one .well
         crib         the crib pile container
         cribLabel    'Your crib' / 'Their crib'
         pile         the <ol> of played cards. Each child is a
                      li.pile__item[data-player][data-spent] wrapping one .card.
         pileEmpty    the 'no cards' line
         count        the count plate; carries [data-count] and [data-full]
         countNum     the numeral
         status       the live region; carries [data-turn]
         statusText   the sentence
         breakdown        the score-breakdown panel
         breakdownList    the empty <ol> Phase 4 fills, one .tally__row per
                          combination; .tally__row[data-total=true] for the total
         breakdownEmpty   the placeholder to hide once rows exist
         history          the hand-history panel
         historyList      the empty <ol>, one .log__row per entry
         historyEmpty     its placeholder
         rail         the board's column
         board        the .crib-board element itself

       view.board is the RenderBoard instance (holePosition, setPegs, pegElement,
       refresh). NOTE for the compact layout: below 1024px the board element is
       rotated a quarter turn in CSS. holePosition() and the pegs' left/top stay
       in the board's own unrotated space and remain correct, but a
       getBoundingClientRect() taken across that boundary is rotated — measure
       peg-to-card flights in the board's space, or compensate.
       ------------------------------------------------------------------------ */
    var refs = {
      root: rootEl,
      app: app,
      table: table,
      game: game,
      seats: [], names: [], scores: [], badges: [], hands: [],
      deck: deckStack,
      deckNote: deckSlot.note,
      starter: starterSlot.body,
      starterNote: starterSlot.note,
      crib: cribPile,
      cribLabel: cribSlot.label,
      cribNote: cribSlot.note,
      pile: pile,
      pileEmpty: pileEmpty,
      count: count,
      countNum: countNum,
      status: status,
      statusText: statusText,
      breakdown: breakdown.panel,
      breakdownList: breakdown.list,
      breakdownEmpty: breakdown.empty,
      history: history.panel,
      historyList: history.list,
      historyEmpty: history.empty,
      rail: rail,
      board: board.el
    };
    refs.seats[them] = seatThem.seat;
    refs.seats[me] = seatMe.seat;
    refs.names[them] = seatThem.name;
    refs.names[me] = seatMe.name;
    refs.scores[them] = seatThem.num;
    refs.scores[me] = seatMe.num;
    refs.badges[them] = seatThem.badge;
    refs.badges[me] = seatMe.badge;
    refs.hands[them] = seatThem.hand;
    refs.hands[me] = seatMe.hand;

    // On a phone the breakdown is a bottom sheet, and a sheet's resting state is
    // shut — open by default it would sit on top of the player's own hand. This
    // is the view's own furniture, not game state: Phase 4 calls
    // setPanelOpen('breakdown', true) when a count actually starts.
    var phone = (typeof window !== 'undefined' && window.matchMedia)
      ? window.matchMedia('(max-width: 639.98px)')
      : null;

    function syncSheet() {
      setPanelOpen('breakdown', !(phone && phone.matches));
    }

    if (phone) {
      if (phone.addEventListener) phone.addEventListener('change', syncSheet);
      else if (phone.addListener) phone.addListener(syncSheet);
      syncSheet();
    }

    var view = {
      el: refs,
      board: board,
      me: me,
      labels: labels,
      state: null,
      renderState: renderState,
      setStatus: setStatus,
      setFourColor: setFourColor,
      setPanelOpen: setPanelOpen,
      findCard: findCard,
      handCards: handCards,
      destroy: destroy
    };
    return view;
  }

  root.Cribbage = root.Cribbage || {};
  root.Cribbage.Render = { mount: mount };
})(typeof window !== 'undefined' ? window : globalThis);
