'use strict';
/**
 * decorrepeat.js - how often the same scenery piece repeats close by: K, 2026-10-03, on a giant Coldshadow's Fantasy:
 * "a lot of terrain blocker repetition that looks really bad...we need to ensure variety and as much random variation
 * as possible along borders" (cracked-earth patches in ranks, one pond down a column, one lake-and-rock piece in a grid).
 *
 * A scenery object is a non-visitable object (sight class 'other', not visitable). Its piece is its animation (the
 * picture the player sees). For each piece on the map, per level:
 *   twins     the share of scenery objects with another of the same piece within R tiles (Chebyshev, anchor to anchor)
 *   clump     the mean number of same-piece neighbours within R
 *   kinds/100 distinct pieces per 100 scenery objects (variety)
 *   top       the pieces with the most same-piece neighbours, with where the worst clump sits
 * Compare ours against the engine's maps of the same settings; the engine's numbers are the target.
 *
 *   node tools/geometry/decorrepeat.js [--r 6] [--top 8] [--json OUT] MAP...
 */
const fs = require('fs');
const sight = require('../mapsight/lib/sight');

function measure(file, R) {
	const M = sight.load(file);
	const out = [];
	for (let l = 0; l < M.NL; l++) {
		const sc = M.objs.filter(o => o.l === l && o.cls === 'other' && !o.visitable);
		const key = o => (o.template && o.template.animation) || `${o.type}/${o.subtype}`;
		const by = new Map();
		for (const o of sc) { const k = key(o); if (!by.has(k)) by.set(k, []); by.get(k).push(o); }
		let twins = 0, clumpSum = 0;
		const worst = new Map();
		for (const [k, list] of by) {
			for (const o of list) {
				let n = 0;
				for (const p of list) if (p !== o && Math.max(Math.abs(p.at[0] - o.at[0]), Math.abs(p.at[1] - o.at[1])) <= R) n++;
				if (n) twins++;
				clumpSum += n;
				const w = worst.get(k);
				if (!w || n > w.n) worst.set(k, { n, at: o.at, count: list.length });
			}
		}
		const top = [...worst].sort((a, b) => b[1].n - a[1].n);
		out.push({ l, scenery: sc.length, kinds: by.size, twins: sc.length ? twins / sc.length : 0, clump: sc.length ? clumpSum / sc.length : 0, top });
	}
	return out;
}

function main(a) {
	const opt = (n, d) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : d; };
	const R = Number(opt('--r', 6)), TOP = Number(opt('--top', 0));
	const files = a.filter((x, i) => !x.startsWith('--') && !(i > 0 && a[i - 1].startsWith('--')));
	const all = [];
	for (const f of files) {
		const m = measure(f, R);
		all.push({ file: f, levels: m });
		console.log(`${f.split(/[\\/]/).pop().slice(-30).padEnd(31)} ` + m.map(x => `L${x.l} scenery ${x.scenery} kinds/100 ${(100 * x.kinds / Math.max(1, x.scenery)).toFixed(1)} twins ${(100 * x.twins).toFixed(0)}% clump ${x.clump.toFixed(2)}`).join(' | '));
		if (TOP) for (const x of m) for (const [k, w] of x.top.slice(0, TOP)) console.log(`    L${x.l} ${k.split('/').pop().padEnd(28)} ${w.count} on the level, worst: ${w.n} within ${R} of (${w.at})`);
	}
	if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify(all.map(f => ({ file: f.file, levels: f.levels.map(x => ({ ...x, top: x.top.slice(0, 20) })) }))));
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { measure };
