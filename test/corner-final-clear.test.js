/**
 * corner-final-clear.test.js - a road step that touches at a corner only is a defect whatever the layout (K, 2026-10-22 via the lead). closeDiagonalSteps takes
 * a tile beside the step; where one of the two is scenery on a zone line the earlier calls refuse it (clearing it would open a walk from one zone into the
 * other), and the last call (finalClear) takes it anyway. Two road tiles at (5,5) and (6,6); a rock piece on (6,5) on the line between zone 0 and zone 1,
 * a building on (5,6): the earlier call leaves the step, the final call clears the rock and joins the road, and the building stays.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const content = require('../src/biome/content');
const { closeDiagonalSteps } = require('../src/biome/gateroad');
const { clearScenery } = require('../src/biome/plan');

const W = 14, H = 12, N = W * H;
const { OCCUPIED, blockingCells, visitableCells, allowedDirs } = content;
const ROCK = { animation: 'rock', mask: ['B'] };
const HUT = { animation: 'hut', mask: ['A'], visitableFrom: ['+++', '+-+', '+++'] };

function level() {
	const blocked = new Uint8Array(N);
	const zone = new Int16Array(N);
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) zone[y * W + x] = x < 6 ? 0 : 1;
	const objects = [
		{ instanceName: 'rock', l: 0, x: 6, y: 5, type: 'rock', subtype: 'object', template: ROCK },
		{ instanceName: 'hut', l: 0, x: 5, y: 6, type: 'faerieRing', subtype: 'object', template: HUT },
	];
	for (const o of objects) for (const [fx, fy] of blockingCells(o.template, o.x, o.y)) blocked[fy * W + fx] |= OCCUPIED;
	const roadCells = new Set([5 * W + 5, 6 * W + 6, 4 * W + 4, 7 * W + 7]);
	return { plan: { objects, zone, roadCells, p: {} }, blocked };
}

function run(final) {
	const { plan, blocked } = level();
	const isDecor = o => !o.template.visitableFrom;
	const out = closeDiagonalSteps(plan, W, H, 0, blocked, OCCUPIED, blockingCells,
		{ allowBlock: true, clearScenery, isDecor, visitOf: visitableCells, dirsOf: allowedDirs, ...(final ? { finalClear: true } : {}) });
	return { out, plan };
}

test('the earlier call leaves a step whose free side is scenery on a zone line', () => {
	const r = run(false);
	assert.ok(!r.plan.roadCells.has(5 * W + 6), 'the road does not take (6,5)');
	assert.ok(r.plan.objects.some(o => o.instanceName === 'rock'), 'the rock stays');
});

test('the final call clears the rock on the zone line, joins the road and leaves the building', () => {
	const r = run(true);
	assert.ok(r.plan.roadCells.has(5 * W + 6), 'the road takes (6,5)');
	assert.ok(!r.plan.objects.some(o => o.instanceName === 'rock'), 'the rock is gone');
	assert.ok(r.plan.objects.some(o => o.instanceName === 'hut'), 'the building stays');
});
