/**
 * mine-slider.test.js - the Mines slider on a template map (K, 2026-10-04: the slider adjusts around the default for the map and
 * template, as the Neutral town slider does). A zone's template mines times the slider; 1x leaves them as they are.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { scaledMines } = require('../src/biome/plan');

const zone = { wood: 1, ore: 1, gold: 1, gems: 1 };
const total = m => Object.values(m).reduce((a, b) => a + b, 0);

test('1x leaves the template mines as they are', () => {
	assert.strictEqual(scaledMines(zone, 1), zone);
});

test('0 takes every mine, 2x doubles, 0.5x halves without rounding each one up', () => {
	assert.strictEqual(total(scaledMines(zone, 0)), 0);
	assert.strictEqual(total(scaledMines(zone, 2)), 8);
	assert.strictEqual(total(scaledMines(zone, 0.5)), 2);
});

test('a zone with no mines, or a slider that is not a number, is left alone', () => {
	assert.strictEqual(scaledMines(null, 2), null);
	assert.strictEqual(scaledMines(zone, undefined), zone);
});

test('the fraction left over carries to the next resource', () => {
	const m = scaledMines({ wood: 1, ore: 1, sulfur: 1 }, 1.5);
	assert.strictEqual(total(m), 4);
});
