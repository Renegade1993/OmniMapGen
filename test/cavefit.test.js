/**
 * cavefit.test.js
 *
 * Pins the cave repair (src/biome/cavefit.js, queue item 26): it lowers the
 * cells no rock sprite fits, it never opens rock between two zones, and it
 * never closes ground that would cut a path.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { fitCave, zoneSafeToOpen, safeToClose } = require('../src/biome/cavefit');
const { makeMaskChecker } = require('../src/exporter/maskcheck');
const { buildPatterns } = require('../src/exporter/terrainView');

const patterns = buildPatterns(JSON.parse(fs.readFileSync(
	path.join(__dirname, '../src/exporter/terrainViewPatterns.json'), 'utf8')
	.replace(/^\s*\/\/.*$/gm, '')));
const ROCK = { id: 'core:rock', group: 'rock', transitionRequired: true, passable: false, isDirt: false, isSand: false };
const SUB = { id: 'core:subterra', group: 'normal', transitionRequired: false, passable: true, isDirt: false, isSand: false };
const checker = makeMaskChecker(patterns, ROCK, [SUB]);

/** Open cells reachable (8-way) from the first open cell. */
function reach(open, W, H) {
	const seen = new Uint8Array(W * H);
	const s = open.indexOf(1);
	if (s < 0) return seen;
	const q = [s];
	seen[s] = 1;
	for (let h = 0; h < q.length; h++) {
		const c = q[h], x = c % W, y = (c / W) | 0;
		for (let dy = -1; dy <= 1; dy++)
			for (let dx = -1; dx <= 1; dx++) {
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const d = ny * W + nx;
				if (open[d] && !seen[d]) { seen[d] = 1; q.push(d); }
			}
	}
	return seen;
}

// Two chambers (zones 0 and 1) joined by a winding one-cell tunnel, with a
// one-cell rock spur and a one-cell notch: the shapes the carve leaves.
function world() {
	const W = 40, H = 24;
	const open = new Uint8Array(W * H), zone = new Int16Array(W * H);
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) zone[y * W + x] = x < W / 2 ? 0 : 1;
	const dig = (x0, y0, x1, y1) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) open[y * W + x] = 1; };
	dig(3, 4, 13, 18);            // chamber in zone 0
	dig(26, 5, 36, 19);           // chamber in zone 1
	for (let x = 14; x <= 25; x++) open[11 * W + x] = 1;   // one-cell tunnel
	for (let y = 8; y <= 11; y++) open[y * W + 19] = 1;    // a bend off it
	open[4 * W + 8] = 0;          // rock pillar inside chamber 0
	open[12 * W + 13] = 0;        // rock spur into chamber 0 by the tunnel mouth
	open[19 * W + 30] = 1;        // one-cell notch below chamber 1
	return { W, H, open, zone };
}

test('safeToClose: a tunnel cell is not safe, a chamber corner is', () => {
	const { W, H, open } = world();
	assert.strictEqual(safeToClose(open, W, H, 11 * W + 16), false, 'mid-tunnel');
	assert.strictEqual(safeToClose(open, W, H, 4 * W + 3), true, 'chamber corner');
});

test('zoneSafeToOpen: rock between the zones is not safe', () => {
	const { W, H, open, zone } = world();
	// the rock beside the tunnel at the zone line touches open cells of both zones
	assert.strictEqual(zoneSafeToOpen(open, zone, W, H, 10 * W + 20), false);
	assert.strictEqual(zoneSafeToOpen(open, zone, W, H, 4 * W + 8), true, 'pillar inside one zone');
});

test('fitCave lowers the cells no sprite fits, joins no zones, cuts no path', () => {
	const { W, H, open, zone } = world();
	const before = open.slice();
	const reachBefore = reach(before, W, H);
	const fit = fitCave(open, zone, W, H, checker);
	assert.ok(fit.before > 0, 'the test world starts with bad cells');
	assert.ok(fit.after < fit.before, `${fit.before} -> ${fit.after}`);
	// nothing reachable before became unreachable
	const reachAfter = reach(open, W, H);
	for (let c = 0; c < W * H; c++)
		if (before[c] && reachBefore[c] && open[c]) assert.ok(reachAfter[c], `cell ${c} still reachable`);
	// every newly opened cell touches open ground of its own zone only
	for (let c = 0; c < W * H; c++)
		if (open[c] && !before[c]) {
			const x = c % W, y = (c / W) | 0;
			for (let dy = -1; dy <= 1; dy++)
				for (let dx = -1; dx <= 1; dx++) {
					const nx = x + dx, ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
					const n = ny * W + nx;
					if (before[n]) assert.strictEqual(zone[n], zone[c], `opened ${c} joins zones`);
				}
		}
});
