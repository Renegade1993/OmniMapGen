'use strict';
/**
 * startkit.js - what each start reaches early, from research report 3 (2026-10-03: "first wood and ore within a turn of
 * each start"; "parity between starts"). Per start town (an owned town): walking steps (8-way, around objects, through
 * nothing that blocks; a guard counts as a wall) to its nearest sawmill and ore pit, how many guards stand on the
 * cheapest way to each, and the spread between the starts of one map.
 *
 *   node tools/geometry/startkit.js MAP...
 */
const sight = require('../mapsight/lib/sight');

function steps(M, l, from, wantFn) {
	const W = M.W, H = M.H, dist = new Int32Array(W * H).fill(-1), q = [];
	for (const [x, y] of from) { const c = y * W + x; if (dist[c] < 0) { dist[c] = 0; q.push(c); } }
	const target = new Map();
	for (const o of M.objs) if (o.l === l && wantFn(o)) for (const [ex, ey] of o.entr.length ? o.entr : [o.at]) target.set(ey * W + ex, o);
	for (let h = 0; h < q.length; h++) {
		const c = q[h], x = c % W, y = (c / W) | 0;
		if (target.has(c)) return dist[c];
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
			const u = x + dx, v = y + dy;
			if ((!dx && !dy) || u < 0 || v < 0 || u >= W || v >= H) continue;
			const m = v * W + u, i = M.idx(l, u, v);
			if (dist[m] >= 0) continue;
			if (!target.has(m) && (!M.ground(i) || M.blocked[i] || M.guardOf[i] >= 0)) continue;
			dist[m] = dist[c] + 1; q.push(m);
		}
	}
	return -1;
}

for (const f of process.argv.slice(2)) {
	const M = sight.load(f);
	const starts = M.objs.filter(o => o.cls === 'town' && o.options && o.options.owner);
	const rows = [];
	for (const t of starts) {
		const from = (t.entr.length ? t.entr : [t.at]).map(([x, y]) => [x, y + 1]);
		const saw = steps(M, t.l, from, o => o.type === 'mine' && o.subtype === 'sawmill');
		const ore = steps(M, t.l, from, o => o.type === 'mine' && o.subtype === 'orePit');
		rows.push({ who: t.options.owner, l: t.l, saw, ore });
	}
	const ok = rows.filter(r => r.saw >= 0 && r.ore >= 0);
	const worst = ok.length ? Math.max(...ok.map(r => Math.max(r.saw, r.ore))) : -1;
	const best = ok.length ? Math.min(...ok.map(r => Math.max(r.saw, r.ore))) : -1;
	console.log(f.split(/[\\/]/).pop().slice(-26).padEnd(27) + rows.map(r => `${r.who}${r.l ? '(u)' : ''} saw ${r.saw < 0 ? 'none' : r.saw} ore ${r.ore < 0 ? 'none' : r.ore}`).join(' | ')
		+ `  spread ${best}-${worst}`);
}
