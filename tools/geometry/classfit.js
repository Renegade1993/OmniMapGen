'use strict';
/**
 * classfit.js - one number for how far a set of our maps sits from the engine's, per group of template zones: guards,
 * high loot and low loot per 100 zone tiles, ours over the engine's, and the sum of |log ratio| over every group and
 * measure. For fitting landing shares and similar levers with a script (pilefit.py) instead of by hand.
 *
 *   node tools/geometry/classfit.js [--groups "start=1-8 treasure=9-16 junction=17-20 central=21"] --engine E... --ours O... [--json] [--cache F]
 * Without --groups the zones are grouped by the template's own zone types (start, treasure, junction...).
 */
const sight = require('../mapsight/lib/sight');

function args(a, name) { const out = []; const i = a.indexOf(name); if (i >= 0) for (let j = i + 1; j < a.length && !a[j].startsWith('--'); j++) out.push(a[j]); return out; }

function groupsOf(spec) {
	const g = [];
	for (const part of spec.split(/\s+/).filter(Boolean)) {
		const [name, list] = part.split('=');
		const zones = new Set();
		for (const r of list.split(',')) { const [a, b] = r.split('-').map(Number); for (let z = a; z <= (b || a); z++) zones.add(z); }
		g.push({ name, zones });
	}
	return g;
}

function groupsByType(file) {
	const M = sight.load(file), by = new Map();
	for (const [id, z] of (M.zones && M.zones.zones) || []) {
		const t = /start/i.test(z.type || '') ? 'start' : (z.type || 'other');
		if (!by.has(t)) by.set(t, new Set());
		by.get(t).add(Number(id));
	}
	return [...by].map(([name, zones]) => ({ name, zones }));
}

function measure(files, groups) {
	const tot = groups.map(() => ({ tiles: 0, guard: 0, high: 0, low: 0 }));
	for (const f of files) {
		const M = sight.load(f);
		const gi = z => groups.findIndex(g => g.zones.has(z));
		for (let l = 0; l < M.NL; l++) for (let y = 0; y < M.H; y++) for (let x = 0; x < M.W; x++) { const i = gi(M.zoneAt(l, x, y)); if (i >= 0) tot[i].tiles++; }
		for (const o of M.objs) {
			const i = gi(M.zoneAt(o.l, o.at[0], o.at[1]));
			if (i < 0) continue;
			if (o.cls === 'monster') tot[i].guard++;
			else if (o.cls === 'high') tot[i].high++;
			else if (o.cls === 'low') tot[i].low++;
		}
	}
	return tot.map(t => ({ guard: 100 * t.guard / (t.tiles || 1), high: 100 * t.high / (t.tiles || 1), low: 100 * t.low / (t.tiles || 1) }));
}

function main(a) {
	// without --groups: the template's own zone types from the first engine map's sidecar (start, treasure, junction...)
	const typeSrc = [...args(a, '--engine'), ...args(a, '--ours')].find(f => require('fs').existsSync(f));
	const groups = args(a, '--groups')[0] ? groupsOf(args(a, '--groups')[0]) : groupsByType(typeSrc);
	// --cache F: the engine side read once and kept (same groups and files)
	const fs = require('fs'), cache = args(a, '--cache')[0];
	let E = null;
	if (cache && fs.existsSync(cache)) E = JSON.parse(fs.readFileSync(cache, 'utf8'));
	if (!E) { E = measure(args(a, '--engine'), groups); if (cache) fs.writeFileSync(cache, JSON.stringify(E)); }
	const O = measure(args(a, '--ours'), groups);
	let err = 0;
	const rows = groups.map((g, i) => {
		const r = {};
		for (const k of ['guard', 'high', 'low']) { r[k] = O[i][k] / (E[i][k] || 1e-9); err += Math.abs(Math.log(Math.max(1e-6, r[k]))); }
		return { group: g.name, ratio: r, engine: E[i], ours: O[i] };
	});
	if (a.includes('--json')) console.log(JSON.stringify({ err, rows }));
	else {
		for (const r of rows) console.log(`${r.group.padEnd(9)} ours/engine guards ${r.ratio.guard.toFixed(2)}  high ${r.ratio.high.toFixed(2)}  low ${r.ratio.low.toFixed(2)}`);
		console.log(`error (sum of |log ratio|) ${err.toFixed(3)}`);
	}
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { measure, groupsOf, groupsByType };
