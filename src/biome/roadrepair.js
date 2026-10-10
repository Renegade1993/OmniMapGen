'use strict';
/**
 * roadrepair.js - the last word on roads, after every object is in: no road ends at nothing.
 *
 * The roads go down early (roadplan.js) and later passes (late gates and monoliths, thinning, entrance stubs, the
 * fill) can leave a road broken a tile or two short of the rest, or running on to nothing. mapsight check found 1 to 11
 * such ends a map on Coldshadow's Fantasy (2026-10-02); the engine's maps have none. Here, on the final layout:
 *
 *   1. a road end within two tiles of another piece of road joins it, over ground no permanent object blocks (a
 *      monster or a pickup may stand on a road, as on the engine's maps);
 *   2. every other end that is not at an entrance (a town's, a mine's, a gate's, a monolith's) is cut back, tile by
 *      tile, to its junction.
 *
 * An end is what mapsight calls one: a road tile with at most one road neighbour, or two that touch each other.
 * VMAPGEN_ROAD_REPAIR=0 skips it.
 */

const N8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

function roadRepair(plan, W, H, l, blocked, OCCUPIED, REMOVABLE, blockingCells, visitableCells, isScenery = null) {
	const road = plan.roadCells;
	if (!road || !road.size) return { joined: 0, cut: 0 };
	const base = l * W * H;
	const objs = plan.objects.filter(o => (o.l || 0) === l && o.template && o.template.mask);
	// tiles a road may not cross: blocked by something that stays
	const hard = new Uint8Array(W * H);
	const owners = new Map();
	for (const o of objs)
		for (const [x, y] of blockingCells(o.template, o.x, o.y)) {
			if (x < 0 || y < 0 || x >= W || y >= H) continue;
			const c = y * W + x;
			if (!owners.has(c)) owners.set(c, []);
			owners.get(c).push(o);
		}
	for (let c = 0; c < W * H; c++) {
		if (!(blocked[base + c] & OCCUPIED)) continue;
		const own = owners.get(c);
		hard[c] = !own || !own.every(o => REMOVABLE.has(o.type)) ? 1 : 0;
	}
	// entrances: the visitable tiles of towns, mines, gates and monoliths, and the ground round them
	const dest = new Set();
	for (const o of objs) {
		if (!/^(town$|randomTown$|mine$|subterraneanGate|monolith)/.test(o.type)) continue;
		for (const [vx, vy] of visitableCells(o.template, o.x, o.y))
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				const x = vx + dx, y = vy + dy;
				if (x >= 0 && y >= 0 && x < W && y < H) dest.add(y * W + x);
			}
	}
	const isRoad = (x, y) => x >= 0 && y >= 0 && x < W && y < H && road.has(y * W + x);
	const isEnd = c => {
		const x = c % W, y = (c / W) | 0;
		const ring = N8.map(([dx, dy]) => (isRoad(x + dx, y + dy) ? 1 : 0));
		const n = ring.reduce((a, b) => a + b, 0);
		let runs = 0;
		for (let k = 0; k < 8; k++) if (ring[k] && !ring[(k + 7) % 8]) runs++;
		return n <= 1 || (n === 2 && runs === 1);
	};
	const label = () => {
		const comp = new Map();
		let id = 0;
		for (const c of road) {
			if (comp.has(c)) continue;
			const st = [c]; comp.set(c, id);
			while (st.length) {
				const k = st.pop(), x = k % W, y = (k / W) | 0;
				for (const [dx, dy] of N8) {
					const nx = x + dx, ny = y + dy;
					if (!isRoad(nx, ny)) continue;
					const m = ny * W + nx;
					if (!comp.has(m)) { comp.set(m, id); st.push(m); }
				}
			}
			id++;
		}
		return comp;
	};
	let joined = 0, cut = 0;
	// the tiles a building is entered from: beside its visitable tile, where its visitableFrom permits (as mapsight reads it)
	const ways = o => {
		const vf = o.template.visitableFrom || ['+++', '+-+', '+++'];
		const outW = [];
		for (const [vx, vy] of visitableCells(o.template, o.x, o.y))
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				if ((!dx && !dy) || (vf[dy + 1] || '')[dx + 1] !== '+') continue;
				const x = vx + dx, y = vy + dy;
				if (x >= 0 && y >= 0 && x < W && y < H) outW.push(y * W + x);
			}
		return outW;
	};
	// Scenery (small, inside one zone, off its border) a gap's join may go through, taking it out: two roads walled
	// apart by a rock or two, each ending at an entrance, were neither joined nor cut (Coldshadow seed 2, 2026-10-02).
	// VMAPGEN_ROAD_THROUGH_SCENERY=0 never does.
	const zoneOf = plan.zone;
	const onBorder = c => { if (!zoneOf) return false; const x = c % W, y = (c / W) | 0, z = zoneOf[c]; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < W && ny < H && zoneOf[ny * W + nx] !== z) return true; } return false; };
	const sceneryOnly = c => {
		if (!isScenery || process.env.VMAPGEN_ROAD_THROUGH_SCENERY === '0') return false;
		const own = owners.get(c);
		return !!own && own.length > 0 && own.every(o => isScenery(o) && blockingCells(o.template, o.x, o.y).length <= 4) && !onBorder(c);
	};
	let throughScenery = false;
	const joinGaps = () => {
		for (let round = 0; round < 6; round++) {
			const comp = label();
			let changed = false;
			for (const c of [...road]) {
				if (!road.has(c) || !isEnd(c)) continue;
				const x = c % W, y = (c / W) | 0;
				// another piece within five steps over ground no permanent object blocks, a detour round scenery included (mapsight calls an end a gap when
				// another piece lies within three tiles)
				const prev = new Map([[c, -1]]);
				let front = [c], hit = -1;
				for (let step = 0; step < 7 && hit < 0; step++) {   // 7: two ends 3 tiles apart round a building's corner needed 6 (seed 1)
					const next = [];
					for (const k of front) {
						const kx = k % W, ky = (k / W) | 0;
						for (const [dx, dy] of N8) {
							const nx = kx + dx, ny = ky + dy;
							if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
							const m = ny * W + nx;
							if (prev.has(m)) continue;
							prev.set(m, k);
							if (road.has(m)) { if (comp.get(m) !== comp.get(c)) { hit = m; break; } continue; }
							if (hard[m] && !(throughScenery && sceneryOnly(m) && (!zoneOf || zoneOf[m] === zoneOf[c]))) continue;
							next.push(m);
						}
						if (hit >= 0) break;
					}
					front = next;
				}
				if (hit >= 0) {
					for (let k = prev.get(hit); k >= 0 && k !== c; k = prev.get(k)) {
						if (hard[k]) {
							// take out the scenery standing here
							for (const o of (owners.get(k) || []).slice()) {
								const i = plan.objects.indexOf(o);
								if (i < 0) continue;
								plan.objects.splice(i, 1);
								for (const [bx, by] of blockingCells(o.template, o.x, o.y)) {
									if (bx < 0 || by < 0 || bx >= W || by >= H) continue;
									const bc = by * W + bx;
									blocked[base + bc] &= ~OCCUPIED; hard[bc] = 0;
									const list = owners.get(bc); if (list && list.includes(o)) list.splice(list.indexOf(o), 1);
								}
							}
						}
						if (!road.has(k)) { road.add(k); joined++; }
					}
					changed = true;
				}
			}
			if (!changed) break;
		}
	};
	joinGaps();
	// A town with no road at its gate gets one, to the nearest road or mine of its own zone, over ground no permanent
	// object blocks: the engine draws a zone's roads to its mines when the zone has fewer than two road nodes
	// (RoadPlacer::connectRoads), and its maps have no town without a road (ours had 3 or 4 a map, 2026-10-02).
	if (process.env.VMAPGEN_TOWN_ROADS !== '0' && plan.zone) {
		const zoneOf = plan.zone;
		const mineDoor = new Set();
		for (const o of objs) if (o.type === 'mine') for (const [vx, vy] of visitableCells(o.template, o.x, o.y)) if (vx >= 0 && vy >= 0 && vx < W && vy < H) mineDoor.add(vy * W + vx);
		for (const t of objs) {
			if (t.type !== 'town' && t.type !== 'randomTown') continue;
			const gates = visitableCells(t.template, t.x, t.y).filter(([a, b]) => a >= 0 && b >= 0 && a < W && b < H).map(([a, b]) => b * W + a);
			if (!gates.length) continue;
			const z = zoneOf[gates[0]];
			// joined: road on the gate or on a tile the town is entered from. Road two tiles off counted before, and a town
			// whose gate opened into a pocket away from that road was left with none (Coldshadow seed 1, 2026-10-02)
			if (gates.some(g => road.has(g)) || ways(t).some(i => road.has(i))) continue;
			// breadth first from the gate over open ground of the zone, to a road tile or a mine's entrance, at most 60 steps
			const prev = new Map(gates.map(g => [g, -1]));
			let front = gates.slice(), hit = -1;
			for (let step = 0; step < 60 && hit < 0 && front.length; step++) {
				const next = [];
				for (const k of front) {
					const kx = k % W, ky = (k / W) | 0;
					for (const [dx, dy] of N8) {
						const nx = kx + dx, ny = ky + dy;
						if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
						const m = ny * W + nx;
						if (prev.has(m) || zoneOf[m] !== z) continue;
						prev.set(m, k);
						if (road.has(m) || mineDoor.has(m)) { hit = m; break; }
						if (hard[m]) continue;
						next.push(m);
					}
					if (hit >= 0) break;
				}
				front = next;
			}
			if (hit < 0) continue;
			for (let k = hit; k >= 0; k = prev.get(k)) if (!road.has(k) && !mineDoor.has(k)) { road.add(k); dest.add(k); joined++; }
		}
	}
	// the town roads can end a tile or two short of another road: join again, then once more through small scenery
	joinGaps();
	throughScenery = true;
	joinGaps();
	throughScenery = false;
	// an end three tiles or less from an entrance runs on to it, over ground no permanent object blocks
	const doors = [];
	for (const o of objs) {
		if (!/^(town$|randomTown$|mine$|subterraneanGate|monolith)/.test(o.type)) continue;
		for (const [vx, vy] of visitableCells(o.template, o.x, o.y)) if (vx >= 0 && vy >= 0 && vx < W && vy < H) doors.push([vx, vy]);
	}
	for (const c of [...road]) {
		if (!road.has(c) || dest.has(c) || !isEnd(c)) continue;
		let x = c % W, y = (c / W) | 0;
		const near = doors.filter(([vx, vy]) => Math.max(Math.abs(vx - x), Math.abs(vy - y)) <= 3)
			.sort((a, b) => Math.max(Math.abs(a[0] - x), Math.abs(a[1] - y)) - Math.max(Math.abs(b[0] - x), Math.abs(b[1] - y)))[0];
		if (!near) continue;
		const path = [];
		let ok = true;
		while (Math.max(Math.abs(near[0] - x), Math.abs(near[1] - y)) > 1) {
			x += Math.sign(near[0] - x); y += Math.sign(near[1] - y);
			const m = y * W + x;
			if (hard[m]) { ok = false; break; }
			path.push(m);
		}
		if (ok) for (const m of path) if (!road.has(m)) { road.add(m); dest.add(m); joined++; }
	}
	// a road beside a town's gate runs onto it: the real maps put road on the gate tile for 1076 of 1078 towns, and the
	// extension above stops a tile short (k0930.test.js, 72x72 free seeds 5 and 6, 2026-10-02)
	for (const o of objs) {
		if (o.type !== 'town' && o.type !== 'randomTown') continue;
		const g = visitableCells(o.template, o.x, o.y)[0];
		if (!g || g[0] < 0 || g[1] < 0 || g[0] >= W || g[1] >= H) continue;
		const gc = g[1] * W + g[0];
		if (road.has(gc)) continue;
		let beside = false;
		for (let dy = -1; dy <= 1 && !beside; dy++) for (let dx = -1; dx <= 1; dx++) if (isRoad(g[0] + dx, g[1] + dy)) { beside = true; break; }
		if (beside) { road.add(gc); dest.add(gc); joined++; }
	}
	// A road end within three tiles of a building none of whose ways in has road runs on to one of them, over ground no
	// permanent object blocks, eight steps at most: mapsight's gate counts each such end as a road stopped short (ours 4 to
	// 14 a map on Coldshadow's Fantasy, the engine's 0 to 3, 2026-10-02). The ways in are the tiles beside the visitable
	// tile its visitableFrom permits, as mapsight reads them. VMAPGEN_ROAD_REACH=0 skips it.
	if (process.env.VMAPGEN_ROAD_REACH !== '0') {
		const buildings = objs.filter(o => /^(town$|randomTown$|mine$|abandonedMine|creatureGenerator|creatureBank|subterraneanGate|monolith)/.test(o.type))
			.map(o => ({ o, v: visitableCells(o.template, o.x, o.y)[0], w: ways(o) }))
			.filter(b => b.v);
		// building by building: an end that ran on to one building can still stand three tiles from another
		for (const b of [...buildings, ...buildings]) {   // twice: a new arm can end beside another building
			if (b.w.some(i => road.has(i))) continue;
			// a bank or a dwelling only where a guard stands within 2 of the tile the road comes to (its ring then touches the
			// end, which mapsight counts as proper; within 1 left 4 near misses on seed 4): mapsight counts an end at an
			// unguarded one as a road ending at an object (seeds 2, 4, 7, 8 of v26)
			const guarded = i => objs.some(m => (m.type === 'monster' || /^randomMonster/.test(m.type)) && Math.abs(m.x - i % W) <= 2 && Math.abs(m.y - ((i / W) | 0)) <= 2);
			const sideKind = /^(creatureGenerator|creatureBank)/.test(b.o.type);
			const goal = new Set(b.w.filter(i => !hard[i] && (!sideKind || guarded(i))));
			if (!goal.size) continue;
			const ends = [];
			for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
				const x = b.v[0] + dx, y = b.v[1] + dy;
				if (isRoad(x, y) && isEnd(y * W + x)) ends.push(y * W + x);
			}
			for (const c of ends) {
				const prev = new Map([[c, -1]]);
				let front = [c], hit = -1;
				for (let step = 0; step < 8 && hit < 0 && front.length; step++) {
					const next = [];
					for (const k of front) {
						const kx = k % W, ky = (k / W) | 0;
						for (const [dx, dy] of N8) {
							const nx = kx + dx, ny = ky + dy;
							if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
							const m = ny * W + nx;
							if (prev.has(m) || hard[m]) continue;
							prev.set(m, k);
							if (goal.has(m)) { hit = m; break; }
							next.push(m);
						}
						if (hit >= 0) break;
					}
					front = next;
				}
				if (hit < 0) continue;
				for (let k = hit; k >= 0 && k !== c; k = prev.get(k)) if (!road.has(k)) { road.add(k); dest.add(k); joined++; }
				dest.add(c);
				break;
			}
		}
	}
	// the reach can leave two ends a few tiles apart: join once more
	joinGaps();
	// cut back every end that is not at an entrance
	for (let round = 0; round < W + H; round++) {
		let changed = false;
		for (const c of [...road]) {
			if (!road.has(c) || dest.has(c) || !isEnd(c)) continue;
			road.delete(c); cut++; changed = true;
		}
		if (!changed) break;
	}
	return { joined, cut };
}

module.exports = { roadRepair };
