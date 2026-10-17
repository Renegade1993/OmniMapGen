/**
 * rich-placement.test.js - the Rich zones lever (richPlacement; the Template Factory's coverage table, 2026-10-16: a rich centre in 62 of
 * the engine's 181 templates, rich zones between the starts in 45). Free layout: plan.js richKeys ranks the zones, biomes.js assignClasses
 * makes the best-ranked the treasure zones. Far (0) is the old rule exactly; Centre puts them nearer the middle; Between nearer the line
 * between two starts.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { partitionBiomes, assignClasses, physZoneDistances, BIOME_CLASS } = require('../src/biome/biomes');
const { richKeys } = require('../src/biome/plan');
const { xorshift } = require('../src/wfc/solver');

const W = 96, H = 96;
const four = [{ x: 12, y: 12 }, { x: 84, y: 84 }, { x: 84, y: 12 }, { x: 12, y: 84 }], two = four.slice(0, 2), starts = four;

// with four corner starts the farthest zones are the middle ones, so Far and Centre agree there; two starts in opposite corners part them
const richCentroids = (mode, starts = four) => {
	const out = [];
	for (let s = 1; s <= 8; s++) {
		const { zone, seeds } = partitionBiomes(W, H, starts, 16, xorshift(s * 7919), {}, null, 0.5 * W * H / starts.length);
		const p = { highLootRatio: 0.25, townRatio: 0.1, lowLootRatio: 0.25, richPlacement: mode };
		const rk = richKeys(p, zone, W, H, starts, seeds.map((_, i) => i), null, s);
		const cl = assignClasses(seeds, p, xorshift(s), physZoneDistances(zone, W, H, starts), rk.key);
		const sx = new Map(), sy = new Map(), n = new Map();
		for (let c = 0; c < W * H; c++) { const z = zone[c]; sx.set(z, (sx.get(z) || 0) + c % W); sy.set(z, (sy.get(z) || 0) + ((c / W) | 0)); n.set(z, (n.get(z) || 0) + 1); }
		cl.forEach((c, i) => { if (c === BIOME_CLASS.HIGH_LOOT) out.push([sx.get(i) / n.get(i), sy.get(i) / n.get(i)]); });
	}
	return out;
};
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;

test('Rich zones Centre, two starts in opposite corners: treasure zones sit nearer the middle than with Far', () => {
	const far = mean(richCentroids(0, two).map(([x, y]) => Math.hypot(x - W / 2, y - H / 2)));
	const centre = mean(richCentroids(1, two).map(([x, y]) => Math.hypot(x - W / 2, y - H / 2)));
	assert.ok(centre + 5 < far, `mean distance from the middle: Centre ${centre.toFixed(1)}, Far ${far.toFixed(1)}`);
});

test('Rich zones Between: treasure zones sit more evenly between their two nearest starts than with Far', () => {
	const uneven = pts => mean(pts.map(([x, y]) => { const d = starts.map(s => Math.hypot(s.x - x, s.y - y)).sort((a, b) => a - b); return d[1] - d[0]; }));
	const far = uneven(richCentroids(0)), between = uneven(richCentroids(2));
	assert.ok(between + 2 < far, `mean |d2 - d1|: Between ${between.toFixed(1)}, Far ${far.toFixed(1)}`);
});

test('Rich zones Far draws exactly the old classes (no key)', () => {
	const { zone, seeds } = partitionBiomes(W, H, starts, 16, xorshift(11), {}, null, 1152);
	const p = { highLootRatio: 0.25, townRatio: 0.1, lowLootRatio: 0.25, richPlacement: 0 };
	const rk = richKeys(p, zone, W, H, starts, seeds.map((_, i) => i), null, 11);
	assert.strictEqual(rk.key, null);
	const dist = physZoneDistances(zone, W, H, starts);
	assert.deepStrictEqual(assignClasses(seeds, p, xorshift(3), dist, rk.key), assignClasses(seeds, p, xorshift(3), dist));
});
