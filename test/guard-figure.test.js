/**
 * guard-figure.test.js - a guard's creature is one whose FIGURE stands on land (K, 2026-11-02, item 25 "SEVERE FAILURE": a Diamond Golem drawn in
 * the water beside a monolith on snow, seed 1320854187, the golem blocking (59,72) on land). A HotA-styled creature's picture is drawn with its
 * bottom right on the anchor tile, and a narrow sprite puts its feet one tile east or west of the tile it blocks. concretizeGuards, rollPlaceholders
 * and applyGuardTheme take a figure test { legal(x, y, l, self), offsetOf(look) } and write only creatures whose figure tile is legal: another
 * creature of the same level, faction where one is, at the same strength, counted. VMAPGEN_GUARD_FIGURE=0 writes the creature picked.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { concretizeGuards, rollPlaceholders, applyGuardTheme, figureTest } = require('../src/biome/guardCreatures');
const { OBJECT_TEMPLATES } = require('../src/stitch/zones');

const reg = () => new Map([
	// feet one tile east of the blocked tile
	['wide', { id: 'wide', name: 'wide', scope: 'mod', level: 6, aiValue: 2000, advMin: 4, advMax: 7, faction: 'a', map: 'wide.def', mapMask: ['VVV', 'VAV'] }],
	// feet on the blocked tile
	['near', { id: 'near', name: 'near', scope: 'mod', level: 6, aiValue: 1000, advMin: 4, advMax: 7, faction: 'a', map: 'near.def', mapMask: ['VVV', 'VAV'] }],
	['other', { id: 'other', name: 'other', scope: 'mod', level: 6, aiValue: 1500, advMin: 4, advMax: 7, faction: 'b', map: 'other.def', mapMask: ['VV', 'VA'] }],
]);
const OFFSETS = { 'wide.def': { dx: 1, dy: 0 }, 'near.def': { dx: 0, dy: 0 }, 'other.def': { dx: 0, dy: 0 } };
const offsetOf = look => OFFSETS[look.tpl.animation + '.def'] || OFFSETS[look.tpl.animation] || null;
const guard = () => ({ type: 'randomMonsterLevel6', subtype: 'object', x: 59, y: 72, l: 0, template: OBJECT_TEMPLATES.randomMonster, options: { character: 'hostile', amount: 10 } });
// the sea starts at x 60, as on K's snow map
const water = (x, y) => x < 60;
const figure = (legal = (x, y) => water(x, y)) => ({ legal, offsetOf });

test('a creature whose figure would stand in the water is written as another of its level and faction, at the same strength', () => {
	const g = guard();
	const r = concretizeGuards([g], new Map([[g, 'wide']]), { registry: reg(), h3: null, useMods: true, W: 180, H: 180, figure: figure(x => x < 60) });
	assert.strictEqual(r.figSwapped, 1);
	assert.strictEqual(g.subtype, 'near', 'the faction-a creature whose feet stand on the blocked tile');
	assert.strictEqual(g.x, 60, 'a three-wide look keeps the HotA anchor, one right of the blocked tile');
	assert.strictEqual(g.options.amount * 1000, 10 * 2000, 'the same strength');
});

test('a creature whose figure stands on free land stays', () => {
	const g = guard();
	const r = concretizeGuards([g], new Map([[g, 'wide']]), { registry: reg(), h3: null, useMods: true, W: 180, H: 180, figure: figure(() => true) });
	assert.strictEqual(r.figSwapped, 0);
	assert.strictEqual(g.subtype, 'wide');
});

test('another object\'s blocked tile under the figure refuses the creature', () => {
	const other = { type: 'tree', subtype: 'object', x: 60, y: 72, l: 0, template: { mask: ['B'] } };
	const held = [other];
	const legal = (x, y, l, self) => !held.some(q => q.x === x && q.y === y) || self === null;
	const g = guard();
	const r = concretizeGuards([g, other], new Map([[g, 'wide']]), { registry: reg(), h3: null, useMods: true, W: 180, H: 180, figure: { legal, offsetOf } });
	assert.strictEqual(r.figSwapped, 1);
	assert.strictEqual(g.subtype, 'near');
});

test('with no creature of its level whose figure stands on free land, the one picked stays and is counted', () => {
	const g = guard();
	const r = concretizeGuards([g], new Map([[g, 'wide']]), { registry: reg(), h3: null, useMods: true, W: 180, H: 180,
		figure: figure(() => false), poolAt: () => [{ id: 'wide' }] });
	assert.strictEqual(r.figSwapped, 0);
	assert.strictEqual(r.figLeft, 1);
	assert.strictEqual(g.subtype, 'wide');
});

test('the swap draws only from the creatures the guard\'s zone allows', () => {
	const g = guard();
	const r = concretizeGuards([g], new Map([[g, 'wide']]), { registry: reg(), h3: null, useMods: true, W: 180, H: 180,
		figure: figure(x => x < 60), poolAt: () => [{ id: 'wide' }, { id: 'other' }] });
	assert.strictEqual(r.figSwapped, 1);
	assert.strictEqual(g.subtype, 'other');
});

test('VMAPGEN_GUARD_FIGURE=0 writes the creature picked', () => {
	process.env.VMAPGEN_GUARD_FIGURE = '0';
	try {
		const g = guard();
		concretizeGuards([g], new Map([[g, 'wide']]), { registry: reg(), h3: null, useMods: true, W: 180, H: 180, figure: figure(() => false) });
		assert.strictEqual(g.subtype, 'wide');
	} finally { delete process.env.VMAPGEN_GUARD_FIGURE; }
});

test('a placeholder the game would roll never lands on a creature whose figure stands in the water', () => {
	let n = 0;
	const rng = () => ((n = (n * 7 + 3) % 97) / 97);
	for (let i = 0; i < 60; i++) {
		const g = guard();
		const r = rollPlaceholders([g], new Map(), { registry: reg(), h3: null, useMods: true, W: 180, H: 180, rng, figure: figure(x => x < 60) });
		assert.notStrictEqual(g.subtype, 'wide');
		assert.strictEqual(r.figRestricted, 1);
	}
});

test('a themed guard never lands on a creature whose figure stands in the water', () => {
	let n = 0;
	const rng = () => ((n = (n * 7 + 3) % 97) / 97);
	const look = (c, m) => ({ name: c.name, level: c.level, aiValue: c.aiValue, advMax: c.advMax, tpl: { animation: c.map.replace('.def', ''), mask: m, visitableFrom: ['+++', '+-+', '+++'] }, shift: m.length && m[0].length === 3 ? { dx: 1, dy: 0 } : { dx: 0, dy: 0 }, mods: [] });
	const r0 = reg();
	const pool = [look(r0.get('wide'), ['VVV', 'VAV']), look(r0.get('near'), ['VVV', 'VAV'])];
	for (let i = 0; i < 40; i++) {
		const g = guard();
		applyGuardTheme([g], { pool, share: 1, rng, W: 180, H: 180, figure: figure(x => x < 60) });
		assert.strictEqual(g.subtype, 'near');
	}
});

test('figureTest: a sprite the archives do not hold is not judged', () => {
	const ft = figureTest({ legal: () => false, roots: ['no-such-folder'] });
	assert.strictEqual(ft.ok({ x: 1, y: 1, l: 0 }, { tpl: { animation: 'NoSuchCreatureDef' }, shift: { dx: 1, dy: 0 } }), true);
	assert.strictEqual(ft.unread, 1);
});

test('a creature whose figure was read is written before one whose sprite no archive holds', () => {
	const r0 = reg();
	r0.set('mystery', { id: 'mystery', name: 'mystery', scope: 'mod', level: 6, aiValue: 2000, advMin: 4, advMax: 7, faction: 'a', map: 'mystery.def', mapMask: ['VVV', 'VAV'] });
	// 'mystery' is nearest in value (2000 against near's 1000) and of the same faction, but nothing says where its feet stand
	const g = guard();
	const r = concretizeGuards([g], new Map([[g, 'wide']]), { registry: r0, h3: null, useMods: true, W: 180, H: 180,
		figure: { legal: x => x < 60, offsetOf: look => (look.tpl.animation.includes('mystery') ? null : offsetOf(look)) } });
	assert.strictEqual(r.figSwapped, 1);
	assert.strictEqual(g.subtype, 'near');
});
