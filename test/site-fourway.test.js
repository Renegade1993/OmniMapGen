'use strict';
/**
 * site-fourway.test.js - plan.js cornersOnly: a gate's body is refused where it leaves two tiles beside it that met side to side meeting only on
 * a corner (pw_079_108p6ut on opus-fg1020: the gate at (88,73) between the rock and a town, two corner-only road steps by its door), and allowed
 * where the ground round it stays joined side to side or the walls part nothing. Made-up 12x12 levels. Opus Map Vision 2026-10-21.
 */
const test = require('node:test');
const assert = require('node:assert');
const { cornersOnly } = require('../src/biome/plan');
const { OCCUPIED } = require('../src/biome/content');

// rows of '#' (rock) and '.' (floor), 12 wide
const level = rows => {
	const W = rows[0].length, H = rows.length, b = new Uint8Array(W * H);
	rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch === '#') b[y * W + x] = OCCUPIED; }));
	return { W, H, b };
};

test('a body that leaves the way past it on a diagonal only is refused', () => {
	// a corridor two tiles wide; walling (5,5) and (6,4) leaves (5,4)-(6,5) the only step, a corner
	const { W, H, b } = level([
		'############',
		'############',
		'############',
		'############',
		'#####..#####',
		'#####..#####',
		'#####..#####',
		'############',
		'############',
		'############',
		'############',
		'############']);
	// walling (5,5) and (6,4): (5,4) meets the rest only at its corner with (6,5)
	assert.strictEqual(cornersOnly([5 * W + 5, 4 * W + 6], 0, W, H, b), true);
	// walling (5,5) and (6,5) parts the corridor altogether: the fill's connectivity guard decides that one
	assert.strictEqual(cornersOnly([5 * W + 5, 5 * W + 6], 0, W, H, b), false);
	// filling the corner (5,4) leaves (6,4) joined side to side below
	assert.strictEqual(cornersOnly([4 * W + 5], 0, W, H, b), false);
});

test('a body beside open ground, which keeps every tile beside it joined side to side, is allowed', () => {
	const { W, H, b } = level(Array.from({ length: 12 }, () => '............'));
	assert.strictEqual(cornersOnly([5 * W + 5, 5 * W + 6, 5 * W + 4, 6 * W + 5], 0, W, H, b), false);
});

test('VMAPGEN_SITE_FOURWAY=0 never refuses', () => {
	const { W, H, b } = level([
		'############', '############', '############', '############',
		'#####..#####', '#####..#####', '#####..#####',
		'############', '############', '############', '############', '############']);
	process.env.VMAPGEN_SITE_FOURWAY = '0';
	try { assert.strictEqual(cornersOnly([4 * W + 6, 6 * W + 5], 0, W, H, b), false); } finally { delete process.env.VMAPGEN_SITE_FOURWAY; }
});
