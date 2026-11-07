/**
 * start-ground.test.js - a start walks to the gate's floor of ground without entering a stack's 3x3 ring (MapGen Dev, 2026-10-14; the boxed-in edge starts of the
 * playable gate: 23 of 350 configurations on 7bebab0, w_mediterranean_108_s7001, r1_16_72p8uf). Floor: 8 tiles on a map up to 48 wide, 50 above.
 * Seeds found with .tmp\m1014\sg_seedhunt.js on the mod-free test install (seeds 1 to 40 of a 48x48 eight-player map: 8 box a start in without the pass).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');

const N8 = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 0], [-1, 1]];

function generate(args, tag, extraEnv = {}) {
	const out = path.join(testTmp(), `vmapgen_startground_${process.pid}_${tag}.vmap`);
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), ...args, '--out', out],
		{ encoding: 'utf8', timeout: 200000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv(extraEnv) });
	return { r, out };
}

// the tiles each owned start walks to from its town's door over open ground outside every monster's ring (the gate's rule, tools/harness/playable_gate.js)
function walks(file) {
	const sight = require('../tools/mapsight/lib/sight');
	const M = sight.load(file), WET = new Set(['wa', 'wt']), st = sight.starts(M);
	const ring = new Set();
	for (const m of M.monsters) for (const [dx, dy] of [[0, 0], ...N8]) if (M.inb(m.at[0] + dx, m.at[1] + dy)) ring.add(M.idx(m.l, m.at[0] + dx, m.at[1] + dy));
	const open = i => M.ground(i) && !WET.has(M.terr[i]) && !M.blocked[i] && !ring.has(i);
	const out = [];
	for (const t of M.objs.filter(o => o.cls === 'town' && st.some(s => s.l === o.l && Math.max(Math.abs(s.at[0] - o.at[0]), Math.abs(s.at[1] - o.at[1])) <= 1))) {
		const seen = new Set(), q = [];
		for (const i of M.approach(t)) if (open(i) && !seen.has(i)) { seen.add(i); q.push(i); }
		for (let h = 0; h < q.length; h++) {
			const c = q[h], x = c % M.W, y = Math.floor(c / M.W) % M.H;
			for (const [dx, dy] of N8) if (M.inb(x + dx, y + dy)) { const k = M.idx(t.l, x + dx, y + dy); if (open(k) && !seen.has(k)) { seen.add(k); q.push(k); } }
		}
		out.push({ at: t.at, tiles: seen.size });
	}
	return { W: M.W, out };
}

// 48x48, eight players: the least a start walks without the pass / with it: seed 8: 3 / 26, seed 12: 3 / 21, seed 20: 3 / 15, seed 30: 3 / 12
const SEEDS = [8, 12, 20, 30];
const args = seed => ['--w', '48', '--h', '48', '--players', '8', '--humans', '1', '--seed', String(seed)];

test('every start of a 48x48 eight-player map walks 8 tiles or more without a fight (seeds 8, 12, 20, 30)', () => {
	for (const seed of SEEDS) {
		const { r, out } = generate(args(seed), 'on' + seed);
		assert.strictEqual(r.status, 0, r.stderr.slice(-400));
		const { W, out: starts } = walks(out);
		const limit = W <= 48 ? 8 : 50;
		assert.strictEqual(starts.length, 8, JSON.stringify(starts));
		for (const s of starts) assert.ok(s.tiles >= limit, `seed ${seed}: start (${s.at}) walks ${s.tiles} tiles, floor ${limit}: ${JSON.stringify(starts)}`);
	}
});

// the start caps round (startPrimaryGuards' third round) moves guards off a start's near wood and ore and opens seed 20 by itself, so the old walk
// is the one with both passes off
// A count over seeds 1 to 16 since 2026-10-18 (the lead: never re-pin a lucky seed): the test shows the passes are needed, so without them some
// seeds must box a start in. Seed 30 stopped doing so with the building-pinch rule (its smallest walk 11 tiles) though the passes are as needed as
// before. Base: seeds 5, 6, 8, 12, 14 and 16 of the 16 box a start in without the passes, on 305b6a6 and with the rule alike (8 of 40 when the
// seeds were found). Bar: at least 2 of the 16.
// Rewritten 2026-11-07 (the suite's debt; the failure since the start-exit pass of 760c0c7, 0.3.27): seeds 1 to 16 with the three old passes off (walk, caps, warp guard) give
// smallest walks of 17 to 48 tiles and none boxes a start in: the start-exit pass (K, 2026-11-02, "it seems like there is only one way in and out of each start") and the later start
// rules keep them out of the box. With the start exit off too (VMAPGEN_START_EXIT=0) seed 14 boxes a start in again (3 tiles; .tmp\m1107\sg_scan.js). So the old walk is the one with
// all four off, and the bar is 1 of the 16 (it was 2: 8 of 40 seeds when the seeds were found); with the start exit on, the same seed 14 keeps its walk.
const OFF_SEEDS = Array.from({ length: 16 }, (_, i) => i + 1);
test('VMAPGEN_START_WALK=0, VMAPGEN_START_CAPS=0 and VMAPGEN_START_EXIT=0 give the old walk: without the passes at least 1 of seeds 1 to 16 boxes a start in, and with the start exit on it does not', { timeout: 900000 }, t => {
	const boxed = [];
	for (const seed of OFF_SEEDS) {
		// and the start warp guard off (biomes.js, 2026-10-16): it keeps some of these starts out of the box before the passes run (seed 12's
		// smallest walk 15 tiles with it), so the old walk needs it off too
		const { r, out } = generate(args(seed), 'off' + seed, { VMAPGEN_START_WALK: '0', VMAPGEN_START_CAPS: '0', VMAPGEN_START_WARP_GUARD: '0', VMAPGEN_START_EXIT: '0' });
		assert.strictEqual(r.status, 0, r.stderr.slice(-400));
		const { out: starts } = walks(out);
		if (starts.some(s => s.tiles < 8)) boxed.push(seed);
	}
	t.diagnostic(`seeds that box a start in without the passes: ${boxed.join(', ')}`);
	assert.ok(boxed.length >= 1, `seeds that box a start in without the passes: ${boxed.join(', ') || 'none'}, bar 1 of ${OFF_SEEDS.length}`);
	// the start exit alone keeps the box shut: the first seed that boxed, with only the three old passes off
	const { r, out } = generate(args(boxed[0]), 'exit' + boxed[0], { VMAPGEN_START_WALK: '0', VMAPGEN_START_CAPS: '0', VMAPGEN_START_WARP_GUARD: '0' });
	assert.strictEqual(r.status, 0, r.stderr.slice(-400));
	for (const st of walks(out).out) assert.ok(st.tiles >= 8, `seed ${boxed[0]} with the start exit on: start (${st.at}) walks ${st.tiles} tiles`);
});
