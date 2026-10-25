/**
 * caverock.test.js - which scenery becomes cave wall does not depend on the
 * order of the plan's objects: a piece turns when it touches the wall as it
 * stood before the pass (findings-oe.md, caverock.js).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { sceneryToRock } = require('../src/biome/caverock');
const { blockingCells } = require('../src/biome/content');
const { makeMaskChecker } = require('../src/exporter/maskcheck');
const { buildPatterns } = require('../src/exporter/terrainView');

const patterns = buildPatterns(JSON.parse(fs.readFileSync(
	path.join(__dirname, '../src/exporter/terrainViewPatterns.json'), 'utf8')
	.replace(/^\s*\/\/.*$/gm, '')));
const ROCK = { id: 'core:rock', group: 'rock', transitionRequired: true, passable: false, isDirt: false, isSand: false };
const SUB = { id: 'core:subterra', group: 'normal', transitionRequired: false, passable: true, isDirt: false, isSand: false };
const checker = makeMaskChecker(patterns, ROCK, [SUB]);

test('sceneryToRock: the same pieces turn whatever order the plan lists them in', () => {
	const { xorshift } = require('../src/wfc/solver');
	const W = 16, H = 16;
	// random rock and one-tile pieces; layout 89 turned (3,3) in one order and not in the other
	for (let seed = 80; seed <= 100; seed++) {
		const r = xorshift(seed * 7919 + 1);
		const base = new Uint8Array(W * H).fill(1);
		for (let k = 0; k < 6; k++) {
			const x0 = (r() * 12) | 0, y0 = (r() * 12) | 0, w = 2 + ((r() * 4) | 0), h = 2 + ((r() * 4) | 0);
			for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) base[y * W + x] = 0;
		}
		const pieces = [];
		for (let k = 0; k < 12; k++) {
			const c = (r() * W * H) | 0;
			if (base[c] && !pieces.some(p => p.y * W + p.x === c)) pieces.push({ type: 'rock', x: c % W, y: (c / W) | 0, l: 0, template: { mask: ['B'] } });
		}
		const run = list => {
			const plan = { openMask: base.slice(), objects: list.map(o => ({ ...o })) };
			sceneryToRock(plan, W, H, 0, () => true, blockingCells, checker);
			return plan.objects.map(o => o.y * W + o.x).sort((a, b) => a - b);
		};
		assert.deepStrictEqual(run(pieces), run(pieces.slice().reverse()), `layout ${seed}`);
	}
});
