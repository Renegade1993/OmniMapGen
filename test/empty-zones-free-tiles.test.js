/**
 * empty-zones-free-tiles.test.js - mapsight's empty-zone rule counts the tiles a hero can stand on, not every ground tile of the zone.
 * 72x72 four players underground seed 12: zone 8 is a diagonal strip of 68 tiles with 11 free; 108x108 seed 2: zone 16, 115 tiles with 3 free.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { emptyZones } = require('../tools/mapsight/lib/check');

const W = 20, H = 20;
// zone 3 covers the whole map; `free` tiles of it are open, the rest blocked; one level, no objects
const map = free => {
	const blocked = new Uint8Array(W * H).fill(1);
	for (let i = 0; i < free; i++) blocked[i] = 0;
	return { NL: 1, W, H, objs: [], blocked, zoneAt: () => 3, ground: () => true, idx: (l, x, y) => y * W + x };
};

test('a zone of 400 tiles with 11 free is not empty, one with 80 free and no object is', () => {
	assert.deepStrictEqual(emptyZones(map(11)), []);
	const r = emptyZones(map(80));
	assert.strictEqual(r.length, 1);
	assert.strictEqual(r[0].zone, 3);
});
