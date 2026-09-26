/**
 * levels.test.js
 *
 * Pins the way down on a two-level map. A subterranean gate needs its
 * footprint free at the same x,y on both levels; fuzz seed 41 case 12
 * (72x72, seven players, template 7SB0c, water, the tab's levers below) left
 * no such cell anywhere, and the map shipped with its whole underground
 * unreachable. Monolith pairs now stand in when no gate fits.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { genEnv, testTmp } = require('./_vcmi');

const LEVERS = { zoneCells: 1000, zoneCap: 28, highLootRatio: 0, townRatio: 0.05, lowLootRatio: 0,
	biomeWobble: 1.45, borderSolidity: 1, interconnectivity: 0.3, interconnectPortal: 0,
	openPathNoRoad: 0.05, openPathRoad: 0, roadNetwork: 0, artifactDensity: 0.001,
	artifactRichness: 0.75, pickupDensity: 2.6, resourceDensity: 2.6, mineDensity: 1.8,
	starterMines: 1, dwellingDensity: 2, bonusDensity: 0, monsterStrength: -1, stackScale: 1.25,
	guardDensity: 0.2, objectGuardShare: 0.55, guardTreasure: 0, guardMines: 0, guardDwellings: 0,
	guardBottlenecks: 0, chokeGuardRatio: 0.4, guardPortals: 1, lootGuardWeight: 0,
	mineGuardWeight: 3.6, subterraneanGateRatio: 0, subterraneanNarrow: 0.45, subterraneanOpen: 0.5,
	decorDensity: 2, waterCoverage: 0.25, waterShape: 6, waterAccess: 2, waterTreasure: 0.5 };

test('a two-level map where no gate fits still links the underground (fuzz seed 41 case 12)', { timeout: 240000 }, () => {
	const { spawnSync } = require('child_process');
	const fs = require('fs');
	const out = path.join(testTmp(), 'vmapgen_levels_nogate.vmap');
	const args = [path.join(__dirname, '../src/main/generate-cli.js'),
		'--w', '72', '--h', '72', '--players', '7', '--humans', '7', '--seed', '44093', '--out', out,
		'--underground', '1', '--template', '7SB0c', '--preset', 'nostalgia', '--rivers', '0'];
	for (const [k, v] of Object.entries(LEVERS)) args.push('--bio.' + k, String(v));
	const r = spawnSync(process.execPath, args,
		{ encoding: 'utf8', timeout: 200000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	assert.doesNotMatch(r.stderr, /underground level is unreachable/);
	const { readVmap } = require('../src/preview/render');
	const { objects } = readVmap(out);
	const down = objects.filter(o => (o.l || 0) === 1
		&& (o.type === 'subterraneanGate' || o.type === 'monolithTwoWay'));
	// a monolith below counts only if its channel also opens on the surface
	const upChannels = new Set(objects.filter(o => (o.l || 0) === 0 && o.type === 'monolithTwoWay')
		.map(o => o.subtype));
	assert.ok(down.some(o => o.type === 'subterraneanGate' || upChannels.has(o.subtype)),
		'nothing on the surface leads down');
	fs.rmSync(out, { force: true });
});
