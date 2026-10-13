/**
 * entrance-shadow.test.js - a tile under a monolith's or a gate's picture is no way in (K, 2026-10-11, "two-way monolith blocking nearby
 * gem pond"; his small Coldshadow seed 876637007 regenerated: an ore pit (12,2), a gold mine (19,18) and one more object with every open
 * way in under a gate's or monolith's picture, none after). content.js entranceOpen skips a SHADOW tile; plan.js fillLevel marks the
 * V tiles of every monolith and gate SHADOW and RESERVED before the fill, so nothing is laid there either.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { entranceOpen, footprintFits, OCCUPIED, RESERVED, SHADOW } = require('../src/biome/content');
const { mineTemplate, pileTemplate } = require('../src/biome/economy');

const W = 10, H = 10;

test('a mine whose only open way in lies under an entrance picture has no entrance', () => {
	const tpl = mineTemplate('orePit'), blocked = new Uint8Array(W * H);
	// the ore pit at (5,5): visiting tile (4,5), entered from (3,5), (5,5) and the row below; all but (4,6) walled
	for (const [x, y] of [[3, 5], [3, 6], [5, 6]]) blocked[y * W + x] = OCCUPIED;
	assert.ok(entranceOpen(tpl, 5, 5, 0, W, H, blocked, null), 'open while (4,6) is plain ground');
	blocked[6 * W + 4] = RESERVED | SHADOW;
	assert.ok(!entranceOpen(tpl, 5, 5, 0, W, H, blocked, null), 'shut once (4,6) is under a picture');
});

test('a pile does not fit on a tile under an entrance picture', () => {
	const tpl = pileTemplate('randomResource'), blocked = new Uint8Array(W * H);
	assert.ok(footprintFits(tpl, 4, 4, 0, W, H, blocked, true));
	blocked[4 * W + 4] = RESERVED | SHADOW;
	assert.ok(!footprintFits(tpl, 4, 4, 0, W, H, blocked, true));
});
