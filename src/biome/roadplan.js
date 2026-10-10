/**
 * roadplan.js - roads laid before the content fill, and the tails pruned after.
 *
 * K (2026-09-27): "this is why i recommended early on that roads be build off
 * splines early on, not to be broken up by things placed around them." The
 * roads used to go in last (roadnet.js), a shortest path between towns around
 * whatever the fill had put down, so they hugged objects and map edges, and
 * the road patch cut into every roaded zone opening stayed as a tail when the
 * network passed elsewhere.
 *
 * Now each zone's roads are laid first, the engine's way (RoadPlacer.cpp): a
 * zone's road nodes are its towns, its roaded openings, and the monoliths and
 * subterranean gates of its links that have a road; with two or more, taken
 * in the engine's order (the topmost first, int3's), each node joins the roads
 * already laid in the zone over the zone's own ground, at the engine's step
 * cost (roadCosts), which keeps a road to the middle of its zone. The road
 * cells are then reserved, and the fill builds around them. After the fill,
 * roadnet.js still joins any town left out, and pruneTails cuts every road end
 * that leads to nothing.
 */
'use strict';

const { OCCUPIED, RESERVED } = require('./content');
const { route, addElbows, DIRS4: R4, DIRS8: R8 } = require('./roadnet');

const DIRS4 = [[0, -1], [1, 0], [0, 1], [-1, 0]];

/**
 * The engine's step cost for a road into each cell (RoadPlacer::createRoad,
 * rmg::Path::nonEuclideanCostFunction): a step costs 1, times a bias that
 * rises to 1.7 in a ring 20 to 30 tiles from the centre of mass of the zone's
 * border, divided by the squared distance to that border wherever that is more
 * than 1. The border is every cell of the zone with one of its eight
 * neighbours outside it (rmg::Area::getBorder), the map's edge included; water
 * is outside every zone, as the engine's water is a zone of its own. Returns
 * a Float64Array, Infinity off the zones.
 */
function roadCosts(zone, W, H, water) {
	const N = W * H;
	const zoneOf = c => (water && water[c] ? -1 : zone[c]);
	const d2 = new Float64Array(N).fill(Infinity);
	const near = new Int32Array(N).fill(-1);
	const queue = [];
	const sums = new Map();
	for (let c = 0; c < N; c++) {
		const z = zoneOf(c);
		if (z < 0) continue;
		const x = c % W, y = (c / W) | 0;
		let edge = false;
		for (let dy = -1; dy <= 1 && !edge; dy++)
			for (let dx = -1; dx <= 1; dx++) {
				const nx = x + dx, ny = y + dy;
				if ((dx || dy) && (nx < 0 || ny < 0 || nx >= W || ny >= H || zoneOf(ny * W + nx) !== z)) { edge = true; break; }
			}
		if (!edge) continue;
		d2[c] = 0;
		near[c] = c;
		queue.push(c);
		const s = sums.get(z) || [0, 0, 0];
		s[0] += x; s[1] += y; s[2]++;
		sums.set(z, s);
	}
	// each cell's nearest border cell, passed from neighbour to neighbour
	// (exact on these grids but for rare ties a tile apart)
	for (let h = 0; h < queue.length; h++) {
		const c = queue[h], s = near[c], sx = s % W, sy = (s / W) | 0, z = zoneOf(c);
		const x = c % W, y = (c / W) | 0;
		for (let dy = -1; dy <= 1; dy++)
			for (let dx = -1; dx <= 1; dx++) {
				const nx = x + dx, ny = y + dy;
				if (!(dx || dy) || nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const n = ny * W + nx;
				if (zoneOf(n) !== z) continue;
				const d = (nx - sx) ** 2 + (ny - sy) ** 2;
				if (d < d2[n]) { d2[n] = d; near[n] = s; queue.push(n); }
			}
	}
	const cost = new Float64Array(N).fill(Infinity);
	for (let c = 0; c < N; c++) {
		const s = sums.get(zoneOf(c));
		if (!s) continue;
		const r = Math.hypot(c % W - s[0] / s[2], ((c / W) | 0) - s[1] / s[2]);
		const t = Math.min(1, Math.max(0, (r - 20) / 10));
		const v = 1 + 0.7 * Math.sin(Math.PI * t);
		cost[c] = d2[c] > 1 ? v / d2[c] : v;
	}
	return cost;
}

/**
 * Cheapest four-connected path from any cell of `from` to any cell of `to`,
 * over cells `open(c)` allows, stepping into a cell at `cost(c)`. A small heap
 * keeps it quick on the biggest maps. Returns the path's cells or null.
 */
function cheapestPath(from, to, W, H, open, cost) {
	const N = W * H;
	const dist = new Float64Array(N).fill(Infinity);
	const prev = new Int32Array(N).fill(-1);
	const heap = [];
	const push = (c, v) => {
		heap.push([v, c]);
		for (let i = heap.length - 1; i > 0;) {
			const pi = (i - 1) >> 1;
			if (heap[pi][0] <= heap[i][0]) break;
			[heap[pi], heap[i]] = [heap[i], heap[pi]];
			i = pi;
		}
	};
	const pop = () => {
		const top = heap[0], last = heap.pop();
		if (heap.length) {
			heap[0] = last;
			for (let i = 0; ;) {
				const a = 2 * i + 1, b = a + 1;
				let m = i;
				if (a < heap.length && heap[a][0] < heap[m][0]) m = a;
				if (b < heap.length && heap[b][0] < heap[m][0]) m = b;
				if (m === i) break;
				[heap[m], heap[i]] = [heap[i], heap[m]];
				i = m;
			}
		}
		return top;
	};
	for (const s of from) if (s >= 0 && s < N && open(s)) { dist[s] = 0; push(s, 0); }
	const goal = to instanceof Set ? to : new Set(to);
	while (heap.length) {
		const [v, c] = pop();
		if (v > dist[c]) continue;
		if (goal.has(c)) {
			const path = [];
			for (let k = c; k !== -1; k = prev[k]) path.push(k);
			return path.reverse();
		}
		const x = c % W, y = (c / W) | 0;
		for (const [dx, dy] of DIRS4) {
			const nx = x + dx, ny = y + dy;
			if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
			const n = ny * W + nx;
			if (!open(n)) continue;
			const nv = v + cost(n);
			if (nv < dist[n]) { dist[n] = nv; prev[n] = c; push(n, nv); }
		}
	}
	return null;
}

/**
 * Lay level l's roads before the fill. plan: the level's plan (zone, openings,
 * roadCells, roadNodes, p.water); towns: [{x, y, l, gates}] on this level;
 * approach(town): the open cells beside a town's gate (roadnet.js); avoid(c):
 * cells no road may take (the zone walls before they are objects); standOn:
 * cells an object will stand on over the road (a doorway's guard). A zone
 * that already has roads (plan.roadCells) keeps them, and its new nodes join
 * them. Adds to plan.roadCells, reserves every road cell in `blocked` but
 * those, and returns { zones, cells, failed, failedNodes: [{z, cells}] }
 * (joinFailed takes those after the fill).
 */
function planRoads({ plan, towns, W, H, blocked, l, approach, avoid = null, standOn = null }) {
	const zone = plan.zone;
	const base = l * W * H;
	const free = c => !(blocked[base + c] & OCCUPIED) && !(avoid && avoid(c));
	// the road nodes of each zone: its towns; its roaded openings (a doorway is
	// a node of every zone it opens into); and the monoliths and subterranean
	// gates of its links that have a road (ConnectionsPlacer: both ends)
	const nodes = new Map();
	const townNodes = new Set();
	const townGates = new Map();   // a town's approach node -> its gate tiles: the road runs onto the gate (real maps: 1076 of 1078 towns)
	const splineEdges = [];
	const addNode = (z, cells) => {
		if (z < 0 || !cells.length) return;
		if (!nodes.has(z)) nodes.set(z, []);
		nodes.get(z).push(cells);
	};
	for (const t of towns) {
		if ((t.l || 0) !== l) continue;
		const cells = approach(t).filter(free);
		if (cells.length) { addNode(zone[cells[0]], cells); townNodes.add(cells); townGates.set(cells, (t.gates || []).filter(([gx, gy]) => gx >= 0 && gy >= 0 && gx < W && gy < H).map(([gx, gy]) => gy * W + gx)); }
	}
	// A roaded opening's own cells are road ground even under the link's guard,
	// which stands in the doorway on the road, as the engine's guards do
	const holeCells = new Set();
	// a doorway is one node shared by the zones it opens into
	const doorNodes = new Set();
	// gate and monolith ends: a road comes to one and stops there, never runs on past it (endRing, below)
	const endNodes = new Set();
	for (const o of plan.openings || []) {
		if (o.kind === 'portal' && o.roadNodes) {
			for (const [z, cells] of o.roadNodes) {
				const open = cells.filter(c => free(c) && zone[c] === z);
				const freeAny = cells.filter(free);
				// none free: the link's guard and the walls round the monolith hold them; the road still comes to the guard
				const arr = open.length ? open : freeAny.length ? freeAny : cells;
				if (process.env.VMAPGEN_ROAD_TRACE) console.error(`[roads] level ${l}: portal end in zone ${z}: ${cells.length} cell(s) beside it, ${open.length} free in the zone, ${arr.length} used`);
				addNode(z, arr);
				endNodes.add(arr);
			}
			continue;
		}
		if (o.kind !== 'openRoad' || !o.hole || !o.hole.length) continue;
		const cells = o.hole.filter(c => c >= 0 && c < W * H);
		if (!cells.length) continue;
		for (const c of cells) holeCells.add(c);
		const zones = new Set();
		for (const c of cells) {
			zones.add(zone[c]);
			const x = c % W, y = (c / W) | 0;
			for (const [dx, dy] of DIRS4) {
				const nx = x + dx, ny = y + dy;
				if (nx >= 0 && ny >= 0 && nx < W && ny < H && free(ny * W + nx)) zones.add(zone[ny * W + nx]);
			}
		}
		for (const z of zones) addNode(z, cells);
		doorNodes.add(cells);
	}
	for (const cells of plan.roadNodes || []) {
		const open = cells.filter(free);
		// none free: the link's guard and the walls round the gate hold them; with the spline layer the road still comes
		// to the guard (seed 3: two gate pairs into the central zone had no road on either side)
		const arr = open.length ? open : process.env.VMAPGEN_ROAD_SPLINES !== '0' ? cells.filter(c => zone[c] >= 0) : [];
		if (arr.length) { addNode(zone[arr[0]], arr); endNodes.add(arr); }
	}
	// The ground round each gate or monolith end is closed to every road but the one going to it: a road passing by
	// a gate's front, with a stub up onto the gate, made its guard stand at a junction (0.35 of our guards on a road
	// against the engine's 0.08, 2026-10-02). Off by default (VMAPGEN_ROAD_END_RING=1 on): tried, it left 8 road nodes
	// unreached instead of 1 and raised the junction share on the seed tested.
	const endRing = new Set();
	if (process.env.VMAPGEN_ROAD_END_RING === '1')
		for (const arr of endNodes) for (const c of arr) {
			const x = c % W, y = (c / W) | 0;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				const nx = x + dx, ny = y + dy;
				if (nx >= 0 && ny >= 0 && nx < W && ny < H) endRing.add(ny * W + nx);
			}
		}
	if (process.env.VMAPGEN_ROAD_TRACE) {
		const kinds = {};
		for (const o of plan.openings || []) kinds[o.kind] = (kinds[o.kind] || 0) + 1;
		const levelTowns = towns.filter(t => (t.l || 0) === l).length;
		console.error(`[roads] level ${l}: openings ${JSON.stringify(kinds)}; ${levelTowns} town(s); `
			+ `${(plan.roadNodes || []).length} gate/monolith node(s); nodes by zone `
			+ [...nodes].map(([z, list]) => `${z}:${list.length}`).join(' '));
	}
	const costs = roadCosts(zone, W, H, plan.p && plan.p.water);
	// On a spline cave the road rides the tunnels' centre lines (K, 2026-09-27: roads "build off splines early on, not
	// to be broken up by things placed around them"): a step along a spline costs SPINE_COST of an ordinary step.
	// VMAPGEN_ROAD_SPINE=0 ignores the splines.
	if (plan.spine && process.env.VMAPGEN_ROAD_SPINE !== '0') {
		const k = Number(process.env.VMAPGEN_ROAD_SPINE_COST || 0.35);
		for (let c = 0; c < W * H; c++) if (plan.spine[c] && Number.isFinite(costs[c])) costs[c] *= k;
	}
	// Roads that wander: a smooth noise field scales each tile's step cost, so a road follows the cheap valleys between
	// its ends instead of the straightest line. The engine's roads, routed between objects already placed, are about
	// 1.5 times ours between the same places (Coldshadow's Fantasy: about 800 road tiles a level against our 450 to
	// 630, 2026-10-02). VMAPGEN_ROAD_WANDER=0 off; the number is the noise's strength (default 0.8), wavelength
	// VMAPGEN_ROAD_WANDER_WAVE (default 9 tiles).
	const wander = process.env.VMAPGEN_ROAD_WANDER === undefined ? 0.8 : Number(process.env.VMAPGEN_ROAD_WANDER);
	if (wander > 0) {
		const { valueNoise } = require('./biomes');
		const wave = Number(process.env.VMAPGEN_ROAD_WANDER_WAVE || 9);
		const n = valueNoise((((plan.p && plan.p.seed) || 1) * 7919 + l * 104729) >>> 0, wave);
		for (let c = 0; c < W * H; c++) if (Number.isFinite(costs[c])) costs[c] *= Math.max(0.15, 1 - wander / 2 + wander * n(c % W, (c / W) | 0));
	}
	const cost = c => costs[c];
	// each zone's open tiles, for the curves' control points (below)
	const zoneCellsOf = new Map();
	const zoneCells = z => {
		if (!zoneCellsOf.has(z)) {
			const out = [];
			for (let c = 0; c < W * H; c++) if (zone[c] === z && free(c)) out.push(c);
			zoneCellsOf.set(z, out);
		}
		return zoneCellsOf.get(z);
	};
	let zonesRoaded = 0, failed = 0;
	const failedNodes = [];
	const laid = new Set();
	const had = new Map();
	for (const c of plan.roadCells || []) {
		if (!had.has(zone[c])) had.set(zone[c], new Set());
		had.get(zone[c]).add(c);
	}
	for (const [z, list] of nodes) {
		const before = had.get(z);
		if (list.length < 2 && !before) continue;
		// the engine keeps its nodes in a set of tiles, so the topmost (then
		// leftmost) starts the roads and the rest join in that order
		list.sort((a, b) => Math.min(...a) - Math.min(...b));
		const inZone = c => holeCells.has(c) || (free(c) && zone[c] === z);
		// A doorway is one road node, its middle cell, where the link's guard
		// stands (the engine's road node per link is the guard's tile), or
		// the cell the zone beyond already took, so the road runs on through
		// it. Each zone taking the doorway cell nearest itself broke the road
		// wherever the doorway's cells were not side by side (a diagonal zone
		// line), and the tail pass then dropped both halves (Golems Aplenty
		// 72, underground).
		const met = cells => {
			if (!doorNodes.has(cells)) return cells;
			const on = cells.filter(c => laid.has(c));
			return on.length ? on : [cells[(cells.length / 2) | 0]];
		};
		// the road spline layer (roadsplines.js, VMAPGEN_ROAD_SPLINES=1): the zone's tree drawn whole, town to T to
		// each link end, curved and stepped like the engine's; nothing after it repairs roads
		if (process.env.VMAPGEN_ROAD_SPLINES !== '0') {
			const zc = [];
			for (let c = 0; c < W * H; c++) if (zone[c] === z) zc.push(c);
			let h = (((plan.p && plan.p.seed) || 1) * 2654435761 + z * 40503 + l * 97) >>> 0;
			const rnd = () => { h ^= h << 13; h >>>= 0; h ^= h >>> 17; h ^= h << 5; h >>>= 0; return h / 4294967296; };
			const townNode = list.find(n => townNodes.has(n));
			const endCells = list.filter(n => n !== townNode).map(n => { const m = met(n); const g = doorNodes.has(n) && standOn ? m.find(c => standOn.has(c)) : undefined; if (g !== undefined) return g; const mid = m[(m.length / 2) | 0]; return [mid, ...m.filter(c => c !== mid)]; });
			const inner = zc.filter(c => { const x = c % W, y = (c / W) | 0; for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H || zone[ny * W + nx] !== z) return false; } return true; });
			const missed = [];
			// a zone in pieces (joined only through the other level) gets one tree per piece: the pieces of its open
			// ground, 4-neighbour, each with the ends and the town that touch it
			const piece = new Map(); let np = 0;
			// pieces of the zone's floor (cave floor below, any ground above), whatever stands on it: held town and gate ground split
			// the open tiles into false pieces and a zone's second town was left without a road (seed 2)
			const floor = c => zone[c] === z && (!plan.openMask || plan.openMask[c]) && !(plan.p && plan.p.water && plan.p.water[c]);
			for (const s0 of zc) { if (piece.has(s0) || !floor(s0)) continue; const st = [s0]; piece.set(s0, np); while (st.length) { const c = st.pop(), x = c % W, y = (c / W) | 0; for (const [dx, dy] of DIRS4) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; const m = ny * W + nx; if (!piece.has(m) && floor(m)) { piece.set(m, np); st.push(m); } } } np++; }
			const pieceOf = c => { if (piece.has(c)) return piece.get(c); const x = c % W, y = (c / W) | 0; for (const [dx, dy] of DIRS4) { const m = (y + dy) * W + x + dx; if (piece.has(m)) return piece.get(m); } return -1; };
			const cellOf = e => (Array.isArray(e) ? e : [e]);
			const tree = new Set();
			const groups = new Map();
			for (const e of endCells) { const k = cellOf(e).map(pieceOf).find(v => v >= 0) ?? -1; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); }
			const townPiece = townNode ? (townNode.map(pieceOf).find(v => v >= 0) ?? -1) : -2;
			if (townNode && !groups.has(townPiece)) groups.set(townPiece, []);
			for (const [k, ends] of groups) {
				const cellsK = k >= 0 ? zc.filter(c => piece.get(c) === k) : zc;
				const innerK = inner.filter(c => k < 0 || piece.get(c) === k);
				const t = require('./roadsplines').zoneTree({ W, H, open: inZone, cost, zoneCells: cellsK.length ? cellsK : zc, inner: innerK.length ? innerK : (cellsK.length ? cellsK : zc),
					town: townNode && k === townPiece ? townNode[0] : -1, ends, rng: rnd, existing: before || null, missed, edges: splineEdges, stub: Number(process.env.VMAPGEN_ROAD_STUB || 7) });
				if (t) for (const c of t) tree.add(c);
			}
			if (tree) {
				for (const c of tree) laid.add(c);
				// each town's gate tile joins the tree, through one 4-neighbour step where the tree only touches it diagonally
				for (const n of list) for (const g of townGates.get(n) || []) {
					const gx = g % W, gy = (g / W) | 0;
					const on4 = DIRS4.some(([dx, dy]) => laid.has((gy + dy) * W + gx + dx));
					if (on4) { laid.add(g); continue; }
					for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
						const d = (gy + dy) * W + gx + dx;
						if (!laid.has(d)) continue;
						const via = [gy * W + gx + dx, (gy + dy) * W + gx].find(c => free(c));
						if (via !== undefined) { laid.add(via); laid.add(g); break; }
					}
				}
				// an end no path reached is joined after the fill (joinFailed), as before
				if (process.env.VMAPGEN_ROAD_TRACE) console.error(`[roads] level ${l}: zone ${z}: spline tree ${tree.size} tiles, ${endCells.length} end(s) [${endCells.map(e => { const c = Array.isArray(e) ? e[0] : e; return (c % W) + ',' + ((c / W) | 0); }).join(' ')}], missed ${missed.length}${before ? ', joining roads already there' : ''}${missed.length ? ' at ' + missed.map(e => { const c = Array.isArray(e) ? e[0] : e; return `(${c % W},${(c / W) | 0})${townNodes.has(list.find(q => met(q).includes(c))) ? ' town' : doorNodes.has(list.find(q => met(q).includes(c))) ? ' door' : ' link end'}`; }).join(' ') : ''}`);
				// An end in a pocket of the cave whose only way out is a diagonal step (a town's chamber, its corners meeting
				// past the town's own tiles) gets its road through the one rock tile between: the engine lays its paths
				// before the rock, so its roads never meet this. Only rock of this zone, never beside another zone's floor.
				if (missed.length && plan.openMask && tree.size) {
					const still = [];
					const safe = m => { const x = m % W, y = (m / W) | 0; if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) return false; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const n = (y + dy) * W + x + dx; if (plan.openMask[n] && zone[n] !== z) return false; } return true; };
					for (const e of missed) {
						let ok = false;
						for (let tries = 0; tries < 3 && !ok; tries++) {
							const st0 = cellOf(e), region = new Set(st0), q = [...st0];
							for (let i = 0; i < q.length; i++) { const c = q[i], x = c % W, y = (c / W) | 0; for (const [dx, dy] of DIRS4) { const m = (y + dy) * W + x + dx; if (x + dx < 0 || y + dy < 0 || x + dx >= W || y + dy >= H || region.has(m) || !inZone(m)) continue; region.add(m); q.push(m); } }
							let wall = -1;
							for (const c of region) {
								const x = c % W, y = (c / W) | 0;
								for (const [dx, dy] of DIRS4) {
									const m = (y + dy) * W + x + dx, mx = x + dx, my = y + dy;
									if (mx < 0 || my < 0 || mx >= W || my >= H || plan.openMask[m] || zone[m] !== z || !safe(m)) continue;
									if (DIRS4.some(([ax, ay]) => { const n = (my + ay) * W + mx + ax; return !region.has(n) && inZone(n); })) { wall = m; break; }
								}
								if (wall >= 0) break;
							}
							if (wall < 0) break;
							plan.openMask[wall] = 1;
							blocked[base + wall] &= ~OCCUPIED;
							let p = null;
							for (const st of st0) { p = require('./roadsplines').routeEdge(st, tree, { W, H, open: inZone, cost }); if (p) break; }
							if (p) { p.forEach(c => { tree.add(c); laid.add(c); }); ok = true; if (process.env.VMAPGEN_ROAD_TRACE) console.error(`[roads] level ${l}: zone ${z}: end at (${st0[0] % W},${(st0[0] / W) | 0}) reached through the rock at (${wall % W},${(wall / W) | 0})`); }
						}
						if (!ok) still.push(e);
					}
					missed.length = 0;
					missed.push(...still);
				}
				if (process.env.VMAPGEN_ROAD_TRACE) for (const e of missed) { const s0 = Array.isArray(e) ? e[0] : e, sx = s0 % W, sy = (s0 / W) | 0; for (let y = sy - 42; y <= sy + 3; y++) { let ln = String(y).padStart(4); for (let x = sx - 30; x <= sx + 6; x++) { const c = y * W + x; ln += (x < 0 || y < 0 || x >= W || y >= H) ? " " : c === s0 ? "E" : tree.has(c) ? '#' : !floor(c) ? (zone[c] === z ? 'r' : '.') : inZone(c) ? 'o' : 'x'; } console.error(ln); } }
				for (const e of missed) { const e0 = Array.isArray(e) ? e[0] : e; const n = list.find(q => met(q).includes(e0)); failed++; failedNodes.push({ z, cells: n || (Array.isArray(e) ? e : [e]) }); }
				zonesRoaded++; continue;
			}
			failed++;
		}
		const first = met(list[0]);
		const roads = new Set(before || first);
		// the zone's doorway road tiles (where their guards stand), for joining roads away from them
		const doorRoad = new Set();
		for (const n of list) if (doorNodes.has(n)) for (const c of met(n)) doorRoad.add(c);
		const nearDoorRoad = c => { for (const d of doorRoad) if (Math.abs(d % W - c % W) <= 1 && Math.abs(((d / W) | 0) - ((c / W) | 0)) <= 1) return true; return false; };
		for (const node of before ? list : list.slice(1)) {
			const cells = met(node);
			if (cells.some(c => roads.has(c))) continue;
			// a road to anything but this end keeps off the ground round every gate or monolith end
			const own = new Set(endNodes.has(node) ? node : []);
			const inZoneHere = c => inZone(c) && (!endRing.has(c) || roads.has(c) || own.has(c)
				|| (endNodes.has(node) && node.some(d => Math.abs(d % W - c % W) <= 1 && Math.abs(((d / W) | 0) - ((c / W) | 0)) <= 1)));
			// A road bent through a waypoint to one side of the straight line between its ends, as a spline would run it
			// (K, 2026-09-27: roads built off splines). The engine's roads, routed between objects already down, are
			// about 1.7 times ours in its treasure zones (Coldshadow's Fantasy, 2026-10-02). The waypoint is the zone's
			// open cell nearest the bent midpoint; with none, or no way through it, the road runs straight.
			// Off by default: at 0.3 it moved Coldshadow's road tiles by +2% on the surface and -13% below (2026-10-02).
			// VMAPGEN_ROAD_BEND sets the side offset as a share of the leg's length.
			let path = null;
			const bend = process.env.VMAPGEN_ROAD_BEND === undefined ? 0 : Number(process.env.VMAPGEN_ROAD_BEND);
			if (bend > 0) {
				const n0 = cells[(cells.length / 2) | 0], nx0 = n0 % W, ny0 = (n0 / W) | 0;
				let near = -1, nd = Infinity;
				for (const r of roads) { const d = (r % W - nx0) ** 2 + (((r / W) | 0) - ny0) ** 2; if (d < nd) { nd = d; near = r; } }
				const len = Math.sqrt(nd);
				if (near >= 0 && len >= 8) {
					const rx = near % W, ry = (near / W) | 0;
					const h = ((n0 * 2654435761) >>> 0) / 4294967296;
					const side = (h < 0.5 ? -1 : 1) * bend * len * (0.6 + 0.8 * ((h * 7) % 1));
					const mx = (nx0 + rx) / 2 + (-(ry - ny0) / len) * side, my = (ny0 + ry) / 2 + ((rx - nx0) / len) * side;
					let via = -1, vd = Infinity;
					for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
						const x = Math.round(mx) + dx, y = Math.round(my) + dy;
						if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
						const c = y * W + x;
						if (!inZoneHere(c) || holeCells.has(c)) continue;
						const d = dx * dx + dy * dy;
						if (d < vd) { vd = d; via = c; }
					}
					if (via >= 0) {
						const a1 = cheapestPath(roads, [via], W, H, inZoneHere, cost);
						const a2 = a1 && cheapestPath([via], cells, W, H, inZoneHere, cost);
						if (a1 && a2) path = [...a1, ...a2];
					}
				}
			}
			// A gate's or a monolith's road follows a curve, as the engine's does (replaceWithCurvedPath, Functions.cpp):
			// a cubic Bezier from the end to the zone's centre through two tiles of the zone picked at random, each step
			// costing its squared distance from the curve (Path::createBezierCostFunction), until it meets the roads.
			// Ours ran straight: road tiles 1.0 to 1.1 times the shortest net joining their ends and junctions, the
			// engine's 1.2 to 1.27, and a third fewer road tiles in all (Coldshadow's Fantasy, 2026-10-02).
			// VMAPGEN_ROAD_CURVE=0 runs them straight; the number weighs the curve against the ground's own cost
			// (default 1).
			const curveK = process.env.VMAPGEN_ROAD_CURVE === undefined ? 1 : Number(process.env.VMAPGEN_ROAD_CURVE);
			if (!path && curveK > 0 && endNodes.has(node)) {
				const zc = zoneCells(z);
				if (zc.length > 8) {
					let h = (cells[0] * 2654435761 + ((plan.p && plan.p.seed) || 1) * 40503 + l * 97) >>> 0;
					const rnd = () => { h ^= h << 13; h >>>= 0; h ^= h >>> 17; h ^= h << 5; h >>>= 0; return h / 4294967296; };
					const P0 = [cells[0] % W, (cells[0] / W) | 0];
					const q1 = zc[(rnd() * zc.length) | 0], q2 = zc[(rnd() * zc.length) | 0];
					const P1 = [q1 % W, (q1 / W) | 0], P2 = [q2 % W, (q2 / W) | 0];
					let sx = 0, sy = 0;
					for (const c of zc) { sx += c % W; sy += (c / W) | 0; }
					const P3 = [sx / zc.length, sy / zc.length];
					const pts = [];
					for (let i = 0; i <= 64; i++) {
						const t = i / 64, u = 1 - t;
						const a0 = u * u * u, a1 = 3 * u * u * t, a2 = 3 * u * t * t, a3 = t * t * t;
						pts.push([a0 * P0[0] + a1 * P1[0] + a2 * P2[0] + a3 * P3[0], a0 * P0[1] + a1 * P1[1] + a2 * P2[1] + a3 * P3[1]]);
					}
					const off = new Map();
					const curveCost = c => {
						let d = off.get(c);
						if (d === undefined) {
							const x = c % W, y = (c / W) | 0;
							d = Infinity;
							for (const [px, py] of pts) { const e = (px - x) ** 2 + (py - y) ** 2; if (e < d) d = e; }
							off.set(c, d);
						}
						return cost(c) + curveK * 0.1 * d;
					};
					// to the roads at the zone's centre: the engine lays its links before anything else, so each curve runs on to
					// the centre and its roads are a star round the town; joined to the nearest road, ours stayed short
					const hub = [...roads].filter(c => (c % W - P3[0]) ** 2 + (((c / W) | 0) - P3[1]) ** 2 <= 64);
					path = cheapestPath(hub.length ? hub : roads, cells, W, H, inZoneHere, curveCost);
					if (process.env.VMAPGEN_ROAD_TRACE) console.error(`[roads] level ${l}: zone ${z}: curve from (${P0}) via (${P1}) (${P2}) to (${P3.map(Math.round)}), hub ${hub.length} of ${roads.size}, ${path ? path.length + ' cells' : 'no path'}`);
				}
			}
			// joined to the zone's roads away from a doorway's road tile, where its guard stands: attached there, the
			// doorway became a junction (0.35 of our guards on a road stood at one, the engine's 0.08, 2026-10-02).
			// Falls back to the whole network. VMAPGEN_ROAD_DOOR_APART=0 attaches anywhere.
			if (!path && process.env.VMAPGEN_ROAD_DOOR_APART !== '0' && doorRoad.size) {
				const away = new Set([...roads].filter(c => !nearDoorRoad(c)));
				if (away.size && away.size < roads.size) path = cheapestPath(away, cells, W, H, inZoneHere, cost);
			}
			path = path || cheapestPath(roads, cells, W, H, inZoneHere, cost)
				|| (cells !== node ? cheapestPath(roads, node, W, H, inZoneHere, cost) : null);
			if (!path) {
				failed++;
				failedNodes.push({ z, cells: node });
				if (process.env.VMAPGEN_ROAD_TRACE) {
					console.error(`[roads] level ${l}: zone ${z}: no way from the roads to the node at `
						+ cells.slice(0, 3).map(c => `(${c % W},${(c / W) | 0})`).join(' '));
					// the ground around it as the planner sees it: R road so far, N the
					// node, # occupied, + reserved, digits the zone (last digit)
					const cx = cells[0] % W, cy = (cells[0] / W) | 0;
					for (let y = Math.max(0, cy - 8); y <= Math.min(H - 1, cy + 8); y++) {
						let row = '';
						for (let x = Math.max(0, cx - 16); x <= Math.min(W - 1, cx + 16); x++) {
							const c = y * W + x;
							row += cells.includes(c) ? 'N' : roads.has(c) ? 'R' : !free(c) ? '#'
								: blocked[base + c] & RESERVED ? '+' : String(zone[c] % 10);
						}
						console.error(`[roads]   ${String(y).padStart(3)} ${row}`);
					}
				}
				continue;
			}
			for (const c of path) roads.add(c);
			if (process.env.VMAPGEN_ROAD_TRACE)
				console.error(`[roads] level ${l}: zone ${z}: node at (${cells[0] % W},${(cells[0] / W) | 0}) joined, ${path.length} cells`);
		}
		for (const c of roads) if (!before || !before.has(c)) laid.add(c);
		zonesRoaded++;
	}
	// a node's own cells joined no road unless a path reached them: only the
	// laid paths are road. A doorway's guard stands on its road, as the
	// engine's does (the guard's tile is the link's road node), so its cell is
	// road but not held clear: reserved, the guard could not be placed, and
	// every roaded doorway lost its guard (Jebus Cross 108 s5001: all four
	// starts walked into the centre unopposed)
	for (const c of laid) {
		plan.roadCells.add(c);
		if (!(standOn && standOn.has(c))) blocked[base + c] |= RESERVED;
	}
	return { zones: zonesRoaded, cells: laid.size, failed, failedNodes, edges: splineEdges };
}

/**
 * After the fill, the nodes planRoads could not reach join the roads of their
 * own zone, routed around what now stands: four ways first, then eight with
 * the elbows filled, as the town net was (roadnet.js). They are a town whose
 * gate faced a wall a later pass opened, or a pocket its zone reached only by
 * a diagonal step, which heroes take and a four-connected road cannot. A node
 * already on a road, or in a zone with none, is left alone. Returns the cells
 * added to roadCells.
 */
function joinFailed(failedNodes, roadCells, zone, W, H, blocked, l) {
	const base = l * W * H;
	let added = 0;
	for (const { z, cells } of failedNodes || []) {
		const side = cells.filter(c => !(blocked[base + c] & OCCUPIED));
		if (!side.length || side.some(c => roadCells.has(c))) continue;
		const targets = new Set([...roadCells].filter(c => zone[c] === z));
		if (!targets.size) continue;
		// the road spline layer joins what it missed the same way, after the fill: a 4-neighbour curve to the zone's roads
		if (process.env.VMAPGEN_ROAD_SPLINES !== '0') {
			const open = c => zone[c] === z && !(blocked[base + c] & OCCUPIED);
			let p = null;
			for (const st of side) { p = require('./roadsplines').routeEdge(st, targets, { W, H, open }); if (p) break; }
			if (p) { for (const c of p) if (!roadCells.has(c)) { roadCells.add(c); added++; } continue; }
		}
		// over the zone's own ground only (VMAPGEN_ROAD_ZONE_ONLY=0 lifts it): a join that ran through a neighbour's ground
		// cut a corridor through a border the template never opens (tools/mapsight zones, Coldshadow: 12.5 such links a map
		// against the engine's 1, e.g. a road from zone 9 into zone 16 at (26,27))
		const own = process.env.VMAPGEN_ROAD_ZONE_ONLY === '0' ? null : c => zone[c] === z;
		let path = route(side, targets, W, H, blocked, l, roadCells, R4, own);
		if (!path) {
			path = route(side, targets, W, H, blocked, l, roadCells, R8, own);
			if (path) path = addElbows(path, W, H, blocked, l);
		}
		if (!path) continue;
		for (const c of path) if (!roadCells.has(c)) { roadCells.add(c); added++; }
	}
	return added;
}

/**
 * Cut every road end that leads to nothing: a road cell with at most one road
 * neighbour goes, and the one before it is looked at again, unless the cell is
 * a destination (beside a town's gate, a mine's entrance, a subterranean gate).
 * Returns how many cells went.
 */
function pruneTails(roadCells, destinations, W, H) {
	const deg = c => {
		const x = c % W, y = (c / W) | 0;
		let n = 0;
		for (const [dx, dy] of DIRS4) {
			const nx = x + dx, ny = y + dy;
			if (nx >= 0 && ny >= 0 && nx < W && ny < H && roadCells.has(ny * W + nx)) n++;
		}
		return n;
	};
	let dropped = 0;
	const stack = [...roadCells].filter(c => deg(c) <= 1);
	while (stack.length) {
		const c = stack.pop();
		if (!roadCells.has(c) || destinations.has(c) || deg(c) > 1) continue;
		roadCells.delete(c);
		dropped++;
		const x = c % W, y = (c / W) | 0;
		for (const [dx, dy] of DIRS4) {
			const nx = x + dx, ny = y + dy;
			if (nx >= 0 && ny >= 0 && nx < W && ny < H && roadCells.has(ny * W + nx)) stack.push(ny * W + nx);
		}
	}
	return dropped;
}

module.exports = { planRoads, joinFailed, pruneTails, roadCosts, cheapestPath };
