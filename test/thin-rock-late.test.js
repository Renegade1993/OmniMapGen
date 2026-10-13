/**
 * thin-rock-late.test.js - no rock on the underground is left outside every 2x2 block of rock: such an arm has no floor edge drawn round
 * it and shows as black squares (K, 2026-10-12, his small Coldshadow seed 876637007: "black squares in front of the stronghold castle",
 * "all labelled as rock"). thinRockToFloor ran before the passes that open rock later (a town's front tile, the zone joins); it runs once
 * more at the end. 72x72 four players two levels seed 1: five such cells before.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');
const sight = require('../tools/mapsight/lib/sight');

test('72x72 four players two levels seed 1: no underground rock one tile wide', () => {
	const out = path.join(testTmp(), `vmapgen_thin_rock_${process.pid}.vmap`);
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), '--w', '72', '--h', '72', '--players', '4',
		'--underground', '1', '--seed', '1', '--out', out], { encoding: 'utf8', timeout: 300000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	try {
		assert.strictEqual(r.status, 0, (r.stderr || '').slice(-800));
		const M = sight.load(out), W = M.W, H = M.H, thin = [];
		for (let l = 1; l < M.NL; l++) {
			const rock = (x, y) => x < 0 || y < 0 || x >= W || y >= H || !M.ground(M.idx(l, x, y));
			for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
				if (!rock(x, y)) continue;
				const inBlock = [[0, 0], [-1, 0], [0, -1], [-1, -1]].some(([ox, oy]) => rock(x + ox, y + oy) && rock(x + ox + 1, y + oy) && rock(x + ox, y + oy + 1) && rock(x + ox + 1, y + oy + 1));
				if (!inBlock) thin.push(`L${l} (${x},${y})`);
			}
		}
		assert.deepStrictEqual(thin, []);
	} finally {
		for (const f of [out, out + '.zones.json']) try { fs.unlinkSync(f); } catch (e) { /* gone already */ }
	}
});
