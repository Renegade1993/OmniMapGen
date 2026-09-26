/**
 * sliver.test.js
 *
 * Pins the one-cell sliver count behind content.js put()'s item 21 rule: a
 * sliver is open ground that sat inside a fully free 2x2 before a placement
 * and sits inside none after it, which is what roomy% counts against a map.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { sliverCount, OCCUPIED } = require('../src/biome/content');

const W = 12, H = 12;
function grid(wallRow) {
	const blocked = new Uint8Array(W * H);
	if (wallRow >= 0) for (let x = 0; x < W; x++) blocked[wallRow * W + x] |= OCCUPIED;
	return blocked;
}

test('a pickup flush against a straight wall leaves no sliver', () => {
	const blocked = grid(3);
	assert.strictEqual(sliverCount([4 * W + 6], blocked, 0, W, H), 0);
});

test('a pickup one cell off a wall leaves the cell between as a sliver', () => {
	const blocked = grid(3);
	// the cell straight between is the only one no free 2x2 can hold
	assert.strictEqual(sliverCount([5 * W + 6], blocked, 0, W, H), 1);
});

test('a pickup out in the open leaves no sliver', () => {
	const blocked = grid(-1);
	assert.strictEqual(sliverCount([6 * W + 6], blocked, 0, W, H), 0);
});

test('two pickups one cell apart pinch the cell between them', () => {
	const blocked = grid(-1);
	blocked[6 * W + 4] |= OCCUPIED;
	assert.strictEqual(sliverCount([6 * W + 6], blocked, 0, W, H), 1);
});

test('ground that was already a sliver is not counted again', () => {
	// a one-wide corridor between two walls: nothing in it is roomy before
	const blocked = grid(3);
	for (let x = 0; x < W; x++) blocked[5 * W + x] |= OCCUPIED;
	assert.strictEqual(sliverCount([4 * W + 6], blocked, 0, W, H), 0);
});
