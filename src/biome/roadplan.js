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
	const addNode = (z, cells) => {
		if (z < 0 || !cells.length) return;
		if (!nodes.has(z)) nodes.set(z, []);
		nodes.get(z).push(cells);
	};
	for (const t of towns) {
		if ((t.l || 0) !== l) continue;
		const cells = approach(t).filter(free);
		if (cells.length) addNode(zone[cells[0]], cells);
	}
	// A roaded opening's own cells are road ground even under the link's guard,
	// which stands in the doorway on the road, as the engine's guards do
	const holeCells = new Set();
	// a doorway is one node shared by the zones it opens into
	const doorNodes = new Set();
	for (const o of plan.openings || []) {
		if (o.kind === 'portal' && o.roadNodes) {
			for (const [z, cells] of o.roadNodes) {
				const open = cells.filter(c => free(c) && zone[c] === z);
				addNode(z, open.length ? open : cells.filter(free));
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
		if (open.length) addNode(zone[open[0]], open);
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
	const cost = c => costs[c];
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
		const first = met(list[0]);
		const roads = new Set(before || first);
		for (const node of before ? list : list.slice(1)) {
			const cells = met(node);
			if (cells.some(c => roads.has(c))) continue;
			const path = cheapestPath(roads, cells, W, H, inZone, cost)
				|| (cells !== node ? cheapestPath(roads, node, W, H, inZone, cost) : null);
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
	return { zones: zonesRoaded, cells: laid.size, failed, failedNodes };
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
		let path = route(side, targets, W, H, blocked, l, roadCells, R4);
		if (!path) {
			path = route(side, targets, W, H, blocked, l, roadCells, R8);
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
