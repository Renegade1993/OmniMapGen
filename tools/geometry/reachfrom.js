// tools/geometry/reachfrom.js MAP X Y [R]: walking steps (8-way, guards as walls, pickups as walls) from the tile below (X,Y) to every
// object within R tiles; lists the unreachable ones and the steps to the reachable ones.
const sight = require('../mapsight/lib/sight');
const [f, X, Y, R = 16] = process.argv.slice(2);
const M = sight.load(f), W = M.W, H = M.H, l = 0;
const dist = new Int32Array(W * H).fill(-1), q = [];
const s = (+Y + 1) * W + +X; dist[s] = 0; q.push(s);
for (let h = 0; h < q.length; h++) {
	const c = q[h], x = c % W, y = (c / W) | 0;
	for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
		const u = x + dx, v = y + dy;
		if ((!dx && !dy) || u < 0 || v < 0 || u >= W || v >= H) continue;
		const m = v * W + u, i = M.idx(l, u, v);
		if (dist[m] >= 0 || !M.ground(i) || M.blocked[i] || M.guardOf[i] >= 0) continue;
		dist[m] = dist[c] + 1; q.push(m);
	}
}
const near = M.objs.filter(o => o.l === l && Math.max(Math.abs(o.at[0] - X), Math.abs(o.at[1] - Y)) <= R && o.cls !== 'decor');
for (const o of near) {
	let best = -1;
	for (const [ex, ey] of (o.entr.length ? o.entr : [o.at])) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
		const u = ex + dx, v = ey + dy; if (u < 0 || v < 0 || u >= W || v >= H) continue;
		const d = dist[v * W + u]; if (d >= 0 && (best < 0 || d < best)) best = d;
	}
	console.log(`${best < 0 ? 'UNREACHED' : 'steps ' + best}`.padEnd(11), o.cls.padEnd(8), o.type + (o.subtype ? ':' + o.subtype : ''), JSON.stringify(o.at));
}
let open = 0; for (let c = 0; c < W * H; c++) if (dist[c] >= 0) open++;
console.log('tiles reached', open);
