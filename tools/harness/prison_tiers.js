'use strict';
/**
 * prison_tiers.js - prison experience tier by zone type, guard presence and guard strength, ours against the engine's.
 *   node tools/harness/prison_tiers.js --ours MAP|DIR... --engine MAP|DIR...
 */
const fs = require('fs');
const path = require('path');
const sight = require('../mapsight/lib/sight');
const { valueOf } = require('../mapsight/lib/values');
const cheb = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
function list(name) {
	const out = []; const a = process.argv;
	for (let i = a.indexOf(name) + 1; i > 0 && i < a.length && !a[i].startsWith('--'); i++) {
		const p = a[i];
		if (fs.existsSync(p) && fs.statSync(p).isDirectory()) fs.readdirSync(p).filter(f => f.endsWith('.vmap')).forEach(f => out.push(path.join(p, f)));
		else out.push(p);
	}
	return out;
}
const med = a => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[b.length >> 1] : NaN; };
function run(files) {
	const rows = [];
	for (const f of files) {
		const M = sight.load(f);
		for (const o of M.objs) {
			if (o.type !== 'prison') continue;
			const tier = (o.options && o.options.experience) || 0;
			const near = M.monsters.filter(m => m.l === o.l && cheb(m.at, o.at) <= 2);
			const known = near.every(m => valueOf(m.subtype));
			const strength = known ? near.reduce((s, m) => s + valueOf(m.subtype).value * ((m.options && m.options.amount) || 0), 0) : undefined;
			const z = M.zoneAt(o.l, o.at[0], o.at[1]);
			const zt = M.zones && z !== undefined ? ((M.zones.zones.get(z) || {}).type || '?') : '?';
			rows.push({ tier, guarded: near.length > 0, flyer: !M.monsters.some(m => m.l === o.l && cheb(m.at, o.at) <= 1), strength, zt });
		}
	}
	return rows;
}
const show = (name, rows, maps) => {
	console.log(`${name}: ${rows.length} prisons on ${maps} maps`);
	console.log('tier      n   per map  unguarded%  flyer-open%  guard strength (median of guarded)   by zone type');
	for (const t of [0, 5000, 15000, 90000, 500000]) {
		const r = rows.filter(x => x.tier === t);
		const zt = {}; r.forEach(x => { zt[x.zt] = (zt[x.zt] || 0) + 1; });
		console.log(String(t).padEnd(8), String(r.length).padStart(4), (r.length / maps).toFixed(1).padStart(8), (100 * r.filter(x => !x.guarded).length / (r.length || 1)).toFixed(0).padStart(10),
			(100 * r.filter(x => x.flyer).length / (r.length || 1)).toFixed(0).padStart(12), String(Math.round(med(r.filter(x => x.guarded && x.strength !== undefined).map(x => x.strength)) || 0)).padStart(12), '  ', JSON.stringify(zt));
	}
};
const O = list('--ours'), E = list('--engine');
show('ours', run(O), O.length); show('engine', run(E), E.length);
