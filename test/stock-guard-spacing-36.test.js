/**
 * stock-guard-spacing-36.test.js - the stock guard rule on the tightest maps: 36x36, eight players, two levels. Stock places no stack beside
 * another (0 touching pairs of 15,920 stacks on its 98 VCMI 1.7.5 engine maps). The Opus Reviewer's case of 2026-11-01
 * (roster\REVIEW-1101-stock-guards.md, seeds 41 to 43 of K's settings): 5 touching pairs of 119 stacks, two of them zone-join guards on either
 * side of one zone line, one a gold mine's fallback guard beside a pile guard. One guard per border and the 2-clear rule took them to 0.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');
const sight = require('../tools/mapsight/lib/sight');

const SEEDS = [41, 42, 43, 44, 45, 46];

test('36x36 eight players two levels, seeds 41 to 46: no stack beside another (stock: 0 of 15,920)', { timeout: 1800000 }, t => {
	let stacks = 0, touching = 0;
	const where = [];
	for (const seed of SEEDS) {
		const out = path.join(testTmp(), `vmapgen_stock_spacing_${process.pid}_${seed}.vmap`);
		const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), '--w', '36', '--h', '36', '--players', '8',
			'--underground', '1', '--seed', String(seed), '--out', out], { encoding: 'utf8', timeout: 300000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
		try {
			assert.strictEqual(r.status, 0, (r.stderr || '').slice(-800));
			const M = sight.load(out);
			stacks += M.monsters.length;
			for (const m of M.monsters) for (const n of M.monsters)
				if (m !== n && m.l === n.l && Math.max(Math.abs(m.at[0] - n.at[0]), Math.abs(m.at[1] - n.at[1])) <= 1) { touching++; where.push(`s${seed} L${m.l} (${m.at})`); }
		} finally {
			for (const f of [out, out + '.zones.json']) try { fs.unlinkSync(f); } catch (e) { /* gone already */ }
		}
	}
	touching /= 2;
	t.diagnostic(`stacks ${stacks}, touching pairs ${touching}${where.length ? ': ' + where.join(' ') : ''}`);
	assert.ok(stacks >= 100, `stacks ${stacks}`);
	assert.ok(touching <= 1, `${touching} touching pairs of ${stacks} stacks: ${where.join(' ')}`);
});
