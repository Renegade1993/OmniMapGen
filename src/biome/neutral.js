'use strict';
/**
 * The neutral values of a named template (S386, K: "reset should set to template, but template for the numerical sliders should be a numerical setting that represents
 * what the template defaults to at that given size, so the player can easily adjust it up or down from there").
 *
 * mod/template-info.json, templates.<name>.neutral: { "<side>": { "<players>": { zoneCells, startZoneShare, zoneCap } } }, measured by tools/neutral_measure.js (the layout the
 * template makes at that map side and player count: the mean land of its neutral zones, the share of the land its start zones take, the zones a level has). Between the
 * measured sides and player counts the values are interpolated, by the map's side (the square root of its area) and by the players; outside the measured sides, or for a
 * template with no block, there is no neutral and the levers read as they did (400 cells a biome, 0.5 for the starts).
 *
 * Only the two levers whose number is a ratio to the template's own are read by the generator: Biome size (zoneCells) and Start biome size (startZoneShare). Set to the
 * neutral at that size, a lever gives the template's own map; above it the zones grow (or the starts take more land), below it they shrink. Most biomes per level (zoneCap) is a
 * plain cap: its neutral is the template's own zone count, and the lobby shows it.
 */
const fs = require('fs');

let info;
function readInfo() {
	if (info !== undefined) return info;
	info = {};
	try {
		const tpl = require('../rmg/template');
		info = JSON.parse(fs.readFileSync(tpl.templateInfoFile(), 'utf8')).templates || {};
	} catch { /* no info file: no neutral values */ }
	return info;
}

const lerp = (a, b, t) => a + (b - a) * t;

/** The two bracketing keys of x in a sorted list of numbers, and the fraction between them; null when x is outside the list. */
function bracket(keys, x) {
	if (!keys.length || x < keys[0] - 1e-9 || x > keys[keys.length - 1] + 1e-9) return null;
	let i = 0;
	while (i < keys.length - 2 && x > keys[i + 1]) i++;
	if (keys.length === 1) return [keys[0], keys[0], 0];
	const lo = keys[i], hi = keys[i + 1];
	return [lo, hi, hi === lo ? 0 : Math.max(0, Math.min(1, (x - lo) / (hi - lo)))];
}

/**
 * The neutral values of `template` on a W x H map with `players` players: { zoneCells, startZoneShare, zoneCap } or null.
 * `table` stands in for the template's block (tests); else it is read from template-info.json.
 */
function neutralFor(template, W, H, players, table) {
	const block = table || ((readInfo()[template] || {}).neutral);
	if (!block || process.env.VMAPGEN_NEUTRAL === '0') return null;
	const sides = Object.keys(block).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
	const side = bracket(sides, Math.sqrt(W * H));
	if (!side) return null;
	const at = s => {
		const row = block[String(s)];
		const keys = Object.keys(row).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
		if (!keys.length) return null;
		const pl = bracket(keys, Math.max(keys[0], Math.min(keys[keys.length - 1], Number(players) || keys[0])));
		const a = row[String(pl[0])], b = row[String(pl[1])];
		if (!a || !b) return null;
		const out = {};
		for (const k of ['zoneCells', 'startZoneShare', 'zoneCap']) out[k] = Number.isFinite(a[k]) && Number.isFinite(b[k]) ? lerp(a[k], b[k], pl[2]) : undefined;
		return out;
	};
	const a = at(side[0]), b = at(side[1]);
	if (!a || !b) return null;
	const out = {};
	for (const k of ['zoneCells', 'startZoneShare', 'zoneCap']) {
		if (a[k] === undefined || b[k] === undefined) continue;
		const v = lerp(a[k], b[k], side[2]);
		out[k] = k === 'zoneCells' ? Math.round(v) : k === 'zoneCap' ? Math.round(v) : Math.round(v * 1000) / 1000;
	}
	return out.zoneCells !== undefined || out.startZoneShare !== undefined ? out : null;
}

module.exports = { neutralFor };
