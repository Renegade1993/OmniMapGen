'use strict';
// The open layout is a named entry of the template list (K, 2026-10-18: "we need to add the open template to the templates list").
// Choosing it means no template; its details entry carries a Template value for every lever.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { genEnv, testTmp } = require('./_vcmi');

const ROOT = path.join(__dirname, '..');
const info = JSON.parse(fs.readFileSync(path.join(ROOT, 'mod', 'template-info.json'), 'utf8')).templates;
const approved = JSON.parse(fs.readFileSync(path.join(ROOT, 'mod', 'approved-templates.json'), 'utf8')).approved;
const { KNOBS } = require('../src/biome/knobs');
const { isOpenLayoutName } = require('../src/rmg/template');

const OPEN_NAME = JSON.parse(fs.readFileSync(path.join(ROOT, 'mod', 'open-template-name.json'), 'utf8')).name;
const open = Object.entries(info).filter(([, v]) => v.openLayout === true);

test('the open layout is the entry named in open-template-name.json, and it is approved; any other open entry is an approximate one of a template', () => {
	assert.strictEqual(open[0][0], OPEN_NAME, "the open layout's name is written once, in mod/open-template-name.json");
	assert.ok(approved[open[0][0]], 'the open entry is not in approved-templates.json');
	for (const [name] of open.slice(1)) {
		assert.match(name, /\(approximate\)$/, `${name} is an open layout that does not say it is approximate`);
		assert.ok(approved[name], `${name} is not in approved-templates.json`);
	}
});

test('the open entry carries a Template value for every lever', () => {
	const levers = open[0][1].originalPreferences.levers;
	// 2026-11-07 (the suite's debt): bb472fc took the seat choices (teams, compOnly: who plays and in which team) out of the preference levers, so the entry carries
	// every lever but those two
	const SEAT = ['teams', 'compOnly'];
	for (const k of KNOBS.filter(q => !SEAT.includes(q.key))) assert.ok(k.key in levers, `no Template value for ${k.key}`);
	for (const k of SEAT) assert.ok(!(k in levers), `${k} is a seat choice and has no Template value`);
	assert.strictEqual(Object.keys(levers).length, KNOBS.length - SEAT.length);
	for (const k of KNOBS.filter(q => !SEAT.includes(q.key))) assert.strictEqual(levers[k.key], k.default, `${k.key} is not at its default`);
});

test('isOpenLayoutName matches the entry name, ignoring case and punctuation, and nothing else', () => {
	const name = open[0][0];
	assert.ok(isOpenLayoutName(name));
	assert.ok(isOpenLayoutName(name.toUpperCase()));
	assert.ok(isOpenLayoutName(name.replace(/ /g, '-')));
	assert.ok(!isOpenLayoutName("Coldshadow's Fantasy"));
	assert.ok(!isOpenLayoutName(''));
	assert.ok(!isOpenLayoutName(undefined));
});

test('generating with the open entry as the template is the open layout', { timeout: 290000 }, () => {
	const out = path.join(testTmp(), 'vmapgen_open_entry.vmap');
	const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), '--out', out, '--declaremods', '0',
		'--template', open[0][0], '--w', '36', '--h', '36', '--players', '2', '--seed', '1', '--factions', 'random,random'],
	{ encoding: 'utf8', timeout: 260000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
	assert.strictEqual(r.status, 0, (r.stderr || '').slice(-600));
	assert.ok(fs.existsSync(out), 'no map written');
	assert.ok(!/unknown template|not approved/i.test(r.stdout + r.stderr), (r.stderr || '').slice(-600));
	assert.ok(!/template "[^"]+": \d+ zones/.test(r.stdout + r.stderr), 'a template file was loaded for the open layout');
});

test('Random is a listed entry that reads as the random template', () => {
	const rnd = Object.entries(info).filter(([, v]) => v.randomEntry === true);
	assert.strictEqual(rnd.length, 1);
	assert.strictEqual(rnd[0][0], 'Random');
	assert.ok(approved.Random, 'Random is not in approved-templates.json');
	assert.ok(require('../src/main/stockChoices').isRandomTemplate('Random'));
	assert.ok(!isOpenLayoutName('Random'));
});

test('Random picks from the whole list, the open layout included, and the pick follows the seed', { timeout: 290000 }, () => {
	const picks = new Set();
	for (const seed of ['1', '2', '3', '4', '5', '6']) {
		const out = path.join(testTmp(), `vmapgen_random_entry_${seed}.vmap`);
		const r = spawnSync(process.execPath, [path.join(__dirname, '../src/main/generate-cli.js'), '--out', out, '--declaremods', '0',
			'--template', 'Random', '--w', '36', '--h', '36', '--players', '2', '--seed', seed, '--factions', 'random,random'],
		{ encoding: 'utf8', timeout: 120000, cwd: path.join(__dirname, '..'), windowsHide: true, env: genEnv() });
		assert.strictEqual(r.status, 0, (r.stderr || '').slice(-600));
		const m = /random: .*template (.+?) \(of (\d+) that take this map\)/.exec(r.stdout + r.stderr);
		assert.ok(m, 'no random: template line in the log');
		picks.add(m[1].trim());
	}
	assert.ok(picks.size >= 2, `six seeds gave one template: ${[...picks]}`);
	assert.ok(![...picks].includes('Random'), 'Random picked itself');
});
