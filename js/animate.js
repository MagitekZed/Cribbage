(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // animate.js — the motion layer.
  //
  // It turns an array of engine events into an ordered list of BEATS and plays
  // them strictly serially. It owns no rules and no copy decisions: every beat
  // is a visible moment for something the engine already decided, and the
  // snapshot handed to play() is the authoritative final picture.
  //
  // THE QUEUE MUST NEVER HANG. Everything below is arranged around that:
  //
  //   * every motion is element.animate(). CSS transitions plus transitionend
  //     are unusable here — transitionend never fires at duration 0, never fires
  //     if the property did not actually change, and never fires for a detached
  //     element, and any one of those permanently stalls a serial queue. An
  //     Animation's .finished promise settles in all three cases and can be
  //     cancelled for skip.
  //   * every awaited animation also races a timeout of duration * 3 + 250ms.
  //     If it has not settled by then we warn, cancel it, and carry on. A visual
  //     glitch is recoverable; a frozen game is not.
  //   * a zero-length animation is never created at all. At --anim-scale 0 every
  //     beat therefore resolves on a microtask, which is what makes "instant"
  //     instant instead of one frame per beat.
  //
  // SKIP EQUALS PLAY. Each beat is split in two:
  //
  //   settle(ctx)  the DOM mutation that leaves the beat's finished state. Runs
  //                on BOTH the played path and the skipped path.
  //   motion(ctx)  the animation. Played path only.
  //
  // So skipping is simply "run every settle, run no motion", and the two paths
  // cannot drift. Anything a motion puts on the screen (a floating label, a
  // lifted peg, a scoring glow) is transient by construction and is tracked so
  // the end-of-drain sweep can guarantee it is gone either way.
  //
  // FAST-FORWARD IS A MODE, NOT AN EVENT. skip() arms it and only resume()
  // disarms it — emphatically NOT the queue happening to go empty. The engine
  // emits one event per advance() during the show and the controller awaits each
  // drain before issuing the next, so a hand's count arrives as a dozen separate
  // one-beat jobs. A skip that ended with the job in flight would fast-forward
  // exactly one of them and leave the player holding the key down through the
  // other eleven. Only the controller knows where the mode should end (the
  // moment a human decision is pending), so only the controller ends it.
  // ---------------------------------------------------------------------------

  // The durations in theme.css, in unscaled milliseconds. They are mirrored
  // rather than parsed one by one because --anim-scale is the only thing that
  // ever moves: read that, multiply, and the tokens and this file cannot drift
  // apart. Keep these in step with the --t-* block in theme.css.
  var BASE = {
    fast: 150,   // --t-fast
    base: 250,   // --t-base
    slow: 400,   // --t-slow
    flip: 300,   // --t-flip
    deal: 400,   // --t-deal
    pegHop: 35   // --t-peg-hop
  };

  var DEAL_STAGGER = 60;   // gap between consecutive cards leaving the deck
  var PEG_WALK_CAP = 1000; // a 29-hand must land near a second, not near two

  // theme.css's easing tokens, mirrored for the same reason as the durations.
  var EASE = 'cubic-bezier(0.22, 0.61, 0.36, 1)';
  var EASE_CARD = 'cubic-bezier(0.2, 0.9, 0.3, 1)';
  var EASE_PEG = 'cubic-bezier(0.34, 1.4, 0.64, 1)';

  function noop() {}

  function isFn(f) {
    return typeof f === 'function';
  }

  function r2(n) {
    return Math.round(n * 100) / 100;
  }

  function isThenable(v) {
    return !!v && isFn(v.then);
  }

  /**
   * create(view, opts) -> anim
   *
   *   view   the object Cribbage.Render.mount() returns.
   *   opts   doc          the document to build elements from. Defaults to the
   *                       global one; injectable so the suite can run headless.
   *          cards        the RenderCards module. Same reason.
   *          guardPad     ms added to every animation's watchdog. Default 250.
   *          guardFactor  multiplier on the expected duration. Default 3.
   *          interactive  build the human's dealt cards as buttons. Default true.
   *          warn         where the watchdog reports. Default console.warn.
   */
  function create(view, opts) {
    if (!view || !view.el) {
      throw new Error('Cribbage.Animate.create: expected a mounted view');
    }
    opts = opts || {};

    var doc = opts.doc || (typeof root.document !== 'undefined' ? root.document : null);
    var RC = opts.cards || (root.Cribbage && root.Cribbage.RenderCards);
    if (!RC) {
      throw new Error('Cribbage.Animate.create: render-cards.js must load first');
    }

    var warn = opts.warn || function (msg) {
      if (typeof console !== 'undefined' && console.warn) console.warn('[animate] ' + msg);
    };
    var guardPad = opts.guardPad === undefined ? 250 : opts.guardPad;
    var guardFactor = opts.guardFactor === undefined ? 3 : opts.guardFactor;
    var interactive = opts.interactive !== false;
    var me = view.me === 1 ? 1 : 0;
    var labels = view.labels || ['You', 'Opponent'];

    // ---------------------------------------------------------------- timing ---

    // The one knob. Read back out of the cascade wherever that is possible, so
    // the OS's prefers-reduced-motion floor in theme.css is honoured without
    // this file knowing the media query exists.
    var scale = 1;

    function readScale() {
      if (!isFn(root.getComputedStyle) || !view.el.app) return;
      try {
        var raw = root.getComputedStyle(view.el.app).getPropertyValue('--anim-scale');
        var n = parseFloat(raw);
        if (isFinite(n) && n >= 0) scale = n;
      } catch (err) {
        // A detached or styleless root is not a reason to stop animating.
      }
    }

    function ms(base) {
      var v = base * scale;
      return v > 0 ? v : 0;
    }

    // -------------------------------------------------- animations and waits ---

    var liveAnims = [];
    var sleepers = [];
    var skipping = false;

    function forget(a) {
      var i = liveAnims.indexOf(a);
      if (i !== -1) liveAnims.splice(i, 1);
    }

    // Below this, a duration is not a duration. Sub-millisecond motion is
    // invisible but still costs a frame to resolve, and prefers-reduced-motion
    // drives --anim-scale to 0.001 — which is the OS asking for no motion, not
    // for a quarter of a millisecond of it. Rounding it away is what makes the
    // reduced-motion path genuinely instant rather than merely imperceptible.
    var FLOOR = 1;

    // The single place an Animation is ever created. A zero-length animation is
    // deliberately NOT created: it would cost a frame to resolve, and 500 beats
    // of one wasted frame each is the difference between "instant" and five
    // seconds of staring at a finished game.
    function animateEl(elm, frames, options) {
      if (!elm || !isFn(elm.animate)) return null;
      // A motion already under way keeps creating animations as its chain
      // advances (the peg walk is a hop per hole). Refusing here is what stops a
      // beat that was mid-flight when the mode was armed from carrying on.
      if (skipping) return null;
      var d = options.duration || 0;
      var delay = options.delay || 0;
      if (d < FLOOR && delay < FLOOR) return null;
      var a;
      try {
        a = elm.animate(frames, options);
      } catch (err) {
        warn('animate() threw: ' + ((err && err.message) || err));
        return null;
      }
      if (!a) return null;
      liveAnims.push(a);
      return a;
    }

    function settled(a) {
      if (a.finished && isFn(a.finished.then)) {
        return a.finished.then(noop, noop);
      }
      // Pre-.finished implementations still fire the two events.
      return new Promise(function (resolve) {
        a.onfinish = resolve;
        a.oncancel = resolve;
      });
    }

    /**
     * guarded(anims, expectedMs) -> Promise that ALWAYS resolves.
     *
     * The watchdog is the reason this function exists. Anything can fail to
     * settle — a display:none ancestor, a detached node, a compositor stall —
     * and the queue has to keep moving regardless.
     */
    function guarded(anims, expectedMs) {
      var list = [];
      var i;
      for (i = 0; i < anims.length; i++) if (anims[i]) list.push(anims[i]);
      if (!list.length) return Promise.resolve();

      var limit = (expectedMs || 0) * guardFactor + guardPad;
      return new Promise(function (resolve) {
        var done = false;

        function finish() {
          if (done) return;
          done = true;
          clearTimeout(timer);
          for (var j = 0; j < list.length; j++) forget(list[j]);
          resolve();
        }

        var timer = setTimeout(function () {
          if (done) return;
          warn('an animation did not settle within ' + Math.round(limit) +
            'ms; cancelling it and continuing');
          for (var j = 0; j < list.length; j++) {
            try { list[j].cancel(); } catch (err) { /* already gone */ }
          }
          finish();
        }, limit);

        var waits = [];
        for (var k = 0; k < list.length; k++) waits.push(settled(list[k]));
        Promise.all(waits).then(finish, finish);
      });
    }

    // A hold between beats. Registered so skip() can release it instantly —
    // a bare setTimeout would make skip wait out every remaining pause.
    //
    // The FLOOR matters more here than anywhere: setTimeout has a clamp of its
    // own (4ms foregrounded, a full second in a background tab), so asking it
    // for a quarter of a millisecond does not buy a quarter of a millisecond.
    //
    // The skipping test is not belt and braces. A score beat's trailing hold is
    // created inside a .then, AFTER the announce and the peg walk have resolved,
    // so at the moment skip() ran it did not exist yet and draining `sleepers`
    // could not reach it. Refusing to create it is the only thing that can.
    function sleep(duration) {
      if (skipping || !(duration >= FLOOR)) return Promise.resolve();
      return new Promise(function (resolve) {
        var entry = { resolve: resolve, timer: 0 };
        entry.timer = setTimeout(function () {
          var i = sleepers.indexOf(entry);
          if (i !== -1) sleepers.splice(i, 1);
          resolve();
        }, duration);
        sleepers.push(entry);
      });
    }

    // -------------------------------------------------------------- geometry ---

    var measuring = true;

    function rectOf(elm) {
      if (!elm || !isFn(elm.getBoundingClientRect)) return null;
      var r;
      try {
        r = elm.getBoundingClientRect();
      } catch (err) {
        return null;
      }
      if (!r) return null;
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    }

    // Measurement is for motion only, so a skipped beat must not pay for a
    // forced layout it will never use.
    function mrect(elm) {
      return measuring ? rectOf(elm) : null;
    }

    // A card carries its own transform (the selection lift, the peg anchor on a
    // peg), and a keyframe on `transform` replaces it wholesale. Composing the
    // FLIP delta OUTSIDE the element's own matrix is what keeps a lifted card
    // lifted and a peg anchored while it travels.
    function ownTransform(elm) {
      if (!isFn(root.getComputedStyle) || !elm) return '';
      try {
        var t = root.getComputedStyle(elm).transform;
        return (!t || t === 'none') ? '' : ' ' + t;
      } catch (err) {
        return '';
      }
    }

    // FLIP: the caller has already moved the element, `before` is where it was.
    // Measured rather than faked with a clone, so it survives the layout changes
    // and the resizes that happen mid-hand.
    function flipFrom(elm, before, duration, easing, delay) {
      if (!elm || !before) return null;
      var after = rectOf(elm);
      if (!after) return null;
      var dx = before.left - after.left;
      var dy = before.top - after.top;
      var own = ownTransform(elm);
      var rest = own ? own.slice(1) : 'none';
      return animateEl(elm, [
        { transform: 'translate(' + r2(dx) + 'px, ' + r2(dy) + 'px)' + own },
        { transform: rest }
      ], {
        duration: duration,
        delay: delay || 0,
        easing: easing || EASE_CARD,
        // 'backwards' so a staggered card waits at the deck instead of sitting
        // in its final place for its whole delay and then twitching.
        fill: 'backwards'
      });
    }

    // The 3D turn. The class is already on the card (settle ran first), so the
    // animation runs from the old face to the new one and then hands back to
    // the cascade, which already agrees with where it landed.
    function turnOver(cardEl, fromDeg, duration, delay) {
      if (!cardEl || !isFn(cardEl.querySelector)) return null;
      var inner = cardEl.querySelector('.card__inner');
      if (!inner) return null;
      var to = fromDeg === 0 ? 180 : 0;
      return animateEl(inner, [
        { transform: 'rotateY(' + fromDeg + 'deg)' },
        { transform: 'rotateY(' + to + 'deg)' }
      ], {
        duration: duration,
        delay: delay || 0,
        easing: EASE_CARD,
        fill: 'backwards'
      });
    }

    // --------------------------------------------------------- transient state ---

    // Everything a motion puts on screen is listed here, so the end-of-drain
    // sweep can guarantee the played path and the skipped path finish with the
    // same DOM even if a beat threw halfway through.
    var floats = [];
    var lifted = [];
    var glowing = [];

    function glow(node, on) {
      if (!node) return;
      RC.setHighlighted(node, on);
      var i = glowing.indexOf(node);
      if (on && i === -1) glowing.push(node);
      else if (!on && i !== -1) glowing.splice(i, 1);
    }

    function lift(peg, on) {
      if (!peg || !isFn(peg.setAttribute)) return;
      var i = lifted.indexOf(peg);
      if (on) {
        peg.setAttribute('data-lifted', 'true');
        if (i === -1) lifted.push(peg);
      } else {
        if (isFn(peg.removeAttribute)) peg.removeAttribute('data-lifted');
        else peg.setAttribute('data-lifted', 'false');
        if (i !== -1) lifted.splice(i, 1);
      }
    }

    function dropFloat(box) {
      if (!box) return;
      var i = floats.indexOf(box);
      if (i !== -1) floats.splice(i, 1);
      if (box.parentNode && isFn(box.parentNode.removeChild)) {
        box.parentNode.removeChild(box);
      }
    }

    function sweep() {
      while (floats.length) dropFloat(floats[floats.length - 1]);
      while (lifted.length) lift(lifted[lifted.length - 1], false);
      while (glowing.length) glow(glowing[glowing.length - 1], false);
    }

    // A label that rises off the table and fades. Built here rather than in
    // layout.css because this module owns no stylesheet — but every value below
    // is a theme token, so it still cannot invent a colour or a radius.
    function floatLabel(text, points, anchorEl) {
      if (!doc || !isFn(doc.createElement)) return null;
      var host = view.el.table;
      if (!host || !isFn(host.appendChild)) return null;
      if (skipping) return null;                // fast-forward: no label to read
      if (ms(BASE.slow) < FLOOR) return null;   // nothing to see at zero speed

      var box = doc.createElement('div');
      box.className = 'anim-float';
      box.setAttribute('aria-hidden', 'true');   // the status line is the live region
      var css = box.style;
      css.position = 'absolute';
      css.zIndex = 'var(--z-label)';
      css.pointerEvents = 'none';
      css.display = 'flex';
      css.alignItems = 'baseline';
      css.gap = 'var(--sp-2)';
      css.padding = 'var(--sp-1) var(--sp-3)';
      css.borderRadius = 'var(--radius)';
      css.border = '1px solid var(--glow-soft)';
      css.background = 'var(--felt-edge)';
      css.boxShadow = 'var(--shadow-panel)';
      css.color = 'var(--on-felt)';
      css.fontFamily = 'var(--font-sans)';
      css.fontSize = '0.95rem';
      css.fontWeight = '600';
      css.whiteSpace = 'nowrap';

      var name = doc.createElement('span');
      name.textContent = text;
      box.appendChild(name);
      if (points) {
        var pts = doc.createElement('span');
        pts.textContent = '+' + points;
        pts.style.color = 'var(--glow)';
        pts.style.fontFamily = 'var(--font-num)';
        pts.style.fontSize = '1.1rem';
        box.appendChild(pts);
      }

      var hostRect = rectOf(host);
      var anchorRect = anchorEl ? rectOf(anchorEl) : null;
      if (hostRect && anchorRect) {
        css.left = r2(anchorRect.left - hostRect.left + anchorRect.width / 2) + 'px';
        css.top = r2(anchorRect.top - hostRect.top + anchorRect.height / 2) + 'px';
      } else {
        css.left = '50%';
        css.top = '40%';
      }

      host.appendChild(box);
      floats.push(box);
      return box;
    }

    function floatMotion(box, life) {
      if (!box) return null;
      return animateEl(box, [
        { opacity: '0', transform: 'translate(-50%, 10px) scale(0.94)' },
        { opacity: '1', transform: 'translate(-50%, -6px) scale(1)', offset: 0.2 },
        { opacity: '1', transform: 'translate(-50%, -16px) scale(1)', offset: 0.72 },
        { opacity: '0', transform: 'translate(-50%, -30px) scale(0.98)' }
      ], { duration: life, easing: EASE, fill: 'both' });
    }

    function announce(text, points, anchorEl) {
      var life = ms(BASE.slow) * 2;
      var box = floatLabel(text, points, anchorEl);
      if (!box) return Promise.resolve();
      return guarded([floatMotion(box, life)], life).then(function () {
        dropFloat(box);
      });
    }

    // ----------------------------------------------------------- DOM plumbing ---

    function clearChildren(node) {
      if (!node || !node.children) return;
      while (node.children.length) {
        node.removeChild(node.children[node.children.length - 1]);
      }
    }

    // An empty slot keeps its footprint as a .well; a card arriving has to
    // displace it, exactly as render.js's syncRow would.
    function removeWells(node) {
      if (!node || !node.children) return;
      for (var i = node.children.length - 1; i >= 0; i--) {
        var kid = node.children[i];
        var cls = kid.className || '';
        if (typeof cls === 'string' && cls.indexOf('well') !== -1) node.removeChild(kid);
      }
    }

    // The last n card elements in a player's hand. render.js keys the opponent's
    // backs 'back0'..'backN-1', so its syncRow drops the LAST ones too — taking
    // from the same end is what keeps the two agreeing about which back left.
    function lastCards(player, n) {
      var all = isFn(view.handCards) ? view.handCards(player) : [];
      return all.slice(Math.max(0, all.length - n));
    }

    function nodesFor(cards) {
      var out = [];
      if (!cards || !isFn(view.findCard)) return out;
      for (var i = 0; i < cards.length; i++) {
        var c = cards[i];
        var node = view.findCard(c && c.id !== undefined ? c.id : c);
        if (node && out.indexOf(node) === -1) out.push(node);
      }
      return out;
    }

    // Mirrors render.js's li.pile__item exactly, so the card the animator lays
    // down and the card renderState repaints are the same object to the eye.
    function pileItem(player, cardEl, seriesStart) {
      var item = doc.createElement('li');
      item.className = 'pile__item';
      item.setAttribute('data-player', String(player));
      item.setAttribute('data-side', player === me ? 'mine' : 'theirs');
      item.setAttribute('data-peg', player === 0 ? 'brass' : 'pewter');
      item.setAttribute('data-spent', 'false');
      item.setAttribute('data-series-start', seriesStart ? 'true' : 'false');
      var owner = doc.createElement('span');
      owner.className = 'pile__owner';
      owner.setAttribute('aria-hidden', 'true');
      item.appendChild(cardEl);
      item.appendChild(owner);
      return item;
    }

    function setCount(n, visible) {
      var count = view.el.count;
      if (count) {
        count.setAttribute('data-count', String(n));
        count.setAttribute('data-full', n === 31 ? 'true' : 'false');
        count.hidden = !visible;
      }
      if (view.el.countNum) view.el.countNum.textContent = String(n);
    }

    function seatOf(player) {
      return view.el.seats ? view.el.seats[player] : null;
    }

    function nameOf(player) {
      return player === me ? 'You' : labels[player];
    }

    function possessive(player) {
      return player === me ? 'Your' : labels[player] + "'s";
    }

    // ------------------------------------------------------------ peg tracking ---

    // Where this module believes each player's two pegs are standing. It mirrors
    // render-board's own rule, including the one at the start of a game where
    // both pegs are home and take the two start holes rather than stacking.
    var walk = [{ rear: -1, front: 0 }, { rear: -1, front: 0 }];
    var seriesLen = 0;

    function syncFrom(state) {
      if (!state) return;
      for (var p = 0; p < 2; p++) {
        var lo = state.prevScores ? state.prevScores[p] : 0;
        var hi = state.scores ? state.scores[p] : 0;
        if (hi < lo) { var t = lo; lo = hi; hi = t; }
        if (lo === 0 && hi === 0) lo = -1;
        walk[p] = { rear: lo, front: hi };
      }
      seriesLen = (state.play && state.play.series) ? state.play.series.length : 0;
    }

    // One hop of the walk. The peg's coordinates come from holePosition(), which
    // render-board deliberately keeps unprojected, so this is honest arithmetic
    // in the board's own space and needs no getBoundingClientRect at all.
    function hopTo(peg, own, from, to, duration, easing) {
      peg.style.left = r2(to.x) + 'px';
      peg.style.top = r2(to.y) + 'px';
      var rest = own ? own.slice(1) : 'none';
      return animateEl(peg, [
        { transform: 'translate(' + r2(from.x - to.x) + 'px, ' +
          r2(from.y - to.y) + 'px)' + own },
        { transform: rest }
      ], { duration: duration, easing: easing, fill: 'backwards' });
    }

    /**
     * The peg walk. The REAR peg travels — it leapfrogs its partner and becomes
     * the new front — so the gap left behind is the score just taken, which is
     * the whole charm of a real board.
     *
     * It is carried to the front peg's hole first and then counted forward hole
     * by hole from there, because that is what a player's hand does. Total time
     * is capped so a 29-hand lands near a second instead of grinding.
     */
    function walkPeg(ctx) {
      var board = view.board;
      var peg = ctx.peg;
      if (!peg || !peg.style || !board || !isFn(board.holePosition)) {
        return Promise.resolve();
      }

      var hops = ctx.endHole - ctx.viaHole;
      var hopMs = ms(BASE.pegHop);
      var cap = ms(PEG_WALK_CAP);
      if (hops > 0 && hopMs * hops > cap) hopMs = cap / hops;
      var carryMs = ms(BASE.fast);

      function place(hole) {
        var t = board.holePosition(ctx.player, hole);
        peg.style.left = r2(t.x) + 'px';
        peg.style.top = r2(t.y) + 'px';
        return t;
      }

      // At zero speed the peg is simply already there; settle() put it there and
      // there is nothing to walk.
      if (hopMs < FLOOR && carryMs < FLOOR) {
        place(ctx.endHole);
        return Promise.resolve();
      }

      var own = ownTransform(peg);
      lift(peg, true);
      // Synchronous, before any await: settle() left the peg on its final hole
      // and it must be back at its start before the browser gets a chance to
      // paint, or the walk begins with a jump.
      var pos = place(ctx.startHole);

      var chain = Promise.resolve();
      if (ctx.startHole !== ctx.viaHole) {
        chain = chain.then(function () {
          if (skipping) return null;
          var to = place(ctx.viaHole);
          var a = hopTo(peg, own, pos, to, carryMs, EASE);
          pos = to;
          return guarded([a], carryMs);
        });
      }

      function step(hole) {
        return function () {
          if (skipping) return null;
          var to = place(hole);
          var a = hopTo(peg, own, pos, to, hopMs, EASE_PEG);
          pos = to;
          return guarded([a], hopMs);
        };
      }
      for (var n = ctx.viaHole + 1; n <= ctx.endHole; n++) chain = chain.then(step(n));

      function land() {
        place(ctx.endHole);
        lift(peg, false);
      }
      return chain.then(land, land);
    }

    // ------------------------------------------------------------------ beats ---
    // Each entry below turns one engine event into one visible moment.

    var MAKERS = {};

    MAKERS.cutForDeal = function (beats, ev) {
      var text;
      if (ev.dealer === null) text = 'A tie — cut again.';
      else text = nameOf(ev.dealer) + ' cut low and deal' + (ev.dealer === me ? '.' : 's.');
      beats.push({
        kind: 'cutForDeal',
        label: text,
        event: ev,
        settle: noop,
        motion: function () {
          return announce(text, 0, view.el.table).then(function () {
            return sleep(ms(BASE.fast));
          });
        }
      });
    };

    MAKERS.deal = function (beats, ev) {
      beats.push({
        kind: 'deal',
        label: possessive(ev.dealer) + ' deal — six cards each.',
        event: ev,
        before: function () {
          // The deck's own rect, not the slot's: the cards have to leave from
          // where the stock is actually drawn.
          return { origin: mrect(view.el.deck), nodes: [] };
        },
        settle: function (ctx) {
          seriesLen = 0;
          clearChildren(view.el.hands[0]);
          clearChildren(view.el.hands[1]);
          // One at a time, alternating, starting with the non-dealer — the same
          // order the engine dealt them in, so the two agree beat for beat.
          var lead = 1 - ev.dealer;
          var taken = [0, 0];
          for (var i = 0; i < 12; i++) {
            var p = (i % 2 === 0) ? lead : ev.dealer;
            var card = ev.hands[p][taken[p]++];
            if (!card) continue;
            var node = (p === me)
              ? RC.createCard(card, { interactive: interactive })
              : RC.createBack();
            view.el.hands[p].appendChild(node);
            ctx.nodes.push(node);
          }
        },
        motion: function (ctx) {
          var d = ms(BASE.deal);
          var stagger = ms(DEAL_STAGGER);
          var anims = [];
          for (var i = 0; i < ctx.nodes.length; i++) {
            anims.push(flipFrom(ctx.nodes[i], ctx.origin, d, EASE_CARD, i * stagger));
          }
          return guarded(anims, d + stagger * ctx.nodes.length);
        }
      });
    };

    MAKERS.discard = function (beats, ev) {
      beats.push({
        kind: 'discard',
        label: (ev.player === me ? 'You lay away two.' : labels[ev.player] + ' lays away two.'),
        event: ev,
        before: function () {
          var nodes;
          if (ev.player === me) {
            nodes = nodesFor(ev.cards);
          } else {
            // The opponent's hand is anonymous backs with no identity in the
            // DOM, which is the point — so any two of them will do.
            nodes = lastCards(ev.player, 2);
          }
          var rects = [];
          for (var i = 0; i < nodes.length; i++) rects.push(mrect(nodes[i]));
          return { nodes: nodes, rects: rects };
        },
        settle: function (ctx) {
          removeWells(view.el.crib);
          for (var i = 0; i < ctx.nodes.length; i++) {
            var node = ctx.nodes[i];
            if (!node) continue;
            RC.setSelected(node, false);
            RC.setDisabled(node, false);
            glow(node, false);
            RC.setFaceDown(node, true);
            view.el.crib.appendChild(node);
          }
        },
        motion: function (ctx) {
          var d = ms(BASE.slow);
          var anims = [];
          for (var i = 0; i < ctx.nodes.length; i++) {
            anims.push(flipFrom(ctx.nodes[i], ctx.rects[i], d, EASE_CARD, i * ms(80)));
            anims.push(turnOver(ctx.nodes[i], 0, ms(BASE.flip), i * ms(80)));
          }
          return guarded(anims, d + ms(80));
        }
      });
    };

    MAKERS.starter = function (beats, ev) {
      beats.push({
        kind: 'starter',
        label: 'The cut.',
        event: ev,
        before: function () {
          return { origin: mrect(view.el.deck), node: null };
        },
        settle: function (ctx) {
          clearChildren(view.el.starter);
          var node = RC.createCard(ev.card, {});
          RC.setFaceDown(node, false);
          view.el.starter.appendChild(node);
          ctx.node = node;
        },
        motion: function (ctx) {
          var travel = ms(BASE.slow);
          var flip = ms(BASE.flip);
          // It leaves the deck first and turns over on the way, so the cut reads
          // as one gesture rather than a move followed by a flip.
          return guarded([
            flipFrom(ctx.node, ctx.origin, travel, EASE_CARD, 0),
            turnOver(ctx.node, 180, flip, travel * 0.35)
          ], travel + flip);
        }
      });
    };

    MAKERS.play = function (beats, ev) {
      beats.push({
        kind: 'play',
        label: (ev.player === me ? 'You play ' : labels[ev.player] + ' plays ') +
          cardName(ev.card) + ' — ' + ev.count + '.',
        event: ev,
        before: function () {
          var source = ev.player === me
            ? (isFn(view.findCard) ? view.findCard(ev.card.id) : null)
            : lastCards(ev.player, 1)[0];
          return { source: source, rect: mrect(source), node: null };
        },
        settle: function (ctx) {
          if (ctx.source && ctx.source.parentNode) {
            ctx.source.parentNode.removeChild(ctx.source);
          }
          // A fresh, static element rather than the hand's button: a card on the
          // table is not a control, and render.js builds the pile the same way.
          var node = RC.createCard(ev.card, {});
          RC.setFaceDown(node, false);
          ctx.node = node;
          view.el.pile.appendChild(pileItem(ev.player, node, seriesLen === 0));
          seriesLen++;
          if (view.el.pileEmpty) view.el.pileEmpty.hidden = true;
          setCount(ev.count, true);
        },
        motion: function (ctx) {
          var d = ms(BASE.base);
          var anims = [flipFrom(ctx.node, ctx.rect, d, EASE_CARD, 0)];
          var count = view.el.count;
          if (count) {
            anims.push(animateEl(count, [
              { transform: 'scale(1)' },
              { transform: 'scale(1.12)', offset: 0.4 },
              { transform: 'scale(1)' }
            ], { duration: ms(BASE.fast), easing: EASE, fill: 'none' }));
          }
          return guarded(anims, d);
        }
      });
    };

    MAKERS.go = function (beats, ev) {
      beats.push({
        kind: 'go',
        label: (ev.player === me ? 'You say go.' : labels[ev.player] + ' says go.'),
        event: ev,
        // A go leaves no trace on the table, so there is nothing to settle and
        // a skipped go is correctly invisible.
        settle: noop,
        motion: function () {
          return announce('Go', 0, seatOf(ev.player));
        }
      });
    };

    MAKERS.seriesReset = function (beats, ev) {
      beats.push({
        kind: 'seriesReset',
        label: 'The count resets.',
        event: ev,
        before: function () {
          var items = [];
          var rects = [];
          var pile = view.el.pile;
          if (pile && pile.children) {
            for (var i = 0; i < pile.children.length; i++) {
              var item = pile.children[i];
              if (item.getAttribute && item.getAttribute('data-spent') === 'false') {
                items.push(item);
                rects.push(mrect(item));
              }
            }
          }
          return { items: items, rects: rects };
        },
        settle: function (ctx) {
          var pile = view.el.pile;
          if (pile && pile.children) {
            for (var i = 0; i < pile.children.length; i++) {
              var item = pile.children[i];
              if (!item.setAttribute) continue;
              item.setAttribute('data-spent', 'true');
              item.setAttribute('data-series-start', 'false');
            }
          }
          seriesLen = 0;
          setCount(0, true);
        },
        motion: function (ctx) {
          var d = ms(BASE.base);
          var anims = [];
          for (var i = 0; i < ctx.items.length; i++) {
            // Knocked back rather than faded: a translucent card lets the felt
            // through and stops reading as paper.
            anims.push(animateEl(ctx.items[i], [
              { transform: 'translateY(0) scale(1)' },
              { transform: 'translateY(6px) scale(0.965)', offset: 0.45 },
              { transform: 'translateY(0) scale(1)' }
            ], { duration: d, easing: EASE, fill: 'none' }));
          }
          var count = view.el.count;
          if (count) {
            anims.push(animateEl(count, [
              { opacity: '0.35' },
              { opacity: '1' }
            ], { duration: ms(BASE.fast), easing: EASE, fill: 'none' }));
          }
          return guarded(anims, d);
        }
      });
    };

    // The key beat. Three things at once — the cards light up, the label floats,
    // the peg walks — and then a hold, because a score the eye has not landed on
    // has not been scored.
    MAKERS.score = function (beats, ev) {
      beats.push({
        kind: 'score',
        label: possessive(ev.player) + ' ' + ev.reason.toLowerCase() + ' — ' +
          ev.points + '.',
        event: ev,
        before: function () {
          var p = ev.player;
          var board = view.board;
          return {
            player: p,
            peg: (board && isFn(board.pegElement)) ? board.pegElement(p, 'rear') : null,
            startHole: walk[p].rear,
            viaHole: walk[p].front,
            endHole: ev.total,
            nodes: nodesFor(ev.cards),
            anchor: seatOf(p)
          };
        },
        settle: function (ctx) {
          // The board's own leapfrog: hand it the two holes and it works out
          // which physical peg is which, which is what keeps each DOM peg
          // welded to the peg it represents.
          if (view.board && isFn(view.board.setPegs)) {
            view.board.setPegs(ctx.player, ctx.viaHole, ctx.endHole);
          }
          walk[ctx.player] = { rear: ctx.viaHole, front: ctx.endHole };
          if (view.el.scores && view.el.scores[ctx.player]) {
            view.el.scores[ctx.player].textContent = String(ctx.endHole);
          }
        },
        motion: function (ctx) {
          var i;
          for (i = 0; i < ctx.nodes.length; i++) glow(ctx.nodes[i], true);
          return Promise.all([
            announce(ev.reason, ev.points, ctx.anchor),
            walkPeg(ctx)
          ]).then(function () {
            return sleep(ms(BASE.base));
          }).then(function () {
            for (var j = 0; j < ctx.nodes.length; j++) glow(ctx.nodes[j], false);
          });
        }
      });
    };

    MAKERS.showStart = function (beats, ev) {
      var what = ev.source === 'crib' ? 'crib' : 'hand';
      beats.push({
        kind: 'showStart',
        label: 'Counting ' + possessive(ev.player).toLowerCase() + ' ' + what + '.',
        event: ev,
        before: function () {
          // Each card flies back from wherever it lay in the pile, which is what
          // gathering a hand for the count actually looks like.
          var fallback = ev.source === 'crib' ? view.el.crib : view.el.pile;
          var origins = [];
          for (var i = 0; i < ev.cards.length; i++) {
            var was = isFn(view.findCard) ? view.findCard(ev.cards[i].id) : null;
            origins.push(mrect(was) || mrect(fallback));
          }
          return { origins: origins, nodes: [] };
        },
        settle: function (ctx) {
          // The pile is gathered back in for the count, exactly as at a table.
          clearChildren(view.el.pile);
          seriesLen = 0;
          if (view.el.pileEmpty) view.el.pileEmpty.hidden = true;
          setCount(0, false);

          var target = ev.source === 'crib' ? view.el.crib : view.el.hands[ev.player];
          clearChildren(target);
          for (var i = 0; i < ev.cards.length; i++) {
            var node = RC.createCard(ev.cards[i], {});
            RC.setFaceDown(node, false);
            target.appendChild(node);
            ctx.nodes.push(node);
          }
        },
        motion: function (ctx) {
          var d = ms(BASE.slow);
          var stagger = ms(70);
          var anims = [];
          for (var i = 0; i < ctx.nodes.length; i++) {
            anims.push(flipFrom(ctx.nodes[i], ctx.origins[i], d, EASE_CARD, i * stagger));
            anims.push(turnOver(ctx.nodes[i], 180, ms(BASE.flip), i * stagger));
          }
          return Promise.all([
            announce(possessive(ev.player) + ' ' + what, 0, seatOf(ev.player)),
            guarded(anims, d + stagger * ctx.nodes.length)
          ]);
        }
      });
    };

    MAKERS.handEnd = function (beats, ev) {
      beats.push({
        kind: 'handEnd',
        label: 'Hand over.',
        event: ev,
        settle: function () {
          seriesLen = 0;
        },
        motion: function () {
          return sleep(ms(BASE.base));
        }
      });
    };

    MAKERS.gameOver = function (beats, ev) {
      var margin = ev.scores[ev.winner] + '–' + ev.scores[1 - ev.winner];
      var tail = ev.skunk === 'double' ? ' A double skunk.'
        : (ev.skunk === 'skunk' ? ' A skunk.' : '');
      beats.push({
        kind: 'gameOver',
        label: (ev.winner === me ? 'You win, ' : labels[ev.winner] + ' wins, ') +
          margin + '.' + tail,
        event: ev,
        settle: noop,
        motion: function () {
          // Restrained on purpose: the winning peg has already landed home on
          // the score beat before this one, so all that is left is to say so and
          // let the peg settle. Confetti would be somebody else's game.
          var board = view.board;
          var peg = (board && isFn(board.pegElement)) ? board.pegElement(ev.winner, 'front') : null;
          var anims = [];
          if (peg) {
            var own = ownTransform(peg);
            var rest = own ? own.slice(1) : 'none';
            anims.push(animateEl(peg, [
              { transform: rest },
              { transform: 'translateY(-5px)' + own, offset: 0.35 },
              { transform: rest }
            ], { duration: ms(BASE.slow), easing: EASE_PEG, fill: 'none' }));
          }
          return Promise.all([
            announce((ev.winner === me ? 'You win' : labels[ev.winner] + ' wins') +
              ' ' + margin, 0, seatOf(ev.winner)),
            guarded(anims, ms(BASE.slow))
          ]).then(function () {
            return sleep(ms(BASE.base));
          });
        }
      });
    };

    // phase, cribComplete: real transitions, but nothing moves on the table for
    // them. Deliberately no beat rather than an empty one that costs a tick.

    var RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    var SUITS = ['spades', 'hearts', 'diamonds', 'clubs'];

    function cardName(card) {
      if (!card) return 'a card';
      var r = RANKS[card.rank - 1] || String(card.rank);
      var s = typeof card.suit === 'number' ? SUITS[card.suit] : String(card.suit);
      return 'the ' + r + ' of ' + s;
    }

    function buildBeats(events) {
      var beats = [];
      for (var i = 0; i < events.length; i++) {
        var ev = events[i];
        if (!ev || !ev.type) continue;
        var make = MAKERS[ev.type];
        if (make) make(beats, ev);
        // Nothing is ever queued after the game ends. The engine will not emit
        // anything either, but a beat that outlives the result is the kind of
        // thing that shows up once in a thousand games and looks like a bug.
        if (ev.type === 'gameOver') break;
      }
      return beats;
    }

    // ------------------------------------------------------------- the queue ---

    var queue = [];
    var draining = false;
    var listeners = [];
    var destroyed = false;

    function emitBeat(beat, index, total) {
      if (!listeners.length) return;
      var payload = {
        kind: beat.kind,
        label: beat.label || '',
        event: beat.event || null,
        index: index,
        total: total,
        skipped: skipping
      };
      for (var i = 0; i < listeners.length; i++) {
        try {
          listeners[i](payload);
        } catch (err) {
          warn('an onBeat listener threw: ' + ((err && err.message) || err));
        }
      }
    }

    // ALWAYS resolves. A beat that throws is reported and stepped over; the one
    // thing that must not happen is the queue stopping.
    function runBeat(beat, index, total) {
      var instant = skipping;
      var ctx = null;
      try {
        measuring = !instant;
        ctx = beat.before ? beat.before() : null;
      } catch (err) {
        warn('beat "' + beat.kind + '" failed to measure: ' + ((err && err.message) || err));
      } finally {
        measuring = true;
      }
      try {
        if (beat.settle) beat.settle(ctx);
      } catch (err) {
        warn('beat "' + beat.kind + '" failed to settle: ' + ((err && err.message) || err));
      }
      emitBeat(beat, index, total);
      if (instant || !beat.motion) return Promise.resolve();
      var result;
      try {
        result = beat.motion(ctx);
      } catch (err) {
        warn('beat "' + beat.kind + '" threw: ' + ((err && err.message) || err));
        return Promise.resolve();
      }
      if (!isThenable(result)) return Promise.resolve();
      return result.then(noop, function (err) {
        warn('beat "' + beat.kind + '" rejected: ' + ((err && err.message) || err));
      });
    }

    function runJob(job) {
      var i = 0;
      var total = job.beats.length;
      function next() {
        if (i >= total) return finishJob(job);
        var beat = job.beats[i];
        i++;
        return runBeat(beat, i, total).then(next);
      }
      return next();
    }

    // The snapshot wins. Whatever the beats did or did not manage, the DOM is
    // repainted from the authoritative state — which is also what makes a
    // skipped drain and a played drain land on the same pixels.
    function finishJob(job) {
      sweep();
      if (job.state && isFn(view.renderState)) {
        try {
          view.renderState(job.state, job.hints || null);
        } catch (err) {
          warn('renderState threw: ' + ((err && err.message) || err));
        }
      }
      syncFrom(job.state);
      return Promise.resolve();
    }

    function drain() {
      readScale();
      function step() {
        if (!queue.length) {
          draining = false;
          // `skipping` deliberately survives. The queue emptying is not the
          // player changing their mind — during a count it empties between
          // every single beat. See the header: only resume() disarms the mode.
          return Promise.resolve();
        }
        var job = queue[0];
        return runJob(job).then(function () {
          queue.shift();
          job.resolve();
          return step();
        }, function (err) {
          // Belt and braces. runJob is already total, so this can only fire if
          // something outside a beat broke, and even then the queue moves on.
          warn('a job failed: ' + ((err && err.message) || err));
          queue.shift();
          job.resolve();
          return step();
        });
      }
      return step();
    }

    // -------------------------------------------------------------- public API ---

    /**
     * play(events, state) -> Promise
     *
     * Resolves once the last beat of THIS call has finished and the snapshot has
     * been painted. Calls made during a drain are appended: beats never
     * interleave and never overtake.
     */
    function play(events, state, hints) {
      if (destroyed) return Promise.resolve();
      var job = {
        beats: buildBeats(events || []),
        state: state || null,
        hints: hints || null,
        resolve: noop
      };
      var promise = new Promise(function (resolve) { job.resolve = resolve; });
      queue.push(job);
      if (!draining) {
        // isBusy() has to be true the moment play() returns, but the first beat
        // deliberately waits a microtask: a controller that does play(); skip();
        // must skip the whole thing, not everything bar the beat that had
        // already started because drain() ran inside the call.
        draining = true;
        Promise.resolve().then(drain);
      }
      return promise;
    }

    /**
     * skip() — arm fast-forward.
     *
     * Cancels what is in flight, releases every pending hold, and drains the
     * rest of the queue settle-only. The DOM lands exactly where playing it out
     * would have left it, because settle() is the only thing that ever writes a
     * lasting change.
     *
     * It STAYS armed until resume(). There is deliberately no `if (!draining)
     * return` guard: the press that matters most lands between two of the
     * controller's one-beat jobs, or during the opponent's think pause, and in
     * both of those the queue is momentarily empty. Dropping the press there is
     * indistinguishable from a dead button.
     */
    function skip() {
      skipping = true;
      var i;
      var anims = liveAnims.slice();
      liveAnims.length = 0;
      for (i = 0; i < anims.length; i++) {
        try { anims[i].cancel(); } catch (err) { /* already finished */ }
      }
      var waiting = sleepers.slice();
      sleepers.length = 0;
      for (i = 0; i < waiting.length; i++) {
        clearTimeout(waiting[i].timer);
        waiting[i].resolve();
      }
    }

    /**
     * resume() — disarm fast-forward, so the next job animates again.
     *
     * The controller calls this the moment a human decision is pending: "skip"
     * means "stop making me wait", and once it is the player's turn nobody is
     * being made to wait. It reaches that point only after a drain has resolved,
     * so in practice the queue is empty here. Called mid-drain it would simply
     * let the REMAINING beats animate again; a beat already stepped over is
     * stepped over, because settle() has run and there is nothing to rewind.
     */
    function resume() {
      skipping = false;
    }

    function isBusy() {
      return draining;
    }

    function isSkipping() {
      return skipping;
    }

    /**
     * setSpeed(scale) — writes --anim-scale. 0 is instant.
     *
     * It goes on the DOCUMENT ROOT, not on the view. theme.css declares
     *   --t-base: calc(250ms * var(--anim-scale))
     * on :root, and a custom property that references another one resolves
     * against the element it was DECLARED on — so an override further down the
     * tree changes what this file reads back and nothing else. Writing it on the
     * app element as well keeps a view mounted outside a document honest, and
     * costs nothing.
     *
     * Note for the controller: create() never writes it, so the reduced-motion
     * floor in theme.css holds until something explicitly asks for a speed.
     */
    function setSpeed(value) {
      var n = Number(value);
      if (!isFinite(n) || n < 0) n = 1;
      if (n > 4) n = 4;
      scale = n;
      var docRoot = doc && doc.documentElement;
      if (docRoot && docRoot.style && isFn(docRoot.style.setProperty)) {
        docRoot.style.setProperty('--anim-scale', String(n));
      }
      if (view.el.app && view.el.app.style && isFn(view.el.app.style.setProperty)) {
        view.el.app.style.setProperty('--anim-scale', String(n));
      }
      return n;
    }

    /** onBeat(fn) -> unsubscribe. Fires once per beat, before its motion. */
    function onBeat(fn) {
      if (!isFn(fn)) return noop;
      listeners.push(fn);
      return function () {
        var i = listeners.indexOf(fn);
        if (i !== -1) listeners.splice(i, 1);
      };
    }

    function destroy() {
      destroyed = true;
      skip();
      var pending = queue.slice();
      queue.length = 0;
      for (var i = 0; i < pending.length; i++) pending[i].resolve();
      sweep();
      listeners.length = 0;
      draining = false;
    }

    // If the view has already painted a snapshot, start from where it is rather
    // than from a fictional 0–0 with both pegs home.
    syncFrom(view.state);
    readScale();

    return {
      play: play,
      skip: skip,
      resume: resume,
      isBusy: isBusy,
      isSkipping: isSkipping,
      setSpeed: setSpeed,
      onBeat: onBeat,
      destroy: destroy,
      // Exposed for the suite and for anyone debugging a stall. Not part of the
      // contract the controller should lean on.
      _internals: {
        buildBeats: buildBeats,
        walk: walk,
        speed: function () { return scale; }
      }
    };
  }

  root.Cribbage = root.Cribbage || {};
  root.Cribbage.Animate = { create: create, BASE: BASE };
})(typeof window !== 'undefined' ? window : globalThis);
