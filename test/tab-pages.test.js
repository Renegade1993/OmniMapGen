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
	// K (2026-09-27): the page buttons at the top, as the released tab has them;
	// the arrows there are DMB's, switching modes, so y 0-50 stays clear
	assert.ok(!tab.items.some(i => i.type === 'pages'), 'no pages widget');
	assert.strictEqual(tab.pages.length, 8);
	const buttons = tab.items.find(i => i.name === 'pageButtons');
	assert.strictEqual(buttons.callback, 'activateMapGenPage');
	for (const b of buttons.items)
		assert.ok(b.position.y >= 51 && b.position.y + 24 <= 103, `page button ${b.index} under the mode bar, above the template row`);
	assert.ok(!tab.items.some(i => i.position && !['background', 'pageButtons'].includes(i.name) && i.position.y < 51), 'nothing of ours in the mode bar DMB draws');
	const w = { pages: tab.pages.map(layout => ({ layout })) };
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
	// K: "the first monster settings are superseded by the other monster tab" -
	// one place for them, the Monsters page
	assert.ok(settings.get('persistent:mapGen/params/monsterStrength').endsWith('page_monsters.json'), 'monster strength on the Monsters page');
	assert.ok(!settings.has('persistent:mapGen/params/roadType'), 'the three road toggles replace Road type');

	// K's no-regression rule, against the stock screen: every choice it offers is
	// here, drawn as stock draws it; and his other (2026-09-27): "all options per
	// theme should be together", so the Map page keeps the map's own and each of
	// the rest is on its theme's page
	const pageItems = id => JSON.parse(fs.readFileSync(path.join(stage, 'config', 'widgets', 'mapGen', `page_${id}.json`), 'utf8')).items;
	const map = pageItems('map');
	const bound = s => map.find(i => i.setting === s);
	const size = bound('persistent:mapGen/map/size');
	assert.strictEqual(size.type, 'toggleGroup', 'map size is a row of buttons, as stock');
	assert.deepStrictEqual(size.values, [36, 72, 108, 144, 180, 216, 252]);
	assert.ok(bound('persistent:mapGen/map/humans').values.includes(-1), 'human or computer players: Random');
	assert.deepStrictEqual(bound('persistent:mapGen/params/compOnly').values, [0, 1, 2, 3, 4, 5, 6, 7, -1], 'computer only players 0-7 and Random');
	assert.ok(map.some(i => i.callback === 'chooseMapGenTeams'), 'team alignments open the grid');
	assert.ok(map.some(i => i.callback === 'chooseMapGenTemplate'), 'the template chooser');
	const on = (setting, id) => assert.ok(settings.get(setting).endsWith(`page_${id}.json`), `${setting} on the ${id} page`);
	on('persistent:mapGen/map/underground', 'underground');
	on('persistent:mapGen/params/waterContent', 'water');
	for (const r of ['roadDirt', 'roadGravel', 'roadCobblestone']) on(`persistent:mapGen/params/${r}`, 'borders');
	const under = pageItems('underground').filter(i => i.setting);
	assert.strictEqual(under[0].setting, 'persistent:mapGen/map/underground', 'the two-level toggle heads its page');
	assert.strictEqual(under[0].type, 'toggleButton', 'a toggle, as stock');
	const water = pageItems('water').filter(i => i.setting);
	assert.deepStrictEqual(water[0].values, [0, 1, 2, -1], 'water content heads its page: none, normal, islands, Random');
	for (const r of ['roadDirt', 'roadGravel', 'roadCobblestone'])
		assert.strictEqual(pageItems('borders').find(i => i.setting === `persistent:mapGen/params/${r}`).type, 'toggleButton', `${r}: its own toggle, as stock`);
});

test('--atbegin: the game makes the map at Begin, so no Generate button, and the mode is "Omni Map Gen"', () => {
	for (const classic of [false, true]) {
		const stage = fs.mkdtempSync(path.join(testTmp(), 'vmapgen-atbegin-'));
		execFileSync(process.execPath, [TOOL, 'build', '--atbegin', ...(classic ? ['--classic'] : []), '--out', stage],
			{ windowsHide: true });
		const tab = JSON.parse(fs.readFileSync(path.join(stage, 'config', 'widgets', 'mapGen', 'mapGenTab.json'), 'utf8'));
		const texts = JSON.parse(fs.readFileSync(path.join(stage, 'config', 'omnimapgen', 'english.json'), 'utf8'));
		assert.ok(tab.items.some(w => w.name === 'pageButtons') && tab.pages.length === 8, 'on the page buttons');
		assert.ok(!tab.items.some(w => w.type === 'pages'), 'no pages widget: its arrows are DMB\'s mode switch now');
		assert.ok(!tab.items.some(w => w.name === 'labelTitle'), 'DMB writes the mode\'s name');
		assert.ok(!tab.items.some(w => w.callback === 'generateMapGenMap'), 'no Generate button');
		const defaults = tab.items.find(w => w.callback === 'resetMapGenDefaults');
		assert.ok(defaults, 'Defaults stays');
		// the player's own presets in Generate's place (DMB API 3)
		for (const cb of ['saveMapGenPreset', 'loadMapGenPreset']) {
			const b = tab.items.find(w => w.callback === cb);
			assert.ok(b, `${cb} beside Defaults`);
			assert.ok(texts[b.help.hover] && texts[b.help.help] && texts[b.items[0].text], `${cb} has its texts`);
			if (classic) assert.ok(b.position.x + 83 <= 54 + 337, `${cb} inside the gold bar`);
		}
		assert.strictEqual(texts['vcmi.lobby.mapGen.hover'], 'Omni Map Gen');
		assert.match(texts['vcmi.lobby.mapGen.help'], /when the game begins/);
		if (classic) {
			const map = JSON.parse(fs.readFileSync(path.join(stage, tab.pages[0]), 'utf8')).items;
			assert.strictEqual(map.find(i => i.name === 'buttonCustomSize').callback, 'chooseMapGenCustomSize', 'C, the custom size');
			assert.strictEqual(map.find(i => i.name === 'labelTemplate').valueTexts.random, 'vcmi.mapGen.template.random');
			assert.strictEqual(texts['vcmi.mapGen.template.random'], '(Random)');
		}
	}
	// the manifest a build carries: level 3, atBegin, K's name; the pages build level 2, the released one untouched
	const { buildModJson } = require('../tools/make_mod');
	const text = fs.readFileSync(path.join(ROOT, 'mod', 'mod.json'), 'utf8');
	const atBegin = JSON.parse(buildModJson(text, { pager: true, atBegin: true }));
	assert.deepStrictEqual(atBegin.dmb, { api: 3 });
	assert.strictEqual(atBegin.mapGenerator.atBegin, true);
	assert.strictEqual(atBegin.mapGenerator.name, 'Omni Map Gen');
	assert.deepStrictEqual(atBegin.mapGenerator.arguments, ['humanColors'], 'DMB sends --humanColors only when named');
	assert.strictEqual(atBegin.mapGenerator.command, JSON.parse(text).mapGenerator.command);
	assert.deepStrictEqual(JSON.parse(buildModJson(text, { pager: true, atBegin: false })).dmb, { api: 2 });
	assert.strictEqual(buildModJson(text, { pager: false, atBegin: false }), text);
	// the stock look needs VCMI Extras' art; the plain pages do not
	// the classic look's lobby art is VCMI Extras' extendedLobby submod's
	assert.deepStrictEqual(JSON.parse(buildModJson(text, { pager: true, atBegin: true, classic: true })).depends, ['vcmi-extras.extendedlobby']);
	assert.strictEqual(atBegin.depends, undefined);
});

test('the released layout keeps its page buttons and asks for no addon API level', () => {
	const tab = JSON.parse(fs.readFileSync(path.join(ROOT, 'mod', 'Content', 'config', 'widgets', 'mapGen', 'mapGenTab.json'), 'utf8'));
	assert.ok(Array.isArray(tab.pages) && tab.pages.length >= 2);
	assert.ok(tab.items.some(w => w.name === 'pageButtons'));
	assert.ok(!tab.items.some(w => w.type === 'pages'), 'no pages widget before a DMB release has level 2');
	const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'mod', 'mod.json'), 'utf8'));
	assert.strictEqual(manifest.dmb, undefined, 'DMB releases before level 2 cannot refuse the mod');
});

test('--api4: the gold bar\'s words carved, Water layout a chooser, and the manifest asks for level 4', () => {
	const stage = fs.mkdtempSync(path.join(testTmp(), 'vmapgen-api4-'));
	execFileSync(process.execPath, [TOOL, 'build', '--classic', '--atbegin', '--api4', '--out', stage], { windowsHide: true });
	const tab = JSON.parse(fs.readFileSync(path.join(stage, 'config', 'widgets', 'mapGen', 'mapGenTab.json'), 'utf8'));
	const texts = JSON.parse(fs.readFileSync(path.join(stage, 'config', 'omnimapgen', 'english.json'), 'utf8'));
	assert.strictEqual(tab.items.find(w => w.name === 'defaultsButton').items[0].style, 'engraved', 'K: black on gold, carved');
	// the game's own size buttons (DMB's DmbSize, 44 by 33): the seven fill the
	// band, C takes the next one, and the two-level button is the game's own too
	const page = id => JSON.parse(fs.readFileSync(path.join(stage, 'config', 'widgets', 'mapGen', `page_${id}.json`), 'utf8')).items;
	const size = page('map').find(w => w.setting === 'persistent:mapGen/map/size');
	assert.deepStrictEqual(size.items.map(b => b.image), ['DmbSizeS', 'DmbSizeM', 'DmbSizeL', 'DmbSizeXL', 'DmbSizeH', 'DmbSizeXH', 'DmbSizeG']);
	assert.ok(size.position.x >= 67 && size.position.x + size.items[6].position.x + 44 <= 67 + 312, 'the seven inside the band');
	const custom = page('map').find(w => w.callback === 'chooseMapGenCustomSize');
	assert.strictEqual(custom.image, 'DmbSizeC');
	assert.ok(custom.position.y >= size.position.y + 33, 'C below the row');
	assert.strictEqual(page('underground').find(w => w.setting === 'persistent:mapGen/map/underground').image, 'RANUNDR');
	const water = JSON.parse(fs.readFileSync(path.join(stage, 'config', 'widgets', 'mapGen', 'page_water.json'), 'utf8'));
	const chooser = water.items.find(w => w.name === 'choose_waterShape');
	assert.ok(chooser && chooser.setting === 'persistent:mapGen/params/waterShape' && chooser.options.length >= 5);
	for (const [, key] of chooser.options) assert.ok(texts[key], `${key} has a text`);
	assert.ok(!water.items.some(w => w.name === 'slider_waterShape'), 'no slider beside it');
	const label = chooser.items[0];
	assert.strictEqual(label.setting, chooser.setting, 'the button shows the choice');
	assert.deepStrictEqual(Object.keys(label.valueTexts), chooser.options.map(([v]) => String(v)));
	const { buildModJson } = require('../tools/make_mod');
	const text = fs.readFileSync(path.join(ROOT, 'mod', 'mod.json'), 'utf8');
	assert.deepStrictEqual(JSON.parse(buildModJson(text, { pager: true, atBegin: true, api4: true })).dmb, { api: 4 });
});
