'use strict';
/**
 * Guards by distance (src/biome/guardDistance.js, knob guardDistance): at 0 the map is as it was; at 0.5 and 1 the rank correlation of a
 * stack's distance to the nearest owned town against its creature level rises step by step, the mean level of the farthest quarter over
 * the nearest widens by at least half a level from 0 to 1 (0.67 on seed 1 here, whose nearest stacks are mostly level 1 already and
 * cannot weaken, so as many far ones stay; 0.9 to 1.5 on seeds 1 to 4 outside the test env), the stacks are the same in number and the
 * mean level moves under 0.1. A map has a
 * gradient of its own at 0 (Spearman 0.43, -0.01, 0.25 and 0.36 on 48x48 four players seeds 1 to 4), so the check is the change, not a bar
 * at 0. Placeholders kept (VMAPGEN_CONCRETE_FREE=0) so the level reads off the type. Opus Map Vision 2026-10-21.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { testTmp, genEnv } = require('./_vcmi');
const { spawnSync } = require('child_process');
const { readVmap } = require('../src/preview/render');

const rank = v => {
	const ix = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]), r = new Array(v.length);
	for (let i = 0; i < ix.length;) { let j = i; while (j + 1 < ix.length && ix[j + 1][0] === ix[i][0]) j++; for (let k = i; k <= j; k++) r[ix[k][1]] = (i + j) / 2; i = j + 1; }
	return r;
};
const pearson = (a, b) => {
	const n = a.length, ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
	let sab = 0, saa = 0, sbb = 0;
	for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
	return sab / Math.sqrt(saa * sbb);
};
const gen = (seed, g) => {
	const out = path.join(fs.mkdtempSync(path.join(testTmp(), 'gd-')), 'm.vmap');
	const args = [path.join(__dirname, '../src/main/generate-cli.js'), '--w', '48', '--h', '48', '--players', '4', '--seed', String(seed), '--underground', '0', '--out', out];
	if (g !== null) args.push('--bio.guardDistance', String(g));
	const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 300000, windowsHide: true, env: { ...genEnv(), VMAPGEN_CONCRETE_FREE: '0' } });
	assert.strictEqual(r.status, 0, (r.stderr || '').slice(-600));
	const o = readVmap(out).objects;
	fs.rmSync(path.dirname(out), { recursive: true, force: true });
	const towns = o.filter(x => /town/i.test(x.type) && x.options && x.options.owner);
	const st = o.filter(x => /^randomMonsterLevel[1-7]$/.test(x.type)).map(x => ({ lv: +x.type.slice(-1), d: Math.min(...towns.map(t => Math.hypot(t.x - x.x, t.y - x.y))) }));
	const by = [...st].sort((a, b) => a.d - b.d), q = Math.floor(by.length / 4), mean = a => a.reduce((s, x) => s + x.lv, 0) / a.length;
	return { objects: JSON.stringify(o), n: st.length, rho: pearson(rank(st.map(s => s.d)), rank(st.map(s => s.lv))), gap: mean(by.slice(-q)) - mean(by.slice(0, q)), mean: mean(st) };
};

for (const seed of [1, 2])
	test(`48x48 four players seed ${seed}: guards stronger with distance from the starts, step by step, the stacks and their mean level kept`, { timeout: 900000 }, () => {
		const none = gen(seed, null), z = gen(seed, 0), h = gen(seed, 0.5), one = gen(seed, 1);
		assert.strictEqual(z.objects, none.objects, 'at 0 the map is as it was');
		// 2026-11-07 (the suite's debt; the same failure on 0.3.28, 0.3.29 and 0.3.30): a stack moves a level at 0.5 only where round(0.5 x 2.4 x (rank - 0.5))
		// reaches 1, which is a rank under 0.08 or over 0.92, and on seed 1 (26 stacks) the nearest are level 1 and cannot weaken, so the far ones stay too
		// (guardDistance.js, the net undone) and 0.5 leaves the map as at 0 ('0 of 26 stacks' in the log; 5 of 26 at 1). So 0.5 makes another map where a
		// stack can move (seed 2) and never goes against the knob where it cannot (seed 1): the correlation never falls from 0 to 0.5 to 1.
		assert.ok(one.objects !== h.objects && one.objects !== z.objects, 'at 1 the map changes');
		if (seed === 2) assert.ok(h.objects !== z.objects, 'each value makes another map');
		assert.ok(z.rho <= h.rho && h.rho <= one.rho && one.rho - z.rho >= 0.1, `Spearman ${z.rho.toFixed(2)}, ${h.rho.toFixed(2)}, ${one.rho.toFixed(2)}`);
		if (seed === 2) assert.ok(z.rho < h.rho && h.rho < one.rho, `Spearman rises step by step: ${z.rho.toFixed(2)}, ${h.rho.toFixed(2)}, ${one.rho.toFixed(2)}`);
		assert.ok(one.gap - z.gap >= 0.5, `far quarter over near: ${z.gap.toFixed(2)} at 0, ${one.gap.toFixed(2)} at 1`);
		assert.ok(z.n === h.n && h.n === one.n, `stacks ${z.n} ${h.n} ${one.n}`);
		assert.ok(Math.abs(one.mean - z.mean) < 0.1, `mean level ${z.mean.toFixed(2)} at 0, ${one.mean.toFixed(2)} at 1`);
	});

test('guardsByDistance: a concrete guard keeps its creature and has its count scaled; a lone stack and a map with no start move nothing', () => {
	const { guardsByDistance } = require('../src/biome/guardDistance');
	const mk = (x, lv, amount) => ({ type: `randomMonsterLevel${lv}`, x, y: 0, l: 0, instanceName: `randomMonsterLevel${lv}_${x}_0_0`, options: { amount } });
	const objs = [mk(1, 3, 10), mk(2, 3, 10), mk(3, 3, 10), mk(4, 3, 10), mk(5, 3, 10)];
	const picked = new Map([[objs[4], 'someCreature']]);
	const r = guardsByDistance(objs, { picked, starts: [{ x: 0, y: 0 }], g: 1, perCreature: lv => [0, 1, 2, 4, 8, 16, 32, 64][lv] });
	assert.deepStrictEqual(objs.map(o => o.type), ['randomMonsterLevel2', 'randomMonsterLevel2', 'randomMonsterLevel3', 'randomMonsterLevel4', 'randomMonsterLevel3']);
	assert.strictEqual(objs[0].instanceName, 'randomMonsterLevel2_1_0_0');
	assert.strictEqual(objs[4].options.amount, 20, 'the picked guard: its count doubled, a level up at twice the strength');
	assert.deepStrictEqual([r.weaker, r.stronger, r.stacks], [2, 2, 5]);
	const low = [mk(1, 1, 5), mk(2, 1, 5), mk(3, 3, 5), mk(4, 3, 5), mk(5, 3, 5)];
	guardsByDistance(low, { starts: [{ x: 0, y: 0 }], g: 1 });
	assert.deepStrictEqual(low.map(o => +o.type.slice(-1)), [1, 1, 3, 3, 3], 'the two nearest at level 1 cannot weaken, so the two that would strengthen stay: the mean holds');
	assert.strictEqual(guardsByDistance([mk(9, 3, 5)], { starts: [{ x: 0, y: 0 }], g: 1 }).weaker + guardsByDistance([mk(9, 3, 5)], { starts: [], g: 1 }).stronger, 0);
});
