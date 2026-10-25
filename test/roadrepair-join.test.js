/**
 * roadrepair-join.test.js - a gap between two roads is joined once: once the
 * first bridge stands, the ends of the joined road do not build more back
 * over it (findings-oe.md, roadrepair.js joinGaps).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { roadRepair } = require('../src/biome/roadrepair');
const { blockingCells, visitableCells, OCCUPIED } = require('../src/biome/content');

test('roadRepair: two roads three tiles apart get one bridge', () => {
	const W = 20, H = 12;
	const road = new Set();
	for (let x = 2; x <= 6; x++) road.add(5 * W + x);        // A, along y 5
	for (let y = 2; y <= 8; y++) road.add(y * W + 9);        // B, down x 9
	// a mine at each far end, so no end is cut as leading nowhere
	const mine = (x, y) => ({ type: 'mine', x, y, l: 0, template: { mask: ['A'], visitableFrom: ['+++', '+-+', '+++'] } });
	const plan = { roadCells: road, objects: [mine(1, 5), mine(9, 1), mine(9, 9)] };
	roadRepair(plan, W, H, 0, new Uint8Array(W * H), OCCUPIED, new Set(), blockingCells, visitableCells);
	// between the roads (x 7 and 8) the tiles of one bridge, on one row
	const between = [...road].filter(c => c % W === 7 || c % W === 8);
	const rows = new Set(between.map(c => (c / W) | 0));
	assert.strictEqual(rows.size, 1, `road between the two at ${between.map(c => `(${c % W},${(c / W) | 0})`).join(' ')}`);
});
