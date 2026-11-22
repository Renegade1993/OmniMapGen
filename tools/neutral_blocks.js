'use strict';
/**
 * neutral_blocks.js - the neutral value of every slider with a Template notch, and the bar range round it, for each template, map size and player count (S434, K, the fourth time: "\"Template\"
 * setting should be in the middle so the players can adjust up or down"; S386, S401, S402: "it should always start with the template neutral value, and let the player adjust up or down from the
 * middle of the bar slider").
 *
 *   node tools/neutral_blocks.js        writes mod/template-info.json: templates.<name>.neutral (the number a slider in its Template state stands for) and templates.<name>.range
 *                                       ({ lever: [low, high] }, the bar's ends: the same room up and down, so the neutral is the middle)
 *
 * neutral, Classic: the value the generator gives the lever on Classic when it is left at Template: a lever the lean draws takes the middle of the lean (neutral_classic.js middle(), S401); every other
 * lever takes the size band's value (classicBands.resolve) or its default.
 * neutral, a named template: the template's own geometry where tools/neutral_measure.js measured it (Biome size, Start biome size, Most biomes per level: kept as they are); every other live lever
 * has no number in the template's file, so the generator uses the lever's default for it (leverStates.js defer: a deferred lever on a named template is left to the template, and a template file
 * carries no value for it), and that default is the neutral. A lever that does nothing on the template (src/biome/inert.json) gets none: the lobby greys it.
 * range: r = the smaller of (neutral - min) and (max - neutral), cut down to a whole number of the lever's steps; [neutral - r, neutral + r]. No range (null) where r is under one step: the
 * neutral stands at an end of the lever's own range and a bar cannot centre it; those levers are listed in the run's output for a decision.
 * The slider list is gen_vcmi_ui.js templateNotch (the lobby build, API4 choosers); test/neutral-blocks.test.js keeps the two in step.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { KNOBS } = require(path.join(ROOT, 'src', 'biome', 'knobs'));
const { BIOME_DEFAULTS } = require(path.join(ROOT, 'src', 'biome', 'biomes'));
const INERT = require(path.join(ROOT, 'src', 'biome', 'inert.json'));
const bands = require(path.join(ROOT, 'src', 'biome', 'classicBands'));
const feel = require(path.join(ROOT, 'src', 'biome', 'classicFeel'));
const { middle } = require('./neutral_classic');

const SIDES = [36, 72, 108, 144, 180, 216, 252];
const PLAYERS = [2, 4, 6, 8];
const CHOOSERS = new Set(['waterShape', 'undergroundStarts', 'guardPortals', 'specialMode']);
const isToggle = k => !!(k.stops && k.stops.length === 2 && k.min === 0 && k.max === 1);
const NOTCHED = KNOBS.filter(k => !k.cli && !k.stock && k.page !== 'map' && !isToggle(k) && !(CHOOSERS.has(k.key) && k.stops) && !(k.stops || []).some(([, l]) => /template/i.test(l)));
const round = v => Math.round(v * 1e6) / 1e6 + 0;   // + 0: no negative zero

function classicNeutral(side, players) {
	const out = { ...middle(side, players) };
	const base = { ...BIOME_DEFAULTS, ...Object.fromEntries(KNOBS.filter(k => k.default !== undefined).map(k => [k.key, k.default])) };
	const ranges = Object.fromEntries(KNOBS.filter(k => !k.cli && k.min !== undefined && k.max !== undefined).map(k => [k.key, { min: k.min, max: k.max }]));
	const band = bands.resolve(side, side, 1, base, ranges, players);
	for (const k of NOTCHED) {
		if (out[k.key] !== undefined) continue;
		const v = band[k.key] !== undefined ? band[k.key] : base[k.key];
		if (Number.isFinite(Number(v))) out[k.key] = Number(v);
	}
	return out;
}

function rangeOf(k, n) {
	const room = Math.min(n - k.min, k.max - n);
	const r = Math.floor(room / k.step + 1e-9) * k.step;
	return r < k.step - 1e-9 ? null : [round(n - r), round(n + r)];
}

function build(info) {
	const ends = {};
	const knob = Object.fromEntries(NOTCHED.map(k => [k.key, k]));
	for (const [name, t] of Object.entries(info.templates)) {
		const had = t.neutral;
		const named = name !== 'Classic' && !!had;
		if (name !== 'Classic' && !had) continue;
		const neutral = {}, range = {};
		for (const s of SIDES) {
			neutral[s] = {}; range[s] = {};
			for (const p of PLAYERS) {
				let n;
				if (name === 'Classic') n = classicNeutral(s, p);
				else {
					n = { ...((had[s] || {})[p] || {}) };
					const base = { ...BIOME_DEFAULTS, ...Object.fromEntries(KNOBS.filter(k => k.default !== undefined).map(k => [k.key, k.default])) };
					for (const k of NOTCHED) {
						if (n[k.key] !== undefined) continue;
						const inert = INERT[k.key] || {};
						if (inert[name] || inert['*named']) continue;
						if (Number.isFinite(Number(base[k.key]))) n[k.key] = Number(base[k.key]);
					}
					// Special buildings on a named template: Template is none (S366, K: "Coldshadow none; slide up to add"), not the lever's default of 1
					if (n.specialDensity !== undefined) n.specialDensity = 0;
				}
				const r = {};
				for (const [key, v] of Object.entries(n)) {
					if (!knob[key]) continue;
					const rg = rangeOf(knob[key], v);
					r[key] = rg;
					if (!rg) (ends[name] = ends[name] || new Set()).add(key);
				}
				neutral[s][p] = n; range[s][p] = r;
			}
		}
		t.neutral = neutral; t.range = range;
	}
	return ends;
}

if (require.main === module) {
	const file = path.join(ROOT, 'mod', 'template-info.json');
	const raw = fs.readFileSync(file, 'utf8');
	const eol = raw.includes('\r\n') ? '\r\n' : '\n';
	const j = JSON.parse(raw);
	const ends = build(j);
	// a range is written on one line, "lever": [low, high]
	const text = JSON.stringify(j, null, '\t').replace(/\[\s+(-?[\d.e+-]+),\s+(-?[\d.e+-]+)\s+\]/g, '[$1, $2]');
	fs.writeFileSync(file, text.replace(/\n/g, eol));
	for (const [name, set] of Object.entries(ends)) console.log(`${name}: neutral at an end of the lever's range (no centred bar): ${[...set].join(', ')}`);
	for (const [name, t] of Object.entries(j.templates)) if (t.neutral) console.log(`${name}: ${Object.keys(t.neutral['108']['4']).length} neutral values at 108 wide, four players`);
}

module.exports = { NOTCHED, classicNeutral, rangeOf, build };
