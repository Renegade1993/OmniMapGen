/**
 * sweep.test.js - the stranded sweep (plan.js sweepStranded) keeps what a hero
 * can reach. A removable object (a pickup, a monster) is cleared once its own
 * approach is reached, and the walk has to carry on over the ground it stood
 * on. Until 2026-09-26 it did not: those cells were skipped while held and
 * never looked at again, so everything behind a pickup or a guard was dropped,
 * 19 to 31 objects on every 108x108 map, template mines among them.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { sweepStranded } = require('../src/biome/plan');

const ONE = { mask: ['A'], visitableFrom: ['+++', '+-+', '+++'] };
const WALL = { mask: ['B'] };
const obj = (type, x, y, tpl, extra = {}) => ({ type, x, y, l: 0, template: tpl,
	instanceName: `${type}_${x}_${y}`, ...extra });

test('ground a cleared pickup stood on carries the walk on to what lies behind it', () => {
	// row 2 is a one-wide corridor: town, open, resource, open, mine
	const W = 9, H = 5;
	const objects = [
		obj('randomTown', 0, 2, ONE, { options: { owner: 'red' } }),
		obj('resource', 2, 2, ONE),
		obj('mine', 4, 2, ONE),
	];
	for (let x = 0; x < W; x++) {
		objects.push(obj('mountain', x, 1, WALL));
		objects.push(obj('mountain', x, 3, WALL));
	}
	for (let x = 5; x < W; x++) objects.push(obj('mountain', x, 2, WALL));
	const plan = { objects, p: {} };
	sweepStranded(plan, W, H, 0, [{ x: 0, y: 2, color: 'red' }], new Set());
	assert.ok(plan.objects.some(o => o.type === 'mine'), 'the mine behind the pickup is kept');
	assert.ok(plan.objects.some(o => o.type === 'resource'));
});

test('an object with no way in at all is still dropped', () => {
	const W = 9, H = 5;
	const objects = [
		obj('randomTown', 0, 2, ONE, { options: { owner: 'red' } }),
		obj('mine', 4, 2, ONE),
		obj('mountain', 2, 2, WALL),
	];
	for (let x = 0; x < W; x++) {
		objects.push(obj('mountain', x, 1, WALL));
		objects.push(obj('mountain', x, 3, WALL));
	}
	const plan = { objects, p: {} };
	sweepStranded(plan, W, H, 0, [{ x: 0, y: 2, color: 'red' }], new Set());
	assert.ok(!plan.objects.some(o => o.type === 'mine'), 'a mine walled off by rock goes');
});
