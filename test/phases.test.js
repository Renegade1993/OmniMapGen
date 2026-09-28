/**
 * phases.test.js - the load screen's lines (src/main/phases.js): one per real
 * stage of the generator, written in order as `[phase] <n>/<total> <id>`, each
 * with its text in the mod's translations (vcmi.mapGen.phase.<id>).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { PHASES } = require('../src/main/phases');
const { genEnv, testTmp } = require('./_vcmi');

test('every stage has one id and a line of text in the mod', () => {
	const ids = PHASES.map(([id]) => id);
	assert.strictEqual(new Set(ids).size, ids.length, 'ids unique');
	const texts = require('../mod/Content/config/omnimapgen/english.json');
	for (const [id, text] of PHASES) {
		assert.ok(text && text.length <= 40, `${id}: a short line`);
		assert.strictEqual(texts[`vcmi.mapGen.phase.${id}`], text, `${id} in the mod's texts`);
	}
});

test('a map\'s run writes its stages in order, first to last, each once', { timeout: 240000 }, () => {
	const out = path.join(testTmp(), 'phases.vmap');
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'),
		'--w', '36', '--h', '36', '--players', '2', '--seed', '7', '--out', out, '--declaremods', '0'],
	{ encoding: 'utf8', timeout: 200000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	assert.strictEqual(r.status, 0, r.stderr.slice(-600));
	const lines = r.stderr.split(/\r?\n/).filter(l => l.startsWith('[phase] '));
	const seen = lines.map(l => {
		const m = l.match(/^\[phase\] (\d+)\/(\d+) (\S+)$/);
		assert.ok(m, `the line's shape: ${l}`);
		assert.strictEqual(+m[2], PHASES.length);
		assert.strictEqual(PHASES[+m[1] - 1][0], m[3], `${m[3]} is stage ${m[1]}`);
		return +m[1];
	});
	for (let i = 1; i < seen.length; i++) assert.ok(seen[i] > seen[i - 1], 'never back, never twice');
	assert.strictEqual(seen[0], 1, 'starts at the first');
	assert.strictEqual(seen[seen.length - 1], PHASES.length, 'ends at writing the map');
});
