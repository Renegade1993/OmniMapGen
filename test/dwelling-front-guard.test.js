/**
 * dwelling-front-guard.test.js - a dwelling whose whole front lies on a corridor held clear (RESERVED) still gets a guard in front of it.
 * closeApproaches would post a guard only on a tile off every corridor and road, so on K's settings for his large two players Coldshadow map
 * (October 9th, his mods) at seed 406757261 the magic lantern at (90,103) had no monster within 6 tiles and three of the ten dwellings
 * stood open (approach-open 30%, the limit 20%). A guard may now stand on such a tile when nothing else can and its ring cuts no way, and a
 * guard against the dwelling's back moves there rather than a second one being posted. The suite's roots have no user folder and place no
 * Coldshadow dwellings, so the test runs the same options on the free layout: at seed 23 one of its eight dwellings stood open (seed 10,
 * used first, changed with the town spots of b3f87f5 and keeps only seven dwellings, under the check's count of ten).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');
const { runChecks } = require('../tools/harness/playtest_checks');

const OPTS = {
	'w': '108', 'h': '108', 'players': '2', 'humans': '2', 'factions': 'random,random', 'bio.compOnly': '0', 'humancolors': 'red', 'declaremods': '1',
	'preset': 'nostalgia', 'bio.artifactDensity': '0.006', 'bio.artifactRichness': '0.5', 'bio.biomeWobble': '0.6',
	'bio.bonusDensity': '1', 'bio.borderSolidity': '1', 'bio.chokeGuardRatio': '0.7', 'bio.decorDensity': '1', 'bio.dwellingDensity': '1',
	'bio.guardBottlenecks': '1', 'bio.guardDensity': '1', 'bio.guardDwellings': '1', 'bio.guardMines': '1', 'bio.guardPortals': '2', 'bio.guardTreasure': '1',
	'bio.highLootRatio': '0.25', 'bio.interconnectPortal': '0.2', 'bio.interconnectivity': '0.6', 'bio.lootGuardWeight': '1', 'bio.lowLootRatio': '0.25',
	'bio.mineDensity': '1', 'bio.mineGuardWeight': '1', 'bio.monsterStrength': '0', 'bio.guardShare': '1', 'bio.openPathNoRoad': '0.55',
	'bio.openPathRoad': '0.26', 'bio.pickupDensity': '1', 'bio.resourceDensity': '1', 'bio.riverAmount': '1', 'rivers': '1', 'bio.roadCobblestone': '1',
	'bio.roadDirt': '1', 'bio.roadGravel': '1', 'bio.roadNetwork': '1', 'bio.roadType': '2', 'bio.stackScale': '1', 'bio.starterMines': '1',
	'bio.subterraneanGateRatio': '1', 'bio.subterraneanNarrow': '0.6', 'bio.subterraneanOpen': '0.57', 'bio.teams': '1', 'bio.townRatio': '0.1',
	'bio.undergroundStarts': '4', 'bio.waterAccess': '2', 'bio.waterBuildings': '1', 'bio.waterContent': '0', 'bio.waterCoverage': '0', 'bio.waterShape': '8',
	'bio.waterTreasure': '1', 'bio.zoneCap': '300', 'bio.zoneCells': '400',
};

// A rate over seeds 20 to 29 since 2026-10-18 (the lead: never re-pin a lucky seed): over seeds 20 to 25 the fronts stood open 4 of 37 on
// 305b6a6 and 8 of 42 with the building-pinch rule, while seed 23 alone read 0 and 1; over seeds 20 to 29, 4 of 67 (6.0%) on 305b6a6. Bar: the
// playable gate's own limit, 20% (approach-open).
const SEEDS = [20, 21, 22, 23, 24, 25, 26, 27, 28, 29];
test('K settings 108x108 two players free layout, seeds 20 to 29: dwelling fronts open under 20%, the playable gate limit', { timeout: 1200000 }, t => {
	let open = 0, dwellings = 0;
	for (const seed of SEEDS) {
		const out = path.join(testTmp(), `vmapgen_dwfront_${process.pid}_${seed}.vmap`);
		const args = [...Object.entries(OPTS).flatMap(([k, v]) => ['--' + k, v]), '--seed', String(seed), '--out', out];
		const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), ...args],
			{ encoding: 'utf8', timeout: 300000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
		try {
			assert.strictEqual(r.status, 0, (r.stderr || '').slice(-800));
			const a = runChecks(out, ['approach-open']).checks['approach-open'];
			open += Math.round((a.nums.dwellings || 0) * (a.nums.nDwellings || 0)); dwellings += a.nums.nDwellings || 0;
		} finally {
			for (const f of [out, out + '.zones.json']) try { fs.unlinkSync(f); } catch (e) { /* gone already */ }
		}
	}
	t.diagnostic(`dwelling fronts open ${open} of ${dwellings} (${(100 * open / dwellings).toFixed(1)}%)`);
	assert.ok(dwellings >= 5 * SEEDS.length, `dwellings ${dwellings}`);
	assert.ok(open / dwellings < 0.2, `dwelling fronts open ${open} of ${dwellings} (${(100 * open / dwellings).toFixed(1)}%), bar 20%`);
});
