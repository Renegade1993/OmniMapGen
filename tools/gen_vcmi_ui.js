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
// --pager: the layout for a DMB framework with a generic "pages" widget (K,
// 2026-09-26: arrows either side of the title page through the screens, as
// stock H3's Random Map Setup does, in place of the page button grid). The
// widget's contract is proposed to DMB Dev and not built yet, so this writes
// to --out (default .tmp/pager) and never over the released layout.
const PAGER = process.argv.includes('--pager');
const outArg = process.argv.indexOf('--out');
const STAGE = PAGER ? path.resolve(outArg > 0 ? process.argv[outArg + 1] : path.join(ROOT, '.tmp', 'pager'))
	: path.join(ROOT, 'mod', 'Content');

// The tab fills the lobby's left panel the way VCMI's own Extra Options tab
// does: AdventureOptionsBackgroundClear from (0,6), titles centred on x 222 as
// the stock tabs centre theirs. The map page comes first, then the lever
// groups.
//
// Everything sits inside the frame that background bakes in (ADVOPTBK,
// measured on the art, 2026-09-26): a title box whose bottom border is at y
// 83-84 on screen, and below it a box whose top line is at y 89-90, with
// light frame lines at x 53 and 389; its interior is x 55-388, y 91-572. K
// saw the page buttons out of line with it: they began at x 28, across the
// left frame line, their first row lay across the title box's border, the
// separator lines ran from x 14 through the frame, and a strip of another
// texture drawn at x 378-388 left a seam down the right side. Now the eight
// page buttons are a block centred on the title (56-387), the bottom buttons
// share its edges, the lines span the interior, and the strip is gone.
const ALL_PAGES = [{ id: 'map', label: 'Map' }, ...PAGES];
const PER_ROW = 4, BTN_W = 80, BTN_GAP = 4, BTN_X0 = 56, BTN_Y0 = 96, BTN_ROW = 26;
const BTN_ROWS = Math.ceil(ALL_PAGES.length / PER_ROW);
// with the pager the rows start just inside the lower box (its top line at y 89-90)
const ROW0 = PAGER ? 104 : BTN_Y0 + BTN_ROWS * BTN_ROW + 14, ROW_H = 30;
// the stock left/right arrows (SCNRBLF / SCNRBRT, 16 px) either side of the
// title at (222,36), symmetric inside the title box (x 55-388)
const ARROW_Y = 28, ARROW_L = 66, ARROW_R = 362;
// the interior of the background's frame, which lines and hover areas span
const X_IN = 55, W_IN = 334;
// values get 80 px to the frame (388): Mediterranean, the longest name a
// value shows, is 13 characters at about 6 px each; labels keep 140 px (22)
const X_LABEL = 58, X_CTRL = 198, SLIDER_W = 104, X_VALUE = 308;
const LINE_BOTTOM = 540, BUTTON_Y = 548;

// the map settings the tab owns, and where they start
const MAP_DEFAULTS = { size: 108, underground: 0, players: 4, humans: 1, template: '', declareMods: 0 };
const SIZE_STOPS = [[36, 'S'], [72, 'M'], [108, 'L'], [144, 'XL'], [180, 'H'], [216, 'XH'], [252, 'G']];

// how a value reads on the page: every step shows as a change, so a value
// takes as many decimals as its step has (0.25 steps read 1.25x, not 1.3x)
function display(k) {
	const places = step => (String(step).split('.')[1] || '').length;
	if (k.stops && k.stops.length) return { valueNames: k.stops.map(([v], i) => [v, `vcmi.mapGen.${k.key}.stop${i}`]) };
	if (k.unit === 'x') return { valueDecimals: Math.max(1, places(k.step)), valueSuffix: 'x' };
	// Artifacts moves in 0.1% steps and reads 0.6%; shown in whole percents it
	// read 1% for ten clicks running
	if (k.min >= 0 && k.max <= 1 && k.step < 1) return { valueDisplayScale: 100, valueDecimals: Math.max(0, places(k.step) - 2), valueSuffix: '%' };
	return { valueDecimals: Math.min(3, places(k.step)) };
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
	name: `help_${id}`, type: 'hoverHelp', rect: { x: X_IN, y, w: X_CTRL - X_IN, h: 22 },
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

// one lever's row: "?" help, label, and a checkbox for an on/off lever or a
// settings-bound slider for the rest
function knobRow(k, y) {
	const setting = `persistent:mapGen/params/${k.key}`;
	if (k.stops && k.stops.length === 2 && k.min === 0 && k.max === 1)
		return [helpButton(k.key, y), rowLabel(k.key, y), checkbox(k.key, setting, y, k.default)];
	return [helpButton(k.key, y), rowLabel(k.key, y),
		...slider(k.key, setting, y, k.min, k.step, Math.round((k.max - k.min) / k.step), k.default, display(k))];
}

function pageJson(page) {
	const items = [];
	KNOBS.filter(k => k.page === page.id).forEach((k, i) => items.push(...knobRow(k, ROW0 + i * ROW_H)));
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
	// the levers that belong with the map's players (teams), as ordinary
	// levers: the tab passes every mapGen.params entry as --bio.<key>
	y += ROW_H + 4;
	for (const k of KNOBS.filter(kn => kn.page === 'map')) {
		items.push(...knobRow(k, y));
		y += ROW_H;
	}
	if (y > LINE_BOTTOM) throw new Error(`the Map page runs to ${y}, past the line at ${LINE_BOTTOM}`);
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
			// No texture strip over it: VCMI's own tabs draw DIBOXBCK at x 391-473,
			// which covered the info card's text (K, 2026-09-25); narrowed to
			// 378-388 it only drew a seam down the frame's interior (K,
			// 2026-09-26). The frame's own art is what should show there.
			{ name: 'background', type: 'picture', image: 'AdventureOptionsBackgroundClear', position: { x: 0, y: 6 } },
			// the pager: each screen's name between the stock arrows, which step
			// through the screens (the proposed generic "pages" widget, id
			// "mapGen", so another mod can add a screen of its own)
			...(PAGER ? [
				{ name: 'pages', type: 'pages', id: 'mapGen', position: { x: 0, y: 0 },
					pages: ALL_PAGES.map(p => ({ layout: `config/widgets/mapGen/page_${p.id}.json`,
						title: `vcmi.mapGen.page.${p.id}.hover` })),
					title: { font: 'big', color: 'yellow', alignment: 'center', position: { x: 222, y: 36 } },
					previous: { image: 'SCNRBLF', position: { x: ARROW_L, y: ARROW_Y } },
					next: { image: 'SCNRBRT', position: { x: ARROW_R, y: ARROW_Y } },
					remember: 'persistent:mapGen/lastPage' },
				{ name: 'labelSubTitle', type: 'label', font: 'small', alignment: 'center', color: 'white',
					text: 'vcmi.mapGen.tab.subtitle', position: { x: 222, y: 60 } },
			] : [
				{ name: 'labelTitle', type: 'label', font: 'big', alignment: 'center', color: 'yellow',
					text: 'vcmi.lobby.mapGen.hover', position: { x: 222, y: 36 } },
				{ name: 'labelSubTitle', type: 'label', font: 'small', alignment: 'center', color: 'white',
					text: 'vcmi.mapGen.tab.subtitle', position: { x: 222, y: 60 } },
				{ name: 'pageButtons', type: 'toggleGroup', position: { x: 0, y: 0 }, items: buttons,
					callback: 'activateMapGenPage' },
				{ name: 'lineTop', type: 'horizontalLine', rect: { x: X_IN, y: ROW0 - 12, w: W_IN, h: 3 } },
			]),
			{ name: 'lineBottom', type: 'horizontalLine', rect: { x: X_IN, y: LINE_BOTTOM, w: W_IN, h: 3 } },
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
		// DMB rc.2: in a network lobby with more players than the tab's Human
		// players, the framework gives each lobby player a human seat and shows
		// this instead of generate.running (one %d, the number of human seats)
		'vcmi.mapGen.generate.humans': 'Generating a map for %d human players...',
		'vcmi.mapGen.generate.failed': 'The map generator failed. See extmapgen_log.txt in the VCMI logs folder.',
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
