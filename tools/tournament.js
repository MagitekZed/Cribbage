#!/usr/bin/env node
'use strict';

// tools/tournament.js — the AI tiers, played off against each other at volume.
//
// A win rate on its own is nearly worthless: a cribbage game is mostly cards, and a
// few thousand independent games only just resolve a two-point-per-game skill gap.
// So the default is MIRRORED PAIRS. Every pair of games uses one seeded sequence of
// decks and plays it twice with the seats swapped, which means each side gets the
// identical cards in the identical role, with the identical dealer sequence. What is
// left over the pair is the play, which is the only thing being measured.
//
// Confidence intervals are therefore taken over PAIRS, not games — the two games of a
// pair are not independent, and treating them as if they were would quote an interval
// about 30% too narrow.
//
//   node tools/tournament.js --matchup=hard-vs-normal --games=2000
//   node tools/tournament.js --all --games=2000
//   node tools/tournament.js --matchup=hard-vs-hard --unpaired --games=4000
//
// The harness is allowed to read the whole engine state — it is the scorekeeper, not a
// player. The AI still only ever sees what game.js hands it: its own hand, whose crib
// it is, and the snapshot it is expected to narrow for itself.

var fs = require('fs');
var vm = require('vm');
var path = require('path');

var projectRoot = path.resolve(__dirname, '..');

// ------------------------------------------------------------------ arguments ---

var LEVELS = ['easy', 'normal', 'hard'];

var ALL_MATCHUPS = [
  ['hard', 'normal'],
  ['hard', 'easy'],
  ['normal', 'easy'],
  ['hard', 'hard'],
  ['normal', 'normal'],
  ['easy', 'easy']
];

function usage() {
  return [
    'Usage: node tools/tournament.js [options]',
    '',
    '  --matchup=X-vs-Y   tiers to play off; easy | normal | hard (default hard-vs-normal)',
    '  --all              every matchup: the three pairings and each tier against itself',
    '  --games=N          games per matchup (default 2000; rounded up to an even number',
    '                     in paired mode, since games are played in mirrored pairs)',
    '  --seed=N           base seed for the deals (default 20260803)',
    '  --target=N         121 (default) or 61',
    '  --unpaired         independent deals instead of mirrored pairs. Slower to',
    '                     converge, but the only way a deterministic tier can be played',
    '                     against itself informatively — see the note in the report.',
    '  --samples=N        override the hard tier crib sample count at the lay-away',
    '  --play-samples=N   override the hard tier imagined-hand count at the peg',
    '  --baseline=PATH    load a second copy of ai.js from PATH and use it for side Y.',
    '                     Lets a tuned tier be measured against a frozen one on exactly',
    '                     the same deals.',
    '  --json             machine-readable output',
    '  --quiet            one summary line per matchup',
    '  --help'
  ].join('\n');
}

var argv = process.argv.slice(2);
var options = {
  matchups: null,
  games: 2000,
  seed: 20260803,
  target: 121,
  paired: true,
  samples: null,
  playSamples: null,
  baseline: null,
  json: false,
  quiet: false
};

if (argv.indexOf('--help') !== -1 || argv.indexOf('-h') !== -1) {
  console.log(usage());
  process.exit(0);
}

var unknown = [];
argv.forEach(function (a) {
  var m;
  if (a === '--all') {
    options.matchups = ALL_MATCHUPS.slice();
    return;
  }
  if (a === '--unpaired') {
    options.paired = false;
    return;
  }
  if (a === '--json') {
    options.json = true;
    return;
  }
  if (a === '--quiet') {
    options.quiet = true;
    return;
  }
  m = /^--matchup=(.+)$/.exec(a);
  if (m) {
    var parts = m[1].toLowerCase().split(/-vs-|:|,/);
    if (parts.length !== 2 || LEVELS.indexOf(parts[0]) < 0 || LEVELS.indexOf(parts[1]) < 0) {
      console.error('Bad matchup "' + m[1] + '"; expected something like hard-vs-normal');
      process.exit(1);
    }
    options.matchups = [[parts[0], parts[1]]];
    return;
  }
  m = /^--games=(\d+)$/.exec(a);
  if (m) {
    options.games = parseInt(m[1], 10);
    return;
  }
  m = /^--seed=(\d+)$/.exec(a);
  if (m) {
    options.seed = parseInt(m[1], 10);
    return;
  }
  m = /^--target=(\d+)$/.exec(a);
  if (m) {
    options.target = parseInt(m[1], 10);
    return;
  }
  m = /^--samples=(\d+)$/.exec(a);
  if (m) {
    options.samples = parseInt(m[1], 10);
    return;
  }
  m = /^--play-samples=(\d+)$/.exec(a);
  if (m) {
    options.playSamples = parseInt(m[1], 10);
    return;
  }
  m = /^--baseline=(.+)$/.exec(a);
  if (m) {
    options.baseline = path.resolve(process.cwd(), m[1]);
    return;
  }
  unknown.push(a);
});

if (unknown.length) {
  console.error('Unknown flag(s): ' + unknown.join(' '));
  console.error(usage());
  process.exit(1);
}
if (!options.matchups) options.matchups = [['hard', 'normal']];
if (options.games < 1) {
  console.error('--games must be at least 1');
  process.exit(1);
}
if (options.paired && options.games % 2 === 1) options.games++;

// -------------------------------------------------------------------- loading ---

function load(relative) {
  var full = path.isAbsolute(relative) ? relative : path.join(projectRoot, relative);
  var source;
  try {
    source = fs.readFileSync(full, 'utf8');
  } catch (err) {
    console.error('Could not read ' + relative + ': ' + err.message);
    process.exit(1);
  }
  try {
    vm.runInThisContext(source, { filename: full });
  } catch (err) {
    console.error('Error evaluating ' + relative + ':\n' + ((err && err.stack) || err));
    process.exit(1);
  }
}

['js/cards.js', 'js/scoring.js', 'js/engine.js', 'js/ai.js'].forEach(load);

var Cards = globalThis.Cribbage.Cards;
var Scoring = globalThis.Cribbage.Scoring;
var Engine = globalThis.Cribbage.Engine;
var AI = globalThis.Cribbage.AI;

// A baseline copy registers itself over Cribbage.AI, so it is captured and the real one
// put back. Both are then just objects with a create().
var BaselineAI = AI;
if (options.baseline) {
  load(options.baseline);
  BaselineAI = globalThis.Cribbage.AI;
  globalThis.Cribbage.AI = AI;
  if (BaselineAI === AI) {
    console.error('--baseline did not register a second Cribbage.AI');
    process.exit(1);
  }
}

// -------------------------------------------------------------------- plumbing ---

function mulberry32(seed) {
  var a = (seed >>> 0) || 0x9e3779b9;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    var t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mix(a, b) {
  var h = (a ^ Math.imul((b + 0x9e3779b9) | 0, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

function now() {
  return Number(process.hrtime.bigint()) / 1e6;
}

// The engine wants an rng for the cut for deal; every game here is dealt with an
// explicit dealer, so it is never called.
function unusedRng() {
  return 0.5;
}

function pad(s, n) {
  s = String(s);
  while (s.length < n) s += ' ';
  return s;
}

function padl(s, n) {
  s = String(s);
  while (s.length < n) s = ' ' + s;
  return s;
}

function pct(x) {
  return (x * 100).toFixed(2) + '%';
}

function signed(x, digits) {
  return (x >= 0 ? '+' : '') + x.toFixed(digits === undefined ? 2 : digits);
}

/**
 * meanCI(values) -> { mean, half, sd, n }
 *
 * A plain normal-approximation interval over whatever unit the caller chose. The
 * choice of unit is the part that matters: in paired mode one MIRRORED PAIR is one
 * observation, because the two games in it share their deals and are correlated.
 */
function meanCI(values) {
  var n = values.length;
  if (!n) return { mean: 0, half: 0, sd: 0, n: 0 };
  var sum = 0;
  var i;
  for (i = 0; i < n; i++) sum += values[i];
  var mean = sum / n;
  var ss = 0;
  for (i = 0; i < n; i++) {
    var d = values[i] - mean;
    ss += d * d;
  }
  var sd = n > 1 ? Math.sqrt(ss / (n - 1)) : 0;
  return { mean: mean, half: 1.96 * sd / Math.sqrt(n), sd: sd, n: n };
}

// ------------------------------------------------------------------ statistics ---

function newRole(level) {
  return {
    level: level,
    handsAsDealer: 0,
    handsAsPone: 0,
    showDealer: 0,
    showPone: 0,
    crib: 0,
    cribHands: 0,
    pegDealer: 0,
    pegPone: 0,
    pegDealerHands: 0,
    pegPoneHands: 0,
    heels: 0
  };
}

function newStats(levels) {
  return {
    levels: levels.slice(),
    games: 0,
    hands: 0,
    wins: [0, 0],
    skunks: [{ skunk: 0, double: 0 }, { skunk: 0, double: 0 }],
    firstDealerWins: 0,
    unitWins: [],
    unitMargins: [],
    role: [newRole(levels[0]), newRole(levels[1])],
    problems: 0,
    timing: {}
  };
}

function noteTiming(stats, level, kind, ms) {
  var key = level + '.' + kind;
  var t = stats.timing[key];
  if (!t) {
    t = { level: level, kind: kind, n: 0, sum: 0, max: 0 };
    stats.timing[key] = t;
  }
  t.n++;
  t.sum += ms;
  if (ms > t.max) t.max = ms;
}

function newHandAcc(dealer) {
  return {
    dealer: dealer,
    pegging: [0, 0],
    heels: [0, 0],
    handValue: null,
    cribValue: 0,
    playComplete: false
  };
}

function flushHand(stats, acc, roleOfSeat) {
  stats.hands++;
  for (var seat = 0; seat < 2; seat++) {
    var r = stats.role[roleOfSeat[seat]];
    var isDealer = seat === acc.dealer;
    if (acc.handValue) {
      // Taken at the cut, off showHands, so it counts every hand that reached the
      // play — including the one the game ended in the middle of. Reading it off the
      // score events instead would quietly drop the biggest hands, which are exactly
      // the ones that end games.
      if (isDealer) {
        r.handsAsDealer++;
        r.showDealer += acc.handValue[seat];
        r.crib += acc.cribValue;
        r.cribHands++;
      } else {
        r.handsAsPone++;
        r.showPone += acc.handValue[seat];
      }
    }
    if (acc.playComplete) {
      // Pegging only from hands whose play ran to the end; a hand cut short by the
      // win would otherwise read as a hand where nobody pegged.
      if (isDealer) {
        r.pegDealer += acc.pegging[seat];
        r.pegDealerHands++;
      } else {
        r.pegPone += acc.pegging[seat];
        r.pegPoneHands++;
      }
    }
    r.heels += acc.heels[seat];
  }
}

// ------------------------------------------------------------------- one game ---

function findDiscard(legal, pair) {
  if (!pair || pair.length !== 2 || !pair[0] || !pair[1]) return null;
  for (var i = 0; i < legal.length; i++) {
    var ids = [legal[i].cards[0].id, legal[i].cards[1].id];
    if ((ids[0] === pair[0].id && ids[1] === pair[1].id) ||
      (ids[1] === pair[0].id && ids[0] === pair[1].id)) return legal[i];
  }
  return null;
}

/**
 * playGame(spec) -> { winner, scores, skunk, hands }
 *
 * Drives the engine exactly the way js/game.js does — same call shape, same arguments,
 * same "whatever it hands back is checked against legalActions()" — so a tournament
 * result is a statement about the code that actually ships.
 */
function playGame(spec, stats) {
  var seatAI = spec.seatAI;
  var levelOfSeat = spec.levelOfSeat;
  var roleOfSeat = spec.roleOfSeat;
  var game = Engine.createGame({
    dealer: 0,
    deck: spec.deckFn,
    targetScore: spec.target,
    rng: unusedRng
  });

  var acc = null;
  var guard = 0;

  function noteEvents(events) {
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (e.type === 'deal') {
        if (acc) flushHand(stats, acc, roleOfSeat);
        acc = newHandAcc(e.dealer);
      } else if (e.type === 'starter' && acc) {
        var snap = game.getState();
        if (snap.showHands[0].length === 4 && snap.showHands[1].length === 4) {
          acc.handValue = [
            Scoring.scoreHand(snap.showHands[0], snap.starter, false).total,
            Scoring.scoreHand(snap.showHands[1], snap.starter, false).total
          ];
          acc.cribValue = Scoring.scoreHand(snap.crib, snap.starter, true).total;
        }
      } else if (e.type === 'score' && acc) {
        if (e.source === 'play') acc.pegging[e.player] += e.points;
        else if (e.source === 'heels') acc.heels[e.player] += e.points;
      } else if (e.type === 'phase' && e.to === 'SHOW_PONE' && acc) {
        acc.playComplete = true;
      }
    }
  }

  while (!game.isOver()) {
    if (++guard > 50000) {
      stats.problems++;
      break;
    }
    var actor = game.pendingActor();
    if (actor === null) {
      noteEvents(game.advance());
      continue;
    }
    var snapshot = game.getState();
    var legal = game.legalActions();
    var action;
    var started;

    if (snapshot.phase === 'DISCARD') {
      started = now();
      var pair = seatAI[actor].chooseDiscard(snapshot.hands[actor].slice(),
        snapshot.dealer === actor, snapshot);
      noteTiming(stats, levelOfSeat[actor], 'lay-away', now() - started);
      action = findDiscard(legal, pair);
      if (!action) {
        stats.problems++;
        action = legal[0];
      }
      noteEvents(game.apply(action));
      continue;
    }

    var cards = legal.map(function (a) { return a.card; });
    started = now();
    var card = seatAI[actor].choosePlay(cards, snapshot);
    noteTiming(stats, levelOfSeat[actor], 'play', now() - started);
    action = null;
    for (var i = 0; i < legal.length && !action; i++) {
      if (card && legal[i].card.id === card.id) action = legal[i];
    }
    if (!action) {
      stats.problems++;
      action = legal[0];
    }
    noteEvents(game.apply(action));
  }

  if (acc) flushHand(stats, acc, roleOfSeat);

  var final = game.getState();
  return { winner: final.winner, scores: final.scores, skunk: final.skunk };
}

// ---------------------------------------------------------------- the matchup ---

function makeDeckFn(seed) {
  return function (handNumber) {
    return Cards.shuffle(Cards.makeDeck(), mulberry32(mix(seed, handNumber)));
  };
}

function makeAI(level, role, gameIndex, base) {
  var factory = role === 1 ? BaselineAI : AI;
  var opts = { rng: mulberry32(mix(mix(base, gameIndex * 2 + 1), role * 7919 + 13)) };
  if (options.samples !== null) opts.cribSamples = options.samples;
  if (options.playSamples !== null) opts.playSamples = options.playSamples;
  return factory.create(level, opts);
}

function record(stats, result, roleOfSeat) {
  stats.games++;
  if (result.winner === null) {
    stats.problems++;
    return 0;
  }
  var winnerRole = roleOfSeat[result.winner];
  stats.wins[winnerRole]++;
  if (result.winner === 0) stats.firstDealerWins++;
  if (result.skunk === 'skunk') stats.skunks[winnerRole].skunk++;
  if (result.skunk === 'double') stats.skunks[winnerRole].double++;
  return winnerRole === 0 ? 1 : 0;
}

function marginFor(result, roleOfSeat) {
  var x = roleOfSeat[0] === 0 ? result.scores[0] : result.scores[1];
  var y = roleOfSeat[0] === 0 ? result.scores[1] : result.scores[0];
  return x - y;
}

function runMatchup(levels, opts) {
  var stats = newStats(levels);
  var started = now();
  var g;

  if (opts.paired) {
    var pairs = opts.games / 2;
    for (var p = 0; p < pairs; p++) {
      var deckFn = makeDeckFn(mix(opts.seed, p));
      var pairWins = 0;
      var pairMargin = 0;
      for (var side = 0; side < 2; side++) {
        // side 0: X at seat 0 (and so dealing first). side 1: the same deals with the
        // seats swapped, so Y gets the cards and the role X just had.
        var roleOfSeat = side === 0 ? [0, 1] : [1, 0];
        var levelOfSeat = [levels[roleOfSeat[0]], levels[roleOfSeat[1]]];
        var seatAI = [
          makeAI(levelOfSeat[0], roleOfSeat[0], p * 2 + side, opts.seed),
          makeAI(levelOfSeat[1], roleOfSeat[1], p * 2 + side, opts.seed)
        ];
        var result = playGame({
          seatAI: seatAI,
          levelOfSeat: levelOfSeat,
          roleOfSeat: roleOfSeat,
          deckFn: deckFn,
          target: opts.target
        }, stats);
        pairWins += record(stats, result, roleOfSeat);
        pairMargin += marginFor(result, roleOfSeat);
      }
      stats.unitWins.push(pairWins / 2);
      stats.unitMargins.push(pairMargin / 2);
      progress(stats.games, opts.games, started);
    }
  } else {
    for (g = 0; g < opts.games; g++) {
      var rs = g % 2 === 0 ? [0, 1] : [1, 0];
      var los = [levels[rs[0]], levels[rs[1]]];
      var res = playGame({
        seatAI: [makeAI(los[0], rs[0], g, opts.seed), makeAI(los[1], rs[1], g, opts.seed)],
        levelOfSeat: los,
        roleOfSeat: rs,
        deckFn: makeDeckFn(mix(opts.seed, 0x51ed ^ g)),
        target: opts.target
      }, stats);
      stats.unitWins.push(record(stats, res, rs));
      stats.unitMargins.push(marginFor(res, rs));
      progress(stats.games, opts.games, started);
    }
  }

  stats.elapsed = (now() - started) / 1000;
  return stats;
}

var lastTick = 0;
function progress(done, total, started) {
  if (options.json || options.quiet) return;
  if (!process.stderr.isTTY) return;
  var t = now();
  if (t - lastTick < 500 && done < total) return;
  lastTick = t;
  var rate = done / ((t - started) / 1000);
  var left = rate > 0 ? (total - done) / rate : 0;
  process.stderr.write('\r    ' + done + '/' + total + ' games, ' +
    rate.toFixed(0) + '/s, ~' + left.toFixed(0) + 's left    ');
  if (done >= total) process.stderr.write('\r' + pad('', 60) + '\r');
}

// ------------------------------------------------------------------- the report ---

function summarise(stats) {
  var win = meanCI(stats.unitWins);
  var margin = meanCI(stats.unitMargins);
  return { win: win, margin: margin };
}

function reportMatchup(stats) {
  var s = summarise(stats);
  var x = stats.levels[0];
  var y = stats.levels[1];
  var unit = options.paired ? 'mirrored pair' : 'game';

  if (options.quiet) {
    console.log(pad(x + ' vs ' + y, 20) + padl(stats.games, 6) + ' games   ' +
      padl(pct(s.win.mean), 8) + ' +/- ' + (s.win.half * 100).toFixed(2) +
      '   margin ' + signed(s.margin.mean, 2));
    return;
  }

  console.log('');
  console.log('  ' + x + ' vs ' + y + '  —  ' + stats.games + ' games' +
    (options.paired ? ' (' + (stats.games / 2) + ' mirrored pairs)' : ' (independent deals)') +
    ', target ' + options.target + ', seed ' + options.seed);
  console.log('  ' + new Array(66).join('-'));
  console.log('    wins            ' + pad(x, 8) + padl(stats.wins[0], 6) + '     ' +
    pad(y, 8) + padl(stats.wins[1], 6));
  console.log('    win rate        ' + pct(s.win.mean) + '   95% CI [' +
    pct(s.win.mean - s.win.half) + ', ' + pct(s.win.mean + s.win.half) + ']   (unit: ' +
    unit + ', n=' + s.win.n + ')');
  console.log('    mean margin     ' + signed(s.margin.mean) + '   95% CI [' +
    signed(s.margin.mean - s.margin.half) + ', ' + signed(s.margin.mean + s.margin.half) +
    ']   (' + x + ' minus ' + y + ')');
  console.log('    skunks          ' + x + ' skunked ' + y + ' in ' +
    pct((stats.skunks[0].skunk + stats.skunks[0].double) / stats.games) + ' of games (' +
    stats.skunks[0].double + ' double), ' + y + ' skunked ' + x + ' in ' +
    pct((stats.skunks[1].skunk + stats.skunks[1].double) / stats.games) + ' (' +
    stats.skunks[1].double + ' double)');
  console.log('    game length     ' + (stats.hands / stats.games).toFixed(2) + ' hands');
  console.log('    first dealer    won ' + pct(stats.firstDealerWins / stats.games) +
    ' of games');
  console.log('');
  console.log('    per hand              pegging    hand    crib   total');
  for (var role = 0; role < 2; role++) {
    var r = stats.role[role];
    var label = role === 0 ? x : y;
    var dealerHands = r.handsAsDealer || 1;
    var poneHands = r.handsAsPone || 1;
    var pegD = r.pegDealer / (r.pegDealerHands || 1);
    var pegP = r.pegPone / (r.pegPoneHands || 1);
    var showD = r.showDealer / dealerHands;
    var showP = r.showPone / poneHands;
    var crib = r.crib / (r.cribHands || 1);
    var heels = r.heels / dealerHands;
    console.log('      ' + pad(label, 8) + 'as dealer' + padl((pegD + heels).toFixed(2), 10) +
      padl(showD.toFixed(2), 8) + padl(crib.toFixed(2), 8) +
      padl((pegD + heels + showD + crib).toFixed(2), 8));
    console.log('      ' + pad('', 8) + 'as pone  ' + padl(pegP.toFixed(2), 10) +
      padl(showP.toFixed(2), 8) + padl('—', 8) + padl((pegP + showP).toFixed(2), 8));
  }

  console.log('');
  var keys = Object.keys(stats.timing).sort();
  console.log('    decision cost');
  keys.forEach(function (k) {
    var t = stats.timing[k];
    console.log('      ' + pad(t.level + ' ' + t.kind, 18) + padl(t.n, 9) + ' calls   mean ' +
      padl((t.sum / t.n).toFixed(3), 8) + 'ms   worst ' + padl(t.max.toFixed(3), 8) + 'ms');
  });
  if (stats.problems) {
    console.log('');
    console.log('    !! ' + stats.problems + ' illegal or unfinished decisions were seen');
  }
  console.log('    ' + stats.elapsed.toFixed(1) + 's');
}

function main() {
  var all = [];
  if (!options.json && !options.quiet) {
    console.log('');
    console.log('Cribbage AI tournament — ' + options.matchups.length + ' matchup(s), ' +
      options.games + ' games each, ' +
      (options.paired ? 'mirrored pairs' : 'independent deals') +
      (options.baseline ? ', side Y from ' + options.baseline : ''));
  }
  options.matchups.forEach(function (levels) {
    var stats = runMatchup(levels, options);
    all.push(stats);
    if (options.json) return;
    reportMatchup(stats);
  });

  if (options.json) {
    console.log(JSON.stringify(all.map(function (stats) {
      var s = summarise(stats);
      return {
        levels: stats.levels,
        games: stats.games,
        wins: stats.wins,
        winRate: s.win.mean,
        winRateCI: s.win.half,
        margin: s.margin.mean,
        marginCI: s.margin.half,
        handsPerGame: stats.hands / stats.games,
        firstDealerWinRate: stats.firstDealerWins / stats.games,
        skunks: stats.skunks,
        role: stats.role,
        timing: stats.timing,
        problems: stats.problems,
        elapsed: stats.elapsed
      };
    }), null, 2));
    return;
  }

  if (all.length > 1) {
    console.log('');
    console.log('  summary');
    console.log('  ' + new Array(66).join('-'));
    all.forEach(function (stats) {
      var s = summarise(stats);
      console.log('    ' + pad(stats.levels[0] + ' vs ' + stats.levels[1], 20) +
        padl(pct(s.win.mean), 8) + '  +/- ' + padl((s.win.half * 100).toFixed(2), 5) +
        '   margin ' + padl(signed(s.margin.mean), 7) +
        '   dealer ' + padl(pct(stats.firstDealerWins / stats.games), 7));
    });
  }
  console.log('');
}

main();
