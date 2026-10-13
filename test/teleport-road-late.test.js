/**
 * teleport-road-late.test.js - every subterranean gate and monolith has road on or beside its visiting tile when road can reach it
 * (mapsight teleportsOffRoad). The teleport road runs before the late passes (the shut entries opened, the late zone join, the town
 * fronts, the seal sweeps), which clear scenery and carve rock after it: a gate those passes opened the way to kept no road. The road
 * now runs to the gates and monoliths once more at the end. 72x72 four players two levels seed 12: the gate (49,23) on level 1.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');
const sight = require('../tools/mapsight/lib/sight');
const { teleportsOffRoad } = require('../tools/mapsight/lib/check');

test('72x72 four players two levels seed 12: no gate or monolith off the road', () => {
	const out = path.join(testTmp(), `vmapgen_teleport_late_${process.pid}.vmap`);
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), '--w', '72', '--h', '72', '--players', '4',
		'--underground', '1', '--seed', '12', '--out', out], { encoding: 'utf8', timeout: 300000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	try {
		assert.strictEqual(r.status, 0, (r.stderr || '').slice(-800));
		assert.deepStrictEqual(teleportsOffRoad(sight.load(out)).map(o => `${o.type} (${o.at}) L${o.l}`), []);
	} finally {
		for (const f of [out, out + '.zones.json']) try { fs.unlinkSync(f); } catch (e) { /* gone already */ }
	}
});
