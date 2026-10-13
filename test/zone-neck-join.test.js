/**
 * zone-neck-join.test.js - a zone pinched to a neck two or three tiles wide between zones it has no doorway to keeps its far lobe joined, and
 * no zone whose doorway opens there is swept empty. K's settings (his 108x108 four players map of October 10th, no paths, no mods) at seed 7004:
 * zone 0's lobe held the doorways of zones 10 and 15; joinZoneWaysIn would not clear scenery on a line with a zone not linked to zone 0, the
 * lobe stayed shut, and 35 objects (zone 10's neutral town among them) were dropped as unreachable. The join now crosses such a line as a
 * last resort (guardZoneJoins guards any step it opens).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');

const OPTS = {
	'w': '108',
	'h': '108',
	'players': '4',
	'humans': '4',
	'factions': 'random,random,random,random',
	'bio.compOnly': '0',
	'humancolors': 'red',
	'declaremods': '0',
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
	'bio.waterContent': '0',
	'bio.waterCoverage': '0',
	'bio.waterShape': '8',
	'bio.waterTreasure': '1',
	'bio.zoneCap': '300',
	'bio.zoneCells': '400',
};

test('K settings 108x108 seed 7004: every zone way in joined, no object dropped as unreachable', () => {
	const out = path.join(testTmp(), `vmapgen_neck_${process.pid}.vmap`);
	const args = [...Object.entries(OPTS).flatMap(([k, v]) => ['--' + k, v]), '--seed', '7004', '--out', out];
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), ...args],
		{ encoding: 'utf8', timeout: 300000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	try {
		assert.strictEqual(r.status, 0, (r.stderr || '').slice(-800));
		const log = (r.stdout || '') + (r.stderr || '');
		const joins = log.split(/\r?\n/).filter(s => /ways into zones joined to their zone/.test(s));
		assert.ok(joins.length, 'no join line');
		for (const s of joins) assert.match(s, /, 0 left/);
		assert.doesNotMatch(log, /nothing could reach/);
	} finally {
		for (const f of [out, out + '.zones.json']) try { fs.unlinkSync(f); } catch (e) { /* gone already */ }
	}
});
