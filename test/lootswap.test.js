/**
 * lootswap.test.js - a trade of guards between two piles happens only when
 * both guards' levels are known (findings-oe.md, lootswap.js tierOf).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { swapLoot } = require('../src/biome/lootswap');
const { blockingCells, visitableCells, OCCUPIED } = require('../src/biome/content');

const tpl = () => ({ mask: ['A'], visitableFrom: ['+++', '+-+', '+++'] });

test('swapLoot: a fixed creature is not traded for a level-1 stack', () => {
	const W = 14, H = 14, blocked = new Uint8Array(W * H);
	// a pocket at the top left, its way out under the fixed stack's ring
	for (let y = 0; y <= 3; y++) if (y !== 1) blocked[y * W + 3] |= OCCUPIED;
	for (let x = 0; x <= 3; x++) blocked[3 * W + x] |= OCCUPIED;
	const lo = { type: 'resource', x: 1, y: 1, l: 0, template: tpl() };
	const gl = { type: 'monster', subtype: 'blackDragon', x: 3, y: 1, l: 0, template: tpl() };
	const hi = { type: 'randomArtifactRelic', x: 9, y: 9, l: 0, template: tpl() };
	const gh = { type: 'randomMonsterLevel1', x: 10, y: 10, l: 0, template: tpl() };
	const plan = { zone: new Int32Array(W * H), objects: [lo, gl, hi, gh] };
	const r = swapLoot(plan, W, H, 0, blocked, OCCUPIED, new Set(['resource']), blockingCells, visitableCells);
	assert.strictEqual(r.swapped, 1);
	assert.deepStrictEqual([hi.x, hi.y], [1, 1]);
	assert.strictEqual(gl.type, 'monster');
	assert.strictEqual(gh.type, 'randomMonsterLevel1');
});
