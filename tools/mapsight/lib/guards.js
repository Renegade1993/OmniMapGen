'use strict';
/**
 * guards.js - how strong each guard is against what it holds, ours beside the engine's.
 * K, 2026-10-01: "engineer these gaps away" (guard strength against what it guards was missing).
 *
 *   mapsight guards --ours FILE... --engine FILE...
 *
 * Strength = amount x the creature's AI value (lib/values.js: core creatures, the mods' own values, else the median of
 * the creature's level, marked estimated). Each guard is filed under the dearest thing it
 * seals (relic, major, minor, treasure artifact, Pandora, scroll, dwelling by tier, bank, mine, low loot), under its
 * zone type when the map has a zone tile map, and under "passage" when it stands between two zones or "nothing" when it
 * seals nothing. The engine sizes a pile's guard from the pile's value (TreasurePlacer), so the strength by what is
 * sealed is the closest a finished map comes to that rule.
 */
const path = require('path');
const sight = require('./sight');
const { describe } = require('./relations');
const { valueOf } = require('./values');

function list(args, name) {
	const out = [];
	args.forEach((a, i) => { if (a === name) for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) out.push(args[j]); });
	return out;
}
const RANK = ['randomArtifactRelic', 'dwelling 7+', 'pandoraBox', 'randomArtifactMajor', 'dwelling 5-6', 'creatureBank', 'artifact', 'spellScroll',
	'randomArtifactMinor', 'mine', 'dwelling 1-4', 'randomArtifactTreasure', 'low loot', 'other'];

function read(file) {
	const A = sight.analyse(file), M = A.M;
	describe(A);                                   // guard roles and what each closes (relations.js)
	const tierOf = new Map(A.census.map(c => [c.o, c.tier]));
	const kindOf = o => {
		if (o.cls === 'dwelling') { const t = tierOf.get(o) || 0; return t >= 7 ? 'dwelling 7+' : t >= 5 ? 'dwelling 5-6' : 'dwelling 1-4'; }
		if (o.cls === 'bank') return 'creatureBank';
		if (o.cls === 'mine') return 'mine';
		if (RANK.includes(o.type)) return o.type;
		if (o.cls === 'low') return 'low loot';
		return 'other';
	};
	const rows = [];
	// what each guard seals: the objects with no visiting tile on open ground within 3 tiles of it, the guard's ring
	// touching their way in (a cheap stand-in for relations.js closes(), which it does not export)
	for (const m of M.monsters) {
		const v = valueOf(m.subtype);
		if (!v) continue;
		const strength = v.value * ((m.options && m.options.amount) || 0);
		const sealed = M.objs.filter(o => o !== m && o.l === m.l && sight.cheb(o.at, m.at) <= 3 && ['high', 'low', 'dwelling', 'bank', 'mine'].includes(o.cls)
			&& !sight.openAccess(M, o) && M.approach(o).some(i => M.guardOf[i] === m.k || (M.region[i] >= 0 && M.regions[M.region[i]].tiles <= 30)));
		const top = sealed.map(kindOf).sort((a, b) => RANK.indexOf(a) - RANK.indexOf(b))[0] || 'nothing sealed';
		const zone = M.zoneAt(m.l, m.at[0], m.at[1]);
		const ztype = zone !== undefined && M.zones ? ((M.zones.zones.get(zone) || {}).type || '?') : '?';
		rows.push({ m, strength, top, ztype, level: v.level });
	}
	return { file, rows };
}

function main(args) {
	const O = list(args, '--ours').map(read), E = list(args, '--engine').map(read);
	if (!O.length || !E.length) { console.log('guards needs --ours and --engine maps'); process.exitCode = 2; return; }
	const q = (a, p) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.min(b.length - 1, Math.floor(p * b.length))] : 0; };
	const k = v => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(Math.round(v)));
	const by = (maps, key) => { const g = new Map(); for (const m of maps) for (const r of m.rows) { const kk = r[key]; if (!g.has(kk)) g.set(kk, []); g.get(kk).push(r); } return g; };
	for (const [key, title] of [['top', 'by the dearest thing the guard seals'], ['ztype', 'by zone type']]) {
		const go = by(O, key), ge = by(E, key);
		console.log(`\nGuard strength (amount x AI value) ${title}: guards per map, median strength, 25th to 75th percentile; ours | engine`);
		const keys = [...new Set([...go.keys(), ...ge.keys()])].sort((a, b) => (RANK.indexOf(a) + 1 || 99) - (RANK.indexOf(b) + 1 || 99));
		for (const kk of keys) {
			const a = (go.get(kk) || []).map(r => r.strength), b = (ge.get(kk) || []).map(r => r.strength);
			const ratio = a.length && b.length ? q(a, 0.5) / Math.max(1, q(b, 0.5)) : null;
			const flag = ratio !== null && (ratio > 1.6 || ratio < 0.62) ? `   <<< ours ${ratio > 1 ? 'stronger' : 'weaker'} x${ratio.toFixed(2)}` : '';
			console.log(`  ${String(kk).padEnd(24)} ${(a.length / O.length).toFixed(1).padStart(5)}/map ${k(q(a, 0.5)).padStart(5)} (${k(q(a, 0.25))}-${k(q(a, 0.75))}) | ${(b.length / E.length).toFixed(1).padStart(5)}/map ${k(q(b, 0.5)).padStart(5)} (${k(q(b, 0.25))}-${k(q(b, 0.75))})${flag}`);
		}
	}
	const lv = maps => { const t = {}; let n = 0; for (const m of maps) for (const r of m.rows) { t[r.level] = (t[r.level] || 0) + 1; n++; } return Object.fromEntries(Object.entries(t).map(([a, b]) => [a, Math.round(100 * b / n)])); };
	console.log(`\nCreature level mix of guards, % (ours | engine): ${JSON.stringify(lv(O))} | ${JSON.stringify(lv(E))}`);
}

module.exports = { main };
