/**
 * inert-controls.test.js - the controls the lobby greys because the generator does not act on them yet (S414, K: "instead of having sliders that don't do anything, we should grey
 * out the ones that don't do anything yet"). The list is src/biome/inert.json; the pages carry it as mapGenTab.json "inert" (DMB Dev's shape) and the sentences as strings.
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
const { KNOBS } = require('../src/biome/knobs');
const INERT = require('../src/biome/inert.json');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'src', 'main', 'generate-cli.js');
const APPROVED = Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'mod', 'approved-templates.json'), 'utf8')).approved);
const entries = Object.entries(INERT).filter(([k]) => !k.startsWith('_'));

test('every inert entry names a lever, a layout that exists and a plain one-line sentence', () => {
	assert.ok(entries.length >= 10);
	for (const [key, kinds] of entries) {
		assert.ok(KNOBS.some(k => k.key === key && !k.cli), `${key} is a lever`);
		for (const [kind, text] of Object.entries(kinds)) {
			assert.ok(kind.startsWith('*') ? ['*named', '*classic', '*random'].includes(kind) : APPROVED.includes(kind), `${key}: ${kind} is a layout`);
			assert.ok(typeof text === 'string' && text.length > 20 && !/\n/.test(text), `${key} ${kind}: a line of text`);
			assert.ok(!/[—–]/.test(text), `${key} ${kind}: no dash`);
			assert.ok(/once built/i.test(text), `${key} ${kind}: says what it will do once built`);
		}
	}
});

test('the pages carry the inert block and its sentences', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inert-pages-'));
	const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'gen_vcmi_ui.js'), 'build', '--pager', '--classic', '--atbegin', '--api4', '--out', dir], { encoding: 'utf8', cwd: ROOT, windowsHide: true, timeout: 120000 });
	assert.strictEqual(r.status, 0, r.stderr);
	const tab = JSON.parse(fs.readFileSync(path.join(dir, 'config', 'widgets', 'mapGen', 'mapGenTab.json'), 'utf8'));
	const eng = JSON.parse(fs.readFileSync(path.join(dir, 'config', 'omnimapgen', 'english.json'), 'utf8'));
	for (const [key, kinds] of entries) {
		assert.ok(tab.inert[key], `${key} is in the inert block`);
		for (const [kind, text] of Object.entries(kinds)) {
			const id = tab.inert[key][kind];
			assert.ok(id && id.startsWith(`vcmi.mapGen.${key}.inert.`), `${key} ${kind}: ${id}`);
			assert.strictEqual(eng[id], text, `${key} ${kind}: the sentence is in english.json`);
		}
	}
	assert.deepStrictEqual(tab.inert.layoutFamily, { '*named': 'vcmi.mapGen.layoutFamily.inert.named' });
	fs.rmSync(dir, { recursive: true, force: true });
});

test('a sample of the claims holds: the control at the bottom and at the top of its range gives the same objects, stacks, terrain and roads', { timeout: 1800000 }, () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inert-maps-'));
	const hash = f => {
		const M = sight.load(f);
		return M.objs.map(x => [x.type, x.subtype, x.l, x.x, x.y, (x.options && x.options.amount) || ''].join(',')).sort().join('|') + '#' + M.terr.join('') + '#' + Array.from(M.road).join('');
	};
	const make = (tag, template, key, value) => {
		const out = path.join(tmp, tag + '.vmap');
		const r = spawnSync(process.execPath, [CLI, '--w', '72', '--h', '72', '--players', '4', '--seed', '1', '--underground', '1', '--declaremods', '0', '--template', template, '--accommodate', 'size,players,humans,underground',
			'--bio.waterContent', '1', '--bio.waterCoverage', '0.3', '--bio.' + key, String(value), '--out', out], { encoding: 'utf8', cwd: ROOT, env: genEnv(), windowsHide: true, timeout: 280000, maxBuffer: 1 << 28 });
		assert.strictEqual(r.status, 0, (r.stderr || '').slice(-400));
		return hash(out);
	};
	for (const [key, template] of [['layoutFamily', "Coldshadow's Fantasy"], ['zoneSizeVariety', 'Jebus Cross'], ['lowLootRatio', 'Golems Aplenty'], ['dwellingDensity', "Coldshadow's Fantasy"]]) {
		assert.ok(INERT[key] && (INERT[key][template] || INERT[key]['*named']), `${key} on ${template} is listed`);
		const k = KNOBS.find(q => q.key === key);
		assert.strictEqual(make('a', template, key, k.min), make('b', template, key, k.max), `${key} acts on ${template}: it should not be listed`);
	}
	fs.rmSync(tmp, { recursive: true, force: true });
});
