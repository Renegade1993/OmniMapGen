'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { genEnv, testTmp } = require('./_vcmi');
const { parseSizeCode, parseRange, resolveZones, checkConstraints,
	buildZonePlan, guardToLevel, loadTemplate, zoneTreasureMass, lootScale }
	= require('../src/rmg/template');
const { planMap } = require('../src/biome/plan');

test('parseSizeCode follows the engine table', () => {
	assert.deepStrictEqual(parseSizeCode('s'), [36, 1]);
	assert.deepStrictEqual(parseSizeCode('XL+U'), [144, 2]);
	assert.deepStrictEqual(parseSizeCode('g'), [252, 1]);
	assert.deepStrictEqual(parseSizeCode('72x96x2'), [72, 2]);
	assert.strictEqual(parseSizeCode('bogus'), null);
});

test('parseRange handles singles, ranges and lists', () => {
	assert.deepStrictEqual(parseRange('2'), [[2, 2]]);
	assert.deepStrictEqual(parseRange('2-4'), [[2, 4]]);
	assert.deepStrictEqual(parseRange('2,4-6'), [[2, 2], [4, 6]]);
});

test('resolveZones resolves *LikeZone against earlier zones', () => {
	const raw = { zones: {
		'1': { type: 'playerStart', owner: 1, size: 20, mines: { wood: 2 },
			treasure: [{ min: 1, max: 5, density: 10 }],
			terrainTypes: ['dirt'], neutralTowns: { towns: 1 } },
		'2': { type: 'treasure', size: 30,
			minesLikeZone: 1, treasureLikeZone: 1,
			terrainTypeLikeZone: 1, townsLikeZone: 1 },
	} };
	const zs = resolveZones(raw);
	assert.strictEqual(zs.length, 2);
	assert.strictEqual(zs[1].mines.wood, 2);
	assert.deepStrictEqual(zs[1].treasure, zs[0].treasure);
	assert.deepStrictEqual(zs[1].terrainTypes, ['dirt']);
	assert.deepStrictEqual(zs[1].neutralTowns.towns, 1);
});

test('checkConstraints strict vs accommodate', () => {
	const raw = { minSize: 'l', maxSize: 'xl', players: '2-4', zones: {} };
	const zones = [{ type: 'playerStart', owner: 1, size: 10 }];
	const req = { w: 72, h: 72, levels: 1, players: 4 };
	let r = checkConstraints(raw, zones, req, new Set());
	assert.strictEqual(r.violations.length, 1);          // size
	assert.strictEqual(r.accommodated.length, 0);
	r = checkConstraints(raw, zones, req, new Set(['size']));
	assert.strictEqual(r.violations.length, 0);
	assert.strictEqual(r.accommodated.length, 1);
	r = checkConstraints(raw, zones, { ...req, w: 108, h: 108, players: 6 },
		new Set());
	assert.strictEqual(r.violations.length, 1);          // players > 4
});

test('checkConstraints follows the engine: forcedLevel is ignored on a one-level map', () => {
	// CZonePlacer skips forcedLevel when the map has one level, so the zone
	// goes on the surface instead of the template being refused
	const raw = { minSize: 's', maxSize: 'xl+u', players: '2', zones: {} };
	const zones = [
		{ id: 1, type: 'playerStart', owner: 1, size: 10 },
		{ id: 2, type: 'treasure', size: 10, forcedLevel: 'underground' }];
	const res = checkConstraints(raw, zones,
		{ w: 36, h: 36, levels: 1, players: 2 }, new Set());
	assert.strictEqual(res.violations.length, 0);
	assert.ok(res.accommodated.some(v => v.includes('surface')));
	const plan = buildZonePlan(raw, zones, { w: 36, h: 36, levels: 1, players: 2 }, new Set());
	assert.strictEqual(plan.perLevel[0].length, 2, 'the forced zone is on the surface');
});

test('checkConstraints follows the engine: spare start zones and the humans range do not refuse', () => {
	// Headquarters: players 2-7, seven start zones. The MapGen tab's picker
	// offers it at 4 players (matchesSize and the players range, as the
	// engine's list does) and the engine builds it, a neutral town in each
	// start zone nobody has; the generator used to refuse it.
	const raw = { minSize: 'm', maxSize: 'xl+u', players: '2-7', humans: '2', zones: {} };
	const zones = [1, 2, 3, 4, 5, 6, 7].map(owner => ({ type: 'playerStart', owner, size: 10 }))
		.concat([{ type: 'treasure', size: 10 }]);
	const four = checkConstraints(raw, zones, { w: 108, h: 108, levels: 1, players: 4, humans: 1 }, new Set());
	assert.deepStrictEqual(four.violations, []);
	assert.ok(four.accommodated.some(v => v.includes('3 of 7 start zones')));
	assert.ok(four.accommodated.some(v => v.includes('human count')));
	// the players range itself still holds, as it does in the engine
	const eight = checkConstraints(raw, zones, { w: 108, h: 108, levels: 1, players: 8, humans: 1 }, new Set());
	assert.ok(eight.violations.some(v => v.includes('player count 8')));
});

test('buildZonePlan parses connections and splits levels', () => {
	const raw = {
		connections: [
			{ a: '1', b: '3', guard: 3000, road: 'true', type: 'wide' },
			{ a: '2', b: '3', guard: 0, road: 'false' },
			{ a: '1', b: '4', guard: 9000 }], // 4 is underground: cross-level
		zones: {} };
	const zones = [
		{ id: 1, type: 'playerStart', owner: 1, size: 20 },
		{ id: 2, type: 'playerStart', owner: 2, size: 20 },
		{ id: 3, type: 'treasure', size: 40 },
		{ id: 4, type: 'treasure', size: 20, forcedLevel: 'underground' }];
	const req = { w: 72, h: 72, levels: 2, players: 2 };
	const plan = buildZonePlan(raw, zones, req, new Set());
	assert.strictEqual(plan.perLevel[0].filter(z => z.forcedLevel === 'underground').length, 0);
	assert.strictEqual(plan.perLevel[1].some(z => z.id === 4), true);
	const c = plan.connections.find(c => c.a === 1 && c.b === 3);
	assert.strictEqual(c.road, true);
	assert.strictEqual(c.wide, true);
	assert.strictEqual(c.guard, 3000);
	// same-level refs carry biome indices; cross-level ones are still present
	assert.ok(c.aRef && c.bRef);
	assert.strictEqual(plan.indexOf.get(4).l, 1);
	assert.ok(plan.medianMass >= 0);
});

test('guardToLevel bands', () => {
	assert.strictEqual(guardToLevel(0), 0);
	assert.strictEqual(guardToLevel(3000), 2);
	assert.strictEqual(guardToLevel(8000), 3);
	assert.strictEqual(guardToLevel(45000), 7);
});

test('loadTemplate reads a JSON file by path', () => {
	const dir = fs.mkdtempSync(path.join(testTmp(), 'rmg-'));
	const f = path.join(dir, 'mine.json');
	fs.writeFileSync(f, JSON.stringify({ 'My Test': { players: '2', zones: { '1': {} } } }));
	const t = loadTemplate(f);
	assert.strictEqual(t.name, 'My Test');
	assert.strictEqual(t.raw.players, '2');
});

test('planMap honors a template zone graph', () => {
	// two zones, one link: openings must exist on the 0-1 border
	const terrainInfo = new Map([['dt', { name: 'core:dirt', moveCost: 100,
		allowedLayers: ['surface'] }]]);
	const zonePlan = buildZonePlan(
		{ connections: [{ a: '1', b: '2', guard: 6000, road: 'false' }] },
		[{ id: 1, type: 'playerStart', owner: 1, size: 20, mines: { wood: 1 } },
		 { id: 2, type: 'treasure', size: 20,
			 treasure: [{ min: 10, max: 20, density: 14 }] }],
		{ w: 36, h: 36, levels: 1, players: 1 }, new Set());
	const W = 36, H = 36;
	const playerStarts = [{ x: 4, y: 4, color: 'red' }];
	const { plans } = planMap({ W, H, levels: 1, playerStarts,
		params: { seed: 9, zonePlan }, terrainShortIds: ['dt'],
		tileIdsByShort: new Map([['dt', [0]]]), numTiles: 1,
		objectPools: {}, terrainInfo });
	const plan = plans[0];
	// every zone got cells
	const seen = new Set(plan.zone);
	assert.ok(seen.size >= 2, `expected 2 biomes, got ${seen.size}`);
	// the 0-1 edge exists and is open (no road requested)
	const o = plan.openings.find(o => (o.a === 0 && o.b === 1) || (o.a === 1 && o.b === 0));
	assert.ok(o, 'no opening between zones 1 and 2');
	assert.ok(o.kind === 'portal' || o.kind === 'openNoRoad', `kind ${o.kind}`);
	// template guard on the hole, sized by the engine's zone-link rule: 6000 on
	// the engine's weak setting is a strength of 3375, a level 1-2 stack
	const g = plan.guards.find(g => g.edge.includes(0) && g.edge.includes(1));
	if (o.kind !== 'portal')
		assert.ok(g && g.level <= 2 && g.amount >= 1, `guard ${JSON.stringify(g)}`);
	// zone meta carried the mines and the treasure loot multiplier, which
	// follows the engine's pile count: 14 small piles per 400 tiles reads 1.25
	assert.ok(plan.zoneMeta[0].mines.wood === 1);
	assert.strictEqual(plan.zoneMeta[0].loot, 0.3);   // no treasure: clamped floor
	assert.ok(plan.zoneMeta[1].loot >= 1);
});

test('a template zone gets the mines it lists, and the starter mines count toward them', { timeout: 240000 }, () => {
	// Mini Nostalgia lists wood 1 and ore 1 in each of its eight start zones
	// and no mines anywhere else; the engine's maps of it carry exactly 16,
	// all sawmills and ore pits. Ours carried 35: random class mines in the
	// treasure zones and a starter sawmill and ore pit on top of each start
	// zone's own (fidelity lens, vmap_templatefit.js, 2026-09-25).
	const { spawnSync } = require('child_process');
	const out = path.join(testTmp(), 'vmapgen_tpl_mines.vmap');
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'),
		'--w', '108', '--h', '108', '--players', '4', '--seed', '1001', '--out', out,
		'--template', 'Mini Nostalgia', '--preset', 'nostalgia'],
	{ encoding: 'utf8', timeout: 200000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	const { readVmap } = require('../src/preview/render');
	const mines = readVmap(out).objects.filter(o => o.type === 'mine');
	const kinds = new Set(mines.map(o => o.subtype));
	assert.deepStrictEqual([...kinds].sort(), ['orePit', 'sawmill'], 'only the listed kinds');
	assert.ok(mines.length <= 16, `${mines.length} mines, the template lists 16`);
	assert.ok(mines.length >= 12, `${mines.length} mines, most of the 16 should fit`);
	fs.rmSync(out, { force: true });
});

test('template guards follow the engine: pile threshold, strength and creature by value', () => {
	// TreasurePlacer / ObjectManager::chooseGuard on the engine's weak map
	// setting, which every corpus map was made with (index 1 for a normal
	// zone). Before this, a template's treasure zones were guarded at levels
	// 4-7 whatever they held: 180 level-7 stacks per Nostalgia map against the
	// engine's 1.8 (fidelity lens, 2026-09-25).
	const { engineGuard } = require('../src/biome/content');
	const { xorshift } = require('../src/wfc/solver');
	const rng = xorshift(5);
	const levels = (v, idx, zoneGuard) => {
		const seen = new Set();
		for (let k = 0; k < 200; k++) {
			const g = engineGuard(v, idx, rng, zoneGuard);
			seen.add(g ? g.level : 0);
		}
		return [...seen].sort();
	};
	assert.deepStrictEqual(levels(2900, 1), [0], 'a pile at or under minGuardedValue is not guarded');
	assert.deepStrictEqual(levels(3000, 1, true), [0], 'a link guard under 2000 strength is not placed');
	assert.ok(levels(10000, 1).every(l => l >= 1 && l <= 6), 'a mid pile draws low and middle levels');
	assert.ok(levels(10000, 1).includes(1), 'including level 1');
	assert.ok(levels(45000, 1, true).every(l => l >= 4), 'a 45000 link draws level 4-7');
	const g = engineGuard(10000, 1, rng);
	assert.ok(g.amount >= 1 && g.strength > 0);
});
