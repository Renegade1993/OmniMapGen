/**
 * free-wobble.test.js - the Border wobble slider bends a free layout's zone borders (the lead, 2026-10-14, from MapGen Dev's lever test:
 * the free layout's domain warp was fixed at 1.7 whatever the slider said, so wobble 0 was not straight lines and 1.5 added a few
 * percent of border at most). biomes.js partitionBiomes scales the warp by the slider as partitionSeeded does: at wobble 0 the
 * borders are shorter than at the default, and at 1.5 longer, by a clear margin.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { partitionBiomes } = require('../src/biome/biomes');
const { xorshift } = require('../src/wfc/solver');

const borderOf = wobble => {
	const W = 96, H = 96;
	const starts = [{ x: 12, y: 12 }, { x: 84, y: 84 }, { x: 84, y: 12 }, { x: 12, y: 84 }];
	let n = 0;
	for (let seed = 1; seed <= 4; seed++) {
		const { zone } = partitionBiomes(W, H, starts, 12, xorshift(seed * 7919), { biomeWobble: wobble });
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
			if (x + 1 < W && zone[y * W + x] !== zone[y * W + x + 1]) n++;
			if (y + 1 < H && zone[y * W + x] !== zone[(y + 1) * W + x]) n++;
		}
	}
	return n;
};

test('free layout: border length rises with the Border wobble slider', () => {
	const b0 = borderOf(0), b6 = borderOf(0.6), b15 = borderOf(1.5);
	assert.ok(b0 < 0.9 * b6, `wobble 0 ${b0} against 0.6 ${b6}`);
	assert.ok(b15 > 1.1 * b6, `wobble 1.5 ${b15} against 0.6 ${b6}`);
});
