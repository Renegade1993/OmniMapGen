/**
 * portalends.test.js - a monster taken off a portal's end leaves its tiles
 * free, its own tile included (findings-oe.md, portalends.js).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { clearPortalEnds } = require('../src/biome/portalends');
const { blockingCells, visitableCells, allowedDirs, OCCUPIED } = require('../src/biome/content');

test('clearPortalEnds: a removed 1x1 monster frees its own tile', () => {
	const W = 10, H = 10;
	const blocked = new Uint8Array(W * H);
	const monolith = { type: 'monolithTwoWay', x: 4, y: 4, l: 0, template: { mask: ['A'], visitableFrom: ['+++', '+-+', '+++'] } };
	const monster = { type: 'randomMonsterLevel3', x: 5, y: 5, l: 0, template: { mask: ['A'], visitableFrom: ['+++', '+-+', '+++'] } };
	blocked[4 * W + 4] |= OCCUPIED;
	blocked[5 * W + 5] |= OCCUPIED;
	const plan = { objects: [monolith, monster] };
	const r = clearPortalEnds(plan, W, H, 0, blocked, { OCCUPIED, blockingCells, visitableCells, allowedDirs });
	assert.strictEqual(r.removed, 1);
	assert.deepStrictEqual(plan.objects, [monolith]);
	assert.strictEqual(blocked[5 * W + 5] & OCCUPIED, 0);
});
