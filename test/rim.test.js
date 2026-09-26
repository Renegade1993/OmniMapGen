/**
 * rim.test.js
 *
 * Pins the zone-rim band (boundaries.js addRimBand, the engine's
 * ConnectionsPlacer::createBorder): a zone line is solid two cells deep on
 * both sides, a doorway is one crossing pair with a one-cell passage out of
 * the band on each side, and the two zones stay connected through it.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { carveBoundaries } = require('../src/biome/boundaries');
const { biomeEdges } = require('../src/biome/biomes');
const { xorshift } = require('../src/wfc/solver');

const { rimModeOf, rimLobeScale, bordersOff } = require('../src/biome/biomes');

test('borderSolidity maps to the four border modes', () => {
	assert.strictEqual(rimModeOf({ borderSolidity: 1 }), true);
	assert.strictEqual(rimLobeScale({ borderSolidity: 1 }), 1);
	assert.strictEqual(rimModeOf({ borderSolidity: 0.5 }), true);
	assert.strictEqual(rimLobeScale({ borderSolidity: 0.5 }), 0);
	assert.strictEqual(rimLobeScale({ borderSolidity: 0.75 }), 0.5);
	assert.strictEqual(rimModeOf({ borderSolidity: 0.35 }), false);
	assert.strictEqual(bordersOff({ borderSolidity: 0.35 }), false);
	assert.strictEqual(bordersOff({ borderSolidity: 0.1 }), true);
	// absent means the default, solid
	assert.strictEqual(rimModeOf({}), true);
	assert.strictEqual(rimLobeScale(undefined), 1);
});

test('borderSolidity under 0.25 leaves no border scenery but keeps the doorway', () => {
	const W = 12, H = 8;
	const zone = twoZones(W, H);
	const edges = biomeEdges(zone, W, H, 2);
	const connections = new Map([[0 * 100000 + 1, 'openRoad']]);
	const r = carveBoundaries(edges, connections, zone, W, H, { borderSolidity: 0 }, xorshift(5), new Map());
	assert.strictEqual(r.barriers.size, 0);
	assert.strictEqual(r.rim, null);
	assert.ok(r.openings.length === 1 && r.openings[0].hole.length > 0);
});

function twoZones(W, H) {
	const zone = new Int16Array(W * H);
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) zone[y * W + x] = x < W / 2 ? 0 : 1;
	return zone;
}

function carve(W, H, kind, env) {
	const prev = process.env.VMAPGEN_RIM;
	if (env === undefined) delete process.env.VMAPGEN_RIM; else process.env.VMAPGEN_RIM = env;
	try {
		const zone = twoZones(W, H);
		const edges = biomeEdges(zone, W, H, 2);
		const connections = new Map([[0 * 100000 + 1, kind]]);
		return { zone, ...carveBoundaries(edges, connections, zone, W, H, {}, xorshift(5), new Map()) };
	} finally {
		if (prev === undefined) delete process.env.VMAPGEN_RIM; else process.env.VMAPGEN_RIM = prev;
	}
}

function connected(W, H, walls, from, to) {
	const seen = new Uint8Array(W * H);
	const st = [from]; seen[from] = 1;
	while (st.length) {
		const c = st.pop();
		if (c === to) return true;
		const x = c % W, y = (c / W) | 0;
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
			const nx = x + dx, ny = y + dy;
			if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
			const n = ny * W + nx;
			if (seen[n] || walls.has(n)) continue;
			seen[n] = 1; st.push(n);
		}
	}
	return false;
}

test('rim band: a zone line is solid two cells deep on both sides', () => {
	const W = 20, H = 12;
	const { barriers, openings } = carve(W, H, 'openNoRoad');
	assert.strictEqual(openings.length, 1);
	const open = new Set([...openings[0].hole, ...openings[0].inner]);
	for (let y = 0; y < H; y++)
		for (const x of [8, 9, 10, 11]) {
			const c = y * W + x;
			if (open.has(c)) continue;
			assert.ok(barriers.has(c), `(${x},${y}) should be rim`);
		}
});

test('rim band: one crossing pair, a passage out of the band on each side', () => {
	const W = 20, H = 12;
	const { zone, barriers, openings } = carve(W, H, 'openNoRoad');
	const o = openings[0];
	assert.strictEqual(o.hole.length, 2, 'doorway should be one crossing pair');
	assert.notStrictEqual(zone[o.hole[0]], zone[o.hole[1]]);
	const xs = [...o.hole, ...o.inner].map(c => c % W);
	assert.ok(xs.some(x => x <= 7), 'no passage out of the band on the left');
	assert.ok(xs.some(x => x >= 12), 'no passage out of the band on the right');
	for (const c of [...o.hole, ...o.inner]) assert.ok(!barriers.has(c), 'passage cell walled');
	assert.ok(connected(W, H, barriers, 0, W * H - 1), 'zones not connected through the doorway');
});

test('rim band: a blocked border stays sealed, VMAPGEN_RIM=0 keeps the one-cell wall', () => {
	const W = 20, H = 12;
	const sealed = carve(W, H, 'blocked');
	assert.ok(!connected(W, H, sealed.barriers, 0, W * H - 1), 'blocked border leaks');
	const old = carve(W, H, 'blocked', '0');
	const cols = new Set([...old.barriers].map(c => c % W));
	assert.deepStrictEqual([...cols], [9], 'old path should wall one column');
});
