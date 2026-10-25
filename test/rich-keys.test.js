/**
 * rich-keys.test.js - Rich zones Centre and Between the starts rank the zones differently (MapGen Dev, 2026-10-20; the lead's order to reproduce the open
 * "richPlacement 1, 2, 3 make one map" report on one map). reach-016 and lever_effect found the three values giving the same map on seed 1072 at 72x72 with two
 * players; over seeds 1072 to 1077 (two and four players, 72x72) Centre and Between pick different treasure zones on five of six, the one that matches being 1072
 * itself (one hub zone is both the nearest the middle and level with both starts, and only two zones are rich). The ranking function is pinned here on a layout
 * built to separate them: a 3x3 block grid, starts in the top-left and bottom-right blocks.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { richKeys } = require('../src/biome/plan');

const W = 30, H = 30, B = 10;
const zone = new Int32Array(W * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) zone[y * W + x] = Math.floor(y / B) * 3 + Math.floor(x / B);
const starts = [{ x: 5, y: 5 }, { x: 25, y: 25 }];
const ids = [1, 2, 3, 4, 5, 6, 7];
const best = (mode, n) => {
	const rk = richKeys({ richPlacement: mode }, zone, W, H, starts, ids, null, 1);
	return rk.key ? ids.slice().sort((a, b) => rk.key.get(a) - rk.key.get(b) || a - b).slice(0, n) : null;
};

test('Far (0) leaves the zones to the free layout\'s own rule', () => {
	assert.strictEqual(best(0, 2), null);
});

test('Centre puts the hub first, then a block beside it; Between puts the hub first, then a corner level with both starts', () => {
	const centre = best(1, 2), between = best(2, 2);
	assert.strictEqual(centre[0], 4, `Centre: ${centre}`);
	assert.strictEqual(between[0], 4, `Between: ${between}`);
	assert.ok([1, 3, 5, 7].includes(centre[1]), `Centre second: ${centre[1]}`);
	assert.ok([2, 6].includes(between[1]), `Between second: ${between[1]}`);
	assert.notDeepStrictEqual(centre, between);
});

test('Random (3) is one of Far, Centre and Between by the seed', () => {
	const seen = new Set();
	for (let seed = 1; seed <= 40; seed++) seen.add(richKeys({ richPlacement: 3 }, zone, W, H, starts, ids, null, seed).mode);
	assert.deepStrictEqual([...seen].sort(), [0, 1, 2]);
});
