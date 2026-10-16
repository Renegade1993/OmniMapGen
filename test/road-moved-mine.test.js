/**
 * road-moved-mine.test.js - a road to where a start mine stood goes back once the mine moves (the start rule moves a start's sawmill or ore
 * pit off a strong stack's ring; its old road ran on to nothing, mapsight "road ends at an object", check89 p2_108L2_s3 (8,23); the Opus
 * Reviewer, pass 74: pin it). generate.js runs trimRoadStubs and lonePieces again on a level where startPrimaryGuards moved a mine; here
 * the trim itself, on a town's road with a spur to a mine's door: the spur stays while the mine is there and goes once it is gone.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { trimRoadStubs, lonePieces } = require('../src/biome/gateroad');

const W = 24, H = 16, D8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const tpl = { mask: ['VV'] };
const visitableCells = (t, x, y) => [[x, y]];
const blockingCells = (t, x, y) => [[x, y]];
const allowedDirs = () => D8;

function plan() {
	// a town at (2,8) with a road east along row 8 to a second town at (20,8), and a spur north from (11,8) to a mine's door at (11,3)
	const road = new Set();
	for (let x = 3; x <= 19; x++) road.add(8 * W + x);
	for (let y = 4; y <= 7; y++) road.add(y * W + 11);
	const objects = [
		{ type: 'town', x: 2, y: 8, l: 0, template: tpl },
		{ type: 'town', x: 20, y: 8, l: 0, template: tpl },
		{ type: 'mine', subtype: 'sawmill', x: 11, y: 3, l: 0, template: tpl },
	];
	return { roadCells: road, objects };
}

test('the spur to a mine stays while the mine is there', () => {
	const p = plan();
	const before = p.roadCells.size;
	trimRoadStubs(p, W, H, 0, visitableCells, blockingCells, allowedDirs);
	lonePieces(p, W, H, 0, visitableCells);
	assert.ok(p.roadCells.has(4 * W + 11), 'the road still reaches the mine');
	assert.strictEqual(p.roadCells.size, before);
});

test('once the mine moves, the spur to its old door goes back to the junction and the road between the towns stays', () => {
	const p = plan();
	p.objects = p.objects.filter(o => o.type !== 'mine');
	trimRoadStubs(p, W, H, 0, visitableCells, blockingCells, allowedDirs);
	lonePieces(p, W, H, 0, visitableCells);
	for (let y = 4; y <= 7; y++) assert.ok(!p.roadCells.has(y * W + 11), `(11,${y}) taken back`);
	for (let x = 3; x <= 19; x++) assert.ok(p.roadCells.has(8 * W + x), `(${x},8) between the towns stays`);
});
