/**
 * sealed-pockets.test.js - a pocket no barrier can open does not stop the
 * pass from opening the next one (findings-oe.md, plan.js openSealedPockets).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { openSealedPockets } = require('../src/biome/plan');
const { OCCUPIED } = require('../src/biome/content');

test('openSealedPockets: a pocket walled by objects is passed over, the barrier wall still opens', () => {
	const W = 20, H = 10, blocked = new Uint8Array(W * H), barriers = new Set();
	// the top left corner (0,0)-(1,0), shut in by objects, which no barrier touches
	for (const [x, y] of [[2, 0], [2, 1], [0, 1], [1, 1]]) blocked[y * W + x] |= OCCUPIED;
	// a barrier wall down x 11, the right side cut off by it
	for (let y = 0; y < H; y++) barriers.add(y * W + 11);
	const removed = openSealedPockets(barriers, W, H, 0, blocked, [{ x: 4, y: 5 }]);
	assert.strictEqual(removed, 1);
	assert.strictEqual(barriers.size, H - 1);
});
