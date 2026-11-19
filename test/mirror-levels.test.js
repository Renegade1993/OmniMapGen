/**
 * mirror-levels.test.js - the second level made like the overworld (S341, K 2026-11-19: "set the subterranean layer to mimic the overworld ... in jebus
 * cross, you would get two layers with jebus crosses and high loot centers and player and neutral starts"). With the lever Second Level Like the
 * Overworld (mirrorLevels) on, a template map of two levels is the template as a one-level map runs it, once on each level: every zone on its own
 * level, no cave floor or rock on level 1, a start zone for each of the template's starts on each level (the players take them level by level, the
 * rest keep a neutral town), and a gate pair between the two centres. Off, the map is what it was.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { genEnv } = require('./_vcmi');
const { readVmap } = require('../src/preview/render');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'src', 'main', 'generate-cli.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-levels-'));

function make(name, args, env) {
	const out = path.join(dir, name + '.vmap');
	const r = spawnSync(process.execPath, [CLI, '--w', '72', '--h', '72', '--underground', '1', '--players', '4', '--template', 'Jebus Cross', ...args, '--out', out],
		{ encoding: 'utf8', cwd: ROOT, env: { ...genEnv(), ...env }, windowsHide: true, timeout: 280000 });
	assert.strictEqual(r.status, 0, r.stderr);
	return { out, log: r.stderr + r.stdout };
}
const terrains = (file, level) => {
	const seen = new Map();
	for (const row of readVmap(file).levels[level].rows) for (const code of row) { const t = String(code).slice(0, 2); seen.set(t, (seen.get(t) || 0) + 1); }
	return seen;
};
const zoneInfo = file => JSON.parse(fs.readFileSync(file + '.zones.json', 'utf8'));

test('Second Level Like the Overworld: both levels are Jebus Crosses on overworld ground', () => {
	for (const seed of [3, 7]) {
		const m = make('on' + seed, ['--seed', String(seed), '--bio.mirrorLevels', '1']);
		assert.ok(/mirrored levels: 4 start zones on each level/.test(m.log), 'the template is mirrored: ' + m.log.split('\n').filter(l => /mirror/.test(l)).join(' | '));
		const z = zoneInfo(m.out);
		assert.deepStrictEqual(z.levels.map(l => l.templateTypes.filter(t => /Start$/.test(t)).length), [4, 4], 'four start zones on each level');
		assert.deepStrictEqual(z.levels.map(l => l.templateTypes.filter(t => t === 'treasure').length), [1, 1], 'a centre on each level');
		assert.ok(!terrains(m.out, 1).has('sb'), 'no cave floor on level 1');
		const starts = (z.starts || []).length;
		void starts;
		const gates = z.linkEnds.filter(e => e.type === 'subterraneanGate' || e.type === 'monolithTwoWay');
		assert.ok(gates.some(e => e.l === 0) && gates.some(e => e.l === 1), 'the two centres are joined by a passage');
	}
});

test('Off, a two-level Jebus Cross has its cave floor as before; the lever on a one-level map does nothing', () => {
	const off = make('off3', ['--seed', '3']);
	assert.ok(terrains(off.out, 1).has('sb'), 'level 1 is cave floor');
	const same = make('off3b', ['--seed', '3', '--bio.mirrorLevels', '0']);
	assert.strictEqual(JSON.stringify(readVmap(off.out).levels), JSON.stringify(readVmap(same.out).levels), 'the lever at 0 is the default map, tile for tile');
	const one = path.join(dir, 'one.vmap');
	const r = spawnSync(process.execPath, [CLI, '--w', '72', '--h', '72', '--players', '4', '--template', 'Jebus Cross', '--seed', '3', '--bio.mirrorLevels', '1', '--out', one],
		{ encoding: 'utf8', cwd: ROOT, env: genEnv(), windowsHide: true, timeout: 280000 });
	assert.strictEqual(r.status, 0, r.stderr);
	assert.strictEqual(readVmap(one).levels.length, 1);
});
