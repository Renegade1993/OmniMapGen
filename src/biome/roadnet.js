/**
 * roadnet.js - lay a road network between the towns of a level.
 *
 * Roads used to be the two or three cells of a carved doorway and nothing
 * else, so a generated map showed a few disconnected patches of road surface
 * and the word "road" was doing no work. Measured over 30 of the installed
 * VCMI random maps, a real surface is 4.3% roaded and the road is almost
 * always cobblestone, and it runs between the places worth walking between.
 *
 * Roads are not decoration in Heroes 3. Cobblestone costs 50 movement per
 * tile against 100 for open ground, so a connected network changes how far a
 * hero gets in a day, for the AI as much as for a player.
 *
 * Method: a minimum spanning tree over the towns, each edge routed as a
 * shortest path across walkable ground. Cells that already carry road are
 * nearly free, so later branches merge into the trunk instead of running
 * beside it. Paths are four-connected, which is what road art is drawn for;
 * heroes still move eight ways, so a four-connected road is a real path, it
 * is just drawn as straights and corners rather than a diagonal stipple.
 */
'use strict';

const { OCCUPIED } = require('./content');

const DIRS4 = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const DIRS8 = [[0, -1], [1, 0], [0, 1], [-1, 0], [1, -1], [1, 1], [-1, 1], [-1, -1]];

/**
 * Dijkstra from any cell in `sources` to any cell in `targets`.
 * Existing road is cheap so branches share a trunk. Returns the path as an
 * array of cell indices, or null.
 */
function route(sources, targets, W, H, blocked, l, roadCells, dirs) {
	const base = l * W * H;
	const N = W * H;
	const dist = new Float64Array(N).fill(Infinity);
	const prev = new Int32Array(N).fill(-1);
	const goal = targets instanceof Set ? targets : new Set(targets);
	// small bucket queue is enough: costs are 1 or 0.25
	let queue = [];
	for (const s of sources) {
		if (s < 0 || s >= N || (blocked[base + s] & OCCUPIED)) continue;
		dist[s] = 0;
		queue.push(s);
	}
	if (!queue.length) return null;
	const seen = new Uint8Array(N);
	while (queue.length) {
		// pick the cheapest pending cell; the frontier stays small enough that
		// a linear scan beats the bookkeeping of a heap at these map sizes
		let bi = 0;
		for (let i = 1; i < queue.length; i++)
			if (dist[queue[i]] < dist[queue[bi]]) bi = i;
		const c = queue[bi];
		queue[bi] = queue[queue.length - 1];
		queue.pop();
		if (seen[c]) continue;
		seen[c] = 1;
		if (goal.has(c)) {
			const path = [];
			for (let k = c; k !== -1; k = prev[k]) path.push(k);
			return path.reverse();
		}
		const x = c % W, y = (c / W) | 0;
		for (const [dx, dy] of dirs) {
			const nx = x + dx, ny = y + dy;
			if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
			const n = ny * W + nx;
			if (seen[n] || (blocked[base + n] & OCCUPIED)) continue;
			// Trunk preference: corpus roads are a few big nets (largest
			// component holds ~52% of road cells), ours ran 41.8% under
			// 0.25 with the balance spread over shards. 0.12 makes a join
			// ride the trunk for the stretch it can instead of paralleling.
			const step = roadCells.has(n) ? 0.12 : 1;
			if (dist[c] + step < dist[n]) {
				dist[n] = dist[c] + step;
				prev[n] = c;
				queue.push(n);
			}
		}
	}
	return null;
}

/** Insert the corner cell for every diagonal step, where the ground allows. */
function addElbows(path, W, H, blocked, l) {
	const base = l * W * H;
	const out = [path[0]];
	for (let i = 1; i < path.length; i++) {
		const a = path[i - 1], b = path[i];
		const ax = a % W, ay = (a / W) | 0, bx = b % W, by = (b / W) | 0;
		if (ax !== bx && ay !== by) {
			const c1 = ay * W + bx, c2 = by * W + ax;
			if (!(blocked[base + c1] & OCCUPIED)) out.push(c1);
			else if (!(blocked[base + c2] & OCCUPIED)) out.push(c2);
		}
		out.push(b);
	}
	return out;
}

/** Open cells beside a town's gate: where a road meets the town. */
function approach(town, W, H, blocked, l) {
	const base = l * W * H;
	// Corpus: 91% of towns sit next to road. The 1-ring gate lip alone left
	// 31% of our towns roadless - scenery crowds the lip on a busy map - so
	// the ring widens until some open ground next to the town is found.
	for (let r = 1; r <= 3; r++) {
		const out = [];
		for (const [vx, vy] of town.gates || []) {
			for (let dy = -r; dy <= r; dy++)
				for (let dx = -r; dx <= r; dx++) {
					if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
					const nx = vx + dx, ny = vy + dy;
					if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
					const c = ny * W + nx;
					if (blocked[base + c] & OCCUPIED) continue;
					out.push(c);
				}
		}
		if (out.length) return out;
	}
	return [];
}

/**
 * Connect every town on the level, adding to `roadCells` in place.
 * towns: [{x, y, gates:[[x,y],...]}]. Returns how many cells were added.
 */
function buildRoadNetwork(towns, roadCells, W, H, blocked, l) {
	if (!towns || towns.length < 2) return 0;
	const nodes = towns.map(t => ({ t, side: approach(t, W, H, blocked, l) }))
		.filter(n => n.side.length);
	if (nodes.length < 2) return 0;

	const before = roadCells.size;
	// Prim's: grow one tree, always joining the nearest town still outside it.
	//
	// The tree's frontier is the towns already joined plus the cells THIS
	// network has laid, never the road patches that were already on the map.
	// Seeding from those instead let a route start at a doorway patch near the
	// target and finish 20 cells later without ever touching the first town.
	let net = new Set();
	let inTree = [0];
	const outside = nodes.map((_, i) => i).slice(1);
	while (outside.length) {
		// route from everything already connected to every remaining town at
		// once, so the cheapest join is found without measuring each pair
		const sources = [];
		for (const i of inTree) sources.push(...nodes[i].side);
		for (const c of net) sources.push(c);
		const targetOf = new Map();
		const targets = new Set();
		for (const i of outside)
			for (const c of nodes[i].side) { targets.add(c); targetOf.set(c, i); }

		let path = route(sources, targets, W, H, blocked, l, roadCells, DIRS4);
		// a four-connected route can fail where an eight-connected one exists,
		// for instance through a doorway only a diagonal step wide
		if (!path) {
			path = route(sources, targets, W, H, blocked, l, roadCells, DIRS8);
			// A diagonal step leaves two road tiles with no orthogonal
			// neighbour, and the orphan sweep then deletes both. On one duel
			// seed that took a 44 cell network down to 12. Fill the elbow so
			// the run stays four-connected wherever the ground allows it.
			if (path) path = addElbows(path, W, H, blocked, l);
		}
		if (!path) {
			// Nothing else this network reaches by road. The towns left stand
			// on other islands, or in zones joined only by a portal pair:
			// they get a network of their own rather than none.
			inTree = [outside.shift()];
			net = new Set();
			continue;
		}
		for (const c of path) { roadCells.add(c); net.add(c); }
		const joined = targetOf.get(path[path.length - 1]);
		inTree.push(joined);
		outside.splice(outside.indexOf(joined), 1);
	}
	return roadCells.size - before;
}

/**
 * Drop road tiles with no orthogonal neighbour.
 *
 * A carved doorway is marked as roaded whether or not the network ended up
 * using it, which leaves one or two tiles of road surface in the middle of
 * nowhere, drawn as the fall-back single-tile segment. A genuine dead end
 * keeps its one neighbour and survives. Runs on every level, including an
 * underground with no towns and therefore no network of its own.
 */
function pruneOrphanRoads(roadCells, W, H) {
	let dropped = 0;
	for (const c of [...roadCells]) {
		const x = c % W, y = (c / W) | 0;
		let joined = false;
		for (const [dx, dy] of DIRS4) {
			const nx = x + dx, ny = y + dy;
			if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
			if (roadCells.has(ny * W + nx)) { joined = true; break; }
		}
		if (!joined) { roadCells.delete(c); dropped++; }
	}
	return dropped;
}

module.exports = { buildRoadNetwork, pruneOrphanRoads, route, approach, addElbows, DIRS4, DIRS8 };
