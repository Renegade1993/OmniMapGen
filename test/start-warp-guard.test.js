/**
 * start-warp-guard.test.js - a free layout's start keeps its own middle at any Border wobble (cause 4 of the playable gate, 2026-10-16).
 * At wobble 1.5 the domain warp moves a tile about a zone's spacing, so the tiles round a corner start were measured from far off and
 * went to a neighbour: 72x72, 4 players, seed 1 gave the start a zone of 20 tiles and a walk of 20 tiles. biomes.js partitionBiomes now
 * fades the warp out towards each start for that start's own distance. Without it, 6 of these 40 layouts give a start's own tile to
 * another zone (VMAPGEN_START_WARP_GUARD=0).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { partitionBiomes } = require('../src/biome/biomes');
const { xorshift } = require('../src/wfc/solver');

test('free layout at Border wobble 1.5: every corner start owns its own tile and at least half its area', () => {
	const W = 72, H = 72, cells = 648;
	const starts = [{ x: 4, y: 4 }, { x: 67, y: 67 }, { x: 4, y: 67 }, { x: 67, y: 4 }];
	const bad = [];
	for (let seed = 1; seed <= 40; seed++) {
		const { zone } = partitionBiomes(W, H, starts, 10, xorshift(seed * 7919), { biomeWobble: 1.5 }, null, cells);
		const area = [0, 0, 0, 0];
		for (let c = 0; c < W * H; c++) if (zone[c] < 4) area[zone[c]]++;
		starts.forEach((s, i) => {
			if (zone[s.y * W + s.x] !== i || area[i] < 0.5 * cells) bad.push(`seed ${seed} start ${i}: tile in zone ${zone[s.y * W + s.x]}, ${area[i]} tiles`);
		});
	}
	assert.deepStrictEqual(bad, []);
});

test('free layout with the starts owed their area (the generator\'s path): the guard leaves the Border wobble slider its reach', () => {
	const W = 96, H = 96, cells = 0.5 * W * H / 4;
	const starts = [{ x: 12, y: 12 }, { x: 84, y: 84 }, { x: 84, y: 12 }, { x: 12, y: 84 }];
	const borderOf = wobble => {
		let n = 0;
		for (let seed = 1; seed <= 4; seed++) {
			const { zone } = partitionBiomes(W, H, starts, 12, xorshift(seed * 7919), { biomeWobble: wobble }, null, cells);
			for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
				if (x + 1 < W && zone[y * W + x] !== zone[y * W + x + 1]) n++;
				if (y + 1 < H && zone[y * W + x] !== zone[(y + 1) * W + x]) n++;
			}
		}
		return n;
	};
	// 2026-10-16 with the guard: 2529, 3151, 3638 (0.80 and 1.15 of the default; 0.80 and 1.16 without it)
	const b0 = borderOf(0), b6 = borderOf(0.6), b15 = borderOf(1.5);
	assert.ok(b0 < 0.85 * b6, `wobble 0 ${b0} against 0.6 ${b6}`);
	assert.ok(b15 > 1.12 * b6, `wobble 1.5 ${b15} against 0.6 ${b6}`);
});
