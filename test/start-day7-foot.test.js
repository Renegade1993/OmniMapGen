/**
 * start-day7-foot.test.js - the day-7 floor (plan.js, the passes at the end of planMap) compares the starts' walks on foot; a start on a
 * level with water whose whole ground on foot is under 1/2.2 of the best walk on foot is an island start and is measured sailing; a pass
 * that lifts no start walks further, or opens a lifted start's way into another player's start zone, is undone; and an undone pass puts
 * back every field of every object (the lead's design call and the Opus Reviewer's notes on 17b1471, 2026-10-22). Cases are pairwise grid
 * configurations (TemplateFactory pw_cases_s1_c288db0.json): pw_047_108p2uf (five starts within 1.82 on foot; orange sails to 760 tiles
 * against blue's 131 on foot in the test install), pw_095_72p6uf (two surface starts on their own islands against two cave starts) and
 * pw_091_108p6f (a pass that would let one start walk into another's zone). Opus Map Vision 2026-10-22.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');
const { snapObjects, restoreObjects } = require('../src/biome/plan');

const PW047 = { w: 108, h: 108, players: 2, humans: 2, seed: '1047', underground: 1, 'bio.waterContent': 1, 'bio.zoneCells': 400, 'bio.zoneCap': 300,
	'bio.highLootRatio': 0, 'bio.townRatio': 0.1, 'bio.lowLootRatio': 0.25, 'bio.borderSolidity': 0.5, 'bio.biomeWobble': 0.6, 'bio.interconnectivity': 0,
	'bio.interconnectPortal': 0, 'bio.openPathNoRoad': 1, 'bio.openPathRoad': 0.26, 'bio.roadNetwork': 0, 'bio.roadType': 2, 'bio.artifactDensity': 0.006,
	'bio.artifactRichness': 0, 'bio.pickupDensity': 1, 'bio.resourceDensity': 1, 'bio.mineDensity': 1, 'bio.starterMines': 1, 'bio.dwellingDensity': 1,
	'bio.bonusDensity': 1, 'bio.monsterStrength': 1, 'bio.stackScale': 3, 'bio.guardDensity': 1, 'bio.objectGuardShare': 0.75, 'bio.guardTreasure': 1,
	'bio.guardMines': 1, 'bio.guardDwellings': 1, 'bio.guardBottlenecks': 1, 'bio.chokeGuardRatio': 0.7, 'bio.guardPortals': 1, 'bio.lootGuardWeight': 4,
	'bio.mineGuardWeight': 0, 'bio.subterraneanGateRatio': 2, 'bio.subterraneanNarrow': 0.6, 'bio.undergroundStarts': 0, 'bio.subterraneanOpen': 0.2,
	'bio.decorDensity': 0, rivers: 1, 'bio.riverAmount': 3, 'bio.teams': 1, 'bio.compOnly': 3, 'bio.roadDirt': 1, 'bio.roadGravel': 0,
	'bio.roadCobblestone': 0, 'bio.waterCoverage': 0, 'bio.waterShape': 0, 'bio.islandShape': 1.5, 'bio.dragonIslandLayout': 0, 'bio.waterAccess': 1,
	'bio.waterTreasure': 3, 'bio.waterBuildings': 3 };
const PW095 = { w: 72, h: 72, players: 6, humans: 2, seed: '1095', underground: 1, 'bio.waterContent': 1, 'bio.zoneCells': 1500, 'bio.zoneCap': 4,
	'bio.highLootRatio': 0.25, 'bio.townRatio': 0.1, 'bio.lowLootRatio': 0, 'bio.borderSolidity': 0, 'bio.biomeWobble': 1.5, 'bio.interconnectivity': 0.6,
	'bio.interconnectPortal': 1, 'bio.openPathNoRoad': 0.55, 'bio.openPathRoad': 0.26, 'bio.roadNetwork': 0, 'bio.roadType': 0, 'bio.artifactDensity': 0.006,
	'bio.artifactRichness': 0.5, 'bio.pickupDensity': 0, 'bio.resourceDensity': 0, 'bio.mineDensity': 3, 'bio.starterMines': 0, 'bio.dwellingDensity': 1,
	'bio.bonusDensity': 0, 'bio.monsterStrength': -2, 'bio.stackScale': 3, 'bio.guardDensity': 3, 'bio.objectGuardShare': 1, 'bio.guardTreasure': 0,
	'bio.guardMines': 1, 'bio.guardDwellings': 0, 'bio.guardBottlenecks': 0, 'bio.chokeGuardRatio': 0, 'bio.guardPortals': 0, 'bio.lootGuardWeight': 4,
	'bio.mineGuardWeight': 4, 'bio.subterraneanGateRatio': 0, 'bio.subterraneanNarrow': 0, 'bio.undergroundStarts': 4, 'bio.subterraneanOpen': 0.9,
	'bio.decorDensity': 1, rivers: 1, 'bio.riverAmount': 0.25, 'bio.teams': 7, 'bio.compOnly': -1, 'bio.roadDirt': 1, 'bio.roadGravel': 1,
	'bio.roadCobblestone': 1, 'bio.waterCoverage': 0.6, 'bio.waterShape': 6, 'bio.islandShape': 1, 'bio.dragonIslandLayout': 0, 'bio.waterAccess': 3,
	'bio.waterTreasure': 1, 'bio.waterBuildings': 0 };

const PW091 = { w: 108, h: 108, players: 6, humans: 2, seed: '1091', 'bio.waterContent': 0, 'bio.zoneCells': 400, 'bio.zoneCap': 4,
	'bio.highLootRatio': 1, 'bio.townRatio': 0, 'bio.lowLootRatio': 1, 'bio.borderSolidity': 0, 'bio.biomeWobble': 1.5, 'bio.interconnectivity': 0,
	'bio.interconnectPortal': 1, 'bio.openPathNoRoad': 1, 'bio.openPathRoad': 0.26, 'bio.roadNetwork': 1, 'bio.roadType': 1,
	'bio.artifactDensity': 0.02, 'bio.artifactRichness': 0, 'bio.pickupDensity': 1, 'bio.resourceDensity': 3, 'bio.mineDensity': 3,
	'bio.starterMines': 1, 'bio.dwellingDensity': 0, 'bio.bonusDensity': 3, 'bio.monsterStrength': -1, 'bio.stackScale': 1, 'bio.guardDensity': 3,
	'bio.objectGuardShare': 1, 'bio.guardTreasure': 1, 'bio.guardMines': 0, 'bio.guardDwellings': 1, 'bio.guardBottlenecks': 0,
	'bio.chokeGuardRatio': 1, 'bio.guardPortals': 1, 'bio.lootGuardWeight': 4, 'bio.mineGuardWeight': 1, 'bio.decorDensity': 1, rivers: 0,
	'bio.riverAmount': 3, 'bio.teams': 7, 'bio.compOnly': -1, 'bio.roadDirt': 1, 'bio.roadGravel': 1, 'bio.roadCobblestone': 0 };

// the map's objects (class, type, level, tile; sorted) and the generator's log, with the environment given
function gen(opt, tag, env = {}) {
	const out = path.join(testTmp(), `vmapgen_day7foot_${process.pid}_${tag}.vmap`);
	const args = [path.join(__dirname, '../src/main/generate-cli.js')];
	for (const [k, v] of Object.entries(opt)) args.push('--' + k, String(v));
	args.push('--out', out);
	const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 600000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv(env), maxBuffer: 1 << 26 });
	assert.strictEqual(r.status, 0, (r.stderr || '').slice(-400));
	const M = require('../tools/mapsight/lib/sight').load(out);
	fs.rmSync(out, { force: true }); fs.rmSync(out + '.zones.json', { force: true });
	return { objs: M.objs.map(o => `${o.cls}:${o.type}/${o.sub || ''}@${o.l},${o.at[0]},${o.at[1]}`).sort(), log: r.stderr || '' };
}
// the trace's starts: owner -> { walk, foot, sail, island }
function trace(log) {
	const line = log.split('\n').find(l => l.startsWith('[floor] day 7, pass 1:'));
	assert.ok(line, 'a day-7 trace line');
	const out = new Map();
	for (const m of line.matchAll(/(\w+) (\d+)( sailing, island)? \(on foot (\d+), sailing (\d+), ground (\d+)/g))
		out.set(m[1], { walk: +m[2], island: !!m[3], foot: +m[4], sail: +m[5], ground: +m[6] });
	return out;
}

test('an undone pass puts back every field of every object, a guard trade of the loot swap included', () => {
	const g1 = { type: 'randomMonsterLevel7', subtype: 'object', options: { character: 'hostile' }, template: { mask: ['VV', 'VA'] }, x: 122, y: 89, l: 1 };
	const g2 = { type: 'randomMonsterLevel3', subtype: 'object', options: { character: 'hostile', amount: 9 }, template: { mask: ['VA'] }, x: 126, y: 100, l: 1 };
	const pile = { type: 'pandoraBox', x: 54, y: 47, l: 1, instanceName: 'pandoraBox_54_47_1' };
	const plans = [{ objects: [pile] }, { objects: [g1, g2] }];
	const before = plans.map(pl => pl.objects.map(o => JSON.parse(JSON.stringify(o))));
	const snap = snapObjects(plans);
	// what the floor and the loot swap do: a guard moved, two guards' creatures traded, a pile moved, a stack taken away, a field added
	for (const k of ['type', 'options', 'subtype', 'template']) [g1[k], g2[k]] = [g2[k], g1[k]];
	g1.x = 125; g1.instanceName = 'monster_125_89_1';
	pile.y = 46;
	plans[1].objects = plans[1].objects.filter(o => o !== g2);
	g2.guardCreature = 'x';
	restoreObjects(plans, snap);
	assert.deepStrictEqual(plans.map(pl => pl.objects.map(o => JSON.parse(JSON.stringify(o)))), before);
	assert.strictEqual(plans[1].objects[0], g1);
	assert.strictEqual(plans[1].objects[1], g2);
});

test('pw_047_108p2uf: the starts within 2.2 on foot, the passes leave the map as with them off; orange\'s sailing walk is over 2.2 of the weakest walk on foot', { timeout: 1500000 }, () => {
	const on = gen(PW047, 'on', { VMAPGEN_FLOOR_TRACE: '1' }), off = gen(PW047, 'off', { VMAPGEN_START_DAY7: '0' });
	const t = trace(on.log), foot = [...t.values()].map(s => s.foot), sail = [...t.values()].map(s => s.sail);
	assert.ok(t.size >= 2, `starts ${[...t.keys()]}`);
	assert.ok([...t.values()].every(s => !s.island), 'no island start');
	assert.ok(Math.max(...foot) <= 2.2 * Math.min(...foot), `on foot ${foot}`);
	assert.ok(Math.max(...sail) > 2.2 * Math.min(...foot), `sailing ${sail} against on foot ${foot}: the case no longer tests the rule`);
	assert.ok(!/start walk by day 7 short/.test(on.log), 'no pass');
	assert.deepStrictEqual(on.objs, off.objs);
});

test('pw_095_72p6uf: the surface starts are island starts measured sailing; the pass lifts neither, is undone and leaves the map as with the passes off', { timeout: 1500000 }, () => {
	const on = gen(PW095, 'on', { VMAPGEN_FLOOR_TRACE: '1' }), off = gen(PW095, 'off', { VMAPGEN_START_DAY7: '0' });
	const t = trace(on.log), isl = [...t.values()].filter(s => s.island), land = [...t.values()].filter(s => !s.island);
	assert.strictEqual(isl.length, 2, JSON.stringify([...t]));
	for (const s of isl) { assert.strictEqual(s.walk, s.sail); assert.ok(s.ground * 2.2 < Math.max(...land.map(x => x.foot)), JSON.stringify(s)); }
	assert.match(on.log, /the pass undone, no start it lifted walks further/);
	assert.deepStrictEqual(on.objs, off.objs);
});

// a pass that would let a lifted start walk into another player's start zone with no fight is undone (the Opus Reviewer on f4c26fc;
// with K's mods pw_091's pass moved the stack at (41,1) and blue walked into orange's start zone at (38,1); in the test install it is teal
// into tan's)
test('pw_091_108p6f: a pass that opens a way into another player\'s start zone is undone and leaves the map as with the passes off', { timeout: 1500000 }, () => {
	const on = gen(PW091, 'on', { VMAPGEN_FLOOR_TRACE: '1' }), off = gen(PW091, 'off', { VMAPGEN_START_DAY7: '0' });
	assert.match(on.log, /the pass undone, \w+ would reach \w+'s start zone with no fight/);
	assert.deepStrictEqual(on.objs, off.objs);
});
