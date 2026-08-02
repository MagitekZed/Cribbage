(function (root) {
  'use strict';

  // The cribbage board: a vertical serpentine rail. Three straightaways joined by
  // two 180-degree turns, travelled bottom-right -> top, top -> bottom down the
  // middle, bottom -> top on the left, with the game hole at the top of the last
  // lane. Each leg carries 40 holes (121 = 40 + 40 + 40 + the game hole).
  //
  // Holes are placed by WALKING an SVG centreline with getPointAtLength() rather
  // than by arithmetic. Arithmetic placement bunches holes on the turns; walking
  // the path keeps the arc-length step constant so the spacing stays even the
  // whole way round. Both players' holes come from the SAME walk, offset along the
  // path normal, so hole n is radially aligned across the two tracks — which is
  // exactly how the two rows are drilled on a real board.
  //
  // This module owns geometry and structure only. It deliberately sets no
  // transitions: the animation layer owns motion, and all it needs from us is
  // that moving a peg is a matter of setting left/top from holePosition().

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var seq = 0;

  // Fallbacks used only if theme.css somehow has not loaded; keeps the board from
  // collapsing to zero rather than silently drawing nothing.
  var FALLBACK = { hole: 8, gapIn: 12, gapOut: 19.2, pegW: 10, pegH: 21 };

  function el(tag, cls) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
  }

  function svgNode(tag) {
    return document.createElementNS(SVG_NS, tag);
  }

  function r2(n) {
    return Math.round(n * 100) / 100;
  }

  function clamp(n, lo, hi) {
    return n < lo ? lo : (n > hi ? hi : n);
  }

  // Deterministic so the plank looks the same every reload — a board whose grain
  // reshuffles on resize stops reading as a physical object.
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a += 0x6d2b79f5;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Real grain is not evenly spaced: it runs in tight dark bands with open
  // figure between them. A tiled pattern gives away its period at this width,
  // so the rays are laid out individually across the actual plank.
  function grainRays(width, height, seed) {
    var rnd = rng(seed);
    var out = [];
    var x = -18;
    var limit = width + 18;
    while (x < limit) {
      var w = 0.35 + rnd() * rnd() * 3.4;
      var cls = rnd() < 0.42 ? 'cb-grain-a' : 'cb-grain-b';
      var op = r2(0.16 + rnd() * 0.52);
      out.push('<rect class="' + cls + '" x="' + r2(x) + '" y="-40" width="' +
        r2(w) + '" height="' + r2(height + 80) + '" opacity="' + op + '"/>');
      // A third of the time the next ray crowds up against this one; otherwise
      // the gap opens right out. That contrast is what reads as wood.
      x += w + (rnd() < 0.34 ? (0.5 + rnd() * 1.7) : (2.2 + rnd() * rnd() * 15));
    }
    return out.join('');
  }

  // -------------------------------------------------------------- the walk ---

  // A group boundary sits before every hole where (n - 1) is a multiple of five.
  // That single rule covers all three cases: the start hole is set apart from
  // hole 1, every group of five is set apart from the next, and the game hole is
  // set apart from hole 120.
  function gapBefore(n, gapIn, gapOut) {
    return ((n - 1) % 5 === 0) ? gapOut : gapIn;
  }

  function walkLength(target, gapIn, gapOut) {
    var total = 0;
    for (var n = 1; n <= target; n++) total += gapBefore(n, gapIn, gapOut);
    return total;
  }

  // ------------------------------------------------------------------ main ---

  function create(opts) {
    opts = opts || {};
    var target = (opts.targetScore === 61) ? 61 : 121;
    var labels = opts.labels || ['You', 'Opponent'];
    var uid = 'cb' + (++seq);

    var skunk = target - 30;
    var doubleSkunk = target - 60;

    // ---- structure ---------------------------------------------------------

    var board = el('div', 'crib-board');
    board.setAttribute('data-target-score', String(target));
    board.setAttribute('role', 'img');

    var probe = el('div', 'crib-board__probe');
    probe.setAttribute('aria-hidden', 'true');
    board.appendChild(probe);

    var grainLines = svgNode('svg');
    grainLines.setAttribute('class', 'crib-board__grain crib-board__grain--lines');
    grainLines.setAttribute('aria-hidden', 'true');
    grainLines.setAttribute('preserveAspectRatio', 'none');
    grainLines.innerHTML =
      '<defs>' +
        // Two octaves at a long wavelength: the rays drift and swell rather than
        // ripple. A high-frequency warp here would read as water, not timber.
        '<filter id="' + uid + '-warp" x="-30%" y="-15%" width="160%" height="130%" ' +
          'color-interpolation-filters="sRGB">' +
          '<feTurbulence type="fractalNoise" baseFrequency="0.0038 0.0125" numOctaves="2" ' +
            'seed="17" result="n"/>' +
          '<feDisplacementMap in="SourceGraphic" in2="n" scale="17" ' +
            'xChannelSelector="R" yChannelSelector="G"/>' +
        '</filter>' +
      '</defs>' +
      '<g class="cb-rays"></g>';
    board.appendChild(grainLines);
    var rays = grainLines.querySelector('.cb-rays');
    rays.setAttribute('filter', 'url(#' + uid + '-warp)');

    // Broad tonal figure: slow, soft mottling so the plank is never one flat tone.
    var grainFigure = svgNode('svg');
    grainFigure.setAttribute('class', 'crib-board__grain crib-board__grain--figure');
    grainFigure.setAttribute('aria-hidden', 'true');
    grainFigure.setAttribute('preserveAspectRatio', 'none');
    grainFigure.innerHTML =
      '<defs>' +
        '<filter id="' + uid + '-figure" x="0" y="0" width="100%" height="100%" ' +
          'color-interpolation-filters="sRGB">' +
          '<feTurbulence type="fractalNoise" baseFrequency="0.016 0.0032" numOctaves="2" seed="41"/>' +
          '<feColorMatrix type="saturate" values="0"/>' +
          '<feComponentTransfer><feFuncA type="linear" slope="0.85"/></feComponentTransfer>' +
        '</filter>' +
      '</defs>' +
      '<rect width="100%" height="100%" filter="url(#' + uid + '-figure)"/>';
    board.appendChild(grainFigure);

    var grainNoise = svgNode('svg');
    grainNoise.setAttribute('class', 'crib-board__grain crib-board__grain--noise');
    grainNoise.setAttribute('aria-hidden', 'true');
    grainNoise.setAttribute('preserveAspectRatio', 'none');
    grainNoise.innerHTML =
      '<defs>' +
        '<filter id="' + uid + '-pore" x="0" y="0" width="100%" height="100%" ' +
          'color-interpolation-filters="sRGB">' +
          '<feTurbulence type="fractalNoise" baseFrequency="0.68 0.31" numOctaves="4" seed="9"/>' +
          '<feColorMatrix type="saturate" values="0"/>' +
          '<feComponentTransfer><feFuncA type="linear" slope="0.62"/></feComponentTransfer>' +
        '</filter>' +
      '</defs>' +
      '<rect width="100%" height="100%" filter="url(#' + uid + '-pore)"/>';
    board.appendChild(grainNoise);

    var scores = el('div', 'crib-board__scores');
    var scoreNums = [];
    // Player 1 sits on the left of the plate and player 0 on the right, matching
    // which side of the rail each player's track starts on.
    [1, 0].forEach(function (p) {
      var row = el('div', 'crib-score crib-score--p' + p);
      var pip = el('span', 'crib-score__pip');
      pip.setAttribute('aria-hidden', 'true');
      var lab = el('span', 'crib-score__label');
      lab.textContent = labels[p];
      var num = el('span', 'crib-score__num');
      num.textContent = '0';
      row.appendChild(pip);
      row.appendChild(lab);
      row.appendChild(num);
      scores.appendChild(row);
      scoreNums[p] = num;
    });
    board.appendChild(scores);

    var track = svgNode('svg');
    track.setAttribute('class', 'crib-board__track');
    track.setAttribute('aria-hidden', 'true');
    var spine = svgNode('path');
    spine.setAttribute('class', 'cb-spine');
    track.appendChild(spine);
    var content = svgNode('g');
    content.setAttribute('class', 'cb-content');
    track.appendChild(content);
    board.appendChild(track);

    var pegLayer = el('div', 'crib-board__pegs');
    pegLayer.setAttribute('aria-hidden', 'true');
    board.appendChild(pegLayer);

    var players = [0, 1].map(function (p) {
      var pegs = [0, 1].map(function (i) {
        var peg = el('div', 'crib-peg crib-peg--' + (p === 0 ? 'brass' : 'pewter'));
        peg.setAttribute('data-player', String(p));
        peg.setAttribute('data-slot', String(i));
        pegLayer.appendChild(peg);
        return peg;
      });
      // Both pegs start in the two start holes, -1 and 0, as on a real board.
      return { pegs: pegs, at: [-1, 0], rear: 0, front: 0 };
    });

    var legend = el('div', 'crib-board__legend');
    function legendItem(kind, text, value) {
      var item = el('span', 'crib-legend');
      var mark = el('span', 'crib-legend__mark crib-legend__mark--' + kind);
      mark.setAttribute('aria-hidden', 'true');
      var txt = el('span', 'crib-legend__text');
      txt.textContent = text + ' ' + value;
      item.appendChild(mark);
      item.appendChild(txt);
      return item;
    }
    legend.appendChild(legendItem('skunk', 'Skunk', skunk));
    if (doubleSkunk >= 5) legend.appendChild(legendItem('double', 'Double', doubleSkunk));
    board.appendChild(legend);

    // ---- geometry state ----------------------------------------------------

    // holes[player][n + 1] -> {x, y} in board-element pixels.
    var holes = [[], []];
    var laidOut = false;
    var geom = null;

    function probeWidth(expr, fallback) {
      probe.style.width = expr;
      var w = probe.getBoundingClientRect().width;
      probe.style.width = '';
      return (w > 0.5 && w < 400) ? w : fallback;
    }

    function buildSpinePath(g) {
      // Right lane up, over the top, middle lane down, under the bottom, left
      // lane up. Sweep flags: left->right bulging up is 1, so right->left over
      // the top is 0, and right->left under the bottom is 1.
      return 'M ' + r2(g.xR) + ' ' + r2(g.yBot) +
        ' L ' + r2(g.xR) + ' ' + r2(g.yTop) +
        ' A ' + r2(g.r) + ' ' + r2(g.r) + ' 0 0 0 ' + r2(g.xM) + ' ' + r2(g.yTop) +
        ' L ' + r2(g.xM) + ' ' + r2(g.yBot) +
        ' A ' + r2(g.r) + ' ' + r2(g.r) + ' 0 0 1 ' + r2(g.xL) + ' ' + r2(g.yBot) +
        ' L ' + r2(g.xL) + ' ' + r2(g.yTop);
    }

    function layout() {
      if (!board.isConnected) return false;
      var boxW = board.clientWidth;
      var boxH = board.clientHeight;
      if (!boxW || !boxH) return false;

      var cs = getComputedStyle(board);
      var padL = parseFloat(cs.paddingLeft) || 0;
      var padR = parseFloat(cs.paddingRight) || 0;
      var padT = parseFloat(cs.paddingTop) || 0;
      var padB = parseFloat(cs.paddingBottom) || 0;

      var h = probeWidth('var(--hole-size)', FALLBACK.hole);
      var gapIn = probeWidth('var(--hole-gap)', FALLBACK.gapIn);
      var gapOut = probeWidth('var(--hole-group-gap)', FALLBACK.gapOut);
      var pegW = probeWidth('var(--peg-w)', FALLBACK.pegW);

      var hr = h / 2;
      // Track separation is the one number that decides how tight the inner arc
      // of a turn gets: the inner row is squeezed by (r - d) / r. Keep it as
      // small as two adjacent pegs will tolerate, which buys back most of it.
      var d = Math.max(h * 0.88, pegW * 0.66);
      var edge = h * 0.5;

      var innerW = Math.max(60, boxW - padL - padR);
      var halfSpan = d + hr + edge;
      var s = (innerW - 2 * halfSpan) / 2;

      // Total path = one extra group gap before the first start hole, then the walk.
      var total = gapOut + walkLength(target, gapIn, gapOut);

      // A 180-degree turn between lanes s apart costs pi*s/2 of track, so wide
      // lanes buy readability at the cost of straightaway length. Cap the lane
      // spacing if the turns would eat the straights.
      var minStraight = 6 * gapOut;
      var maxS = (total - 3 * minStraight) / Math.PI;
      s = clamp(s, 6 * h, Math.max(6 * h, maxS));
      var r = s / 2;

      var straight = (total - 2 * Math.PI * r) / 3;
      var xL = (innerW - 2 * s) / 2;
      var yTop = r + hr + edge * 0.6;
      var yBot = yTop + straight;

      var g = {
        h: h, hr: hr, d: d, s: s, r: r, gapIn: gapIn, gapOut: gapOut,
        xL: xL, xM: xL + s, xR: xL + 2 * s,
        yTop: yTop, yBot: yBot,
        W: innerW,
        H: yBot + r + hr + edge * 0.6,
        total: total
      };

      // Vertical band left for the track once the score plate and legend have
      // taken theirs.
      var headH = scores.offsetHeight;
      var footH = legend.offsetHeight;
      var availH = Math.max(80, boxH - padT - padB - headH - footH);
      var k = Math.min(1, availH / g.H, innerW / g.W);

      g.scale = k;
      g.left = padL + (innerW - g.W * k) / 2;
      g.top = padT + headH + (availH - g.H * k) / 2;
      geom = g;

      board.style.setProperty('--cb-scale', String(r2(k)));
      rays.innerHTML = grainRays(boxW, boxH, 0x5eed);

      track.setAttribute('viewBox', '0 0 ' + r2(g.W) + ' ' + r2(g.H));
      track.setAttribute('width', r2(g.W * k));
      track.setAttribute('height', r2(g.H * k));
      track.style.left = r2(g.left) + 'px';
      track.style.top = r2(g.top) + 'px';

      spine.setAttribute('d', buildSpinePath(g));
      walkAndDraw(g);

      laidOut = true;
      placeAllPegs();
      return true;
    }

    // Sample the centreline once and hand back point + unit tangent. The tangent
    // is a central difference because SVGGeometryElement gives us no derivative.
    function sample(measured, at) {
      var eps = 0.6;
      var p = spine.getPointAtLength(clamp(at, 0, measured));
      var a = spine.getPointAtLength(clamp(at - eps, 0, measured));
      var b = spine.getPointAtLength(clamp(at + eps, 0, measured));
      var dx = b.x - a.x;
      var dy = b.y - a.y;
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      return { x: p.x, y: p.y, tx: dx / len, ty: dy / len };
    }

    // Player 0 takes the outer side of the first leg — the edge of the rail —
    // and both tracks then hold a constant offset along the normal, which puts
    // one player on the inside of each turn and the other on the outside, as a
    // real serpentine does.
    function offsetPoint(sm, side) {
      var nx = sm.ty;
      var ny = -sm.tx;
      return side === 0
        ? { x: sm.x - nx * geom.d, y: sm.y - ny * geom.d }
        : { x: sm.x + nx * geom.d, y: sm.y + ny * geom.d };
    }

    function walkAndDraw(g) {
      var measured = spine.getTotalLength();
      // getTotalLength approximates arcs, so rescale the walk onto the measured
      // path. Without this the game hole drifts off the end of the track.
      var fit = measured / g.total;

      var cursors = [];
      var cursor = 0;
      cursors.push(0);          // second start hole, index -1
      cursor = g.gapOut;
      cursors.push(cursor);     // start hole, index 0
      for (var n = 1; n <= target; n++) {
        cursor += gapBefore(n, g.gapIn, g.gapOut);
        cursors.push(cursor);
      }

      holes = [[], []];
      var samples = [];
      for (var i = 0; i < cursors.length; i++) {
        var sm = sample(measured, cursors[i] * fit);
        samples.push(sm);
        holes[0].push(offsetPoint(sm, 0));
        holes[1].push(offsetPoint(sm, 1));
      }

      // ---- skunk lines ------------------------------------------------------
      var marks = '';
      function markAt(n, double) {
        if (n < 1 || n > target) return '';
        var mid = (cursors[n] + cursors[n + 1]) / 2;  // between hole n-1 and n
        var out = '';
        var offsets = double ? [-g.h * 0.42, g.h * 0.42] : [0];
        for (var oi = 0; oi < offsets.length; oi++) {
          var sm = sample(measured, mid * fit + offsets[oi]);
          var nx = sm.ty;
          var ny = -sm.tx;
          var reach = g.d + g.h * 1.15;
          var ax = r2(sm.x - nx * reach), ay = r2(sm.y - ny * reach);
          var bx = r2(sm.x + nx * reach), by = r2(sm.y + ny * reach);
          out += '<path class="cb-mark-groove" d="M ' + ax + ' ' + (ay + 1) +
            ' L ' + bx + ' ' + (by + 1) + '" stroke-width="' + r2(g.h * 0.3) + '"/>';
          out += '<path class="cb-mark" d="M ' + ax + ' ' + ay + ' L ' + bx + ' ' + by +
            '" stroke-width="' + r2(g.h * 0.26) + '"/>';
        }
        return out;
      }
      marks += markAt(skunk, false);
      if (doubleSkunk >= 5) marks += markAt(doubleSkunk, true);

      // ---- holes ------------------------------------------------------------
      // Three passes rather than three-element groups: identical output, a third
      // of the DOM depth, and 700-odd nodes is enough to care.
      var bores = '', depth = '', rims = '';
      for (var pl = 0; pl < 2; pl++) {
        for (var hi = 0; hi < holes[pl].length; hi++) {
          var pt = holes[pl][hi];
          var rad = (hi - 1 === target) ? g.hr * 1.3 : g.hr;
          var cx = r2(pt.x), cy = r2(pt.y);
          bores += '<circle class="cb-bore" cx="' + cx + '" cy="' + cy +
            '" r="' + r2(rad) + '"/>';
          depth += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r2(rad) +
            '" fill="url(#' + uid + '-bore)"/>';
          rims += '<circle class="cb-rim" cx="' + cx + '" cy="' + cy + '" r="' +
            r2(rad) + '" stroke="url(#' + uid + '-rim)" stroke-width="' +
            r2(Math.max(0.8, rad * 0.34)) + '"/>';
        }
      }

      // One inlaid surround enclosing both game holes. Two separate rings at this
      // spacing overlap into a figure-eight, which just looks like a mistake.
      var e0 = holes[0][holes[0].length - 1];
      var e1 = holes[1][holes[1].length - 1];
      var mx = (e0.x + e1.x) / 2;
      var my = (e0.y + e1.y) / 2;
      var sep = Math.sqrt((e1.x - e0.x) * (e1.x - e0.x) + (e1.y - e0.y) * (e1.y - e0.y));
      var rr = g.hr * 2.0;
      var ang = Math.atan2(e1.y - e0.y, e1.x - e0.x) * 180 / Math.PI;
      var extra = '<rect class="cb-game-ring" x="' + r2(mx - sep / 2 - rr) + '" y="' +
        r2(my - rr) + '" width="' + r2(sep + 2 * rr) + '" height="' + r2(2 * rr) +
        '" rx="' + r2(rr) + '" stroke-width="' + r2(Math.max(1, g.h * 0.18)) +
        '" transform="rotate(' + r2(ang) + ' ' + r2(mx) + ' ' + r2(my) + ')"/>';

      content.innerHTML =
        '<defs>' +
          // Lightest just under the top rim, pitch dark at the bottom of the bore.
          '<radialGradient id="' + uid + '-bore" cx="50%" cy="50%" r="62%" fx="50%" fy="16%">' +
            '<stop class="cb-stop-shadow" offset="0" stop-opacity="0"/>' +
            '<stop class="cb-stop-shadow" offset="0.5" stop-opacity="0.4"/>' +
            '<stop class="cb-stop-shadow" offset="1" stop-opacity="1"/>' +
          '</radialGradient>' +
          '<linearGradient id="' + uid + '-rim" x1="0" y1="0" x2="0" y2="1">' +
            '<stop class="cb-stop-rim" offset="0" stop-opacity="1"/>' +
            '<stop class="cb-stop-rim" offset="0.45" stop-opacity="0.14"/>' +
            '<stop class="cb-stop-rim" offset="1" stop-opacity="0"/>' +
          '</linearGradient>' +
        '</defs>' +
        '<g class="cb-marks">' + marks + '</g>' +
        '<g class="cb-holes">' + extra + bores + depth + rims + '</g>';
    }

    // ---- public geometry ---------------------------------------------------

    function ensureLayout() {
      if (!laidOut) layout();
      return laidOut;
    }

    function holePosition(player, n) {
      ensureLayout();
      var p = (player === 1) ? 1 : 0;
      var idx = clamp(Math.round(n), -1, target) + 1;
      var row = holes[p];
      if (!row.length) return { x: 0, y: 0 };
      var pt = row[idx] || row[row.length - 1];
      return {
        x: geom.left + pt.x * geom.scale,
        y: geom.top + pt.y * geom.scale
      };
    }

    function placePeg(player, slot) {
      var st = players[player];
      var pos = holePosition(player, st.at[slot]);
      var peg = st.pegs[slot];
      peg.style.left = r2(pos.x) + 'px';
      peg.style.top = r2(pos.y) + 'px';
    }

    function placeAllPegs() {
      for (var p = 0; p < 2; p++) {
        placePeg(p, 0);
        placePeg(p, 1);
      }
    }

    function describe() {
      board.setAttribute('aria-label',
        'Cribbage board, game to ' + target + '. ' +
        labels[0] + ' ' + players[0].front + ', ' +
        labels[1] + ' ' + players[1].front + '.');
    }

    function setPegs(player, rear, front) {
      var p = (player === 1) ? 1 : 0;
      var st = players[p];
      var lo = clamp(Math.round(rear), 0, target);
      var hi = clamp(Math.round(front), 0, target);
      if (hi < lo) { var t = lo; lo = hi; hi = t; }

      // Leapfrog: the peg that was in front stays put and becomes the new rear,
      // and the peg that was behind jumps over it. Whichever peg already stands
      // on one of the two target holes keeps that hole, so each DOM element stays
      // welded to the physical peg it represents — that is what lets the
      // animation layer pick up the one that is actually going to move.
      var rearSlot;
      if (st.at[0] === lo) rearSlot = 0;
      else if (st.at[1] === lo) rearSlot = 1;
      else if (st.at[0] === hi) rearSlot = 1;   // peg 0 holds the front, so peg 1 takes the rear
      else if (st.at[1] === hi) rearSlot = 0;
      else rearSlot = 0;

      st.at[rearSlot] = lo;
      st.at[1 - rearSlot] = hi;

      // Before the first score both pegs are home, so they take the two start
      // holes rather than stacking in one. Whichever peg is already in the outer
      // start hole stays there, so repeated calls do not shuffle identities.
      if (lo === 0 && hi === 0) {
        var outer = (st.at[1] === -1) ? 1 : 0;
        st.at[outer] = -1;
        st.at[1 - outer] = 0;
      }

      st.rear = lo;
      st.front = hi;
      scoreNums[p].textContent = String(hi);
      describe();
      if (ensureLayout()) placeAllPegs();
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

    // ---- lifecycle ---------------------------------------------------------

    var ro = null;
    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(function () { layout(); });
      ro.observe(board);
    } else if (typeof window !== 'undefined') {
      window.addEventListener('resize', function () { layout(); });
    }

    describe();
    setPegs(0, 0, 0);
    setPegs(1, 0, 0);

    return {
      el: board,
      targetScore: target,
      skunkLine: skunk,
      doubleSkunkLine: doubleSkunk,
      holePosition: holePosition,
      setPegs: setPegs,
      pegElement: pegElement,
      refresh: layout,
      destroy: function () { if (ro) ro.disconnect(); }
    };
  }

  root.Cribbage = root.Cribbage || {};
  root.Cribbage.RenderBoard = { create: create };
})(typeof window !== 'undefined' ? window : globalThis);
