/**
 * zone-towns.test.js - a template zone's towns, the engine's way
 * (src/biome/zoneTowns.js, TownPlacer.cpp, CRmgTemplate.cpp).
 *
 * We ignored allowedTowns and bannedTowns: neutral towns were random-town
 * placeholders (Golems Aplenty's centre could be any faction instead of
 * Tower), and player starts rolled from every faction where the engine rolls
 * from the zone's list and keeps Dungeon, Inferno and Necropolis
 * (preferUndergroundPlacement) off surface starts (2026-09-26).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { zoneTownTypes, pickStartFaction, townTemplate, townMods, TOWN_MASK } = require('../src/biome/zoneTowns');
const { resolveZones } = require('../src/rmg/template');
const { blockingCells, visitableCells } = require('../src/biome/content');
const { OBJECT_TEMPLATES } = require('../src/stitch/zones');
const { genEnv, testTmp } = require('./_vcmi');

const F = (bare, extra = {}) => ({ id: `core:${bare}`, bare, scope: 'core', preferUnderground: false,
	townMap: { village: `V_${bare}`, fort: `F_${bare}` }, townMapCore: { village: `V_${bare}`, fort: `F_${bare}` },
	townMapScope: 'core', ...extra });
const ALL = [F('castle'), F('tower'), F('dungeon', { preferUnderground: true }), F('inferno', { preferUnderground: true })];

test('a zone allows its allowedTowns minus its bannedTowns, and every faction when it lists none', () => {
	const names = spec => zoneTownTypes(spec, ALL).map(f => f.bare).join(',');
	assert.strictEqual(names({}), 'castle,tower,dungeon,inferno');
	assert.strictEqual(names({ allowedTowns: ['tower'] }), 'tower');
	assert.strictEqual(names({ allowedTowns: ['core:Tower', 'dungeon'], bannedTowns: ['dungeon'] }), 'tower');
	assert.strictEqual(names({ bannedTowns: ['castle'] }), 'tower,dungeon,inferno');
});

test('a random start prefers the factions whose preferUndergroundPlacement matches its level', () => {
	for (let r = 0; r < 1; r += 0.1) {
		assert.ok(!pickStartFaction(ALL, false, r).preferUnderground, 'surface start');
		assert.ok(pickStartFaction(ALL, true, r).preferUnderground, 'underground start');
	}
	// none matching: any of the zone's factions
	assert.strictEqual(pickStartFaction([F('dungeon', { preferUnderground: true })], false, 0.5).bare, 'dungeon');
	assert.strictEqual(pickStartFaction([], false, 0.5), null);
});

test('a concrete town blocks and opens what the placeholder does, with its faction\'s sprite', () => {
	const t = townTemplate(F('tower'), false, false);
	assert.strictEqual(t.animation, 'V_tower');
	assert.strictEqual(townTemplate(F('tower'), true, false).animation, 'F_tower');
	assert.deepStrictEqual(t.mask, TOWN_MASK);
	const key = cells => cells.map(([x, y]) => `${x},${y}`).sort().join(' ');
	assert.strictEqual(key(blockingCells(t, 10, 10)), key(blockingCells(OBJECT_TEMPLATES.randomTown, 10, 10)));
	assert.strictEqual(key(visitableCells(t, 10, 10)), key(visitableCells(OBJECT_TEMPLATES.randomTown, 10, 10)));
	// a restyled core town on a map with mods: the restyle's sprite and its mod
	const restyled = F('castle', { townMap: { village: 'hota/castle/village' }, townMapScope: 'hota.newgraphics' });
	assert.strictEqual(townTemplate(restyled, false, true).animation, 'hota/castle/village');
	assert.strictEqual(townTemplate(restyled, false, false).animation, 'V_castle', 'no mods: core\'s sprite');
	assert.deepStrictEqual(townMods(restyled, true), ['hota.newgraphics']);
	assert.deepStrictEqual(townMods(restyled, false), []);
	assert.strictEqual(townTemplate(F('x', { townMap: null, townMapCore: null }), false, true), null);
});

test('townsLikeZone copies every town property over the zone\'s own, as the engine does', () => {
	const zones = resolveZones({ zones: {
		1: { type: 'treasure', neutralTowns: { towns: 1 }, allowedTowns: ['tower'], townsAreSameType: true },
		2: { type: 'treasure', allowedTowns: ['castle'], bannedTowns: ['inferno'], townsLikeZone: 1 },
	} });
	const z2 = zones.find(z => z.id === 2);
	assert.deepStrictEqual(z2.allowedTowns, ['tower']);
	assert.strictEqual(z2.bannedTowns, undefined, 'the other zone bans nothing, so neither does this one');
	assert.deepStrictEqual(z2.neutralTowns, { towns: 1 });
});

test('Golems Aplenty\'s neutral town is Tower, and no surface start is Dungeon, Inferno or Necropolis', { timeout: 240000 }, () => {
	const { spawnSync } = require('child_process');
	const out = path.join(testTmp(), 'vmapgen_golems_towns.vmap');
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'),
		'--w', '72', '--h', '72', '--players', '4', '--humans', '1', '--seed', '12', '--underground', '1',
		'--template', 'Golems Aplenty', '--accommodate', 'size,players,humans,underground', '--out', out,
		'--declaremods', '0'],
	{ encoding: 'utf8', timeout: 200000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	// a start underground (template.js assignLevels) prefers exactly those
	const below = ((r.stderr.match(/\[gen\] starts underground: (.*)/) || [])[1] || '').split(', ').filter(Boolean);
	const factions = ((r.stderr.match(/\[gen\] factions: (.*)/) || [])[1] || '')
		.split(/\s{2,}/).filter(f => !below.includes(f.split('=')[0])).join('  ');
	assert.doesNotMatch(factions, /dungeon|inferno|necropolis/, factions);
	const { readVmap } = require('../src/preview/render');
	const towns = readVmap(out).objects.filter(o => o.type === 'town');
	assert.ok(towns.length >= 1, 'no concrete town');
	for (const t of towns) {
		assert.strictEqual(t.subtype, 'tower');
		assert.strictEqual(t.options.hasFort, false, 'a "towns" entry starts without a fort');
		assert.ok((t.options.possibleSpells || []).length === 69);
	}
	fs.rmSync(out, { force: true });
});

test('every town a template asks for gets placed: 8XM8 for seven has its 16', { timeout: 300000 }, () => {
	// 8XM8 wants a neutral town in each of zones 9-16, plus one in the start
	// zone no player takes. Placed in the zones' fill, after the walls and
	// ridges, one to three of them found no room on every map; their ground is
	// now held first, the engine's order (TownPlacer).
	const { spawnSync } = require('child_process');
	const out = path.join(testTmp(), 'vmapgen_8xm8_towns.vmap');
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'),
		'--w', '108', '--h', '108', '--players', '7', '--seed', '1001', '--declaremods', '0',
		'--template', '8XM8', '--out', out],
	{ encoding: 'utf8', timeout: 280000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	assert.doesNotMatch(r.stderr, /town found no room|holds ground for/);
	const towns = require('../src/preview/render').readVmap(out).objects.filter(o => /town/i.test(o.type));
	assert.strictEqual(towns.length, 16);
	assert.strictEqual(towns.filter(t => !(t.options && t.options.owner)).length, 9);
	fs.rmSync(out, { force: true });
});

test('Neutral town biomes at 0 suppresses a fixed template\'s own neutral towns too', { timeout: 300000 }, () => {
	// K, 2026-09-28, live testing: Jebus Cross at 2 players with the slider at
	// 0 still placed its authored neutral towns, the setting silently ignored
	// outside free layout. 4 players gives every start zone its own player,
	// isolating the fix from the unrelated "spare start becomes a neutral
	// town" accommodation (template.js's checkConstraints): the only neutral
	// towns left on the map are the template's own authored ones, 2 in each
	// of the 4 player zones plus 2 in the crossroads zone, 10 total.
	const { spawnSync } = require('child_process');
	const run = (out, extra) => spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'),
		'--w', '108', '--h', '108', '--players', '4', '--seed', '1001', '--declaremods', '0',
		'--template', 'Jebus Cross', '--out', out, ...extra],
	{ encoding: 'utf8', timeout: 280000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	const neutralTowns = out => require('../src/preview/render').readVmap(out).objects
		.filter(o => /town/i.test(o.type) && !(o.options && o.options.owner)).length;

	const outDefault = path.join(testTmp(), 'vmapgen_jebus_towns_default.vmap');
	const rDefault = run(outDefault, []);
	assert.strictEqual(rDefault.status, 0, rDefault.stderr.slice(-600));
	assert.strictEqual(neutralTowns(outDefault), 10, 'unchanged at the default setting, the calibrated corpus behavior');
	fs.rmSync(outDefault, { force: true });

	const outZero = path.join(testTmp(), 'vmapgen_jebus_towns_zero.vmap');
	const rZero = run(outZero, ['--bio.townRatio', '0']);
	assert.strictEqual(rZero.status, 0, rZero.stderr.slice(-600));
	assert.strictEqual(neutralTowns(outZero), 0, 'the slider at 0 now actually suppresses them');
	fs.rmSync(outZero, { force: true });
});

test('the same fix, verified live on every other template that authors neutral towns',
{ timeout: 600000 }, () => {
	// The lead's own follow-up, 2026-09-28: the fix above was only reproduced
	// and re-verified on Jebus Cross; "report real per-template results, not
	// just 'should cover it'". Each run at the template's own full player
	// count, same reason as Jebus Cross: no spare start, so every neutral
	// town on the map is one the template itself authored. Predicted counts
	// hand-summed from each template's own JSON, confirmed live before being
	// pinned here.
	const { spawnSync } = require('child_process');
	const { readVmap } = require('../src/preview/render');
	const run = (name, players, w, h, underground, extra, out) => {
		const args = [path.join(__dirname, '../src/main/generate-cli.js'),
			'--w', String(w), '--h', String(h), '--players', String(players), '--seed', '1001',
			'--declaremods', '0', '--template', name, '--out', out, ...extra];
		if (underground) args.push('--underground', '1');
		return spawnSync(process.execPath, args,
			{ encoding: 'utf8', timeout: 280000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	};
	const neutralTowns = out => readVmap(out).objects
		.filter(o => /town/i.test(o.type) && !(o.options && o.options.owner)).length;

	const CASES = [
		// name, players (the template's own max), w, h, underground, expected neutral towns at default
		['Golems Aplenty', 4, 72, 72, 0, 1],       // zone 5's neutralTowns.towns:1, nothing on any player zone
		['Headquarters', 7, 108, 108, 0, 9],       // 7 player zones' neutralTowns.towns:1 each, zone 9's castles:2
		['Nostalgia', 8, 144, 144, 1, 9],          // 9 treasure zones (16-24) at neutralTowns.towns:1 each
		["Coldshadow's Fantasy", 8, 144, 144, 1, 17], // 8 player zones + 8 treasure zones (9-16) + zone 21, all towns/castles:1
	];
	for (const [name, players, w, h, underground, expectDefault] of CASES) {
		const slug = name.replace(/[^a-z0-9]/gi, '_');
		const outDefault = path.join(testTmp(), `vmapgen_${slug}_default.vmap`);
		const rDefault = run(name, players, w, h, underground, [], outDefault);
		assert.strictEqual(rDefault.status, 0, `${name} default: ${rDefault.stderr.slice(-600)}`);
		assert.strictEqual(neutralTowns(outDefault), expectDefault, `${name}: unchanged at default`);
		fs.rmSync(outDefault, { force: true });

		const outZero = path.join(testTmp(), `vmapgen_${slug}_zero.vmap`);
		const rZero = run(name, players, w, h, underground, ['--bio.townRatio', '0'], outZero);
		assert.strictEqual(rZero.status, 0, `${name} townRatio=0: ${rZero.stderr.slice(-600)}`);
		assert.strictEqual(neutralTowns(outZero), 0, `${name}: the slider at 0 suppresses them too`);
		fs.rmSync(outZero, { force: true });
	}
});
