// Pickups another object's picture hides half or more of, as a rate (tools/harness/overlap_scan.js; the lead, 2026-10-18: "add the
// pickup-hidden gate to the suite as a rate"). The engine's own maps hide 4% to 11% of their pickups that way; K's three open maps hid 5.6% to
// 6.7% before declipPictures and the written zIndex, 2.0% to 3.8% after. Each sprite is read from the suite's install, so a run whose sprites cannot be read skips.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');

// bar 4%: with the pass 68 of 2453 (2.77%), without it (VMAPGEN_DECLIP_ART=0) 193 (7.87%); the engine's own maps 4% to 11%
const BAR = Number(process.env.VMAPGEN_HIDDEN_BAR || 0.04);

test('72x72 four players, seeds 1 to 8: pickups half hidden under another object\'s picture at most 4%', { timeout: 900000 }, t => {
	const env = genEnv();
	const before = { VCMI_ROOT: process.env.VCMI_ROOT, VCMI_USER_DIR: process.env.VCMI_USER_DIR };
	process.env.VCMI_ROOT = env.VCMI_ROOT;
	if (env.VCMI_USER_DIR) process.env.VCMI_USER_DIR = env.VCMI_USER_DIR; else delete process.env.VCMI_USER_DIR;
	const { CHECKS } = require('../tools/harness/k1018_checks');
	const sight = require('../tools/mapsight/lib/sight');
	let hidden = 0, pickups = 0, read = 0;
	const where = [];
	try {
		for (let seed = 1; seed <= 8; seed++) {
			const out = path.join(testTmp(), `vmapgen_hidden_${process.pid}_${seed}.vmap`);
			const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), '--w', '72', '--h', '72', '--players', '4',
				'--seed', String(seed), '--out', out], { encoding: 'utf8', timeout: 300000, cwd: path.join(__dirname, '..'), windowsHide: true, env });
			try {
				assert.strictEqual(r.status, 0, (r.stderr || '').slice(-800));
				const c = CHECKS['pickup-hidden'](sight.load(out));
				if (c.skipped) continue;
				read++;
				hidden += c.nums.hidden; pickups += c.nums.pickups;
				if (c.nums.hidden) where.push(`seed ${seed}: ${c.items.slice(0, 3).join('; ')}`);
			} finally {
				for (const f of [out, out + '.zones.json']) try { fs.unlinkSync(f); } catch (e) { /* gone already */ }
			}
		}
	} finally {
		for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
	}
	if (!read) { t.skip('no sprite read from the suite install'); return; }
	t.diagnostic(`pickups half hidden ${hidden} of ${pickups} (${(100 * hidden / Math.max(1, pickups)).toFixed(2)}%) on ${read} maps`);
	assert.ok(hidden <= BAR * pickups, `${hidden} of ${pickups} half hidden, bar ${BAR}: ${where.join(' | ')}`);
});
