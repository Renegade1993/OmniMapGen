/**
 * guardhigh.test.js - a guard on every high-class pile a hero takes without a fight (K, 2026-10-04: loot out in the open underground
 * with no guard). The pass is plain generator behaviour, with no switch; this pins what it does.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { guardHigh } = require('../src/biome/guardhigh');
const content = require('../src/biome/content');

const W = 24, H = 24;
const deps = (rng) => ({
	OCCUPIED: content.OCCUPIED, RESERVED: content.RESERVED, APPROACH: content.APPROACH,
	blockingCells: content.blockingCells, visitableCells: content.visitableCells, allowedDirs: content.allowedDirs,
	footprintFits: content.footprintFits, footprintBlock: content.footprintBlock, markApproach: content.markApproach,
	objectEntry: (type, x, y, l, tpl, subtype, opts) => ({ type, x, y, l, template: tpl, subtype, options: opts }),
	monsterTpl: content.FILL_TYPES.creeps[0].tpl, monsterOptions: () => ({}), rng,
});
const pile = (type, x, y) => ({ type, x, y, l: 0, template: { mask: ['A'], visitableFrom: ['+++', '+-+', '+++'] } });
const level = (objects) => ({ plan: { objects, zone: new Int16Array(W * H), roadCells: new Set(), p: {} }, blocked: new Uint8Array(W * H) });
const monsters = m => m.plan.objects.filter(o => /^randomMonster/.test(o.type));

test('an open relic gets one guard on a tile beside it, of the relic tier', () => {
	const m = level([pile('randomArtifactRelic', 12, 12)]);
	m.blocked[12 * W + 12] |= content.OCCUPIED;
	const r = guardHigh(m.plan, W, H, 0, m.blocked, deps(() => 0.5));
	assert.deepStrictEqual([r.open, r.guarded, r.left], [1, 1, 0]);
	const g = monsters(m);
	assert.strictEqual(g.length, 1);
	assert.strictEqual(g[0].type, 'randomMonsterLevel6');
	assert.ok(Math.max(Math.abs(g[0].x - 12), Math.abs(g[0].y - 12)) === 1, 'on a tile beside the pile');
});

test('a pile with a monster within two tiles, and a low pile, get nothing', () => {
	const m = level([pile('randomArtifactMajor', 12, 12), { type: 'randomMonsterLevel3', x: 14, y: 12, l: 0, template: content.FILL_TYPES.creeps[0].tpl },
		pile('treasureChest', 5, 5)]);
	m.blocked[12 * W + 12] |= content.OCCUPIED;
	const r = guardHigh(m.plan, W, H, 0, m.blocked, deps(() => 0.5));
	assert.strictEqual(r.guarded, 0);
	assert.strictEqual(monsters(m).length, 1);
});

test('a pile walled in on every side is not open, so it gets no guard', () => {
	const m = level([pile('pandoraBox', 12, 12)]);
	for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) m.blocked[(12 + dy) * W + 12 + dx] |= content.OCCUPIED;
	const r = guardHigh(m.plan, W, H, 0, m.blocked, deps(() => 0.5));
	assert.deepStrictEqual([r.open, r.guarded], [0, 0]);
});
