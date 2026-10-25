/**
 * start-walk-fair.test.js - two seats of a 144x144 two-level open-layout map walk within 2.2 of each other without a fight (the start-walk-
 * fairness ticket's limit: the engine's own two-start maps reach 2.12), where the late start-ground pass (plan.js startGroundCells) holds a
 * floor of 0.3 of the start zone's open ground and half the best start's ring-free walk, and drops a stuck stack over the start's road beside
 * dear pickups, a bank or nothing. Panel N cases (bf90d6a's ratios 8.53, 3.30, 2.24; 66413a5's 8.94, 8.74, 11.12): tb144x2 s7402 (default
 * sliders, one start on each level), no144x2 s8307 and s8312 (the Nostalgia entry's sliders). Opus Map Vision 2026-10-21.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');

const N8 = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 0], [-1, 1]];
const NOS = ['--bio.zoneCells', '1500', '--bio.interconnectPortal', '0.8', '--bio.guardDensity', '0.5', '--bio.highLootRatio', '0.1', '--bio.artifactDensity', '0.003',
	'--bio.dwellingDensity', '1.2', '--bio.guardGradient', '1'];
const CASES = [['tb144x2 s7402', '7402', []], ['no144x2 s8307', '8307', NOS], ['no144x2 s8312', '8312', NOS]];

// each owned start's ring-free walk, as start-ground.test.js and the playable gate read it; the ratio of the larger to the smaller
function ratio(seed, extra, tag, env = {}) {
	const out = path.join(testTmp(), `vmapgen_walkfair_${process.pid}_${tag}.vmap`);
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), '--w', '144', '--h', '144', '--players', '2', '--humans', '1',
		'--seed', seed, '--underground', '1', ...extra, '--out', out], { encoding: 'utf8', timeout: 400000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv(env) });
	assert.strictEqual(r.status, 0, (r.stderr || '').slice(-400));
	const sight = require('../tools/mapsight/lib/sight');
	const M = sight.load(out), WET = new Set(['wa', 'wt']), st = sight.starts(M), ring = new Set();
	for (const m of M.monsters) for (const [dx, dy] of [[0, 0], ...N8]) if (M.inb(m.at[0] + dx, m.at[1] + dy)) ring.add(M.idx(m.l, m.at[0] + dx, m.at[1] + dy));
	const open = i => M.ground(i) && !WET.has(M.terr[i]) && !M.blocked[i] && !ring.has(i);
	const walks = [];
	for (const t of M.objs.filter(o => o.cls === 'town' && st.some(s => s.l === o.l && Math.max(Math.abs(s.at[0] - o.at[0]), Math.abs(s.at[1] - o.at[1])) <= 1))) {
		const seen = new Set(), q = [];
		for (const i of M.approach(t)) if (open(i) && !seen.has(i)) { seen.add(i); q.push(i); }
		for (let h = 0; h < q.length; h++) {
			const c = q[h], x = c % M.W, y = Math.floor(c / M.W) % M.H;
			for (const [dx, dy] of N8) if (M.inb(x + dx, y + dy)) { const k = M.idx(t.l, x + dx, y + dy); if (open(k) && !seen.has(k)) { seen.add(k); q.push(k); } }
		}
		walks.push(seen.size);
	}
	fs.rmSync(out, { force: true }); fs.rmSync(out + '.zones.json', { force: true });
	assert.strictEqual(walks.length, 2, `two starts: ${walks}`);
	return { walks, ratio: Math.max(...walks) / Math.max(1, Math.min(...walks)) };
}

for (const [name, seed, extra] of CASES)
	test(`144x144 two levels, two players, ${name}: the two seats walk within 2.2 of each other without a fight`, { timeout: 900000 }, () => {
		const r = ratio(seed, extra, 'on' + seed);
		assert.ok(r.ratio <= 2.2, `walks ${r.walks}, ratio ${r.ratio.toFixed(2)}`);
	});

test('the same three cases with the floor, the peer floor and the road drops off: at least one seat pair is over 2.2 (the passes are needed)', { timeout: 1800000 }, () => {
	const off = { VMAPGEN_START_FLOOR: '0', VMAPGEN_START_PEER: '0', VMAPGEN_START_WALK_DEAR: '0', VMAPGEN_START_DAY7: '0' };
	const rs = CASES.map(([, seed, extra]) => ratio(seed, extra, 'off' + seed, off));
	assert.ok(rs.some(r => r.ratio > 2.2), JSON.stringify(rs));
});

// The day-7 passes (VMAPGEN_START_DAY7) act only on a map whose starts are beyond 2.2 by the walk by day 7: tb144x2 s7407 in the test
// install reads 450/675 (1.50) and comes out the same object for object with them off (the lead, 2026-10-22: maps already within the
// ratio untouched)
test('tb144x2 s7407, within 2.2: the same objects with the day-7 passes on and off', { timeout: 900000 }, () => {
	const objs = env => {
		const out = path.join(testTmp(), `vmapgen_walkfair_${process.pid}_d7${env.VMAPGEN_START_DAY7 || 'on'}.vmap`);
		const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), '--w', '144', '--h', '144', '--players', '2', '--humans', '1',
			'--seed', '7407', '--underground', '1', '--out', out], { encoding: 'utf8', timeout: 400000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv(env) });
		assert.strictEqual(r.status, 0, (r.stderr || '').slice(-400));
		const M = require('../tools/mapsight/lib/sight').load(out);
		fs.rmSync(out, { force: true }); fs.rmSync(out + '.zones.json', { force: true });
		return M.objs.map(o => `${o.cls}:${o.type}@${o.l},${o.at[0]},${o.at[1]}`).sort();
	};
	assert.deepStrictEqual(objs({}), objs({ VMAPGEN_START_DAY7: '0' }));
});
