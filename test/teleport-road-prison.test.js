/**
 * teleport-road-prison.test.js - the road to a gate or monolith may lie under a prison's tiles, as under a chest: freeing the hero takes the prison away.
 * 72x72 two levels, interconnectivity 1 and decorDensity 2 (seed 1): the monolith (50,2,L1) and the gate (57,24,L1) stood in a pocket whose only way out
 * went over a prison, the pass counted the prison as a wall, and mapsight reported "teleport off road".
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { teleportRoads } = require('../src/biome/gateroad');

const W = 12, H = 12, OCC = 1;
const at = (x, y) => y * W + x;
const visit = (tpl, x, y) => [[x, y]];
const fp = (tpl, x, y) => [[x, y]];
const level = (objects, road, wall = []) => {
	const blocked = new Uint8Array(W * H);
	for (const [x, y] of wall) blocked[at(x, y)] |= OCC;
	return { plan: { objects, roadCells: new Set(road.map(([x, y]) => at(x, y))), openMask: null, p: {} }, blocked };
};
const gate = (x, y) => ({ type: 'subterraneanGate', l: 0, x, y, template: {} });

// the gate's ring is walled except the tile at (8,7), where the object under test stands
const walled = () => {
	const wall = [];
	for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && !(dx === 0 && dy === -1)) wall.push([8 + dx, 8 + dy]);
	wall.push([8, 7]);
	return wall;
};

test('a pocket closed by a prison is crossed under the prison', () => {
	const prison = { type: 'prison', l: 0, x: 8, y: 7, template: { mask: ['A'] } };
	const m = level([gate(8, 8), prison], [[2, 8], [1, 8]], walled());
	const r = teleportRoads(m.plan, W, H, 0, m.blocked, OCC, visit, fp);
	assert.strictEqual(r.joined, 1);
	assert.ok(m.plan.roadCells.has(at(8, 7)), 'the road lies under the prison');
});

test('a pocket closed by a building that stays is still not crossed', () => {
	const hut = { type: 'witchHut', l: 0, x: 8, y: 7, template: { mask: ['A'] } };
	const m = level([gate(8, 8), hut], [[2, 8], [1, 8]], walled());
	assert.strictEqual(teleportRoads(m.plan, W, H, 0, m.blocked, OCC, visit, fp).none, 1);
});
