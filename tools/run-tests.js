#!/usr/bin/env node
'use strict';

// Node CLI driver for the cribbage engine test suite.
//
// The js/*.js files are classic browser scripts (no module syntax), so they are read
// off disk and evaluated with vm.runInThisContext rather than require()d. That keeps a
// single copy of the engine serving both file:// in a browser and this runner.
//
//   node tools/run-tests.js               fast suite
//   node tools/run-tests.js --exhaustive  adds the full C(52,5) enumeration
//   node tools/run-tests.js --verbose     prints every passing assertion

var fs = require('fs');
var vm = require('vm');
var path = require('path');

var argv = process.argv.slice(2);
var options = {
  exhaustive: argv.indexOf('--exhaustive') !== -1,
  verbose: argv.indexOf('--verbose') !== -1
};

if (argv.indexOf('--help') !== -1 || argv.indexOf('-h') !== -1) {
  console.log('Usage: node tools/run-tests.js [--exhaustive] [--verbose]');
  process.exit(0);
}

var unknown = argv.filter(function (a) {
  return ['--exhaustive', '--verbose', '--help', '-h'].indexOf(a) === -1;
});
if (unknown.length) {
  console.error('Unknown flag(s): ' + unknown.join(' '));
  console.error('Usage: node tools/run-tests.js [--exhaustive] [--verbose]');
  process.exit(1);
}

var projectRoot = path.resolve(__dirname, '..');
var files = [
  'js/cards.js',
  'js/scoring.js',
  'js/scoring-naive.js',
  'js/tests.js'
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

function log(line) {
  console.log(line);
}

console.log('');
console.log('Cribbage engine test suite');
console.log('  show cases: ' + globalThis.Cribbage.Tests.showCaseCount +
  '   play sequences: ' + globalThis.Cribbage.Tests.playCaseCount +
  (options.exhaustive ? '   + exhaustive enumeration' : ''));
console.log('');

var started = Date.now();
var result = globalThis.Cribbage.Tests.run({
  exhaustive: options.exhaustive,
  verbose: options.verbose,
  log: log
});
var elapsed = ((Date.now() - started) / 1000).toFixed(2);

var failures = result.results.filter(function (r) { return !r.ok; });

console.log('');
if (failures.length) {
  console.log('FAILURES (' + failures.length + '):');
  failures.forEach(function (f, i) {
    console.log('');
    console.log('  ' + (i + 1) + ') ' + f.name);
    console.log('     expected: ' + JSON.stringify(f.expected));
    console.log('     actual:   ' + JSON.stringify(f.actual));
    if (f.detail) console.log('     ' + f.detail);
  });
  console.log('');
}

console.log('----------------------------------------------------------');
console.log('  ' + result.passed + ' passed, ' + result.failed + ' failed   (' +
  elapsed + 's)');
console.log('----------------------------------------------------------');
console.log('');

process.exit(result.failed === 0 ? 0 : 1);
