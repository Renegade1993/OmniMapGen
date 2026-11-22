'use strict';
/**
 * neutral_classic.js - Classic's neutral value for every lever its lean draws, at each map size and player count (S401, K: "Yes, use the middle of the lean."; S402: "it should always
 * start with the template neutral value, and let the player adjust up or down from the middle of the bar slider").
 *
 *   node tools/neutral_classic.js        writes mod/template-info.json, templates.Classic.neutral = { "<side>": { "<players>": { lever: value } } }
 *
 * The middle of the lean: the feel 0.5 in every group and every lever halfway between its old-school ends (src/biome/classicFeel.js apply with u 0.5), on the size band of that map
 * (classicBands.resolve), one level. Special buildings are 0.5x (the lean's middle, classicFeel.specialLean at feel 0.5). The lobby reads this block for a slider in its Template state on
 * Classic; the generator still draws each map's own values from its seed (Classic differs by seed inside the lean, the neutral is its middle).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { KNOBS } = require(path.join(ROOT, 'src', 'biome', 'knobs'));
const { BIOME_DEFAULTS } = require(path.join(ROOT, 'src', 'biome', 'biomes'));
const bands = require(path.join(ROOT, 'src', 'biome', 'classicBands'));
const feel = require(path.join(ROOT, 'src', 'biome', 'classicFeel'));

const SIDES = [36, 72, 108, 144, 180, 216, 252];
const PLAYERS = [2, 4, 6, 8];

function middle(side, players) {
	const base = { ...BIOME_DEFAULTS, ...Object.fromEntries(KNOBS.filter(k => k.default !== undefined).map(k => [k.key, k.default])) };
	const ranges = Object.fromEntries(KNOBS.filter(k => !k.cli && k.min !== undefined && k.max !== undefined).map(k => [k.key, { min: k.min, max: k.max }]));
	const t = feel.feelTable();
	const band = bands.resolve(side, side, 1, base, ranges, players);
	const d = { f: 0.5, group: {}, u: {}, pockets: 0 };
	for (const [g, levers] of Object.entries(t.groups)) { d.group[g] = 0.5; for (const k of Object.keys(levers)) d.u[k] = 0.5; }
	const moved = feel.apply(d, { ...base, ...band }, ranges, { W: side, H: side, levels: 1, players });
	const out = {};
	for (const k of feel.leaning()) {
		const v = moved[k] !== undefined ? moved[k] : band[k] !== undefined ? band[k] : base[k];
		if (Number.isFinite(Number(v))) out[k] = Number(v);
	}
	out.specialDensity = feel.specialLean({ group: { dressing: 0.5 } });
	return out;
}

if (require.main === module) {
	const file = path.join(ROOT, 'mod', 'template-info.json');
	const raw = fs.readFileSync(file, 'utf8');
	const eol = raw.includes('\r\n') ? '\r\n' : '\n';
	const j = JSON.parse(raw);
	const block = {};
	for (const s of SIDES) { block[String(s)] = {}; for (const p of PLAYERS) block[String(s)][String(p)] = middle(s, p); }
	j.templates.Classic.neutral = block;
	fs.writeFileSync(file, JSON.stringify(j, null, '\t').replace(/\n/g, eol));
	console.log(`wrote Classic's neutral for ${SIDES.length} sizes and ${PLAYERS.length} player counts (${Object.keys(block['108']['4']).length} levers each)`);
}

module.exports = { middle, SIDES, PLAYERS };
