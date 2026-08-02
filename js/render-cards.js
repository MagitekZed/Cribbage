(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // render-cards.js — builds card DOM. No game logic, no state, no animation:
  // it hands back inert elements that cards.css styles and animate.js moves.
  //
  // The rank/suit tables below deliberately mirror cards.js rather than reading
  // from it, so this file has no script-order dependency and can be loaded (or
  // unit-tested) on its own. The SUITS order is fixed by the card id formula and
  // is documented as load-bearing in cards.js, so there is nothing to drift.
  // ---------------------------------------------------------------------------

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var XLINK_NS = 'http://www.w3.org/1999/xlink';
  var DEFS_ID = 'cribbage-suit-defs';
  var SYMBOL_PREFIX = 'crib-suit-';

  var SUIT_KEYS = ['S', 'H', 'D', 'C'];
  var SUIT_WORDS = ['Spades', 'Hearts', 'Diamonds', 'Clubs'];
  var RANK_LABELS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  var RANK_WORDS = [
    'Ace', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
    'Ten', 'Jack', 'Queen', 'King'
  ];

  // --- Suit artwork ----------------------------------------------------------
  // All four pips share a 0 0 100 100 viewBox so that a single square pip box in
  // CSS renders them at a consistent optical size. Within that box each suit is
  // drawn to its own traditional proportions — the diamond is narrow, the club
  // and spade are wide — and the extents were chosen so the four have roughly
  // equal ink area, which is what actually makes a mixed hand look balanced.

  var SPADE =
    'M50 4' +
    'C54 14 62 25 74 36' +
    'C86 47 93 54 93 64' +
    'C93 76 85 84 74 84' +
    'C65 84 57 80 52 72' +
    'C54 81 58 89 66 95' +
    'L34 95' +
    'C42 89 46 81 48 72' +
    'C43 80 35 84 26 84' +
    'C15 84 7 76 7 64' +
    'C7 54 14 47 26 36' +
    'C38 25 46 14 50 4Z';

  var HEART =
    'M50 91' +
    'C34 78 6 58 6 34' +
    'C6 17 19 7 32 7' +
    'C42 7 48 15 50 22' +
    'C52 15 58 7 68 7' +
    'C81 7 94 17 94 34' +
    'C94 58 66 78 50 91Z';

  // Straight-edged rhombi read as a UI glyph; the control points bow each edge
  // out by about 1.5 units, which is enough to look drawn rather than plotted.
  var DIAMOND =
    'M50 2' +
    'C60 15 72 31 82 50' +
    'C72 69 60 85 50 98' +
    'C40 85 28 69 18 50' +
    'C28 31 40 15 50 2Z';

  // The club's three lobes are real circles rather than fitted beziers — hand
  // fitting a circle in cubics at this size always leaves a visible flat spot.
  var CLUB_LOBES = [[50, 27, 23], [28, 61, 23], [72, 61, 23]];
  var CLUB_STEM =
    'M45 48' +
    'C46 63 41 80 30 95' +
    'L70 95' +
    'C59 80 54 63 55 48Z';

  var SUIT_ART = {
    S: { paths: [SPADE] },
    H: { paths: [HEART] },
    D: { paths: [DIAMOND] },
    C: { circles: CLUB_LOBES, paths: [CLUB_STEM] }
  };

  // --- Classical pip layout --------------------------------------------------
  // Cells are [column 1..3, row 1..13] on the pip grid declared in cards.css.
  // Anything below row 7 is rotated 180deg, exactly as on a printed card.
  var PIP_LAYOUT = {
    1: [[2, 7]],
    2: [[2, 1], [2, 13]],
    3: [[2, 1], [2, 7], [2, 13]],
    4: [[1, 1], [3, 1], [1, 13], [3, 13]],
    5: [[1, 1], [3, 1], [2, 7], [1, 13], [3, 13]],
    6: [[1, 1], [3, 1], [1, 7], [3, 7], [1, 13], [3, 13]],
    7: [[1, 1], [3, 1], [2, 4], [1, 7], [3, 7], [1, 13], [3, 13]],
    8: [[1, 1], [3, 1], [2, 4], [1, 7], [3, 7], [2, 10], [1, 13], [3, 13]],
    9: [[1, 1], [3, 1], [1, 5], [3, 5], [2, 7], [1, 9], [3, 9], [1, 13], [3, 13]],
    10: [[1, 1], [3, 1], [2, 3], [1, 5], [3, 5], [1, 9], [3, 9], [2, 11], [1, 13], [3, 13]]
  };

  // --- Art deco panel geometry -----------------------------------------------
  // The court panels and the ace of spades are drawn in one inline SVG per card
  // with a 100 x 140 viewBox — the card's own 5:7 — so one SVG unit is exactly
  // 1% of the card width and every number below reads as a percentage. Nothing
  // here carries a colour or a stroke width: those are classes, so cards.css
  // stays the only place a value can be tuned and theme.css the only place a
  // colour is spelled out.
  //
  // A real court card looks the same either way up, because the figure is drawn
  // as two half-figures. Every ornament below is built once for the top half and
  // then CLONED through rotate(180 50 70), so that symmetry is exact by
  // construction rather than by carefully typed coordinates. The rank letter is
  // the single deliberate exception: it stays upright in the medallion, because
  // a court card is read at speed in a fan of four and a letter you have to
  // resolve twice is a letter that slows the game down.

  var D_W = 100;
  var D_H = 140;
  var D_CX = 50;
  var D_CY = 70;

  // The corner indices occupy roughly x 3.5-19.5 / y 4.5-34.5 and its half-turn
  // twin, so the frame runs narrow past them and steps OUT across the middle
  // band where nothing is in the way. That step is what buys the medallion its
  // size, and a stepped cartouche is deco vocabulary rather than a compromise.
  function cartouche(halfW, halfBand, top, cut, bandTop, bandCut) {
    var bot = D_H - top;
    var bandBot = D_H - bandTop;
    var l = D_CX - halfW;
    var r = D_CX + halfW;
    var lb = D_CX - halfBand;
    var rb = D_CX + halfBand;
    return [
      [l + cut, top], [r - cut, top],
      [r, top + cut], [r, bandTop - bandCut],
      [rb, bandTop], [rb, bandBot],
      [r, bandBot + bandCut], [r, bot - cut],
      [r - cut, bot], [l + cut, bot],
      [l, bot - cut], [l, bandBot + bandCut],
      [lb, bandBot], [lb, bandTop],
      [l, bandTop - bandCut], [l, top + cut]
    ];
  }

  // Mitred square, centred. `cut` does all the work: a small cut gives the
  // King's blocky medallion, a large one the Jack's lozenge, and both are the
  // same construction so the three courts stay a family.
  function octagon(half, cut, cx, cy) {
    cx = cx === undefined ? D_CX : cx;
    cy = cy === undefined ? D_CY : cy;
    return [
      [cx - half + cut, cy - half], [cx + half - cut, cy - half],
      [cx + half, cy - half + cut], [cx + half, cy + half - cut],
      [cx + half - cut, cy + half], [cx - half + cut, cy + half],
      [cx - half, cy + half - cut], [cx - half, cy - half + cut]
    ];
  }

  function pointStr(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      out.push(round(list[i][0]) + ',' + round(list[i][1]));
    }
    return out.join(' ');
  }

  function round(n) {
    return Math.round(n * 100) / 100;
  }

  // --- Small DOM helpers -----------------------------------------------------

  function el(tag, cls) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    return node;
  }

  function svgEl(tag, cls) {
    var node = document.createElementNS(SVG_NS, tag);
    // SVGElement.className is a read-only SVGAnimatedString, so never assign it.
    if (cls) node.setAttribute('class', cls);
    return node;
  }

  function svgShape(tag, cls, attrs) {
    var node = svgEl(tag, cls);
    for (var k in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, k)) node.setAttribute(k, String(attrs[k]));
    }
    return node;
  }

  function symbolId(suitKey) {
    return SYMBOL_PREFIX + suitKey.toLowerCase();
  }

  function suitKeyOf(card) {
    return typeof card.suit === 'number' ? SUIT_KEYS[card.suit] : String(card.suit).toUpperCase();
  }

  // A <use> instance of one of the four suit symbols, sized entirely by CSS.
  function pipGlyph(suitKey, cls) {
    var svg = svgEl('svg', cls ? 'card__glyph ' + cls : 'card__glyph');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    var use = svgEl('use');
    var ref = '#' + symbolId(suitKey);
    use.setAttribute('href', ref);
    // Older WebKit only resolves the xlink form; harmless everywhere else.
    use.setAttributeNS(XLINK_NS, 'xlink:href', ref);
    svg.appendChild(use);
    return svg;
  }

  // --- Public: the symbol sheet ---------------------------------------------

  function suitDefs() {
    var svg = svgEl('svg');
    svg.setAttribute('id', DEFS_ID);
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    // Hidden by collapsing rather than display:none — some engines refuse to
    // resolve <use> into a subtree that was never laid out.
    svg.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden');

    var defs = svgEl('defs');
    for (var i = 0; i < SUIT_KEYS.length; i++) {
      var key = SUIT_KEYS[i];
      var art = SUIT_ART[key];
      var sym = svgEl('symbol');
      sym.setAttribute('id', symbolId(key));
      sym.setAttribute('viewBox', '0 0 100 100');
      // Presentation attribute on the symbol, not a stylesheet rule: document
      // CSS selectors cannot reach inside a <use> shadow tree, but inherited
      // properties like fill do flow in.
      sym.setAttribute('fill', 'currentColor');

      var j;
      if (art.circles) {
        for (j = 0; j < art.circles.length; j++) {
          var c = svgEl('circle');
          c.setAttribute('cx', String(art.circles[j][0]));
          c.setAttribute('cy', String(art.circles[j][1]));
          c.setAttribute('r', String(art.circles[j][2]));
          sym.appendChild(c);
        }
      }
      for (j = 0; j < art.paths.length; j++) {
        var p = svgEl('path');
        p.setAttribute('d', art.paths[j]);
        sym.appendChild(p);
      }
      defs.appendChild(sym);
    }
    svg.appendChild(defs);
    return svg;
  }

  // Idempotent. createCard calls this itself so callers cannot forget it.
  function ensureDefs(doc) {
    var d = doc || document;
    if (d.getElementById(DEFS_ID)) return d.getElementById(DEFS_ID);
    var node = suitDefs();
    (d.body || d.documentElement).insertBefore(node, (d.body || d.documentElement).firstChild);
    return node;
  }

  // --- Card faces ------------------------------------------------------------

  function buildIndex(rankLabel, suitKey, corner) {
    var wrap = el('span', 'card__index card__index--' + corner);
    var rank = el('span', 'card__rank');
    // '10' is the only two-glyph index; it gets its own size so the corner
    // block stays the same width as every other card's.
    if (rankLabel.length > 1) rank.classList.add('card__rank--wide');
    rank.textContent = rankLabel;
    wrap.appendChild(rank);
    wrap.appendChild(pipGlyph(suitKey, 'card__index-pip'));
    return wrap;
  }

  function buildPips(rank, suitKey) {
    var field = el('div', 'card__pips');
    var cells = PIP_LAYOUT[rank] || [];
    for (var i = 0; i < cells.length; i++) {
      var col = cells[i][0];
      var row = cells[i][1];
      var cls = 'card__pip card__pip--c' + col + ' card__pip--r' + row;
      if (rank === 1) cls += ' card__pip--ace';
      var slot = el('span', cls);
      slot.appendChild(pipGlyph(suitKey));
      field.appendChild(slot);
    }
    return field;
  }

  // --- The deco panel --------------------------------------------------------

  // A suit symbol placed in panel coordinates. Same four symbols as the pips, so
  // a court card's suit is drawn with exactly the ink a number card's is — the
  // suit is worked into the ornament rather than sitting on top of it.
  function decoPip(suitKey, cx, cy, size, cls) {
    var use = svgShape('use', cls || 'card__deco-pip', {
      x: round(cx - size / 2),
      y: round(cy - size / 2),
      width: round(size),
      height: round(size)
    });
    var ref = '#' + symbolId(suitKey);
    use.setAttribute('href', ref);
    use.setAttributeNS(XLINK_NS, 'xlink:href', ref);
    return use;
  }

  // Angles run clockwise from straight up, which is how the ornament reads.
  function polar(cx, cy, deg, r) {
    var rad = deg * Math.PI / 180;
    return [cx + Math.sin(rad) * r, cy - Math.cos(rad) * r];
  }

  function ray(cls, cx, cy, deg, r0, r1) {
    var a = polar(cx, cy, deg, r0);
    var b = polar(cx, cy, deg, r1);
    return svgShape('line', cls, { x1: round(a[0]), y1: round(a[1]), x2: round(b[0]), y2: round(b[1]) });
  }

  // Arc of `r` about (cx, cy), symmetric about the vertical, opening upward.
  function fanArc(cls, cx, cy, r, spread) {
    var a = polar(cx, cy, -spread, r);
    var b = polar(cx, cy, spread, r);
    return svgShape('path', cls, {
      d: 'M' + round(a[0]) + ' ' + round(a[1]) +
         'A' + round(r) + ' ' + round(r) + ' 0 0 1 ' + round(b[0]) + ' ' + round(b[1])
    });
  }

  function poly(tag, cls, list) {
    return svgShape(tag, cls, { points: pointStr(list) });
  }

  // --- The three court motifs ------------------------------------------------
  // Each returns the TOP half only; buildCourt clones it through a half turn. So
  // everything below lives in roughly y 15-48, above the medallion, and the
  // rotated copy fills y 92-125 for free.

  // KING — a solid stepped ziggurat with the suit knocked OUT of it. Deco lives
  // on the positive/negative flip, and the solid mass is what gives the King his
  // weight: he is the only one of the three with a filled silhouette, and it is
  // the last thing to disappear as the card shrinks.
  function kingMotif(suitKey) {
    var g = svgEl('g');
    g.appendChild(poly('polygon', 'card__deco-solid', [
      [32, 45], [32, 38], [36, 38], [36, 31], [40, 31], [40, 25],
      [60, 25], [60, 31], [64, 31], [64, 38], [68, 38], [68, 45]
    ]));
    // Big enough that the crown reads as a frame around the suit rather than as
    // a dark mass with a speck in it — the difference is everything at 52px.
    g.appendChild(decoPip(suitKey, 50, 35, 13.5, 'card__deco-knockout'));
    return g;
  }

  // QUEEN — a rising fan of arcs and spokes springing off the medallion's crown,
  // the suit riding the crest. The elaborate, radial one: nothing filled, but
  // three times the line count of the Jack.
  function queenMotif(suitKey) {
    var g = svgEl('g');
    var fx = D_CX;
    var fy = 50;          // the fan springs from the top of the medallion
    var radii = [10, 15, 20];
    var i;
    for (i = 0; i < radii.length; i++) {
      g.appendChild(fanArc(i === 1 ? 'card__deco-rule-fine' : 'card__deco-rule', fx, fy, radii[i], 72));
    }
    var spokes = [-60, -30, 0, 30, 60];
    for (i = 0; i < spokes.length; i++) {
      g.appendChild(ray('card__deco-rule-fine', fx, fy, spokes[i], 9.5, 20.5));
    }
    g.appendChild(decoPip(suitKey, 50, 22.5, 12));
    return g;
  }

  // JACK — two solid chevrons between a pair of thin columns. The lean one: the
  // same confident geometry, a third of the ink.
  function jackMotif(suitKey) {
    var g = svgEl('g');
    var apex = [29, 38];
    for (var i = 0; i < apex.length; i++) {
      var a = apex[i];
      g.appendChild(poly('polygon', 'card__deco-solid', [
        [36, a + 8], [50, a], [64, a + 8],
        [64, a + 11.5], [50, a + 3.5], [36, a + 11.5]
      ]));
    }
    g.appendChild(svgShape('line', 'card__deco-rule-fine', { x1: 32, y1: 30, x2: 32, y2: 49.5 }));
    g.appendChild(svgShape('line', 'card__deco-rule-fine', { x1: 68, y1: 30, x2: 68, y2: 49.5 }));
    g.appendChild(decoPip(suitKey, 50, 20.5, 11));
    return g;
  }

  // --- Medallions ------------------------------------------------------------
  // One family, three silhouettes: a blocky mitred square for the King, a circle
  // for the Queen, a deep-cut lozenge for the Jack. Silhouette is what still
  // distinguishes the three at 52px, once the ornament inside them has faded —
  // which is exactly what the old identical panels were failing to do.

  function medallion(rank) {
    var g = svgEl('g', 'card__deco-medallion');
    if (rank === 13) {
      g.appendChild(poly('polygon', 'card__deco-ground-face', octagon(20, 7)));
      g.appendChild(poly('polygon', 'card__deco-rule', octagon(20, 7)));
      g.appendChild(poly('polygon', 'card__deco-brass', octagon(17.5, 6)));
    } else if (rank === 12) {
      g.appendChild(svgShape('circle', 'card__deco-ground-face', { cx: D_CX, cy: D_CY, r: 20 }));
      g.appendChild(svgShape('circle', 'card__deco-rule', { cx: D_CX, cy: D_CY, r: 20 }));
      g.appendChild(svgShape('circle', 'card__deco-brass', { cx: D_CX, cy: D_CY, r: 17.5 }));
    } else {
      // Deep mitres, so the Jack's lozenge is a different silhouette from the
      // King's square one at any size — shape, not detail, is what survives
      // being read across a table.
      g.appendChild(poly('polygon', 'card__deco-ground-face', octagon(20, 12)));
      g.appendChild(poly('polygon', 'card__deco-rule', octagon(20, 12)));
      g.appendChild(poly('polygon', 'card__deco-brass', octagon(17.5, 10.5)));
    }
    return g;
  }

  // --- Panel assembly --------------------------------------------------------

  function decoSvg() {
    var svg = svgEl('svg', 'card__deco');
    svg.setAttribute('viewBox', '0 0 ' + D_W + ' ' + D_H);
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    return svg;
  }

  // The stepped frame both the courts and the ace of spades sit inside: a heavy
  // rule with a brass hairline running parallel just inside it. Deco almost
  // never uses a single line where it can use two of different weight.
  function decoFrame(svg) {
    var outer = cartouche(26, 30, 11, 7, 48, 5);
    svg.appendChild(poly('polygon', 'card__deco-ground', outer));
    svg.appendChild(poly('polygon', 'card__deco-rule', outer));
    svg.appendChild(poly('polygon', 'card__deco-brass', cartouche(23.4, 27.4, 13.6, 6.4, 49, 5)));
  }

  function buildCourt(rankLabel, suitKey, rank) {
    var panel = el('div', 'card__court');
    var svg = decoSvg();
    decoFrame(svg);

    var motif = rank === 13 ? kingMotif(suitKey)
      : rank === 12 ? queenMotif(suitKey)
        : jackMotif(suitKey);
    svg.appendChild(motif);
    // The half-turn twin. cloneNode rather than a second build so the two can
    // never drift apart, and rotate() rather than mirrored coordinates so the
    // suit pip comes out genuinely upside down the way a printed one does.
    var twin = motif.cloneNode(true);
    twin.setAttribute('transform', 'rotate(180 ' + D_CX + ' ' + D_CY + ')');
    svg.appendChild(twin);

    svg.appendChild(medallion(rank));
    panel.appendChild(svg);

    var letter = el('span', 'card__court-letter');
    letter.textContent = rankLabel;
    panel.appendChild(letter);
    return panel;
  }

  // The ace of spades gets the oversized treatment every printed deck gives it —
  // it is where deck designers traditionally show off — in the same deco
  // language as the courts: the frame, a stepped crest above and below, and one
  // big spade sitting where the rank letter would be.
  function buildAceOfSpades(suitKey) {
    var panel = el('div', 'card__court card__court--ace');
    var svg = decoSvg();
    decoFrame(svg);

    // The King's ziggurat, under a brass lozenge. Reusing the courts' vocabulary
    // is deliberate: the ace should read as the same deck showing off, not as a
    // second idea that wandered in.
    var crest = svgEl('g');
    crest.appendChild(poly('polygon', 'card__deco-solid', [
      [36, 43], [36, 38], [40, 38], [40, 33], [45, 33], [45, 28],
      [55, 28], [55, 33], [60, 33], [60, 38], [64, 38], [64, 43]
    ]));
    crest.appendChild(poly('polygon', 'card__deco-brass', [[50, 17], [54.5, 21.5], [50, 26], [45.5, 21.5]]));
    svg.appendChild(crest);
    var twin = crest.cloneNode(true);
    twin.setAttribute('transform', 'rotate(180 ' + D_CX + ' ' + D_CY + ')');
    svg.appendChild(twin);

    // The court medallion, oversized, with the spade standing where a rank
    // letter would.
    svg.appendChild(poly('polygon', 'card__deco-ground-face', octagon(23.5, 8)));
    svg.appendChild(poly('polygon', 'card__deco-rule', octagon(23.5, 8)));
    svg.appendChild(poly('polygon', 'card__deco-brass', octagon(21, 7)));
    svg.appendChild(decoPip(suitKey, D_CX, D_CY, 38));
    panel.appendChild(svg);
    return panel;
  }

  function buildFront(card) {
    var face = el('div', 'card__face card__face--front');
    if (!card) return face; // blank stock, used by createBack

    var rankLabel = RANK_LABELS[card.rank - 1];
    var suitKey = suitKeyOf(card);

    face.appendChild(buildIndex(rankLabel, suitKey, 'tl'));
    face.appendChild(buildIndex(rankLabel, suitKey, 'br'));
    if (card.rank >= 11) {
      face.appendChild(buildCourt(rankLabel, suitKey, card.rank));
    } else if (card.rank === 1 && suitKey === 'S') {
      face.appendChild(buildAceOfSpades(suitKey));
    } else {
      face.appendChild(buildPips(card.rank, suitKey));
    }
    return face;
  }

  function buildBack() {
    var face = el('div', 'card__face card__face--back');
    face.appendChild(el('span', 'card__back-field'));
    return face;
  }

  function cardLabel(card) {
    return RANK_WORDS[card.rank - 1] + ' of ' + SUIT_WORDS[
      typeof card.suit === 'number' ? card.suit : SUIT_KEYS.indexOf(suitKeyOf(card))
    ];
  }

  // --- Public: card construction --------------------------------------------

  function build(card, opts) {
    opts = opts || {};
    ensureDefs(document);

    var interactive = !!opts.interactive;
    // Interactive cards are real buttons so they are tab-reachable and fire on
    // Enter/Space for free; static cards stay divs so the deck and the crib do
    // not litter the tab order.
    var node = el(interactive ? 'button' : 'div', 'card');
    if (interactive) {
      node.type = 'button';
      node.classList.add('card--interactive');
    } else {
      node.setAttribute('role', 'img');
    }

    if (card) {
      node.setAttribute('data-card-id', String(card.id));
      node.setAttribute('data-rank', String(card.rank));
      node.setAttribute('data-rank-label', RANK_LABELS[card.rank - 1]);
      node.setAttribute('data-suit', suitKeyOf(card));
      node.setAttribute('data-label', cardLabel(card));
    } else {
      node.setAttribute('data-label', 'Face-down card');
    }

    var inner = el('div', 'card__inner');
    inner.appendChild(buildFront(card));
    inner.appendChild(buildBack());
    node.appendChild(inner);

    setFaceDown(node, !!opts.faceDown || !card);
    if (opts.selected) setSelected(node, true);
    if (opts.disabled) setDisabled(node, true);
    if (opts.highlighted) setHighlighted(node, true);
    return node;
  }

  function createCard(card, opts) {
    if (!card || typeof card.rank !== 'number') {
      throw new Error('createCard: expected a card object from Cribbage.Cards');
    }
    return build(card, opts);
  }

  // An anonymous face-down card with no rank or suit in the DOM at all — the
  // only honest way to show the opponent's hand, since a real card turned over
  // would still be sitting there in the markup for anyone who opens devtools.
  //
  // There is no back-colour argument and there must never be one again. Both
  // players draw from ONE deck, so the back is a single global choice: it comes
  // from --card-back / --card-back-dark, which theme.css resolves from
  // [data-deck-back] on the document root. To show the four options side by side
  // the styleguide wraps a demo card in an element carrying that same attribute;
  // the tokens inherit, so nothing has to be threaded through this file.
  function createBack(opts) {
    // Tolerates the old createBack('red') call so the game keeps rendering while
    // render.js is updated; the colour argument is simply thrown away.
    return build(null, (opts && typeof opts === 'object') ? opts : {});
  }

  // --- Public: state setters -------------------------------------------------

  function setFaceDown(node, on) {
    if (!node) return node;
    on = !!on;
    node.classList.toggle('card--face-down', on);
    node.setAttribute('data-face-down', on ? 'true' : 'false');
    // The label has to follow the face: announcing "Five of Hearts" for a card
    // the player cannot see would leak the deck.
    node.setAttribute('aria-label', on ? 'Face-down card' : (node.getAttribute('data-label') || 'Card'));
    return node;
  }

  function setSelected(node, on) {
    if (!node) return node;
    on = !!on;
    node.classList.toggle('card--selected', on);
    node.setAttribute('data-selected', on ? 'true' : 'false');
    // Selection is a toggle, so aria-pressed is the honest mapping; the raised
    // position carries the same information without relying on colour.
    if (node.tagName === 'BUTTON') node.setAttribute('aria-pressed', on ? 'true' : 'false');
    return node;
  }

  function setDisabled(node, on) {
    if (!node) return node;
    on = !!on;
    node.classList.toggle('card--disabled', on);
    node.setAttribute('aria-disabled', on ? 'true' : 'false');
    if (node.tagName === 'BUTTON') node.disabled = on;
    return node;
  }

  function setHighlighted(node, on) {
    if (!node) return node;
    on = !!on;
    node.classList.toggle('card--highlighted', on);
    node.setAttribute('data-highlighted', on ? 'true' : 'false');
    return node;
  }

  root.Cribbage = root.Cribbage || {};
  root.Cribbage.RenderCards = {
    DEFS_ID: DEFS_ID,
    PIP_LAYOUT: PIP_LAYOUT,
    suitDefs: suitDefs,
    ensureDefs: ensureDefs,
    createCard: createCard,
    createBack: createBack,
    setFaceDown: setFaceDown,
    setSelected: setSelected,
    setDisabled: setDisabled,
    setHighlighted: setHighlighted
  };
})(typeof window !== 'undefined' ? window : globalThis);
