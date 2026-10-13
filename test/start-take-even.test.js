/**
 * start-take-even.test.js - two starts take about the same with no fight, and leave past about the same guards (K, 2026-10-12, his
 * small Coldshadow seed 1099575901: "a really nasty start for me. significantly less resources in my biome, + a lot more creature
 * value blocking me from anything substantive below....compared to blue"). Measured on the written map: the walk from each start
 * town's door over open ground and pickups that never steps into a guard's ring, and the mines, piles, chests and artifacts it
 * reaches; and the way out the generator's start fairness line reports. 36x36 two players two levels Coldshadow's Fantasy, core
 * content, seed 1099575901: blue took 0.77 of red's take and red's way out cost 1.54 times blue's before (now at most 1.3).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');
const sight = require('../tools/mapsight/lib/sight');

const VALUE = { sawmill: 2000, orePit: 2000, alchemistLab: 3000, sulfurDune: 3000, crystalCavern: 3000, gemPond: 3000, goldMine: 5000 };
// the values plan.js evenStartTakes weighs a take with: wood and ore are worth less than the dear resources, an artifact by its tier
const RES = { wood: 300, ore: 300, mercury: 1000, sulfur: 1000, crystal: 1000, gems: 1000, gold: 750 };
const ART = { Treasure: 5000, Minor: 10000, Major: 20000, Relic: 30000 };
const valueOf = o => o.type === 'mine' ? VALUE[o.subtype] || 2500 : o.type === 'resource' ? RES[o.subtype] || 500 : o.type === 'randomResource' ? 750
	: o.type === 'treasureChest' ? 1500 : /^randomArtifact/.test(o.type) ? ART[(o.type.match(/(Treasure|Minor|Major|Relic)$/) || [])[1]] || 10000 : 0;

test("36x36 two players two levels Coldshadow's Fantasy seed 1099575901: the starts' take with no fight and their ways out are even", () => {
	const out = path.join(testTmp(), `vmapgen_take_even_${process.pid}.vmap`);
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), '--w', '36', '--h', '36', '--players', '2',
		'--underground', '1', '--template', "Coldshadow's Fantasy", '--seed', '1099575901', '--out', out],
	{ encoding: 'utf8', timeout: 300000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	try {
		assert.strictEqual(r.status, 0, (r.stderr || '').slice(-800));
		const M = sight.load(out), W = M.W, H = M.H;
		const takes = [];
		for (const s of sight.starts(M)) {
			const town = M.objs.find(o => o.cls === 'town' && o.l === s.l && Math.max(Math.abs(o.at[0] - s.at[0]), Math.abs(o.at[1] - s.at[1])) <= 1);
			const ring = new Set();
			for (const m of M.monsters) if (m.l === s.l) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (M.inb(m.at[0] + dx, m.at[1] + dy)) ring.add(M.idx(m.l, m.at[0] + dx, m.at[1] + dy));
			const pick = new Set();
			for (const o of M.objs) if (o.pickup) for (const [x, y] of o.cells) if (M.inb(x, y)) pick.add(M.idx(o.l, x, y));
			const seen = new Set(M.approach(town).filter(i => M.ground(i) && !M.blocked[i] && !ring.has(i))), q = [...seen];
			while (q.length) {
				const i = q.pop(), c = i % (W * H), x = c % W, y = (c / W) | 0;
				for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
					if (!M.inb(x + dx, y + dy)) continue;
					const n = M.idx(s.l, x + dx, y + dy);
					if (seen.has(n) || ring.has(n) || !M.ground(n) || (M.blocked[n] && !pick.has(n))) continue;
					seen.add(n); q.push(n);
				}
			}
			let value = 0;
			for (const o of M.objs) {
				if (o.l !== s.l || !valueOf(o)) continue;
				if (M.approach(o).some(i => seen.has(i)) || (o.pickup && o.cells.some(([x, y]) => seen.has(M.idx(o.l, x, y))))) value += valueOf(o);
			}
			takes.push(value);
		}
		assert.strictEqual(takes.length, 2);
		assert.ok(Math.min(...takes) >= 0.8 * Math.max(...takes), `takes with no fight ${takes.join(' and ')}`);
		const fair = (r.stderr || '').split(/\r?\n/).find(s => s.includes('[gen] start fairness:'));
		const gates = [...fair.matchAll(/gate (\d+)(?: cut to (\d+))?(?: raised to (\d+))?/g)].map(m => Number(m[3] || m[2] || m[1]));
		assert.strictEqual(gates.length, 2, fair);
		assert.ok(Math.max(...gates) <= 1.3 * Math.min(...gates) + 1, fair);
	} finally {
		for (const f of [out, out + '.zones.json']) try { fs.unlinkSync(f); } catch (e) { /* gone already */ }
	}
});
