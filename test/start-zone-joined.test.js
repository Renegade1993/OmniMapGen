/**
 * start-zone-joined.test.js - a free layout's start whose town the warp left in a neighbour's zone keeps its own zone's body: the town's
 * patch handed back to the start (plan.js VMAPGEN_START_GROUND) is joined to the body by the short way between them, so the pass that keeps
 * each zone whole keeps both (VMAPGEN_START_GROUND_JOIN). The pairwise grid's pw_017_144p7f (144 one level, eight starts, Road Network Off):
 * pink's town (70,4) stood in zone 3 with its own zone five tiles off, and its zone went from 1425 tiles to 19 (the Opus Reviewer on
 * f4c26fc). Opus Map Vision 2026-10-22.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');

const OPT = ['--w', '144', '--h', '144', '--players', '7', '--humans', '2', '--seed', '1017', '--bio.waterContent', '-1', '--bio.zoneCells', '150',
	'--bio.zoneCap', '4', '--bio.highLootRatio', '1', '--bio.townRatio', '1', '--bio.lowLootRatio', '1', '--bio.borderSolidity', '0.75',
	'--bio.biomeWobble', '1.5', '--bio.interconnectivity', '1', '--bio.interconnectPortal', '0', '--bio.openPathNoRoad', '1', '--bio.openPathRoad', '0',
	'--bio.roadNetwork', '0', '--bio.roadType', '1', '--bio.artifactDensity', '0.006', '--bio.artifactRichness', '1', '--bio.pickupDensity', '3',
	'--bio.resourceDensity', '1', '--bio.mineDensity', '0', '--bio.starterMines', '1', '--bio.dwellingDensity', '1', '--bio.bonusDensity', '1',
	'--bio.monsterStrength', '-1', '--bio.stackScale', '1', '--bio.guardDensity', '1', '--bio.objectGuardShare', '1', '--bio.guardTreasure', '0',
	'--bio.guardMines', '1', '--bio.guardDwellings', '1', '--bio.guardBottlenecks', '1', '--bio.chokeGuardRatio', '1', '--bio.guardPortals', '1',
	'--bio.lootGuardWeight', '4', '--bio.mineGuardWeight', '4', '--bio.decorDensity', '1', '--rivers', '0', '--bio.riverAmount', '0.25', '--bio.teams', '2',
	'--bio.compOnly', '7', '--bio.roadDirt', '1', '--bio.roadGravel', '1', '--bio.roadCobblestone', '0', '--bio.waterCoverage', '0', '--bio.waterShape', '2',
	'--bio.islandShape', '1.5', '--bio.dragonIslandLayout', '0', '--bio.waterAccess', '1', '--bio.waterTreasure', '1', '--bio.waterBuildings', '0'];

// the tiles of each start's zone (the zone under its town), smallest and largest
function startZones(tag, env = {}) {
	const out = path.join(testTmp(), `vmapgen_zonejoin_${process.pid}_${tag}.vmap`);
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), ...OPT, '--out', out],
		{ encoding: 'utf8', timeout: 600000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv(env) });
	assert.strictEqual(r.status, 0, (r.stderr || '').slice(-400));
	const sight = require('../tools/mapsight/lib/sight');
	const M = sight.load(out), st = sight.starts(M), Z = JSON.parse(fs.readFileSync(out + '.zones.json', 'utf8')).levels;
	const sizes = [];
	for (const t of M.objs.filter(o => o.cls === 'town' && st.some(s => s.l === o.l && Math.max(Math.abs(s.at[0] - o.at[0]), Math.abs(s.at[1] - o.at[1])) <= 1))) {
		const zone = Z[t.l || 0].zone, z = zone[t.at[1] * M.W + t.at[0]];
		sizes.push(zone.filter(v => v === z).length);
	}
	fs.rmSync(out, { force: true }); fs.rmSync(out + '.zones.json', { force: true });
	assert.ok(sizes.length >= 7, `starts: ${sizes}`);
	return { lo: Math.min(...sizes), hi: Math.max(...sizes), sizes };
}

test('pw_017_144p7f: every start zone has at least a quarter of the largest start zone\'s tiles', { timeout: 900000 }, () => {
	const r = startZones('on');
	assert.ok(r.lo * 4 >= r.hi, `start zones ${r.sizes}`);
});

test('pw_017_144p7f with VMAPGEN_START_GROUND_JOIN=0: a start zone is under a quarter of the largest (the join is needed)', { timeout: 900000 }, () => {
	const r = startZones('off', { VMAPGEN_START_GROUND_JOIN: '0' });
	assert.ok(r.lo * 4 < r.hi, `start zones ${r.sizes}`);
});
