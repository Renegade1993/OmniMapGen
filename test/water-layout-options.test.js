/**
 * water-layout-options.test.js - Water layout gets Random (7) and Template (8, the picker's default) beside Lakes to Archipelago
 * (0 to 6) (K, 2026-10-05: "water layout should have a option for random, and a option for template"), and content Islands and layout
 * Islands are one state.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const stock = require('../src/main/stockChoices');

const ISL = 5;
const run = (b, seed = 1) => { const roll = stock.roller(seed); stock.applyWaterContent(b, roll, { islandsShape: ISL, defaultCoverage: 0.2 }); return { b, roll }; };

test('Template (8) is Lakes, the template\'s own engine-style water', () => {
	assert.strictEqual(run({ waterShape: 8, waterContent: 1 }).b.waterShape, 0);
});

test('Random (7) picks one of the five land layouts from the seed, never islands, and reports it', () => {
	const seen = new Set();
	for (let s = 1; s <= 40; s++) {
		const { b, roll } = run({ waterShape: 7, waterContent: 1 }, s);
		assert.ok([0, 1, 2, 3, 4].includes(b.waterShape), `seed ${s} gave ${b.waterShape}`);
		assert.ok(roll.rolled.some(r => /^water layout /.test(r)));
		seen.add(b.waterShape);
		assert.strictEqual(run({ waterShape: 7, waterContent: 1 }, s).b.waterShape, b.waterShape, 'the same seed picks the same layout');
	}
	assert.ok(seen.size >= 4, `only ${[...seen]} seen in 40 seeds`);
});

test('content Islands with the default layout is Islands; layout Islands lifts content Normal to Islands', () => {
	assert.strictEqual(run({ waterShape: 8, waterContent: 2 }).b.waterShape, ISL);
	assert.strictEqual(run({ waterShape: 0, waterContent: 2 }).b.waterShape, ISL);
	const b = run({ waterShape: ISL, waterContent: 1 }).b;
	assert.strictEqual(b.waterContentMode, 2);
	assert.strictEqual(b.waterShape, ISL);
});

test('a land layout chosen on purpose puts content Islands back to Normal', () => {
	for (const sh of [1, 2, 3, 4]) {
		const b = run({ waterShape: sh, waterContent: 2 }).b;
		assert.strictEqual(b.waterContentMode, 1, `layout ${sh}`);
		assert.strictEqual(b.waterShape, sh);
	}
});

test('a layout other than Islands with content Normal stays as it is', () => {
	const b = run({ waterShape: 3, waterContent: 1 }).b;
	assert.strictEqual(b.waterShape, 3);
	assert.strictEqual(b.waterContentMode, 1);
});
