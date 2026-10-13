/**
 * road-end-on-door.test.js - a road that ends beside a town, mine, monolith or gate ends on its door: on its visiting tile or a tile it
 * is entered from, never a tile short of one or a tile past one (K, 2026-10-12, his small Coldshadow seed 1099575901, two of the three
 * circled ends on level 1: (19,27) a diagonal step short of the gold mine's door (20,27), and (31,2) one tile past the mine's door
 * (32,2); 42 such ends on the 80 grid maps of check62). gateroad.js trimRoadStubs on a hand-made level: a gold mine at (6,5), its
 * visiting tile (5,5), entered from (4,6), (5,6), (6,6) and the sides; a road up column 3 whose far end (3,11) is a kept end.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { mineTemplate } = require('../src/biome/economy');
const { visitableCells, blockingCells, allowedDirs } = require('../src/biome/content');
const { trimRoadStubs } = require('../src/biome/gateroad');

const W = 12, H = 14, at = (x, y) => y * W + x;
const level = road => {
	const tpl = mineTemplate('goldMine');
	return { objects: [{ type: 'mine', subtype: 'goldMine', x: 6, y: 5, l: 0, template: tpl }], roadCells: new Set(road.map(([x, y]) => at(x, y))),
		roadEndsKept: new Set([at(3, 11)]) };
};

test('a road end a diagonal step short of a mine\'s door goes on onto the door', () => {
	const plan = level([[3, 11], [3, 10], [3, 9], [3, 8], [3, 7]]);
	trimRoadStubs(plan, W, H, 0, visitableCells, blockingCells, allowedDirs);
	assert.ok(plan.roadCells.has(at(4, 6)), 'the door (4,6) is road');
	for (let y = 7; y <= 11; y++) assert.ok(plan.roadCells.has(at(3, y)), `(3,${y}) kept`);
});

test('a road end one tile past a mine\'s door is taken off', () => {
	const plan = level([[3, 11], [3, 10], [3, 9], [3, 8], [3, 7], [4, 6], [3, 5]]);
	trimRoadStubs(plan, W, H, 0, visitableCells, blockingCells, allowedDirs);
	assert.ok(!plan.roadCells.has(at(3, 5)), '(3,5) past the door is gone');
	assert.ok(plan.roadCells.has(at(4, 6)), 'the door (4,6) stays road');
});
