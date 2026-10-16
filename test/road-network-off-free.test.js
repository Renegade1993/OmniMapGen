/**
 * road-network-off-free.test.js - Build Road Network Off takes road away on a free layout too (the lead, 2026-10-14, from MapGen Dev's
 * lever test: Off kept 93% of the road on free layouts; seed 1 at 72x72 had more road with Off than with On, 328 tiles against 279,
 * because the portal and gate roads, the mines' and the bare towns' joins ignored Off outside a template). plan.js: roadsOff no longer
 * needs a template. Three 72x72 two-player free maps: on each, fewer road tiles with Off than with On.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');
const sight = require('../tools/mapsight/lib/sight');

const roads = (seed, on) => {
	const out = path.join(testTmp(), `vmapgen_roadoff_${seed}_${on}.vmap`);
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), '--out', out, '--declaremods', '0',
		'--w', '72', '--h', '72', '--players', '2', '--seed', String(seed), '--factions', 'random,random', '--bio.roadNetwork', on ? '1' : '0'],
	{ encoding: 'utf8', timeout: 150000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	const M = sight.load(out);
	let n = 0;
	for (let i = 0; i < M.road.length; i++) if (M.road[i]) n++;
	for (const f of [out, out + '.zones.json', out.replace(/\.vmap$/, '.zonedump.json')]) fs.rmSync(f, { force: true });
	return n;
};

test('free layout: Build Road Network Off has less road than On on each of three seeds', { timeout: 280000 }, () => {
	for (const seed of [1, 2, 3]) {
		const off = roads(seed, false), on = roads(seed, true);
		assert.ok(off < on, `seed ${seed}: ${off} road tiles with Off, ${on} with On`);
	}
});
