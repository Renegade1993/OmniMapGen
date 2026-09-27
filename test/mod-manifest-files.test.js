/**
 * mod-manifest-files.test.js - a mod contributes exactly the config files its
 * mod.json lists, as the engine loads them (ContentTypeHandler.cpp:251-273).
 *
 * The index used to read every JSON under a mod's config folder. Highlands
 * Town ships config/highlands/banks/dwarfHighBank.json without listing it, so
 * the engine never loads it, but ftDwarfBank reached our maps and the engine
 * refused them: "Failed to find object of type creatureBank::ftDwarfBank"
 * (2026-09-25). This pins listed files in, loose and zipped, with and without
 * the ".json" the engine implies, and an unlisted file out.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildAssetIndex } = require('../src/parser/assetIndex');
const { writeZip } = require('../src/exporter/zipWriter');
const { testTmp } = require('./_vcmi');

const bankGroup = name => JSON.stringify({ creatureBank: { handler: 'bank', types: {
	[name]: { templates: { normal: { animation: `${name}.def`, mask: ['VVV', 'VBA'],
		visitableFrom: ['---', '+-+', '+++'] } } } } } });

test('only the config files a mod.json lists are indexed, loose or zipped', () => {
	const dir = fs.mkdtempSync(path.join(testTmp(), 'vmapgen-manifest-'));
	fs.mkdirSync(path.join(dir, 'Content', 'config', 'banks'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'Content', 'config', 'listed.json'), bankGroup('listedBank'));
	fs.writeFileSync(path.join(dir, 'Content', 'config', 'banks', 'unlisted.json'), bankGroup('unlistedBank'));
	fs.writeFileSync(path.join(dir, 'content.zip'),
		writeZip([{ name: 'config/zipped.json', data: bankGroup('zippedBank') }]));
	const manifest = { name: 'Fixture', objects: ['config/listed.json', 'config/zipped'],
		__dir: dir, __id: 'fixture' };
	const idx = buildAssetIndex(null, [manifest]);
	const ids = [...idx.objects.keys()];
	assert.ok(ids.includes('fixture:creatureBank.listedBank'), 'listed loose file indexed');
	assert.ok(ids.includes('fixture:creatureBank.zippedBank'), 'listed zipped file, ".json" implied, indexed');
	assert.ok(!ids.some(k => k.endsWith('.unlistedBank')), 'a file the manifest does not list stays out');
});

test('a file listed under "creatures" is indexed as creatures, level only or not', () => {
	// Core's creature entries carry a level and no fightValue/aiValue (those
	// come from the game's CRTRAITS.TXT); the category is what makes them
	// creatures, as in the engine.
	const dir = fs.mkdtempSync(path.join(testTmp(), 'vmapgen-creatures-'));
	fs.mkdirSync(path.join(dir, 'Content', 'config'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'Content', 'config', 'creatures.json'), JSON.stringify({
		stoneThing: { level: 3, faction: 'neutral' },
		'core:pikeman': { level: 2 },
	}));
	fs.writeFileSync(path.join(dir, 'Content', 'config', 'spells.json'), JSON.stringify({
		someSpell: { level: 4, school: { fire: true } },
	}));
	const manifest = { name: 'Fixture', creatures: ['config/creatures'], spells: ['config/spells'],
		__dir: dir, __id: 'fixture' };
	const idx = buildAssetIndex(null, [manifest]);
	assert.strictEqual((idx.creatures.get('fixture:stoneThing') || {}).level, 3);
	assert.strictEqual((idx.creatures.get('core:pikeman') || {}).level, 2, 'a scoped key overrides as written');
	assert.ok(!idx.creatures.has('fixture:someSpell'), 'a spell with a level is not a creature');
});

test('a later mod patches the object an earlier one defined, as the engine merges it', () => {
	// JsonUtils::merge in load order: "rmg": null takes an object out of the
	// random map generator (HotA's rmgBan), a partial rmg changes only the
	// fields it names (HotA's rmgTweak: the Imp Cache at 1500), and a patch's
	// templates join the object's (New Pavilion's dunes art for the crypt).
	const base = fs.mkdtempSync(path.join(testTmp(), 'vmapgen-patchbase-'));
	const patch = fs.mkdtempSync(path.join(testTmp(), 'vmapgen-patch-'));
	const tpl = (anim, extra = {}) => ({ normal: { animation: anim, mask: ['VVV', 'VBA'],
		visitableFrom: ['---', '+-+', '+++'], ...extra } });
	fs.mkdirSync(path.join(base, 'Content', 'config'), { recursive: true });
	fs.writeFileSync(path.join(base, 'Content', 'config', 'banks.json'), JSON.stringify({ creatureBank: {
		handler: 'bank', types: {
			alpha: { rmg: { value: 3000, rarity: 100 }, templates: tpl('alpha.def') },
			beta: { rmg: { value: 5000, rarity: 100, zoneLimit: 2 }, templates: tpl('beta.def') },
			gamma: { rmg: { value: 2000, rarity: 50 }, templates: tpl('gamma.def') } } } }));
	fs.mkdirSync(path.join(patch, 'Content', 'config'), { recursive: true });
	fs.writeFileSync(path.join(patch, 'Content', 'config', 'patch.json'), JSON.stringify({ 'base:creatureBank': {
		types: {
			alpha: { rmg: null },
			beta: { rmg: { value: 1500 } },
			gamma: { templates: { snowy: { animation: 'patch/gammaSnow', mask: ['VVV', 'VBA'],
				visitableFrom: ['---', '+-+', '+++'], allowedTerrains: ['snow'] } } } } } }));
	const idx = buildAssetIndex(null, [
		{ name: 'Base', objects: ['config/banks'], __dir: base, __id: 'base' },
		{ name: 'Patch', objects: ['config/patch'], __dir: patch, __id: 'patch' }]);
	const get = s => idx.objects.get(`base:creatureBank.${s}`);
	assert.strictEqual(get('alpha').rmg, undefined, '"rmg": null removes it');
	assert.deepStrictEqual(get('beta').rmg, { value: 1500, rarity: 100, zoneLimit: 2 }, 'a partial rmg merges');
	assert.deepStrictEqual(get('gamma').rmg, { value: 2000, rarity: 50 });
	const snowy = get('gamma').templates.find(t => t.name === 'snowy');
	assert.ok(snowy, 'the patch template joins the object');
	assert.deepStrictEqual(snowy.allowedTerrains, ['snow']);
	assert.strictEqual(get('gamma').templates.find(t => t.name === 'normal').allowedTerrains, undefined,
		'no list means any land');
	// the patch keeps an entry of its own, marked, so no pool reads it as a new bank
	assert.strictEqual(idx.objects.get('patch:base:creatureBank.alpha').overrides, 'base:creatureBank.alpha');
	fs.rmSync(base, { recursive: true, force: true });
	fs.rmSync(patch, { recursive: true, force: true });
});

test('a faction is its records merged in load order, across files and mods', () => {
	// HotA's Cove sets nativeTerrain in faction.json and its town in town.json;
	// New Pavilion's dunes submod patches Pavilion's native terrain. The engine
	// merges them all before judging the faction; judging record by record kept
	// the first one with a town and lost the terrain.
	const base = fs.mkdtempSync(path.join(testTmp(), 'vmapgen-faction-'));
	const patch = fs.mkdtempSync(path.join(testTmp(), 'vmapgen-factionpatch-'));
	fs.mkdirSync(path.join(base, 'Content', 'config'), { recursive: true });
	fs.writeFileSync(path.join(base, 'Content', 'config', 'town.json'), JSON.stringify({
		cove: { town: { mapObject: { templates: { village: { animation: 'covevil.def' } } } } } }));
	fs.writeFileSync(path.join(base, 'Content', 'config', 'faction.json'), JSON.stringify({
		cove: { nativeTerrain: 'swamp', name: 'Cove' },
		// a record with no town anywhere is not a faction with a town
		lonely: { nativeTerrain: 'sand' } }));
	fs.mkdirSync(path.join(patch, 'Content', 'config'), { recursive: true });
	fs.writeFileSync(path.join(patch, 'Content', 'config', 'terrain.json'), JSON.stringify({
		'base:cove': { nativeTerrain: 'dunes' } }));
	const idx = buildAssetIndex(null, [
		{ name: 'Base', factions: ['config/town', 'config/faction'], __dir: base, __id: 'base' },
		{ name: 'Patch', factions: ['config/terrain'], __dir: patch, __id: 'patch' }]);
	const cove = idx.factions.get('base:cove');
	assert.ok(cove, 'split across two files, still one faction');
	assert.strictEqual(cove.nativeTerrain, 'dunes', 'the later mod\'s patch wins');
	assert.strictEqual(cove.name, 'Cove');
	assert.deepStrictEqual(cove.townMap, { village: 'covevil' });
	assert.ok(!idx.factions.has('base:lonely'), 'no town, no faction');
	fs.rmSync(base, { recursive: true, force: true });
	fs.rmSync(patch, { recursive: true, force: true });
});
