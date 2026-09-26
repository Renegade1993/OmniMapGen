/**
 * waterfill.test.js
 *
 * Pins boats, shipyards and water objects (src/biome/waterfill.js, water W2)
 * on a small lake: a town zone on the shore gets a shipyard whose launch tile
 * is this lake's water with a free boarding cell beside it; water objects sit
 * on the lake only, and every one can be reached by boat from that launch.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { placeHarbours, fillWater } = require('../src/biome/waterfill');
const { OCCUPIED, blockingCells, visitableCells, allowedDirs } = require('../src/biome/content');
const { xorshift } = require('../src/wfc/solver');

const entry = (type, x, y, l, tpl, subtype = 'object') =>
	({ instanceName: `${type}_${x}_${y}_${l}`, l, x, y, type, subtype,
		template: { animation: tpl.animation, mask: tpl.mask, visitableFrom: tpl.visitableFrom } });

function world() {
	const W = 48, H = 40;
	const water = new Uint8Array(W * H), zone = new Int16Array(W * H), blocked = new Uint8Array(W * H);
	// a lake in the middle, zone 0 west of x = 24, zone 1 east
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			zone[y * W + x] = x < 24 ? 0 : 1;
			if ((x - 24) ** 2 / 144 + (y - 20) ** 2 / 64 <= 1) water[y * W + x] = 1;
		}
	for (let c = 0; c < W * H; c++) if (water[c]) blocked[c] |= OCCUPIED;
	return { W, H, water, zone, blocked };
}

test('a town zone on the shore gets a shipyard that launches onto the lake', () => {
	const { W, H, water, zone, blocked } = world();
	const objects = [];
	const towns = [{ x: 6, y: 20, l: 0 }];                 // a town in zone 0
	const harbours = placeHarbours({ W, H, l: 0, water, zone, blocked, rng: xorshift(3),
		p: { waterAccess: 2 }, objects, towns, playerStarts: [], objectEntry: entry });
	const yards = objects.filter(o => o.type === 'shipyard');
	assert.strictEqual(yards.length, 1, 'one shipyard, for the one town zone');
	assert.strictEqual(harbours.length, 1);
	const h = harbours[0];
	assert.ok(water[h.cell], 'launch tile is water');
	// the shipyard stands on zone 0's land
	for (const [x, y] of blockingCells(yards[0].template, yards[0].x, yards[0].y)) {
		assert.ok(!water[y * W + x], 'shipyard on land');
		assert.strictEqual(zone[y * W + x], 0);
	}
	// its launch tile is the first free water tile in the engine's order
	const [vx, vy] = visitableCells(yards[0].template, yards[0].x, yards[0].y)[0];
	const LAUNCH = [[-2, 0], [2, 0], [-2, 1], [2, 1], [-1, 1], [1, 1], [0, 1], [-2, -1], [2, -1], [-1, -1], [1, -1], [0, -1]];
	const first = LAUNCH.map(([dx, dy]) => (vy + dy) * W + vx + dx).find(c => water[c]);
	assert.strictEqual(first, h.cell);
});

test('water objects sit on the lake and a boat from the harbour reaches every one', () => {
	const { W, H, water, zone, blocked } = world();
	const objects = [];
	const harbours = placeHarbours({ W, H, l: 0, water, zone, blocked, rng: xorshift(5),
		p: { waterAccess: 3 }, objects, towns: [{ x: 6, y: 20, l: 0 }], playerStarts: [], objectEntry: entry });
	assert.ok(harbours.length >= 1);
	const before = objects.length;
	const placed = fillWater({ W, H, l: 0, water, harbours, rng: xorshift(7),
		p: { waterTreasure: 3 }, objects, objectEntry: entry });
	assert.ok(placed > 0, 'something was placed');
	const added = objects.slice(before);
	// the water layer after placement: land and blocking cells taken
	const taken = new Uint8Array(W * H);
	for (let c = 0; c < W * H; c++) if (!water[c]) taken[c] = 1;
	for (const o of added)
		for (const [x, y] of blockingCells(o.template, o.x, o.y)) {
			assert.ok(water[y * W + x], `${o.type} blocks only water`);
			taken[y * W + x] = 1;
		}
	// sail 8-way from the first harbour over untaken water
	const seen = new Uint8Array(W * H);
	const q = [harbours[0].cell];
	seen[q[0]] = 1;
	for (let i = 0; i < q.length; i++) {
		const c = q[i], x = c % W, y = (c / W) | 0;
		for (let dy = -1; dy <= 1; dy++)
			for (let dx = -1; dx <= 1; dx++) {
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const d = ny * W + nx;
				if (!seen[d] && water[d] && !taken[d]) { seen[d] = 1; q.push(d); }
			}
	}
	for (const o of added) {
		const vis = visitableCells(o.template, o.x, o.y);
		if (!vis.length) continue;                                   // scenery
		const ok = vis.some(([vx, vy]) => allowedDirs(o.template)
			.some(([dx, dy]) => seen[(vy + dy) * W + vx + dx]));
		assert.ok(ok, `${o.type} at ${o.x},${o.y} reachable by boat`);
	}
});

test('no harbours with waterAccess 0, and nothing on the water without one', () => {
	const { W, H, water, zone, blocked } = world();
	const objects = [];
	const harbours = placeHarbours({ W, H, l: 0, water, zone, blocked, rng: xorshift(3),
		p: { waterAccess: 0 }, objects, towns: [{ x: 6, y: 20, l: 0 }], playerStarts: [], objectEntry: entry });
	assert.strictEqual(harbours.length, 0);
	assert.strictEqual(fillWater({ W, H, l: 0, water, harbours, rng: xorshift(7), p: {}, objects, objectEntry: entry }), 0);
	assert.strictEqual(objects.length, 0);
});
