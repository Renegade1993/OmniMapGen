/**
 * road-network-off-free.test.js - Build Road Network Off means no roads at all and changes nothing else (K, 2026-11-05: "roads being off
 * should mean no visual roads and no road bonuses"; the Opus Reviewer, 2026-11-06, REVIEW-1106-roadoff.md: the plan still ran the old smaller
 * network, 2,669 of 2,863 objects moved on Classic 108 seed 41, so Off is the plan of On with the road type 'none', as stock's three road
 * toggles all off give). Three 72x72 two-player free maps: Off has no road tile, On has road, and the two maps hold the same objects.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');
const sight = require('../tools/mapsight/lib/sight');

const gen = (seed, on) => {
	const out = path.join(testTmp(), `vmapgen_roadoff_${seed}_${on}.vmap`);
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), '--out', out, '--declaremods', '0',
		'--w', '72', '--h', '72', '--players', '2', '--seed', String(seed), '--factions', 'random,random', '--bio.roadNetwork', on ? '1' : '0'],
	{ encoding: 'utf8', timeout: 150000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	const M = sight.load(out);
	let roads = 0;
	for (let i = 0; i < M.road.length; i++) if (M.road[i]) roads++;
	const objects = M.objs.map(o => `${o.l || 0},${o.type},${o.subtype || ''},${o.x},${o.y}`).sort().join(';');
	for (const f of [out, out + '.zones.json', out.replace(/\.vmap$/, '.zonedump.json')]) fs.rmSync(f, { force: true });
	return { roads, objects, count: M.objs.length };
};

test('free layout: Build Road Network Off has no road tile and the same objects as On, on each of three seeds', { timeout: 280000 }, () => {
	for (const seed of [1, 2, 3]) {
		const off = gen(seed, false), on = gen(seed, true);
		assert.strictEqual(off.roads, 0, `seed ${seed}: ${off.roads} road tiles with Off`);
		assert.ok(on.roads > 0, `seed ${seed}: ${on.roads} road tiles with On`);
		assert.strictEqual(off.count, on.count, `seed ${seed}: ${off.count} objects with Off, ${on.count} with On`);
		assert.strictEqual(off.objects, on.objects, `seed ${seed}: Off and On stand objects on different tiles`);
	}
});
