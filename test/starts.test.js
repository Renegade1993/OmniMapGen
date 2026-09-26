/**
 * starts.test.js
 *
 * Pins two ways a start went short on 2026-09-24:
 *   - a start zone whose open borders all drew portals boxed its player
 *     into a handful of cells with monoliths as the only way out (36x36,
 *     8 players, seed 2: orange walked 35 cells); every start zone now keeps
 *     a land border, so every start walks out of its zone on foot
 *   - start balancing guarded the wrong ground: one connectivity guard,
 *     seeded at the first start's town anchor (a blocked tile), fell back to
 *     the largest open region, and on an island map every start elsewhere
 *     drew all its candidate cells and placed nothing (72x72 Islands, 4
 *     players, seed 1: red and green stayed below the balancing target);
 *     each start now gets a guard seeded beside its own gate
 *   - balancing measured a start from the town's two top corners, because
 *     the gate is a blocked tile in its grid: with the ground above a town
 *     walled off it measured from a pocket behind the town and placed
 *     nothing (36x36, 8 players, seed 2: red and orange); the walk now
 *     starts from the gate too, as vmap_startparity.js reads it
 *   - starter mines went wherever a random ring first fitted, up to 14 cells
 *     out: behind the town or across a wall, 30-38 steps away on foot, and
 *     one against the map edge cut off the ground in front of its own
 *     entrance and was dropped (72x72, 4 players, seed 5: red had no ore
 *     pit); they are now ranked by the walk from the gate, with the mine's
 *     own cells blocked, and the seal pass may not take them out
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');
const { blockingCells, visitableCells, REMOVABLE_TYPES } = require('../src/biome/content');
const { WATER_SHAPES } = require('../src/biome/water');

const generate = (args, env = {}) => {
	const out = path.join(testTmp(), `vmapgen_starts_${process.pid}_${args.join('_').replace(/[^a-z0-9_.]/gi, '')}.vmap`);
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), ...args, '--out', out],
		{ encoding: 'utf8', timeout: 200000, cwd: path.join(__dirname, '..'), windowsHide: true,
			env: genEnv(env) });
	return { r, out };
};

// Cells each player's hero reaches on foot from its town gate: 8-way over
// land no fixed object blocks (monsters and pickups step aside), no boat, no
// portal.
function footReach(file) {
	const { readVmap } = require('../src/preview/render');
	const { objects, levels } = readVmap(file);
	const rows = levels[0].rows, H = rows.length, W = rows[0].length;
	const hard = new Uint8Array(W * H);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const t = String(rows[y][x]).slice(0, 2);
			if (t === 'wt' || t === 'rc') hard[y * W + x] = 1;
		}
	const on0 = objects.filter(o => (o.l || 0) === 0 && o.template && o.template.mask);
	const cellsOf = (o, f) => f(o.template, o.x, o.y).filter(([x, y]) => x >= 0 && y >= 0 && x < W && y < H).map(([x, y]) => y * W + x);
	for (const o of on0) if (!REMOVABLE_TYPES.has(o.type)) for (const c of cellsOf(o, blockingCells)) hard[c] = 1;
	const out = {};
	for (const t of on0.filter(o => o.type === 'randomTown' && o.options && o.options.owner)) {
		const seen = new Uint8Array(W * H);
		const stack = cellsOf(t, visitableCells).map(c => c + W).filter(c => c < W * H && !hard[c]);
		for (const c of stack) seen[c] = 1;
		let n = stack.length;
		while (stack.length) {
			const c = stack.pop(), x = c % W, y = (c / W) | 0;
			for (let dy = -1; dy <= 1; dy++)
				for (let dx = -1; dx <= 1; dx++) {
					const u = x + dx, v = y + dy;
					if ((!dx && !dy) || u < 0 || v < 0 || u >= W || v >= H) continue;
					const d = v * W + u;
					if (!seen[d] && !hard[d]) { seen[d] = 1; stack.push(d); n++; }
				}
		}
		out[t.options.owner] = n;
	}
	return out;
}

// every start balancing found short ends at or above its target
const toppedUp = stderr => {
	const lines = stderr.split('\n').filter(l => l.startsWith('[parity] '));
	assert.ok(lines.length > 0, 'some start was below target, so balancing ran');
	for (const l of lines) {
		const m = l.match(/^\[parity\] (\w+): value=(\d+) target=(\d+)/);
		assert.ok(m, l);
		assert.ok(+m[2] >= +m[3], `${m[1]} topped up to ${m[2]} of ${m[3]}`);
	}
};

test('36x36, 8 players, seed 2: every start walks out of its zone and is topped up', { timeout: 240000 }, () => {
	const { r, out } = generate(['--w', '36', '--h', '36', '--players', '8', '--seed', '2'],
		{ VMAPGEN_PARITY_DEBUG: '1' });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	const reach = footReach(out);
	assert.strictEqual(Object.keys(reach).length, 8);
	for (const [color, n] of Object.entries(reach))
		assert.ok(n >= 100, `${color} walks ${n} cells`);
	toppedUp(r.stderr);
	fs.rmSync(out, { force: true });
});

test('Islands 72x72, 4 players, seed 1: balancing lifts every start to its target', { timeout: 240000 }, () => {
	const shape = WATER_SHAPES.findIndex(s => s.id === 'islands');
	const { r, out } = generate(['--w', '72', '--h', '72', '--players', '4', '--seed', '1',
		'--bio.waterCoverage', '0.35', '--bio.waterShape', String(shape)], { VMAPGEN_PARITY_DEBUG: '1' });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	toppedUp(r.stderr);
	fs.rmSync(out, { force: true });
});

test('72x72, 4 players, seed 5: every start walks to a sawmill and an ore pit of its own', { timeout: 240000 }, () => {
	const { r, out } = generate(['--w', '72', '--h', '72', '--players', '4', '--seed', '5']);
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	const { readVmap } = require('../src/preview/render');
	const { objects, levels } = readVmap(out);
	const rows = levels[0].rows, H = rows.length, W = rows[0].length;
	const hard = new Uint8Array(W * H);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const t2 = String(rows[y][x]).slice(0, 2);
			if (t2 === 'wt' || t2 === 'rc') hard[y * W + x] = 1;
		}
	const on0 = objects.filter(o => (o.l || 0) === 0 && o.template && o.template.mask);
	const cellsOf = (o, f) => f(o.template, o.x, o.y).filter(([x, y]) => x >= 0 && y >= 0 && x < W && y < H).map(([x, y]) => y * W + x);
	for (const o of on0) if (!REMOVABLE_TYPES.has(o.type)) for (const c of cellsOf(o, blockingCells)) hard[c] = 1;
	for (const t2 of on0.filter(o => o.type === 'randomTown' && o.options && o.options.owner)) {
		const dist = new Int32Array(W * H).fill(-1);
		const q = cellsOf(t2, visitableCells).map(c => c + W).filter(c => c < W * H && !hard[c]);
		for (const c of q) dist[c] = 1;
		for (let i = 0; i < q.length; i++) {
			const c = q[i], x = c % W, y = (c / W) | 0;
			for (let dy = -1; dy <= 1; dy++)
				for (let dx = -1; dx <= 1; dx++) {
					const u = x + dx, v = y + dy;
					if ((!dx && !dy) || u < 0 || v < 0 || u >= W || v >= H) continue;
					const d = v * W + u;
					if (dist[d] < 0 && !hard[d]) { dist[d] = dist[c] + 1; q.push(d); }
				}
		}
		for (const kind of ['sawmill', 'orePit']) {
			let best = Infinity;
			for (const m of on0.filter(o => o.type === 'mine' && o.subtype === kind)) {
				const v = cellsOf(m, visitableCells)[0];
				for (let dy = -1; dy <= 1; dy++)
					for (let dx = -1; dx <= 1; dx++) {
						const u = v % W + dx, w = ((v / W) | 0) + dy;
						if (u < 0 || w < 0 || u >= W || w >= H) continue;
						const d = dist[w * W + u];
						if (d >= 0 && d < best) best = d;
					}
			}
			assert.ok(best <= 24, `${t2.options.owner} walks ${best} steps to a ${kind}`);
		}
	}
	fs.rmSync(out, { force: true });
});
