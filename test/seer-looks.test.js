/**
 * seer-looks.test.js - piles.js seerLooks: every look a seer hut can take, for the engine's per-hut choice (TreasurePlacer::addSeerHuts,
 * chooseRandomAppearance in lib/rmg/Functions.cpp). On 0.3.31 every seer hut took subtype 0: Coldshadow 144, 135 of 135 on 16 maps, where
 * the engine's 40 on 7 maps took seven looks (Opus Map Vision, 2026-11-10; K 2026-10-31: "a full scan for any buildings not placed on my map
 * that should have been"). No map is generated here.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { seerLooks } = require('../src/rmg/piles');

const tpl = (animation, allowedTerrains = null) => ({ raw: { animation, mask: ['VVV', 'VAV'], visitableFrom: ['---', '+-+', '+++'] }, allowedTerrains });
const objects = new Map([
	['core:seerHut.0', { type: 'seerHut', subtype: '0', classIndex: 83, subIndex: 0, templates: [] }],
	['core:seerHut.1', { type: 'seerHut', subtype: '1', classIndex: 83, subIndex: 1, templates: [] }],
	['hota.mapdecorations:core:seerHut.seerHutHota2', { type: 'seerHut', subtype: 'seerHutHota2', templates: [tpl('hota/seerHut/AVXseee0')] }],
	['hota.mapdecorations:core:seerHut.seerHutHota3', { type: 'seerHut', subtype: 'seerHutHota3', templates: [tpl('hota/seerHut/wt_seerh', ['water'])] }],
	['hota.bulwark:core:seerHut.seersHutIgloo', { type: 'seerHut', subtype: 'seersHutIgloo', templates: [tpl('hota/bulwark/AVXseekA0', ['snow'])] }],
	['newtown-terrains.deadlandterrain:core:seerHut.0', { type: 'seerHut', subtype: '0', overrides: 'core:seerHut.0', templates: [tpl('deadland/FALF0197', ['deadland'])] }],
	['core:creatureBank.cyclopsStockpile', { type: 'creatureBank', subtype: 'cyclopsStockpile', templates: [] }],
]);

test('seerLooks: core and mod looks, no sea-only look, no patch, nothing but seer huts', () => {
	const looks = seerLooks(objects, true, null);
	assert.deepStrictEqual(looks.map(l => l.subtype).sort(), ['0', '1', 'seerHutHota2', 'seersHutIgloo']);
	const igloo = looks.find(l => l.subtype === 'seersHutIgloo');
	assert.strictEqual(igloo.core, false);
	assert.deepStrictEqual(igloo.tpls[0].allowedTerrains, ['snow']);
	assert.strictEqual(looks.find(l => l.subtype === '0').core, true);
});

test('seerLooks: without mods only the core looks', () => {
	assert.deepStrictEqual(seerLooks(objects, false, null).map(l => l.subtype).sort(), ['0', '1']);
});
