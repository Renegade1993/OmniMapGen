/**
 * start-spacing-whole.test.js - a start moved so its zone's second town can stand TOWN_WALK walking tiles off must keep its door joined to most of the zone.
 * 48x48 Coldshadow's Fantasy, seven players, seed 34458: tan's start went to a shore pocket of 16 tiles, because ground the door "does not reach at all"
 * counted as room for the second town and a pocket reaches none of the zone's ground (mapsight: start reaches 0 of 9 land zones).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { startForSpacing } = require('../src/biome/plan');

const W = 40, H = 40;
// one zone over the whole map, with a ring of water round a 7 x 9 pocket in the upper left (a lake that left a shore pocket)
const level = () => {
	const zone = new Int32Array(W * H).fill(0), water = new Uint8Array(W * H), blocked = new Uint8Array(W * H);
	for (let y = 7; y <= 17; y++) for (let x = 7; x <= 15; x++) if (x === 7 || x === 15 || y === 7 || y === 17) water[y * W + x] = 1;
	return { zone, water, blocked };
};
const inPocket = p => p.x > 7 && p.x < 15 && p.y > 7 && p.y < 17;

test('a spot on a pocket the water cuts off is not taken for a start, though the rest of the zone then counts as unreached ground', () => {
	const { zone, water, blocked } = level();
	const at = { x: 11, y: 12 };
	const was = process.env.VMAPGEN_TOWN_WHOLE;
	process.env.VMAPGEN_TOWN_WHOLE = '0';
	try { assert.deepStrictEqual(startForSpacing(zone, 0, W, H, 0, blocked, water, null, at), at, 'without the rule the pocket passes'); }
	finally { if (was === undefined) delete process.env.VMAPGEN_TOWN_WHOLE; else process.env.VMAPGEN_TOWN_WHOLE = was; }
	const r = startForSpacing(zone, 0, W, H, 0, blocked, water, null, at);
	assert.ok(r && !inPocket(r), 'the start moves out of the pocket: ' + JSON.stringify(r));
});

test('a spot whose door reaches the zone is kept', () => {
	const { zone, water, blocked } = level();
	const at = { x: 24, y: 24 };
	assert.deepStrictEqual(startForSpacing(zone, 0, W, H, 0, blocked, water, null, at), at);
});
