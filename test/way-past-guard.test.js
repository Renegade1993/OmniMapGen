/**
 * way-past-guard.test.js - a guard standing on a dear pile's approach tile counts as the pile's way in (a hero beats it and steps there), so
 * the pile's last free tile is closed instead of kept open for a flyer. closeApproaches would not close an object's last free approach tile,
 * and a guard's tile was not free: on K's small underground map seed 1750425234 two piles at (6,5) and (7,5) on level 1 kept a dead-end
 * tile below them open while their guard stood above, and 11 of 36 dear piles stood open. 36x36 two players two levels seed 4: 5 of 37
 * open before, 1 after.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');
const { runChecks } = require('../tools/harness/playtest_checks');

test('36x36 two players two levels seed 4: dear piles open under 6%', () => {
	const out = path.join(testTmp(), `vmapgen_way_past_guard_${process.pid}.vmap`);
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), '--w', '36', '--h', '36', '--players', '2',
		'--underground', '1', '--seed', '4', '--out', out], { encoding: 'utf8', timeout: 300000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	try {
		assert.strictEqual(r.status, 0, (r.stderr || '').slice(-800));
		const a = runChecks(out, ['approach-open']).checks['approach-open'];
		assert.ok(a.nums.nPiles >= 20, `piles ${a.nums.nPiles}`);
		assert.ok(a.nums.piles < 0.06, a.value);
	} finally {
		for (const f of [out, out + '.zones.json']) try { fs.unlinkSync(f); } catch (e) { /* gone already */ }
	}
});
