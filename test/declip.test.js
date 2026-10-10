/**
 * declip.test.js - no pickup under a monster's sprite (K, 2026-10-04: "multi-grid creatures improperly placed clipping onto
 * loot"). A creature's map sprite covers its own tile, the tile to its left, the tile above and the one up and to the left
 * (every core creature's is 64x64, bottom-right on its tile); a pickup there moves to a free tile ahead of the sprite.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { declipMonsters } = require('../src/biome/declip');
const { blockingCells, footprintCells } = require('../src/biome/content');

const W = 16, H = 16;
const chest = (x, y) => ({ type: 'treasureChest', l: 0, x, y, template: { mask: ['A'] } });
const horse = (x, y) => ({ type: 'randomMonsterLevel6', l: 0, x, y, template: { mask: ['A'] } });
const run = objects => {
	const blocked = new Uint8Array(W * H);
	for (const o of objects) blocked[o.y * W + o.x] |= 1;
	const plan = { objects, roadCells: new Set(), openMask: null, p: {}, zone: new Uint8Array(W * H) };
	return { r: declipMonsters(plan, W, H, 0, blocked, blockingCells, footprintCells), objects, blocked };
};

test('a chest on the monster\'s own tile moves ahead of its sprite', () => {
	const c = chest(8, 8), m = horse(8, 8);
	const { r } = run([c, m]);
	assert.strictEqual(r.moved, 1);
	assert.ok(c.x >= 8 && c.y >= 8 && !(c.x === 8 && c.y === 8), `chest at ${c.x},${c.y}`);
});

test('a chest to the monster\'s left, above or up and left moves; one to its right or below stays', () => {
	for (const [dx, dy] of [[-1, 0], [0, -1], [-1, -1]]) {
		const c = chest(8 + dx, 8 + dy), m = horse(8, 8);
		assert.strictEqual(run([c, m]).r.moved, 1, `${dx},${dy}`);
	}
	for (const [dx, dy] of [[1, 0], [0, 1], [1, 1]]) {
		const c = chest(8 + dx, 8 + dy), m = horse(8, 8);
		const { r } = run([c, m]);
		assert.strictEqual(r.moved, 0, `${dx},${dy}`);
		assert.deepStrictEqual([c.x, c.y], [8 + dx, 8 + dy]);
	}
});

test('a pickup that has nowhere clear to go stays where it is', () => {
	const c = chest(8, 8), m = horse(8, 8), objs = [c, m];
	for (let y = 6; y <= 11; y++) for (let x = 6; x <= 11; x++) if (x > 8 || y > 8) objs.push({ type: 'rock', l: 0, x, y, template: { mask: ['B'] } });
	const { r } = run(objs);
	assert.strictEqual(r.moved, 0);
	assert.strictEqual(r.left, 1);
});

test('the pickup does not land on a road or in another monster\'s sprite', () => {
	const c = chest(8, 8), m = horse(8, 8), other = horse(10, 10);
	const blocked = new Uint8Array(W * H);
	for (const o of [c, m, other]) blocked[o.y * W + o.x] |= 1;
	const plan = { objects: [c, m, other], roadCells: new Set([8 * W + 9, 9 * W + 8]), openMask: null, p: {}, zone: new Uint8Array(W * H) };
	declipMonsters(plan, W, H, 0, blocked, blockingCells, footprintCells);
	for (const [x, y] of footprintCells(c.template, c.x, c.y)) {
		assert.ok(!plan.roadCells.has(y * W + x));
		assert.ok(!(x >= 9 && x <= 10 && y >= 9 && y <= 10), 'not under the second monster');
	}
});
