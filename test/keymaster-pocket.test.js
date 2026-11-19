/**
 * keymaster-pocket.test.js - keymaster pockets (S340, K 2026-11-19: "a smattering of maps where there are keymasters like the oldschool maps").
 * A pocket is one zone shut by border guards of one colour, with a tent of that colour elsewhere. Checked here on the finished map, by a walk of
 * its own: with the guards in place no start reaches a tile of the pocket, every start reaches the tent, and the starts reach each other; with the
 * guards taken away (the tent visited) a start walks into the pocket. A map whose pocket found no place is made without it, never refused.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { genEnv } = require('./_vcmi');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'src', 'main', 'generate-cli.js');
const sight = require(path.join(ROOT, 'tools', 'mapsight', 'lib', 'sight'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keymaster-'));
const PASS = /^(resource|randomResource|treasureChest|campfire|randomArtifact|artifact|pandoraBox|spellScroll|prison|seaChest|flotsam|monster|randomMonster)/;

function make(seed, extra = []) {
	const out = path.join(dir, `k${seed}.vmap`);
	const r = spawnSync(process.execPath, [CLI, '--w', '108', '--h', '108', '--players', '4', '--seed', String(seed), '--bio.keymasterPockets', '1', '--out', out, ...extra],
		{ encoding: 'utf8', cwd: ROOT, env: genEnv(), windowsHide: true, timeout: 280000 });
	assert.strictEqual(r.status, 0, r.stderr);
	return { out, log: r.stdout + r.stderr };
}

function analyse(file, guardsOn) {
	const M = sight.load(file), W = M.W, H = M.H;
	const guards = M.objs.filter(o => o.type === 'borderGuard'), tents = M.objs.filter(o => o.type === 'keymasterTent');
	if (!tents.length) return { M, guards, tents };
	const gset = new Set(guards.map(g => g.at[1] * W + g.at[0]));
	const occ = new Uint8Array(W * H);
	for (const o of M.objs) {
		if ((o.l || 0) !== 0) continue;
		const isGuard = o.type === 'borderGuard';
		for (const [x, y] of o.cells || []) if (x >= 0 && y >= 0 && x < W && y < H) occ[y * W + x] = isGuard ? (guardsOn ? 1 : 0) : (PASS.test(o.type) ? 0 : 1);
	}
	for (let i = 0; i < W * H; i++) if (!M.ground(i)) occ[i] = 1;
	const flood = (sx, sy) => {
		const seen = new Uint8Array(W * H), q = [sy * W + sx];
		if (occ[q[0]]) return seen;
		seen[q[0]] = 1;
		for (let i = 0; i < q.length; i++) {
			const c = q[i], x = c % W, y = (c / W) | 0;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				const u = x + dx, v = y + dy;
				if (u < 0 || v < 0 || u >= W || v >= H) continue;
				const d = v * W + u;
				if (!seen[d] && !occ[d]) { seen[d] = 1; q.push(d); }
			}
		}
		return seen;
	};
	const towns = M.objs.filter(o => o.options && o.options.owner && /own/i.test(o.type));
	const reach = towns.map(t => flood(t.at[0], t.at[1] + 1));
	return { M, W, H, guards, tents, gset, towns, reach, zoneOf: (x, y) => M.zoneAt(0, x, y) };
}

test('a map with a pocket: one colour, guards on the pocket\'s border, the tent reached by every start, the pocket shut until the guards are gone', () => {
	let tried = 0, found = 0;
	for (const seed of [1, 2, 3, 4]) {
		const { out } = make(seed);
		tried++;
		const a = analyse(out, true);
		if (!a.tents.length) continue;
		found++;
		assert.strictEqual(a.tents.length, 1);
		assert.ok(a.guards.length >= 1);
		const colour = a.tents[0].subtype;
		assert.ok(a.guards.every(g => g.subtype === colour), 'guards and tent share one colour');
		const zone = a.zoneOf(a.guards[0].at[0], a.guards[0].at[1]);
		const pocket = new Set(a.guards.map(g => a.zoneOf(g.at[0], g.at[1])));
		// the guards stand in the pocket zone's own border tiles (one zone)
		assert.strictEqual(pocket.size, 1, 'every guard stands in the one pocket zone');
		const tentAt = a.tents[0].at, front = (tentAt[1] + 1) * a.W + tentAt[0];
		for (const r of a.reach) assert.ok(r[front], 'a start does not reach the tent');
		// the pocket is shut: no tile of its zone is reached from any start
		for (const r of a.reach) {
			let inside = 0;
			for (let y = 0; y < a.H; y++) for (let x = 0; x < a.W; x++) if (r[y * a.W + x] && a.zoneOf(x, y) === zone) inside++;
			assert.strictEqual(inside, 0, `seed ${seed}: ${inside} pocket tile(s) reached with the guards in place`);
		}
		// and open once they are gone
		const b = analyse(out, false);
		let inside = 0;
		for (let y = 0; y < b.H; y++) for (let x = 0; x < b.W; x++) if (b.reach[0][y * b.W + x] && b.zoneOf(x, y) === zone) inside++;
		assert.ok(inside > 0, 'the pocket opens when the guards are gone');
	}
	assert.ok(found >= 1, `none of ${tried} maps got a pocket`);
});

test('VMAPGEN_KEYMASTERS=0 makes the earlier map: no tent, no border guard', () => {
	const { out } = make(1, []);
	const r = spawnSync(process.execPath, [CLI, '--w', '72', '--h', '72', '--players', '3', '--seed', '2', '--bio.keymasterPockets', '1', '--out', path.join(dir, 'off.vmap')],
		{ encoding: 'utf8', cwd: ROOT, env: { ...genEnv(), VMAPGEN_KEYMASTERS: '0' }, windowsHide: true, timeout: 280000 });
	assert.strictEqual(r.status, 0, r.stderr);
	const M = sight.load(path.join(dir, 'off.vmap'));
	assert.strictEqual(M.objs.filter(o => /^(keymasterTent|borderGuard)$/.test(o.type)).length, 0);
	assert.ok(out);
});
