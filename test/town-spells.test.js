/**
 * town-spells.test.js - every town lists the spells its mage guild may offer.
 *
 * The engine fills a town's mage guild from the possibleSpells its map entry
 * lists and from nowhere else (CGTownInstance::serializeJsonOptions,
 * CGameState.cpp:901-942). Ours listed none, so every town on every map we
 * generated opened with an empty mage guild (found 2026-09-26). The engine's
 * own generator lists every spell allowed by default: not special, not a
 * creature ability (TownPlacer.cpp:112, CSpellHandler::getDefaultAllowed).
 * Core's H3 spells name no type in their config; the engine reads it from
 * SPTRAITS.TXT, where 70 and up are creature abilities.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { buildAssetIndex } = require('../src/parser/assetIndex');
const { TEST_ROOT, genEnv, testTmp } = require('./_vcmi');

const allowed = idx => [...idx.spells].filter(([, s]) => !s.special && s.type !== 'ability').map(([k]) => k);

test('core allows the 69 spells every corpus town lists, and no creature ability', () => {
	const ok = allowed(buildAssetIndex(path.join(TEST_ROOT, 'config'), []));
	assert.strictEqual(ok.length, 69);
	assert.ok(ok.includes('core:magicArrow') && ok.includes('core:summonBoat') && ok.includes('core:armageddon'));
	for (const ability of ['core:stoneGaze', 'core:poison', 'core:deathStare', 'core:acidBreath'])
		assert.ok(!ok.includes(ability), `${ability} is a creature ability`);
});

test('a generated map\'s towns all list the default spells', { timeout: 240000 }, () => {
	const { spawnSync } = require('child_process');
	const out = path.join(testTmp(), 'vmapgen_town_spells.vmap');
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'),
		'--w', '36', '--h', '36', '--players', '2', '--seed', '7', '--out', out, '--declaremods', '0'],
	{ encoding: 'utf8', timeout: 200000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	const { readVmap } = require('../src/preview/render');
	const map = readVmap(out);
	const towns = map.objects.filter(o => o.type === 'town' || o.type === 'randomTown');
	assert.ok(towns.length >= 2, `${towns.length} towns`);
	for (const t of towns) {
		const ps = (t.options || {}).possibleSpells || [];
		assert.strictEqual(ps.length, 69, `${t.instanceName} lists ${ps.length} spells`);
		assert.ok(ps.includes('core:townPortal'));
	}
	// A map with no water bans what the engine's generator bans from one
	// (CMap::banWaterContent), the way every land map in the corpus does:
	// the boat spells stay out of the guild, Navigation out of level-ups.
	const none = k => ((map.header[k] || {}).noneOf || []);
	for (const s of ['core:summonBoat', 'core:scuttleBoat', 'core:waterWalk'])
		assert.ok(none('allowedSpells').includes(s), `${s} is not banned on a land map`);
	assert.ok(none('allowedAbilities').includes('core:navigation'));
	assert.ok(none('allowedArtifacts').includes('core:seaCaptainsHat'));
	assert.ok(!none('allowedSpells').includes('core:townPortal'));
	fs.rmSync(out, { force: true });
});

test('a map with water bans none of the water content', { timeout: 240000 }, () => {
	const { spawnSync } = require('child_process');
	const out = path.join(testTmp(), 'vmapgen_town_spells_sea.vmap');
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'),
		'--w', '36', '--h', '36', '--players', '2', '--seed', '7', '--out', out, '--declaremods', '0',
		'--bio.waterCoverage', '0.3'],
	{ encoding: 'utf8', timeout: 200000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	assert.match(r.stderr, /allow-lists: a water map/);
	const { header } = require('../src/preview/render').readVmap(out);
	for (const k of ['allowedSpells', 'allowedArtifacts', 'allowedAbilities', 'allowedHeroes'])
		assert.strictEqual(header[k], undefined, `${k} names changes on a water map`);
	fs.rmSync(out, { force: true });
});

test('a template\'s banned and enabled spells reach the map, enabled winning', { timeout: 240000 }, () => {
	const { spawnSync } = require('child_process');
	const tplFile = path.join(testTmp(), 'ban_test_template.json');
	const start = owner => ({ type: 'playerStart', size: 10, owner, monsters: 'normal', playerTowns: { castles: 1 },
		mines: { wood: 1, ore: 1 }, treasure: [{ min: 500, max: 3000, density: 10 }] });
	fs.writeFileSync(tplFile, JSON.stringify({ 'Ban Test': { minSize: 's', maxSize: 'm', players: '2',
		bannedSpells: ['core:townPortal'], enabledSpells: ['core:summonBoat'],
		zones: { 1: start(1), 2: start(2) }, connections: [{ a: '1', b: '2', guard: 3000 }] } }));
	const out = path.join(testTmp(), 'vmapgen_town_spells_tpl.vmap');
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'),
		'--w', '36', '--h', '36', '--players', '2', '--seed', '3', '--out', out, '--declaremods', '0',
		'--template', tplFile],
	{ encoding: 'utf8', timeout: 200000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	const spells = require('../src/preview/render').readVmap(out).header.allowedSpells;
	assert.ok(spells.noneOf.includes('core:townPortal') && spells.noneOf.includes('core:waterWalk'));
	assert.ok(!spells.noneOf.includes('core:summonBoat'), 'the template enables Summon Boat, so it is not banned');
	assert.deepStrictEqual(spells.allOf, ['core:summonBoat']);
	fs.rmSync(out, { force: true });
	fs.rmSync(tplFile, { force: true });
});

test('the index knows the water-only spells, skill and artifacts', () => {
	const idx = buildAssetIndex(path.join(TEST_ROOT, 'config'), []);
	const water = kind => [...idx[kind]].filter(([, v]) => v.waterOnly).map(([k]) => k).sort();
	assert.deepStrictEqual(water('spells'), ['core:scuttleBoat', 'core:summonBoat', 'core:waterWalk']);
	assert.deepStrictEqual(water('skills'), ['core:navigation']);
	assert.deepStrictEqual(water('artifacts'), ['core:admiralsHat', 'core:bootsOfLevitation',
		'core:necklaceOfOceanGuidance', 'core:seaCaptainsHat']);
});
