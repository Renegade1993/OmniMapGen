'use strict';
/**
 * dwellings.js - dwellings per map by kind, and how many stand in the template's rich zones, so a template's signature
 * dwellings (Coldshadow's Fantasy's neutral dragons in its junction zones) are counted per seed, not just in total.
 * K, 2026-10-03: "i generated a similar map on medium with underground and i don't see any dwellings at all".
 *
 *   node tools/geometry/dwellings.js [--rich 17,18,19,20,21] MAP...
 * Without --rich the rich zones are those the sidecar types junction, plus treasure zones whose bands reach 50000 when
 * the sidecar carries bands (today's sidecars do not: name a rich treasure zone with --rich).
 */
const sight = require('../mapsight/lib/sight');

const a = process.argv.slice(2);
const ri = a.indexOf('--rich');
const richList = ri >= 0 ? new Set(a[ri + 1].split(',').map(Number)) : null;
const files = a.filter((x, i) => !x.startsWith('--') && !(ri >= 0 && i === ri + 1));

for (const f of files) {
	let M;
	try { M = sight.load(f); } catch (e) { console.log(f, 'load failed', e.message); continue; }
	const Z = (M.zones && M.zones.zones) || new Map();
	const isRich = z => {
		if (richList) return richList.has(z);
		const info = Z.get(z) || {};
		if (info.type === 'junction') return true;
		return Array.isArray(info.treasure) && info.treasure.some(t => (t.max || 0) >= 50000);
	};
	const d = M.objs.filter(o => /creatureGenerator|dwelling/i.test(o.type) || o.cls === 'dwelling');
	const n = new Map();
	for (const o of d) n.set(String(o.subtype), (n.get(String(o.subtype)) || 0) + 1);
	const rich = d.filter(o => M.zones && isRich(M.zoneAt(o.l, o.at[0], o.at[1]))).length;
	console.log(f.split(/[\\/]/).pop().slice(-34).padEnd(35), `W${M.W} L${M.NL}`, 'dwellings', d.length, 'in rich zones', rich, '|',
		[...n].sort((x, y) => y[1] - x[1]).slice(0, 12).map(([k, v]) => `${k}:${v}`).join(' '));
}
