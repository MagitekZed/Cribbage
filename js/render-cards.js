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

  function buildCourt(rankLabel, suitKey) {
    var panel = el('div', 'card__court');
    panel.appendChild(el('span', 'card__court-rule card__court-rule--outer'));
    panel.appendChild(el('span', 'card__court-rule card__court-rule--inner'));

    var corners = ['tl', 'tr', 'bl', 'br'];
    for (var i = 0; i < corners.length; i++) {
      panel.appendChild(el('span', 'card__court-fleur card__court-fleur--' + corners[i]));
    }

    panel.appendChild(pipGlyph(suitKey, 'card__court-pip card__court-pip--top'));
    var letter = el('span', 'card__court-letter');
    letter.textContent = rankLabel;
    panel.appendChild(letter);
    panel.appendChild(pipGlyph(suitKey, 'card__court-pip card__court-pip--bottom'));
    return panel;
  }

  function buildFront(card) {
    var face = el('div', 'card__face card__face--front');
    if (!card) return face; // blank stock, used by createBack

    var rankLabel = RANK_LABELS[card.rank - 1];
    var suitKey = suitKeyOf(card);

    face.appendChild(buildIndex(rankLabel, suitKey, 'tl'));
    face.appendChild(buildIndex(rankLabel, suitKey, 'br'));
    face.appendChild(card.rank >= 11 ? buildCourt(rankLabel, suitKey) : buildPips(card.rank, suitKey));
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

    var back = opts.back === 'blue' ? 'blue' : 'red';
    node.setAttribute('data-back', back);

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

  function createBack(which) {
    return build(null, { back: which, faceDown: true });
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
