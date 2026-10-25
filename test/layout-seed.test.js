/**
 * layout-seed.test.js - each level and each try of a template layout draws
 * its own stream, large seeds included (findings-oe.md, plan.js 2407, 2444).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { layoutSeed } = require('../src/biome/plan');

test('layoutSeed: two levels of a large seed differ; small seeds keep their value', () => {
	const seed = 620090276;
	// in doubles the level's term is lost: the old formula gave one value for both levels
	assert.strictEqual(((seed * 2654435761) + 97 + 13) >>> 0, ((seed * 2654435761) + 13) >>> 0);
	assert.notStrictEqual(layoutSeed(seed, 0, 0, 13), layoutSeed(seed, 1, 0, 13));
	assert.notStrictEqual(layoutSeed(seed, 0, 0, 13), layoutSeed(seed, 0, 1, 13));
	for (const s of [1, 7, 4242, 3000000])
		for (const [l, k] of [[0, -1], [0, 0], [1, 3]])
			assert.strictEqual(layoutSeed(s, l, k, 13), ((s * 2654435761) + l * 97 + k * 7919 + 13) >>> 0);
});
