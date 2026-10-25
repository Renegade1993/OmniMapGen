/**
 * way-past-guard.test.js - a guard standing on a dear pile's approach tile counts as the pile's way in (a hero beats it and steps there), so
 * the pile's last free tile is closed instead of kept open for a flyer. closeApproaches would not close an object's last free approach tile,
 * and a guard's tile was not free: on K's small underground map seed 1750425234 two piles at (6,5) and (7,5) on level 1 kept a dead-end
 * tile below them open while their guard stood above, and 11 of 36 dear piles stood open. 36x36 two players two levels seed 4: 5 of 37
 * open before, 1 after.
 * A rate over seeds 1 to 8 since 2026-10-18 (the lead: never re-pin a lucky seed). One seed swings: seed 4 alone read 5.4% on 305b6a6 and
 * 13.6% with the building-pinch rule, while the eight seeds read 8.8% and 8.6% (23 of 261 and 23 of 268). Bar: under 12%.
 * Seeds 1 to 24 and a bar set from the noise since 2026-10-20 (the Opus Reviewer, pass 210: 12% sat inside eight seeds' noise, HEAD 11.1% and a tip
 * 12.4%, one pile apart). On the dmbpack-b15 install HEAD 0086185 opens 95 of 746 (12.7%) and opus-fg1020 7a277c1 86 of 760 (11.3%); one seed
 * reads 0% to 29%. With about 750 piles a binomial spread is 1.2 points: the bar is HEAD's rate and two spreads, 15%.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');
const { runChecks } = require('../tools/harness/playtest_checks');

const SEEDS = Array.from({ length: 24 }, (_, i) => i + 1);
const BAR = 0.15;

test('36x36 two players two levels, seeds 1 to 24: dear piles open under 15% (HEAD 12.7% on this install)', { timeout: 1800000 }, t => {
	let open = 0, piles = 0;
	for (const seed of SEEDS) {
		const out = path.join(testTmp(), `vmapgen_way_past_guard_${process.pid}_${seed}.vmap`);
		const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), '--w', '36', '--h', '36', '--players', '2',
			'--underground', '1', '--seed', String(seed), '--out', out], { encoding: 'utf8', timeout: 300000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
		try {
			assert.strictEqual(r.status, 0, (r.stderr || '').slice(-800));
			const a = runChecks(out, ['approach-open']).checks['approach-open'];
			open += Math.round(a.nums.piles * a.nums.nPiles); piles += a.nums.nPiles;
		} finally {
			for (const f of [out, out + '.zones.json']) try { fs.unlinkSync(f); } catch (e) { /* gone already */ }
		}
	}
	t.diagnostic(`dear piles open ${open} of ${piles} (${(100 * open / piles).toFixed(1)}%)`);
	assert.ok(piles >= 20 * SEEDS.length, `piles ${piles}`);
	assert.ok(open / piles < BAR, `dear piles open ${open} of ${piles} (${(100 * open / piles).toFixed(1)}%), bar ${100 * BAR}%`);
});
