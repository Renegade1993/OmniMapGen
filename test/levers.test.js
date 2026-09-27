/**
 * levers.test.js - the in-game tab reaches the generator only through
 * --bio.<lever> (every mapGen.params entry, generically), so three of the
 * generator's own options became levers too: road type, river amount and
 * teams. Each must change the map it is asked to, and an explicit flag
 * (--road, --rivershare, --teams) must still win.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { readVmap } = require('../src/preview/render');
const { KNOBS } = require('../src/biome/knobs');
const { genEnv, testTmp } = require('./_vcmi');

function generate(name, extra) {
	const out = path.join(testTmp(), `vmapgen_levers_${name}.vmap`);
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'),
		'--w', '36', '--h', '36', '--players', '4', '--seed', '31', '--declaremods', '0', '--out', out, ...extra],
	{ cwd: path.join(__dirname, '..'), env: genEnv(), encoding: 'utf8', timeout: 180000, windowsHide: true });
	assert.strictEqual(r.status, 0, r.stderr);
	const m = readVmap(out);
	const roads = {};
	let rivers = 0;
	for (const lv of m.levels) for (const row of lv.rows) for (const c of row) {
		const s = String(c), road = s.match(/p[dgc]/);
		if (road) roads[road[0]] = (roads[road[0]] || 0) + 1;
		if (/r[wilm]/.test(s.slice(2))) rivers++;
	}
	return { roads: Object.keys(roads).sort(), rivers, teams: (m.header && m.header.teams) || null };
}

test('road type, river amount and teams are levers the tab can pass', () => {
	for (const key of ['roadType', 'riverAmount', 'teams'])
		assert.ok(KNOBS.some(k => k.key === key && !k.cli), `${key} is an ordinary lever`);
	const base = generate('default', []);
	assert.deepStrictEqual(base.roads, ['pc'], 'cobblestone by default');
	assert.strictEqual(base.teams, null, 'no teams by default');

	const lev = generate('set', ['--bio.roadType', '0', '--bio.riverAmount', '2', '--bio.teams', '2']);
	assert.deepStrictEqual(lev.roads, ['pd'], 'dirt roads');
	assert.ok(lev.rivers > base.rivers * 1.5, `more river (${lev.rivers} against ${base.rivers})`);
	assert.deepStrictEqual(lev.teams, [['red', 'tan'], ['blue', 'green']], 'two teams in colour order');

	const flags = generate('flags', ['--bio.roadType', '0', '--road', 'pg', '--bio.teams', '2', '--teams', 'red,blue;tan,green']);
	assert.deepStrictEqual(flags.roads, ['pg'], 'an explicit --road wins');
	assert.deepStrictEqual(flags.teams, [['red', 'blue'], ['tan', 'green']], 'an explicit --teams wins');

	const solo = generate('fourteams', ['--bio.teams', '4']);
	assert.strictEqual(solo.teams, null, 'as many teams as players is every player for themselves');
});
