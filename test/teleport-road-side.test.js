/**
 * teleport-road-side.test.js - a monolith's road arrives from a side its template lets a hero step in from (K, November 2nd 2026: "the
 * road connects to the monolith's front by running underneath it"). The two-way monolith's visitableFrom is ['---', '+-+', '+++']:
 * nothing from the row above.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { teleportRoads } = require('../src/biome/gateroad');

const W = 12, H = 12, OCC = 1;
const at = (x, y) => y * W + x;
const visit = (tpl, x, y) => [[x, y]];
const mono = (x, y) => ({ type: 'monolithTwoWay', l: 0, x, y, template: { visitableFrom: ['---', '+-+', '+++'] } });
const level = (objects, road, wall = []) => {
	const blocked = new Uint8Array(W * H);
	for (const [x, y] of wall) blocked[at(x, y)] |= OCC;
	return { plan: { objects, roadCells: new Set(road.map(([x, y]) => at(x, y))), openMask: null, p: {} }, blocked };
};
const run = m => teleportRoads(m.plan, W, H, 0, m.blocked, OCC, visit);

test('a road only above the monolith does not serve it: the run leaves by a side and reaches that road', () => {
	const m = level([mono(5, 5)], [[5, 4], [5, 3], [5, 2]]);
	const r = run(m);
	assert.ok(m.plan.roadCells.has(at(5, 5)));
	const R = m.plan.roadCells;
	const sides = [[-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]].some(([dx, dy]) => R.has(at(5 + dx, 5 + dy)));
	assert.ok(sides, 'a road tile on a side the monolith is entered from');
	assert.strictEqual(r.joined, 1);
});

test('a road beside the monolith on an allowed side gives the tile only', () => {
	const m = level([mono(5, 5)], [[4, 5], [3, 5]]);
	const r = run(m);
	assert.deepStrictEqual(r, { onto: 1, joined: 0, none: 0 });
});

test('a monolith already on the road but met only from above takes a run from a side', () => {
	const m = level([mono(5, 5)], [[5, 5], [5, 4], [5, 3]]);
	const r = run(m);
	assert.strictEqual(r.resided, 1);
	const R = m.plan.roadCells;
	assert.ok([[-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]].some(([dx, dy]) => R.has(at(5 + dx, 5 + dy))));
});

test('VMAPGEN_TELEPORT_ROAD_SIDE=0 takes the road above, as before', () => {
	process.env.VMAPGEN_TELEPORT_ROAD_SIDE = '0';
	try {
		const m = level([mono(5, 5)], [[5, 4], [5, 3]]);
		const r = run(m);
		assert.deepStrictEqual(r, { onto: 1, joined: 0, none: 0 });
	} finally { delete process.env.VMAPGEN_TELEPORT_ROAD_SIDE; }
});

test('walled on every allowed side: left as it is', () => {
	const m = level([mono(5, 5)], [[5, 4], [5, 3]], [[4, 5], [6, 5], [4, 6], [5, 6], [6, 6]]);
	const r = run(m);
	assert.strictEqual(r.none, 1);
	assert.ok(!m.plan.roadCells.has(at(5, 5)));
});

const { sideDoorStubs } = require('../src/biome/gateroad');
const { allowedDirs } = require('../src/biome/content');
const monoM = (x, y) => ({ type: 'monolithTwoWay', l: 0, x, y, template: { mask: ['VV', 'VA'], visitableFrom: ['---', '+-+', '+++'] } });

test('sideDoorStubs keeps the side door when the monolith tile meets the road only from above', () => {
	// road along row 4 (above the monolith at (5,5)), the monolith tile, and the side door (4,5) down from (4,4)
	const plan = { objects: [monoM(5, 5)], roadCells: new Set([[2, 4], [3, 4], [4, 4], [5, 4], [6, 4], [7, 4], [5, 5], [4, 5]].map(([x, y]) => at(x, y))) };
	sideDoorStubs(plan, W, H, 0, visit, allowedDirs);
	assert.ok(plan.roadCells.has(at(4, 5)), 'the side door stays');
});

test('sideDoorStubs still takes a side door when the road passes the front', () => {
	const plan = { objects: [monoM(5, 5)], roadCells: new Set([[2, 6], [3, 6], [4, 6], [5, 6], [6, 6], [7, 6], [5, 5], [4, 5]].map(([x, y]) => at(x, y))) };
	sideDoorStubs(plan, W, H, 0, visit, allowedDirs);
	assert.ok(!plan.roadCells.has(at(4, 5)), 'the side door goes');
});
