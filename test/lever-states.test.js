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
