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
function draw(seed, forced) {
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
	}
	return { f, group, u };
}

/** The levers the draw moves, given the draw and the values the levers have now (band or default): { lever: value }. */
function apply(d, current, range) {
	const t = feelTable(), out = {};
	if (!t || !d) return out;
	for (const [g, levers] of Object.entries(t.groups)) {
		const wOld = 1 - d.group[g];
		for (const [k, pole] of Object.entries(levers)) {
			const now = Number(current[k]);
			if (!Number.isFinite(now)) continue;
			const old = pole[0] + (pole[1] - pole[0]) * d.u[k];
			let v = now * (1 - wOld) + old * wOld;
			const r = range && range[k];
			if (r) v = Math.max(r.min, Math.min(r.max, v));
			out[k] = Math.round(v * 1e4) / 1e4;
		}
	}
	return out;
}

module.exports = { draw, apply, feelTable };
