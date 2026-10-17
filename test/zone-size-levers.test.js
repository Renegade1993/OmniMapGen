/**
 * zone-size-levers.test.js - Start biome size (startZoneShare) and Biome size variety (zoneSizeVariety), the two levers for the engine
 * templates' unequal zones (the Template Factory's coverage table, 2026-10-16: 99 of 181 templates). Free layout, biomes.js partitionBiomes
 * and plan.js's start cap: the starts' share of the map follows the lever, two players included (the cap grows with it); the spread of the
 * other zones' areas widens with the variety, and 0 draws exactly what the generator drew before.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { partitionBiomes } = require('../src/biome/biomes');
const { xorshift } = require('../src/wfc/solver');

const W = 96, H = 96;
const four = [{ x: 12, y: 12 }, { x: 84, y: 84 }, { x: 84, y: 12 }, { x: 12, y: 84 }];

test('Start biome size: on a two-player map the starts take more of it as the lever rises (cap grows with the lever)', () => {
	// plan.js: startCells = min(share / players, 0.2 x max(1, share / 0.5)) x land
	const take = share => {
		let t = 0;
		for (let s = 1; s <= 6; s++) {
			const cells = Math.min(share / 2, 0.2 * Math.max(1, share / 0.5)) * W * H;
			const { zone } = partitionBiomes(W, H, four.slice(0, 2), 10, xorshift(s * 7919), { startZoneShare: share }, null, cells);
			for (const z of zone) if (z < 2) t++;
		}
		return t / (6 * W * H);
	};
	const lo = take(0.3), mid = take(0.5), hi = take(0.8);
	assert.ok(lo + 0.05 < mid && mid + 0.1 < hi, `starts' share ${lo.toFixed(2)}, ${mid.toFixed(2)}, ${hi.toFixed(2)} at 0.3, 0.5, 0.8`);
});

test('Biome size variety: the spread of the other zones\' areas widens with the lever, and 0 is as before', () => {
	const cv = v => {
		let sum = 0;
		for (let s = 1; s <= 12; s++) {
			const { zone, count } = partitionBiomes(W, H, four, 14, xorshift(s * 7919), { zoneSizeVariety: v }, null, 1152);
			const a = new Array(count).fill(0);
			for (const z of zone) a[z]++;
			const n = a.slice(4), m = n.reduce((x, y) => x + y, 0) / n.length;
			sum += Math.sqrt(n.reduce((x, y) => x + (y - m) ** 2, 0) / n.length) / m;
		}
		return sum / 12;
	};
	// 2026-10-16: 0.537, 0.645, 0.837
	const c0 = cv(0), c5 = cv(0.5), c1 = cv(1);
	assert.ok(c0 + 0.05 < c5 && c5 + 0.1 < c1, `area spread ${c0.toFixed(3)}, ${c5.toFixed(3)}, ${c1.toFixed(3)} at 0, 0.5, 1`);
	const old = process.env.VMAPGEN_ZONE_VARIETY;
	try {
		const a = partitionBiomes(W, H, four, 14, xorshift(5), { zoneSizeVariety: 0 }, null, 1152).zone;
		process.env.VMAPGEN_ZONE_VARIETY = '0';
		const b = partitionBiomes(W, H, four, 14, xorshift(5), { zoneSizeVariety: 1 }, null, 1152).zone;
		assert.deepStrictEqual([...a], [...b]);
	} finally {
		if (old === undefined) delete process.env.VMAPGEN_ZONE_VARIETY; else process.env.VMAPGEN_ZONE_VARIETY = old;
	}
});
