(function (root) {
  'use strict';

  // Suit index is the low 2 bits of the card id, so SUITS order is load-bearing:
  // id = (rank - 1) * 4 + suit.
  var SUITS = ['S', 'H', 'D', 'C'];
  var SUIT_NAMES = ['spades', 'hearts', 'diamonds', 'clubs'];
  var SUIT_SYMBOLS = ['♠', '♥', '♦', '♣'];
  var RANK_LABELS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

  // Two distinct notions of rank live on every card and must never be conflated:
  //   rank  1..13 -> pairs, runs, nobs
  //   value 1..10 -> fifteens and the running play count
  function makeCard(rank, suit) {
    if (typeof rank !== 'number' || rank < 1 || rank > 13 || (rank | 0) !== rank) {
      throw new Error('makeCard: rank must be an integer 1..13, got ' + rank);
    }
    if (typeof suit !== 'number' || suit < 0 || suit > 3 || (suit | 0) !== suit) {
      throw new Error('makeCard: suit must be an integer 0..3, got ' + suit);
    }
    return {
      id: (rank - 1) * 4 + suit,
      rank: rank,
      suit: suit,
      value: rank < 10 ? rank : 10
    };
  }

  function cardFromId(id) {
    if (typeof id !== 'number' || id < 0 || id > 51 || (id | 0) !== id) {
      throw new Error('cardFromId: id must be an integer 0..51, got ' + id);
    }
    return makeCard(Math.floor(id / 4) + 1, id % 4);
  }

  function makeDeck() {
    var deck = [];
    for (var id = 0; id < 52; id++) deck.push(cardFromId(id));
    return deck;
  }

  // Returns a NEW array; the caller's deck is never touched. rng is injectable so
  // that games and AI simulations can be made deterministic under test.
  function shuffle(deck, rng) {
    var random = rng || Math.random;
    var out = deck.slice();
    for (var i = out.length - 1; i > 0; i--) {
      var j = Math.floor(random() * (i + 1));
      var tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }

  function rankName(rank) {
    return RANK_LABELS[rank - 1];
  }

  function suitName(suit) {
    return SUIT_NAMES[suit];
  }

  function suitSymbol(suit) {
    return SUIT_SYMBOLS[suit];
  }

  function cardName(card) {
    return rankName(card.rank) + SUITS[card.suit];
  }

  function isRed(card) {
    return card.suit === 1 || card.suit === 2;
  }

  // Accepts '5H', 'AS', '10D', 'TD' (T is an accepted alias for 10). Case-insensitive.
  function parseCard(str) {
    if (str && typeof str === 'object' && typeof str.id === 'number') return str;
    if (typeof str !== 'string') throw new Error('parseCard: expected a string, got ' + str);
    var s = str.trim().toUpperCase();
    if (s.length < 2) throw new Error('parseCard: cannot parse "' + str + '"');
    var suitChar = s.charAt(s.length - 1);
    var rankPart = s.slice(0, s.length - 1);
    var suit = SUITS.indexOf(suitChar);
    if (suit < 0) throw new Error('parseCard: bad suit in "' + str + '"');
    var rank;
    if (rankPart === 'T') rank = 10;
    else rank = RANK_LABELS.indexOf(rankPart) + 1;
    if (rank < 1) throw new Error('parseCard: bad rank in "' + str + '"');
    return makeCard(rank, suit);
  }

  // Convenience for tests and fixtures: 'AS 5H 5D 5C' or ['AS','5H',...].
  function parseCards(input) {
    var parts = Array.isArray(input) ? input : String(input).split(/[\s,]+/);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === '') continue;
      out.push(parseCard(parts[i]));
    }
    return out;
  }

  function cardNames(cards) {
    var out = [];
    for (var i = 0; i < cards.length; i++) out.push(cardName(cards[i]));
    return out.join(' ');
  }

  root.Cribbage = root.Cribbage || {};
  root.Cribbage.Cards = {
    SUITS: SUITS,
    SUIT_NAMES: SUIT_NAMES,
    SUIT_SYMBOLS: SUIT_SYMBOLS,
    RANK_LABELS: RANK_LABELS,
    makeCard: makeCard,
    cardFromId: cardFromId,
    makeDeck: makeDeck,
    shuffle: shuffle,
    rankName: rankName,
    suitName: suitName,
    suitSymbol: suitSymbol,
    cardName: cardName,
    cardNames: cardNames,
    parseCard: parseCard,
    parseCards: parseCards,
    isRed: isRed
  };
})(typeof window !== 'undefined' ? window : globalThis);
