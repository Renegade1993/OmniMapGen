/**
 * corner-move-tile.test.js - a corner-only road step whose two tiles are already in one piece, where neither can come off because taking it leaves two
 * of its neighbours touching at a corner (tb108 s7202 on the 114 panel cases, beside a mine's door): the last call of closeDiagonalSteps (finalClear)
 * takes the step's tile off and lays the road on the free tile at the other corner, so the road runs side to side (K, 2026-10-22 via the lead: a
 * diagonal-only road step is a defect; move the road, never the building). Every tile not named is a building.
 * Road: column (5,0..5), the step (5,6)-(6,7), the loop (4,6) (4,7) (4,8) (5,8) (6,8), and (7,7) on to the east edge. Free: (4,5).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const content = require('../src/biome/content');
const { closeDiagonalSteps } = require('../src/biome/gateroad');
const { clearScenery } = require('../src/biome/plan');

const W = 24, H = 12, N = W * H;
const { OCCUPIED, blockingCells, visitableCells, allowedDirs } = content;
const HUT = { animation: 'hut', mask: ['A'], visitableFrom: ['+++', '+-+', '+++'] };
const at = (x, y) => y * W + x;

function level() {
	const blocked = new Uint8Array(N);
	const zone = new Int16Array(N);
	const road = [[4, 6], [4, 7], [4, 8], [5, 8], [6, 8], [5, 6], [6, 7]];
	for (let y = 0; y <= 5; y++) road.push([5, y]);
	for (let x = 7; x < W; x++) road.push([x, 7]);
	const roadCells = new Set(road.map(([x, y]) => at(x, y)));
	const objects = [];
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
		if (roadCells.has(at(x, y)) || (x === 4 && y === 5)) continue;
		objects.push({ instanceName: `hut${x}_${y}`, l: 0, x, y, type: 'faerieRing', subtype: 'object', template: HUT });
	}
	for (const o of objects) for (const [fx, fy] of blockingCells(o.template, o.x, o.y)) blocked[at(fx, fy)] |= OCCUPIED;
	return { plan: { objects, zone, roadCells, p: {} }, blocked };
}

function run() {
	const { plan, blocked } = level();
	const isDecor = o => !o.template.visitableFrom;
	const n0 = plan.objects.length;
	const out = closeDiagonalSteps(plan, W, H, 0, blocked, OCCUPIED, blockingCells,
		{ allowBlock: true, clearScenery, isDecor, visitOf: visitableCells, dirsOf: allowedDirs, finalClear: true });
	return { out, plan, n0 };
}

function cornerSteps(R) {
	let k = 0;
	for (const c of R) {
		const x = c % W, y = (c / W) | 0;
		for (const [dx, dy] of [[1, 1], [1, -1]]) {
			const nx = x + dx, ny = y + dy;
			if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
			if (R.has(at(nx, ny)) && !R.has(at(nx, y)) && !R.has(at(x, ny))) k++;
		}
	}
	return k;
}

test('the premise: one corner-only step, both tiles in one piece', () => {
	assert.strictEqual(cornerSteps(level().plan.roadCells), 1, 'the step (5,6)-(6,7)');
});

test('the last call moves the road a tile: (5,6) comes off, (4,5) takes the road, no building goes', () => {
	const r = run();
	assert.ok(!r.plan.roadCells.has(at(5, 6)), '(5,6) off');
	assert.ok(r.plan.roadCells.has(at(4, 5)), '(4,5) on');
	assert.ok(!r.plan.roadCells.has(at(5, 6)) && r.plan.roadCells.has(at(6, 7)), 'the other tile of the step stays');
	assert.strictEqual(r.plan.objects.length, r.n0, 'no object removed');
	assert.ok(r.out.moved >= 1);
	assert.strictEqual(cornerSteps(r.plan.roadCells), 0, 'no corner-only step left');
});

test('VMAPGEN_ROAD_DIAG_MOVE=0 leaves (5,6) on the road', () => {
	process.env.VMAPGEN_ROAD_DIAG_MOVE = '0';
	try { assert.ok(run().plan.roadCells.has(at(5, 6))); } finally { delete process.env.VMAPGEN_ROAD_DIAG_MOVE; }
});
