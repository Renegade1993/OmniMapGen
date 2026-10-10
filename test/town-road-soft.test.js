/**
 * town-road-soft.test.js - a town whose way to a road runs over loot gets its road (K's XL map, 2026-10-06: a neutral town with two pickups
 * between its front tile and a road 9 tiles off had none: the road planner counted a pickup as a wall, though it vanishes when taken).
 * gateroad.joinBareTowns on a hand-built plan: the town at (10,10), walls round it but for a corridor east whose tiles 14 and 15 hold pickups.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { joinBareTowns } = require('../src/biome/gateroad');

const W = 40, H = 40, OCCUPIED = 1;

function scene() {
	const blocked = new Uint8Array(W * H);
	const zone = new Int32Array(W * H);
	// walls: everything but the town's front tile (10,11), the corridor row 11 from x 10 to 20
	for (let i = 0; i < W * H; i++) blocked[i] = OCCUPIED;
	for (let x = 10; x <= 20; x++) blocked[11 * W + x] = 0;
	blocked[10 * W + 10] = OCCUPIED;                       // the town's own tile (the visiting tile)
	const town = { type: 'town', l: 0, x: 10, y: 10, template: { mask: ['A'] } };
	const pickups = [14, 15].map(x => ({ type: 'resource', l: 0, x, y: 11, template: { mask: ['B'] } }));
	for (const q of pickups) blocked[q.y * W + q.x] = OCCUPIED;
	const roadCells = new Set([11 * W + 20, 11 * W + 21]);
	const plan = { objects: [town, ...pickups], roadCells, zone };
	const cells = (tpl, x, y) => [[x, y]];
	return { plan, blocked, cells, roadCells };
}

test('a road crosses the pickups that shut a town in', () => {
	const s = scene();
	const r = joinBareTowns(s.plan, W, H, 0, s.blocked, OCCUPIED, s.cells, false, s.cells);
	assert.strictEqual(r.joined, 1, JSON.stringify(r));
	assert.ok(s.roadCells.has(11 * W + 10), 'the front tile carries road');
	assert.ok(s.roadCells.has(11 * W + 14) && s.roadCells.has(11 * W + 15), 'the road runs under the pickups');
});

test('with no way to know the loot (no blockingCells) the town stays as it was', () => {
	const s = scene();
	const r = joinBareTowns(s.plan, W, H, 0, s.blocked, OCCUPIED, s.cells, false, null);
	assert.strictEqual(r.joined, 0);
	assert.strictEqual(r.left, 1);
});
