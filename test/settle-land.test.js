/**
 * settle-land.test.js - stray land goes to the zones round it a layer at a
 * time, so the zone it shares more border with takes more of it, whichever
 * side the sweep starts from (findings-oe.md, water.js settleZonesOnLand).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { settleZonesOnLand } = require('../src/biome/water');

const run = mirror => {
	const W = 7, H = 3, N = W * H;
	const X = x => (mirror ? W - 1 - x : x);
	const zone = new Int32Array(N).fill(2), water = new Uint8Array(N);
	// zone 0 touches the stray piece (columns 1 to 5) through one tile, zone 1 along its whole side
	for (let y = 0; y < H; y++) { zone[y * W + X(0)] = 0; zone[y * W + X(6)] = 1; }
	for (const [x, y] of [[0, 0], [0, 2], [1, 0], [1, 2]]) water[y * W + X(x)] = 1;
	const seeds = [{ x: X(0), y: 1 }, { x: X(6), y: 1 }, { x: X(0), y: 0 }];
	settleZonesOnLand(zone, seeds, W, H, water);
	const n = [0, 0];
	for (let c = 0; c < N; c++) if (!water[c] && zone[c] < 2) n[zone[c]]++;
	return n;
};

test('settleZonesOnLand: the zone with the long border takes the larger share', () => {
	for (const mirror of [false, true]) {
		const [a, b] = run(mirror);
		assert.ok(b > a, `mirror ${mirror}: zone 0 holds ${a} tiles, zone 1 ${b}`);
	}
});
