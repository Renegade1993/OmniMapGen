/**
 * lever-states.test.js - a slider's three states (S358, K 2026-11-19: "the sliders always dominate and rule. The exception is "random" or "Template" those
 * defer, and allow the template to "lean""). A value the player set is law; Template, a number below the range and Random on a lever the lean draws hand
 * the lever to the lean on Classic (as if it were left out); Random on a lever the lean does not draw rolls. One case each for set, Random and Template.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { genEnv } = require('./_vcmi');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'src', 'main', 'generate-cli.js');
const { KNOBS } = require(path.join(ROOT, 'src', 'biome', 'knobs'));
const { defer } = require(path.join(ROOT, 'src', 'main', 'leverStates'));
const feel = require(path.join(ROOT, 'src', 'biome', 'classicFeel'));
const LEAN = feel.leaning();

const plan = (feelValue, args) => {
	const r = spawnSync(process.execPath, [CLI, '--layout', '1', '--w', '108', '--h', '108', '--players', '8', '--seed', '5', '--feel', String(feelValue), ...args],
		{ encoding: 'utf8', cwd: ROOT, env: genEnv(), windowsHide: true, timeout: 240000 });
	assert.strictEqual(r.status, 0, (r.stderr || '').slice(-800));
	const line = k => (r.stdout.split('\n').find(l => l.startsWith(k + ':')) || '').slice(k.length + 1).trim();
	return { settings: line('settings'), random: line('random') };
};
// the value the lean gave a lever, from the settings line ("...: mineDensity 2.5329, ...")
const leanValue = (s, key) => { const m = s.split('; feel')[1] && new RegExp('[ ,:]' + key + ' (-?[0-9.]+)').exec(s.split('; feel')[1]); return m ? Number(m[1]) : undefined; };

test('the lever states: set stays, Template and below-range go to the lean, Random goes to the lean where it draws and rolls where it does not', () => {
	const at = (bio, classic = true) => defer(bio, KNOBS, classic, LEAN);
	assert.ok(LEAN.has('mineDensity') && LEAN.has('zoneCells') && LEAN.has('decorDensity') && !LEAN.has('subterraneanNarrow'));
	assert.deepStrictEqual(at({ mineDensity: '2' }).handed, [], 'a number in range is law');
	assert.deepStrictEqual(at({ mineDensity: 'template' }).handed, ['mineDensity']);
	assert.deepStrictEqual(at({ mineDensity: '-1' }).handed, ['mineDensity'], 'one below the range is Template');
	assert.deepStrictEqual(at({ mineDensity: 'random' }).handed, ['mineDensity'], 'Random on a drawn lever hands it to the lean');
	const r = at({ subterraneanNarrow: 'random' });
	assert.deepStrictEqual(r.rolls, ['subterraneanNarrow'], 'Random on a lever the lean does not draw rolls');
	assert.ok('subterraneanNarrow' in r.opt && r.handed.length === 0);
	assert.deepStrictEqual(at({ undergroundStarts: '4' }).handed, ['undergroundStarts'], 'the Template stop of a drawn lever defers');
	assert.deepStrictEqual(at({ undergroundStarts: '2' }).handed, [], 'All Underground is law');
	assert.deepStrictEqual(at({ guardPortals: '2' }).handed, [], 'the Template stop of a lever with no lean is its own resolution');
	assert.deepStrictEqual(at({ mineDensity: 'random' }, false).rolls, ['mineDensity'], 'on a named template there is no lean, so Random rolls');
	assert.deepStrictEqual(at({ mineDensity: '-1' }, false).handed, ['mineDensity'], 'and Template is the template\'s own value');
});

test('a set lever stands, Random and Template give the lean\'s value, left out gives the same', { timeout: 900000 }, () => {
	const absent = plan(0, []);
	const base = leanValue(absent.settings, 'mineDensity');
	assert.ok(base >= 0.7, `the lean drew mines at feel 0: ${base}`);
	const set = plan(0, ['--bio.mineDensity', '2']);
	assert.ok(/changed: mineDensity 2;/.test(set.settings) && leanValue(set.settings, 'mineDensity') === undefined, `set: ${set.settings}`);
	for (const word of ['template', 'random', '-1']) {
		const s = plan(0, ['--bio.mineDensity', word]);
		assert.strictEqual(leanValue(s.settings, 'mineDensity'), base, `${word} gives the lean's mines`);
		assert.ok(/handed to the lean: mineDensity/.test(s.random), s.random);
	}
});

test('a start share set by hand is the one the zone count is worked from', { timeout: 600000 }, () => {
	const s = plan(0, ['--bio.startZoneShare', '0.3']);
	// the band's zone size from a share of 0.3: 108 x 108 x 0.7 over the 15 zones less the 8 starts
	assert.ok(/zoneCells 1166\.4[,;]/.test(s.settings), s.settings);
	assert.ok(/changed: startZoneShare 0\.3;/.test(s.settings) && leanValue(s.settings, 'startZoneShare') === undefined, s.settings);
});

test('Special buildings: Template (left out, or one below the range) lets the lean draw the count, a number is law', { timeout: 900000 }, () => {
	const old = plan(0, []), nostalgia = plan(1, []);
	assert.ok(/specialDensity 1(;|$)/.test(old.settings.replace(/(; feel.*)$/, '')), `an old-school map gets the originals' rate: ${old.settings}`);
	assert.ok(/specialDensity 0(;|$)/.test(nostalgia.settings.replace(/(; feel.*)$/, '')), `a Nostalgia map gets none: ${nostalgia.settings}`);
	const t = plan(0, ['--bio.specialDensity', '-1']);
	assert.ok(/handed to the lean: specialDensity/.test(t.random) && /specialDensity 1(;|$)/.test(t.settings.replace(/(; feel.*)$/, '')), t.settings);
	const set = plan(1, ['--bio.specialDensity', '2']);
	assert.ok(/changed: specialDensity 2;/.test(set.settings) && !/; specialDensity/.test(set.settings), `2x is law even on a Nostalgia map: ${set.settings}`);
});

test('the lobby page of Special buildings has a Template notch below the range and stores -1 (S365, DMB Dev\'s spec)', () => {
	const fs = require('fs'), os = require('os');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lever-pages-'));
	const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'gen_vcmi_ui.js'), 'build', '--pager', '--classic', '--atbegin', '--api4', '--out', dir], { encoding: 'utf8', cwd: ROOT, windowsHide: true, timeout: 120000 });
	assert.strictEqual(r.status, 0, r.stderr);
	const w = path.join(dir, 'config', 'widgets', 'mapGen');
	const slider = JSON.parse(fs.readFileSync(path.join(w, 'page_treasure.json'), 'utf8')).items.find(i => i.name === 'slider_specialDensity');
	assert.strictEqual(slider.valueMin, -0.1);
	assert.strictEqual(slider.itemsTotal, 31);
	assert.strictEqual(slider.valueDefault, -1);
	assert.deepStrictEqual(slider.valueNames, [[-1, 'vcmi.mapGen.specialDensity.stopTemplate'], [0, '']]);
	const tab = JSON.parse(fs.readFileSync(path.join(w, 'mapGenTab.json'), 'utf8'));
	assert.strictEqual(tab.defaults.params.specialDensity, -1);
	assert.strictEqual(tab.reset.params.specialDensity, -1);
	assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'config', 'omnimapgen', 'english.json'), 'utf8'))['vcmi.mapGen.specialDensity.stopTemplate'], 'Template');
	fs.rmSync(dir, { recursive: true, force: true });
});

test('every slider on the lobby pages has a Template notch below its range and starts on it; toggles, choosers with a Template stop and the map page have none (S385)', () => {
	const fs = require('fs'), os = require('os');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lever-pages2-'));
	const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'gen_vcmi_ui.js'), 'build', '--pager', '--classic', '--atbegin', '--api4', '--out', dir], { encoding: 'utf8', cwd: ROOT, windowsHide: true, timeout: 120000 });
	assert.strictEqual(r.status, 0, r.stderr);
	const w = path.join(dir, 'config', 'widgets', 'mapGen');
	const tab = JSON.parse(fs.readFileSync(path.join(w, 'mapGenTab.json'), 'utf8'));
	const sliders = [];
	for (const f of fs.readdirSync(w).filter(n => /^page_/.test(n)))
		for (const it of JSON.parse(fs.readFileSync(path.join(w, f), 'utf8')).items) if (it.type === 'slider') sliders.push(it);
	assert.ok(sliders.length >= 43, `${sliders.length} sliders`);
	for (const s of sliders) {
		const key = s.name.replace('slider_', ''), k = KNOBS.find(q => q.key === key);
		const T = Math.min(-1, Math.round((k.min - k.step) * 1e6) / 1e6);
		assert.strictEqual(s.valueMin, Math.round((k.min - k.step) * 1e6) / 1e6, `${key}: the first notch is one step below the range`);
		assert.strictEqual(s.itemsTotal, Math.round((k.max - k.min) / k.step) + 1, `${key}: one more notch`);
		assert.strictEqual(s.valueDefault, T, `${key}: the page starts on Template`);
		assert.strictEqual(tab.defaults.params[key], T, `${key}: defaults store Template`);
		assert.strictEqual(tab.reset.params[key], T, `${key}: Reset returns to Template`);
		assert.deepStrictEqual(s.valueNames[0], [T, `vcmi.mapGen.${key}.stopTemplate`]);
		assert.ok(T < k.min, `${key}: Template is below the range, which the generator reads as deferred`);
		assert.ok(defer({ [key]: String(T) }, KNOBS, true, LEAN).handed.includes(key), `${key}: the generator hands it over`);
		assert.ok(!defer({ [key]: String(k.default) }, KNOBS, true, LEAN).handed.includes(key) || k.stops && k.stops.some(([v, l]) => v === k.default && /template/i.test(l)), `${key}: its own default number is set`);
	}
	for (const key of ['roadNetwork', 'starterMines', 'guardTreasure', 'guardMines', 'guardDwellings', 'guardBottlenecks', 'mirrorLevels', 'teams', 'compOnly', 'waterContent', 'roadType', 'guardPortals', 'undergroundStarts', 'waterShape'])
		assert.ok(!sliders.some(s => s.name === 'slider_' + key), `${key} has no Template notch slider`);
	assert.ok(tab.defaults.params.teams > 0 && tab.defaults.params.roadNetwork === 1, 'toggles and the map page keep their default numbers');
	fs.rmSync(dir, { recursive: true, force: true });
});

test('a non-drawn numeric slider and a slider with names: Template gives the lever\'s default, a number stays law (S385)', { timeout: 900000 }, () => {
	for (const [key, below, set, shown] of [['stackScale', '-1', '2', 'stackScale 2'], ['monsterStrength', '-3', '2', 'monsterStrength 2'], ['borderSolidity', '-1', '0.5', 'borderSolidity 0.5']]) {
		const t = plan(0, ['--bio.' + key, below]), s = plan(0, ['--bio.' + key, set]);
		assert.ok(/handed to the lean: /.test(t.random) && t.random.includes(key), `${key}: ${t.random}`);
		assert.ok(/changed: none/.test(t.settings), `${key} at Template changes nothing: ${t.settings}`);
		assert.ok(s.settings.includes('changed: ') && s.settings.includes(shown), `${key} set: ${s.settings}`);
	}
});

test('after Reset the lobby sends every stored number and the lean still draws: Template is below the range, so nothing counts as set (S385 proof)', { timeout: 900000 }, () => {
	const fs = require('fs'), os = require('os');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lever-reset-'));
	const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'gen_vcmi_ui.js'), 'build', '--pager', '--classic', '--atbegin', '--api4', '--out', dir], { encoding: 'utf8', cwd: ROOT, windowsHide: true, timeout: 120000 });
	assert.strictEqual(r.status, 0, r.stderr);
	const tab = JSON.parse(fs.readFileSync(path.join(dir, 'config', 'widgets', 'mapGen', 'mapGenTab.json'), 'utf8'));
	// what MapGenTab.cpp:1619 to 1630 sends after Reset: every number stored under params, as --bio.<name> <value> (rivers as --rivers); the lobby's own extras are left out
	const args = [];
	for (const [k, v] of Object.entries(tab.reset.params)) if (typeof v === 'number' && k !== 'rivers' && k !== 'teams' && k !== 'compOnly' && k !== 'waterContent') args.push('--bio.' + k, String(v));
	const reset = plan(0, args), fresh = plan(0, []);
	const handed = (reset.random.match(/handed to the lean: ([^|]*)$/) || [, ''])[1].split(', ').map(s => s.trim()).filter(Boolean);
	for (const key of ['mineDensity', 'resourceDensity', 'pickupDensity', 'artifactDensity', 'artifactRichness', 'highLootRatio', 'dwellingDensity', 'bonusDensity', 'guardDensity', 'decorDensity', 'startZoneShare', 'zoneCells', 'specialDensity'])
		assert.ok(handed.includes(key), `${key} reaches the generator as Template: ${reset.random}`);
	assert.ok(handed.length >= 40, `${handed.length} levers handed over`);
	// the same lean as a map made with nothing sent: the lean's own draws, lever by lever
	const lean = s => s.split('; feel')[1];
	assert.strictEqual(lean(reset.settings), lean(fresh.settings), 'Reset gives the map the lean draws for it');
	assert.ok(/changed: none/.test(reset.settings), reset.settings);
	fs.rmSync(dir, { recursive: true, force: true });
});
