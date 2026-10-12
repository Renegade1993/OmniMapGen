/**
 * road-diagonal.test.js - two road tiles that touch only at a corner are drawn by the game as two dead ends, a gap in the road (K, 2026-10-10,
 * 108x108 four players seed 2090106454: "roads are a mess"; 638 such steps on 72 grid maps). The last road pass gives each step a tile beside it.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { closeDiagonalSteps } = require('../src/biome/gateroad');

const W = 16, H = 16, OCCUPIED = 1;
const cell = (x, y) => y * W + x;
const plan = (cells, objects = []) => ({ roadCells: new Set(cells.map(([x, y]) => cell(x, y))), objects });
const steps = p => {
	let n = 0;
	for (const c of p.roadCells) {
		const x = c % W, y = (c / W) | 0;
		for (const [dx, dy] of [[1, 1], [1, -1]])
			if (p.roadCells.has(cell(x + dx, y + dy)) && !p.roadCells.has(cell(x + dx, y)) && !p.roadCells.has(cell(x, y + dy))) n++;
	}
	return n;
};
const run = (p, blocked = new Uint8Array(W * H), d = {}) => closeDiagonalSteps(p, W, H, 0, blocked, OCCUPIED, () => [], d);

test('a step that meets at a corner gets a tile beside it, a 4-connected road is left as it is', () => {
	const p = plan([[3, 3], [4, 3], [5, 4], [6, 4], [7, 4]]);
	assert.strictEqual(steps(p), 1);
	assert.strictEqual(run(p).closed, 1);
	assert.strictEqual(steps(p), 0);
	assert.strictEqual(p.roadCells.size, 6);
	const q = plan([[3, 3], [4, 3], [4, 4], [5, 4]]);
	assert.strictEqual(run(q).closed, 0);
	assert.strictEqual(q.roadCells.size, 4);
});

test('a tile an object blocks is not taken, the other one is; with both blocked the step stays and is counted', () => {
	const blocked = new Uint8Array(W * H);
	blocked[cell(5, 3)] = OCCUPIED;
	const p = plan([[4, 3], [5, 4]]);
	assert.strictEqual(run(p, blocked).closed, 1);
	assert.ok(p.roadCells.has(cell(4, 4)) && !p.roadCells.has(cell(5, 3)));
	blocked[cell(4, 4)] = OCCUPIED;
	const q = plan([[4, 3], [5, 4]]);
	const r = run(q, blocked);
	assert.strictEqual(r.closed, 0);
	assert.ok(r.left >= 1);
});

test('scenery on the tile is cleared when nothing free joins the step, other objects are left', () => {
	const blocked = new Uint8Array(W * H);
	blocked[cell(5, 3)] = blocked[cell(4, 4)] = OCCUPIED;
	const tree = { type: 'tree', l: 0, x: 5, y: 3, template: { mask: ['A'] } };
	const mine = { type: 'mine', l: 0, x: 4, y: 4, template: { mask: ['A'] } };
	const gone = [];
	const d = { clearScenery: (pl, l, w, h, b, spot) => { for (const o of spot.gone) gone.push(o); return spot.gone.size; }, isDecor: o => o.type === 'tree' };
	const p = plan([[4, 3], [5, 4]], [tree, mine]);
	const bc = (tpl, x, y) => [[x, y]];
	const r = closeDiagonalSteps(p, W, H, 0, blocked, OCCUPIED, bc, d);
	assert.strictEqual(r.closed, 1);
	assert.deepStrictEqual(gone, [tree]);
	assert.ok(p.roadCells.has(cell(5, 3)));
});
