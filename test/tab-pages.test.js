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

test('--classic: the stock background, the rows inside its bands, every text there', () => {
	const stage = fs.mkdtempSync(path.join(testTmp(), 'vmapgen-classic-'));
	execFileSync(process.execPath, [TOOL, 'build', '--classic', '--out', stage], { windowsHide: true });
	const tab = JSON.parse(fs.readFileSync(path.join(stage, 'config', 'widgets', 'mapGen', 'mapGenTab.json'), 'utf8'));
	const texts = JSON.parse(fs.readFileSync(path.join(stage, 'config', 'omnimapgen', 'english.json'), 'utf8'));
	// the extended lobby's background, as the Random Map Setup K plays with has it
	assert.strictEqual(tab.items.find(w => w.name === 'background').image, 'RanMapBk_new');
	const w = tab.items.find(i => i.type === 'pages');
	assert.ok(w && w.name === 'pages' && w.id === 'mapGen');
	// every text a label, a button's word or an empty line names exists
	const keys = [];
	const walk = node => {
		if (Array.isArray(node)) return node.forEach(walk);
		if (!node || typeof node !== 'object') return;
		for (const [k, v] of Object.entries(node)) {
			if ((k === 'text' || k === 'emptyText' || k === 'hover' || k === 'help') && typeof v === 'string' && v.startsWith('vcmi.')) keys.push(v);
			else walk(v);
		}
	};
	walk(tab);
	const settings = new Map();
	for (const p of w.pages) {
		const page = JSON.parse(fs.readFileSync(path.join(stage, p.layout), 'utf8'));
		walk(page);
		for (const item of page.items) {
			if (!item.setting) continue;
			assert.ok(!settings.has(item.setting), `${item.setting} on one page only`);
			settings.set(item.setting, p.layout);
			// lever rows sit inside the bands (header text at 133, the sixth band's control strip to 517)
			if (item.type === 'slider' && !/page_map/.test(p.layout)) assert.ok(item.position.y >= 128 && item.position.y + 16 <= 517, `${item.name} inside the bands`);
		}
	}
	for (const k of keys) assert.ok(texts[k], `${k} has a text`);
	assert.ok(settings.get('persistent:mapGen/params/monsterStrength').endsWith('page_map.json'), 'monster strength on the Map page, as stock');
	assert.ok(!settings.has('persistent:mapGen/params/roadType'), 'the three road toggles replace Road type');

	// K's no-regression rule, against the stock screen: every choice it offers is here
	const map = JSON.parse(fs.readFileSync(path.join(stage, w.pages[0].layout), 'utf8')).items;
	const bound = s => map.find(i => i.setting === s);
	const size = bound('persistent:mapGen/map/size'), under = bound('persistent:mapGen/map/underground');
	assert.strictEqual(size.type, 'toggleGroup', 'map size is a row of buttons, as stock');
	assert.deepStrictEqual(size.values, [36, 72, 108, 144, 180, 216, 252]);
	assert.strictEqual(under.position.y, size.position.y, 'the two-level toggle in the size row');
	assert.ok(under.position.x > size.position.x + size.items[size.items.length - 1].position.x, 'and last in it');
	assert.ok(bound('persistent:mapGen/map/humans').values.includes(-1), 'human or computer players: Random');
	assert.deepStrictEqual(bound('persistent:mapGen/params/compOnly').values, [0, 1, 2, 3, 4, 5, 6, 7, -1], 'computer only players 0-7 and Random');
	assert.deepStrictEqual(bound('persistent:mapGen/params/waterContent').values, [0, 1, 2, -1], 'water: none, normal, islands, Random');
	assert.ok(bound('persistent:mapGen/params/monsterStrength').values.includes(-9), 'monster strength: Random');
	for (const r of ['roadDirt', 'roadGravel', 'roadCobblestone'])
		assert.strictEqual(bound(`persistent:mapGen/params/${r}`).type, 'toggleButton', `${r}: its own toggle, as stock`);
	assert.ok(map.some(i => i.callback === 'chooseMapGenTeams'), 'team alignments open the grid');
	assert.ok(map.some(i => i.callback === 'chooseMapGenTemplate'), 'the template chooser');
});

test('the released layout keeps its page buttons and asks for no addon API level', () => {
	const tab = JSON.parse(fs.readFileSync(path.join(ROOT, 'mod', 'Content', 'config', 'widgets', 'mapGen', 'mapGenTab.json'), 'utf8'));
	assert.ok(Array.isArray(tab.pages) && tab.pages.length >= 2);
	assert.ok(tab.items.some(w => w.name === 'pageButtons'));
	assert.ok(!tab.items.some(w => w.type === 'pages'), 'no pages widget before a DMB release has level 2');
	const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'mod', 'mod.json'), 'utf8'));
	assert.strictEqual(manifest.dmb, undefined, 'DMB releases before level 2 cannot refuse the mod');
});
