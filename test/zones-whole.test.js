/**
 * zones-whole.test.js - on a free layout every zone is one piece (4-connected) on each level, and no zone is left empty. One pass of zonesWhole
 * (biomes.js) could leave a fragment: 72x72 two levels four players seed 7003 kept two cells of zone 4 between zones 6 and 2, the only place zones
 * 2 and 4 met, so their one doorway opened on those two cells; the other 559 cells of zone 4 had no way in, 46 objects were dropped as
 * unreachable and mapsight read zone 4 as empty (0 of 569). zonesWhole now repeats until a pass moves nothing.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');
const { emptyZones } = require('../tools/mapsight/lib/check');
const sight = require('../tools/mapsight/lib/sight');

test('72x72 two levels four players seed 7003: every zone in one piece, none empty', () => {
	const out = path.join(testTmp(), `vmapgen_whole_${process.pid}.vmap`);
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), '--w', '72', '--h', '72', '--players', '4',
		'--underground', '1', '--seed', '7003', '--out', out], { encoding: 'utf8', timeout: 300000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	try {
		assert.strictEqual(r.status, 0, (r.stderr || '').slice(-800));
		const j = JSON.parse(fs.readFileSync(out + '.zones.json', 'utf8')), W = 72, H = 72;
		j.levels.forEach((L, l) => {
			const z = L.zone, seen = new Int32Array(W * H).fill(-1), pieces = new Map();
			for (let c0 = 0; c0 < W * H; c0++) {
				if (z[c0] < 0 || seen[c0] >= 0) continue;
				const q = [c0]; seen[c0] = c0;
				for (let h = 0; h < q.length; h++) {
					const c = q[h], x = c % W, y = (c / W) | 0;
					for (const [u, v] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]])
						if (u >= 0 && v >= 0 && u < W && v < H && seen[v * W + u] < 0 && z[v * W + u] === z[c0]) { seen[v * W + u] = c0; q.push(v * W + u); }
				}
				pieces.set(z[c0], (pieces.get(z[c0]) || 0) + 1);
			}
			for (const [k, n] of pieces) assert.strictEqual(n, 1, `level ${l} zone ${k} in ${n} pieces`);
		});
		assert.deepStrictEqual(emptyZones(sight.load(out)), []);
	} finally {
		for (const f of [out, out + '.zones.json']) try { fs.unlinkSync(f); } catch (e) { /* gone already */ }
	}
});
