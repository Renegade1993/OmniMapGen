/**
 * gold-floor.test.js - a few gold mines on every Classic map (S340, K 2026-11-19: "No, keep a few gold mines on every Classic map").
 * The free layout has at least 3 gold mines on a map 108 wide or more and 2 under it, outside the players' zones, whatever the mine lever says;
 * a template's map is left as its template makes it; VMAPGEN_GOLD_FLOOR=0 is the earlier rule.
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gold-floor-'));
const make = (name, args, env) => {
	const out = path.join(dir, name + '.vmap');
	const r = spawnSync(process.execPath, [CLI, '--seed', '3', '--out', out, ...args], { encoding: 'utf8', cwd: ROOT, env: { ...genEnv(), ...env }, windowsHide: true, timeout: 280000 });
	assert.strictEqual(r.status, 0, r.stderr);
	return out;
};
const gold = f => sight.load(f).objs.filter(o => o.type === 'mine' && o.subtype === 'goldMine');

test('a 72 map with no mines asked for has 2 gold mines, a 108 map 3, none of them in a player\'s zone', () => {
	const small = make('s72', ['--w', '72', '--h', '72', '--players', '4', '--bio.mineDensity', '0']);
	assert.ok(gold(small).length >= 2, `72 map: ${gold(small).length} gold mines`);
	const big = make('s108', ['--w', '108', '--h', '108', '--players', '4', '--bio.mineDensity', '0']);
	const mines = gold(big), M = sight.load(big);
	assert.ok(mines.length >= 3, `108 map: ${mines.length} gold mines`);
	const types = z => { const q = M.zones && M.zones.zones.get(z); return q ? q.type : ''; };
	for (const g of mines) {
		const z = M.zoneAt(g.l, g.at[0], g.at[1]);
		assert.ok(!/start/i.test(types(z)), `a gold mine at (${g.at}) in a start zone`);
	}
});

test('the earlier rule is VMAPGEN_GOLD_FLOOR=0: no mines asked for, no gold mines', () => {
	const f = make('off72', ['--w', '72', '--h', '72', '--players', '4', '--bio.mineDensity', '0'], { VMAPGEN_GOLD_FLOOR: '0' });
	assert.strictEqual(gold(f).length, 0);
});
