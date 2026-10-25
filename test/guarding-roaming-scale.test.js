/**
 * guarding-roaming-scale.test.js - Guarding vs roaming reads 0 to 1 from 0.3.18: 1 (the default) puts every monster on a guard post and
 * none in the open, 0 leaves every monster of the open layout roaming, and each step between changes the map on the open layout and on a
 * template. Before it the same map was the lever at 0.75 and the lever stopped changing anything above that; on a template 0.25 and 0 were the
 * same map (the roamers per guard stood at their cap of 2 from a third down). The test reads the lever off the generator's own line
 * "roaming monsters: N placed of M asked", not off how near a stack stands to loot.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');

function make(tag, extra) {
	const out = path.join(testTmp(), `vmapgen_roamscale_${tag}.vmap`);
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), '--out', out, '--declaremods', '0',
		'--w', '72', '--h', '72', '--players', '4', '--seed', '1', '--factions', 'random,random,random,random',
		'--accommodate', 'size,players,humans,underground', ...extra],
	{ encoding: 'utf8', timeout: 120000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	for (const f of [out, out + '.zones.json', out.replace(/\.vmap$/, '.zonedump.json')]) fs.rmSync(f, { force: true });
	const m = (r.stderr + r.stdout).match(/roaming monsters: (\d+) placed of (\d+) asked/);
	assert.ok(m, 'no "roaming monsters" line in the generator log');
	return { placed: Number(m[1]), asked: Number(m[2]) };
}

test('Guarding vs roaming: every step from 1 down to 0 puts more roaming monsters on the open layout', { timeout: 280000 }, () => {
	const s = [1, 0.75, 0.5, 0.25, 0].map(v => ({ v, ...make('open_' + v, ['--bio.guardShare', String(v)]) }));
	console.log('open layout', JSON.stringify(s));
	assert.strictEqual(s[0].placed, 0, `none roam at 1: ${s[0].placed}`);
	for (let i = 1; i < s.length; i++)
		assert.ok(s[i].placed > s[i - 1].placed, `no more roamers from ${s[i - 1].v} to ${s[i].v}: ${s[i - 1].placed} then ${s[i].placed}`);
});

test('Guarding vs roaming on a template: the roamers asked for rise from 1 down to 0 and the placed ones hold up', { timeout: 280000 }, () => {
	const tpl = ['--template', "Coldshadow's Fantasy"];
	const s = [1, 0.5, 0.25, 0].map(v => ({ v, ...make('tpl_' + v, [...tpl, '--bio.guardShare', String(v)]) }));
	console.log('template', JSON.stringify(s));
	assert.strictEqual(s[0].placed, 0, `none roam at 1: ${s[0].placed}`);
	// each guard brings 2 x (1 - lever) roamers on average: the number asked for rises at every step. How many find a tile that fits (not on a road,
	// not clipping, two from other stacks) depends on the room the template leaves: 27, 25 and 28 of 45, 69 and 86 asked on this 72x72 map in the test
	// install, more on K's with his mods; so the placed count is only held up, not rising
	assert.ok(s[1].asked > 0 && s[2].asked > s[1].asked && s[3].asked > s[2].asked, `asked ${s.map(x => x.asked).join(', ')}`);
	assert.ok(s[1].placed > 0, `0.5 places ${s[1].placed}`);
	assert.ok(s[2].placed >= s[1].placed - 4 && s[3].placed >= s[1].placed - 4, `placed ${s.map(x => x.placed).join(', ')}`);
});
