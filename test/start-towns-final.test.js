/**
 * start-towns-final.test.js - every start zone holds the same number of towns once the fill is done (K, 2026-10-06 14:57, his 36x36 two-level
 * Coldshadow's Fantasy: red 2 towns, blue 1). The plan's own parity counted town spots; a town the fill then found no room for broke it again.
 * Six of ten small seeds read 1 against 2 before the final pass; none after.
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

function townsPerStart(seed) {
	const out = path.join(testTmp(), `vmapgen_start_towns_${seed}.vmap`);
	const a = [path.join(__dirname, '../src/main/generate-cli.js'), '--out', out, '--declaremods', '0', '--template', "Coldshadow's Fantasy",
		'--w', '36', '--h', '36', '--underground', '1', '--players', '2', '--seed', String(seed), '--factions', 'random,random',
		'--accommodate', 'size,players,humans,underground'];
	const r = spawnSync(process.execPath, a, { encoding: 'utf8', timeout: 200000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	const res = CHECKS['towns-per-start'](sight.load(out));
	for (const f of [out, out + '.zones.json', out.replace(/\.vmap$/, '.zonedump.json')]) fs.rmSync(f, { force: true });
	return res;
}

test("36x36 two levels, two players, Coldshadow's Fantasy: both start zones hold the same number of towns (seeds 2 and 4 read 1 against 2 before)", { timeout: 400000 }, () => {
	for (const seed of [2, 4]) {
		const r = townsPerStart(seed);
		assert.strictEqual(r.pass, true, `seed ${seed}: ${r.value} ${(r.items || []).join('; ')}`);
	}
});
