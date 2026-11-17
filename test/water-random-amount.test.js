/**
 * water-random-amount.test.js - Water content Random also draws the amount of water, 20% to 60%, from the map's seed (K, 2026-11-16, S278:
 * "would like for 'Random' water content to also mean that the 'amount of water' is effectively randomized between 20% and 60%").
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const stock = require('../src/main/stockChoices');

const opts = { islandsShape: 5, defaultCoverage: 0.2 };
const run = (b, seed) => { stock.applyWaterContent(b, stock.roller(seed), opts); return b; };

test('Random water content: the amount is 20% to 60% in steps of 5, or 0 when the dice say None; the lever is not read', () => {
	const seen = new Set();
	let none = 0;
	for (let seed = 1; seed <= 400; seed++) {
		const b = run({ waterContent: -1, waterCoverage: 0.05, waterShape: 1 }, seed);
		if (b.waterCoverage === 0) { none++; continue; }
		const pct = Math.round(b.waterCoverage * 100);
		assert.ok(pct >= 20 && pct <= 60 && pct % 5 === 0, `amount ${pct} for seed ${seed}`);
		seen.add(pct);
	}
	assert.strictEqual(seen.size, 9, 'every step 20, 25 ... 60 turns up: ' + [...seen].sort((a, b) => a - b).join(','));
	assert.ok(none > 80 && none < 190, `None is about a third of the draws, got ${none} of 400`);
});

test('the same seed gives the same amount, and Normal or Islands chosen on purpose keep the lever', () => {
	assert.strictEqual(run({ waterContent: -1, waterCoverage: 0.3, waterShape: 1 }, 77).waterCoverage, run({ waterContent: -1, waterCoverage: 0.55, waterShape: 1 }, 77).waterCoverage);
	assert.strictEqual(run({ waterContent: 1, waterCoverage: 0.35, waterShape: 1 }, 77).waterCoverage, 0.35);
	assert.strictEqual(run({ waterContent: 2, waterCoverage: 0.4, waterShape: 1 }, 77).waterCoverage, 0.4);
});

test('VMAPGEN_WATER_RANDOM_AMOUNT=0 keeps the lever under Random', () => {
	process.env.VMAPGEN_WATER_RANDOM_AMOUNT = '0';
	try {
		for (let seed = 1; seed <= 20; seed++) {
			const b = run({ waterContent: -1, waterCoverage: 0.33, waterShape: 1 }, seed);
			assert.ok(b.waterCoverage === 0 || b.waterCoverage === 0.33);
		}
	} finally { delete process.env.VMAPGEN_WATER_RANDOM_AMOUNT; }
});
