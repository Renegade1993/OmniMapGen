/**
 * zone-floor-path.test.js - a zone whose open ground is all path still gets its floor of one visited object a 100 tiles (MapGen Dev's
 * 350 gate on d900c2f, 2026-10-14: five one-level zones of 50 to 140 tiles with every open tile reserved, mapsight's empty-zone FAIL;
 * r1_45_72p2f zone 3, 27 open of 103, one pile). fillBareWindows' floor puts a resource pile on a path tile a hero walks to when the
 * zone has no free tile; it is taken in passing. VMAPGEN_ZONE_FLOOR_PATH=0 is the old rule, which leaves the zone empty.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { fillBareWindows } = require('../src/biome/plan');
const { OCCUPIED, RESERVED } = require('../src/biome/content');
const { pileTemplate } = require('../src/biome/economy');

const run = () => {
	const W = 24, H = 24, blocked = new Uint8Array(W * H), zone = new Int16Array(W * H);
	const tpl = pileTemplate('randomResource');
	// zone 0 the left half, open; zone 1 the right half, rock but for a path along row 12 from zone 0's ground
	for (let y = 0; y < H; y++) for (let x = 12; x < W; x++) { zone[y * W + x] = 1; blocked[y * W + x] |= OCCUPIED; }
	for (let x = 12; x < W - 1; x++) { blocked[12 * W + x] &= ~OCCUPIED; blocked[12 * W + x] |= RESERVED; }
	const objects = [
		{ type: 'monolithTwoWay', subtype: 'object', x: 6, y: 12, l: 0, template: tpl },
		{ type: 'resource', subtype: 'wood', x: 3, y: 3, l: 0, template: tpl },
	];
	const pl = { zone, objects, roadCells: new Set(), p: {} };
	fillBareWindows(pl, 0, W, H, blocked, {});
	return pl.objects.filter(o => o.type === 'resource' && zone[o.y * W + o.x] === 1);
};

test('a zone of path only gets resource piles on its path', () => {
	const got = run();
	assert.ok(got.length >= 1, 'a pile in the path zone');
	for (const o of got) assert.strictEqual(o.y, 12, `pile at (${o.x},${o.y}) off the path`);
});

test('without the path rule the zone stays empty', () => {
	process.env.VMAPGEN_ZONE_FLOOR_PATH = '0';
	try { assert.strictEqual(run().length, 0); } finally { delete process.env.VMAPGEN_ZONE_FLOOR_PATH; }
});
