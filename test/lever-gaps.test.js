/**
 * lever-gaps.test.js - four settings the lever table (2026-10-05) found doing nothing, or the wrong thing, on a template map:
 * Border wobble (the zone warp ignored it: borders as rough at 0 as at 0.6), Guards on treasure Off and Treasure guard pull (the
 * guard pass for high piles ignored both), Mine guard weight (4x equalled 1x), Water layout (ignored by the template's own water).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');
const sight = require('../tools/mapsight/lib/sight');

function make(tag, w, extra, template = true) {
	const out = path.join(testTmp(), `vmapgen_gaps_${tag}.vmap`);
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), '--out', out, '--declaremods', '0',
		...(template ? ['--template', "Coldshadow's Fantasy"] : []), '--w', String(w), '--h', String(w), '--players', '4', '--seed', '1',
		'--factions', 'random,random,random,random', '--accommodate', 'size,players,humans,underground', ...extra],
	{ encoding: 'utf8', timeout: 150000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	return out;
}
const drop = out => { for (const f of [out, out + '.zones.json', out.replace(/\.vmap$/, '.zonedump.json')]) fs.rmSync(f, { force: true }); };

function roughness(out) {
	const z = JSON.parse(fs.readFileSync(out + '.zones.json', 'utf8')).levels[0].zone, n = Math.round(Math.sqrt(z.length));
	const area = new Map();
	let per = 0;
	for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
		const a = z[y * n + x];
		area.set(a, (area.get(a) || 0) + 1);
		for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) { const u = x + dx, v = y + dy; if (u >= 0 && v >= 0 && u < n && v < n && z[v * n + u] !== a) per++; }
	}
	let sq = 0;
	for (const [, ar] of area) sq += 4 * Math.sqrt(ar);
	return per / sq;
}

test('Border wobble: borders straighter at 0 than at 1.5 on Coldshadow', { timeout: 200000 }, () => {
	const a = make('wob0', 72, ['--bio.biomeWobble', '0']), b = make('wob15', 72, ['--bio.biomeWobble', '1.5']);
	const r0 = roughness(a), r15 = roughness(b);
	drop(a); drop(b);
	assert.ok(r15 > r0 + 0.1, `0 ${r0} against 1.5 ${r15}`);
});

test('Guards on treasure Off leaves the high piles open; Treasure guard pull 0 does the same', { timeout: 280000 }, () => {
	const share = out => {
		const M = sight.load(out);
		const piles = M.objs.filter(o => /^(randomArtifactRelic|randomArtifactMajor|pandoraBox|artifact)$/.test(o.type));
		return piles.filter(o => M.monsters.some(m => m.l === o.l && Math.max(Math.abs(m.at[0] - o.x), Math.abs(m.at[1] - o.y)) <= 2)).length / Math.max(1, piles.length);
	};
	const on = make('gt_on', 72, []), off = make('gt_off', 72, ['--bio.guardTreasure', '0']), pull0 = make('gt_p0', 72, ['--bio.lootGuardWeight', '0']);
	const sOn = share(on), sOff = share(off), sP0 = share(pull0);
	drop(on); drop(off); drop(pull0);
	assert.ok(sOn > 0.3, `default ${sOn}`);
	assert.ok(sOff < sOn / 2, `Off ${sOff} against ${sOn}`);
	assert.ok(sP0 < sOn / 2, `pull 0 ${sP0} against ${sOn}`);
});

test('Mine guard weight: 4x guards more mines than 0x on a template map', { timeout: 280000 }, () => {
	const guarded = out => {
		const M = sight.load(out);
		return M.objs.filter(o => o.cls === 'mine' && M.monsters.some(q => q.l === o.l && Math.min(...o.entr.map(([x, y]) => Math.max(Math.abs(q.at[0] - x), Math.abs(q.at[1] - y)))) <= 2)).length;
	};
	const a = make('mg0', 144, ['--bio.mineGuardWeight', '0']), b = make('mg4', 144, ['--bio.mineGuardWeight', '4']);
	const g0 = guarded(a), g4 = guarded(b);
	drop(a); drop(b);
	assert.ok(g4 >= g0 + 5, `0x ${g0} against 4x ${g4}`);
});

test('Water layout on a template map: Mediterranean puts more water in the middle than Continental does', { timeout: 200000 }, () => {
	const centre = out => {
		const M = sight.load(out);
		let n = 0, w = 0;
		for (let y = 0; y < M.H; y++) for (let x = 0; x < M.W; x++) if (Math.hypot(x - M.W / 2, y - M.H / 2) / M.W < 0.2) { n++; if (!M.ground(M.idx(0, x, y))) w++; }
		return w / n;
	};
	const water = ['--bio.waterContent', '1', '--bio.waterCoverage', '0.2'];
	const med = make('wl_med', 108, [...water, '--bio.waterShape', '3']), con = make('wl_con', 108, [...water, '--bio.waterShape', '2']);
	const cm = centre(med), cc = centre(con);
	drop(med); drop(con);
	assert.ok(cm > cc + 0.1, `Mediterranean ${cm} against Continental ${cc}`);
});
