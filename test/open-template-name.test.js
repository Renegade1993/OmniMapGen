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

// Rewritten 2026-11-07 (the suite's debt): K, 2026-11-03: "focused general information provision, with a 'what makes it different' subtext focus" (roster
// SPEC-MapGenDev-descriptions-1104.md): paragraph 1 says what the map is, for a newcomer, in plain words; paragraph 2 opens 'What makes it different:'. The old opening
// ('Start here if you are new to Heroes or to Dead Man's Boots.') and the sentence about DMB's own Nostalgia in the description are gone; the one-line text keeps DMB's Nostalgia.
test('the description opens with what the map is for a newcomer, then says what makes it different, in plain prose', () => {
	const paras = entry.description.split('\n\n');
	assert.match(paras[0], /if you are new/);
	assert.ok(paras[0].length < 520, 'the opening is a short plain paragraph');
	assert.match(paras[1] || '', /^What makes it different:/);
	assert.ok(!/—/.test(entry.description + entry.oneLine), 'no em dash');
	assert.match(entry.oneLine, /DMB's own Nostalgia/);
});

// Rewritten 2026-11-07 (the suite's debt): the description no longer carries a slider guide (it ran to 451 words; K's rule leaves slider names, values and measurements out):
// it is a short text of 70 to 140 words that names no setting by its label, and the settings it points to by what they do are real pages of the lobby.
test('the description is a short plain text and names no setting by its label', () => {
	const words = entry.description.split(/\s+/).length;
	assert.ok(words >= 70 && words <= 140, `the description is ${words} words`);
	for (const k of KNOBS.filter(q => q.label.split(' ').length >= 2)) assert.ok(!entry.description.includes(k.label), `the description names the setting ${k.label}`);
	const fam = KNOBS.find(k => k.key === 'layoutFamily');
	assert.ok(fam && fam.stops.length === 8, 'a Layout family stop was added or removed');
});
