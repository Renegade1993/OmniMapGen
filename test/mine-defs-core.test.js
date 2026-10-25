/**
 * mine-defs-core.test.js - a mine's art is a def the game's own archives contain (K, 2026-10-19: roads that ran to nothing; the game log said
 * "Animation AVMsaws0 failed to load". AVMsaws0, the swamp sawmill, is a Horn of the Abyss def, absent from the Heroes III archives that Dead Man's
 * Boots runs on, so every sawmill on swamp was invisible and its road looked like one that led nowhere). The list is object 53's defs in the
 * original OBJECTS.TXT, every one of them present in H3sprite.lod. A swamp sawmill wears the grass def AVMsawg0, as OBJECTS.TXT lists it
 * (its terrain flags cover grass and swamp).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const DATA = require('../src/biome/economy.templates.json');

const CORE_MINE_DEFS = new Set(`AVXabnd0 AvMAbMG AVMalch0 AVMalcs0 AVMcrys0 AVMcrdr0 AVMcrds0 AVMcrgr0 AVMcrrf0 AVMcrsn0 AVMcrsu0 AVMcrsw0 AVMcrvo0
AVMgems0 AVMgedr0 AVMgelv0 AVMgerf0 AVMgesn0 AVMgodr0 AVMgogr0 AVMgold0 AVMgorf0 AVMgovo0 AVMgods0 AVMgosb0 AVMgosn0 AVMgosw0 AVMordr0 AVMords0
AVMore0 AVMorlv0 AVMorro0 AVMorsb0 AVMorsn0 AVMorsw0 AVMsawd0 AVMsawg0 AVMsawl0 AVMsawr0 AVMswds0 AVMswsn0 AVMsulf0`.split(/\s+/).map(s => s.toLowerCase()));

test('every mine def the generator can pick exists in the Heroes III archives', () => {
	const used = [];
	for (const [mine, byTerrain] of Object.entries(DATA.mineTerrainAnim)) for (const [t, def] of Object.entries(byTerrain)) used.push([`${mine}/${t}`, def]);
	for (const [mine, def] of Object.entries(DATA.mineDefaultAnim)) used.push([`${mine}/default`, def]);
	assert.ok(used.length > 40);
	const missing = used.filter(([, def]) => !CORE_MINE_DEFS.has(def.toLowerCase()));
	assert.deepStrictEqual(missing, [], 'a def not in the core archives loads in no game that lacks the add-on');
});

test('a sawmill on swamp wears the grass sawmill def', () => {
	assert.strictEqual(DATA.mineTerrainAnim.sawmill.sw, 'AVMsawg0');
});
