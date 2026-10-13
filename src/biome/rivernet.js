/**
 * rivernet.js - run a few watercourses across a level.
 *
 * Rivers were never generated at all. Measured over 26 installed VCMI random
 * maps, 25 of 26 have them and they cover 1.8% of the surface, so a map with
 * none reads as flat in a way that is hard to name and easy to notice.
 *
 * A river does not block movement and does not change its cost, so unlike a
 * road it can run anywhere, including under objects. That makes the planning
 * simple: start on one edge, wander toward the far side, stop at the other
 * edge or when it meets water already laid. The wander is what stops a river
 * looking like a ruler.
 *
 * The river TYPE is the one the ground declares. terrains.json gives each
 * terrain a `river`, so dirt and sand run mud, snow runs ice, lava runs lava
 * and everything else runs water, which is why a real map's rivers change
 * colour as they cross a biome boundary.
 */
'use strict';

/**
 * Cells for one river, four-connected so the art reads as a continuous run.
 * `budget` caps how much water this river may add, so a single wander cannot
 * blow the map's whole allowance: the first version checked the total only
 * between rivers and a 36x36 asked for 23 tiles and got 68.
 */
function traceRiver(W, H, rng, cells, budget = Infinity) {
	const horizontal = rng() < 0.5;
	// start on one edge, aim for the opposite
	const forward = rng() < 0.5;
	let x, y, dx, dy;
	if (horizontal) {
		x = forward ? 0 : W - 1;
		y = 2 + ((rng() * (H - 4)) | 0);
		dx = forward ? 1 : -1; dy = 0;
	} else {
		x = 2 + ((rng() * (W - 4)) | 0);
		y = forward ? 0 : H - 1;
		dx = 0; dy = forward ? 1 : -1;
	}

	const added = [];
	const limit = Math.min((W + H) * 2, budget);  // a wander cannot run forever
	for (let step = 0; step < limit; step++) {
		if (x < 0 || y < 0 || x >= W || y >= H) break;
		const cell = y * W + x;
		if (cells.has(cell) && added.length) break;   // joined an existing run
		cells.add(cell);
		added.push(cell);
		// advance, with a sideways wobble about a third of the time
		if (rng() < 0.34) {
			if (horizontal) y += rng() < 0.5 ? 1 : -1;
			else x += rng() < 0.5 ? 1 : -1;
		} else {
			x += dx; y += dy;
		}
	}
	return added;
}

/**
 * Rivers routed over free ground (K, 2026-10-07 18:3x: "instances of these creeks running through objects and dead-ending out in the open";
 * the lead's option C, 2026-10-08: under plain scenery allowed, never under anything visited, a pickup or a guard ring).
 * A river starts at a map edge, at water or at another river, and ends at one of those at least `minLen` tiles away; it never crosses a tile
 * `forbid` marks (an object's footprint, a guard's ring) nor closed ground (`open` 0, rock underground) nor water; one that cannot reach an
 * end is not laid. The way is the cheapest by a coarse noise field, which bends it the way the random wander did, and a tile beside a river
 * already laid costs more, so two rivers meet at an end rather than run side by side. Measured before this on K's eight case maps: 109 of
 * 176 river ends in the open, 52% of river tiles under an object (the engine's own maps: 76 of 119 and 9%; K's rule is stricter).
 * Returns the set of river cells.
 */
function routeRivers(W, H, rng, share, { forbid = null, water = null, open = null, under = null } = {}) {
	const cells = new Set();
	const target = Math.round(W * H * share);
	if (target < 4) return cells;
	const N = W * H;
	const free = c => (!forbid || !forbid[c]) && (!open || open[c]) && !(water && water[c]);
	// a coarse value noise, 0..1, one knot every 6 tiles
	const G = 6, gw = Math.ceil(W / G) + 2, gh = Math.ceil(H / G) + 2, knots = new Float32Array(gw * gh);
	for (let i = 0; i < knots.length; i++) knots[i] = rng();
	const noise = (x, y) => {
		const fx = x / G, fy = y / G, ix = fx | 0, iy = fy | 0, tx = fx - ix, ty = fy - iy;
		const k = (a, b) => knots[(iy + b) * gw + ix + a];
		const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
		return (k(0, 0) * (1 - sx) + k(1, 0) * sx) * (1 - sy) + (k(0, 1) * (1 - sx) + k(1, 1) * sx) * sy;
	};
	const cost = new Float32Array(N);
	// under plain scenery (the lead's option C, 2026-10-08) a river may pass, at a cost, so it keeps to open ground and ducks under a wall to cross it
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) cost[y * W + x] = 1 + 6 * noise(x, y) + (under && under[y * W + x] ? 5 : 0);
	const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
	const wetBeside = c => { if (!water) return false; const x = c % W, y = (c / W) | 0; return N4.some(([dx, dy]) => { const u = x + dx, v = y + dy; return u >= 0 && v >= 0 && u < W && v < H && water[v * W + u]; }); };
	// a level with a sea (a body of 200 tiles or more): a river runs between water and water or another river, never to the map edge (K,
	// 2026-10-12, his XL Mediterranean on Coldshadow, "strange creek beginning and ends": 6 of his rivers' 9 ends lay on the map edge and
	// 1 at the sea; the engine's own Coldshadow 144 with water has none on the edge). VMAPGEN_RIVER_SEA_ENDS=0 keeps the edge.
	let sea = false;
	if (water && process.env.VMAPGEN_RIVER_SEA_ENDS !== '0') {
		const seen = new Uint8Array(N);
		for (let c0 = 0; c0 < N && !sea; c0++) {
			if (!water[c0] || seen[c0]) continue;
			const q = [c0]; seen[c0] = 1;
			for (let h = 0; h < q.length; h++) { const c = q[h], x = c % W, y = (c / W) | 0; for (const [dx, dy] of N4) { const u = x + dx, v = y + dy; if (u >= 0 && v >= 0 && u < W && v < H && water[v * W + u] && !seen[v * W + u]) { seen[v * W + u] = 1; q.push(v * W + u); } } }
			if (q.length >= 200) sea = true;
		}
	}
	const onEdge = c => { if (sea) return false; const x = c % W, y = (c / W) | 0; return x === 0 || y === 0 || x === W - 1 || y === H - 1; };
	const riverBeside = c => { const x = c % W, y = (c / W) | 0; return N4.some(([dx, dy]) => { const u = x + dx, v = y + dy; return u >= 0 && v >= 0 && u < W && v < H && cells.has(v * W + u); }); };
	// an end: free ground on the edge, beside water, or beside a river already laid
	// an end is in view: not under scenery
	const isEnd = c => free(c) && !(under && under[c]) && (onEdge(c) || wetBeside(c) || riverBeside(c));
	const starts = [];
	for (let c = 0; c < N; c++) if (free(c) && !(under && under[c]) && (onEdge(c) || wetBeside(c))) starts.push(c);
	const T = process.env.VMAPGEN_RIVER_TRACE ? { starts: starts.length, target, nogoal: 0, toolong: 0, laid: 0, skip: 0 } : null;
	if (!starts.length) { if (T) console.error("[river] " + JSON.stringify(T)); return cells; }
	let failed = 0;
	const dist = new Float64Array(N), prev = new Int32Array(N);   // doubles, as the heap holds them: a float32 store skipped tiles
	for (let tries = 0; tries < 80 && cells.size < target; tries++) {
		const s = starts[(rng() * starts.length) | 0];
		if (cells.has(s) || riverBeside(s)) continue;
		const sx = s % W, sy = (s / W) | 0;
		// end to end 15 to 35% of the map's span: a river that reads as one, crossing a zone wall or two under its scenery
		// shorter after each try that found no end, down to 8 (an island is smaller than the span: K's islands map had none)
		const minLen = Math.max(8, Math.round((W + H) * (0.15 + 0.2 * rng()) * Math.pow(0.8, failed)));
		dist.fill(Infinity); prev.fill(-1);
		dist[s] = 0;
		// a binary heap of [cost, cell]
		const heap = [[0, s]];
		const push = (d, c) => { heap.push([d, c]); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
		const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
		let goal = -1;
		while (heap.length) {
			const [d, c] = pop();
			if (d > dist[c]) continue;
			const cx = c % W, cy = (c / W) | 0;
			if (c !== s && isEnd(c) && Math.max(Math.abs(cx - sx), Math.abs(cy - sy)) >= minLen) { goal = c; break; }
			for (const [dx, dy] of N4) {
				const u = cx + dx, v = cy + dy;
				if (u < 0 || v < 0 || u >= W || v >= H) continue;
				const n = v * W + u;
				if (!free(n) || cells.has(n)) continue;
				// short of the goal, a tile on the edge, beside water or beside a river is a way along it, not into it
				const along = (onEdge(n) || wetBeside(n) || riverBeside(n)) && Math.max(Math.abs(u - sx), Math.abs(v - sy)) < minLen ? 8 : 0;
				const nd = d + cost[n] + along;
				if (nd < dist[n]) { dist[n] = nd; prev[n] = c; push(nd, n); }
			}
		}
		if (goal < 0) { failed++; if (T) T.nogoal++; continue; }
		const path = [];
		for (let c = goal; c >= 0; c = prev[c]) path.push(c);
		// the river the network asked for, not much more: a river longer than what is left (and a quarter) is passed over and the next try is shorter
		if (cells.size + path.length > target * 1.25 + 4) { failed++; if (T) T.toolong++; continue; }
		for (const c of path) cells.add(c);
		if (T) T.laid++;
	}
	if (T) console.error("[river] " + JSON.stringify(T) + " cells " + cells.size);
	return cells;
}

/**
 * Lay rivers over a level until roughly `share` of it carries water.
 * Returns the set of river cells. With `route` (the tiles to keep off and the water), rivers are routed by routeRivers.
 */
function buildRiverNetwork(W, H, rng, share = 0.018, route = null) {
	if (route) return routeRivers(W, H, rng, share, route);
	const cells = new Set();
	const target = Math.round(W * H * share);
	if (target < 4) return cells;
	// A river wants to be long enough to read as one, so aim for a span and a
	// half each and let the total decide how many there are: one on a small
	// map, three or four on a large one.
	const each = Math.max(8, Math.round((W + H) * 0.75));
	for (let tries = 0; tries < 12 && cells.size < target; tries++)
		traceRiver(W, H, rng, cells, Math.min(each, target - cells.size + 2));
	return cells;
}

module.exports = { buildRiverNetwork, traceRiver, routeRivers };
