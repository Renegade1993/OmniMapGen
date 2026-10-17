/**
 * join-ways-edge.test.js - a zone's pieces are joined when the piece to reach lies on the map's outermost ring.
 * 144x144 two levels, 2 players, seed 55928 (biomeWobble 0): the 14-19 doorway on level 1 opens at x=143, a piece of the zone only that column wide.
 * joinZoneWaysIn never stepped on the outermost ring, so it could not reach that piece, left it, and the sweep emptied zone 14 and zone 6 above it.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { joinZoneWaysIn } = require('../src/biome/plan');

const W = 20, H = 20, N = W * H;
const at = (x, y) => y * W + x;

// zone 0 fills the map; its open ground is the body x 2..17 and a strip down the last column x=19, with a rock column at x=18 between them
const level = () => {
	const zone = new Int32Array(N).fill(0), openMask = new Uint8Array(N), blocked = new Uint8Array(N);
	for (let y = 2; y <= 17; y++) for (let x = 2; x <= 17; x++) openMask[at(x, y)] = 1;
	for (let y = 8; y <= 10; y++) openMask[at(19, y)] = 1;
	for (let c = 0; c < N; c++) if (!openMask[c]) blocked[c] |= 1;
	// two doorways of the zone: one in the body, one on the last column (the opening's hole is its tiles)
	const openings = [
		{ kind: 'openRoad', a: 0, b: 1, hole: [at(5, 5), at(5, 6)] },
		{ kind: 'openRoad', a: 0, b: 2, hole: [at(19, 9)] },
	];
	return { pl: { zone, openMask, objects: [], openings, p: {} }, blocked };
};

test('the strip on the last column is joined to the body through one rock tile', () => {
	const { pl, blocked } = level();
	const r = joinZoneWaysIn(pl, 0, W, H, blocked);
	assert.strictEqual(r.left, 0, 'nothing left unjoined');
	assert.strictEqual(r.joined, 1);
	assert.strictEqual(r.rock, 1);
	assert.ok([7, 8, 9, 10, 11].some(y => pl.openMask[at(18, y)]), 'a tile of the rock column beside the strip is open now');
});

test('the outermost ring is still not carved where no doorway or open ground lies', () => {
	const { pl, blocked } = level();
	joinZoneWaysIn(pl, 0, W, H, blocked);
	for (let y = 0; y < H; y++) if (y < 8 || y > 10) assert.strictEqual(pl.openMask[at(19, y)], 0, `column 19 row ${y} stays rock`);
});
