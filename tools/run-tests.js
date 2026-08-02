#!/usr/bin/env node
'use strict';

// Node CLI driver for the cribbage test suites.
//
// The js/*.js files are classic browser scripts (no module syntax), so they are read
// off disk and evaluated with vm.runInThisContext rather than require()d. That keeps a
// single copy of the engine serving both file:// in a browser and this runner.
//
//   node tools/run-tests.js               fast suites (scoring + engine)
//   node tools/run-tests.js --exhaustive  adds the full C(52,5) enumeration
//   node tools/run-tests.js --games=N     engine fuzz volume (default 2000)
//   node tools/run-tests.js --verbose     prints every passing assertion

var fs = require('fs');
var vm = require('vm');
var path = require('path');

var argv = process.argv.slice(2);
var options = {
  exhaustive: argv.indexOf('--exhaustive') !== -1,
  verbose: argv.indexOf('--verbose') !== -1,
  games: 2000
};

function usage() {
  return 'Usage: node tools/run-tests.js [--exhaustive] [--games=N] [--verbose]';
}

if (argv.indexOf('--help') !== -1 || argv.indexOf('-h') !== -1) {
  console.log(usage());
  process.exit(0);
}

var unknown = [];
argv.forEach(function (a) {
  if (['--exhaustive', '--verbose', '--help', '-h'].indexOf(a) !== -1) return;
  var m = /^--games=(\d+)$/.exec(a);
  if (m) {
    options.games = parseInt(m[1], 10);
    return;
  }
  unknown.push(a);
});
if (unknown.length) {
  console.error('Unknown flag(s): ' + unknown.join(' '));
  console.error(usage());
  process.exit(1);
}

var projectRoot = path.resolve(__dirname, '..');
var files = [
  'js/cards.js',
  'js/scoring.js',
  'js/scoring-naive.js',
  'js/engine.js',
  'js/tests.js',
  'js/engine-tests.js',
  // animate.js is a browser script but touches no DOM until create() is called,
  // and its suite injects its own document, so both load cleanly under Node.
  'js/animate.js',
  'js/animate-tests.js'
];

files.forEach(function (relative) {
  var full = path.join(projectRoot, relative);
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
    console.error('Error evaluating ' + relative + ':\n' + (err && err.stack || err));
    process.exit(1);
  }
});

if (!globalThis.Cribbage || !globalThis.Cribbage.Tests) {
  console.error('js/tests.js did not register Cribbage.Tests');
  process.exit(1);
}
if (!globalThis.Cribbage.EngineTests) {
  console.error('js/engine-tests.js did not register Cribbage.EngineTests');
  process.exit(1);
}
if (!globalThis.Cribbage.AnimateTests) {
  console.error('js/animate-tests.js did not register Cribbage.AnimateTests');
  process.exit(1);
}

function log(line) {
  console.log(line);
}

console.log('');
console.log('Cribbage test suites');
console.log('  scoring — show cases: ' + globalThis.Cribbage.Tests.showCaseCount +
  '   play sequences: ' + globalThis.Cribbage.Tests.playCaseCount +
  (options.exhaustive ? '   + exhaustive enumeration' : ''));
console.log('  engine  — flow cases + ' + options.games + ' fuzzed games');
console.log('');

var suites = [];
var started = Date.now();

console.log('  [scoring]');
var scoringStarted = Date.now();
var scoring = globalThis.Cribbage.Tests.run({
  exhaustive: options.exhaustive,
  verbose: options.verbose,
  log: log
});
suites.push({
  name: 'scoring',
  result: scoring,
  elapsed: (Date.now() - scoringStarted) / 1000
});

console.log('');
console.log('  [engine]');
var engineStarted = Date.now();
var engine = globalThis.Cribbage.EngineTests.run({
  games: options.games,
  verbose: options.verbose,
  log: log
});
suites.push({
  name: 'engine',
  result: engine,
  elapsed: (Date.now() - engineStarted) / 1000
});

// The animation queue is asynchronous, so unlike the other two this suite hands
// back a promise. Everything downstream of it therefore has to wait.
console.log('');
console.log('  [animate]');
var animateStarted = Date.now();
globalThis.Cribbage.AnimateTests.run({
  verbose: options.verbose,
  log: log
}).then(function (animate) {
  suites.push({
    name: 'animate',
    result: animate,
    elapsed: (Date.now() - animateStarted) / 1000
  });
  report();
}, function (err) {
  console.error('The animate suite rejected:\n' + ((err && err.stack) || err));
  process.exit(1);
});

function report() {
  var elapsed = ((Date.now() - started) / 1000).toFixed(2);

  var passed = 0;
  var failed = 0;
  suites.forEach(function (s) {
    passed += s.result.passed;
    failed += s.result.failed;
  });

  console.log('');
  suites.forEach(function (s) {
    var failures = s.result.results.filter(function (r) { return !r.ok; });
    if (!failures.length) return;
    console.log('FAILURES in the ' + s.name + ' suite (' + failures.length + '):');
    failures.forEach(function (f, i) {
      console.log('');
      console.log('  ' + (i + 1) + ') ' + f.name);
      console.log('     expected: ' + JSON.stringify(f.expected));
      console.log('     actual:   ' + JSON.stringify(f.actual));
      if (f.detail) console.log('     ' + f.detail);
    });
    console.log('');
  });

  console.log('----------------------------------------------------------');
  suites.forEach(function (s) {
    console.log('  ' + (s.name + '          ').slice(0, 9) + ' ' +
      String(s.result.passed).padStart(6, ' ') + ' passed, ' + s.result.failed +
      ' failed   (' + s.elapsed.toFixed(2) + 's)');
  });
  console.log('  ' + 'total    ' + String(passed).padStart(6, ' ') + ' passed, ' + failed +
    ' failed   (' + elapsed + 's)');
  console.log('----------------------------------------------------------');
  console.log('');

  process.exit(failed === 0 ? 0 : 1);
}
