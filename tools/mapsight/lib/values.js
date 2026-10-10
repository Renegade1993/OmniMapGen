'use strict';
/**
 * values.js - each creature's AI value (the game's power rating that VCMI's generator sizes guards with), for every
 * creature a map can hold: the 150 core creatures from src/biome/creature_values.json (CRTRAITS), the mods' creatures
 * from their own config files ("aiValue", 209 in K's mods on 2026-10-01), and for a creature with neither (HotA's carry
 * none in their files) the median value of the known creatures of its level, marked estimated.
 *
 *   const { valueOf } = require('./values'); valueOf('nagaQueen') -> { value: 2840, level: 6, estimated: false }
 */
const fs = require('fs');
const path = require('path');
const sight = require('./sight');
const CORE = require('../../../src/biome/creature_values.json');

let TABLE = null;
function build() {
	TABLE = new Map();
	for (const [k, v] of Object.entries(CORE)) TABLE.set(k.toLowerCase(), { value: v.aiValue, level: v.level, estimated: false });
	const roots = [process.env.VCMI_USER_DIR && path.join(process.env.VCMI_USER_DIR, 'Mods'), process.env.VCMI_ROOT && path.join(process.env.VCMI_ROOT, 'Mods')].filter(Boolean);
	const walk = dir => {
		let ents = [];
		try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
		for (const e of ents) {
			const p = path.join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else if (/\.json$/i.test(e.name) && /creature/i.test(p)) {
				let j;
				try { j = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/,\s*([}\]])/g, '$1')); } catch (err) { continue; }
				for (const [id, c] of Object.entries(j || {})) if (c && typeof c === 'object' && Number.isFinite(c.aiValue) && c.aiValue > 0) {
					const k = id.replace(/^.*:/, '').toLowerCase();
					if (!TABLE.has(k)) TABLE.set(k, { value: c.aiValue, level: c.level || null, estimated: false });
				}
			}
		}
	};
	for (const r of roots) walk(r);
	return TABLE;
}
const byLevel = new Map();
function levelMedian(level) {
	if (byLevel.has(level)) return byLevel.get(level);
	const v = [...(TABLE || build()).values()].filter(x => !x.estimated && x.level === level).map(x => x.value).sort((a, b) => a - b);
	const m = v.length ? v[v.length >> 1] : null;
	byLevel.set(level, m);
	return m;
}
function valueOf(name) {
	const T = TABLE || build();
	const k = String(name || '').replace(/^.*:/, '').toLowerCase();
	if (T.has(k)) return T.get(k);
	const I = sight.index();
	const c = I && I.creature(name);
	const level = c ? c.level : null;
	if (level === null) return null;
	const m = levelMedian(level);
	return m === null ? null : { value: m, level, estimated: true };
}
module.exports = { valueOf, build };
