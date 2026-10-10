'use strict';
/**
 * mine_guards.js - mines by kind and zone type: how many have a guard (a monster within 2 tiles of the visit tile, or whose 3x3 covers an
 * approach tile), and the guard's strength. K, 2026-10-08: "found a completely unguarded gold mine in my start biome".
 *
 *   node tools/harness/mine_guards.js MAP|DIR... [--kind goldMine]
 */
const fs = require('fs');
const path = require('path');
const sight = require('../mapsight/lib/sight');
const { valueOf } = require('../mapsight/lib/values');
const cheb = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
const files = [];
for (const a of process.argv.slice(2)) {
	if (a.startsWith('--') || process.argv[process.argv.indexOf(a) - 1] === '--kind') continue;
	if (fs.existsSync(a) && fs.statSync(a).isDirectory()) fs.readdirSync(a).filter(f => f.endsWith('.vmap')).forEach(f => files.push(path.join(a, f)));
	else files.push(a);
}
const K = process.argv.includes('--kind') ? process.argv[process.argv.indexOf('--kind') + 1] : null;
const t = {};
const med = a => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[b.length >> 1] : 0; };
for (const f of files) {
	const M = sight.load(f), W = M.W, H = M.H;
	for (const o of M.objs) {
		if (o.cls !== 'mine' || (K && o.subtype !== K)) continue;
		const z = M.zoneAt(o.l, o.at[0], o.at[1]);
		const zt = M.zones && z !== undefined ? ((M.zones.zones.get(z) || {}).type || '?') : '?';
		const ap = M.approach(o).map(i => { const c = i % (W * H); return [c % W, (c / W) | 0]; });
		const g = M.monsters.filter(m => m.l === o.l && (cheb(m.at, o.at) <= 2 || ap.some(a => cheb(a, m.at) <= 1)));
		const key = `${o.subtype} in ${zt}`;
		const r = t[key] || (t[key] = { n: 0, guarded: 0, s: [] });
		r.n++;
		if (g.length) {
			r.guarded++;
			const known = g.every(m => valueOf(m.subtype));
			if (known) r.s.push(g.reduce((a, m) => a + valueOf(m.subtype).value * ((m.options && m.options.amount) || 0), 0));
		}
	}
}
for (const [k, r] of Object.entries(t).sort()) console.log(`${k.padEnd(32)} ${String(r.n).padStart(4)} mines, ${(100 * r.guarded / r.n).toFixed(0).padStart(3)}% guarded, median guard ${Math.round(med(r.s))}`);
