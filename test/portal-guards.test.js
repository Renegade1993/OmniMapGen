/**
 * portal-guards.test.js - Guards at portals is three states (K, 2026-10-05: "with this setting off, there should be no guards in front
 * of portals ... it should be a definitive toggle one way or the other, and ... default to template preference"): 0 Off, no monster
 * beside any portal end whatever placed it; 1 On, a monster in front of every end; 2 Template, the template's link guards. Guards at
 * bottlenecks no longer touches portals.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');
const sight = require('../tools/mapsight/lib/sight');

function ends(tag, extra) {
	const out = path.join(testTmp(), `vmapgen_portals_${tag}.vmap`);
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), '--out', out, '--declaremods', '0',
		'--template', "Coldshadow's Fantasy", '--w', '72', '--h', '72', '--players', '4', '--seed', '2',
		'--factions', 'random,random,random,random', '--accommodate', 'size,players,humans,underground', ...extra],
	{ encoding: 'utf8', timeout: 150000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	const M = sight.load(out);
	let n = 0, g = 0;
	for (const o of M.objs) {
		if (!/^monolith/.test(o.type)) continue;
		n++;
		const cells = [...M.approach(o), ...o.entr.map(([x, y]) => M.idx(o.l, x, y))];
		if (M.monsters.some(q => q.l === o.l && cells.some(i => Math.max(Math.abs(q.at[0] - (i % M.W)), Math.abs(q.at[1] - (Math.floor(i / M.W) % M.H))) <= 1))) g++;
	}
	for (const f of [out, out + '.zones.json', out.replace(/\.vmap$/, '.zonedump.json')]) fs.rmSync(f, { force: true });
	return { n, g };
}

test('Guards at portals: Off leaves no monolith end guarded, On and Template guard every end of a Coldshadow map', { timeout: 280000 }, () => {
	const off = ends('off', ['--bio.guardPortals', '0']), on = ends('on', ['--bio.guardPortals', '1']), tpl = ends('tpl', []);
	assert.ok(off.n >= 2, 'the map has portals');
	assert.strictEqual(off.g, 0, `Off: ${off.g} of ${off.n} ends guarded`);
	assert.strictEqual(on.g, on.n, `On: ${on.g} of ${on.n} ends guarded`);
	assert.strictEqual(tpl.g, tpl.n, `Template: ${tpl.g} of ${tpl.n} ends guarded`);
});

test('Guards at bottlenecks Off no longer takes the portal guards away', { timeout: 200000 }, () => {
	const t = ends('bn0', ['--bio.guardBottlenecks', '0']);
	assert.strictEqual(t.g, t.n, `${t.g} of ${t.n} ends guarded`);
});

test('Guards at portals On puts a monster at the ends of a template whose link guards are too weak to place one (Nostalgia, 144x144 two levels)', { timeout: 400000 }, () => {
	const out = path.join(testTmp(), 'vmapgen_portals_nostalgia.vmap');
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), '--out', out, '--declaremods', '0',
		'--template', 'Nostalgia', '--w', '144', '--h', '144', '--underground', '1', '--players', '4', '--seed', '2',
		'--factions', 'random,random,random,random', '--accommodate', 'size,players,humans,underground', '--bio.guardPortals', '1'],
	{ encoding: 'utf8', timeout: 380000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	const M = sight.load(out);
	let n = 0, g = 0;
	for (const o of M.objs) {
		if (!/^monolith/.test(o.type)) continue;
		n++;
		const cells = [...M.approach(o), ...o.entr.map(([x, y]) => M.idx(o.l, x, y))];
		if (M.monsters.some(q => q.l === o.l && cells.some(i => Math.max(Math.abs(q.at[0] - (i % M.W)), Math.abs(q.at[1] - (Math.floor(i / M.W) % M.H))) <= 1))) g++;
	}
	for (const f of [out, out + '.zones.json', out.replace(/\.vmap$/, '.zonedump.json')]) fs.rmSync(f, { force: true });
	assert.ok(n >= 10, `${n} monolith ends`);
	assert.ok(g >= n - 1, `On: ${g} of ${n} monolith ends guarded (a corner end with no free approach tile may stay bare; 26 of 34 before the fix)`);
});
