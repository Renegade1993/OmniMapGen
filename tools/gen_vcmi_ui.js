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
// --pager: the layout for DMB's "pages" widget (K, 2026-09-26: arrows either
// side of the title page through the screens, as stock H3's Random Map Setup
// does, in place of the page button grid). The widget is DMB's addon API level
// 2 (docs/modders/DMB_UI_Modding.md), which no DMB release carries yet, so
// this writes to --out (default .tmp/pager) and never over the released
// layout; make_mod.js --pager packages it.
// --classic: the same pages in stock Heroes III's Random Map Setup look (K,
// 2026-09-26), on its own background with DMB's blank stock buttons; implies
// --pager, and writes to --out (default .tmp/classic).
// --atbegin: the map is made when the game begins, as stock's random map is
// (DMB's addon API level 3: mapGenerator "atBegin"): the host presses Begin,
// every player's town reaches the generator, and the finished map goes to
// every player (K, 2026-09-27: "set the map settings, set your town, begin
// game, generate the map"). So the tab has no Generate button, and the mode
// is "Omni Map Gen", K's name for it. Implies --pager; with --classic too,
// Defaults takes the whole gold bar.
const CLASSIC = process.argv.includes('--classic');
const AT_BEGIN = process.argv.includes('--atbegin');
const PAGER = CLASSIC || AT_BEGIN || process.argv.includes('--pager');
const outArg = process.argv.indexOf('--out');
const STAGE = PAGER ? path.resolve(outArg > 0 ? process.argv[outArg + 1]
	: path.join(ROOT, '.tmp', CLASSIC ? 'classic' : AT_BEGIN ? 'atbegin' : 'pager'))
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
const ARROW_Y = CLASSIC ? 24 : 28, ARROW_L = 66, ARROW_R = 362;
// the interior of the background's frame, which lines and hover areas span
// (--classic: the inside of RANMAPBK's bands, x 66-378)
const X_IN = CLASSIC ? 66 : 55, W_IN = 334;
// values get 80 px to the frame (388): Mediterranean, the longest name a
// value shows, is 13 characters at about 6 px each; labels keep 140 px (22).
// In the bands, 78 px to their right line (x 379), and 136 px for a label
// ("Passages without road", 21 characters).
const X_LABEL = CLASSIC ? 68 : 58, X_CTRL = CLASSIC ? 204 : 198, SLIDER_W = CLASSIC ? 90 : 104,
	X_VALUE = CLASSIC ? 300 : 308;
const LINE_BOTTOM = 540, BUTTON_Y = 548;

// --classic geometry, measured on RANMAPBK (drawn at 0,6): the title box, the
// Map Size box (x 55-155, y 81-113) with the size strip beside it, and six
// bands, each a header strip over a control strip: band tops at screen y
// 129/195/261/327/394/461, dividers 151/217/283/349/417/483, bottoms
// 185/251/317/383/451/517. The stock tab puts a band's header text at
// BAND_HEAD and its buttons (32 high) at BAND_CTRL. Every page shares the
// tab's background (the pages widget draws a page over its own title and
// arrows, so a page cannot bring one), so a lever page lays its rows into the
// bands, two a band: one in the header strip, one in the control strip.
const BAND_HEAD = [133, 199, 265, 331, 398, 465];
const BAND_CTRL = [153, 219, 285, 351, 419, 485];
const classicRowTop = i => (i % 2 ? BAND_CTRL[i >> 1] + 5 : BAND_HEAD[i >> 1] - 5);
// levers the classic Map page shows in a stock band of its own (the stock
// tab's Monster Strength), and levers stock's own choices replace there (its
// three road toggles pave as Road type did), so neither is on its lever page
const CLASSIC_ON_MAP = new Set(['monsterStrength', 'roadType']);
// VCMI Extras' art for the classic Map page (its extended lobby's background,
// template box and field, size and two-level icons, Setup button and blue
// checkbox): the look K plays with. DMB is asked (2026-09-27) to supply these
// or say how a layout names them when that mod is off; they change here only.
const EXTRAS_ART = {
	background: 'RanMapBk_new', templateBox: 'RmgTTBk', templateField: 'DrDoCoBk',
	sizes: ['RandSizS', 'RandSizM', 'RandSizL', 'RandSizXL', 'RandSizH', 'RandSizXH', 'RandSizG'], customSize: 'RandSizC',
	twoLevels: 'RANDUND', setupButton: 'HWBUT2', checkbox: 'ChkBlue',
};
// the pages widget's title and arrows: the classic background's title box is
// the extended lobby's slim one (screen y 21-46), whose title sits at y 32
const TITLE_Y = CLASSIC ? 32 : 36;

// the map settings the tab owns, and where they start
const MAP_DEFAULTS = { size: 108, underground: 0, players: 4, humans: 1, template: '', declareMods: 0 };
const SIZE_STOPS = [[36, 'S'], [72, 'M'], [108, 'L'], [144, 'XL'], [180, 'H'], [216, 'XH'], [252, 'G']];
// Each size's tooltip gives a scale a player can feel (K, 2026-09-27): a new
// hero's days to cross the map corner to corner over open grass with nothing
// in the way. A diagonal step there costs 141 (CPathfinder.cpp: the step's 100
// times the square root of 2), and a hero whose slowest creature has speed 4
// moves 1560 a day (config/gameConfig.json, movementPointsLand).
const SIZE_NAMES = { S: 'Small', M: 'Medium', L: 'Large', XL: 'Extra large', H: 'Huge', XH: 'Extra huge', G: 'Giant' };
const crossingDays = v => Math.round(141 * (v - 1) / 1560);

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
	const knobs = KNOBS.filter(k => k.page === page.id && !(CLASSIC && CLASSIC_ON_MAP.has(k.key)));
	if (CLASSIC && knobs.length > 2 * BAND_HEAD.length)
		throw new Error(`the ${page.id} page has ${knobs.length} levers, more than six bands hold`);
	knobs.forEach((k, i) => items.push(...knobRow(k, CLASSIC ? classicRowTop(i) : ROW0 + i * ROW_H)));
	return { library: ['config/widgets/commonPrimitives.json'], items };
}

/**
 * The classic Map page, laid out as the game's Random Map Setup looks with
 * the VCMI Extras mod's extended lobby (the screen K plays with, 2026-09-27),
 * with every choice stock offers there: the template; the seven map sizes
 * with the two-level toggle last in the same row; human or computer players
 * and computer only players, each with Random; team alignments; the three
 * road types; water content and monster strength, each with Random. Mod
 * content, which stock has no screen for, shares the team band. K's rule: the
 * tab may do more than stock, never less.
 *
 * The RANNUM, RANRAND, RANNONE, RANNORM and RANISLD buttons and the road
 * sprites are the game's own; RanButton50 and the gold bars are DMB's blank
 * stock buttons; the rest is VCMI Extras' art, named in EXTRAS_ART.
 */
function classicMapPageJson() {
	const items = [];
	const help = id => ({ hover: `vcmi.mapGen.${id}.hover`, help: `vcmi.mapGen.${id}.help` });
	const word = (text, font = 'big') => [{ type: 'label', font, alignment: 'center', color: 'yellow', text }];
	const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
	// a band's header, white on the header strip as the stock tab writes them
	const head = (n, id, x = X_LABEL, w = 312) => [
		{ name: `help_${id}`, type: 'hoverHelp', rect: { x: x - 2, y: BAND_HEAD[n] - 3, w, h: 18 }, help: help(id) },
		{ name: `label_${id}`, type: 'label', font: 'small', alignment: 'left', color: 'white',
			text: `vcmi.mapGen.${id}.hover`, position: { x, y: BAND_HEAD[n] } }];
	// a row of choices, settings-bound: items[i] stores values[i]; stock's
	// word buttons wear the gold frame when chosen (imageOrder), RANRAND and
	// the number buttons draw their own
	const group = (name, pos, setting, values, def, imageOf, xs, words, font, helpOf) => ({
		name, type: 'toggleGroup', position: pos, setting, values, selected: Math.max(0, values.indexOf(def)),
		items: values.map((v, i) => {
			const image = imageOf(v, i);
			return { index: i, type: 'toggleButton', image,
				...(/^(RANNUM|RANRAND)/.test(image) ? {} : { imageOrder: [0, 1, 1, 3] }),
				position: { x: xs[i], y: 0 }, help: help(helpOf ? helpOf(i) : name.replace(/^group_/, '')),
				...(words && words[i] ? { items: word(words[i], font) } : {}) };
		}),
	});
	const knob = key => KNOBS.find(k => k.key === key);

	// the template row: the stock box and label, and the field that opens the chooser
	items.push({ name: 'boxTemplate', type: 'picture', image: EXTRAS_ART.templateBox, position: { x: 54, y: 56 } },
		{ name: 'label_map.template', type: 'label', font: 'small', alignment: 'center', color: 'white',
			text: 'vcmi.mapGen.template.hover', position: { x: 104, y: 66 } },
		{ name: 'buttonChooseTemplate', type: 'button', image: EXTRAS_ART.templateField, imageOrder: [0, 0, 0, 0],
			position: { x: 158, y: 56 }, callback: 'chooseMapGenTemplate', help: help('map.template') },
		// DMB's settings-bound label (addon API 2): the stored template, or the short "none" line
		{ name: 'labelTemplate', type: 'label', font: 'small', alignment: 'center', color: 'white',
			setting: 'persistent:mapGen/map/template', emptyText: 'vcmi.mapGen.template.noneShort',
			// the chooser's Random stores "random"; the label says so in words (API 3)
			...(AT_BEGIN ? { valueTexts: { random: 'vcmi.mapGen.template.random' } } : {}),
			position: { x: 262, y: 66 } });
	// the size row, 37 px apart from x 54, and the two-level toggle last in it (x 350)
	// each size its own tooltip, with the days a new hero takes to cross it
	items.push(group('group_map.size', { x: 54, y: 81 }, 'persistent:mapGen/map/size', SIZE_STOPS.map(([v]) => v),
		MAP_DEFAULTS.size, (v, i) => EXTRAS_ART.sizes[i], SIZE_STOPS.map((_, i) => i * 37),
		undefined, undefined, i => `map.size.s${i}`),
		{ name: 'check_map.underground', type: 'toggleButton', image: EXTRAS_ART.twoLevels, imageOrder: [0, 1, 1, 3],
			position: { x: 350, y: 81 }, setting: 'persistent:mapGen/map/underground',
			selected: !!MAP_DEFAULTS.underground, help: help('map.underground') });
	// C, the custom size window, where the extended lobby has it (DMB API 3:
	// map/width and map/height, and map/size 0 so the row shows none)
	if (AT_BEGIN)
		items.push({ name: 'buttonCustomSize', type: 'button', image: EXTRAS_ART.customSize,
			position: { x: 313, y: 81 }, callback: 'chooseMapGenCustomSize', help: help('map.size.custom') });
	// the players: stock's two bands, each with Random (-1)
	const numbersAndRandom = from => [...range(0, 7).map(i => i * 32), 256];
	items.push(...head(0, 'map.humans'),
		group('group_map.humans', { x: 67, y: BAND_CTRL[0] }, 'persistent:mapGen/map/humans', [...range(1, 8), -1],
			MAP_DEFAULTS.humans, v => (v < 0 ? 'RANRAND' : `RANNUM${v}`), numbersAndRandom()));
	items.push(...head(1, 'compOnly'),
		group('group_compOnly', { x: 67, y: BAND_CTRL[1] }, 'persistent:mapGen/params/compOnly', [...range(0, 7), -1],
			knob('compOnly').default, v => (v < 0 ? 'RANRAND' : `RANNUM${v}`), numbersAndRandom()));
	// team alignments (DMB's grid, one team a player) and, beside them, mod content
	items.push(...head(2, 'map.teams', X_LABEL, 150), ...head(2, 'map.declareMods', 228, 150),
		{ name: 'buttonTeams', type: 'button', image: EXTRAS_ART.setupButton, position: { x: 73, y: 292 },
			callback: 'chooseMapGenTeams', help: help('map.teams'),
			items: [{ type: 'label', font: 'small', alignment: 'center', color: 'yellow', text: 'vcmi.mapGen.map.teams.setup' }] },
		{ name: 'check_map.declareMods', type: 'toggleButton', image: EXTRAS_ART.checkbox, position: { x: 228, y: 290 },
			setting: 'persistent:mapGen/map/declareMods', selected: !!MAP_DEFAULTS.declareMods, help: help('map.declareMods') },
		{ name: 'label_map.declareMods.use', type: 'label', font: 'small', alignment: 'left', color: 'white',
			text: 'vcmi.mapGen.map.declareMods.use', position: { x: 263, y: 294 } });
	// the road types: stock's three toggles, each beside its road
	items.push(...head(3, 'map.roads'));
	['roadDirt', 'roadGravel', 'roadCobblestone'].forEach((key, i) => items.push(
		{ name: `check_${key}`, type: 'toggleButton', image: EXTRAS_ART.checkbox, position: { x: 67 + 100 * i, y: 354 },
			setting: `persistent:mapGen/params/${key}`, selected: !!knob(key).default, help: help(key) },
		{ name: `road_${key}`, type: 'animation', image: ['dirtrd', 'gravrd', 'cobbrd'][i], position: { x: 117 + 100 * i, y: 354 },
			frames: { start: 13, end: 13 } }));
	// water content and monster strength, each with Random
	items.push(...head(4, 'waterContent'),
		group('group_waterContent', { x: 67, y: BAND_CTRL[4] }, 'persistent:mapGen/params/waterContent', [0, 1, 2, -1],
			knob('waterContent').default, v => ({ 0: 'RANNONE', 1: 'RANNORM', 2: 'RANISLD' }[v] || 'RANRAND'), [0, 85, 170, 256]));
	// our five strengths on DMB's 50 px blanks where stock has three, then stock's Random (-9)
	const strength = knob('monsterStrength');
	items.push(...head(5, 'monsterStrength'),
		group('group_monsterStrength', { x: 67, y: BAND_CTRL[5] }, 'persistent:mapGen/params/monsterStrength',
			[...strength.stops.map(([v]) => v), -9], strength.default, v => (v === -9 ? 'RANRAND' : 'RanButton50'),
			[0, 51, 102, 153, 204, 256], strength.stops.map((_, i) => `vcmi.mapGen.monsterStrength.word${i}`), 'small'));
	return { library: ['config/widgets/commonPrimitives.json'], items };
}

/** The map page: what the Random Map tab asks, in this tab's own settings. */
function mapPageJson() {
	const items = [];
	let y = ROW0;
	// the template first, where stock's Random Map Setup has it (K, 2026-09-27)
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
	y += ROW_H + 4;
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
	// the levers that belong with the map's players (teams), as ordinary
	// levers: the tab passes every mapGen.params entry as --bio.<key>
	y += 44;
	// (not the stock choices, which only the classic Map page lays out)
	for (const k of KNOBS.filter(kn => kn.page === 'map' && !kn.stock)) {
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
	// the released tab leaves the stock choices unset, so the generator never
	// sees a computer-only count beside that tab's own player count
	for (const k of KNOBS) if (CLASSIC || !k.stock) params[k.key] = k.default;
	return {
		library: ['config/widgets/commonPrimitives.json'],
		// the page list the page buttons show; the pages widget carries its own
		...(PAGER ? {} : { pages: ALL_PAGES.map(p => `config/widgets/mapGen/page_${p.id}.json`) }),
		// the preset Defaults returns to, which the client no longer assumes
		defaults: { params, map: MAP_DEFAULTS, preset: 'nostalgia' },
		items: [
			// No texture strip over it: VCMI's own tabs draw DIBOXBCK at x 391-473,
			// which covered the info card's text (K, 2026-09-25); narrowed to
			// 378-388 it only drew a seam down the frame's interior (K,
			// 2026-09-26). The frame's own art is what should show there.
			{ name: 'background', type: 'picture', image: CLASSIC ? EXTRAS_ART.background : 'AdventureOptionsBackgroundClear', position: { x: 0, y: 6 } },
			// the pager: each screen's name between the stock arrows, which step
			// through the screens (DMB's "pages" widget; named "pages" so
			// MapGenTab drives it, id "mapGen" so another mod's tabPages can add
			// a screen of its own)
			...(PAGER ? [
				{ name: 'pages', type: 'pages', id: 'mapGen', position: { x: 0, y: 0 },
					pages: ALL_PAGES.map(p => ({ layout: `config/widgets/mapGen/page_${p.id}.json`,
						title: `vcmi.mapGen.page.${p.id}.hover` })),
					title: { font: 'big', color: 'yellow', alignment: 'center', position: { x: 222, y: TITLE_Y } },
					previous: { image: 'SCNRBLF', position: { x: ARROW_L, y: ARROW_Y } },
					next: { image: 'SCNRBRT', position: { x: ARROW_R, y: ARROW_Y } },
					remember: 'persistent:mapGen/lastPage' },
				// the classic title box is one line tall, and the template row sits below it
				...(CLASSIC ? [] : [{ name: 'labelSubTitle', type: 'label', font: 'small', alignment: 'center', color: 'white',
					text: 'vcmi.mapGen.tab.subtitle', position: { x: 222, y: 60 } }]),
			] : [
				{ name: 'labelTitle', type: 'label', font: 'big', alignment: 'center', color: 'yellow',
					text: 'vcmi.lobby.mapGen.hover', position: { x: 222, y: 36 } },
				{ name: 'labelSubTitle', type: 'label', font: 'small', alignment: 'center', color: 'white',
					text: 'vcmi.mapGen.tab.subtitle', position: { x: 222, y: 60 } },
				{ name: 'pageButtons', type: 'toggleGroup', position: { x: 0, y: 0 }, items: buttons,
					callback: 'activateMapGenPage' },
				{ name: 'lineTop', type: 'horizontalLine', rect: { x: X_IN, y: ROW0 - 12, w: W_IN, h: 3 } },
			]),
			// classic: the stock tab's gold bar (RANSHOW's place, 54,535), as two
			// halves of DMB's blank one, lettered black as RANSHOW is
			...(CLASSIC ? [
				{ name: 'defaultsButton', type: 'button', image: 'RanShowButton166',
					position: { x: 54, y: 535 },
					help: { hover: 'vcmi.mapGen.defaults.hover', help: 'vcmi.mapGen.defaults.help' },
					callback: 'resetMapGenDefaults',
					items: [{ type: 'label', font: 'big', alignment: 'center', color: [0, 0, 0, 255],
						text: 'vcmi.mapGen.defaults.hover' }] },
				// at Begin the game makes the map, so no Generate: the player's own
				// presets take its half of the gold bar (DMB API 3, K's "save and load
				// presets"), two of the stock word buttons side by side
				...(AT_BEGIN ? ['save', 'load'].map((k, i) => ({
					name: `${k}PresetButton`, type: 'button', image: 'RanButton83', position: { x: 224 + i * 83, y: 539 },
					help: { hover: `vcmi.mapGen.presets.${k}.hover`, help: `vcmi.mapGen.presets.${k}.help` },
					callback: k === 'save' ? 'saveMapGenPreset' : 'loadMapGenPreset',
					items: [{ type: 'label', font: 'medium', alignment: 'center', color: 'yellow',
						text: `vcmi.mapGen.presets.${k}.word` }] })) : [
				// at Begin the game makes the map: no Generate
				{ name: 'generateButton', type: 'button', image: 'RanShowButton166', position: { x: 225, y: 535 },
					help: { hover: 'vcmi.mapGen.generate.hover', help: 'vcmi.mapGen.generate.help' },
					callback: 'generateMapGenMap',
					items: [{ type: 'label', font: 'big', alignment: 'center', color: [0, 0, 0, 255],
						text: 'vcmi.mapGen.generate.hover' }] }]),
			] : [
			{ name: 'lineBottom', type: 'horizontalLine', rect: { x: X_IN, y: LINE_BOTTOM, w: W_IN, h: 3 } },
			{ name: 'defaultsButton', type: 'button', image: 'MapGenButton80',
				position: { x: BTN_X0, y: BUTTON_Y },
				help: { hover: 'vcmi.mapGen.defaults.hover', help: 'vcmi.mapGen.defaults.help' },
				callback: 'resetMapGenDefaults',
				items: [{ type: 'label', font: 'small', alignment: 'center', color: 'yellow',
					text: 'vcmi.mapGen.defaults.hover' }] },
			...(AT_BEGIN ? ['save', 'load'].map((k, i) => ({
				name: `${k}PresetButton`, type: 'button', image: 'MapGenButton80', position: { x: X_CTRL + i * 90, y: BUTTON_Y },
				help: { hover: `vcmi.mapGen.presets.${k}.hover`, help: `vcmi.mapGen.presets.${k}.help` },
				callback: k === 'save' ? 'saveMapGenPreset' : 'loadMapGenPreset',
				items: [{ type: 'label', font: 'small', alignment: 'center', color: 'yellow',
					text: `vcmi.mapGen.presets.${k}.word` }] })) : [
			{ name: 'generateButton', type: 'button', image: 'MapGenButton190',
				position: { x: X_CTRL, y: BUTTON_Y },
				help: { hover: 'vcmi.mapGen.generate.hover', help: 'vcmi.mapGen.generate.help' },
				callback: 'generateMapGenMap',
				items: [{ type: 'label', font: 'medium', alignment: 'center', color: 'yellow',
					text: 'vcmi.mapGen.generate.hover' }] }]),
			]),
		],
	};
}

function stringsJson() {
	const s = {
		'vcmi.lobby.mapGen.hover': AT_BEGIN ? 'Omni Map Gen' : 'MapGen',
		'vcmi.lobby.mapGen.help': AT_BEGIN
			? '{Omni Map Gen}\n\nOur own random map generator with every one of its settings: the map, biomes, borders, treasure, monsters, underground, scenery and water. The map is made when the game begins, from these settings and the town each player picks.'
			: '{MapGen}\n\nOur own random map generator with every one of its settings: the map, biomes, borders, treasure, monsters, underground, scenery and water. Generate makes a map and selects it in the scenario list.',
		'vcmi.mapGen.tab.subtitle': 'Every setting of our own map generator',
		// the Begin build's own buttons and texts (DMB API 3)
		...(AT_BEGIN ? {
			'vcmi.mapGen.presets.save.word': 'Save',
			'vcmi.mapGen.presets.save.hover': 'Save these settings',
			'vcmi.mapGen.presets.save.help': '{Save these settings}\n\nKeeps every setting on these pages under a name you choose, to load again later.',
			'vcmi.mapGen.presets.load.word': 'Load',
			'vcmi.mapGen.presets.load.hover': 'Load saved settings',
			'vcmi.mapGen.presets.load.help': '{Load saved settings}\n\nReplaces every setting on these pages with a set you saved.',
			'vcmi.mapGen.map.size.custom.hover': 'Custom size',
			'vcmi.mapGen.map.size.custom.help': '{Custom size}\n\nAny width and height you type, and one or two levels, instead of the sizes in the row.',
			'vcmi.mapGen.template.random': '(Random)',
		} : {}),
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
		// the chooser's description line, empty: every template runs at any size,
		// level count and player count now (the generator accommodates them, K,
		// 2026-09-27), so the old "templates that take this map size" line was
		// no longer true, and it overflowed the dialog. MapGenTab shows ours
		// whenever the key exists, even empty.
		'vcmi.mapGen.template.choose': '',
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
		'vcmi.mapGen.map.size.help': '{Map size}\n\nS 36, M 72, L 108, XL 144, H 180, XH 216 or G 252 cells a side. A new hero crosses one corner to corner in about '
			+ SIZE_STOPS.map(([v]) => crossingDays(v)).join(', ').replace(/, (\d+)$/, ' or $1') + ' days, over open grass with nothing in the way.',
		'vcmi.mapGen.map.underground.hover': 'Underground',
		'vcmi.mapGen.map.underground.help': '{Underground}\n\nA second, underground level linked to the surface by subterranean gates.',
		'vcmi.mapGen.map.declareMods.hover': 'Use mod content',
		'vcmi.mapGen.map.declareMods.help': '{Use mod content}\n\nPlace modded terrain, creature banks and dwellings from your installed mods, and declare them in the map so VCMI requires the same mods to open it. Off makes a map that loads anywhere, core content only.',
		'vcmi.mapGen.map.players.hover': 'Players',
		'vcmi.mapGen.map.players.help': '{Players}\n\nHow many players the map has, human and computer together.',
		'vcmi.mapGen.map.humans.hover': 'Human players',
		'vcmi.mapGen.map.humans.help': '{Human players}\n\nHow many of those seats a human can take. The rest are computer players.',
		'vcmi.mapGen.map.template.hover': 'Template',
		'vcmi.mapGen.map.template.help': '{Template}\n\nThe biome layout. Free layout is our own, calibrated on your own random maps; the game\'s templates (Jebus Cross, Coldshadow\'s Fantasy and the rest) lay the biomes out their way, with the settings on the other pages still applied.',
	};
	if (CLASSIC) {
		// the classic Map page names its bands as the game's Random Map Setup does
		s['vcmi.mapGen.template.noneShort'] = 'No template: free layout';
		s['vcmi.mapGen.map.humans.hover'] = 'Human or computer players';
		s['vcmi.mapGen.map.humans.help'] = '{Human or computer players}\n\nSeats a human can take, or the computer when no human does. Random rolls a count the template takes.';
		s['vcmi.mapGen.map.teams.hover'] = 'Team alignments';
		s['vcmi.mapGen.map.teams.help'] = '{Team alignments}\n\nWhich players are allied: each player on a team of its own, or with others.';
		s['vcmi.mapGen.map.teams.setup'] = 'Setup...';
		s['vcmi.mapGen.map.declareMods.hover'] = 'Mod content';
		s['vcmi.mapGen.map.declareMods.use'] = 'Use mod content';
		s['vcmi.mapGen.map.roads.hover'] = 'Road types';
		s['vcmi.mapGen.map.roads.help'] = '{Road types}\n\nThe roads are paved with the best type left on, cobblestone first, as the game\'s generator does; with none on there are no roads.';
		['Weakest', 'Weak', 'Normal', 'Strong', 'Strongest'].forEach((w, i) => { s[`vcmi.mapGen.monsterStrength.word${i}`] = w; });
	}
	// after the lever texts below: the classic band says what stock's does
	const classicLabels = CLASSIC ? { 'vcmi.mapGen.monsterStrength.hover': 'Monster strength' } : {};
	SIZE_STOPS.forEach(([v, name], i) => {
		s[`vcmi.mapGen.map.size.stop${i}`] = name;
		s[`vcmi.mapGen.map.size.s${i}.hover`] = `${SIZE_NAMES[name]}, ${v}x${v}`;
		s[`vcmi.mapGen.map.size.s${i}.help`] = `{${SIZE_NAMES[name]}, ${v}x${v}}\n\nA new hero crosses it corner to corner `
			+ `in about ${crossingDays(v)} days over open grass, with nothing in the way. A cobblestone road halves that; `
			+ 'rough ground, sand, snow and swamp stretch it.';
	});
	for (const p of ALL_PAGES) {
		s[`vcmi.mapGen.page.${p.id}.hover`] = p.label;
		s[`vcmi.mapGen.page.${p.id}.help`] = `{${p.label}}\n\nShow the ${p.label.toLowerCase()} settings.`;
	}
	for (const k of KNOBS) {
		if (k.stock && !CLASSIC) continue;
		s[`vcmi.mapGen.${k.key}.hover`] = k.label;
		s[`vcmi.mapGen.${k.key}.help`] = `{${k.label}}\n\n${k.help}`;
		(k.stops || []).forEach(([, name], i) => { s[`vcmi.mapGen.${k.key}.stop${i}`] = name; });
	}
	return { ...s, ...classicLabels };
}

function build() {
	const dir = path.join(STAGE, 'config/widgets/mapGen');
	fs.mkdirSync(dir, { recursive: true });
	for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));   // no stale pages
	const write = (rel, obj) => fs.writeFileSync(path.join(STAGE, rel), JSON.stringify(obj, null, '\t') + '\n');
	write('config/widgets/mapGen/mapGenTab.json', tabJson());
	write('config/widgets/mapGen/page_map.json', CLASSIC ? classicMapPageJson() : mapPageJson());
	for (const p of PAGES) write(`config/widgets/mapGen/page_${p.id}.json`, pageJson(p));
	fs.mkdirSync(path.join(STAGE, 'config/omnimapgen'), { recursive: true });
	write('config/omnimapgen/english.json', stringsJson());
	console.log(`built ${ALL_PAGES.length} pages, ${KNOBS.length} levers into ${STAGE}`);
}

const [cmd] = process.argv.slice(2);
if (cmd === 'build') build();
else { console.error('usage: node tools/gen_vcmi_ui.js build'); process.exit(2); }
