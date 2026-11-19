'use strict';
/**
 * Classic follows the map's size (K, 2026-11-17, S320: Nostalgia and Mini Nostalgia "were supposed to be integrated into classic, and were supposed to
 * help form the baseline for classic in terms of our measurements ... They are all supposed to merge and combine in the classic template").
 *
 * The open layout's lever defaults are a function of the map: the values that bring Classic to what VCMI 1.7.5's own Mini Nostalgia (at 108) and
 * Nostalgia (at 180) make, measured on 16 engine maps per template and size (VCMIMapGen\! LLM Files\2026-11-17_S320-step2-measurement-classic-vs-engine.md),
 * at the anchors; a straight line between anchors by the map's side (the square root of its area); the end anchors hold beyond. Under the first
 * anchor the values fade in from the lever's own default over the "fade" sides, so no size has a cliff. The table lives in mod/template-info.json
 * (Classic, originalPreferences.bands) because the lobby reads that file; this module is the one place that turns it into numbers.
 *
 * "zones" is a pseudo lever: the zone count the stock template has (15 and 24, eight of them starts). It becomes zoneCells, the cells of the other
 * zones: all the land the starts leave, shared by the zones that are not starts. A lever in "steps" is a choice (Underground starts), not a number:
 * it takes the nearer anchor's value. Classic's defaults are never read here for a lever the player moved: resolve() returns defaults only and
 * generate-cli.js puts them under --bio.<lever>. VMAPGEN_CLASSIC_BANDS=0 turns it off (the before arm of a before and after; players cannot reach it).
 */
const fs = require('fs');

const STOCK_STARTS = 8; // both stock templates have eight start zones whatever the player count
let table; // undefined: not read; null: no table
function bandTable() {
	if (table !== undefined) return table;
	table = null;
	try {
		const tpl = require('../rmg/template');
		const name = tpl.openLayoutNames()[0];
		const j = JSON.parse(fs.readFileSync(tpl.templateInfoFile(), 'utf8')).templates || {};
		const b = j[name] && j[name].originalPreferences && j[name].originalPreferences.bands;
		if (b && Array.isArray(b.anchors) && b.anchors.length) table = b;
	} catch { /* no info file: no bands */ }
	return table;
}

const clamp01 = v => Math.max(0, Math.min(1, v));

/**
 * The lever values Classic starts from on a W x H map of `levels` levels: { lever: value } for every lever the bands move.
 * `base` is the lever defaults (preset on the generator's own) the fade starts from; `range` the slider range of a lever ({min, max}), which a
 * default never leaves (the zone size of a huge map stops at the slider's end; a player can still move it by hand).
 */
function resolve(W, H, levels, base, range) {
	const b = bandTable();
	if (!b || process.env.VMAPGEN_CLASSIC_BANDS === '0') return {};
	const side = Math.sqrt(W * H), A = [...b.anchors].sort((x, y) => x.side - y.side);
	let lo = A[0], hi = A[0];
	for (let i = 0; i < A.length; i++) if (side >= A[i].side) { lo = A[i]; hi = A[Math.min(i + 1, A.length - 1)]; }
	const t = hi !== lo ? clamp01((side - lo.side) / (hi.side - lo.side)) : 0;
	const steps = new Set(b.steps || []);
	const out = {};
	for (const k of new Set(A.flatMap(a => Object.keys(a.levers || {})))) {
		const a = lo.levers[k], c = hi.levers[k];
		if (a === undefined || c === undefined) continue;
		out[k] = steps.has(k) ? (t < 0.5 ? a : c) : a + (c - a) * t;
	}
	if (lo.zones !== undefined && hi.zones !== undefined) {
		const zones = lo.zones + (hi.zones - lo.zones) * t;
		const share = out.startZoneShare !== undefined ? out.startZoneShare : (base && Number(base.startZoneShare)) || 0.5;
		out.zoneCells = (W * H * Math.max(1, levels) * (1 - share)) / Math.max(1, zones - STOCK_STARTS);
	}
	// under the first anchor the values fade in from the lever's own default
	const fade = b.fade || [A[0].side, A[0].side];
	const w = fade[1] > fade[0] ? clamp01((side - fade[0]) / (fade[1] - fade[0])) : 1;
	for (const k of Object.keys(out)) {
		const d = base && base[k] !== undefined ? Number(base[k]) : undefined;
		if (w < 1 && d !== undefined && Number.isFinite(d)) out[k] = steps.has(k) ? (w < 0.5 ? d : out[k]) : d + (out[k] - d) * w;
		const r = range && range[k];
		if (r && !steps.has(k)) out[k] = Math.max(r.min, Math.min(r.max, out[k]));
		out[k] = steps.has(k) ? out[k] : Math.round(out[k] * 1e4) / 1e4;
	}
	return out;
}

module.exports = { resolve, bandTable };
