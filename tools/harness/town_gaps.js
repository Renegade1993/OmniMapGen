'use strict';
/**
 * town_gaps.js - how towns thin out with walking distance (K, 2026-10-09 10:3x: "Town spacing (15 walking tiles): we should get eyes on the falloff that
 * takes place beyond 15 tiles too"). For every town, the walking distance (the town-spacing rule of grid_extra.js: 8-connected steps over open ground from
 * its visiting tiles to another town's, up to 60) to its nearest other town on the same level, in 5-tile bins from 0 to 59 and one bin for 60 or more or none.
 * A start town's neighbour is the nearest town of any kind; a neutral town's is the nearest neutral town.
 *
 *   node tools/harness/town_gaps.js LABEL=MAP|DIR [LABEL=MAP|DIR ...] [--json out.json]
 *
 * One line a label per kind: the share of towns in each bin. chart_town_gaps.py draws the JSON.
 */
const fs = require('fs');
const path = require('path');
const sight = require('../mapsight/lib/sight');

const N8 = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 0], [-1, 1]];
const cheb = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
const LIMIT = 60, BIN = 5, NB = LIMIT / BIN + 1;

function walkDist(M, o, limit) {
	const dist = new Map(), q = [];
	for (const i of M.approach(o)) if (M.ground(i) && !M.blocked[i]) { dist.set(i, 0); q.push(i); }
	for (let h = 0; h < q.length; h++) {
		const c = q[h], d = dist.get(c);
		if (d >= limit) continue;
		const l = Math.floor(c / (M.W * M.H)), x = c % M.W, y = Math.floor(c / M.W) % M.H;
		for (const [dx, dy] of N8) {
			if (!M.inb(x + dx, y + dy)) continue;
			const k = M.idx(l, x + dx, y + dy);
			if (dist.has(k) || !M.ground(k) || M.blocked[k]) continue;
			dist.set(k, d + 1); q.push(k);
		}
	}
	return dist;
}

/** Nearest-neighbour walking distance of every town of one map: { start: [d...], neutral: [d...] } (99 for none within the limit). */
function gaps(M) {
	const towns = M.objs.filter(o => o.cls === 'town');
	const st = sight.starts(M), isStart = o => st.some(s => s.l === o.l && cheb(s.at, o.at) <= 1);
	const out = { start: [], neutral: [] };
	for (const a of towns) {
		const dist = walkDist(M, a, LIMIT), s = isStart(a);
		let best = 99;
		for (const b of towns) {
			if (b === a || b.l !== a.l || (!s && isStart(b))) continue;
			for (const i of M.approach(b)) if (dist.has(i)) best = Math.min(best, dist.get(i) + 1);
		}
		(s ? out.start : out.neutral).push(best);
	}
	return out;
}

const bins = list => { const h = new Array(NB).fill(0); for (const d of list) h[d >= LIMIT ? NB - 1 : Math.floor(d / BIN)]++; return h; };

if (require.main === module) {
	const args = process.argv.slice(2), jsonAt = args.indexOf('--json');
	const out = {};
	for (const a of args.filter((x, i) => !x.startsWith('--') && i !== jsonAt + 1)) {
		const [label, p] = a.includes('=') ? a.split(/=(.*)/s) : [path.basename(a), a];
		const files = fs.statSync(p).isDirectory() ? fs.readdirSync(p).filter(f => f.endsWith('.vmap')).sort().map(f => path.join(p, f)) : [p];
		const all = { start: [], neutral: [] };
		for (const f of files) { const g = gaps(sight.load(f)); all.start.push(...g.start); all.neutral.push(...g.neutral); }
		out[label] = { maps: files.length, start: bins(all.start), neutral: bins(all.neutral), nStart: all.start.length, nNeutral: all.neutral.length, raw: all };
		const pc = h => h.map(v => (100 * v / Math.max(1, h.reduce((x, y) => x + y, 0))).toFixed(0).padStart(3)).join(' ');
		const head = Array.from({ length: NB }, (_, i) => (i === NB - 1 ? '60+' : String(i * BIN))).map(v => v.padStart(3)).join(' ');
		console.log(`${label}: ${files.length} maps\n  bins       ${head}\n  start   %  ${pc(out[label].start)}   (${all.start.length} towns, under 15 tiles ${all.start.filter(d => d < 15).length})\n  neutral %  ${pc(out[label].neutral)}   (${all.neutral.length} towns, under 15 tiles ${all.neutral.filter(d => d < 15).length})`);
	}
	if (jsonAt > 0) fs.writeFileSync(args[jsonAt + 1], JSON.stringify(out));
}
module.exports = { gaps, bins };
