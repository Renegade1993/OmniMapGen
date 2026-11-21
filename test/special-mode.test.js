/**
 * special-mode.test.js - the four states of the Special buildings control and the buildings on named templates (S366, S388; K: "the old school buildings need a multi-button setting
 * like the water has. Template, Random, Off and On/Forced ... the player can leave it to the template, make it completely random, have it off always, or have it on always"; K S371:
 * "on coldshadow i believe there is none, so by default there should be none ... and the player should be able to add them by sliding up the scale").
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { genEnv } = require('./_vcmi');
const sight = require('../tools/mapsight/lib/sight');
const { resolveMode, zoneAllows } = require('../src/biome/special');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'src', 'main', 'generate-cli.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'special-mode-'));
const KIND = o => (/^tradingPost/.test(o.type) ? 'tradingPost' : /^(university|sanctuary|hillFort|sign)$/.test(o.type) ? o.type : o.type === 'cartographer' ? 'cartographer' : /^monolithOneWay/.test(o.type) ? 'oneWay' : null);

function make(tag, template, args, seed = 1, size = 108) {
	const out = path.join(dir, tag + '.vmap');
	const r = spawnSync(process.execPath, [CLI, '--w', String(size), '--h', String(size), '--players', '4', '--seed', String(seed), ...(template ? ['--template', template, '--accommodate', 'size,players,humans,underground'] : []), ...args, '--declaremods', '0', '--out', out],
		{ encoding: 'utf8', cwd: ROOT, env: genEnv(), windowsHide: true, timeout: 280000 });
	assert.strictEqual(r.status, 0, (r.stderr || '').slice(-600));
	return { out, settings: (r.stdout.split('\n').find(l => l.startsWith('settings:')) || '') };
}
const total = file => sight.load(file).objs.filter(o => KIND(o)).length;

test('the mode and the amount make the map\'s buildings: Off beats an amount, On is the amount (1x never moved), Template follows the layout, Random rolls from the seed', () => {
	const at = (mode, amount, template, lean) => resolveMode({ mode, amount, template, lean, seed: 5 });
	assert.deepStrictEqual(at(2, 2, false, 0.8), { amount: 0, force: false, mode: 2 }, 'Off beats an amount');
	assert.deepStrictEqual(at(3, undefined, true), { amount: 1, force: true, mode: 3 }, 'On with no amount is 1x, on a template too');
	assert.deepStrictEqual(at(3, 2.5, true), { amount: 2.5, force: true, mode: 3 });
	assert.deepStrictEqual(at(0, undefined, true), { amount: 0, force: false, mode: 0 }, 'Template on a named template is none');
	assert.deepStrictEqual(at(0, undefined, false, 0.4), { amount: 0.4, force: false, mode: 0 }, 'Template on Classic is the lean\'s count');
	assert.deepStrictEqual(at(0, undefined, false, undefined), { amount: 1, force: false, mode: 0 }, 'no lean (the feel off): 1x as before');
	assert.deepStrictEqual(at(0, 0.1, true), { amount: 0.1, force: true, mode: 0 }, 'an amount set by hand counts as On, 0.1 included');
	assert.deepStrictEqual(at(0, 0, true), { amount: 0, force: true, mode: 0 }, '0 is none');
	let off = 0, amounts = new Set();
	for (let s = 1; s <= 400; s++) { const r = resolveMode({ mode: 1, template: true, seed: s }); if (r.amount === 0) off++; else { assert.ok(r.force && r.amount >= 0.5 && r.amount <= 2.0, JSON.stringify(r)); amounts.add(r.amount); } }
	assert.ok(off > 90 && off < 150, `Random is none on about 3 maps in 10: ${off} of 400`);
	assert.ok(amounts.size >= 12, `Random draws amounts from 0.5x to 2x: ${amounts.size} different`);
	assert.deepStrictEqual(resolveMode({ mode: 1, template: true, seed: 9 }), resolveMode({ mode: 1, template: true, seed: 9 }), 'the same seed rolls the same');
	assert.strictEqual(resolveMode({ mode: 1, amount: 3, template: false, seed: 4 }).amount === 3 || resolveMode({ mode: 1, amount: 3, template: false, seed: 4 }).amount === 0, true, 'Random with an amount set keeps the amount and rolls only on or off');
});

test('a template zone takes buildings only when forced, and never a start zone', () => {
	const neutral = { spec: { type: 'treasure' }, ownerColor: null }, start = { spec: { type: 'playerStart' }, ownerColor: 'red' }, cpu = { spec: { type: 'cpuStart' }, ownerColor: null };
	assert.strictEqual(zoneAllows(null, 0), true, 'the open layout always');
	assert.strictEqual(zoneAllows(neutral, 0), false);
	assert.strictEqual(zoneAllows(neutral, 1), true);
	assert.strictEqual(zoneAllows(start, 1), false);
	assert.strictEqual(zoneAllows(cpu, 1), false);
});

test('Coldshadow\'s Fantasy and Jebus Cross: Template and Off give none, On and an amount set by hand give buildings (0.1x included)', { timeout: 1800000 }, () => {
	for (const name of ["Coldshadow's Fantasy", 'Jebus Cross']) {
		const k = name[0];
		assert.strictEqual(total(make(k + 'tpl', name, []).out), 0, `${name}: Template is none`);
		assert.strictEqual(total(make(k + 'off', name, ['--bio.specialMode', '2', '--bio.specialDensity', '2']).out), 0, `${name}: Off beats an amount`);
		const on = make(k + 'on', name, ['--bio.specialMode', '3']);
		assert.ok(total(on.out) > 0, `${name}: On puts buildings in its neutral zones: ${on.settings}`);
		const set = make(k + 'set', name, ['--bio.specialDensity', '3']);
		assert.ok(total(set.out) > 0, `${name}: an amount set by hand counts as On: ${set.settings}`);
	}
	let some = 0;
	for (let s = 1; s <= 4; s++) some += total(make('low' + s, "Coldshadow's Fantasy", ['--bio.specialDensity', '0.1'], s, 144).out);
	assert.ok(some > 0, '0.1x already adds buildings: no threshold (four 144 wide maps)');
});

test('on Classic Off gives none whatever the amount, and On is the amount', { timeout: 900000 }, () => {
	assert.strictEqual(total(make('coff', null, ['--bio.specialMode', '2', '--bio.specialDensity', '3']).out), 0);
	assert.ok(total(make('con', null, ['--bio.specialMode', '3']).out) > 0, 'On, 1x');
});
