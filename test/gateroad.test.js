/**
 * gateroad.test.js - the road runs onto the visiting tile of every gate and monolith (K, 2026-10-04: "portals and subterranean
 * gates are still being missed by roads"). A small level, a stand-in for visitableCells (the tile below the object), and the road
 * pass: a road beside the tile gives the tile; a road far off is reached by a run of free floor; walls stop it.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { teleportRoads } = require('../src/biome/gateroad');

const W = 12, H = 12, OCC = 1;
const at = (x, y) => y * W + x;
const visit = (tpl, x, y) => [[x, y]];
const level = (objects, road, wall = []) => {
	const blocked = new Uint8Array(W * H);
	for (const [x, y] of wall) blocked[at(x, y)] |= OCC;
	return { plan: { objects, roadCells: new Set(road.map(([x, y]) => at(x, y))), openMask: null, p: {} }, blocked };
};
const gate = (x, y) => ({ type: 'subterraneanGate', l: 0, x, y, template: {} });
const run = (m) => teleportRoads(m.plan, W, H, 0, m.blocked, OCC, visit);

test('a road beside the visiting tile gives the tile', () => {
	const m = level([gate(5, 5)], [[4, 5], [3, 5], [2, 5]]);
	const r = run(m);
	assert.ok(m.plan.roadCells.has(at(5, 5)));
	assert.deepStrictEqual(r, { onto: 1, joined: 0, none: 0 });
});

test('a road across a corner counts (a gate in a wall is entered diagonally)', () => {
	const m = level([gate(5, 5)], [[4, 4], [3, 3]], [[4, 5], [6, 5], [5, 4]]);
	run(m);
	assert.ok(m.plan.roadCells.has(at(5, 5)));
});

test('a road a few tiles off is reached over free floor', () => {
	const m = level([gate(8, 8)], [[2, 8], [1, 8]]);
	const r = run(m);
	assert.strictEqual(r.joined, 1);
	assert.ok(m.plan.roadCells.has(at(8, 8)));
	assert.ok(m.plan.roadCells.has(at(3, 8)), 'the run ends on the road');
});

test('a gate walled off from every road stays as it is', () => {
	const wall = [];
	for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) wall.push([8 + dx, 8 + dy]);
	const m = level([gate(8, 8)], [[2, 8], [1, 8]], wall);
	const r = run(m);
	assert.deepStrictEqual(r, { onto: 0, joined: 0, none: 1 });
	assert.ok(!m.plan.roadCells.has(at(8, 8)));
});

test('a gate already on a road is left alone, and so is other scenery', () => {
	const m = level([gate(5, 5), { type: 'mine', l: 0, x: 9, y: 9, template: {} }], [[5, 5], [6, 5]]);
	const before = m.plan.roadCells.size;
	run(m);
	assert.strictEqual(m.plan.roadCells.size, before);
});

test('water is not crossed', () => {
	const m = level([gate(8, 8)], [[2, 8]]);
	m.plan.p.water = new Uint8Array(W * H);
	for (let y = 0; y < H; y++) m.plan.p.water[at(5, y)] = 1;
	const r = run(m);
	assert.strictEqual(r.none, 1);
});

test('a pocket closed by loot is crossed under the pickups, and a wall of rock still is not', () => {
	// the gate's ring is walled (rock) except the tile at (8,7), which a chest stands on; the chest vanishes when taken
	const wall = [];
	for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && !(dx === 0 && dy === -1)) wall.push([8 + dx, 8 + dy]);
	wall.push([8, 7]);
	const chest = { type: 'treasureChest', l: 0, x: 8, y: 7, template: { mask: ['A'] } };
	const fp = (tpl, x, y) => [[x, y]];
	const m = level([gate(8, 8), chest], [[2, 8], [1, 8]], wall);
	const r = teleportRoads(m.plan, W, H, 0, m.blocked, OCC, visit, fp);
	assert.strictEqual(r.joined, 1);
	assert.ok(m.plan.roadCells.has(at(8, 7)), 'the road lies under the chest');
	const closed = level([gate(8, 8)], [[2, 8], [1, 8]], wall);
	assert.strictEqual(teleportRoads(closed.plan, W, H, 0, closed.blocked, OCC, visit, fp).none, 1);
});

const { closeRoadGaps } = require('../src/biome/gateroad');
const gapLevel = (road, wall = [], objects = []) => {
	const m = level(objects, road, wall);
	return m;
};
const gaps = (m) => closeRoadGaps(m.plan, W, H, 0, m.blocked, OCC, () => []);

test('two road pieces whose ends are three tiles apart are joined', () => {
	const m = gapLevel([[1, 5], [2, 5], [3, 5], [7, 5], [8, 5], [9, 5]]);
	const r = gaps(m);
	assert.strictEqual(r.joined, 1);
	for (const x of [4, 5, 6]) assert.ok(m.plan.roadCells.has(at(x, 5)), `tile ${x}`);
});

test('pieces more than four steps apart, or with a wall between, are left alone', () => {
	const far = gapLevel([[1, 5], [2, 5], [3, 5], [9, 5], [10, 5]]);
	assert.strictEqual(gaps(far).joined, 0);
	const wall = [];
	for (let y = 0; y < H; y++) wall.push([5, y]);
	const walled = gapLevel([[1, 5], [2, 5], [3, 5], [7, 5], [8, 5], [9, 5]], wall);
	assert.strictEqual(gaps(walled).joined, 0);
});

test('one connected road is not touched', () => {
	const m = gapLevel([[1, 5], [2, 5], [3, 5], [4, 5], [5, 5]]);
	const before = m.plan.roadCells.size;
	assert.strictEqual(gaps(m).joined, 0);
	assert.strictEqual(m.plan.roadCells.size, before);
});

test('mines join the road net by chance: chance 0 touches nothing, chance 1 runs the road onto the visiting tile', () => {
	const mine = { type: 'mine', l: 0, x: 8, y: 8, template: {} };
	const opts = chance => ({ types: /^(mine|abandonedMine)$/, reach: 30, chance, rng: () => 0.5 });
	const none = level([mine], [[2, 8], [1, 8]]);
	teleportRoads(none.plan, W, H, 0, none.blocked, OCC, visit, undefined, opts(0));
	assert.ok(!none.plan.roadCells.has(at(8, 8)));
	const all = level([mine], [[2, 8], [1, 8]]);
	const r = teleportRoads(all.plan, W, H, 0, all.blocked, OCC, visit, undefined, opts(1));
	assert.strictEqual(r.joined, 1);
	assert.ok(all.plan.roadCells.has(at(8, 8)) && all.plan.roadCells.has(at(3, 8)));
	const other = level([gate(8, 8)], [[2, 8]]);
	teleportRoads(other.plan, W, H, 0, other.blocked, OCC, visit, undefined, opts(1));
	assert.ok(!other.plan.roadCells.has(at(8, 8)), 'a gate is not a mine');
});
