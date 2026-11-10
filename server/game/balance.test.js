// The hunt matters: whole matches against the computer's boat, played by scripted players
// (playtest.js), on fixed seeds. Charging in at Full loses on Normal; a careful hunt wins there;
// a first-timer at the helm wins on Easy; Hard is harder than Normal.
// `node server/game/playtest.js 100` prints the whole table.
const test = require('node:test');
const assert = require('node:assert');
const { winRate, seedsFor } = require('./playtest');

const SEEDS = seedsFor(30);
const rate = (style, skill) => winRate({ style, skill, seeds: SEEDS }).rate;

test('on Normal, charging in at Full loses, and so does rushing in to ping and shoot point-blank', () => {
  assert.ok(rate('charge', 'normal') <= 0.1, 'charge');
  assert.ok(rate('rush', 'normal') <= 0.15, 'rush');
});

test('on Normal, a careful hunt wins more often than not', () => {
  assert.ok(rate('careful', 'normal') >= 0.55);
});

test('on Easy, a first-timer at the helm wins, and a careful hunt nearly always does', () => {
  assert.ok(rate('novice', 'easy') >= 0.8, 'first-timer');
  assert.ok(rate('careful', 'easy') >= 0.9, 'careful');
});

test('Hard is harder than Normal for the same careful crew', () => {
  assert.ok(rate('careful', 'hard') < rate('careful', 'normal') - 0.1);
});
