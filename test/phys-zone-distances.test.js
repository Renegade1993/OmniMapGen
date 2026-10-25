/**
 * phys-zone-distances.test.js - a zone no start walks to reads as far, and
 * every zone has an entry (findings-oe.md, biomes.js physZoneDistances).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { physZoneDistances } = require('../src/biome/biomes');

test('physZoneDistances: a zone behind water is the farthest, not the nearest', () => {
	// 9x3: zone 0 (x 0-2) with the start, zone 1 (x 3-5) dry, a lake at x 6, zone 2 (x 7-8) beyond it
	const W = 9, H = 3, zone = new Int32Array(W * H), water = new Uint8Array(W * H);
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
		zone[y * W + x] = x < 3 ? 0 : x < 7 ? 1 : 2;
		if (x === 6) water[y * W + x] = 1;
	}
	const d = physZoneDistances(zone, W, H, [{ x: 0, y: 1 }], water, false);
	assert.strictEqual(d.length, 3);
	assert.ok(d[2] > d[1] && d[1] > d[0], `distances ${d.join(', ')}`);
});
