/**
 * corner-decor-round.test.js - a road step that touches at a corner only, between two buildings, with no way round over free ground: the last call of
 * closeDiagonalSteps (finalClear) takes the way round over a tree, clears the tree and takes the step's tile off, so the road is joined side to side and
 * both buildings stay (K, 2026-10-22 via the lead: a diagonal-only road step is a defect; move the road, never the building). Every tile not named is a
 * building. Road (0..5,5) on down column 0, and (6..23,6), the step (5,5)-(6,6), buildings on (6,5) and (5,6); the way round (5,4) tree, (6,4), (7,4), (7,5) free.
 * Where clearing the tree would open a walk from one zone into another, the tree stays and so does the step.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const content = require('../src/biome/content');
const { closeDiagonalSteps } = require('../src/biome/gateroad');
const { clearScenery } = require('../src/biome/plan');

const W = 24, H = 20, N = W * H;
const { OCCUPIED, blockingCells, visitableCells, allowedDirs } = content;
const TREE = { animation: 'tree', mask: ['B'] };
const HUT = { animation: 'hut', mask: ['A'], visitableFrom: ['+++', '+-+', '+++'] };
const at = (x, y) => y * W + x;

function level(treeOnLine) {
	const blocked = new Uint8Array(N);
	const zone = new Int16Array(N);
	// each piece longer than the 12 tiles the arm cut takes up
	const road = [];
	for (let x = 0; x <= 5; x++) road.push([x, 5]);
	for (let y = 6; y < H; y++) road.push([0, y]);
	for (let x = 6; x < W; x++) road.push([x, 6]);
	const free = [[6, 4], [7, 4], [7, 5]];
	if (treeOnLine) zone[at(6, 4)] = 1;
	const roadCells = new Set(road.map(([x, y]) => at(x, y)));
	const objects = [{ instanceName: 'tree', l: 0, x: 5, y: 4, type: 'trees', subtype: 'object', template: TREE }];
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
		if (roadCells.has(at(x, y)) || free.some(([a, b]) => a === x && b === y) || (x === 5 && y === 4)) continue;
		objects.push({ instanceName: `hut${x}_${y}`, l: 0, x, y, type: 'faerieRing', subtype: 'object', template: HUT });
	}
	for (const o of objects) for (const [fx, fy] of blockingCells(o.template, o.x, o.y)) blocked[at(fx, fy)] |= OCCUPIED;
	return { plan: { objects, zone, roadCells, p: {} }, blocked };
}

function run(treeOnLine) {
	const { plan, blocked } = level(treeOnLine);
	const isDecor = o => !o.template.visitableFrom;
	const out = closeDiagonalSteps(plan, W, H, 0, blocked, OCCUPIED, blockingCells,
		{ allowBlock: true, clearScenery, isDecor, visitOf: visitableCells, dirsOf: allowedDirs, finalClear: true });
	return { out, plan };
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

test('the premise: the step lies between two buildings and nothing beside it can carry road', () => {
	const { plan, blocked } = level(false);
	assert.strictEqual(cornerSteps(plan.roadCells), 1);
	assert.ok(blocked[at(6, 5)] & OCCUPIED && blocked[at(5, 6)] & OCCUPIED);
});

test('the last call goes round over the tree: the tree is cleared, the step is gone, both buildings stay', () => {
	const r = run(false);
	assert.strictEqual(cornerSteps(r.plan.roadCells), 0, 'no corner-only step left');
	for (const [x, y] of [[5, 4], [6, 4], [7, 4], [7, 5]]) assert.ok(r.plan.roadCells.has(at(x, y)), `road on (${x},${y})`);
	assert.ok(!r.plan.objects.some(o => o.instanceName === 'tree'), 'the tree is gone');
	assert.ok(r.plan.objects.some(o => o.instanceName === 'hut6_5') && r.plan.objects.some(o => o.instanceName === 'hut5_6'), 'both buildings stay');
	assert.strictEqual(r.out.decorRound, 1);
});

test('a tree whose clearing opens a walk into another zone stays, and the step with it', () => {
	const r = run(true);
	assert.ok(r.plan.objects.some(o => o.instanceName === 'tree'), 'the tree stays');
	assert.strictEqual(cornerSteps(r.plan.roadCells), 1, 'the step is left');
});

test('VMAPGEN_ROAD_DIAG_LINK_DECOR=0 leaves the step', () => {
	process.env.VMAPGEN_ROAD_DIAG_LINK_DECOR = '0';
	try {
		const r = run(false);
		assert.strictEqual(cornerSteps(r.plan.roadCells), 1);
		assert.ok(r.plan.objects.some(o => o.instanceName === 'tree'));
	} finally { delete process.env.VMAPGEN_ROAD_DIAG_LINK_DECOR; }
});
