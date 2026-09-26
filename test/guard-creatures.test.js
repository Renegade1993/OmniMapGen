/**
 * guard-creatures.test.js - guards written as creatures (src/biome/guardCreatures.js).
 *
 * K asked for a golem-heavy map (2026-09-25). The engine's template schema has
 * no room for a theme (zones and root are additionalProperties:false), so it
 * is a generator lever that swaps guard placeholders for concrete creatures.
 * The same machinery writes a template guard as the creature the engine's
 * rule picked from what its zone allows (allowedMonsters / bannedMonsters),
 * as the engine's own maps do. These pin what a swap may and may not do: stay
 * on the tiles the planner checked, keep the guard's strength, use only names
 * the engine resolves in a map, and declare the mods it draws from.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { themePool, applyGuardTheme, footprintShift, levelStrengths, concretizeGuards,
	creatureRegistry, guardPool } = require('../src/biome/guardCreatures');
const { zoneGuardPool } = require('../src/biome/content');
const { xorshift } = require('../src/wfc/solver');
const CORE = require('../src/biome/creature_values.json');
const { genEnv, testTmp } = require('./_vcmi');

const VF = ['+++', '+-+', '+++'];
// an H3 template for every core creature, shaped like the real ones
const h3 = new Map(Object.values(CORE).map(c =>
	[c.index, { animation: `AVW${c.index}`, mask: ['VVV', 'VVA'], visitableFrom: VF }]));
const guard = (level, x, amount) => ({
	instanceName: `randomMonsterLevel${level}_${x}_5_0`, l: 0, x, y: 5,
	type: `randomMonsterLevel${level}`, subtype: 'object',
	template: { animation: 'AVWmrnd0', editorAnimation: '', mask: ['VV', 'VA'], visitableFrom: VF },
	options: amount === undefined ? { character: 'hostile' } : { character: 'hostile', amount },
});
const CORE_GOLEMS = ['diamondGolem', 'goldGolem', 'ironGolem', 'obsidianGargoyle',
	'stoneGargoyle', 'stoneGolem'];

test('a theme only uses templates that block one tile, and moves the anchor to keep it in place', () => {
	assert.deepStrictEqual(footprintShift({ mask: ['VV', 'VA'], visitableFrom: VF }), { dx: 0, dy: 0 });
	assert.deepStrictEqual(footprintShift({ mask: ['VVVV', 'VVVA'], visitableFrom: VF }), { dx: 0, dy: 0 },
		'a wider sprite is only drawn');
	// HotA's creatures: a three-wide sprite over the middle tile
	assert.deepStrictEqual(footprintShift({ mask: ['VVV', 'VAV'], visitableFrom: VF }), { dx: 1, dy: 0 });
	assert.deepStrictEqual(footprintShift({ mask: ['VAV', 'VVV'], visitableFrom: VF }), { dx: 1, dy: 1 });
	assert.strictEqual(footprintShift({ mask: ['VB', 'VA'], visitableFrom: VF }), null, 'a second blocked tile');
	assert.strictEqual(footprintShift({ mask: ['VV', 'VB'], visitableFrom: VF }), null, 'blocked, not visitable');
	assert.strictEqual(footprintShift({ mask: ['VV', 'VA'], visitableFrom: ['---', '+-+', '+++'] }), null,
		'fewer sides to approach from');
	assert.strictEqual(footprintShift(undefined), null);
});

test('a moved anchor keeps the blocked tile where the planner put it, and never leaves the map', () => {
	const wide = { name: 'steelGolem', level: 4, aiValue: 597, advMax: 20, mods: ['hota'],
		tpl: { animation: 'avwslgl0', mask: ['VVV', 'VAV'], visitableFrom: VF }, shift: { dx: 1, dy: 0 } };
	const inner = guard(4, 10, 5), edge = guard(4, 35, 5);
	const t = applyGuardTheme([inner, edge], { pool: [wide], rng: xorshift(2), W: 36, H: 36 });
	assert.strictEqual(t.themed, 1);
	assert.strictEqual(inner.x, 11, 'anchor one right of the placeholder');
	const { blockingCells } = require('../src/biome/content');
	assert.deepStrictEqual(blockingCells(inner.template, inner.x, inner.y).map(([x, y]) => [x, y]), [[10, 5]]);
	assert.strictEqual(edge.type, 'randomMonsterLevel4', 'an anchor at x = 36 would be off a 36-wide map');
	assert.strictEqual(edge.x, 35);
});

test('core golems are the six core creatures the golem terms name', () => {
	assert.deepStrictEqual(themePool('golems', { h3 }).map(c => c.name).sort(), CORE_GOLEMS);
	assert.deepStrictEqual(themePool('golems', {}), [], 'no H3 templates, nothing placeable');
	assert.throws(() => themePool('dragons', { h3 }), /unknown guard theme "dragons"/);
});

test('a guard becomes a themed creature at its level or one either side, at the same strength', () => {
	const pool = themePool('golems', { h3 });
	const objs = [guard(3, 1, 10), guard(4, 4), guard(7, 7, 2), guard(1, 10, 30)];
	const t = applyGuardTheme(objs, { pool, rng: xorshift(7) });
	assert.strictEqual(t.placeholders, 4);
	assert.strictEqual(t.themed, 4);
	assert.strictEqual(t.mods.size, 0);
	const s = levelStrengths();
	const [g3, g4, g7, g1] = objs;
	for (const o of objs) {
		assert.strictEqual(o.type, 'monster');
		assert.strictEqual(o.instanceName, `monster_${o.x}_5_0`);
		assert.strictEqual(o.template.animation, `AVW${CORE[o.subtype].index}`,
			'the template of the creature placed, not the placeholder');
		assert.strictEqual(o.options.character, 'hostile');
	}
	assert.ok(['ironGolem', 'stoneGolem'].includes(g3.subtype), g3.subtype);
	// a stack given an amount keeps its strength: amount x aiValue
	assert.strictEqual(g3.options.amount,
		Math.round(10 * s.get(3).perCreature / CORE[g3.subtype].aiValue));
	// no core golem at 4: one level either side, sized for level 4
	assert.ok(['ironGolem', 'stoneGolem', 'goldGolem'].includes(g4.subtype), g4.subtype);
	assert.ok(g4.options.amount >= 1);
	// the diamond golem is level 6, one below a level-7 guard
	assert.strictEqual(g7.subtype, 'diamondGolem');
	assert.strictEqual(g7.options.amount, Math.round(2 * s.get(7).perCreature / CORE.diamondGolem.aiValue));
	assert.ok(['stoneGargoyle', 'obsidianGargoyle'].includes(g1.subtype), g1.subtype);
});

test('a guard with no family member within one level stays random', () => {
	const pool = themePool('golems', { h3 }).filter(c => c.level <= 3);
	const objs = [guard(5, 1, 4), guard(6, 3)];
	assert.strictEqual(applyGuardTheme(objs, { pool, rng: xorshift(5) }).themed, 0);
	assert.strictEqual(objs[0].type, 'randomMonsterLevel5');
	assert.strictEqual(objs[1].template.animation, 'AVWmrnd0');
});

test('a same-level guard the engine would size keeps the engine sizing it', () => {
	const objs = [guard(3, 1)];
	applyGuardTheme(objs, { pool: themePool('golems', { h3 }), rng: xorshift(3) });
	assert.strictEqual(objs[0].type, 'monster');
	assert.ok(!('amount' in objs[0].options), 'the engine rolls it from the creature\'s own range');
});

test('share 0 changes nothing, and a shared options object is never written to', () => {
	const shared = { character: 'hostile' };
	const a = guard(4, 1), b = guard(4, 4);
	a.options = shared;
	b.options = shared;
	const pool = themePool('golems', { h3 });
	assert.strictEqual(applyGuardTheme([a, b], { pool, share: 0, rng: xorshift(1) }).themed, 0);
	assert.strictEqual(a.type, 'randomMonsterLevel4');
	assert.strictEqual(applyGuardTheme([a, b], { pool, share: 1, rng: xorshift(1) }).themed, 2);
	assert.ok(a.options.amount >= 1 && b.options.amount >= 1);
	assert.deepStrictEqual(shared, { character: 'hostile' });
});

test('with mods: mod golems join, a restyle declares its mod, shared names and excluded ones stay out', () => {
	const creatures = new Map([
		['core:ironGolem', { level: 3, aiValue: 0, index: CORE.ironGolem.index, scope: 'core' }],
		// a mod restyles a core golem: its sprite, so the map needs that mod
		['core:goldGolem', { level: 5, aiValue: 0, index: CORE.goldGolem.index, scope: 'core',
			map: 'AvWGolR.def', mapScope: 'refugee' }],
		['forge:steelGolem', { level: 4, aiValue: 900, scope: 'forge', map: 'AVWsteel',
			mapMask: ['VVV', 'VVA'], advMin: 10, advMax: 20 }],
		// blocks more than one tile
		['forge:hugeGolem', { level: 6, aiValue: 3000, scope: 'forge', map: 'AVWhuge',
			mapMask: ['BBV', 'BBA'] }],
		// HotA's shape: the blocked tile one left of the anchor
		['forge:wideGolem', { level: 7, aiValue: 5000, scope: 'forge', map: 'AVWwide',
			mapMask: ['VVV', 'VAV'] }],
		// kept out of the engine's own random rolls
		['forge:summonGolem', { level: 2, aiValue: 200, scope: 'forge', map: 'AVWsum', noRandom: true }],
		// a name two creatures share cannot be resolved in a map
		['other:stoneGolem', { level: 3, aiValue: 250, scope: 'other', map: 'AVWst2' }],
		['core:stoneGolem', { level: 3, aiValue: 0, index: CORE.stoneGolem.index, scope: 'core' }],
		['core:pikeman', { level: 1, aiValue: 0, index: 0, scope: 'core' }],
	]);
	const pool = themePool('golems', { creatures, h3, useMods: true });
	const byName = new Map(pool.map(c => [c.name, c]));
	assert.deepStrictEqual([...byName.keys()].sort(), ['goldGolem', 'ironGolem', 'steelGolem', 'wideGolem']);
	assert.deepStrictEqual(byName.get('wideGolem').shift, { dx: 1, dy: 0 });
	assert.strictEqual(byName.get('ironGolem').aiValue, CORE.ironGolem.aiValue, 'core aiValue from CRTRAITS');
	assert.deepStrictEqual(byName.get('ironGolem').mods, []);
	assert.strictEqual(byName.get('goldGolem').tpl.animation, 'AvWGolR');
	assert.deepStrictEqual(byName.get('goldGolem').mods, ['refugee']);
	assert.deepStrictEqual(byName.get('steelGolem').tpl.mask, ['VVV', 'VVA']);
	assert.deepStrictEqual(byName.get('steelGolem').mods, ['forge']);
	const objs = [guard(4, 1, 8)];
	const t = applyGuardTheme(objs, { pool, rng: xorshift(9) });
	assert.strictEqual(objs[0].subtype, 'steelGolem');
	assert.deepStrictEqual([...t.mods], ['forge']);
});

test('--guardtheme golems puts core golems on every guard of a generated map', { timeout: 240000 }, () => {
	const { spawnSync } = require('child_process');
	// a user folder holding OBJECTS.TXT rows for the six core golems: the
	// anchor tile (first in the file's order) blocked and visitable
	const user = fs.mkdtempSync(path.join(testTmp(), 'vmapgen-golems-'));
	fs.mkdirSync(path.join(user, 'Data'));
	const rows = [30, 31, 32, 33, 116, 117].map(i =>
		`TGOL${i}.def 0${'1'.repeat(47)} 1${'0'.repeat(47)} 111111111 111111111 54 ${i} 1 0`);
	fs.writeFileSync(path.join(user, 'Data', 'OBJECTS.TXT'), [rows.length, ...rows].join('\r\n'));
	const out = path.join(user, 'golems.vmap');
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'),
		'--w', '36', '--h', '36', '--players', '2', '--seed', '42', '--out', out,
		'--guardtheme', 'golems', '--vcmiuserdir', user, '--declaremods', '0'],
	{ encoding: 'utf8', timeout: 200000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	assert.match(r.stderr, /guard theme golems: \d+ of \d+ guards from 6 creatures/);
	const { readVmap } = require('../src/preview/render');
	const { objects } = readVmap(out);
	const monsters = objects.filter(o => o.type === 'monster');
	assert.ok(monsters.length > 0, 'no guard was themed');
	assert.strictEqual(objects.filter(o => /^randomMonsterLevel/.test(o.type)).length, 0,
		'every level has a core golem within one, so no guard stays random');
	for (const o of monsters) {
		assert.ok(CORE_GOLEMS.includes(o.subtype), o.subtype);
		assert.strictEqual(o.template.animation, `TGOL${CORE[o.subtype].index}`);
	}
	fs.rmSync(user, { recursive: true, force: true });
});

test('a zone allows the guards of its allowedMonsters factions, minus bannedMonsters, as the engine does', () => {
	const pool = [{ id: 'a', faction: 'tower' }, { id: 'b', faction: 'inferno' },
		{ id: 'c', faction: 'neutral' }, { id: 'd' }, { id: 'e', faction: 'hota.cove:cove' }];
	const ids = spec => zoneGuardPool(pool, spec).map(c => c.id).join('');
	assert.strictEqual(zoneGuardPool(pool, {}), pool, 'no lists: every creature');
	assert.strictEqual(zoneGuardPool(pool, undefined), pool);
	assert.strictEqual(ids({ allowedMonsters: ['tower', 'neutral'] }), 'acd', 'no faction is neutral');
	assert.strictEqual(ids({ bannedMonsters: ['inferno'] }), 'acde', 'banned alone: all the others');
	assert.strictEqual(ids({ allowedMonsters: ['Tower', 'inferno'], bannedMonsters: ['inferno'] }), 'a');
	assert.strictEqual(ids({ allowedMonsters: ['cove'] }), 'e', 'factions compare by bare name');
	// every allowed faction banned: CRmgTemplate.cpp:1028-1032 falls back to all
	assert.strictEqual(ids({ allowedMonsters: ['tower'], bannedMonsters: ['tower'] }), 'bcde');
});

test('the core registry gives engineGuard the same pool, in the same order, as before', () => {
	const pool = guardPool(creatureRegistry(null, false));
	const before = Object.entries(CORE).filter(([, c]) => !c.special && c.aiValue > 0 && c.level >= 1);
	assert.deepStrictEqual(pool.map(c => c.id), before.map(([id]) => id));
	const { engineGuard } = require('../src/biome/content');
	for (let seed = 1; seed <= 20; seed++)
		assert.deepStrictEqual(engineGuard(9000 + seed * 500, 1, xorshift(seed), false, pool),
			engineGuard(9000 + seed * 500, 1, xorshift(seed)), 'the same draw from the same pool');
});

test('with mods, a core creature takes what its index entry leaves out from CRTRAITS', () => {
	const reg = creatureRegistry(new Map([
		['core:goldGolem', { level: 5, aiValue: 0, index: 116, scope: 'core', faction: 'refugee',
			map: 'AvWGolR', mapScope: 'refugee' }],
		['forge:steelGolem', { level: 4, aiValue: 900, scope: 'forge', faction: 'neutral' }],
	]), true);
	assert.deepStrictEqual([...reg.keys()], ['goldGolem', 'forge:steelGolem'], 'core bare, mods scoped');
	const g = reg.get('goldGolem');
	assert.strictEqual(g.aiValue, CORE.goldGolem.aiValue);
	assert.strictEqual(g.advMax, CORE.goldGolem.advMax);
	assert.strictEqual(g.faction, 'refugee', 'the override wins where it speaks');
});

test('a picked guard is written as its creature; one the map cannot write stays a placeholder', () => {
	const registry = creatureRegistry(null, false);
	const a = guard(3, 4, 12), b = guard(7, 9, 2), c = guard(2, 20, 5), d = guard(1, 30, 9);
	const picked = new Map([[a, 'ironGolem'], [b, 'azureDragon'], [c, 'noSuchCreature']]);
	const noAzure = new Map([...h3].filter(([i]) => i !== CORE.azureDragon.index));
	const r = concretizeGuards([a, b, c, d], picked, { registry, h3: noAzure, useMods: false });
	assert.deepStrictEqual([r.placed, r.kept], [1, 2]);
	assert.strictEqual(a.type, 'monster');
	assert.strictEqual(a.subtype, 'ironGolem');
	assert.strictEqual(a.options.amount, 12, 'the engine rule sized it for this creature already');
	assert.strictEqual(a.template.animation, `AVW${CORE.ironGolem.index}`);
	assert.strictEqual(b.type, 'randomMonsterLevel7', 'no template: stays a placeholder');
	assert.strictEqual(c.type, 'randomMonsterLevel2', 'unknown creature: stays a placeholder');
	assert.strictEqual(d.type, 'randomMonsterLevel1', 'not picked: untouched');
	assert.strictEqual(r.mods.size, 0);
});

test('with mods, a picked mod creature is written with its own template and declares its mod', () => {
	const registry = creatureRegistry(new Map([
		['hota.neutralcreatures:steelGolem', { level: 4, aiValue: 597, scope: 'hota.neutralcreatures',
			map: 'hota/avwslgl0.def', mapMask: ['VVV', 'VAV'], mapScope: 'hota.neutralcreatures' }],
	]), true);
	const a = guard(4, 10, 6), edge = guard(4, 35, 6);
	const r = concretizeGuards([a, edge],
		new Map([[a, 'hota.neutralcreatures:steelGolem'], [edge, 'hota.neutralcreatures:steelGolem']]),
		{ registry, h3, useMods: true, W: 36, H: 36 });
	assert.strictEqual(a.subtype, 'steelGolem', 'maps name it unscoped, as the engine writes it');
	assert.strictEqual(a.template.animation, 'hota/avwslgl0');
	assert.strictEqual(a.x, 11, 'HotA shape: anchor one right, blocked tile unmoved');
	assert.deepStrictEqual([...r.mods], ['hota.neutralcreatures']);
	assert.strictEqual(edge.type, 'randomMonsterLevel4', 'the moved anchor would leave a 36-wide map');
});

test('planMap picks each template zone\'s guards from the factions it allows', () => {
	const { buildZonePlan } = require('../src/rmg/template');
	const { planMap } = require('../src/biome/plan');
	const treasure = [{ min: 3000, max: 9000, density: 10 }, { min: 9000, max: 20000, density: 4 }];
	const zonePlan = buildZonePlan(
		{ connections: [{ a: '1', b: '2', guard: 9000 }] },
		[{ id: 1, type: 'playerStart', owner: 1, size: 20, allowedMonsters: ['tower'], treasure },
		 { id: 2, type: 'treasure', size: 20, allowedMonsters: ['inferno', 'neutral'],
			bannedMonsters: ['neutral'], treasure }],
		{ w: 36, h: 36, levels: 1, players: 1 }, new Set());
	const terrainInfo = new Map([['dt', { name: 'core:dirt', moveCost: 100, allowedLayers: ['surface'] }]]);
	const { plans } = planMap({ W: 36, H: 36, levels: 1, playerStarts: [{ x: 4, y: 4, color: 'red' }],
		params: { seed: 9, zonePlan }, terrainShortIds: ['dt'], tileIdsByShort: new Map([['dt', [0]]]),
		numTiles: 1, objectPools: { guards: guardPool(creatureRegistry(null, false)) }, terrainInfo });
	const plan = plans[0];
	const allowed = [new Set(['tower']), new Set(['inferno'])];
	const linkCells = new Map(plan.guards.map(g => [g.cell, g.edge[0]]));
	const guards = plan.objects.filter(o => o.guardCreature);
	assert.ok(guards.length >= 4, `${guards.length} picked guards`);
	for (const o of guards) {
		const c = CORE[o.guardCreature];
		// a link guard is its first zone's pick; the rest stand in their own zone
		const cell = o.y * 36 + o.x;
		const z = linkCells.has(cell) ? linkCells.get(cell) : plan.zone[cell];
		// Azure Dragon is the engine's fallback when nothing allowed fits
		if (o.guardCreature !== 'azureDragon')
			assert.ok(allowed[z].has(c.faction), `${o.guardCreature} (${c.faction}) in zone ${z}`);
	}
	assert.ok(guards.some(o => CORE[o.guardCreature].faction === 'tower'));
	assert.ok(guards.some(o => CORE[o.guardCreature].faction === 'inferno'));
});

test('a template map\'s guards are written as the creatures its zones allow, by default', { timeout: 240000 }, () => {
	const { spawnSync } = require('child_process');
	// an OBJECTS.TXT row for every core creature: anchor tile blocked and visitable
	const user = fs.mkdtempSync(path.join(testTmp(), 'vmapgen-concrete-'));
	fs.mkdirSync(path.join(user, 'Data'));
	const rows = Object.values(CORE).map(c =>
		`TCRE${c.index}.def 0${'1'.repeat(47)} 1${'0'.repeat(47)} 111111111 111111111 54 ${c.index} 1 0`);
	fs.writeFileSync(path.join(user, 'Data', 'OBJECTS.TXT'), [rows.length, ...rows].join('\r\n'));
	const treasure = [{ min: 3000, max: 9000, density: 10 }, { min: 9000, max: 20000, density: 4 }];
	const zone = extra => ({ size: 20, allowedMonsters: ['tower', 'neutral'], treasure, ...extra });
	const tplFile = path.join(user, 'towerGuards.json');
	fs.writeFileSync(tplFile, JSON.stringify({ 'Tower Guards': { minSize: 's', maxSize: 'm', players: '2',
		zones: { 1: zone({ type: 'playerStart', owner: 1, playerTowns: { castles: 1 } }),
			2: zone({ type: 'playerStart', owner: 2, playerTowns: { castles: 1 } }),
			3: zone({ type: 'treasure', size: 30 }) },
		connections: [{ a: '1', b: '3', guard: 9000 }, { a: '2', b: '3', guard: 9000 }] } }));
	const out = path.join(user, 'tower.vmap');
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'),
		'--w', '36', '--h', '36', '--players', '2', '--seed', '5', '--out', out, '--template', tplFile,
		'--vcmiuserdir', user, '--declaremods', '0'],
	{ encoding: 'utf8', timeout: 200000, cwd: path.join(__dirname, '..'), windowsHide: true,
		env: genEnv() });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	assert.match(r.stderr, /concrete guards: \d+ written as their creature, 0 kept/);
	const { readVmap } = require('../src/preview/render');
	const { objects } = readVmap(out);
	const monsters = objects.filter(o => o.type === 'monster');
	assert.ok(monsters.length > 0, 'no guard written as a creature');
	assert.strictEqual(objects.filter(o => /^randomMonsterLevel/.test(o.type)).length, 0);
	for (const o of monsters) {
		const f = CORE[o.subtype].faction;
		assert.ok(f === 'tower' || f === 'neutral', `${o.subtype} (${f})`);
		assert.strictEqual(o.template.animation, `TCRE${CORE[o.subtype].index}`);
		assert.ok(o.options.amount >= 1, 'the engine rule sized every stack');
		assert.ok(!('guardCreature' in o), 'the pick never reaches the map file');
	}
	fs.rmSync(user, { recursive: true, force: true });
});

test('a theme\'s dwellings are those offering a family creature, core and mod, nearest the level asked', () => {
	const { themeDwellingPool } = require('../src/biome/guardCreatures');
	const objects = new Map([
		['core:creatureGeneratorSpecial.golemFactory', { creature: 'ironGolem',
			creatures: ['ironGolem', 'stoneGolem', 'goldGolem', 'diamondGolem'] }],
		['core:creatureGeneratorCommon.parapet', { creature: 'stoneGargoyle', creatures: ['stoneGargoyle'] }],
		['core:creatureGeneratorCommon.barracks', { creature: 'pikeman', creatures: ['pikeman'] }],
	]);
	const core = [
		{ type: 'creatureGeneratorSpecial', subtype: 'golemFactory', level: 3, weight: 1 },
		{ type: 'creatureGeneratorCommon', subtype: 'parapet', level: 2, weight: 1 },
		{ type: 'creatureGeneratorCommon', subtype: 'barracks', level: 1, weight: 1 },
	];
	const mods = [{ type: 'creatureGeneratorCommon', subtype: 'factoryLevel4', level: 4, weight: 1,
		creatures: ['hota.factory:automaton'], mod: 'hota.factory' },
	{ type: 'creatureGeneratorCommon', subtype: 'kennel', level: 1, weight: 1, creatures: ['dog'] }];
	const th = themeDwellingPool('golems', core, mods, objects, 0.5);
	assert.deepStrictEqual(th.pool.map(d => d.subtype), ['golemFactory', 'parapet', 'factoryLevel4']);
	assert.strictEqual(th.share, 0.5);
	const { nearestLevelDwelling } = require('../src/biome/content');
	assert.strictEqual(nearestLevelDwelling(th.pool, 2, xorshift(1)).subtype, 'parapet');
	assert.strictEqual(nearestLevelDwelling(th.pool, 7, xorshift(1)).subtype, 'factoryLevel4', 'nearest below');
	assert.strictEqual(nearestLevelDwelling(th.pool, 1, xorshift(1)).subtype, 'parapet', 'nearest above');
});

test('a theme\'s banks are those its family guards or pays out, read from "rewards" or "levels"', () => {
	const { buildAssetIndex } = require('../src/parser/assetIndex');
	const { themeBankPool } = require('../src/biome/guardCreatures');
	const dir = fs.mkdtempSync(path.join(testTmp(), 'vmapgen-banks-'));
	fs.mkdirSync(path.join(dir, 'Content', 'config'), { recursive: true });
	const bank = (guard, extra = {}) => ({ templates: { normal: { animation: 'x', mask: ['VA'],
		visitableFrom: ['+++', '+-+', '+++'] } }, ...extra, guard });
	fs.writeFileSync(path.join(dir, 'Content', 'config', 'banks.json'), JSON.stringify({
		creatureBank: { handler: 'bank', types: {
			studio: bank(0, { rewards: [{ guards: [{ amount: 8, type: 'stoneGargoyle' }], resources: { gold: 500 } }] }),
			forge: bank(0, { rewards: [{ guards: [{ amount: 4, type: 'pikeman' }], creatures: [{ amount: 2, type: 'fixture:steelGolem' }] }] }),
			oldStyle: bank(0, { levels: [{ guards: [{ amount: 3, type: 'ironGolem' }] }] }),
			pond: bank(0, { rewards: [{ guards: [{ amount: 9, type: 'pikeman' }] }] }),
		} },
	}));
	const idx = buildAssetIndex(null, [{ name: 'Fixture', objects: ['config/banks'], __dir: dir, __id: 'fixture' }]);
	const mods = ['studio', 'forge', 'oldStyle', 'pond'].map(s => ({ subtype: s,
		creatures: idx.objects.get(`fixture:creatureBank.${s}`).bankCreatures || [] }));
	const th = themeBankPool('golems', [], mods, idx.objects, 0.3);
	assert.deepStrictEqual(th.pool.map(b => b.subtype), ['studio', 'forge', 'oldStyle']);
	fs.rmSync(dir, { recursive: true, force: true });
});

test('a template that brings a theme gets it when none is asked for', { timeout: 240000 }, () => {
	const { spawnSync } = require('child_process');
	const THEMES = require('../src/biome/templateThemes.json');
	assert.strictEqual(THEMES['Golem Foundry'].theme, 'golems');
	const run = extra => spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'),
		'--w', '72', '--h', '72', '--players', '4', '--humans', '1', '--seed', '3', '--template', 'Golem Foundry',
		'--out', path.join(testTmp(), 'vmapgen_golem_foundry.vmap'), '--declaremods', '0', ...extra],
	{ encoding: 'utf8', timeout: 200000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	const r = run([]);
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	assert.match(r.stderr, /template brings theme golems/);
	assert.match(r.stderr, /guard theme golems:/);
	fs.rmSync(path.join(testTmp(), 'vmapgen_golem_foundry.vmap'), { force: true });
});
