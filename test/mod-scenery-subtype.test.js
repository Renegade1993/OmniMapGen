/**
 * mod-scenery-subtype.test.js - a mod's scenery goes out as its own object.
 *
 * A mod's obstacle is usually a subtype of its own (HotA's spruces::spruces).
 * Three call sites let it default to "object", and the engine refused every map
 * with such a piece: "Failed to resolve identifier spruces::object" (0.2.1, with
 * mod content on). A fixture mod here brings obstacles of subtype "tall" and
 * obstacle sets for every core terrain; a map generated with it declared must
 * write those pieces as fixturePalm::tall, declare the mod, and leave the
 * guard before writing nothing to correct.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { readVmap } = require('../src/preview/render');
const { genEnv, testTmp } = require('./_vcmi');

function fixtureUserDir() {
	const user = fs.mkdtempSync(path.join(testTmp(), 'vmapgen-modscenery-'));
	const mod = path.join(user, 'Mods', 'fixturepalms');
	fs.mkdirSync(path.join(mod, 'Content', 'config'), { recursive: true });
	fs.mkdirSync(path.join(user, 'config'), { recursive: true });
	fs.writeFileSync(path.join(mod, 'mod.json'), JSON.stringify({
		name: 'Fixture palms', version: '1.0', modType: 'Graphical',
		objects: ['config/objects'], biomes: ['config/biomes'] }));
	const core = ['grass', 'dirt', 'sand', 'snow', 'swamp', 'rough', 'lava', 'subterra'];
	const tpl = (name, mask) => ({ animation: `fixturepalms/${name}.def`, mask, allowedTerrains: core });
	fs.writeFileSync(path.join(mod, 'Content', 'config', 'objects.json'), JSON.stringify({
		fixturePalm: { handler: 'static', types: { tall: { templates: {
			fxPalm1: tpl('fxPalm1', ['B']),
			fxPalm2: tpl('fxPalm2', ['BB']),
			fxPalm4: tpl('fxPalm4', ['BB', 'BB']),
		} } } } }));
	// a set of every kind the engine draws, on every core terrain, so zones take them often
	const sets = {};
	for (const type of ['mountain', 'tree', 'rock', 'plant', 'lake'])
		sets[`palms_${type}`] = { biome: { terrain: core, objectType: type }, templates: ['fxPalm1', 'fxPalm2', 'fxPalm4'] };
	fs.writeFileSync(path.join(mod, 'Content', 'config', 'biomes.json'), JSON.stringify(sets));
	fs.writeFileSync(path.join(user, 'config', 'modSettings.json'), JSON.stringify({
		activePreset: 'test', presets: { test: { mods: ['fixturepalms'], settings: {} } } }));
	return user;
}

test('a mod\'s obstacles keep their own subtype, and the map declares the mod', () => {
	const user = fixtureUserDir();
	const out = path.join(testTmp(), 'vmapgen_modscenery.vmap');
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'),
		'--w', '36', '--h', '36', '--players', '2', '--seed', '77', '--declaremods', '1',
		'--vcmiuserdir', user, '--nocache', '1', '--out', out],
	{ cwd: path.join(__dirname, '..'), env: genEnv(), encoding: 'utf8', timeout: 240000, windowsHide: true });
	assert.strictEqual(r.status, 0, r.stderr);
	assert.ok(!/WARNING: \d+ scenery piece/.test(r.stderr), 'the guard corrected nothing: every call site kept the subtype');
	const m = readVmap(out);
	const palms = m.objects.filter(o => o.type === 'fixturePalm');
	assert.ok(palms.length > 0, 'the mod\'s sets were drawn');
	assert.deepStrictEqual([...new Set(palms.map(o => o.subtype))], ['tall'], 'written as fixturePalm::tall');
	assert.ok(Object.values(m.header.mods || {}).some(d => d.modId === 'fixturepalms'), 'the mod is declared');
});
