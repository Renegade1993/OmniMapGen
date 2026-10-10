'use strict';
/**
 * roadsplines.js - the road spline layer (VCMIMapGen\! LLM Files\Generation-Paradigm-Brainstorm-2026-10-02.md, 2h).
 *
 * A zone's roads are a tree drawn whole: from its town gate a short stub to a junction T, from T one curved edge to
 * each link end. Each edge follows a cubic Bezier through two control points inside the zone (the engine's
 * replaceWithCurvedPath), rasterised as a 4-neighbour path whose cost is the ground's plus the squared distance to
 * the curve, with a penalty for long straight runs where the curve runs diagonally, so it steps in short stairs as
 * the engine's roads do (stair share 0.94 to 1, straight runs 2 to 3 tiles). No repair pass is needed after it.
 *
 * routeEdge(from, to, opts) -> [cells]   one edge
 * zoneTree(zone, opts) -> Set of cells   one zone's tree
 * All cells are y * W + x on one level. Not wired into plan.js yet.
 */

const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];

function bezier(P0, P1, P2, P3, n = 64) {
	const pts = [];
	for (let i = 0; i <= n; i++) {
		const t = i / n, u = 1 - t;
		const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
		pts.push([a * P0[0] + b * P1[0] + c * P2[0] + d * P3[0], a * P0[1] + b * P1[1] + c * P2[1] + d * P3[1]]);
	}
	return pts;
}

/**
 * One edge from cell `from` to any cell of `to` (array or Set). opts: W, H, open(c) -> bool (passable for a road),
 * cost(c) -> ground cost (default 1), ctrl: [[x, y], [x, y]] the curve's two control points, k (curve weight,
 * default 0.15), stair (penalty for a straight run past 3 tiles where the curve is diagonal, default 0.6).
 * Dijkstra over (cell, direction, run length up to 4).
 */
const TURN = Number(process.env.VMAPGEN_ROAD_TURN ?? 0.3);
function routeEdge(from, to, opts) {
	const { W, H, open } = opts;
	const cost = opts.cost || (() => 1);
	const goal = to instanceof Set ? to : new Set(to);
	const fx = from % W, fy = (from / W) | 0;
	// the curve aims at the goal's nearest tile: aimed at its first (the town end of a tree), an edge ran beside the
	// tree all the way back to the town and two roads went side by side (2026-10-03)
	let tc = -1, td = Infinity;
	for (const g of goal) { const d = (g % W - fx) ** 2 + (((g / W) | 0) - fy) ** 2; if (d < td) { td = d; tc = g; } }
	const tx = tc % W, ty = (tc / W) | 0;
	let ctrl = opts.ctrl;
	if (!ctrl) {
		// on the straight line at a third and two thirds; with opts.bend (and opts.rng) pushed sideways, both to one side, by
		// a share of the edge's length: one gentle arc. Control points anywhere in the zone made edges meander round half of
		// it (2026-10-03: a C round a hill between two towns, a box beside a town)
		const len = Math.hypot(tx - fx, ty - fy) || 1, nx = -(ty - fy) / len, ny = (tx - fx) / len;
		let o1 = 0, o2 = 0;
		if (opts.bend && opts.rng) {
			const side = opts.rng() < 0.5 ? -1 : 1;
			o1 = side * (0.3 + 0.7 * opts.rng()) * opts.bend * len;
			o2 = side * (0.3 + 0.7 * opts.rng()) * opts.bend * len;
		}
		ctrl = [[fx + (tx - fx) / 3 + nx * o1, fy + (ty - fy) / 3 + ny * o1], [fx + 2 * (tx - fx) / 3 + nx * o2, fy + 2 * (ty - fy) / 3 + ny * o2]];
	}
	const curve = bezier([fx, fy], ctrl[0], ctrl[1], [tx, ty]);
	const k = opts.k ?? 0.15, stair = opts.stair ?? 0.6;
	const off = new Map();
	const near = c => {
		let v = off.get(c);
		if (v !== undefined) return v;
		const x = c % W, y = (c / W) | 0;
		let best = Infinity, bi = 0;
		curve.forEach(([px, py], i) => { const e = (px - x) ** 2 + (py - y) ** 2; if (e < best) { best = e; bi = i; } });
		const j = Math.min(curve.length - 1, bi + 1), i0 = Math.max(0, bi - 1);
		const dx = curve[j][0] - curve[i0][0], dy = curve[j][1] - curve[i0][1];
		const diag = Math.abs(dx) > 0.35 * Math.hypot(dx, dy) && Math.abs(dy) > 0.35 * Math.hypot(dx, dy);
		v = { d2: best, diag };
		off.set(c, v);
		return v;
	};
	// state = cell * 20 + dir * 5 + run
	const S = (c, d, r) => c * 20 + d * 5 + r;
	const dist = new Map(), prev = new Map(), heap = [];
	const push = (s, v) => { heap.push([v, s]); for (let i = heap.length - 1; i > 0;) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
	const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; for (let i = 0; ;) { const a = 2 * i + 1, b = a + 1; let m = i; if (a < heap.length && heap[a][0] < heap[m][0]) m = a; if (b < heap.length && heap[b][0] < heap[m][0]) m = b; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
	for (let d = 0; d < 4; d++) { const s = S(from, d, 0); dist.set(s, 0); push(s, 0); }
	let end = -1;
	while (heap.length) {
		const [v, s] = pop();
		if (v > dist.get(s)) continue;
		const c = Math.floor(s / 20), d = Math.floor((s % 20) / 5), r = s % 5;
		if (goal.has(c) && c !== from) { end = s; break; }
		const x = c % W, y = (c / W) | 0;
		for (let nd = 0; nd < 4; nd++) {
			const nx = x + DIRS[nd][0], ny = y + DIRS[nd][1];
			if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
			const m = ny * W + nx;
			if (!goal.has(m) && !open(m)) continue;
			const nr = nd === d ? Math.min(4, r + 1) : 1;
			const nb = near(m);
			let w = cost(m) + k * nb.d2;
			// beside the road it is joining but not on it: join now rather than run alongside (a two-wide road)
			if (!goal.has(m) && DIRS.some(([ax, ay]) => goal.has((ny + ay) * W + nx + ax))) w += opts.besidePenalty ?? 2;
			if (nb.diag && nr > 3) w += stair;
			// a turn costs a little, so a diagonal steps two or three tiles at a time as the engine's roads do (mean straight
			// run 2.6-2.8 on Coldshadow; ours turned every tile, 1.7-2.0, 2026-10-04). VMAPGEN_ROAD_TURN sets it (0 off).
			if (nd !== d && r > 0) w += TURN;
			const ns = S(m, nd, nr), nv = v + w;
			if (!dist.has(ns) || nv < dist.get(ns)) { dist.set(ns, nv); prev.set(ns, s); push(ns, nv); }
		}
	}
	if (end < 0) return null;
	const path = [];
	for (let s = end; s !== undefined; s = prev.get(s)) { const c = Math.floor(s / 20); if (path[path.length - 1] !== c) path.push(c); }
	return path.reverse();
}

/**
 * One zone's tree. opts: W, H, open(c), cost(c), zoneCells (array), town (cell of the gate's road tile, or -1),
 * ends (array of cells, the link ends' road tiles), rng (0..1), stub (tiles, default 7). Returns a Set of road cells,
 * or null if an end cannot be reached.
 */
function zoneTree(opts) {
	const { W, open, zoneCells, ends, rng } = opts;
	const roads = new Set();
	if (!ends.length && opts.town < 0) return roads;
	// a zone that has roads already (a late gate or monolith): each new end joins them
	if (opts.existing && opts.existing.size) {
		const xy0 = c => [c % W, (c / W) | 0], inner0 = opts.inner || zoneCells, pick0 = () => xy0(inner0[Math.floor(rng() * inner0.length)]);
		for (const e of ends) { let p = null; for (const st of (Array.isArray(e) ? e : [e])) { p = routeEdge(st, new Set([...opts.existing, ...roads]), { ...opts, ...((process.env.VMAPGEN_ROAD_BEND === 'pick' ? null : Number(process.env.VMAPGEN_ROAD_BEND || 0.2)) === null ? { ctrl: [pick0(), pick0()] } : { ctrl: null, bend: (process.env.VMAPGEN_ROAD_BEND === 'pick' ? null : Number(process.env.VMAPGEN_ROAD_BEND || 0.2)) }) }); if (p) break; } if (!p) { if (opts.missed) opts.missed.push(e); continue; } p.forEach(c => roads.add(c)); if (opts.edges) opts.edges.push({ end: p[0], cells: p.slice() }); }
		return roads;
	}
	const xy = c => [c % W, (c / W) | 0];
	const mean = ends.length ? ends.map(e => xy(Array.isArray(e) ? e[0] : e)).reduce((a, b) => [a[0] + b[0] / ends.length, a[1] + b[1] / ends.length], [0, 0]) : xy(opts.town);
	// interior tiles for control points: zone tiles far from its border (top third by distance to the zone's edge)
	const inner = opts.inner || zoneCells;
	const pick = () => xy(inner[Math.floor(rng() * inner.length)]);
	let T;
	const chosen = new Set();
	if (opts.town >= 0) {
		// T: about `stub` tiles from the gate, toward the mean of the link ends, on open ground of the zone
		const [gx, gy] = xy(opts.town), L = Math.hypot(mean[0] - gx, mean[1] - gy) || 1, stub = opts.stub ?? 7;
		const want = [gx + (mean[0] - gx) * Math.min(1, stub / L), gy + (mean[1] - gy) * Math.min(1, stub / L)];
		T = zoneCells.filter(open).reduce((b, c) => { const [x, y] = xy(c), e = (x - want[0]) ** 2 + (y - want[1]) ** 2; return !b || e < b.e ? { c, e } : b; }, null);
		T = T ? T.c : opts.town;
		const s = routeEdge(opts.town, [T], { ...opts, ctrl: null });
		if (s) s.forEach(c => roads.add(c));
	} else {
		let sx = 0, sy = 0; for (const c of zoneCells) { sx += c % W; sy += (c / W) | 0; }
		const ctr = [sx / zoneCells.length, sy / zoneCells.length];
		const best = zoneCells.filter(open).reduce((b, c) => { const [x, y] = xy(c), e = (x - ctr[0]) ** 2 + (y - ctr[1]) ** 2; return !b || e < b.e ? { c, e } : b; }, null);
		T = best ? best.c : (Array.isArray(ends[0]) ? ends[0][0] : ends[0]);
	}
	for (const e of ends) {
		let p = null;
		for (const st of (Array.isArray(e) ? e : [e])) { p = routeEdge(st, roads.size ? roads : new Set([T]), { ...opts, ...((process.env.VMAPGEN_ROAD_BEND === 'pick' ? null : Number(process.env.VMAPGEN_ROAD_BEND || 0.2)) === null ? { ctrl: [pick(), pick()] } : { ctrl: null, bend: (process.env.VMAPGEN_ROAD_BEND === 'pick' ? null : Number(process.env.VMAPGEN_ROAD_BEND || 0.2)) }) }); if (p) break; }
		if (!p && process.env.VMAPGEN_ROAD_TRACE) { const g = roads.size ? roads : new Set([T]); const st0 = Array.isArray(e) ? e : [e]; const seen = new Set(st0), q = [...st0]; let hit = false; for (let i = 0; i < q.length && !hit; i++) { const c = q[i], x = c % W, y = (c / W) | 0; for (const [dx, dy] of DIRS) { const m = (y + dy) * W + x + dx; if (seen.has(m)) continue; if (g.has(m)) { hit = true; break; } if (!open(m)) continue; seen.add(m); q.push(m); } } console.error(`[roads] zoneTree miss: starts ${st0.length} (${st0.map(c => (c % W) + ',' + ((c / W) | 0)).join(' ')}), goal ${g.size}${roads.size ? '' : ' (T ' + (T % W) + ',' + ((T / W) | 0) + ')'}, bfs reaches ${hit} over ${seen.size}`); }
		if (!p) { if (opts.missed) opts.missed.push(e); continue; }
		p.forEach(c => roads.add(c));
		chosen.add(p[0]);
		if (opts.edges) opts.edges.push({ end: p[0], cells: p.slice() });
	}
	// the stub past the point where the edges joined it leads nowhere: cut back every end that is not the town or a
	// link end (part of drawing the tree, not a repair of anything else)
	const keep = new Set([opts.town, ...chosen]);
	for (let changed = true; changed;) {
		changed = false;
		for (const c of [...roads]) {
			if (keep.has(c)) continue;
			const x = c % W, y = (c / W) | 0;
			if (DIRS.filter(([dx, dy]) => roads.has((y + dy) * W + x + dx)).length <= 1) { roads.delete(c); changed = true; }
		}
	}
	return roads;
}

/**
 * Real roads are one tile wide (none of the 71 real maps has a 2x2 block of road). Where two branches meet in a 2x2
 * block, the tile of the block with no road neighbour outside it goes; the other three stay joined (an L), and
 * nothing outside loses its link. A block whose every tile has an outside neighbour stays. Returns tiles removed.
 */
function thinSafe(roads, W, H, keep = null) {
	let cut = 0;
	const has = (x, y) => x >= 0 && y >= 0 && x < W && y < H && roads.has(y * W + x);
	for (let changed = true; changed;) {
		changed = false;
		for (const c of [...roads]) {
			const x = c % W, y = (c / W) | 0;
			if (!(has(x + 1, y) && has(x, y + 1) && has(x + 1, y + 1))) continue;
			const block = [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]];
			const inB = (a, b2) => block.some(([p, q]) => p === a && q === b2);
			const outside = ([a, b2]) => DIRS.filter(([dx, dy]) => !inB(a + dx, b2 + dy) && has(a + dx, b2 + dy)).length;
			const t = block.find(q => outside(q) === 0 && !(keep && keep.has(q[1] * W + q[0])));
			if (!t) continue;
			roads.delete(t[1] * W + t[0]); cut++; changed = true;
		}
	}
	return cut;
}

/**
 * Small loops go (K, 2026-10-02: "busted road logic....look at that loop on the left....makes no sense"). A road
 * tile with two road neighbours that are joined to each other by another road path of at most MAXLOOP steps sits on
 * a small loop; it goes, and the dangling ends left by it are cut back unless they are in `keep` (town gates, link
 * ends). The engine's roads are trees between their nodes. Returns tiles removed.
 */
// zoneOf (optional): a loop that stays inside one zone goes at any length up to 400 steps (a zone's road is a tree)
function breakLoops(roads, W, H, keep = null, MAXLOOP = 30, zoneOf = null) {
	let cut = 0;
	const nb = c => { const x = c % W, y = (c / W) | 0; return DIRS.map(([dx, dy]) => [x + dx, y + dy]).filter(([a, b]) => a >= 0 && b >= 0 && a < W && b < H && roads.has(b * W + a)).map(([a, b]) => b * W + a); };
	const reach = (from, to, skip, z = null) => {
		const seen = new Set([from, skip]), q = [[from, 0]], lim = z === null ? MAXLOOP : 400;
		for (let h = 0; h < q.length; h++) {
			const [c, d] = q[h];
			if (c === to) return true;
			if (d >= lim) continue;
			for (const m of nb(c)) if (!seen.has(m) && (z === null || zoneOf(m) === z)) { seen.add(m); q.push([m, d + 1]); }
		}
		return false;
	};
	for (let changed = true, guard = 0; changed && guard < 50; guard++) {
		changed = false;
		for (const c of [...roads]) {
			if (!roads.has(c) || (keep && keep.has(c))) continue;
			const n = nb(c);
			if (n.length !== 2) continue;
			if (!reach(n[0], n[1], c) && !(zoneOf && reach(n[0], n[1], c, zoneOf(c)))) continue;
			roads.delete(c); cut++; changed = true;
			// cut back what now dangles
			for (let e of n) for (let k = 0; k < 200 && roads.has(e) && !(keep && keep.has(e)) && nb(e).length <= 1; k++) { const nx = nb(e)[0]; roads.delete(e); cut++; if (nx === undefined) break; e = nx; }
		}
	}
	return cut;
}

module.exports = { routeEdge, zoneTree, bezier, thinSafe, breakLoops };
