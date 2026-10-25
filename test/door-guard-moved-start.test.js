/**
 * door-guard-moved-start.test.js - a doorway guard keeps off the ground before
 * a start's town where the town finally stands, after the capitals pass has
 * moved it (findings-oe.md, plan.js townCells).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { startTownCells, moveDoorGuards } = require('../src/biome/plan');

test('a doorway guard measured against the moved town moves off its gate', () => {
	const W = 40, H = 40;
	const start = { x: 10, y: 10 };
	// a doorway hole running across the row in front of where the town will stand
	const before = startTownCells([start], W, H);
	start.x = 25; start.y = 25;
	const after = startTownCells([start], W, H);
	const front = [...after].find(c => !before.has(c) && (c / W | 0) === 27);
	assert.ok(front !== undefined, 'a cell before the moved town');
	const hole = [];
	for (let x = 15; x < 36; x++) hole.push(27 * W + x);
	const g = { cell: front, edge: [0, 1] };
	// measured against the old town, the guard stays where it is
	assert.strictEqual(moveDoorGuards([g], [{ hole }], c => before.has(c), W, 0).length, 0);
	assert.strictEqual(g.cell, front);
	// measured against the town's final cell, it leaves the town's ground
	const moved = moveDoorGuards([g], [{ hole }], c => after.has(c), W, 0);
	assert.deepStrictEqual(moved.map(([, from]) => from), [front]);
	assert.ok(!after.has(g.cell) && hole.includes(g.cell));
});
