/**
 * river-road-parallel.test.js - S449 (K 2026-11-21: "IT CAN CROSS, BUT RUNNING UNDER IT, ACTUALLY UNDER IT AND PARALLEL WITH IT SHOULD NEVER HAPPEN"; S345 on 11-19). rivernet.js routeRivers: a river crosses a road one tile
 * at a time and never runs parallel with it. The river tiles on or within one tile of a road form groups of at most two tiles, or at most four round a crossing that holds one road tile.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { routeRivers } = require('../src/biome/rivernet');

const mulberry = a => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

const W = 72, H = 72;
const near = (road, c) => { const x = c % W, y = (c / W) | 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const u = x + dx, v = y + dy; if (u >= 0 && v >= 0 && u < W && v < H && road[v * W + u]) return true; } return false; };
// connected groups (eight ways) of river tiles that are on or within one tile of a road, and the ones that break the rule
function violations(cells, road) {
	const bad = [], seen = new Set();
	for (const c0 of cells) {
		if (!near(road, c0) || seen.has(c0)) continue;
		const q = [c0]; seen.add(c0);
		for (let i = 0; i < q.length; i++) { const c = q[i], x = c % W, y = (c / W) | 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const u = x + dx, v = y + dy, n = v * W + u; if (u >= 0 && v >= 0 && u < W && v < H && cells.has(n) && near(road, n) && !seen.has(n)) { seen.add(n); q.push(n); } } }
		const roads = q.filter(c => road[c]).length;
		if (!(roads <= 1 && q.length <= (roads ? 4 : 2))) bad.push(q.length + ' tiles, ' + roads + ' road tile(s) at (' + (c0 % W) + ',' + ((c0 / W) | 0) + ')');
	}
	return bad;
}

test('no river runs parallel with a road: groups of road-near river tiles stay at 2 (4 round a crossing)', () => {
	for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
		const road = new Uint8Array(W * H);
		for (let y = 6; y < H - 6; y++) road[y * W + 36] = 1;                 // a long straight road down the middle
		for (let x = 6; x < 36; x++) road[20 * W + x] = 1;                    // and one across the left half
		const cells = routeRivers(W, H, mulberry(seed), 0.03, { road });
		assert.deepStrictEqual(violations(cells, road), [], 'seed ' + seed);
	}
});

test('where the only open ground is a strip along the road, no river is laid (the earlier routing ran one down it, the 30 tiles of K\'s map)', () => {
	const road = new Uint8Array(W * H), open = new Uint8Array(W * H);
	for (let y = 0; y < H; y++) for (let x = 34; x <= 38; x++) open[y * W + x] = 1;
	for (let y = 6; y < H - 6; y++) road[y * W + 36] = 1;
	let earlier = 0;
	for (const seed of [1, 2, 3, 4]) {
		assert.deepStrictEqual(violations(routeRivers(W, H, mulberry(seed), 0.03, { road, open }), road), [], 'seed ' + seed);
		process.env.VMAPGEN_RIVER_PARALLEL = '0';
		try { earlier += violations(routeRivers(W, H, mulberry(seed), 0.03, { road, open }), road).length; } finally { delete process.env.VMAPGEN_RIVER_PARALLEL; }
	}
	assert.ok(earlier > 0, 'the strip case is one the earlier routing broke (the test can see the fault)');
});
