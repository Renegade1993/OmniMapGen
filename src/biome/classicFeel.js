'use strict';
/**
 * Classic draws each map's feel at random (K, 2026-11-19, S340): "Classic is basically supposed to be a catch-all, random generator that see's
 * VCMI/HOTA's nostalgia, and raises it all-in. It should throw a lot of map phenomena from old scenarios, but at random. some should feel exactly like
 * old school heroes, some should feel like VCMI/HOTA nostalgia, but not all."
 *
 * A map draws one number from its seed, its feel f: 0 is an old-school scenario, 1 the Nostalgia band (classicBands.js). Four lever groups (layout,
 * economy, danger, dressing) each take f plus a small offset of their own, so a map in the middle can mix (a Nostalgia-shaped layout with an
 * old-school economy). A lever's value is its Nostalgia value (the band, or the lever's own default) blended toward its old-school value by
 * 1 - the group's feel; the old-school value is drawn per lever between the two ends measured on the 157 original scenarios (their 10th and 90th
 * percentile of the property the lever moves, per ground tile, S226), so the old-school end is a spread and not a point. The table is in
 * mod/template-info.json (Classic, originalPreferences.feel). A lever the player moved is never touched. The draw uses a stream of its own, so it moves
 * nothing else; VMAPGEN_FEEL=0..1 (or --feel) fixes f for pictures and tests, and VMAPGEN_CLASSIC_FEEL=0 turns the draw off (the proof arm).
 */
const fs = require('fs');

let table; // undefined: not read; null: none
function feelTable() {
	if (table !== undefined) return table;
	table = null;
	try {
		const tpl = require('../rmg/template');
		const name = tpl.openLayoutNames()[0];
		const j = JSON.parse(fs.readFileSync(tpl.templateInfoFile(), 'utf8')).templates || {};
		const t = j[name] && j[name].originalPreferences && j[name].originalPreferences.feel;
		if (t && t.groups) table = t;
	} catch { /* no info file: no draw */ }
	return table;
}

function stream(seed) {
	let s = (Number(seed) * 2654435761 + 0x5ee1f00d) >>> 0;
	return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const clamp01 = v => Math.max(0, Math.min(1, v));

/** The draw for a seed: { f, group: { name: feel }, u: { lever: 0..1 } }. forced fixes f and drops the group offsets (pictures, tests). */
function draw(seed, forced, side) {
	const t = feelTable();
	if (!t || process.env.VMAPGEN_CLASSIC_FEEL === '0') return null;
	const rnd = stream(seed);
	rnd(); rnd();
	const end = t.ends || { oldSchool: 0.2, nostalgia: 0.2, span: 0.15 };
	let f;
	const r = rnd(), a = rnd();
	if (forced !== undefined && forced !== null && Number.isFinite(Number(forced))) f = clamp01(Number(forced));
	else if (r < end.oldSchool) f = a * end.span;
	else if (r < end.oldSchool + end.nostalgia) f = 1 - end.span + a * end.span;
	else f = end.span + a * (1 - 2 * end.span);
	const group = {}, u = {};
	for (const g of Object.keys(t.groups)) {
		const off = (rnd() * 2 - 1) * (t.offset === undefined ? 0.25 : t.offset);
		group[g] = forced !== undefined && forced !== null && Number.isFinite(Number(forced)) ? f : clamp01(f + off);
		for (const k of Object.keys(t.groups[g])) u[k] = rnd();
	}	// keymaster pockets: one map in five (K, S343; S340 had one in four): about a third of the old-school half, a twelfth of the Nostalgia half; 1 to 3 colours, mostly 1.
	// Today only a one-level map gets one (keymaster.js), so over all maps the rate is lower until two levels are covered.
	const rk = rnd(), rn = rnd();
	// K's one map in five is the pockets placed, not drawn (the lead, 2026-11-19): on 200 seeds at 108 wide 23.0 percent drawn and 21.5 placed, at 72 wide 23.0 drawn and 13.5 placed (a 72 map has few
	// neutral zones to shut), so the draw is raised on a map under 108 wide, by half at 72 and by one more half at 36 (keymaster.js drops what it cannot place)
	const boost = side && side < 108 ? 1 + 0.5 * (108 - side) / 36 : 1;
	const pockets = rk < (f < 0.5 ? 0.32 : 0.08) * boost ? (rn < 0.6 ? 1 : rn < 0.9 ? 2 : 3) : 0;
	return { f, group, u, pockets };
}

// levers whose draw is a whole number (their slider steps by one)
const WHOLE = new Set(['monsterStrength']);

/** The levers the draw moves, given the draw and the values the levers have now (band or default): { lever: value }. */
function apply(d, current, range, ctx) {
	const t = feelTable(), out = {};
	if (!t || !d) return out;
	const area = ctx ? ctx.W * ctx.H * Math.max(1, ctx.levels || 1) : 0, players = ctx ? Math.max(1, Math.min(8, ctx.players || 8)) : 8;
	// a lever the player set stands as it is, and it is the value the zone count below is worked from (S358: a start share set by hand was blended toward the old-school share first)
	const named = (ctx && ctx.named) || {};
	const isNamed = k => named[k] !== undefined && Number.isFinite(Number(named[k]));
	for (const [g, levers] of Object.entries(t.groups)) {
		const wOld = 1 - d.group[g];
		for (const [k, pole] of Object.entries(levers)) {
			// zonesPer1000 is not a lever: the old-school zone count per 1,000 tiles, which becomes zoneCells below
			if (k === 'zonesPer1000') continue;
			if (isNamed(k)) { out[k] = Number(named[k]); continue; }
			const now = Number(current[k]);
			if (!Number.isFinite(now)) continue;
			let old = pole[0] + (pole[1] - pole[0]) * d.u[k];
			// a start zone keeps its size when fewer play (classicBands.js): the old-school share is for eight players
			if (k === 'startZoneShare') old *= players / 8;
			let v = now * (1 - wOld) + old * wOld;
			const r = range && range[k];
			if (r) v = Math.max(r.min, Math.min(r.max, v));
			// Monster tier moves whole creature levels (a stop, not a number): the draw is rounded to one (S404)
			if (WHOLE.has(k)) v = Math.round(v);
			out[k] = Math.round(v * 1e4) / 1e4;
		}
	}
	// the zone count: the band's now (the land the starts leave over zoneCells, and the starts), blended toward the originals' count per 1,000 tiles
	const lz = t.groups.layout && t.groups.layout.zonesPer1000;
	if (lz && area && Number.isFinite(Number(current.zoneCells)) && !isNamed('zoneCells')) {
		const share = Math.max(0.01, Math.min(0.95, out.startZoneShare !== undefined ? out.startZoneShare : Number(current.startZoneShare) || 0.5));
		const zonesNow = players + (area * (1 - Number(current.startZoneShare || 0.5))) / Number(current.zoneCells);
		const zonesOld = (lz[0] + (lz[1] - lz[0]) * d.u.zonesPer1000) * area / 1000 * 0.85; // about 85 percent of the tiles are ground
		const zones = Math.max(players + 2, zonesNow * d.group.layout + zonesOld * (1 - d.group.layout));
		let cells = (area * (1 - share)) / Math.max(1, zones - players);
		const r = range && range.zoneCells;
		if (r) cells = Math.max(r.min, Math.min(r.max, cells));
		out.zoneCells = Math.round(cells * 100) / 100;
	}
	return out;
}

/** The levers the lean draws on a Classic map: the feel's levers, the band's, and the zone size they both reach (S358: what Random and Template hand over). */
function leaning() {
	const out = new Set(['zoneCells']);
	const t = feelTable();
	if (t) for (const levers of Object.values(t.groups)) for (const k of Object.keys(levers)) if (k !== 'zonesPer1000') out.add(k);
	const b = require('./classicBands').bandTable();
	if (b) for (const a of b.anchors) for (const k of Object.keys(a.levers || {})) out.add(k);
	return out;
}

/**
 * The Special buildings count on Template (S365, K: "probably default this one to Template"): the lean draws it. An old-school map (dressing feel 0) gets the originals'
 * own rate, 1x; a Nostalgia map (feel 1) none, as the engine's own maps have none of these buildings. Returns the multiplier, 0 to 1.
 */
function specialLean(d) {
	return Math.round(Math.max(0, Math.min(1, 1 - d.group.dressing)) * 100) / 100;
}

module.exports = { draw, apply, feelTable, leaning, specialLean };
