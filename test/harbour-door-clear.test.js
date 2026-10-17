/**
 * harbour-door-clear.test.js - a start harbour's walls keep 3 tiles from every doorway between zones (src/biome/waterfill.js placeHarbours,
 * ctx.doorCells and ctx.keepClear). On the Mediterranean 108 seed 9 (0.3.12) the start harbour, placed as near the start as it fits,
 * stood in the doorway out of green's zone: green walked 262 tiles and reached 2 of 21 zones, against 21 of 21 before that rule.
 * VMAPGEN_HARBOUR_DOOR_CLEAR=0 is the old rule.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { placeHarbours } = require('../src/biome/waterfill');
const { OCCUPIED, blockingCells } = require('../src/biome/content');
const { xorshift } = require('../src/wfc/solver');

const entry = (type, x, y, l, tpl, subtype = 'object') =>
	({ instanceName: `${type}_${x}_${y}_${l}`, l, x, y, type, subtype,
		template: { animation: tpl.animation, mask: tpl.mask, visitableFrom: tpl.visitableFrom } });

function world() {
	const W = 48, H = 40;
	const water = new Uint8Array(W * H), zone = new Int16Array(W * H), blocked = new Uint8Array(W * H);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			zone[y * W + x] = x < 4 ? 2 : x < 24 ? 0 : 1;   // zone 2, a strip on the west edge with no shore, holds the start
			if ((x - 24) ** 2 / 144 + (y - 20) ** 2 / 64 <= 1) water[y * W + x] = 1;
		}
	for (let c = 0; c < W * H; c++) if (water[c]) blocked[c] |= OCCUPIED;
	return { W, H, water, zone, blocked };
}

const yardWalls = (doorCells, env) => {
	const old = process.env.VMAPGEN_HARBOUR_DOOR_CLEAR;
	if (env === undefined) delete process.env.VMAPGEN_HARBOUR_DOOR_CLEAR; else process.env.VMAPGEN_HARBOUR_DOOR_CLEAR = env;
	try {
		const { W, H, water, zone, blocked } = world();
		const objects = [];
		// the start harbour (Mediterranean water, waterShape 3): the start's zone has no shore, so its shipyard goes on zone 0's shore, toward it
		placeHarbours({ W, H, l: 0, water, zone, blocked, rng: xorshift(3), p: { waterAccess: 1, waterShape: 3 }, objects,
			towns: [], playerStarts: [{ x: 2, y: 20 }], objectEntry: entry, doorCells });
		const y = objects.find(o => o.type === 'shipyard');
		return y ? blockingCells(y.template, y.x, y.y) : null;
	} finally {
		if (old === undefined) delete process.env.VMAPGEN_HARBOUR_DOOR_CLEAR; else process.env.VMAPGEN_HARBOUR_DOOR_CLEAR = old;
	}
};

test("a start's harbour moves off a doorway that stands where it would have gone, and stays where it was without one", () => {
	const W = 48;
	const free = yardWalls([]);
	assert.ok(free, 'a shipyard on the open shore');
	// a doorway hole right beside where the shipyard went
	const [fx, fy] = free[0];
	const door = [[fx, fy - 1], [fx + 1, fy - 1], [fx + 2, fy - 1]].map(([x, y]) => y * W + x);
	assert.deepStrictEqual(yardWalls(door, '0'), free, 'the old rule puts it in the same place');
	const moved = yardWalls(door);
	assert.ok(moved, 'a shipyard still goes down');
	const gap = Math.min(...moved.flatMap(([x, y]) => door.map(c => Math.max(Math.abs(c % W - x), Math.abs(((c / W) | 0) - y)))));
	assert.ok(gap > 3, `walls ${gap} tiles from the doorway`);
});
