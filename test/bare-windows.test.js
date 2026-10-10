/**
 * bare-windows.test.js - open ground with no loot in it gets a pile (K, 2026-10-05, a zone with "mountain clumps and trees but almost
 * no loot"): on Coldshadow's Fantasy 108x108 one level, 8x8 windows that are at least half open ground and hold no loot, monster, mine,
 * dwelling or bank stay under 5% on one seed and the fill reports its piles (over 12 maps of a size the share fell from 3.2 to 3.7% to
 * 1.6%; the engine's own maps 0.7%).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');
const sight = require('../tools/mapsight/lib/sight');

const CONTENT = new Set(['monster', 'mine', 'low', 'high', 'dwelling', 'bank']);

test('loot-free 8x8 windows of open ground are given piles and stay under 5% on a Coldshadow map', { timeout: 280000 }, () => {
	const out = path.join(testTmp(), 'vmapgen_barewin.vmap');
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), '--out', out, '--declaremods', '0',
		'--template', "Coldshadow's Fantasy", '--w', '108', '--h', '108', '--players', '2', '--seed', '3',
		'--factions', 'random,random', '--accommodate', 'size,players,humans,underground'],
	{ encoding: 'utf8', timeout: 250000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	assert.ok(/loot-free stretches of ground given a pile: \d+/.test(r.stderr), 'the fill ran');
	const M = sight.load(out), W = M.W, H = M.H;
	const occ = new Uint8Array(W * H);
	for (const o of M.objs) if (o.l === 0 && CONTENT.has(o.cls)) for (const [x, y] of o.cells) if (x >= 0 && y >= 0 && x < W && y < H) occ[y * W + x] = 1;
	const isOpen = (x, y) => { const i = M.idx(0, x, y); return M.ground(i) && !M.blocked[i] && M.terr[i] !== 'wt' && M.terr[i] !== 'wa'; };
	let wins = 0, bare = 0;
	for (let y0 = 0; y0 + 8 <= H; y0 += 4) for (let x0 = 0; x0 + 8 <= W; x0 += 4) {
		let open = 0, c = 0;
		for (let y = y0; y < y0 + 8; y++) for (let x = x0; x < x0 + 8; x++) { if (isOpen(x, y)) open++; if (occ[y * W + x]) c++; }
		if (open < 32) continue;
		wins++;
		if (!c) bare++;
	}
	for (const f of [out, out + '.zones.json', out.replace(/\.vmap$/, '.zonedump.json')]) fs.rmSync(f, { force: true });
	assert.ok(wins > 100, `only ${wins} windows read`);
	assert.ok(bare / wins < 0.05, `${bare} of ${wins} windows hold no loot`);
});
