(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Cribbage.AnimateTests.run(options) -> Promise<{ passed, failed, results }>
  //
  // NOTE THE PROMISE. js/tests.js and js/engine-tests.js are synchronous because
  // the code under test is. The animation queue is asynchronous by definition, so
  // this suite cannot be — run() returns a promise resolving to the same shape.
  // tools/run-tests.js awaits it.
  //
  // Everything below is hermetic: a small fake DOM and a fake view built inside
  // this file, no jsdom and no dependency. Three reasons that is the right call
  // rather than a compromise:
  //
  //   1. animate.js takes `doc` and `cards` as injectable seams, so the suite can
  //      drive it with no global `document` at all — which is what lets it run
  //      identically under Node and in tests.html.
  //   2. the fake view repaints through the SAME keyed reconciliation render.js
  //      uses, pool and all. A renderState that simply rebuilt the world would
  //      make skip-equals-play true by construction and prove nothing.
  //   3. the fake Animation resolves on a microtask, so a full 121-point game
  //      drains in milliseconds instead of eleven real minutes.
  //
  // What is NOT covered headlessly, and is covered in a browser instead:
  //   * real getBoundingClientRect geometry, so the FLIP deltas here are
  //     synthetic. That motion actually happens on screen is a browser check.
  //   * the real board's holePosition() walk along an SVG centreline.
  //   * whether element.animate() genuinely settles at duration 0 in an engine.
  //     Here the fake animation is the thing being relied on; the browser scratch
  //     page under the scratchpad is where the real one is exercised.
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------- assertions ---
  // Same shape as the Suite in js/engine-tests.js, deliberately duplicated so the
  // three suites stay independent of one another.

  function Suite(options) {
    this.options = options || {};
    this.log = this.options.log || function () {};
    this.passed = 0;
    this.failed = 0;
    this.results = [];
  }

  // A DOM node in an assertion is a circular structure, and both this reporter
  // and tools/run-tests.js stringify what they are handed. One careless
  // assertion must not be able to take the runner down.
  function safe(value) {
    try {
      JSON.stringify(value);
      return value;
    } catch (err) {
      return '[unserialisable ' + (value && value.constructor ?
        value.constructor.name : typeof value) + ']';
    }
  }

  Suite.prototype.record = function (name, ok, expected, actual, detail) {
    var entry = {
      name: name,
      ok: !!ok,
      expected: safe(expected),
      actual: safe(actual),
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

  function r2(n) {
    return Math.round(n * 100) / 100;
  }

  // =========================================================================
  //  A minimal DOM
  // =========================================================================

  function makeDom() {
    var animMode = 'settle';   // 'settle' | 'never' | 'reject'
    var animLog = [];

    function FakeAnimation(frames, options, owner) {
      this.frames = frames;
      this.options = options || {};
      this.owner = owner;
      this.playState = 'running';
      var self = this;
      this.finished = new Promise(function (resolve, reject) {
        self._resolve = resolve;
        self._reject = reject;
      });
      // The suite cancels animations on purpose, and a rejected .finished with
      // no handler is a process-level warning in Node. Claiming it here changes
      // nothing for other consumers.
      this.finished.then(null, function () {});
      animLog.push(this);

      var mode = (owner && owner.__animMode) || animMode;
      if (mode === 'never') return;
      if (mode === 'reject') {
        Promise.resolve().then(function () {
          if (self.playState !== 'running') return;
          self.playState = 'failed';
          self._reject(new Error('the compositor gave up'));
        });
        return;
      }
      Promise.resolve().then(function () {
        if (self.playState !== 'running') return;
        self.playState = 'finished';
        self._resolve(self);
      });
    }

    FakeAnimation.prototype.cancel = function () {
      if (this.playState !== 'running') return;
      this.playState = 'cancelled';
      var err = new Error('animation cancelled');
      err.name = 'AbortError';
      this._reject(err);
    };

    function FakeStyle() {}
    FakeStyle.prototype.setProperty = function (name, value) {
      this[name] = String(value);
    };
    FakeStyle.prototype.getPropertyValue = function (name) {
      return this[name] === undefined ? '' : this[name];
    };

    function classes(node) {
      return String(node.className || '').split(/\s+/).filter(Boolean);
    }

    function writeClasses(node, list) {
      node.className = list.join(' ');
    }

    function FakeElement(tag, ns) {
      this.tagName = String(tag).toUpperCase();
      this.namespaceURI = ns || null;
      this.className = '';
      this.attributes = {};
      this.children = [];
      this.parentNode = null;
      this.style = new FakeStyle();
      this.hidden = false;
      this._text = '';
      var self = this;
      this.classList = {
        add: function () {
          var list = classes(self);
          for (var i = 0; i < arguments.length; i++) {
            if (list.indexOf(arguments[i]) === -1) list.push(arguments[i]);
          }
          writeClasses(self, list);
        },
        remove: function () {
          var list = classes(self);
          for (var i = 0; i < arguments.length; i++) {
            var at = list.indexOf(arguments[i]);
            if (at !== -1) list.splice(at, 1);
          }
          writeClasses(self, list);
        },
        contains: function (c) {
          return classes(self).indexOf(c) !== -1;
        },
        toggle: function (c, on) {
          var has = classes(self).indexOf(c) !== -1;
          var want = on === undefined ? !has : !!on;
          if (want) self.classList.add(c);
          else self.classList.remove(c);
          return want;
        }
      };
    }

    Object.defineProperty(FakeElement.prototype, 'textContent', {
      get: function () {
        if (!this.children.length) return this._text;
        var out = '';
        for (var i = 0; i < this.children.length; i++) out += this.children[i].textContent;
        return out;
      },
      set: function (value) {
        for (var i = 0; i < this.children.length; i++) this.children[i].parentNode = null;
        this.children.length = 0;
        this._text = (value === null || value === undefined) ? '' : String(value);
      }
    });

    Object.defineProperty(FakeElement.prototype, 'firstChild', {
      get: function () { return this.children[0] || null; }
    });

    FakeElement.prototype.appendChild = function (node) {
      if (node.parentNode) node.parentNode.removeChild(node);
      node.parentNode = this;
      this.children.push(node);
      return node;
    };

    FakeElement.prototype.insertBefore = function (node, ref) {
      if (node.parentNode) node.parentNode.removeChild(node);
      node.parentNode = this;
      var at = ref ? this.children.indexOf(ref) : -1;
      if (at === -1) this.children.push(node);
      else this.children.splice(at, 0, node);
      return node;
    };

    FakeElement.prototype.removeChild = function (node) {
      var at = this.children.indexOf(node);
      if (at !== -1) {
        this.children.splice(at, 1);
        node.parentNode = null;
      }
      return node;
    };

    FakeElement.prototype.setAttribute = function (name, value) {
      if (name === 'class') this.className = String(value);
      else this.attributes[name] = String(value);
    };

    FakeElement.prototype.setAttributeNS = function (ns, name, value) {
      this.setAttribute(name, value);
    };

    FakeElement.prototype.getAttribute = function (name) {
      if (name === 'class') return this.className;
      return this.attributes[name] === undefined ? null : this.attributes[name];
    };

    FakeElement.prototype.removeAttribute = function (name) {
      if (name === 'class') this.className = '';
      else delete this.attributes[name];
    };

    // Compound selectors only — '.a.b', 'li.pile__item', '[data-x="y"]'. That is
    // everything animate.js and the fake view actually ask for.
    function parseSelector(sel) {
      var parts = { tag: null, classes: [], attrs: [] };
      var re = /(^[a-zA-Z][\w-]*)|\.([\w-]+)|\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]/g;
      var m;
      while ((m = re.exec(sel)) !== null) {
        if (m[1]) parts.tag = m[1].toUpperCase();
        else if (m[2]) parts.classes.push(m[2]);
        else if (m[3]) parts.attrs.push([m[3], m[4] === undefined ? null : m[4]]);
      }
      return parts;
    }

    function matches(node, parts) {
      if (parts.tag && node.tagName !== parts.tag) return false;
      var list = classes(node);
      var i;
      for (i = 0; i < parts.classes.length; i++) {
        if (list.indexOf(parts.classes[i]) === -1) return false;
      }
      for (i = 0; i < parts.attrs.length; i++) {
        var got = node.getAttribute(parts.attrs[i][0]);
        if (got === null) return false;
        if (parts.attrs[i][1] !== null && got !== parts.attrs[i][1]) return false;
      }
      return true;
    }

    FakeElement.prototype.querySelectorAll = function (sel) {
      var parts = parseSelector(sel);
      var out = [];
      (function walk(node) {
        for (var i = 0; i < node.children.length; i++) {
          var kid = node.children[i];
          if (matches(kid, parts)) out.push(kid);
          walk(kid);
        }
      })(this);
      return out;
    };

    FakeElement.prototype.querySelector = function (sel) {
      return this.querySelectorAll(sel)[0] || null;
    };

    // Synthetic layout: deterministic, and different enough between containers
    // that a FLIP delta is never accidentally zero.
    FakeElement.prototype.getBoundingClientRect = function () {
      var x = 0;
      var y = 0;
      var node = this;
      var depth = 0;
      while (node && depth < 40) {
        var at = node.parentNode ? node.parentNode.children.indexOf(node) : 0;
        x += at * 17 + depth * 3;
        y += at * 11 + depth * 29;
        node = node.parentNode;
        depth++;
      }
      return { left: x, top: y, width: 60, height: 84, right: x + 60, bottom: y + 84 };
    };

    FakeElement.prototype.animate = function (frames, options) {
      return new FakeAnimation(frames, options, this);
    };

    var doc = {
      createElement: function (tag) { return new FakeElement(tag); },
      createElementNS: function (ns, tag) { return new FakeElement(tag, ns); }
    };

    return {
      doc: doc,
      Element: FakeElement,
      animations: animLog,
      setAnimMode: function (mode) { animMode = mode; },
      resetAnimations: function () { animLog.length = 0; }
    };
  }

  // =========================================================================
  //  A stand-in for render-cards.js
  // =========================================================================
  //
  // Faithful to the parts animate.js touches: the .card element, the
  // .card__inner it turns over, the data attributes findCard() searches on, and
  // the four state setters. Deliberately not the real module, so the suite needs
  // no global document and stays independent of Phase 3's markup.

  function makeCards(doc) {
    var SUITS = ['S', 'H', 'D', 'C'];

    function el(tag, cls) {
      var n = doc.createElement(tag);
      if (cls) n.className = cls;
      return n;
    }

    function suitKey(card) {
      return typeof card.suit === 'number' ? SUITS[card.suit] : String(card.suit).toUpperCase();
    }

    function build(card, opts) {
      opts = opts || {};
      var node = el(opts.interactive ? 'button' : 'div', 'card');
      if (opts.interactive) {
        node.type = 'button';
        node.classList.add('card--interactive');
      } else {
        node.setAttribute('role', 'img');
      }
      if (card) {
        node.setAttribute('data-card-id', String(card.id));
        node.setAttribute('data-rank', String(card.rank));
        node.setAttribute('data-suit', suitKey(card));
        node.setAttribute('data-label', 'card ' + card.id);
      } else {
        node.setAttribute('data-label', 'Face-down card');
      }
      var inner = el('div', 'card__inner');
      inner.appendChild(el('div', 'card__face card__face--front'));
      inner.appendChild(el('div', 'card__face card__face--back'));
      node.appendChild(inner);
      api.setFaceDown(node, !!opts.faceDown || !card);
      return node;
    }

    var api = {
      createCard: function (card, opts) {
        if (!card || typeof card.rank !== 'number') throw new Error('createCard: not a card');
        return build(card, opts);
      },
      createBack: function (opts) {
        return build(null, (opts && typeof opts === 'object') ? opts : {});
      },
      setFaceDown: function (node, on) {
        if (!node) return node;
        on = !!on;
        node.classList.toggle('card--face-down', on);
        node.setAttribute('data-face-down', on ? 'true' : 'false');
        node.setAttribute('aria-label', on ? 'Face-down card' :
          (node.getAttribute('data-label') || 'Card'));
        return node;
      },
      setSelected: function (node, on) {
        if (!node) return node;
        on = !!on;
        node.classList.toggle('card--selected', on);
        node.setAttribute('data-selected', on ? 'true' : 'false');
        if (node.tagName === 'BUTTON') node.setAttribute('aria-pressed', on ? 'true' : 'false');
        return node;
      },
      setDisabled: function (node, on) {
        if (!node) return node;
        on = !!on;
        node.classList.toggle('card--disabled', on);
        node.setAttribute('aria-disabled', on ? 'true' : 'false');
        return node;
      },
      setHighlighted: function (node, on) {
        if (!node) return node;
        on = !!on;
        node.classList.toggle('card--highlighted', on);
        node.setAttribute('data-highlighted', on ? 'true' : 'false');
        return node;
      }
    };
    return api;
  }

  // =========================================================================
  //  A stand-in for the mounted view
  // =========================================================================

  var SHOWING = {
    SHOW_PONE: true, SHOW_DEALER: true, SHOW_CRIB: true, HAND_END: true, GAME_OVER: true
  };

  // render.js's syncRow, copied so the fake view reconciles by key exactly the
  // way the real one does. If a beat leaves a stray element behind, this keeps
  // it — which is precisely what makes skip-equals-play worth asserting.
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
      if (node) delete kept[spec.key];
      else {
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
    for (i = 0; i < wanted.length; i++) {
      if (container.children[i] !== wanted[i]) {
        container.insertBefore(wanted[i], container.children[i] || null);
      }
    }
  }

  // render-board.js's peg rule, mirrored: the peg that was in front stays put and
  // becomes the new rear, and the one behind leapfrogs it. The identity of the
  // two DOM pegs has to survive that, because the animator picks up whichever
  // one is actually going to travel.
  function makeBoard(doc, targetScore, labels) {
    var boardEl = doc.createElement('div');
    boardEl.className = 'crib-board';
    boardEl.setAttribute('data-target-score', String(targetScore));
    var pegLayer = doc.createElement('div');
    pegLayer.className = 'crib-board__pegs';
    boardEl.appendChild(pegLayer);

    var players = [0, 1].map(function (p) {
      var pegs = [0, 1].map(function (i) {
        var peg = doc.createElement('div');
        peg.className = 'crib-peg crib-peg--' + (p === 0 ? 'brass' : 'pewter');
        peg.setAttribute('data-player', String(p));
        peg.setAttribute('data-slot', String(i));
        pegLayer.appendChild(peg);
        return peg;
      });
      return { pegs: pegs, at: [-1, 0], rear: 0, front: 0 };
    });

    function clamp(n, lo, hi) {
      return n < lo ? lo : (n > hi ? hi : n);
    }

    function holePosition(player, n) {
      var idx = clamp(Math.round(n), -1, targetScore);
      return { x: (player === 1 ? 60 : 12) + idx * 3.5, y: 720 - idx * 5.25 };
    }

    function placePeg(player, slot) {
      var st = players[player];
      var pos = holePosition(player, st.at[slot]);
      st.pegs[slot].style.left = r2(pos.x) + 'px';
      st.pegs[slot].style.top = r2(pos.y) + 'px';
    }

    function placeAllPegs() {
      for (var p = 0; p < 2; p++) { placePeg(p, 0); placePeg(p, 1); }
    }

    function setPegs(player, rear, front) {
      var p = (player === 1) ? 1 : 0;
      var st = players[p];
      var lo = clamp(Math.round(rear), 0, targetScore);
      var hi = clamp(Math.round(front), 0, targetScore);
      if (hi < lo) { var t = lo; lo = hi; hi = t; }

      var rearSlot;
      if (st.at[0] === lo) rearSlot = 0;
      else if (st.at[1] === lo) rearSlot = 1;
      else if (st.at[0] === hi) rearSlot = 1;
      else if (st.at[1] === hi) rearSlot = 0;
      else rearSlot = 0;

      st.at[rearSlot] = lo;
      st.at[1 - rearSlot] = hi;

      if (lo === 0 && hi === 0) {
        var outer = (st.at[1] === -1) ? 1 : 0;
        st.at[outer] = -1;
        st.at[1 - outer] = 0;
      }
      st.rear = lo;
      st.front = hi;
      placeAllPegs();
    }

    function pegElement(player, which) {
      var st = players[(player === 1) ? 1 : 0];
      var a = st.at[0];
      var b = st.at[1];
      var wantFront = (which === 'front');
      if (a === b) return st.pegs[wantFront ? 1 : 0];
      var frontSlot = (a > b) ? 0 : 1;
      return st.pegs[wantFront ? frontSlot : (1 - frontSlot)];
    }

    setPegs(0, 0, 0);
    setPegs(1, 0, 0);

    return {
      el: boardEl,
      players: players,
      targetScore: targetScore,
      labels: labels,
      holePosition: holePosition,
      setPegs: setPegs,
      pegElement: pegElement,
      refresh: placeAllPegs,
      destroy: function () {}
    };
  }

  function makeView(doc, cards, options) {
    options = options || {};
    var me = options.me === 1 ? 1 : 0;
    var them = 1 - me;
    var targetScore = options.targetScore === 61 ? 61 : 121;
    var labels = options.labels || (me === 0 ? ['You', 'Opponent'] : ['Opponent', 'You']);
    var interactive = options.interactive !== false;

    function el(tag, cls, text) {
      var n = doc.createElement(tag);
      if (cls) n.className = cls;
      if (text !== undefined) n.textContent = text;
      return n;
    }

    var app = el('div', 'app');
    var table = el('div', 'table');
    var game = el('div', 'game');
    app.appendChild(table);
    table.appendChild(game);

    var seats = [];
    var scoreNums = [];
    var badges = [];
    var hands = [];
    [them, me].forEach(function (p) {
      var seat = el('section', 'seat seat--' + (p === me ? 'player' : 'opponent'));
      seat.setAttribute('data-player', String(p));
      var num = el('span', 'seat__score-num', '0');
      var badge = el('span', 'seat__badge', 'Dealer');
      badge.hidden = true;
      var hand = el('div', 'hand');
      seat.appendChild(num);
      seat.appendChild(badge);
      seat.appendChild(hand);
      game.appendChild(seat);
      seats[p] = seat;
      scoreNums[p] = num;
      badges[p] = badge;
      hands[p] = hand;
    });

    var deck = el('div', 'deck');
    var deckNote = el('span', 'slot__note', '');
    var starter = el('div', 'slot__body');
    var starterNote = el('span', 'slot__note', '');
    var crib = el('div', 'crib-pile');
    var cribNote = el('span', 'slot__note', '');
    var supply = el('div', 'supply');
    [deck, deckNote, starter, starterNote, crib, cribNote].forEach(function (n) {
      supply.appendChild(n);
    });
    game.appendChild(supply);

    var pile = el('ol', 'pile');
    var pileEmpty = el('p', 'pile__empty', 'No cards on the table.');
    var count = el('div', 'count');
    var countNum = el('span', 'count__num', '0');
    count.appendChild(countNum);
    game.appendChild(pile);
    game.appendChild(pileEmpty);
    game.appendChild(count);

    var status = el('div', 'status');
    var statusText = el('p', 'status__text', '');
    status.appendChild(statusText);
    game.appendChild(status);

    var board = makeBoard(doc, targetScore, labels);
    var rail = el('div', 'rail');
    rail.appendChild(board.el);
    table.appendChild(rail);

    // The pool render.js keeps, for the same reason: a card holds one DOM
    // identity for as long as it stays in one container.
    var pool = Object.create(null);

    function poolCard(card, live) {
      var key = (live ? 'b' : 'd') + card.id;
      if (!pool[key]) pool[key] = cards.createCard(card, { interactive: live });
      return pool[key];
    }

    function cardSpec(card, live, tune) {
      return {
        key: 'card' + card.id,
        make: function () { return poolCard(card, live); },
        tune: tune
      };
    }

    function backSpec(key) {
      return { key: key, make: function () { return cards.createBack(); } };
    }

    function wellSpec(key) {
      return { key: key, make: function () { return el('div', 'well'); } };
    }

    function has(list, id) {
      return !!list && list.indexOf(id) !== -1;
    }

    function paintHand(container, player, state, showing, hints) {
      var list = showing
        ? (state.showHands[player].length ? state.showHands[player] : state.hands[player])
        : state.hands[player];
      var specs = [];
      var i;
      if (player === me) {
        var live = interactive && !showing;
        for (i = 0; i < list.length; i++) {
          specs.push(cardSpec(list[i], live, tuneFace(list[i], hints, live)));
        }
      } else if (showing) {
        for (i = 0; i < list.length; i++) {
          specs.push(cardSpec(list[i], false, tuneFace(list[i], hints, false)));
        }
      } else {
        for (i = 0; i < list.length; i++) specs.push(backSpec('back' + i));
      }
      syncRow(container, specs);
    }

    function tuneFace(card, hints, live) {
      return function (node) {
        cards.setFaceDown(node, false);
        cards.setSelected(node, has(hints.selected, card.id));
        cards.setHighlighted(node, has(hints.highlighted, card.id));
        cards.setDisabled(node, !!(live && hints.playable && !has(hints.playable, card.id)));
      };
    }

    function renderState(state, hints) {
      if (!state) throw new Error('renderState: no state');
      var src = hints || {};
      hints = {
        playable: src.playable || null,
        selected: src.selected || [],
        highlighted: src.highlighted || []
      };
      var showing = !!SHOWING[state.phase];
      var i;

      scoreNums[0].textContent = String(state.scores[0]);
      scoreNums[1].textContent = String(state.scores[1]);
      badges[0].hidden = state.dealer !== 0;
      badges[1].hidden = state.dealer !== 1;

      paintHand(hands[0], 0, state, showing, hints);
      paintHand(hands[1], 1, state, showing, hints);

      var specs = [];
      var n = state.cardsRemaining;
      var shims = n > 3 ? 3 : Math.max(0, n - 1);
      for (i = 0; i < shims; i++) specs.push(wellSpec('shim' + i));
      specs.push(n > 0 ? backSpec('top') : wellSpec('deck-well'));
      syncRow(deck, specs);
      deckNote.textContent = n === 1 ? '1 card left' : n + ' cards left';

      specs = [];
      if (state.starter) {
        specs.push(cardSpec(state.starter, false, (function (c) {
          return function (node) {
            cards.setFaceDown(node, false);
            cards.setHighlighted(node, has(hints.highlighted, c.id));
          };
        })(state.starter)));
      } else {
        specs.push(wellSpec('starter-well'));
      }
      syncRow(starter, specs);
      starterNote.textContent = state.starter ? 'Cut' : 'Not cut yet';

      var revealed = showing && (state.phase === 'SHOW_CRIB' || state.phase === 'HAND_END' ||
        state.phase === 'GAME_OVER');
      specs = [];
      for (i = 0; i < state.crib.length; i++) {
        if (revealed) {
          specs.push(cardSpec(state.crib[i], false, (function (c) {
            return function (node) {
              cards.setFaceDown(node, false);
              cards.setHighlighted(node, has(hints.highlighted, c.id));
            };
          })(state.crib[i])));
        } else {
          specs.push(backSpec('crib' + i));
        }
      }
      if (!specs.length) specs.push(wellSpec('crib-well'));
      syncRow(crib, specs);
      cribNote.textContent = state.crib.length + ' of 4';

      var entries = showing ? [] : state.play.pile;
      var live = state.play.series.length;
      var firstLive = entries.length - live;
      specs = [];
      for (i = 0; i < entries.length; i++) {
        specs.push((function (entry, idx) {
          return {
            key: 'pile' + entry.card.id,
            make: function () {
              var item = el('li', 'pile__item');
              item.appendChild(poolCard(entry.card, false));
              var owner = el('span', 'pile__owner');
              owner.setAttribute('aria-hidden', 'true');
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
                cards.setFaceDown(card, false);
                cards.setHighlighted(card, has(hints.highlighted, entry.card.id));
              }
            }
          };
        })(entries[i], i));
      }
      syncRow(pile, specs);
      pileEmpty.hidden = entries.length > 0 || showing;
      countNum.textContent = String(state.play.count);
      count.setAttribute('data-count', String(state.play.count));
      count.setAttribute('data-full', state.play.count === 31 ? 'true' : 'false');
      count.hidden = state.phase !== 'PLAY';

      board.setPegs(0, state.prevScores[0], state.scores[0]);
      board.setPegs(1, state.prevScores[1], state.scores[1]);

      view.state = state;
      return view;
    }

    var view = {
      el: {
        root: app,
        app: app,
        table: table,
        game: game,
        seats: seats,
        scores: scoreNums,
        badges: badges,
        hands: hands,
        deck: deck,
        deckNote: deckNote,
        starter: starter,
        starterNote: starterNote,
        crib: crib,
        cribNote: cribNote,
        pile: pile,
        pileEmpty: pileEmpty,
        count: count,
        countNum: countNum,
        status: status,
        statusText: statusText,
        rail: rail,
        board: board.el
      },
      board: board,
      me: me,
      labels: labels,
      state: null,
      renderState: renderState,
      setStatus: function () { return view; },
      findCard: function (id) {
        return table.querySelector('.card[data-card-id="' + Number(id) + '"]');
      },
      handCards: function (player) {
        return hands[player].querySelectorAll('.card');
      },
      destroy: function () {}
    };
    return view;
  }

  // =========================================================================
  //  DOM serialisation — the skip-equals-play comparison
  // =========================================================================

  function serialize(node, depth, out) {
    var pad = new Array(depth + 1).join('  ');
    var bits = [node.tagName.toLowerCase()];
    if (node.className) bits.push('class="' + node.className + '"');
    var names = Object.keys(node.attributes).sort();
    for (var i = 0; i < names.length; i++) {
      if (names[i] === 'data-key') continue;   // reconciliation bookkeeping
      bits.push(names[i] + '="' + node.attributes[names[i]] + '"');
    }
    var styleKeys = Object.keys(node.style).sort();
    for (i = 0; i < styleKeys.length; i++) {
      bits.push('style:' + styleKeys[i] + '=' + node.style[styleKeys[i]]);
    }
    if (node.hidden) bits.push('hidden');
    if (!node.children.length && node._text) bits.push('text="' + node._text + '"');
    out.push(pad + '<' + bits.join(' ') + '>');
    for (i = 0; i < node.children.length; i++) serialize(node.children[i], depth + 1, out);
    return out;
  }

  function domString(view) {
    return serialize(view.el.app, 0, []).join('\n');
  }

  function firstDifference(a, b) {
    var la = a.split('\n');
    var lb = b.split('\n');
    for (var i = 0; i < Math.max(la.length, lb.length); i++) {
      if (la[i] !== lb[i]) {
        return 'line ' + (i + 1) + '\n            A: ' + (la[i] === undefined ? '(none)' : la[i]) +
          '\n            B: ' + (lb[i] === undefined ? '(none)' : lb[i]);
      }
    }
    return '';
  }

  // =========================================================================
  //  Event streams
  // =========================================================================

  // A hand-written stream with one of every beat, so the ordering assertions do
  // not depend on what a shuffled game happens to produce.
  function scriptedStream(Cards) {
    function c(id) { return Cards.cardFromId(id); }
    var mine = [c(0), c(4), c(8), c(12), c(16), c(20)];
    var theirs = [c(1), c(5), c(9), c(13), c(17), c(21)];
    return [
      { type: 'cutForDeal', cuts: [c(2), c(30)], dealer: 0 },
      { type: 'phase', from: 'CUT_FOR_DEAL', to: 'DEAL' },
      { type: 'deal', hands: [mine, theirs], dealer: 0 },
      { type: 'discard', player: 1, cards: [theirs[4], theirs[5]] },
      { type: 'discard', player: 0, cards: [mine[4], mine[5]] },
      { type: 'cribComplete' },
      { type: 'starter', card: c(40) },
      { type: 'play', player: 1, card: theirs[0], count: theirs[0].value },
      { type: 'play', player: 0, card: mine[0], count: theirs[0].value + mine[0].value },
      { type: 'score', player: 0, points: 2, reason: 'Pair', cards: [theirs[0], mine[0]],
        source: 'play', total: 2 },
      { type: 'go', player: 1 },
      { type: 'seriesReset', nextLeader: 1 },
      { type: 'showStart', player: 1, source: 'hand',
        cards: [theirs[0], theirs[1], theirs[2], theirs[3]], starter: c(40), handTotal: 4 },
      { type: 'score', player: 1, points: 4, reason: 'Run of four',
        cards: [theirs[0], theirs[1], theirs[2], theirs[3]], source: 'hand', total: 4 },
      { type: 'handEnd', dealer: 0 }
    ];
  }

  // A real game, batched the way a controller drives one: one play() per beat.
  function gameBatches(Engine, seed, targetScore) {
    var rand = mulberry32(seed);
    var game = Engine.createGame({ targetScore: targetScore, rng: rand });
    var out = [];
    var guard = 0;
    while (!game.isOver() && guard++ < 40000) {
      var actor = game.pendingActor();
      var events;
      if (actor === null) {
        events = game.advance();
      } else {
        var actions = game.legalActions();
        events = game.apply(actions[Math.floor(rand() * actions.length) % actions.length]);
      }
      out.push({ events: events, state: game.getState() });
    }
    return out;
  }

  // =========================================================================
  //  The tests
  // =========================================================================

  function rig(overrides) {
    var dom = makeDom();
    var cards = makeCards(dom.doc);
    var view = makeView(dom.doc, cards, overrides && overrides.view);
    var warnings = [];
    var Animate = root.Cribbage.Animate;
    var anim = Animate.create(view, {
      doc: dom.doc,
      cards: cards,
      guardPad: (overrides && overrides.guardPad !== undefined) ? overrides.guardPad : 12,
      guardFactor: (overrides && overrides.guardFactor !== undefined) ? overrides.guardFactor : 1,
      warn: function (msg) { warnings.push(msg); }
    });
    anim.setSpeed(overrides && overrides.speed !== undefined ? overrides.speed : 0);
    return { dom: dom, cards: cards, view: view, anim: anim, warnings: warnings };
  }

  function testOrdering(S, Cards) {
    var r = rig({ speed: 0.004 });
    var seen = [];
    var resolvedAt = -1;
    r.anim.onBeat(function (b) { seen.push(b.kind); });

    var events = scriptedStream(Cards);
    var expected = ['cutForDeal', 'deal', 'discard', 'discard', 'starter', 'play', 'play',
      'score', 'go', 'seriesReset', 'showStart', 'score', 'handEnd'];

    S.eq('isBusy() is false before anything is queued', r.anim.isBusy(), false);
    var p = r.anim.play(events, null).then(function () { resolvedAt = seen.length; });
    S.eq('isBusy() is true while draining', r.anim.isBusy(), true);

    return p.then(function () {
      S.deepEq('beats play in strict engine order', seen, expected);
      S.eq('play() resolves only after the last beat', resolvedAt, expected.length);
      S.eq('isBusy() is false once the queue is empty', r.anim.isBusy(), false);
      S.eq('phase and cribComplete produce no beat', seen.indexOf('phase'), -1);
    });
  }

  function testZeroScale(S, Engine) {
    if (!Engine) return Promise.resolve();
    var r = rig({ speed: 0 });
    var batches = gameBatches(Engine, 0xC21BB, 121);
    S.ok('the fuzzed stream reaches game over', batches.length > 0 &&
      batches[batches.length - 1].state.phase === 'GAME_OVER');

    S.eq('setSpeed(0) writes --anim-scale', r.view.el.app.style['--anim-scale'], '0');

    var last = null;
    for (var i = 0; i < batches.length; i++) {
      last = r.anim.play(batches[i].events, batches[i].state);
    }
    return last.then(function () {
      var end = batches[batches.length - 1].state;
      S.eq('a full game drains at --anim-scale 0', r.view.state.phase, 'GAME_OVER');
      S.eq('the winning score is painted', r.view.el.scores[end.winner].textContent,
        String(end.scores[end.winner]));
      S.eq('no animation is ever created at zero duration', r.dom.animations.length, 0);
      S.eq('the queue is idle afterwards', r.anim.isBusy(), false);
    });
  }

  function testReducedMotion(S, Engine) {
    if (!Engine) return Promise.resolve();
    // 0.001 is exactly what theme.css sets under prefers-reduced-motion. The OS
    // is asking for no motion, not for a quarter of a millisecond of it, so the
    // whole drain has to come out instant — no animations, no timers.
    var r = rig({ speed: 0.001 });
    var batches = gameBatches(Engine, 0x5EED1, 61);
    var last = null;
    for (var i = 0; i < batches.length; i++) {
      last = r.anim.play(batches[i].events, batches[i].state);
    }
    return last.then(function () {
      S.eq('a full game drains under prefers-reduced-motion',
        r.view.state.phase, 'GAME_OVER');
      S.eq('and creates no animation at all', r.dom.animations.length, 0);
      S.eq('nothing stalled', r.anim.isBusy(), false);
      S.eq('the watchdog never had to fire', r.warnings.length, 0,
        r.warnings.slice(0, 3).join(' | '));
    });
  }

  function testTinyDurations(S, Engine) {
    if (!Engine) return Promise.resolve();
    // Just above the floor: every beat goes through the MOTION path with real
    // but very short animations, which is where a serial queue is most likely to
    // trip over its own scheduling.
    var r = rig({ speed: 0.02 });
    var batches = gameBatches(Engine, 0x5EED1, 61).slice(0, 150);
    var last = null;
    for (var i = 0; i < batches.length; i++) {
      last = r.anim.play(batches[i].events, batches[i].state);
    }
    return last.then(function () {
      S.ok('short animations really were created', r.dom.animations.length > 50,
        r.dom.animations.length + ' animations');
      S.deepEq('the drain landed on the last snapshot handed in',
        r.view.state.scores, batches[batches.length - 1].state.scores);
      S.eq('nothing stalled', r.anim.isBusy(), false);
      S.eq('the watchdog never had to fire', r.warnings.length, 0,
        r.warnings.slice(0, 3).join(' | '));
    });
  }

  function testSkipEqualsPlay(S, Engine) {
    if (!Engine) return Promise.resolve();
    var batches = gameBatches(Engine, 0xBEEF7, 61);
    var played = rig({ speed: 0.004 });
    var skipped = rig({ speed: 0.004 });

    var i;
    var lastPlayed = null;
    for (i = 0; i < batches.length; i++) {
      lastPlayed = played.anim.play(batches[i].events, batches[i].state);
    }
    var lastSkipped = null;
    for (i = 0; i < batches.length; i++) {
      lastSkipped = skipped.anim.play(batches[i].events, batches[i].state);
    }
    skipped.anim.skip();

    return Promise.all([lastPlayed, lastSkipped]).then(function () {
      var a = domString(played.view);
      var b = domString(skipped.view);
      S.record('skip() lands on byte-identical DOM to playing it out',
        a === b, 'identical', a === b ? 'identical' : 'different', firstDifference(a, b));
      S.eq('both drains ended in game over', skipped.view.state.phase, 'GAME_OVER');
      S.deepEq('the pegs agree',
        [skipped.view.board.players[0].at, skipped.view.board.players[1].at],
        [played.view.board.players[0].at, played.view.board.players[1].at]);
      S.ok('the played run actually animated something', played.dom.animations.length > 20,
        played.dom.animations.length + ' animations');
      S.eq('the skipped run animated nothing', skipped.dom.animations.length, 0);
    });
  }

  // The shape the CONTROLLER actually produces, which is NOT the shape above.
  //
  // game.js issues exactly one play() per engine batch and awaits that drain
  // before issuing the next, and the engine emits ONE event per advance() during
  // the show — so counting a hand is a dozen separate one-beat jobs, never a
  // single queued sequence. testSkipEqualsPlay pushes a whole game in up front,
  // which is the one shape the controller never produces, so a skip that lasted
  // only as long as the job in flight passed it while leaving the player mashing
  // S through every remaining beat of every count.
  //
  // Fast-forward is therefore a MODE, not an event: it has to survive the queue
  // going momentarily empty between two jobs, and only the controller knows when
  // it should end (the moment a human decision is pending).
  function testSkipSpansSerialJobs(S, Engine, Cards) {
    if (!Engine) return Promise.resolve();
    var r = rig({ speed: 0.004 });
    var batches = gameBatches(Engine, 0xBEEF7, 61);
    var seen = [];
    r.anim.onBeat(function (b) { seen.push({ kind: b.kind, skipped: b.skipped }); });

    var i = 0;
    var presses = 0;
    var jobs = 0;
    var overlapped = 0;

    function nextJob() {
      if (i >= batches.length) return Promise.resolve();
      var batch = batches[i++];
      jobs++;
      if (r.anim.isBusy()) overlapped++;
      var p = r.anim.play(batch.events, batch.state);
      // ONE press, during the first job only. Nothing ever presses it again.
      if (!presses) { presses++; r.anim.skip(); }
      return p.then(nextJob);
    }

    return nextJob().then(function () {
      var played = seen.filter(function (b) { return !b.skipped; });
      S.eq('one press of skip fast-forwards every later job too', played.length, 0,
        played.length + ' of ' + seen.length + ' beats still played at full speed' +
        (played.length ? ', first was "' + played[0].kind + '"' : ''));
      S.eq('so nothing animated after the press', r.dom.animations.length, 0);
      S.ok('the run really was many separate jobs', jobs > 50, jobs + ' jobs');
      S.eq('and no two of them were ever queued together', overlapped, 0);
      S.eq('the game still reached game over', r.view.state.phase, 'GAME_OVER');
      S.eq('the queue is idle', r.anim.isBusy(), false);
      S.eq('fast-forward stays armed until something clears it',
        r.anim.isSkipping(), true);

      r.anim.resume();
      S.eq('resume() ends fast-forward', r.anim.isSkipping(), false);
      return r.anim.play(scriptedStream(Cards), null);
    }).then(function () {
      S.ok('and motion comes back afterwards', r.dom.animations.length > 20,
        r.dom.animations.length + ' animations after resume()');

      // A press that lands while the queue happens to be empty — between two of
      // the controller's one-beat jobs, or during the opponent's think pause —
      // has to arm the NEXT job rather than being dropped on the floor.
      var idle = rig({ speed: 0.004 });
      S.eq('nothing is draining yet', idle.anim.isBusy(), false);
      idle.anim.skip();
      return idle.anim.play(scriptedStream(Cards), null).then(function () {
        S.eq('a press that lands between jobs arms the next one',
          idle.dom.animations.length, 0);
      });
    });
  }

  // The trailing hold on a score beat is created inside a .then, AFTER the
  // announce and the peg walk have resolved — so at the moment skip() runs it
  // does not exist yet and cannot be released by draining `sleepers`. A hold
  // asked for while fast-forward is armed must therefore not be a hold at all.
  function testSkipReleasesLaterSleeps(S, Cards) {
    var r = rig({ speed: 1 });
    var c = function (id) { return Cards.cardFromId(id); };
    var started = Date.now();
    var p = r.anim.play([
      { type: 'score', player: 0, points: 12, reason: 'Double run', cards: [c(0), c(4)],
        source: 'hand', total: 12 }
    ], null);
    // Two turns in: past the deferred drain and into the peg walk, which is
    // exactly where the trailing sleep has not been created yet.
    return Promise.resolve().then(function () {}).then(function () {
      r.anim.skip();
      return p;
    }).then(function () {
      var took = Date.now() - started;
      // BASE.base is 250ms at speed 1. Anything near that means the hold was
      // waited out rather than skipped.
      S.ok('a hold created after the press is not waited out', took < 120,
        took + 'ms for a skipped score beat');
      S.eq('the queue is idle', r.anim.isBusy(), false);
      r.anim.resume();
    });
  }

  function testSkipMidFlight(S, Cards) {
    var r = rig({ speed: 1 });
    // Animations that stay running, so there is genuinely something in flight to
    // cancel rather than something that already settled on a microtask.
    r.dom.setAnimMode('never');
    var events = scriptedStream(Cards);
    var p = r.anim.play(events, null);
    // Two turns of the event loop in: one for the deferred drain, one for the
    // first beat to get its animations up.
    return Promise.resolve().then(function () {}).then(function () {
      S.ok('animations are running before the skip', r.dom.animations.length > 0,
        r.dom.animations.length + ' created');
      r.anim.skip();
      return p;
    }).then(function () {
      var cancelled = 0;
      for (var i = 0; i < r.dom.animations.length; i++) {
        if (r.dom.animations[i].playState === 'cancelled') cancelled++;
      }
      S.ok('skip() cancelled the in-flight animations', cancelled > 0, cancelled + ' cancelled');
      S.eq('skip() drained the queue', r.anim.isBusy(), false);
      S.eq('no floating label survived the skip',
        r.view.el.table.querySelectorAll('.anim-float').length, 0);
      S.eq('no peg was left lifted',
        r.view.el.table.querySelectorAll('[data-lifted="true"]').length, 0);
      S.eq('no card was left glowing',
        r.view.el.table.querySelectorAll('.card--highlighted').length, 0);
    });
  }

  function testNeverSettles(S, Cards) {
    var r = rig({ speed: 0.05, guardPad: 12, guardFactor: 1 });
    r.dom.setAnimMode('never');
    var seen = [];
    r.anim.onBeat(function (b) { seen.push(b.kind); });
    // Deliberately no wall-clock assertion here. The watchdog is a setTimeout,
    // and setTimeout has a clamp of its own that depends on the environment — a
    // backgrounded tab stretches every one of them to a second. What matters is
    // that the promise settles at all, which is exactly what awaiting it proves.
    return r.anim.play(scriptedStream(Cards), null).then(function () {
      S.ok('a queue of never-settling animations still drains', seen.length >= 13,
        seen.length + ' beats');
      S.ok('the watchdog fired and said so', r.warnings.length > 0,
        (r.warnings[0] || '') + '');
      S.ok('every stuck animation was cancelled', (function () {
        for (var i = 0; i < r.dom.animations.length; i++) {
          if (r.dom.animations[i].playState === 'running') return false;
        }
        return true;
      })());
      S.eq('and the queue came back idle', r.anim.isBusy(), false);
    });
  }

  function testRejects(S, Cards) {
    var r = rig({ speed: 0.05 });
    r.dom.setAnimMode('reject');
    var seen = [];
    r.anim.onBeat(function (b) { seen.push(b.kind); });
    return r.anim.play(scriptedStream(Cards), null).then(function () {
      S.ok('a rejecting animation does not stall the queue', seen.length >= 13,
        seen.length + ' beats');
      S.eq('the queue is idle', r.anim.isBusy(), false);
    });
  }

  function testEnqueueDuringDrain(S, Cards) {
    var r = rig({ speed: 0.004 });
    var events = scriptedStream(Cards);
    var seen = [];
    var marks = [];
    var second = null;

    r.anim.onBeat(function (b) {
      seen.push(b.kind);
      // Queue a second job from inside the first one's third beat — the worst
      // moment for a queue that reorders.
      if (seen.length === 3 && !second) {
        second = r.anim.play([{ type: 'handEnd', dealer: 0 }], null)
          .then(function () { marks.push('second'); });
      }
    });

    var first = r.anim.play(events, null).then(function () { marks.push('first'); });

    return first.then(function () { return second; }).then(function () {
      var expectedFirst = 13;
      S.eq('every beat of both jobs ran', seen.length, expectedFirst + 1);
      S.eq('the second job did not interleave', seen[seen.length - 1], 'handEnd');
      S.deepEq('the first job finished before the second started', marks, ['first', 'second']);
    });
  }

  function testPegLeapfrog(S, Cards) {
    // Fast, but comfortably above the sub-millisecond floor, so the walk really
    // is a hop per hole rather than one collapsed placement.
    var r = rig({ speed: 0.2 });
    var c = function (id) { return Cards.cardFromId(id); };
    var board = r.view.board;

    // Compared by slot rather than by element: a DOM node in an assertion's
    // expected/actual is a circular structure and the reporter stringifies both.
    function rearSlot(p) { return board.pegElement(p, 'rear').getAttribute('data-slot'); }
    function frontSlot(p) { return board.pegElement(p, 'front').getAttribute('data-slot'); }

    var firstMover = rearSlot(0);
    return r.anim.play([
      { type: 'score', player: 0, points: 6, reason: 'Fifteen six', cards: [c(0)],
        source: 'play', total: 6 }
    ], null).then(function () {
      var p0 = board.players[0];
      S.eq('the first score sends the rear peg out in front', frontSlot(0), firstMover);
      S.eq('and it lands on the new total', Math.max(p0.at[0], p0.at[1]), 6);
      S.eq('with its partner left on the old one', Math.min(p0.at[0], p0.at[1]), 0);

      var secondMover = rearSlot(0);
      S.ok('the peg due to travel next is the other one', secondMover !== firstMover);

      return r.anim.play([
        { type: 'score', player: 0, points: 8, reason: 'Run of four', cards: [c(4)],
          source: 'hand', total: 14 },
        { type: 'score', player: 1, points: 24, reason: 'Double double run', cards: [c(8)],
          source: 'hand', total: 24 }
      ], null).then(function () {
        var rear0 = Math.min(p0.at[0], p0.at[1]);
        var front0 = Math.max(p0.at[0], p0.at[1]);
        S.eq('the front peg stands on the new total', front0, 14);
        S.eq('the rear peg stands on the old total', rear0, 6);
        S.eq('the gap between the pegs is the score just taken', front0 - rear0, 8);
        S.eq('and it is the rear peg that leapfrogged', frontSlot(0), secondMover);
        S.eq('the pegs stand where the board says they do',
          p0.pegs[0].style.top, r2(board.holePosition(0, p0.at[0]).y) + 'px');

        var p1 = board.players[1];
        var rear1 = Math.min(p1.at[0], p1.at[1]);
        var front1 = Math.max(p1.at[0], p1.at[1]);
        S.eq("a 24-hand leaves a 24-hole gap on the other player's track",
          front1 - rear1, 24);
        S.eq('and lands on 24', front1, 24);

        var hops = 0;
        for (var i = 0; i < r.dom.animations.length; i++) {
          var a = r.dom.animations[i];
          if (a.owner && a.owner.className.indexOf('crib-peg') !== -1) hops++;
        }
        S.ok('the peg visibly walked rather than teleporting', hops >= 24 + 8 + 6,
          hops + ' peg hops for 38 holes of travel');
      });
    });
  }

  function testPegWalkIsCapped(S, Cards) {
    var r = rig({ speed: 1 });
    var c = function (id) { return Cards.cardFromId(id); };
    var p = r.anim.play([
      { type: 'score', player: 0, points: 29, reason: 'Twenty-nine', cards: [c(0)],
        source: 'hand', total: 29 }
    ], null);
    r.anim.skip();
    return p.then(function () {
      var total = 0;
      var hops = 0;
      for (var i = 0; i < r.dom.animations.length; i++) {
        var a = r.dom.animations[i];
        if (a.owner && a.owner.className.indexOf('crib-peg') !== -1) {
          hops++;
          total += a.options.duration || 0;
        }
      }
      // Every hop is created up front by the same rule, so the total the walk
      // WOULD have taken is measurable even though skip() cut it short.
      S.ok('a 29-hand walk is capped near a second', total <= 1050,
        Math.round(total) + 'ms across ' + hops + ' hops');
    });
  }

  function testNothingAfterGameOver(S, Cards) {
    var r = rig({ speed: 0.004 });
    var c = function (id) { return Cards.cardFromId(id); };
    var events = [
      { type: 'score', player: 0, points: 5, reason: 'Fifteen four', cards: [c(0)],
        source: 'hand', total: 121 },
      { type: 'phase', from: 'SHOW_PONE', to: 'GAME_OVER' },
      { type: 'gameOver', winner: 0, scores: [121, 98], skunk: 'none' },
      // Nothing should ever follow a gameOver. If something one day does, it
      // must not become a beat.
      { type: 'score', player: 1, points: 4, reason: 'Run of four', cards: [c(4)],
        source: 'hand', total: 102 },
      { type: 'handEnd', dealer: 0 }
    ];
    var beats = r.anim._internals.buildBeats(events);
    var kinds = beats.map(function (b) { return b.kind; });
    S.deepEq('no beat is queued after gameOver', kinds, ['score', 'gameOver']);

    var seen = [];
    r.anim.onBeat(function (b) { seen.push(b.kind); });
    return r.anim.play(events, null).then(function () {
      S.deepEq('and none is played either', seen, ['score', 'gameOver']);
    });
  }

  function testSpeedControl(S) {
    var r = rig({ speed: 1 });
    S.eq('setSpeed writes the token', r.view.el.app.style['--anim-scale'], '1');
    r.anim.setSpeed(0.25);
    S.eq('setSpeed(0.25)', r.view.el.app.style['--anim-scale'], '0.25');
    r.anim.setSpeed(0);
    S.eq('setSpeed(0)', r.view.el.app.style['--anim-scale'], '0');
    r.anim.setSpeed(-3);
    S.eq('a nonsense speed falls back to 1', r.view.el.app.style['--anim-scale'], '1');
    r.anim.setSpeed(99);
    S.eq('speed is clamped', r.view.el.app.style['--anim-scale'], '4');
    return Promise.resolve();
  }

  function testOnBeatIsSafe(S, Cards) {
    var r = rig({ speed: 0 });
    var seen = 0;
    var off = r.anim.onBeat(function () {
      seen++;
      throw new Error('a listener that throws');
    });
    return r.anim.play(scriptedStream(Cards), null).then(function () {
      S.eq('a throwing onBeat listener still sees every beat', seen, 13);
      S.ok('and is reported rather than swallowed', r.warnings.length === seen);
      off();
      return r.anim.play([{ type: 'handEnd', dealer: 0 }], null);
    }).then(function () {
      S.eq('unsubscribing works', seen, 13);
    });
  }

  function testRenderStateWins(S, Engine) {
    if (!Engine) return Promise.resolve();
    // The snapshot is authoritative: whatever the beats moved around, a view
    // driven through the animator ends up where a view driven by renderState
    // alone would. Both are walked through the SAME sequence of snapshots —
    // comparing against a single late repaint would only prove that pooled
    // elements accumulate attributes, which they do in render.js too.
    var batches = gameBatches(Engine, 0x1234, 61).slice(0, 60);
    var driven = rig({ speed: 0.004 });
    var painted = rig({ speed: 0.004 });

    var last = null;
    for (var i = 0; i < batches.length; i++) {
      last = driven.anim.play(batches[i].events, batches[i].state);
      painted.view.renderState(batches[i].state, null);
    }
    return last.then(function () {
      var a = domString(driven.view);
      var b = domString(painted.view);
      S.record('an animated drain ends where a plain repaint would',
        a === b, 'identical', a === b ? 'identical' : 'different', firstDifference(a, b));
    });
  }

  // =========================================================================
  //  The count summary (js/game.js)
  // =========================================================================
  //
  // Scoring is automatic, so after each of the three counts in a hand the game
  // stops on a summary and waits for Continue. What that summary shows has to
  // be the receipts for what was ACTUALLY SCORED, which is not the same thing
  // as what the hand is worth: the engine's award gate stops the count dead the
  // moment somebody reaches the target, so a hand that wins on its third
  // combination never awards its fourth.
  //
  // game.js exports the pure fold that builds the summary out of engine events,
  // and everything below drives that fold with real games. Scoring.scoreHand()
  // appears only on the EXPECTED side of an assertion, as the thing the summary
  // must not be.

  // Plays a whole game the way the controller does — one batch at a time — and
  // folds every batch through Game.readCounts exactly as runEvents() does.
  function playForCounts(Game, Engine, seed, options) {
    var rand = mulberry32(seed);
    var opts = { rng: rand };
    for (var k in (options || {})) opts[k] = options[k];
    var game = Engine.createGame(opts);
    var target = game.getState().targetScore;

    var open = null;
    var openBefore = 0;      // the counting player's score when the count opened
    var counts = [];
    var handEnds = [];       // index into `counts` at which each hand finished
    var awarded = [];        // every score event carrying a count's source
    var starts = 0;          // showStart events, i.e. counts the engine began
    var guard = 0;

    while (!game.isOver() && guard++ < 40000) {
      var before = game.getState().scores.slice();
      var actor = game.pendingActor();
      var events;
      if (actor === null) {
        events = game.advance();
      } else {
        var legal = game.legalActions();
        events = game.apply(legal[Math.floor(rand() * legal.length) % legal.length]);
      }

      var i;
      for (i = 0; i < events.length; i++) {
        var ev = events[i];
        if (ev.type === 'showStart') {
          starts++;
          openBefore = before[ev.player];
        }
        if (ev.type === 'score' && (ev.source === 'hand' || ev.source === 'crib')) {
          awarded.push(ev);
        }
        if (ev.type === 'handEnd') handEnds.push(counts.length);
      }

      var read = Game.readCounts(open, events);
      open = read.open;
      for (i = 0; i < read.closed.length; i++) {
        read.closed[i].scoreBefore = openBefore;
        read.closed[i].scoreAfter = game.getState().scores[read.closed[i].player];
        counts.push(read.closed[i]);
      }
    }

    return {
      counts: counts,
      handEnds: handEnds,
      awarded: awarded,
      starts: starts,
      open: open,
      target: target,
      state: game.getState()
    };
  }

  function sumPoints(items) {
    var n = 0;
    for (var i = 0; i < items.length; i++) n += items[i].points;
    return n;
  }

  function testSummaryPerCount(S, Game, Engine) {
    var run = playForCounts(Game, Engine, 0x5C0DED, { targetScore: 121 });

    S.eq('the game reached game over', run.state.phase, 'GAME_OVER');
    S.eq('no count is left open at the end', run.open, null);
    S.ok('a whole game produces counts to summarise', run.counts.length > 20,
      run.counts.length + ' counts');

    // A count opens on showStart and closes when the engine leaves the show
    // phase, so "one summary per count, no more and no fewer" is the same
    // statement as "one closed count per showStart event".
    S.eq('every count the engine began produced exactly one summary',
      run.counts.length, run.starts);

    var start = 0;
    var bad = [];
    for (var h = 0; h < run.handEnds.length; h++) {
      var trio = run.counts.slice(start, run.handEnds[h]);
      start = run.handEnds[h];
      var name = 'hand ' + (h + 1);
      if (trio.length !== 3) {
        bad.push(name + ' summarised ' + trio.length + ' counts');
        continue;
      }
      if (trio[0].source !== 'hand' || trio[1].source !== 'hand' ||
        trio[2].source !== 'crib') {
        bad.push(name + ' counted ' + trio.map(function (c) { return c.source; }).join(','));
      }
      if (trio[0].player === trio[1].player) {
        bad.push(name + ' counted the same player twice');
      }
      if (trio[1].player !== trio[2].player) {
        bad.push(name + ' gave the crib to the wrong player');
      }
      if (trio[2].cards.length !== 4 || !trio[2].starter) {
        bad.push(name + ' did not carry five cards for the crib');
      }
    }
    S.ok('a whole game of complete hands', run.handEnds.length > 5,
      run.handEnds.length + ' hands');
    S.eq("every completed hand is three counts — pone's hand, dealer's hand, dealer's crib",
      bad.length, 0, bad.slice(0, 3).join(' | '));

    // The receipts, against what the engine actually awarded. This is the
    // assertion that a re-scored summary fails.
    var listed = [];
    for (var c = 0; c < run.counts.length; c++) {
      var items = run.counts[c].items;
      for (var j = 0; j < items.length; j++) {
        listed.push(items[j].reason + ' +' + items[j].points);
      }
    }
    var emitted = run.awarded.map(function (ev) {
      return ev.reason + ' +' + ev.points;
    });
    S.deepEq('the summaries list exactly the combinations the engine awarded',
      listed, emitted);

    var totalsAgree = true;
    for (c = 0; c < run.counts.length; c++) {
      if (run.counts[c].total !== sumPoints(run.counts[c].items)) totalsAgree = false;
      // Everything short of the win is unclamped, so the pegs and the total are
      // the same number; the winning count is checked separately below.
      if (run.counts[c].scoreAfter < run.target &&
        run.counts[c].scoreBefore + run.counts[c].total !== run.counts[c].scoreAfter) {
        totalsAgree = false;
      }
    }
    S.ok('every total is the sum of its own list, and the pegs agree', totalsAgree);
  }

  // "Nothing. A nineteen hand." is only reachable if a count really can come out
  // of the engine with no score events at all.
  function testNineteenHand(S, Game, Engine) {
    var nil = null;
    var counted = 0;
    for (var seed = 1; seed <= 12 && !nil; seed++) {
      var run = playForCounts(Game, Engine, seed * 0x9E3779B1, { targetScore: 121 });
      for (var i = 0; i < run.counts.length; i++) {
        counted++;
        if (!run.counts[i].items.length) { nil = run.counts[i]; break; }
      }
    }
    S.ok('a count that scores nothing really happens', !!nil,
      counted + ' counts searched');
    if (!nil) return;
    S.eq('and it carries no items at all', nil.items.length, 0);
    S.eq('with a total of nothing', nil.total, 0);
    S.eq('the five cards are still there to be shown', nil.cards.length, 4);
    S.ok('including the cut', !!nil.starter);
    S.eq('and the player did not move', nil.scoreBefore, nil.scoreAfter);
  }

  // THE CASE THE WHOLE DESIGN TURNS ON. The game ends the instant a player
  // reaches the target, including partway through a count: the engine emits
  // score events up to that point and stops. A summary built by re-scoring the
  // hand would list a combination the player was never awarded and a total that
  // disagrees with their pegs.
  function testSummaryOnAMidCountWin(S, Game, Engine, Scoring) {
    if (!Scoring) return;
    var found = null;
    var searched = 0;
    var seed;
    var game;
    var last;
    for (seed = 1; seed <= 600 && !found; seed++) {
      searched++;
      game = playForCounts(Game, Engine, seed * 0x27D4EB2D, {
        targetScore: 121,
        scores: [114, 112]
      });
      last = game.counts[game.counts.length - 1];
      if (!last || game.state.winner !== last.player) continue;
      if (last.scoreAfter !== game.target || !last.items.length) continue;
      var full = Scoring.scoreHand(last.cards, last.starter, last.source === 'crib');
      if (full.breakdown.length > last.items.length) {
        found = { game: game, count: last, full: full };
      }
    }

    S.ok('found a count that won the game partway through', !!found,
      searched + ' games searched');
    if (!found) return;

    var c = found.count;
    var whole = found.full;

    S.ok('the count really was cut short', c.items.length < whole.breakdown.length,
      c.items.length + ' of ' + whole.breakdown.length + ' combinations awarded');
    S.deepEq('the summary lists only the combinations that were awarded',
      c.items.map(function (it) { return it.reason; }),
      whole.breakdown.slice(0, c.items.length).map(function (b) { return b.label; }));
    S.eq('the total is the sum of what was actually awarded',
      c.total, sumPoints(c.items));
    S.ok('which is less than the hand is worth', c.total < whole.total,
      c.total + ' shown, ' + whole.total + ' in the hand');
    // The engine clamps the winning award at the target, so the pegs land on
    // home rather than past it. That is what "matching the pegs" means here.
    S.eq('and the pegs agree with the summary',
      Math.min(c.scoreBefore + c.total, found.game.target), c.scoreAfter);
    S.eq('the count that won the game is still summarised',
      found.game.state.phase, 'GAME_OVER');
    S.eq('and it closed rather than being left open',
      found.game.open, null);
  }

  // What does and does not belong to a count, stated directly. Pegging points
  // and his heels are scored in the same hand and are nobody's count.
  function testCountFoldIgnoresTheRestOfTheHand(S, Game, Cards) {
    var c = function (id) { return Cards.cardFromId(id); };
    var four = [c(0), c(4), c(8), c(12)];
    var stream = [
      { type: 'score', player: 0, points: 2, reason: 'His heels', cards: [c(40)],
        source: 'heels', total: 2 },
      { type: 'phase', from: 'CUT_STARTER', to: 'PLAY' },
      { type: 'score', player: 0, points: 2, reason: 'Fifteen two', cards: [],
        source: 'play', total: 4 },
      { type: 'phase', from: 'PLAY', to: 'SHOW_PONE' },
      { type: 'showStart', player: 1, source: 'hand', cards: four,
        starter: c(40), handTotal: 6 },
      { type: 'score', player: 1, points: 2, reason: 'Fifteen two', cards: [],
        source: 'hand', total: 2 },
      { type: 'score', player: 1, points: 4, reason: 'Run of four', cards: [],
        source: 'hand', total: 6 },
      { type: 'phase', from: 'SHOW_PONE', to: 'SHOW_DEALER' }
    ];
    var expected = [
      { reason: 'Fifteen two', points: 2 },
      { reason: 'Run of four', points: 4 }
    ];

    var read = Game.readCounts(null, stream);
    S.eq('one count closed', read.closed.length, 1);
    S.eq('and none is left open', read.open, null);
    S.deepEq('pegging points and his heels are not part of a count',
      read.closed[0].items, expected);
    S.eq('the total is the sum of what was awarded', read.closed[0].total, 6);
    S.eq('the four cards being counted are carried', read.closed[0].cards.length, 4);
    S.eq('and the cut with them', read.closed[0].starter.id, 40);
    S.eq('whose count it is', read.closed[0].player, 1);
    S.eq('and whether it is a hand or a crib', read.closed[0].source, 'hand');

    // Fed one event at a time, which is the shape the controller actually sees:
    // the engine emits one event per advance() through the whole count.
    var open = null;
    var closed = [];
    for (var i = 0; i < stream.length; i++) {
      var step = Game.readCounts(open, [stream[i]]);
      open = step.open;
      closed = closed.concat(step.closed);
    }
    S.eq('one event at a time closes the same single count', closed.length, 1);
    S.deepEq('with the same items', closed[0].items, expected);

    // A count that is still being read must not close early on anything else.
    // Everything up to and including the first of the two scoring combinations.
    var partial = Game.readCounts(null, stream.slice(0, 6));
    S.eq('a count still in progress does not close', partial.closed.length, 0);
    S.ok('and is reported as open', !!partial.open);
    S.eq('holding what it has so far', partial.open.items.length, 1);
  }

  // SKIP MUST LAND ON THE SUMMARY, NOT PAST IT. Being able to see the count is
  // the entire point of the pause, so fast-forward may remove the animation and
  // nothing else. It is structurally safe — game.js reads the receipts off the
  // events in runEvents() before a beat plays, and the gate hangs off the end of
  // the drain — and this checks the animator's half: a skipped count still runs
  // every settle and still reports every scoring beat.
  function testSkipLandsOnTheSummary(S, Game, Engine) {
    if (!Engine) return Promise.resolve();
    var batches = gameBatches(Engine, 0xC0FFEE, 61);

    var open = null;
    var counts = [];
    for (var b = 0; b < batches.length; b++) {
      var read = Game.readCounts(open, batches[b].events);
      open = read.open;
      counts = counts.concat(read.closed);
    }
    S.ok('the stream contains counts to summarise', counts.length >= 6,
      counts.length + ' counts');

    function drive(press) {
      var r = rig({ speed: 0.004 });
      var seen = [];
      var counted = 0;      // score beats belonging to a count, not to the play
      var pressed = false;
      var animsAtPress = -1;
      r.anim.onBeat(function (beat) {
        if (beat.kind === 'showStart' || beat.kind === 'score') {
          seen.push(beat.kind + ':' + beat.event.source + ':' +
            (beat.event.reason || ''));
          if (beat.kind === 'score' &&
            (beat.event.source === 'hand' || beat.event.source === 'crib')) counted++;
        }
        // One press, during the first count. Nothing presses it again.
        if (press && !pressed && beat.kind === 'showStart') {
          pressed = true;
          animsAtPress = r.dom.animations.length;
          r.anim.skip();
        }
      });
      var i = 0;
      function next() {
        if (i >= batches.length) return Promise.resolve();
        var batch = batches[i++];
        return r.anim.play(batch.events, batch.state).then(next);
      }
      return next().then(function () {
        return {
          seen: seen, counted: counted, rig: r,
          pressed: pressed, animsAtPress: animsAtPress
        };
      });
    }

    return drive(false).then(function (played) {
      return drive(true).then(function (skipped) {
        S.ok('the press landed inside a count', skipped.pressed);
        S.deepEq('a skip during a count loses no scoring beat',
          skipped.seen, played.seen);
        S.eq('nothing animated after the press',
          skipped.rig.dom.animations.length, skipped.animsAtPress);
        S.ok('while the played run animated plenty',
          played.rig.dom.animations.length > 20,
          played.rig.dom.animations.length + ' animations');
        S.eq('fast-forward is still armed at the end of the run',
          skipped.rig.anim.isSkipping(), true);

        // The receipts survive the fast-forward because they are read off the
        // events, not off the animation. Same events, same summaries.
        var listed = 0;
        for (var i = 0; i < counts.length; i++) listed += counts[i].items.length;
        S.eq('and every listed combination still has a beat behind it',
          listed, skipped.counted);
        skipped.rig.anim.resume();
      });
    });
  }

  // ...AND NEITHER MAY THE SKIP KEY ITSELF. The animator's half of "skip lands
  // on the summary" is above; this is the keyboard's half, and it is where the
  // bug actually was. Space is fast-forward during a count and Continue once the
  // summary is up, the Skip button tells the player to tap it, and a tap is not
  // auto-repeat — so the tap already on its way when the panel appeared used to
  // dismiss it. Measured against the real page: twelve summaries opened and
  // closed at 202-206ms each under a 200ms tap, none of them readable.
  //
  // Game.summaryKey is the pure decision, so the whole thing is testable as
  // arithmetic on a clock. The settle time is read back out of the function
  // rather than assumed, so the behaviour is asserted independently of the
  // number; the number itself is pinned once, at the end, and for its own
  // reason.
  function testSpaceTapsCannotDismissTheSummary(S, Game) {
    var press = function (key, now, settled, repeat) {
      return Game.summaryKey(key, { now: now, settled: settled, repeat: !!repeat });
    };

    // A press inside the window comes back held, and the window it comes back
    // with is how long the settle is.
    var settle = press(' ', 0, 1).settled;
    S.ok('Space has a settle window at all', settle > 0, settle + 'ms');
    S.ok('long enough to outlast a hurried tap', settle >= 300, settle + 'ms');

    // THE FAILING CASE, at both cadences the auditor measured. The summary opens
    // at t=0 armed for `settle`, and the player keeps tapping the key the UI
    // told them to tap. Every one of those taps must be swallowed, however many
    // of them there are — a burst ends by stopping, not by running out.
    [200, 120, 399].forEach(function (gap) {
      var settled = settle;         // openSummary() arms it at now + settle
      var closed = -1;
      for (var i = 1; i <= 60 && closed === -1; i++) {
        var v = press(' ', i * gap, settled);
        settled = v.settled;
        if (v.action === 'close') closed = i * gap;
      }
      S.eq('tapping Space every ' + gap + 'ms never dismisses the summary',
        closed, -1, closed === -1 ? '' : 'dismissed after ' + closed + 'ms');
    });

    // A held key is the other half of the same gesture and was already covered;
    // it stays covered, and it also keeps the window open behind it.
    var held = press(' ', 10, settle, true);
    S.eq('auto-repeat never activates Continue', held.action, 'hold');
    S.ok('and pushes the window out behind it', held.settled > settle);
    S.eq('a held Enter does not either', press('Enter', 9999, 0, true).action, 'hold');
    S.eq('nor a held Escape', press('Escape', 9999, 0, true).action, 'hold');

    // S is inert behind the summary, which is what made this a Space bug and not
    // a design necessity — but it is still the player hurrying, so S-then-Space
    // is one gesture rather than a skip followed by a Continue.
    var sKey = press('s', 1000, 0);
    S.eq('S is not the summary\'s key', sKey.action, 'pass');
    S.eq('but it keeps the burst alive', sKey.settled, 1000 + settle);
    S.eq('so a Space right behind it is still fast-forward',
      press(' ', 1050, sKey.settled).action, 'hold');

    // The window may not become a dead end. Two keys continue on the very first
    // press however hard the player is leaning on Space, and Space itself comes
    // back the moment the tapping stops.
    S.eq('Enter continues immediately, inside the window',
      press('Enter', 10, settle).action, 'close');
    S.eq('Escape continues immediately, inside the window',
      press('Escape', 10, settle).action, 'close');
    S.eq('and Space continues once the burst has stopped',
      press(' ', settle, settle).action, 'close');
    S.eq('Tab is left alone so focus can leave the panel',
      press('Tab', 10, settle).action, 'pass');
    S.eq('and it does not disturb the window',
      press('Tab', 10, settle).settled, settle);

    // The settle is a property of the hand on the keyboard, not of the
    // animation, so it is a plain constant — --t-slow's 400ms borrowed as a
    // length of time. Pinned, because the obvious "tidy-up" is to multiply it by
    // --anim-scale like every real duration, and at scale 0 that is no window at
    // all — precisely where the counts are instant and the taps arrive fastest.
    S.eq('the window is a constant, not a scaled token', settle, 400);
  }

  // =========================================================================
  //  Runner
  // =========================================================================

  function run(options) {
    options = options || {};
    var S = new Suite(options);
    var log = options.log || function () {};

    if (!root.Cribbage || !root.Cribbage.Animate) {
      S.ok('modules loaded (animate.js)', false);
      return Promise.resolve({ passed: S.passed, failed: S.failed, results: S.results });
    }
    var Cards = root.Cribbage.Cards;
    if (!Cards) {
      S.ok('modules loaded (cards.js)', false);
      return Promise.resolve({ passed: S.passed, failed: S.failed, results: S.results });
    }
    var Engine = root.Cribbage.Engine || null;
    if (!Engine) log('  (engine.js not loaded — the full-game drains are skipped)');
    var Scoring = root.Cribbage.Scoring || null;
    // game.js exports the count-summary fold and nothing else this suite needs.
    // It touches no DOM until create() is called, so it loads cleanly here.
    var Game = root.Cribbage.Game || null;
    if (!Game) log('  (game.js not loaded — the count-summary group is skipped)');

    var sections = [
      ['beat order', function () { return testOrdering(S, Cards); }],
      ['zero speed', function () { return testZeroScale(S, Engine); }],
      ['reduced motion', function () { return testReducedMotion(S, Engine); }],
      ['tiny durations', function () { return testTinyDurations(S, Engine); }],
      ['skip equals play', function () { return testSkipEqualsPlay(S, Engine); }],
      ['skip spans jobs', function () { return testSkipSpansSerialJobs(S, Engine, Cards); }],
      ['skip releases later sleeps', function () { return testSkipReleasesLaterSleeps(S, Cards); }],
      ['skip mid-flight', function () { return testSkipMidFlight(S, Cards); }],
      ['watchdog', function () { return testNeverSettles(S, Cards); }],
      ['rejection', function () { return testRejects(S, Cards); }],
      ['enqueue during drain', function () { return testEnqueueDuringDrain(S, Cards); }],
      ['peg leapfrog', function () { return testPegLeapfrog(S, Cards); }],
      ['peg walk cap', function () { return testPegWalkIsCapped(S, Cards); }],
      ['game over', function () { return testNothingAfterGameOver(S, Cards); }],
      ['speed control', function () { return testSpeedControl(S); }],
      ['onBeat', function () { return testOnBeatIsSafe(S, Cards); }],
      ['renderState wins', function () { return testRenderStateWins(S, Engine); }],
      ['summary per count', function () {
        if (Game && Engine) testSummaryPerCount(S, Game, Engine);
      }],
      ['nineteen hand', function () {
        if (Game && Engine) testNineteenHand(S, Game, Engine);
      }],
      ['summary on a mid-count win', function () {
        if (Game && Engine) testSummaryOnAMidCountWin(S, Game, Engine, Scoring);
      }],
      ['what belongs to a count', function () {
        if (Game) testCountFoldIgnoresTheRestOfTheHand(S, Game, Cards);
      }],
      ['skip lands on the summary', function () {
        return Game ? testSkipLandsOnTheSummary(S, Game, Engine) : Promise.resolve();
      }],
      ['the skip key cannot dismiss it', function () {
        if (Game) testSpaceTapsCannotDismissTheSummary(S, Game);
      }]
    ];

    // A section that throws or rejects is a failure like any other, but it must
    // not take the rest of the suite down with it.
    var chain = Promise.resolve();
    sections.forEach(function (entry) {
      chain = chain.then(function () {
        var started = Date.now();
        return Promise.resolve()
          .then(entry[1])
          .then(function () {
            if (options.verbose) log('  ' + entry[0] + ' (' + (Date.now() - started) + 'ms)');
          }, function (err) {
            S.record(entry[0] + ': the group threw', false, 'no throw',
              (err && err.message) || String(err), (err && err.stack) || '');
          });
      });
    });

    return chain.then(function () {
      return { passed: S.passed, failed: S.failed, results: S.results };
    });
  }

  root.Cribbage = root.Cribbage || {};
  root.Cribbage.AnimateTests = { run: run };
})(typeof window !== 'undefined' ? window : globalThis);
