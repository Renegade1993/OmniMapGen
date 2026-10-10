/**
 * road-trim.test.js - a road that ends at nothing is taken back to its junction (mapsight "road ends ... at nothing": 10 of 72 default
 * free-layout maps and 13 of 18 Coldshadow maps with Guards at bottlenecks off had one). Roads end at towns, mines, monoliths and gates;
 * a spur into a dead pocket goes, and so does a road run to a doorway or a monster (K, 2026-10-05).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { trimRoadStubs } = require('../src/biome/gateroad');

const W = 24, H = 24;
const cell = (x, y) => y * W + x;
const mock = o => ({
	visitableCells: (tpl, x, y) => [[x, y]],
	blockingCells: () => [],
	allowedDirs: () => [[-1, 0], [1, 0], [0, 1], [0, -1]],
});
const town = (x, y) => ({ type: 'town', l: 0, x, y, template: { mask: ['V'] } });
const plan = (cells, objects) => ({ roadCells: new Set(cells.map(([x, y]) => cell(x, y))), objects });
const run = p => trimRoadStubs(p, W, H, 0, mock().visitableCells, mock().blockingCells, mock().allowedDirs);

test('a spur into a dead pocket is cut back to the junction, the road between two towns stays', () => {
	const road = [];
	for (let x = 3; x <= 15; x++) road.push([x, 12]);
	const spur = [];
	for (let y = 7; y <= 11; y++) spur.push([9, y]);
	const p = plan([...road, ...spur], [town(2, 12), town(16, 12)]);
	const r = run(p);
	assert.strictEqual(r.cut, spur.length);
	for (const [x, y] of road) assert.ok(p.roadCells.has(cell(x, y)), `road tile ${x},${y} stays`);
	for (const [x, y] of spur) assert.ok(!p.roadCells.has(cell(x, y)), `spur tile ${x},${y} goes`);
});

test('an end that rests on a town stays; an end beside a monster is no destination and goes back to the town', () => {
	const road = [];
	for (let x = 3; x <= 12; x++) road.push([x, 5]);
	const mon = { type: 'randomMonsterLevel3', l: 0, x: 13, y: 5, template: { mask: ['V'] } };
	const p = plan(road, [town(2, 5), mon]);
	assert.ok(run(p).cut > 0, 'the stretch to the monster is taken back (K, 2026-10-05: a road that stops beside a figure)');
	assert.ok(!p.roadCells.has(cell(12, 5)), 'the tile beside the monster goes');
	assert.ok(p.roadCells.has(cell(3, 5)), 'the tile at the town stays');
	const q = plan(road, [town(2, 5), town(13, 5)]);
	assert.strictEqual(run(q).cut, 0);
	assert.strictEqual(q.roadCells.size, road.length);
});

test('a loop of road that touches no destination goes whole', () => {
	const ring = [];
	for (let x = 5; x <= 9; x++) { ring.push([x, 8]); ring.push([x, 12]); }
	for (let y = 9; y <= 11; y++) { ring.push([5, y]); ring.push([9, y]); }
	const p = plan(ring, []);
	assert.strictEqual(run(p).cut, ring.length);
	assert.strictEqual(p.roadCells.size, 0);
});

test('a loose piece with nothing at either end goes whole', () => {
	const loose = [];
	for (let x = 4; x <= 10; x++) loose.push([x, 18]);
	const p = plan(loose, []);
	assert.strictEqual(run(p).cut, loose.length);
	assert.strictEqual(p.roadCells.size, 0);
});
