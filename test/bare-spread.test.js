/**
 * bare-spread.test.js - a start biome's loot is spread over its whole area (K, 2026-10-06 15:44, his XL four-player Coldshadow's Fantasy, seed
 * 1594927107: "a straight up empty snow biome that grew as an appendage of my starting biome ... very sparse and artificial looking"). Windows of 12x12
 * with under a quarter of the level's median loot, joined edge to edge, made a bare area of 18 windows (2300 land tiles, 34 objects); the engine's
 * Coldshadow maps have 3 at most. A window under a third of the level's median is lifted to half of it, whatever its neighbours hold (plan.js
 * fillBareWindows).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');
const sight = require('../tools/mapsight/lib/sight');
const { CHECKS } = require('../tools/harness/playtest_checks');

// K's recorded options of that map (declaremods off, the paths dropped)
const K = JSON.parse('{"w":"144","h":"144","players":"4","humans":"4","factions":"random,random,random,random","bio.compOnly":"0","underground":"1","humancolors":"red","template":"Coldshadow\'s Fantasy","preset":"nostalgia","bio.artifactDensity":"0.006","bio.artifactRichness":"0.5","bio.biomeWobble":"0.6","bio.bonusDensity":"1","bio.borderSolidity":"1","bio.chokeGuardRatio":"0.7","bio.decorDensity":"1","bio.dwellingDensity":"1","bio.guardBottlenecks":"1","bio.guardDensity":"1","bio.guardDwellings":"1","bio.guardMines":"1","bio.guardPortals":"2","bio.guardTreasure":"1","bio.highLootRatio":"0.25","bio.interconnectPortal":"0.2","bio.interconnectivity":"0.6","bio.lootGuardWeight":"1","bio.lowLootRatio":"0.25","bio.mineDensity":"1","bio.mineGuardWeight":"1","bio.monsterStrength":"0","bio.objectGuardShare":"0.75","bio.openPathNoRoad":"0.55","bio.openPathRoad":"0.26","bio.pickupDensity":"1","bio.resourceDensity":"1","bio.riverAmount":"1","rivers":"1","bio.roadCobblestone":"1","bio.roadDirt":"1","bio.roadGravel":"1","bio.roadNetwork":"1","bio.roadType":"2","bio.stackScale":"1","bio.starterMines":"1","bio.subterraneanGateRatio":"1","bio.subterraneanNarrow":"0.6","bio.subterraneanOpen":"0.57","bio.teams":"1","bio.townRatio":"0.1","bio.undergroundStarts":"4","bio.waterAccess":"2","bio.waterBuildings":"1","bio.waterContent":"0","bio.waterCoverage":"0","bio.waterShape":"8","bio.waterTreasure":"1","bio.zoneCap":"300","bio.zoneCells":"400"}');

test("K's XL map options, seed 1594927107: the largest bare area is under 12 windows (18 before the lift)", { timeout: 400000 }, () => {
	const out = path.join(testTmp(), 'vmapgen_bare_spread.vmap');
	const a = [path.join(__dirname, '../src/main/generate-cli.js'), '--out', out, '--declaremods', '0', '--seed', '1594927107'];
	for (const [k, v] of Object.entries(K)) a.push('--' + k, String(v));
	const r = spawnSync(process.execPath, a, { encoding: 'utf8', timeout: 380000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	const res = CHECKS['biome-density'](sight.load(out));
	for (const f of [out, out + '.zones.json', out.replace(/\.vmap$/, '.zonedump.json')]) fs.rmSync(f, { force: true });
	assert.strictEqual(res.pass, true, res.value + ' ' + (res.items || []).join('; '));
});
