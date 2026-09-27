/**
 * tab-pages.test.js - the tab on DMB's "pages" widget (addon API level 2,
 * docs/modders/DMB_UI_Modding.md in DMB), as gen_vcmi_ui.js --pager writes it,
 * and the released layout left as it is until a DMB release carries level 2.
 *
 * DMB's MapGenTab drives the widget only when it is named "pages", and other
 * mods add screens to it by its id through tabPages; the contract lists
 * OmniMapGen's as "mapGen". A root "pages" list is the page buttons' own
 * mechanism, so the pager layout carries none.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { testTmp } = require('./_vcmi');

const ROOT = path.join(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'gen_vcmi_ui.js');

test('--pager: one pages widget as the contract has it, every page and title there', () => {
	const stage = fs.mkdtempSync(path.join(testTmp(), 'vmapgen-pager-'));
	execFileSync(process.execPath, [TOOL, 'build', '--pager', '--out', stage], { windowsHide: true });
	const tab = JSON.parse(fs.readFileSync(path.join(stage, 'config', 'widgets', 'mapGen', 'mapGenTab.json'), 'utf8'));
	const texts = JSON.parse(fs.readFileSync(path.join(stage, 'config', 'omnimapgen', 'english.json'), 'utf8'));
	assert.strictEqual(tab.pages, undefined, 'no root page list beside the widget');
	assert.ok(!tab.items.some(w => w.name === 'pageButtons'), 'no page buttons');
	const widgets = tab.items.filter(w => w.type === 'pages');
	assert.strictEqual(widgets.length, 1);
	const w = widgets[0];
	assert.strictEqual(w.name, 'pages', 'MapGenTab drives the widget named "pages"');
	assert.strictEqual(w.id, 'mapGen', 'the id tabPages names');
	assert.strictEqual(w.remember, 'persistent:mapGen/lastPage');
	assert.deepStrictEqual([w.previous.image, w.next.image], ['SCNRBLF', 'SCNRBRT']);
	assert.ok(w.pages.length >= 2);
	for (const p of w.pages) {
		assert.ok(fs.existsSync(path.join(stage, p.layout)), `${p.layout} written`);
		assert.ok(texts[p.title], `${p.title} has a text`);
		// the settings MapGenTab forwards to the generator
		const page = JSON.parse(fs.readFileSync(path.join(stage, p.layout), 'utf8'));
		for (const item of page.items)
			if (item.setting) assert.match(item.setting, /^persistent:mapGen\//, `${p.layout}: ${item.name}`);
	}
});

test('the released layout keeps its page buttons and asks for no addon API level', () => {
	const tab = JSON.parse(fs.readFileSync(path.join(ROOT, 'mod', 'Content', 'config', 'widgets', 'mapGen', 'mapGenTab.json'), 'utf8'));
	assert.ok(Array.isArray(tab.pages) && tab.pages.length >= 2);
	assert.ok(tab.items.some(w => w.name === 'pageButtons'));
	assert.ok(!tab.items.some(w => w.type === 'pages'), 'no pages widget before a DMB release has level 2');
	const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'mod', 'mod.json'), 'utf8'));
	assert.strictEqual(manifest.dmb, undefined, 'DMB releases before level 2 cannot refuse the mod');
});
