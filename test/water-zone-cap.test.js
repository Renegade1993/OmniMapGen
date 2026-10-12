/**
 * water-zone-cap.test.js - Normal water on a template keeps ground in every zone (K, 2026-10-10, 180x180 Coldshadow's Fantasy with Mediterranean
 * water at 45%: the middle zones were wet to 70% and two of them drowned, "extremely strange"). adoptWater takes the most of a zone the radius rule
 * may wet; buildAdoptedPlan tries 0.7 down to 0.55 until every zone of 60 cells or more keeps 40% land, the amount falling short when it must.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { adoptWater, buildAdoptedPlan, WATER_SHAPES } = require('../src/biome/water');
const { xorshift } = require('../src/wfc/solver');

const W = 120, H = 120;
const zoneOf = new Int32Array(W * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) zoneOf[y * W + x] = ((y / 30) | 0) * 4 + ((x / 30) | 0);
const shape = WATER_SHAPES.findIndex(s => s.id === 'mediterranean');

const wetShare = mask => {
	const wet = new Array(16).fill(0), area = new Array(16).fill(0);
	for (let c = 0; c < W * H; c++) { area[zoneOf[c]]++; if (mask[c]) wet[zoneOf[c]]++; }
	return wet.map((n, z) => n / area[z]);
};

test('adoptWater takes no more of a zone than the cap given, at any scale', () => {
	assert.ok(shape >= 0);
	const forced = new Uint8Array(W * H);
	for (const seed of [1, 2, 3]) {
		const loose = wetShare(adoptWater(W, H, zoneOf, 'normal', xorshift(seed * 7919), forced, null, shape, 8, 0.95));
		const capped = wetShare(adoptWater(W, H, zoneOf, 'normal', xorshift(seed * 7919), forced, null, shape, 8, 0.55));
		assert.ok(Math.max(...capped) <= 0.62, `seed ${seed}: the wettest zone is ${Math.round(100 * Math.max(...capped))}% water`);
		assert.ok(Math.max(...loose) > 0.7, `seed ${seed}: without the cap a zone goes ${Math.round(100 * Math.max(...loose))}% (the case the cap is for)`);
	}
});

test('Mediterranean water at 45% leaves every zone of a template at least 35% land', () => {
	const starts = [{ x: 15, y: 15 }, { x: 105, y: 15 }, { x: 15, y: 105 }, { x: 105, y: 105 }];
	for (const seed of [1, 2, 3]) {
		const plan = buildAdoptedPlan(W, H, zoneOf, 'normal', starts, seed, null, null, shape, 0.45);
		const share = wetShare(plan.mask);
		assert.ok(Math.max(...share) <= 0.65, `seed ${seed}: the wettest zone is ${Math.round(100 * Math.max(...share))}% water`);
		assert.ok(plan.coverage > 0.3, `seed ${seed}: the amount reached ${plan.coverage.toFixed(2)}`);
	}
});
