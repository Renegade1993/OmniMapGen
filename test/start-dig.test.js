/**
 * start-dig.test.js - a free-layout map keeps every player's start in one walkable piece (K, 2026-10-10: 108x108 four players seed 670084743 with
 * Biome connections 0.35 and Portal share 0 came out as two pieces, red and tan against blue and green; the fill gave everything to one piece and
 * left the other's zones bare). The pocket pass digs a start shut in by zone borders out through them as a last resort and puts a guard on the hole.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');
const { blockingCells, visitableCells, REMOVABLE_TYPES } = require('../src/biome/content');

const generate = args => {
	const out = path.join(testTmp(), `vmapgen_dig_${process.pid}_${args.join('_').replace(/[^a-z0-9_.]/gi, '')}.vmap`);
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), ...args, '--out', out],
		{ encoding: 'utf8', timeout: 200000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	return { r, out };
};

// the pieces of land the owned towns' doors stand in (8-way, over ground no fixed object blocks; monsters and pickups step aside)
function townPieces(file) {
	const { readVmap } = require('../src/preview/render');
	const { objects, levels } = readVmap(file);
	const rows = levels[0].rows, H = rows.length, W = rows[0].length;
	const hard = new Uint8Array(W * H);
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const t = String(rows[y][x]).slice(0, 2); if (t === 'wt' || t === 'rc') hard[y * W + x] = 1; }
	const on0 = objects.filter(o => (o.l || 0) === 0 && o.template && o.template.mask);
	const cellsOf = (o, f) => f(o.template, o.x, o.y).filter(([x, y]) => x >= 0 && y >= 0 && x < W && y < H).map(([x, y]) => y * W + x);
	for (const o of on0) if (!REMOVABLE_TYPES.has(o.type)) for (const c of cellsOf(o, blockingCells)) hard[c] = 1;
	const piece = new Int32Array(W * H).fill(-1);
	let k = 0;
	const ids = new Set();
	for (const t of on0.filter(o => /^(town|randomTown)$/.test(o.type) && o.options && o.options.owner)) {
		const start = cellsOf(t, visitableCells).map(c => c + W).find(c => c < W * H && !hard[c]);
		if (start === undefined) { ids.add('shut ' + t.x + ',' + t.y); continue; }
		if (piece[start] < 0) {
			const stack = [start]; piece[start] = k;
			while (stack.length) {
				const c = stack.pop(), x = c % W, y = (c / W) | 0;
				for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
					const u = x + dx, v = y + dy;
					if ((!dx && !dy) || u < 0 || v < 0 || u >= W || v >= H) continue;
					const d = v * W + u;
					if (piece[d] < 0 && !hard[d]) { piece[d] = k; stack.push(d); }
				}
			}
			k++;
		}
		ids.add(piece[start]);
	}
	return ids.size;
}

const DIG_ARGS = seed => ['--w', '108', '--h', '108', '--players', '4', '--humans', '4', '--seed', seed,
	'--bio.interconnectivity', '0.35', '--bio.interconnectPortal', '0', '--bio.openPathNoRoad', '0.5', '--bio.openPathRoad', '0.5',
	'--bio.borderSolidity', '0.7', '--bio.compOnly', '0'];

// K's own seed: every start in one walkable piece (the rule, K 2026-10-10). Rewritten 2026-11-07 (the suite's debt): this seed no longer needs the border dig (the zone cut it
// drew changed with the generator), so its log no longer says "dug out through them", and that line was asserted here with the rule.
test('108x108, four players, Biome connections 0.35, no portals, seed 670084743: all four starts are in one walkable piece', { timeout: 300000 }, () => {
	const { r, out } = generate(DIG_ARGS('670084743'));
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	assert.strictEqual(townPieces(out), 1, 'red, blue, tan and green walk to each other');
	fs.rmSync(out, { force: true });
});

// The dig itself needs a map that shuts a start in. Of the twelve seeds 670084743 to 670084754 of these settings one does on the generator of 0.3.30, 670084753 (found by scanning
// the twelve, .tmp\m1107\dig_scan.js, 2026-11-07), so the dig's case is that seed: the start is dug out, the hole has a guard, and the four starts are in one piece.
test('108x108, four players, Biome connections 0.35, no portals, seed 670084753: a start shut in is dug out, the hole is guarded, and all four starts are in one piece', { timeout: 300000 }, () => {
	const { r, out } = generate(DIG_ARGS('670084753'));
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	assert.strictEqual(townPieces(out), 1, 'red, blue, tan and green walk to each other');
	assert.ok(/dug out through them/.test(r.stderr), 'this seed needs the border dig');
	assert.ok(/guard\(s\) on the holes dug through zone borders/.test(r.stderr), 'the hole it dug has a guard');
	fs.rmSync(out, { force: true });
});
