/**
 * obstacle-sets.test.js - the mods' obstacle sets ("biomes"), which the engine's
 * prepareBiome draws a zone's scenery from alongside core's (retile.js).
 *
 * The index reads a mod's "biomes" files as the engine does (a set's type,
 * terrains, level, factions, alignments and template names) and records which
 * mod brought each template, also one it adds to an object another defined:
 * that is the mod a map using the art must declare. The retile pass then draws
 * from core's sets and the registered mod sets together, keeps a mod piece's
 * own subtype, and forgets the mod sets when they are cleared.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { buildAssetIndex } = require('../src/parser/assetIndex');
const { zoneTemplates, registerModSet, clearModSets, coreSetTemplates, retileLevel } = require('../src/biome/retile');
const { testTmp } = require('./_vcmi');

test('a mod\'s biomes are indexed as sets, and its templates carry their mod', () => {
	const dir = fs.mkdtempSync(path.join(testTmp(), 'vmapgen-biomes-'));
	fs.mkdirSync(path.join(dir, 'Content', 'config'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'Content', 'config', 'objects.json'), JSON.stringify({
		palms: { handler: 'static', types: { tall: { templates: {
			avPalm01: { animation: 'fixture/palms/avPalm01.def', mask: ['VV', 'BB'], allowedTerrains: ['sand'] } } } } },
		// joining core's cactus: the template is still this mod's
		cactus: { types: { object: { templates: {
			avCact77: { animation: 'fixture/cactus/avCact77.def', mask: ['B'] } } } } },
	}));
	fs.writeFileSync(path.join(dir, 'Content', 'config', 'biomes.json'), JSON.stringify({
		sandPalms: { biome: { terrain: 'sand', objectType: 'tree' }, templates: ['avPalm01'] },
		evilCactus: { biome: { terrain: ['sand', 'core:dirt'], objectType: 'plant', level: 'surface',
			faction: 'inferno', alignment: 'evil' }, templates: ['avCact77', 'AVLca1s0'] },
		notASet: { templates: ['avPalm01'] },
	}));
	// the mod whose cactus the fixture adds to (core's, in a real install)
	const baseDir = fs.mkdtempSync(path.join(testTmp(), 'vmapgen-biomes-base-'));
	fs.mkdirSync(path.join(baseDir, 'Content', 'config'), { recursive: true });
	fs.writeFileSync(path.join(baseDir, 'Content', 'config', 'objects.json'), JSON.stringify({
		cactus: { handler: 'static', types: { object: { templates: {
			avCact01: { animation: 'avCact01.def', mask: ['B'] } } } } } }));
	const base = { name: 'Base', objects: ['config/objects'], __dir: baseDir, __id: 'base' };
	const manifest = { name: 'Fixture', objects: ['config/objects'], biomes: ['config/biomes'],
		__dir: dir, __id: 'fixture' };
	const idx = buildAssetIndex(null, [base, manifest]);
	assert.deepStrictEqual(idx.obstacleSets.map(s => s.name), ['sandPalms', 'evilCactus'], 'a set needs a biome');
	const evil = idx.obstacleSets[1];
	assert.deepStrictEqual([evil.scope, evil.type, evil.terrains, evil.level, evil.factions, evil.alignments, evil.templates],
		['fixture', 'plant', ['sand', 'dirt'], 'surface', ['inferno'], ['evil'], ['avCact77', 'AVLca1s0']]);
	const palm = idx.objects.get('fixture:palms.tall').templates[0];
	assert.deepStrictEqual([palm.name, palm.scope], ['avPalm01', 'fixture']);
	const owner = idx.objects.get('base:cactus.object');
	assert.deepStrictEqual(owner.templates.map(t => [t.name, t.scope]), [['avCact01', 'base'], ['avCact77', 'fixture']],
		'a template added to another mod\'s object keeps its own mod');
});

test('a zone draws from core\'s sets and the registered mod sets together, until they are cleared', () => {
	clearModSets();
	const palm = { type: 'palms', subtype: 'tall', animation: 'fixture/palms/avPalm01', mask: ['VV', 'BB'] };
	// sand has one core tree set; with a second set of trees, the draws take both
	let rng = (() => { let s = 7; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
	const drawn = () => { const seen = new Set(); for (let i = 0; i < 400; i++) for (const t of zoneTemplates('sa', rng)) seen.add(t.animation); return seen; };
	assert.ok(!drawn().has(palm.animation), 'no mod art before a mod set is registered');
	registerModSet('sa', 'tree', { name: 'fixture:sandPalms', factions: [], templates: [palm] });
	assert.ok(drawn().has(palm.animation), 'a registered mod set is drawn like core\'s');
	assert.ok([...drawn()].some(a => !a.includes('/')), 'core\'s sets are still drawn');
	clearModSets();
	assert.ok(!drawn().has(palm.animation), 'cleared: gone');
	assert.ok(coreSetTemplates().size > 100, 'H3\'s own templates, by def name, for a mod set to name');
});

test('a mod piece the retile pass places keeps its own subtype', () => {
	clearModSets();
	const block = { type: 'palms', subtype: 'tall', animation: 'fixture/palms/avPalm01', mask: ['B'] };
	// a terrain no core set covers: only the mod's set can fill it
	for (const type of ['mountain', 'tree', 'rock']) registerModSet('zz', type, { name: `fixture:${type}`, factions: [], templates: [block] });
	const W = 6, H = 6;
	const tile = { type: 'rock', animation: 'AVLrk1d0', mask: ['B'] };
	const objects = [{ type: 'rock', subtype: 'object', x: 2, y: 2, l: 0, template: tile }];
	const res = retileLevel({ objects, zone: new Int32Array(W * H), biomeTerrain: ['zz'], W, H, l: 0,
		rng: () => 0.3, isScenery: () => true,
		blockingCells: (tpl, x, y) => (tpl.mask[0] === 'B' ? [[x, y]] : []),
		entry: (type, x, y, l, tpl, subtype) => ({ type, subtype, x, y, l, template: tpl }) });
	clearModSets();
	assert.strictEqual(res.objects.length, 1);
	assert.deepStrictEqual([res.objects[0].type, res.objects[0].subtype, res.objects[0].template.animation],
		['palms', 'tall', 'fixture/palms/avPalm01']);
});
