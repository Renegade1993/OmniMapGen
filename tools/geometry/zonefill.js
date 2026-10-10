'use strict';
/**
 * zonefill.js - every template zone's contents against the engine's same zone, so no zone is bare or stacked while the
 * map-wide averages look fine. K, 2026-10-02: "multiple biomes loot bare....so your statistical averages are hiding the
 * problems there for certain ... we should be able to run biome-wide loot comps to ensure biomes are balanced".
 *
 *   node tools/geometry/zonefill.js --engine ENGINE.vmap... --ours OURS.vmap... [--json OUT]
 *
 * Per template zone (both levels together), per map: open tiles, and per 100 open tiles: high loot, low loot, guards,
 * dwellings, banks, mines, towns, scenery tiles. The engine's maps give each zone a range (lowest to highest over its
 * seeds, widened by a fifth); each of ours is flagged LOW or HIGH where it falls outside. The zone's role (start, treasure,
 * junction) comes from the sidecar, so start, treasure and junction zones can be read apart. Needs zone sidecars.
 */
const fs = require('fs');
const path = require('path');
const sight = require('../mapsight/lib/sight');

const KEYS = ['high', 'low', 'guard', 'dwelling', 'bank', 'mine', 'town', 'scenery'];
const keyOf = o => (o.cls === 'monster' ? 'guard' : o.cls === 'other' ? (o.visitable ? null : 'scenery') : KEYS.includes(o.cls) ? o.cls : null);

function zonesOfMap(file) {
	const M = sight.load(file);
	if (!M.zones || !M.zones.zoneOf) return null;
	const Z = new Map();
	const get = z => { if (!Z.has(z)) Z.set(z, { open: 0, n: Object.fromEntries(KEYS.map(k => [k, 0])) }); return Z.get(z); };
	for (let l = 0; l < M.NL; l++) for (let y = 0; y < M.H; y++) for (let x = 0; x < M.W; x++) {
		const z = M.zoneAt(l, x, y);
		if (z === undefined || z === null || z < 0) continue;
		const i = M.idx(l, x, y);
		if (M.ground(i) && !M.blocked[i]) get(z).open++;
	}
	for (const o of M.objs) {
		const k = keyOf(o);
		if (!k) continue;
		const z = M.zoneAt(o.l, o.at[0], o.at[1]);
		if (z === undefined || z === null || z < 0) continue;
		get(z).n[k] += k === 'scenery' ? o.cells.length : 1;
	}
	const type = z => ((M.zones.zones && M.zones.zones.get(z)) || {}).type || '?';
	const out = {};
	for (const [z, e] of Z) out[z] = { type: type(z), open: e.open, per100: Object.fromEntries(KEYS.map(k => [k, e.open ? (100 * e.n[k]) / e.open : 0])), count: e.n };
	return out;
}

function list(args, name) { const out = []; args.forEach((a, i) => { if (a === name) for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) out.push(args[j]); }); return out; }

function main(args) {
	const eng = list(args, '--engine').map(zonesOfMap).filter(Boolean);
	const oursF = list(args, '--ours');
	const ours = oursF.map(zonesOfMap);
	const zones = [...new Set(eng.flatMap(e => Object.keys(e)))].sort((a, b) => a - b);
	const range = {};
	for (const z of zones) {
		range[z] = {};
		for (const k of ['open', ...KEYS]) {
			const v = eng.map(e => e[z] && (k === 'open' ? e[z].open : e[z].per100[k])).filter(x => x !== undefined && x !== null);
			if (!v.length) continue;
			const lo = Math.min(...v), hi = Math.max(...v), pad = (hi - lo) * 0.2;
			range[z][k] = [lo - pad, hi + pad];
		}
	}
	const f = v => (v >= 10 ? v.toFixed(0) : v.toFixed(1));
	const lines = [`zones: ${zones.length}; engine maps ${eng.length}; per 100 open tiles; ! = outside the engine's range for that zone`];
	lines.push('zone type        ' + ['open', ...KEYS].map(k => k.padStart(9)).join(''));
	let flags = 0;
	for (const z of zones) {
		const t = (eng.find(e => e[z]) || {})[z].type;
		const er = range[z];
		lines.push(`${String(z).padStart(4)} ${String(t).padEnd(11)} engine ` + ['open', ...KEYS].map(k => (er[k] ? `${f(er[k][0] < 0 ? 0 : er[k][0])}-${f(er[k][1])}` : '-').padStart(9)).join(''));
		ours.forEach((o, i) => {
			if (!o || !o[z]) { lines.push(`${''.padEnd(16)} ${path.basename(oursF[i]).slice(-10)} missing`); flags++; return; }
			const cells = ['open', ...KEYS].map(k => {
				const v = k === 'open' ? o[z].open : o[z].per100[k];
				const r = er[k];
				const bad = r && (v < r[0] || v > r[1]);
				if (bad) flags++;
				return ((bad ? '!' : '') + f(v)).padStart(9);
			});
			lines.push(`${''.padEnd(16)} ${path.basename(oursF[i]).slice(-10).padEnd(6)}` + cells.join(''));
		});
	}
	lines.push(`${flags} zone measure(s) outside the engine's range`);
	console.log(lines.join('\n'));
	const j = args.indexOf('--json');
	if (j >= 0) fs.writeFileSync(args[j + 1], JSON.stringify({ range, ours }, null, 1));
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { zonesOfMap };
