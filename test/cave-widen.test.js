/**
 * cave-widen.test.js - no cave passage one tile wide and no floor meeting floor at a corner only, after the carve (K, 2026-10-18: "single-with
 * underground branches, which i'm pretty sure are impassible and therefore erroneous", "two lava tiles with absolutely no border"; the terrain
 * table has no picture for a floor tile with rock on two opposite sides nor for floor touching floor at a corner only, so the game drew them
 * flat). splinecave.widenPassages opens rock beside such floor, and only where every floor tile round it is already one piece, so no new way
 * between two caves opens.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { widenPassages } = require('../src/biome/splinecave');

const W = 20, H = 12;
function grid(rows) {
	const open = new Uint8Array(W * H);
	rows.forEach((r, y) => { for (let x = 0; x < r.length; x++) if (r[x] === '.') open[y * W + x] = 1; });
	return open;
}
const zoneAll = new Int32Array(W * H);
const at = (x, y) => y * W + x;

// a floor tile with rock on both sides across, or two floor tiles touching at a corner only
function bad(open) {
	const out = [];
	for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
		const c = at(x, y);
		if (!open[c]) continue;
		if (!open[c - 1] && !open[c + 1]) out.push(`(${x},${y}) rock left and right`);
		if (!open[c - W] && !open[c + W]) out.push(`(${x},${y}) rock above and below`);
		for (const [dx, dy] of [[1, 1], [-1, 1]]) if (open[at(x + dx, y + dy)] && !open[at(x + dx, y)] && !open[at(x, y + dy)]) out.push(`(${x},${y}) corner step`);
	}
	return out;
}
function pieces(open) {
	const seen = new Uint8Array(W * H);
	let n = 0;
	for (let c0 = 0; c0 < W * H; c0++) {
		if (!open[c0] || seen[c0]) continue;
		n++;
		const q = [c0]; seen[c0] = 1;
		while (q.length) {
			const c = q.pop(), x = c % W, y = (c / W) | 0;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const m = at(nx, ny);
				if (open[m] && !seen[m]) { seen[m] = 1; q.push(m); }
			}
		}
	}
	return n;
}

test('a one-tile corridor and a diagonal staircase are widened until the table can draw them', () => {
	const open = grid([
		'####################',
		'#....##############.',
		'#....##############.',
		'#.................##',
		'#....###########.###',
		'#....############.##',
		'##################.#',
		'###################.',
		'####################',
		'####################',
		'####################',
		'####################',
	]);
	assert.ok(bad(open).length > 0, 'the premise: the corridor and the staircase are there');
	const before = pieces(open);
	const n = widenPassages(W, H, open, zoneAll, () => true, false);
	assert.ok(n > 0, 'some rock opened');
	assert.deepStrictEqual(bad(open), [], 'no floor left the table cannot draw');
	assert.strictEqual(pieces(open), before, 'no two caves joined');
});

test('two caves a one-tile wall apart stay apart', () => {
	const open = grid([
		'####################',
		'#....#....##########',
		'#....#....##########',
		'#....#....##########',
		'####################',
		'####################',
		'####################',
		'####################',
		'####################',
		'####################',
		'####################',
		'####################',
	]);
	assert.strictEqual(pieces(open), 2);
	widenPassages(W, H, open, zoneAll, () => true, false);
	assert.strictEqual(pieces(open), 2, 'the wall between them stays');
	for (let y = 1; y <= 3; y++) assert.ok(!open[at(5, y)], `the wall tile (5,${y}) stays rock`);
});

test('with zones (a template) a tile next to another zone\'s floor does not open', () => {
	const open = grid([
		'####################',
		'#....#....##########',
		'#....#....##########',
		'#....#....##########',
		'####################',
		'####################',
		'####################',
		'####################',
		'####################',
		'####################',
		'####################',
		'####################',
	]);
	const zone = new Int32Array(W * H);
	for (let y = 0; y < H; y++) for (let x = 6; x < W; x++) zone[at(x, y)] = 1;
	widenPassages(W, H, open, zone, () => true, true);
	for (let y = 1; y <= 3; y++) assert.ok(!open[at(5, y)], `the zone line (5,${y}) stays rock`);
});
