/**
 * open-template-name.test.js - the open layout's list name is written once (mod/open-template-name.json), and its description says what the code does (K, 2026-10-21:
 * the name is not final; the text opens with a sentence for a newcomer, then the details, and that this is DMB's Nostalgia).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { KNOBS } = require('../src/biome/knobs');

const ROOT = path.join(__dirname, '..');
const NAME = JSON.parse(fs.readFileSync(path.join(ROOT, 'mod', 'open-template-name.json'), 'utf8')).name;
const info = JSON.parse(fs.readFileSync(path.join(ROOT, 'mod', 'template-info.json'), 'utf8')).templates;
const approved = JSON.parse(fs.readFileSync(path.join(ROOT, 'mod', 'approved-templates.json'), 'utf8')).approved;
const entry = info[NAME];

test('the name file, template-info.json and approved-templates.json agree (run tools/apply_open_template_name.js when they do not)', () => {
	assert.ok(entry, `template-info.json has no entry named "${NAME}"`);
	assert.strictEqual(entry.openLayout, true);
	assert.ok(approved[NAME], `approved-templates.json has no entry named "${NAME}"`);
	assert.strictEqual(Object.entries(info).filter(([, v]) => v.openLayout === true)[0][0], NAME, 'the open layout is the first open entry');
	for (const [k, v] of Object.entries(info)) assert.ok(!/Throwback/.test(JSON.stringify(v)), `${k} still says Throwback`);
});

test('the lobby label is read from the name file', () => {
	const src = fs.readFileSync(path.join(ROOT, 'tools', 'gen_vcmi_ui.js'), 'utf8');
	assert.match(src, /noneShort'\] = JSON\.parse\(fs\.readFileSync\(path\.join\(ROOT, 'mod\/open-template-name\.json'\)/, 'noneShort is not read from open-template-name.json');
});

test('the description opens for a newcomer, then says it is DMB\'s Nostalgia, in plain prose', () => {
	const paras = entry.description.split('\n\n');
	assert.match(paras[0], /^Start here if you are new to Heroes or to Dead Man's Boots\./);
	assert.ok(paras[0].length < 520, 'the opening is a short plain paragraph');
	assert.match(entry.description, /DMB's own Nostalgia/);
	assert.ok(!/—/.test(entry.description + entry.oneLine), 'no em dash');
	assert.match(entry.oneLine, /DMB's own Nostalgia/);
});

test('every setting the description names is a setting with that label, and every Layout family stop is named', () => {
	const labels = new Set(KNOBS.map(k => k.label));
	const named = ['Biome size', 'Start biome size', 'Treasure biomes', 'Layout family', 'Biome connections', 'Portal share', 'Passages with road', 'Passages without road', 'Guards at bottlenecks',
		'Bottleneck guard share', 'Guard gradient', 'Guards by distance', 'Guards on treasure', 'Monster count', 'Monster tier', 'Stack size', 'Mines', 'Creature dwellings', 'Artifacts'];
	for (const n of named) {
		assert.ok(labels.has(n), `"${n}" is not a setting's label in knobs.js`);
		assert.ok(entry.description.includes(n), `the description does not name ${n}`);
	}
	const fam = KNOBS.find(k => k.key === 'layoutFamily');
	for (const [, label] of fam.stops) assert.ok(entry.description.includes(label), `the description does not name the Layout family stop ${label}`);
	assert.strictEqual(fam.stops.length, 8, 'a Layout family stop was added or removed: the description (paragraph on how the biomes join) must follow');
});
