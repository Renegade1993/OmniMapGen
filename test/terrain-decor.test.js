/**
 * terrain-decor.test.js - scenery for a terrain the harvest has none for
 * comes from the obstacles its mods bring (decor.js registerTerrainDecor,
 * filled by generate.js from the asset index). A registered mod terrain
 * draws its own clusters, single pieces and packs with their own subtypes;
 * a core terrain keeps its harvested pools; and clearTerrainDecor takes every
 * registration back, so one map's mods never reach the next map made in the
 * same process.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const decor = require('../src/biome/decor');

const rng = () => 0.5;
const mountain = { type: 'mountain', subtype: 'hlMountain1', animation: 'AVHLMNT1', cells: 6, weight: 1,
	mask: ['VVBBBB', 'VVBBBB'] };
const flowers = { type: 'flowers', subtype: 'hlFlowers', animation: 'AVHLFLW1', cells: 1, weight: 1 / 6,
	mask: ['B'] };
const pack = { size: 6, cells: [[2, 0], [3, 0], [4, 0], [5, 0], [2, 1], [3, 1]],
	objects: [{ type: 'mountain', subtype: 'hlMountain1', animation: 'AVHLMNT1', mask: mountain.mask, dx: 0, dy: 0 }] };

test('a mod terrain draws the scenery its mods bring, until cleared', () => {
	decor.clearTerrainDecor();
	assert.strictEqual(decor.clusterTemplate('hl', rng), null, 'nothing before registration');
	assert.strictEqual(decor.registerTerrainDecor('hl', { clusters: [mountain], single: [flowers], packs: [pack] }), true);

	const c = decor.clusterTemplate('hl', rng);
	assert.deepStrictEqual([c.type, c.subtype, c.tpl.animation], ['mountain', 'hlMountain1', 'AVHLMNT1'],
		'the mod piece, with its own subtype');
	const s = decor.singleTemplate('hl', rng);
	assert.deepStrictEqual([s.type, s.subtype], ['flowers', 'hlFlowers']);
	const p = decor.packFor('hl', rng, 6);
	assert.ok(p && p.objects[0].animation === 'AVHLMNT1', 'the pack pass has the mod pack');

	decor.clearTerrainDecor();
	assert.strictEqual(decor.clusterTemplate('hl', rng), null, 'cleared: no clusters');
	assert.strictEqual(decor.singleTemplate('hl', rng), null, 'cleared: no single pieces');
	assert.strictEqual(decor.packFor('hl', rng, 6), null, 'cleared: no packs');
});

test('a core terrain keeps its harvested pools', () => {
	decor.clearTerrainDecor();
	const before = decor.clusterTemplate('gr', rng);
	assert.ok(before, 'grass has harvested clusters');
	assert.strictEqual(decor.registerTerrainDecor('gr', { clusters: [mountain], single: [flowers] }), false);
	assert.deepStrictEqual(decor.clusterTemplate('gr', rng), before, 'the harvest still decides grass');
	decor.clearTerrainDecor();
	assert.deepStrictEqual(decor.clusterTemplate('gr', rng), before, 'and clearing leaves it alone');
});
