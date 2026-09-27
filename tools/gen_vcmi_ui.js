/**
 * gen_vcmi_ui.js - build the in-game MapGen tab from the generator's own
 * lever list (src/biome/knobs.js), queue item 25.
 *
 *   node tools/gen_vcmi_ui.js build            writes the mod's tab files into mod/Content/
 *
 * The MapGen tab is a third map-selection tab in the lobby, a peer of
 * Scenarios and Random Map with its own lobby button; the stock Random Map tab
 * is left as shipped. The client's map generator framework draws it while
 * this mod is enabled (mod/mod.json "mapGenerator"), from the files this
 * writes into the mod:
 *   config/widgets/mapGen/mapGenTab.json   the tab: page buttons, Defaults,
 *                                          Generate, the page list, defaults
 *   config/widgets/mapGen/page_map.json    map size, underground, players,
 *                                          human players, template picker
 *   config/widgets/mapGen/page_<id>.json   one page per lever group: "?" help
 *                                          button, label, settings-bound slider
 *                                          or checkbox, value
 *   config/omnimapgen/english.json         vcmi.mapGen.* and vcmi.lobby.mapGen.*
 *
 * Widgets are settings-bound (client patch in InterfaceObjectConfigurable):
 * "setting": "persistent:mapGen/params/<lever>" or ".../map/<key>", which is
 * persistentStorage.json, and the tab's Generate forwards every mapGen.params
 * value to the generator as --bio.<lever>. Nothing goes into settings.json:
 * the command comes from the mod. Rebuild whenever knobs.js or a default
 * changes, so the mod never carries a stale default: every one of them comes
 * from BIOME_DEFAULTS through here.
 */
'use strict';

const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const { PAGES, KNOBS } = require(path.join(ROOT, 'src/biome/knobs'));
const PRESETS = require(path.join(ROOT, 'src/biome/presets.json'));
const STAGE = path.join(ROOT, 'mod', 'Content');

// The tab fills the lobby's left panel the way VCMI's own Extra Options tab
// does: clear background art from (0,6), titles centred on x 222 as the stock
// tabs centre theirs, content between x 20 and 386 (the info card covers the
// rest of the panel; InfoCard::InfoCard() sets pos.x += 393, so 386 leaves a
// real margin rather than sitting flush against it). The map page comes
// first, then the lever groups.
//
// K's live test (2026-09-25) found the panel's content sitting closer to its
// own left frame than the stock Random Map tab's does. The two tabs share
// one background position (0,6) but not one background IMAGE (RANMAPBK vs
// AdventureOptionsBackgroundClear), and the two arts do not bake in the same
// amount of frame before their usable interior starts, so identical
// coordinates read as "hugging the edge" against one and not the other.
// X_HELP and BTN_X0 moved right a little (14->20, 22->28) to compensate;
// this is a visual match made without being able to render the tab and see
// it (the standing constraint against launching a windowed client), so it
// is a considered nudge, not a measured fix the way the overlap below is.
const ALL_PAGES = [{ id: 'map', label: 'Map' }, ...PAGES];
const PER_ROW = 4, BTN_W = 80, BTN_GAP = 8, BTN_X0 = 28, BTN_Y0 = 80, BTN_ROW = 36;
const BTN_ROWS = Math.ceil(ALL_PAGES.length / PER_ROW);
const ROW0 = BTN_Y0 + BTN_ROWS * BTN_ROW + 14, ROW_H = 30;
const X_HELP = 20, X_LABEL = 58, X_CTRL = 202, SLIDER_W = 120, X_VALUE = 328;
const LINE_BOTTOM = 540, BUTTON_Y = 548;

// the map settings the tab owns, and where they start
const MAP_DEFAULTS = { size: 108, underground: 0, players: 4, humans: 1, template: '', declareMods: 0 };
const SIZE_STOPS = [[36, 'S'], [72, 'M'], [108, 'L'], [144, 'XL'], [180, 'H'], [216, 'XH'], [252, 'G']];

// how a value reads on the page
function display(k) {
	if (k.stops && k.stops.length) return { valueNames: k.stops.map(([v], i) => [v, `vcmi.mapGen.${k.key}.stop${i}`]) };
	if (k.min >= 0 && k.max <= 1 && k.step < 1) return { valueDisplayScale: 100, valueDecimals: 0, valueSuffix: '%' };
	if (/Density$|Weight$|Scale$/.test(k.key) && k.key !== 'artifactDensity') return { valueDecimals: k.step < 0.1 ? 2 : 1, valueSuffix: 'x' };
	if (k.key === 'artifactDensity') return { valueDisplayScale: 1000, valueDecimals: 1, valueSuffix: ' per 1000' };
	const d = k.step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(k.step)));
	return { valueDecimals: d };
}

// The base game has no visible help icon anywhere in this tab's real
// counterpart (client/lobby/RandomMapTab.cpp): hovering a setting shows its
// hint on the status bar, right (or left) click shows the popup, nothing is
// drawn. K's live test flagged our "?" square as one more plain rectangle
// that doesn't integrate; matching vanilla exactly means dropping the icon
// and covering the label instead with the same invisible hoverable rect the
// engine already has for this (LRClickableAreaWText).
//
// Stops at X_CTRL rather than spanning the whole row: EventDispatcher fires
// every clickable whose rect contains the click point, not just the topmost
// one, and LRClickableAreaWText's own left-click handler pops an interrupting
// modal dialog. Reaching into the slider/checkbox/button's own rect would
// fire that dialog on every attempt to drag a slider. The control itself
// already carries its own real hover text where one exists (toggleButton and
// button both read "help" directly); this rect only needs to cover the
// label, which nothing else claims.
//
// Height 22, not the row's full 30: the map page's players/humans rows sit
// their own number-button toggleGroup 24px below the label inside the same
// nominal row (mapPageJson's `y += 24`), and those buttons carry their own
// real per-button help already. 22 clears the label's own text (drawn at
// y+5 in a small font) with margin and stays clear of that group.
const helpButton = (id, y) => ({
	name: `help_${id}`, type: 'hoverHelp', rect: { x: 14, y, w: X_CTRL - 14, h: 22 },
	help: { hover: `vcmi.mapGen.${id}.hover`, help: `vcmi.mapGen.${id}.help` },
});
const rowLabel = (id, y) => ({ name: `label_${id}`, type: 'label', font: 'small', alignment: 'left',
	color: 'yellow', text: `vcmi.mapGen.${id}.hover`, position: { x: X_LABEL, y: y + 5 } });
const checkbox = (id, setting, y, on) => ({ name: `check_${id}`, type: 'toggleButton', image: 'lobby/checkbox',
	position: { x: X_CTRL, y: y - 1 }, setting, selected: !!on,
	help: { hover: `vcmi.mapGen.${id}.hover`, help: `vcmi.mapGen.${id}.help` } });
const slider = (id, setting, y, min, step, total, def, fmt) => [
	{ name: `slider_${id}`, type: 'slider', orientation: 'horizontal', style: 'brown',
		position: { x: X_CTRL, y: y + 4 }, size: SLIDER_W, itemsVisible: 0, itemsTotal: total,
		scrollBounds: { x: -4, y: -6, w: SLIDER_W + 8, h: 26 },
		setting, valueMin: min, valueStep: step, valueDefault: def, valueLabel: `value_${id}`, ...fmt },
	{ name: `value_${id}`, type: 'label', font: 'small', alignment: 'left', color: 'white',
		text: '', position: { x: X_VALUE, y: y + 5 } },
];

function pageJson(page) {
	const items = [];
	KNOBS.filter(k => k.page === page.id).forEach((k, i) => {
		const y = ROW0 + i * ROW_H;
		items.push(helpButton(k.key, y), rowLabel(k.key, y));
		const setting = `persistent:mapGen/params/${k.key}`;
		if (k.stops && k.stops.length === 2 && k.min === 0 && k.max === 1) {
			items.push(checkbox(k.key, setting, y, k.default));
			return;
		}
		items.push(...slider(k.key, setting, y, k.min, k.step, Math.round((k.max - k.min) / k.step), k.default, display(k)));
	});
	return { library: ['config/widgets/commonPrimitives.json'], items };
}

/** The map page: what the Random Map tab asks, in this tab's own settings. */
function mapPageJson() {
	const items = [];
	let y = ROW0;
	items.push(helpButton('map.size', y), rowLabel('map.size', y),
		...slider('map.size', 'persistent:mapGen/map/size', y, 36, 36, 6, MAP_DEFAULTS.size,
			{ valueNames: SIZE_STOPS.map(([v], i) => [v, `vcmi.mapGen.map.size.stop${i}`]) }));
	y += ROW_H;
	items.push(helpButton('map.underground', y), rowLabel('map.underground', y),
		checkbox('map.underground', 'persistent:mapGen/map/underground', y, MAP_DEFAULTS.underground));
	y += ROW_H;
	// Queue item "Mod-content integration" (2026-09-21, SID-20260921-5e2c9a):
	// default stays core-only so maps still work mod-free, an opt-in toggle
	// unlocks modded terrain/creature banks/dwellings and declares them in
	// the map's mod-requirements block. The toggle shipped in the standalone
	// Electron app (App.jsx: "Use mod content", retired 2026-09-26 to
	// VCMIMapGen\retired\electron-app) but never reached this tab,
	// because this tab didn't exist yet on 2026-09-21 - restoring it here
	// rather than leaving it dropped (fidelity lens, 2026-09-25: banks/
	// dwellings read as a real shortfall with no way for a player to fix it
	// from this tab at all).
	items.push(helpButton('map.declareMods', y), rowLabel('map.declareMods', y),
		checkbox('map.declareMods', 'persistent:mapGen/map/declareMods', y, MAP_DEFAULTS.declareMods));
	// player counts on the Random Map tab's own number buttons
	const numbers = (id, from, def, yy) => ({
		name: `group_${id}`, type: 'toggleGroup', position: { x: X_LABEL, y: yy },
		setting: `persistent:mapGen/map/${id.split('.')[1]}`,
		values: Array.from({ length: 9 - from }, (_, i) => from + i), selected: def - from,
		items: Array.from({ length: 9 - from }, (_, i) => ({
			index: i, type: 'toggleButton', image: `RANNUM${from + i}`, position: { x: i * 32, y: 0 },
			help: { hover: `vcmi.mapGen.${id}.hover`, help: `vcmi.mapGen.${id}.help` } })),
	});
	y += ROW_H;
	items.push(helpButton('map.players', y), rowLabel('map.players', y));
	y += 24;
	items.push(numbers('map.players', 2, MAP_DEFAULTS.players, y));
	y += 40;
	items.push(helpButton('map.humans', y), rowLabel('map.humans', y));
	y += 24;
	items.push(numbers('map.humans', 1, MAP_DEFAULTS.humans, y));
	y += 44;
	items.push(helpButton('map.template', y), rowLabel('map.template', y),
		{ name: 'buttonChooseTemplate', type: 'button', image: 'MapGenButton80',
			position: { x: X_CTRL, y: y - 4 }, callback: 'chooseMapGenTemplate',
			help: { hover: 'vcmi.mapGen.map.template.hover', help: 'vcmi.mapGen.map.template.help' },
			items: [{ type: 'label', font: 'small', alignment: 'center', color: 'yellow',
				text: 'vcmi.mapGen.template.button' }] });
	y += ROW_H + 2;
	// filled from settings by MapGenTab after the page is built
	items.push({ name: 'labelTemplateName', type: 'label', font: 'small', alignment: 'left',
		color: 'white', text: '', position: { x: X_LABEL, y: y + 3 } });
	return { library: ['config/widgets/commonPrimitives.json'], items };
}

function tabJson() {
	const buttons = ALL_PAGES.map((p, i) => ({
		index: i, type: 'toggleButton', image: 'MapGenButton80',
		position: { x: BTN_X0 + (i % PER_ROW) * (BTN_W + BTN_GAP), y: BTN_Y0 + Math.floor(i / PER_ROW) * BTN_ROW },
		help: { hover: `vcmi.mapGen.page.${p.id}.hover`, help: `vcmi.mapGen.page.${p.id}.help` },
		items: [{ type: 'label', font: 'small', alignment: 'center', color: 'yellow',
			text: `vcmi.mapGen.page.${p.id}.hover` }],
	}));
	const params = {};
	for (const k of KNOBS) params[k.key] = k.default;
	return {
		library: ['config/widgets/commonPrimitives.json'],
		pages: ALL_PAGES.map(p => `config/widgets/mapGen/page_${p.id}.json`),
		// the preset Defaults returns to, which the client no longer assumes
		defaults: { params, map: MAP_DEFAULTS, preset: 'nostalgia' },
		items: [
			{ name: 'background', type: 'picture', image: 'AdventureOptionsBackgroundClear', position: { x: 0, y: 6 } },
			// K's live test (2026-09-25) found this painting over the first
			// several characters of every line in the neighbouring info card:
			// InfoCard::InfoCard() sets pos.x += 393, and this rect's old
			// width (391 to 473) reached 80px past that into the card's own
			// content. AdventureOptionsBackgroundClear is generated at
			// Point(575, 585) (AssetGenerator::createAdventureOptionsCleanBackground),
			// far wider than this ~390px-wide panel, and this texture exists
			// to cover the sliver of it that would otherwise show past our
			// own content; it never needed to reach anywhere near the card.
			// Narrowed to stop at 388, five pixels clear of the card's 393.
			{ name: 'textureCampaignOverdraw', type: 'texture', color: 'blue', image: 'DIBOXBCK',
				rect: { x: 378, y: 14, w: 10, h: 569 } },
			{ name: 'labelTitle', type: 'label', font: 'big', alignment: 'center', color: 'yellow',
				text: 'vcmi.lobby.mapGen.hover', position: { x: 222, y: 36 } },
			{ name: 'labelSubTitle', type: 'label', font: 'small', alignment: 'center', color: 'white',
				text: 'vcmi.mapGen.tab.subtitle', position: { x: 222, y: 60 } },
			{ name: 'pageButtons', type: 'toggleGroup', position: { x: 0, y: 0 }, items: buttons,
				callback: 'activateMapGenPage' },
			{ name: 'lineTop', type: 'horizontalLine', rect: { x: 14, y: ROW0 - 12, w: 372, h: 3 } },
			{ name: 'lineBottom', type: 'horizontalLine', rect: { x: 14, y: LINE_BOTTOM, w: 372, h: 3 } },
			{ name: 'defaultsButton', type: 'button', image: 'MapGenButton80',
				position: { x: BTN_X0, y: BUTTON_Y },
				help: { hover: 'vcmi.mapGen.defaults.hover', help: 'vcmi.mapGen.defaults.help' },
				callback: 'resetMapGenDefaults',
				items: [{ type: 'label', font: 'small', alignment: 'center', color: 'yellow',
					text: 'vcmi.mapGen.defaults.hover' }] },
			{ name: 'generateButton', type: 'button', image: 'MapGenButton190',
				position: { x: X_CTRL, y: BUTTON_Y },
				help: { hover: 'vcmi.mapGen.generate.hover', help: 'vcmi.mapGen.generate.help' },
				callback: 'generateMapGenMap',
				items: [{ type: 'label', font: 'medium', alignment: 'center', color: 'yellow',
					text: 'vcmi.mapGen.generate.hover' }] },
		],
	};
}

function stringsJson() {
	const s = {
		'vcmi.lobby.mapGen.hover': 'MapGen',
		'vcmi.lobby.mapGen.help': '{MapGen}\n\nOur own random map generator with every one of its settings: the map, zones, borders, treasure, monsters, underground, scenery and water. Generate makes a map and selects it in the scenario list.',
		'vcmi.mapGen.tab.subtitle': 'Every setting of our own map generator',
		'vcmi.mapGen.defaults.hover': 'Defaults',
		'vcmi.mapGen.defaults.help': `{Defaults}\n\nPuts every setting back to the ${PRESETS.nostalgia.label} defaults. ${PRESETS.nostalgia.help}`,
		'vcmi.mapGen.generate.hover': 'Generate map',
		'vcmi.mapGen.generate.help': '{Generate map}\n\nMakes a map from these settings and selects it in the scenario list. Settings are saved as you change them.',
		'vcmi.mapGen.generate.running': 'Generating a map...',
		'vcmi.mapGen.generate.failed': 'The map generator failed. See extmapgen_log.txt in the VCMI logs folder.',
		'vcmi.mapGen.generate.notConfigured': 'No map generator is configured. Set mapGen.externalGenerator in settings.json.',
		'vcmi.mapGen.template.hover': 'Template',
		'vcmi.mapGen.template.choose': 'Templates that take this map size, level count and player count. Free layout is our own zone layout, calibrated on your own random maps.',
		// K's live test (2026-09-25): with no template chosen, this line read
		// like the map itself would come out Nostalgia-shaped. It does not;
		// free layout draws its own random zone graph, and only its loot,
		// guard and mine rates are tuned against Nostalgia's numbers. "No
		// template" now leads the sentence instead of trailing in a
		// parenthetical (this is a plain "label" widget, not multiLineLabel,
		// so it has to stay one line).
		'vcmi.mapGen.template.none': 'No template: free layout, tuned to Nostalgia\'s numbers',
		'vcmi.mapGen.template.button': 'Choose',
		'vcmi.mapGen.map.size.hover': 'Map size',
		'vcmi.mapGen.map.size.help': '{Map size}\n\nS 36, M 72, L 108, XL 144, H 180, XH 216 or G 252 cells a side.',
		'vcmi.mapGen.map.underground.hover': 'Underground',
		'vcmi.mapGen.map.underground.help': '{Underground}\n\nA second, underground level linked to the surface by subterranean gates.',
		'vcmi.mapGen.map.declareMods.hover': 'Use mod content',
		'vcmi.mapGen.map.declareMods.help': '{Use mod content}\n\nPlace modded terrain, creature banks and dwellings from your installed mods, and declare them in the map so VCMI requires the same mods to open it. Off makes a map that loads anywhere, core content only.',
		'vcmi.mapGen.map.players.hover': 'Players',
		'vcmi.mapGen.map.players.help': '{Players}\n\nHow many players the map has, human and computer together.',
		'vcmi.mapGen.map.humans.hover': 'Human players',
		'vcmi.mapGen.map.humans.help': '{Human players}\n\nHow many of those seats a human can take. The rest are computer players.',
		'vcmi.mapGen.map.template.hover': 'Template',
		'vcmi.mapGen.map.template.help': '{Template}\n\nThe zone layout. Free layout is our own, calibrated on your own random maps; the game\'s templates (Jebus Cross, Coldshadow\'s Fantasy and the rest) lay the zones out their way, with the settings on the other pages still applied.',
	};
	SIZE_STOPS.forEach(([, name], i) => { s[`vcmi.mapGen.map.size.stop${i}`] = name; });
	for (const p of ALL_PAGES) {
		s[`vcmi.mapGen.page.${p.id}.hover`] = p.label;
		s[`vcmi.mapGen.page.${p.id}.help`] = `{${p.label}}\n\nShow the ${p.label.toLowerCase()} settings.`;
	}
	for (const k of KNOBS) {
		s[`vcmi.mapGen.${k.key}.hover`] = k.label;
		s[`vcmi.mapGen.${k.key}.help`] = `{${k.label}}\n\n${k.help}`;
		(k.stops || []).forEach(([, name], i) => { s[`vcmi.mapGen.${k.key}.stop${i}`] = name; });
	}
	return s;
}

function build() {
	const dir = path.join(STAGE, 'config/widgets/mapGen');
	fs.mkdirSync(dir, { recursive: true });
	for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));   // no stale pages
	const write = (rel, obj) => fs.writeFileSync(path.join(STAGE, rel), JSON.stringify(obj, null, '\t') + '\n');
	write('config/widgets/mapGen/mapGenTab.json', tabJson());
	write('config/widgets/mapGen/page_map.json', mapPageJson());
	for (const p of PAGES) write(`config/widgets/mapGen/page_${p.id}.json`, pageJson(p));
	fs.mkdirSync(path.join(STAGE, 'config/omnimapgen'), { recursive: true });
	write('config/omnimapgen/english.json', stringsJson());
	console.log(`built ${ALL_PAGES.length} pages, ${KNOBS.length} levers into ${STAGE}`);
}

const [cmd] = process.argv.slice(2);
if (cmd === 'build') build();
else { console.error('usage: node tools/gen_vcmi_ui.js build'); process.exit(2); }
