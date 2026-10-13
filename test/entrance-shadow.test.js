/**
 * entrance-shadow.test.js - a tile under a monolith's or a gate's picture is no way in (K, 2026-10-11, "two-way monolith blocking nearby
 * gem pond"; his small Coldshadow seed 876637007 regenerated: an ore pit (12,2), a gold mine (19,18) and one more object with every open
 * way in under a gate's or monolith's picture, none after). content.js entranceOpen skips a shadowed tile; plan.js fillLevel marks every
 * cell of a monolith's and a gate's picture (markShadow) before the fill, and the fill lays nothing whose picture touches one.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { entranceOpen, pictureOnShadow, markShadow, OCCUPIED } = require('../src/biome/content');
const { mineTemplate, pileTemplate } = require('../src/biome/economy');

const W = 10, H = 10;

test('a mine whose only open way in lies under an entrance picture has no entrance (VMAPGEN_FILL_SHADOW=1)', { skip: process.env.VMAPGEN_FILL_SHADOW !== '1' }, () => {
	const tpl = mineTemplate('orePit'), blocked = new Uint8Array(W * H);
	// the ore pit at (5,5): visiting tile (4,5), entered from (3,5), (5,5) and the row below; all but (4,6) walled
	for (const [x, y] of [[3, 5], [3, 6], [5, 6]]) blocked[y * W + x] = OCCUPIED;
	assert.ok(entranceOpen(tpl, 5, 5, 0, W, H, blocked, null), 'open while (4,6) is plain ground');
	markShadow(blocked, 6 * W + 4);
	assert.ok(!entranceOpen(tpl, 5, 5, 0, W, H, blocked, null), 'shut once (4,6) is under a picture');
});

test('a pile on a tile under an entrance picture is seen as drawn into it', () => {
	const tpl = pileTemplate('randomResource'), blocked = new Uint8Array(W * H);
	assert.ok(!pictureOnShadow(tpl, 4, 4, 0, W, H, blocked));
	markShadow(blocked, 4 * W + 4);
	assert.ok(pictureOnShadow(tpl, 4, 4, 0, W, H, blocked));
});
