/**
 * road-visit-corner.test.js - no road step that touches at a corner only has an end on a building's visiting tile (a mine's, a bank's; towns,
 * gates and monoliths keep the road their own passes run onto that tile). The game draws both tiles of such a step as dead ends, so the road
 * shows a gap at the entrance (K's road map seed 670084743: the mine at (103,100) beside a town's road). closeDiagonalSteps (gateroad.js)
 * takes the road off the visiting tile when no side of it touches road and the road beside it stays one piece. 108x108 four players: seeds 2
 * and 8 had one each.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');
const sight = require('../tools/mapsight/lib/sight');

for (const seed of [2, 8]) {
	test(`108x108 four players seed ${seed}: no corner-only road step on a building's visiting tile`, () => {
		const out = path.join(testTmp(), `vmapgen_visit_corner_${process.pid}_${seed}.vmap`);
		const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), '--w', '108', '--h', '108', '--players', '4',
			'--seed', String(seed), '--out', out], { encoding: 'utf8', timeout: 300000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
		try {
			assert.strictEqual(r.status, 0, (r.stderr || '').slice(-800));
			const M = sight.load(out), W = M.W, H = M.H, visAt = new Map(), hits = [];
			for (const o of M.objs)
				if (o.visitable && !o.pickup && !/^(monster|randomMonster|town|randomTown|subterraneanGate|monolith)/.test(o.type)) visAt.set(M.idx(o.l, o.at[0], o.at[1]), o.type);
			const has = (l, x, y) => x >= 0 && y >= 0 && x < W && y < H && M.road[M.idx(l, x, y)];
			for (let l = 0; l < M.NL; l++) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
				if (!has(l, x, y)) continue;
				for (const [dx, dy] of [[1, 1], [1, -1]])
					if (has(l, x + dx, y + dy) && !has(l, x + dx, y) && !has(l, x, y + dy)) {
						const v = visAt.get(M.idx(l, x, y)) || visAt.get(M.idx(l, x + dx, y + dy));
						if (v) hits.push(`${v} L${l} (${x},${y})-(${x + dx},${y + dy})`);
					}
			}
			assert.deepStrictEqual(hits, []);
		} finally {
			for (const f of [out, out + '.zones.json']) try { fs.unlinkSync(f); } catch (e) { /* gone already */ }
		}
	});
}
