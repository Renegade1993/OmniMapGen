/**
 * start-own-ground.test.js - on a free layout every start's cell is its own zone's, and no start has a town of its zone behind a guard. The
 * domain warp in partitionBiomes moved where a cell is measured from by up to a third of the zone spacing, so a start's cell could fall to a
 * neighbour: 36x36 eight players seed 901 put red's (4,4) and orange's gate (2,18) in high-loot zone 9, and mapsight read both towns as behind a
 * guard (the Opus Reviewer's R26, 2026-10-09); seed 1911 put two starts' cells in zones 9 and 8. plan.js gives the town's footprint and the
 * ground before its gate to the start's own zone before the walls are drawn.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');
const { checkMap } = require('../tools/mapsight/lib/check');

for (const seed of [901, 1911]) {
	test(`36x36 eight players seed ${seed}: every start stands in its own zone, no own town behind a guard`, () => {
		const out = path.join(testTmp(), `vmapgen_own_ground_${process.pid}_${seed}.vmap`);
		const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), '--w', '36', '--h', '36', '--players', '8',
			'--seed', String(seed), '--out', out], { encoding: 'utf8', timeout: 300000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
		assert.strictEqual(r.status, 0, (r.stderr || '').slice(-800));
		try {
			const j = JSON.parse(fs.readFileSync(out + '.zones.json', 'utf8'));
			j.levels.forEach((L, l) => (L.starts || []).forEach((s, i) =>
				assert.strictEqual(L.zone[s.y * 36 + s.x], i, `level ${l} start ${i} at (${s.x},${s.y})`)));
			const fails = checkMap(out).fails.filter(f => /own town behind a guard/.test(f));
			assert.deepStrictEqual(fails, []);
		} finally {
			for (const f of [out, out + '.zones.json']) try { fs.unlinkSync(f); } catch (e) { /* gone already */ }
		}
	});
}
