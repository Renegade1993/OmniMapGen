/**
 * start-reach-water.test.js - on a Mediterranean map every start walks to every land zone (guards beaten, subterranean gates and monoliths
 * taken; tools/geometry/startreach.js). The Opus Reviewer's R42, 2026-10-11: the central sea drowned the middle zones Coldshadow's Fantasy
 * links its ring through, and the ring zones met only through walls (108x108 four players seed 7001: red walked 1 of 19 zones; K's 180x180
 * seed 669067840: two starts their own zone only). plan.js ringLinks opens guarded passages between neighbouring pieces of land. This is
 * stricter than "every land zone or a shipyard": a start with a shipyard and nothing else to walk to still fails.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');
const { reach } = require('../tools/geometry/startreach');

// K's options for his 180x180 Mediterranean game (October 10th), the one-level Coldshadow's Fantasy with water shape 3 at 45%
const OPTS = {
	'players': '4',
	'humans': '4',
	'factions': 'random,random,random,random',
	'bio.compOnly': '0',
	'humancolors': 'red',
	'declaremods': '1',
	'template': "Coldshadow's Fantasy",
	'preset': 'nostalgia',
	'bio.artifactDensity': '0.006',
	'bio.artifactRichness': '0.5',
	'bio.biomeWobble': '0.6',
	'bio.bonusDensity': '1',
	'bio.borderSolidity': '0.7',
	'bio.chokeGuardRatio': '0.7',
	'bio.decorDensity': '1',
	'bio.dwellingDensity': '1',
	'bio.guardBottlenecks': '1',
	'bio.guardDensity': '1',
	'bio.guardDwellings': '1',
	'bio.guardMines': '1',
	'bio.guardPortals': '2',
	'bio.guardTreasure': '1',
	'bio.highLootRatio': '0.25',
	'bio.interconnectPortal': '0',
	'bio.interconnectivity': '0.35',
	'bio.lootGuardWeight': '1',
	'bio.lowLootRatio': '0.25',
	'bio.mineDensity': '1',
	'bio.mineGuardWeight': '1',
	'bio.monsterStrength': '0',
	'bio.objectGuardShare': '0.75',
	'bio.openPathNoRoad': '0.5',
	'bio.openPathRoad': '0.5',
	'bio.pickupDensity': '1',
	'bio.resourceDensity': '1',
	'bio.riverAmount': '1',
	'rivers': '1',
	'bio.roadCobblestone': '1',
	'bio.roadDirt': '1',
	'bio.roadGravel': '1',
	'bio.roadNetwork': '1',
	'bio.roadType': '2',
	'bio.stackScale': '1',
	'bio.starterMines': '1',
	'bio.subterraneanGateRatio': '1',
	'bio.subterraneanNarrow': '0.6',
	'bio.subterraneanOpen': '0.57',
	'bio.teams': '1',
	'bio.townRatio': '0.1',
	'bio.undergroundStarts': '4',
	'bio.waterAccess': '2',
	'bio.waterBuildings': '1',
	'bio.waterContent': '1',
	'bio.waterCoverage': '0.45',
	'bio.waterShape': '3',
	'bio.waterTreasure': '1',
	'bio.zoneCap': '300',
	'bio.zoneCells': '400',
	'underground': '0',
};
const MED = Object.entries(OPTS).flatMap(([k, v]) => ['--' + k, v]);

for (const [name, args] of [
	['108x108 seed 7001', ['--w', '108', '--h', '108', '--seed', '7001']],
	['144x144 seed 7001', ['--w', '144', '--h', '144', '--seed', '7001']],
]) {
	test(`Mediterranean Coldshadow's Fantasy ${name}: every start walks to every land zone`, () => {
		const out = path.join(testTmp(), `vmapgen_reach_${process.pid}_${name.replace(/[^a-z0-9]/gi, '')}.vmap`);
		const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), ...MED, ...args, '--out', out],
			{ encoding: 'utf8', timeout: 300000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
		assert.strictEqual(r.status, 0, (r.stderr || '').slice(-800));
		try {
			const rows = reach(out);
			assert.ok(rows.length === 4, `${rows.length} start towns`);
			for (const s of rows) assert.deepStrictEqual(s.miss, [], `${s.owner} at (${s.at}) walks ${s.zones} of ${s.of} land zones`);
		} finally {
			for (const f of [out, out + '.zones.json']) try { fs.unlinkSync(f); } catch (e) { /* gone already */ }
		}
	});
}
