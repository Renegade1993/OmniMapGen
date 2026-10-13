'use strict';
/**
 * gateroad.js - the road runs onto the visiting tile of every gate and monolith (K, 2026-10-04: "portals and subterranean gates are
 * still being missed by roads"). In the engine's maps the road is ON the visitable tile of 72% of monolith ends and 81% of gates
 * (tools/map_metrics.js roadAtEntrance), and where a road is drawn to one it ends there.
 *
 * Earlier passes (gateStubs, the zone joins, the spline take-back) treat the ring round an entrance as the end of a road, so a road
 * that reaches a gate stops on a tile beside the visiting tile, and a gate or monolith placed late, or opened in a pocket the zone's
 * roads never reached, gets no road at all. This is the last road pass: for every gate and monolith end with no road on its visiting
 * tile, the shortest run of free floor to the level's nearest road is laid (steps in eight directions as the engine's roads take, over floor no object blocks and not
 * water; a monster's tile may carry road), the tile itself included. An end no free floor connects to a road stays as it is.
 * VMAPGEN_TELEPORT_ROADS=0 skips it. Returns { onto, joined, none }: ends whose neighbour was road (the tile only), ends that took
 * a run of more than one tile, ends nothing reached.
 */
const D8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const TYPES = /^(subterraneanGate|monolith)/;
const PICKUP = /^(resource|randomResource|treasureChest|campfire|randomArtifact|artifact|spellScroll|pandoraBox)/;
// gone once visited, as a pickup is: a town's road may run under one (K's 72x72 s710452006, 2026-10-08: a scholar in the one way out of a
// castle's front pocket left the castle with no road, the break he circled)
const ONE_VISIT = /^(scholar|seaChest|flotsam)$/;
// anchored: a mod building named "townGate" matched "town" and kept a road ending beside it (grid, 108x108 seed 1, 2026-10-09)
const SERVED = /^(mine|abandonedMine|monolith|subterraneanGate)|^(town|randomTown)$/;
const REACH = 60;       // the longest run laid for one end, in tiles
// the step costs of an eight-way road run (roadnet.js route): a diagonal with a free side tile a little dearer than a straight step, one between two
// blocked side tiles (drawn as two dead ends) dear enough that a straight way up to about 25 tiles longer wins
const DIAG_COST = { elbow: 1.5, corner: 25 };

function teleportRoads(plan, W, H, l, blocked, OCCUPIED, visitableCells, blockingCells, opts = {}) {
	const types = opts.types || TYPES, reach = opts.reach || REACH, chance = opts.chance === undefined ? 1 : opts.chance, rng = opts.rng || Math.random;
	const R = plan.roadCells;
	const out = { onto: 0, joined: 0, none: 0 };
	if (!R) return out;
	const base = l * W * H;
	const water = plan.p && plan.p.water, om = plan.openMask;
	const guard = new Set();
	// opts.overGuards false: the run never crosses a guard (a mine's road, laid by chance, ran under the guard at a town's door: K's XL underground
	// seed 1594927107, red's second town (30,95) and the sawmill (31,100))
	if (opts.overGuards !== false)
		for (const o of plan.objects) if ((o.l || 0) === l && /^(randomMonster|monster)/.test(o.type)) guard.add(o.y * W + o.x);
	const floor = c => !(water && water[c]) && (!om || om[c]);
	const free = c => floor(c) && (!(blocked[base + c] & OCCUPIED) || guard.has(c));
	// a pickup vanishes when taken, so a road may lie under it; used only when no run over bare floor reaches a road (a pocket whose
	// mouth is its loot, 4p 72x72 seed 3: the monolith in a pile's pocket, Opus Map Vision 14:13)
	const pick = new Set();
	if (blockingCells && process.env.VMAPGEN_TELEPORT_ROAD_PICKUPS !== '0')
		for (const o of plan.objects)
			if ((o.l || 0) === l && o.template && o.template.mask && PICKUP.test(o.type))
				for (const [fx, fy] of blockingCells(o.template, o.x, o.y)) if (fx >= 0 && fy >= 0 && fx < W && fy < H) pick.add(fy * W + fx);
	const under = c => floor(c) && pick.has(c);
	const ends = [];
	for (const o of plan.objects)
		if ((o.l || 0) === l && o.template && types.test(o.type) && (chance >= 1 || rng() < chance))
			for (const [vx, vy] of visitableCells(o.template, o.x, o.y))
				if (vx >= 0 && vy >= 0 && vx < W && vy < H) ends.push(vy * W + vx);
	if (!R.size) return out;
	for (const v of ends) {
		if (R.has(v)) continue;
		// a road tile beside the visiting tile, even only across a corner (a gate in a wall is entered diagonally): the tile joins it
		const vx0 = v % W, vy0 = (v / W) | 0;
		let beside = false;
		for (let dy = -1; dy <= 1 && !beside; dy++) for (let dx = -1; dx <= 1; dx++)
			if ((dx || dy) && vx0 + dx >= 0 && vy0 + dy >= 0 && vx0 + dx < W && vy0 + dy < H && R.has((vy0 + dy) * W + vx0 + dx)) { beside = true; break; }
		if (beside) { R.add(v); out.onto++; continue; }
		let prev, hit = -1;
		// four ways first, eight only where no straight run reaches a road (an eight-way run drew staircases of corner-only steps, which the game
		// shows as dead ends: a gold mine's road on K's 180x180 seed 669067840, (14,46), the Opus Reviewer's R27)
		for (const dirs of [D8.slice(0, 4), D8]) {
		for (const ok of [free, c => free(c) || under(c)]) {
			prev = new Map([[v, -1]]);
			const q = [v];
			for (let h = 0; h < q.length && hit < 0; h++) {
				const c = q[h], x = c % W, y = (c / W) | 0;
				let d = 0; for (let k = c; prev.get(k) !== -1; k = prev.get(k)) d++;
				if (d >= reach) continue;
				for (const [dx, dy] of dirs) {
					const nx = x + dx, ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
					const m = ny * W + nx;
					if (prev.has(m)) continue;
					if (R.has(m)) { prev.set(m, c); hit = m; break; }
					if (!ok(m)) continue;
					prev.set(m, c); q.push(m);
				}
			}
			if (hit >= 0 || !pick.size) break;
		}
			if (hit >= 0) break;
		}
		if (hit < 0) { out.none++; continue; }
		let n = 0;
		for (let c = prev.get(hit); c >= 0; c = prev.get(c)) { if (!R.has(c)) { R.add(c); n++; } }
		if (n > 1) out.joined++; else out.onto++;
	}
	return out;
}

/**
 * A road end with another road piece four steps or fewer away over ground a hero walks (open floor, pickups, a guard's tile) is a
 * gap a player sees as a break (Opus Map Vision, 2026-10-04: two pieces of one zone's road ending at two monoliths 4 tiles apart;
 * a doorway guard and a gate on one level). Each such end takes the shortest run to the other piece, over floor no object blocks,
 * under pickups and over a guard's tile. mapsight roadEnds is the rule (an end: a road tile with at most one road neighbour, or two
 * on one side). VMAPGEN_ROAD_GAPS=0 skips it. Returns { joined, left }.
 */
function closeRoadGaps(plan, W, H, l, blocked, OCCUPIED, blockingCells) {
	const R = plan.roadCells, out = { joined: 0, left: 0 };
	if (!R || !R.size) return out;
	const base = l * W * H;
	const water = plan.p && plan.p.water, om = plan.openMask;
	const walkers = new Set();     // a guard's tile and the cells a pickup blocks: walked, and a road may lie under them
	for (const o of plan.objects)
		if ((o.l || 0) === l && o.template && o.template.mask && /^(resource|randomResource|treasureChest|campfire|randomArtifact|artifact|spellScroll|pandoraBox|randomMonster|monster)/.test(o.type))
			for (const [fx, fy] of blockingCells(o.template, o.x, o.y)) if (fx >= 0 && fy >= 0 && fx < W && fy < H) walkers.add(fy * W + fx);
	const walk = c => !(water && water[c]) && (!om || om[c]) && (!(blocked[base + c] & OCCUPIED) || walkers.has(c));
	const comp = new Map();
	const nb = c => { const x = c % W, y = (c / W) | 0, r = []; for (const [dx, dy] of D8) { const u = x + dx, v = y + dy; if (u >= 0 && v >= 0 && u < W && v < H) r.push(v * W + u); } return r; };
	const label = () => {
		comp.clear(); let k = 0;
		for (const c of R) {
			if (comp.has(c)) continue;
			const q = [c]; comp.set(c, k);
			for (let h = 0; h < q.length; h++) for (const m of nb(q[h])) if (R.has(m) && !comp.has(m)) { comp.set(m, k); q.push(m); }
			k++;
		}
	};
	const isEnd = c => {
		const ring = D8RING.map(([dx, dy]) => { const u = (c % W) + dx, v = ((c / W) | 0) + dy; return u >= 0 && v >= 0 && u < W && v < H && R.has(v * W + u) ? 1 : 0; });
		const n = ring.reduce((a, b) => a + b, 0);
		let runs = 0; for (let k = 0; k < 8; k++) if (ring[k] && !ring[(k + 7) % 8]) runs++;
		return n <= 1 || (n === 2 && runs === 1);
	};
	label();
	for (const e of [...R].filter(isEnd)) {
		if (!R.has(e)) continue;
		const my = comp.get(e);
		const prev = new Map([[e, -1]]), dist = new Map([[e, 0]]), q = [e];
		let hit = -1;
		for (let h = 0; h < q.length && hit < 0; h++) {
			const c = q[h], d = dist.get(c);
			if (d >= 4) continue;
			for (const m of nb(c)) {
				if (dist.has(m)) continue;
				if (R.has(m)) { if (comp.get(m) !== my) { prev.set(m, c); hit = m; break; } continue; }
				if (!walk(m)) continue;
				prev.set(m, c); dist.set(m, d + 1); q.push(m);
			}
		}
		if (hit < 0) continue;
		for (let c = prev.get(hit); c >= 0 && c !== e; c = prev.get(c)) R.add(c);
		label();
		out.joined++;
	}
	return out;
}
const D8RING = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];

/**
 * A road that stops short of everything is taken back (mapsight "road ends ... at nothing": a road run to a doorway with no guard in it
 * and no road on the far side, or a spur into a dead pocket; 14% of free-layout maps and 13 of 18 with Guards at bottlenecks off). An
 * end with no visitable object and no monster within two tiles goes, tile by tile, back to the nearest junction or, for a piece with
 * both ends loose, whole; an arm of more than 600 tiles stays. VMAPGEN_ROAD_TRIM=0 skips it. Returns { cut }.
 */
function trimRoadStubs(plan, W, H, l, visitableCells, blockingCells, allowedDirs) {
	const R = plan.roadCells, out = { cut: 0 };
	if (!R || !R.size) return out;
	// what an end may rest against, as mapsight reads it: the visiting tile and the tiles it is entered from of a town, mine, monolith or
	// gate, an end with one of those in the nine tiles around it is served (K, 2026-10-05, "improper road termination": a road that stops beside a guard is no destination either; VMAPGEN_ROAD_END_AT_MONSTER=1 serves it again)
	const hit = new Set(), at = (x, y) => { if (x >= 0 && y >= 0 && x < W && y < H) hit.add(y * W + x); };
	for (const o of plan.objects) {
		if ((o.l || 0) !== l || !o.template || !o.template.mask) continue;
		if (/^(randomMonster|monster)/.test(o.type)) { if (process.env.VMAPGEN_ROAD_END_AT_MONSTER !== '1') continue; for (const [fx, fy] of blockingCells(o.template, o.x, o.y)) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) at(fx + dx, fy + dy); at(o.x, o.y); continue; }
		if (!SERVED.test(o.type)) continue;       // roads go to towns, mines, monoliths and gates (mapsight ROAD_DEST); a pickup or a bank is not an end
		const dirs = allowedDirs ? allowedDirs(o.template) : D8;
		for (const [vx, vy] of visitableCells(o.template, o.x, o.y)) { at(vx, vy); for (const [dx, dy] of dirs) at(vx + dx, vy + dy); }
	}
	// the end of a roadless zone's town road (joinBareTowns: to an object of the zone or its shore) is an end too: trimmed back as one at nothing,
	// it left a start's 16-tile road a 4-tile stub (islands 144 eight players seed 1, 2026-10-09)
	for (const c of plan.roadEndsKept || []) at(c % W, (c / W) | 0);
	const serve = { has: c => { const x = c % W, y = (c / W) | 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const u = x + dx, v = y + dy; if (u >= 0 && v >= 0 && u < W && v < H && hit.has(v * W + u)) return true; } return false; } };
	const nb = c => { const x = c % W, y = (c / W) | 0, r = []; for (const [dx, dy] of D8) { const u = x + dx, v = y + dy; if (u >= 0 && v >= 0 && u < W && v < H && R.has(v * W + u)) r.push(v * W + u); } return r; };
	const runs = c => { const ring = D8RING.map(([dx, dy]) => { const u = (c % W) + dx, v = ((c / W) | 0) + dy; return u >= 0 && v >= 0 && u < W && v < H && R.has(v * W + u) ? 1 : 0; }); let n = 0; for (let k = 0; k < 8; k++) if (ring[k] && !ring[(k + 7) % 8]) n++; return { n: ring.reduce((a, b) => a + b, 0), runs: n }; };
	const isEnd = c => { const r = runs(c); return r.n <= 1 || (r.n === 2 && r.runs === 1); };
	// An end beside a destination's door, and not on one, rests on nothing a player sees (K, 2026-10-12, his small Coldshadow seed
	// 1099575901, the circled ends on level 1): where the road already runs over a door beside it, the end is one tile too many ((31,2)
	// past the mine's door (32,2)); otherwise it goes one tile on, onto the door ((19,27), a diagonal step short of the gold mine's door
	// (20,27)), when nothing stands there. VMAPGEN_ROAD_END_ON_DOOR=0 leaves both.
	if (process.env.VMAPGEN_ROAD_END_ON_DOOR !== '0') {
		const taken = new Set();
		for (const o of plan.objects)
			if ((o.l || 0) === l && o.template && o.template.mask && !/^(randomMonster|monster)/.test(o.type))
				for (const [fx, fy] of blockingCells(o.template, o.x, o.y)) if (fx >= 0 && fy >= 0 && fx < W && fy < H) taken.add(fy * W + fx);
		const around = c => { const x = c % W, y = (c / W) | 0, r = []; for (const [dx, dy] of D8) { const u = x + dx, v = y + dy; if (u >= 0 && v >= 0 && u < W && v < H) r.push(v * W + u); } return r; };
		for (let pass = 0; pass < 4; pass++) {
			let any = false;
			for (const e of [...R]) {
				if (!R.has(e) || hit.has(e) || !isEnd(e) || !around(e).some(c => hit.has(c))) continue;
				if (nb(e).some(c => hit.has(c))) { R.delete(e); out.cut++; out.past = (out.past || 0) + 1; any = true; continue; }
				const door = around(e).filter(c => hit.has(c) && !taken.has(c)).sort((a, b) => a - b)[0];
				if (door !== undefined) { R.add(door); out.onDoor = (out.onDoor || 0) + 1; any = true; }
			}
			if (!any) break;
		}
	}
	for (let pass = 0; pass < 12; pass++) {
		let any = false;
		for (const e of [...R]) {
			if (!R.has(e) || serve.has(e) || !isEnd(e)) continue;
			const arm = [e], seen = new Set([e]);
			let cur = e, junction = false, loose = false, served = false;
			for (let step = 0; step < 600; step++) {
				const next = nb(cur).filter(m => !seen.has(m));
				if (!next.length) { loose = !serve.has(cur) || arm.length === 1; break; }
				if (next.length > 1 || runs(next[0]).runs >= 3) { junction = true; break; }
				cur = next[0]; seen.add(cur);
				if (serve.has(cur)) { served = true; break; }      // the tail up to a tile that rests on something goes
				arm.push(cur);
			}
			if (junction || loose || served) { for (const c of arm) R.delete(c); out.cut += arm.length; any = true; }
		}
		if (!any) break;
	}
	// a stretch of road that touches no destination anywhere, however it winds (a loop round a cluster of loot, K's 2026-10-05
	// picture), goes whole
	const seenC = new Set();
	for (const s of [...R]) {
		if (seenC.has(s)) continue;
		const comp = [s], stack = [s];
		seenC.add(s);
		let any = false;
		while (stack.length) {
			const c = stack.pop();
			if (serve.has(c)) any = true;
			for (const m of nb(c)) if (!seenC.has(m)) { seenC.add(m); comp.push(m); stack.push(m); }
		}
		if (!any) { for (const c of comp) R.delete(c); out.cut += comp.length; }
	}
	return out;
}

/**
 * A road piece that serves fewer than two places goes whole (K, 2026-10-11, road ends that lead nowhere: a 4-tile road from a monolith in a
 * zone with no other road, 108x108 four players seed 321088871 (45,45); every tile of it lay beside the monolith's door, so trimRoadStubs
 * counted each end served). A place is a town, mine, monolith or gate whose visiting tile the piece runs on or beside; a piece at a town or
 * at a kept end of a town's road stays. VMAPGEN_ROAD_LONE=0 skips it. Returns { cut, pieces }.
 */
function lonePieces(plan, W, H, l, visitableCells) {
	const R = plan.roadCells, out = { cut: 0, pieces: 0 };
	if (!R || !R.size) return out;
	const near = new Map(), objs = [];
	for (const o of plan.objects) {
		if ((o.l || 0) !== l || !o.template || !o.template.mask || !SERVED.test(o.type)) continue;
		const k = objs.length; objs.push(o);
		for (const [vx, vy] of visitableCells(o.template, o.x, o.y))
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				const x = vx + dx, y = vy + dy;
				if (x < 0 || y < 0 || x >= W || y >= H) continue;
				const c = y * W + x;
				if (!near.has(c)) near.set(c, []);
				near.get(c).push(k);
			}
	}
	const kept = plan.roadEndsKept || new Set(), seen = new Set();
	for (const s of [...R]) {
		if (seen.has(s)) continue;
		const comp = [s]; seen.add(s);
		for (let i = 0; i < comp.length; i++) {
			const x = comp[i] % W, y = (comp[i] / W) | 0;
			for (const [dx, dy] of D8) { const u = x + dx, v = y + dy, m = v * W + u; if (u >= 0 && v >= 0 && u < W && v < H && R.has(m) && !seen.has(m)) { seen.add(m); comp.push(m); } }
		}
		const at = new Set();
		let town = false;
		for (const c of comp) {
			if (kept.has(c)) town = true;
			for (const k of near.get(c) || []) { at.add(k); if (/^(town|randomTown)$/.test(objs[k].type)) town = true; }
		}
		if (town || at.size >= 2) continue;
		for (const c of comp) R.delete(c);
		out.cut += comp.length; out.pieces++;
	}
	return out;
}

/**
 * A town with no road at its door joins the road of its own zone (K, 2026-10-05, an underground corner castle "with no road to it"; 13 of 656
 * towns on the 40 two-level grid maps). The way runs over free ground inside the town's zone, from the town's visiting tile to the nearest road
 * tile of that zone, or failing that over free ground to the nearest road within 60 tiles; no free way leaves the town as it was. Returns { joined, left }.
 */
// tiles of road a town's road must join (MapGen Dev's start-road check, LIMITS.roadMin)
const ROAD_MIN = 8;
// how far off a roadless zone's town the goal of its road stands, so the road is ROAD_MIN long at least
const GOAL_OFF = 8;
/** The goal tiles of a town's road in a zone with no road: beside an object a hero visits GOAL_OFF tiles off at least, else the zone's shore */
function roadlessGoals(plan, W, H, l, blocked, OCCUPIED, visitableCells, o, vis, z, off = GOAL_OFF) {
	const goal = new Set(), far = (x, y) => !vis.some(c => Math.max(Math.abs(c % W - x), Math.abs(((c / W) | 0) - y)) < off);
	for (const q of plan.objects) {
		if (q === o || (q.l || 0) !== l || !q.template || !VISIT_GOAL.test(q.type)) continue;
		const qv = visitableCells(q.template, q.x, q.y);
		if (!qv.every(([qx, qy]) => far(qx, qy))) continue;
		for (const [vx, vy] of qv)
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				const x = vx + dx, y = vy + dy;
				if (x < 0 || y < 0 || x >= W || y >= H) continue;
				const c = y * W + x;
				if (plan.zone[c] === z && !(blocked[l * W * H + c] & OCCUPIED)) goal.add(c);
			}
	}
	const wat = plan.p && plan.p.water;
	if (false && !goal.size && wat)
		for (let c = 0; c < W * H; c++) {
			if (plan.zone[c] !== z || wat[c] || (blocked[l * W * H + c] & OCCUPIED)) continue;
			const x = c % W, y = (c / W) | 0;
			if (!far(x, y)) continue;
			for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < W && ny < H && wat[ny * W + nx]) { goal.add(c); break; } }
		}
	return goal;
}
// what a road may end at (mapsight's ROAD_DEST: towns, mines, monoliths and gates); a road ending at a bank, a dwelling, a mod building whose
// name starts with "town" (townGate) or the shore fails its check as a road ending at an object or at nothing (grid, 108x108 seed 1, 2026-10-09)
const VISIT_GOAL = /^(mine|abandonedMine|monolith|subterraneanGate)|^(town|randomTown)$/;
/** The steps of a path between two tiles that touch only at a corner with both side tiles blocked in bl. */
function cornerSteps(path, W, bl, base, OCCUPIED) {
	let n = 0;
	for (let i = 1; i < path.length; i++) {
		const a = path[i - 1], b = path[i], ax = a % W, ay = (a / W) | 0, bx = b % W, by = (b / W) | 0;
		if (ax !== bx && ay !== by && (bl[base + ay * W + bx] & OCCUPIED) && (bl[base + by * W + ax] & OCCUPIED)) n++;
	}
	return n;
}

function joinBareTowns(plan, W, H, l, blocked, OCCUPIED, visitableCells, ownedOnly = false, blockingCells = null, opts = {}) {
	const out = { joined: 0, left: 0 };
	// a pickup vanishes when taken and a hero fights through a monster, so a road may lie under either (gateroad's teleportRoads does the same): the way a town
	// shut in by loot and its guards needs (K's XL map, 2026-10-06: a neutral town whose front tile had 2 pickups between it and a road 9 tiles off)
	let soft = null, softLoot = null;
	const softBlocked = () => {
		if (soft || !blockingCells) return soft;
		soft = new Uint8Array(blocked);
		softLoot = new Uint8Array(blocked);
		for (const q of plan.objects) {
			if ((q.l || 0) !== l || !q.template) continue;
			const loot = PICKUP.test(q.type) || ONE_VISIT.test(q.type);
			if (!loot && !/^(monster|randomMonster)/.test(q.type)) continue;
			for (const [fx, fy] of blockingCells(q.template, q.x, q.y)) if (fx >= 0 && fy >= 0 && fx < W && fy < H) {
				soft[l * W * H + fy * W + fx] &= ~OCCUPIED;
				if (loot) softLoot[l * W * H + fy * W + fx] &= ~OCCUPIED;
			}
		}
		return soft;
	};
	const R = plan.roadCells;
	if (!R || !R.size || !plan.zone) return out;
	const { route, addElbows, DIRS4, DIRS8 } = require('./roadnet');
	for (const o of plan.objects) {
		if ((o.l || 0) !== l || !o.template || !/^(town|randomTown)$/.test(o.type)) continue;
		// Build Road Network Off: only a player's town (an owner) joins the road of its zone, a neutral town stands as the passages leave it
		if (ownedOnly && !(o.options && o.options.owner)) continue;
		const vis = visitableCells(o.template, o.x, o.y).filter(([x, y]) => x >= 0 && y >= 0 && x < W && y < H).map(([x, y]) => y * W + x);
		if (!vis.length) continue;
		const door = new Set();
		for (const c of vis) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
			const x = (c % W) + dx, y = ((c / W) | 0) + dy;
			if (x >= 0 && y >= 0 && x < W && y < H) door.add(y * W + x);
		}
		// the road runs on the tile in front of the entrance, as the engine's does on all 186 towns of its maps (K, 2026-10-06: a pavilion
		// and a start with the road ending one tile to the side)
		const front = vis.map(c => c + W).filter(c => c < W * H);
		// a road at the door that is only a stub (a piece under ROAD_MIN tiles: the front-tile pass's own in a zone with no other road) counts
		// as none, and the join runs past it
		const stub = new Set();
		{
			const q = [...front, ...vis].filter(c => R.has(c));
			for (const c of q) stub.add(c);
			for (let h = 0; h < q.length && stub.size < ROAD_MIN; h++) {
				const c = q[h], x = c % W, y = (c / W) | 0;
				for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
					const nx = x + dx, ny = y + dy, n = ny * W + nx;
					if (nx >= 0 && ny >= 0 && nx < W && ny < H && R.has(n) && !stub.has(n)) { stub.add(n); q.push(n); }
				}
			}
		}
		if (stub.size >= ROAD_MIN) continue;
		// a start's road is the net's: it runs up to 140 tiles to reach it before settling for the object a hero visits in its own roadless zone (a start whose
		// zone has no road ended in a 6-tile stub to a mine, 108x108 eight players underground seed 3, MapGen Dev's start-road)
		const maxJoin = o.options && o.options.owner ? 140 : 60;
		const z = plan.zone[vis[0]];
		const here = new Set([...R].filter(c => plan.zone[c] === z && !stub.has(c)));
		// the visiting tile is itself marked occupied, so the way starts from the free tiles around it (the road then runs onto the
		// entrance, as the engine's does); everything else the road may not cross is OCCUPIED
		const open = c => !(blocked[l * W * H + c] & OCCUPIED);
		const from = front.some(open) ? front.filter(open) : [...door].filter(open);
		// the front tile and every tile round the door hold loot or a guard (K's XL map seed 1594927107, town (30,95): a pile on the front tile and piles and a monster
		// round it): no free tile to start from, but the way may cross them (softBlocked), so the town is not left bare here
		let softFrom = false;
		if (!from.length && softBlocked() && process.env.VMAPGEN_TOWN_ROAD_SOFT !== '0') {
			const sOpen0 = c => !(soft[l * W * H + c] & OCCUPIED);
			softFrom = front.some(sOpen0) || [...door].some(sOpen0);
		}
		if (!from.length && !softFrom) { if (process.env.VMAPGEN_TOWNROAD_TRACE) console.error(`[jbt] (${o.x},${o.y}) zone ${z} left: no free tile round the door`); out.left++; continue; }
		// first inside the zone; failing that, over free ground into the next zone (an unguarded opening), where a short way reaches a road
		let path = here.size ? route(from, here, W, H, blocked, l, R, DIRS4, n => plan.zone[n] === z) : null;
		const away = stub.size ? new Set([...R].filter(c => !stub.has(c))) : R;
		if (!path || path.length > 120) path = route(from, away, W, H, blocked, l, R, DIRS4);
		let bl = blocked;
		// over loot only first, then over loot and guards: a town road led through a guard although a way over two piles left the town (K's XL underground
		// seed 1594927107, red's second town at (30,95))
		// a pocket joined to the rest by diagonal steps between blocked tiles has no four-connected way out, but a hero walks it: the way over eight
		// neighbours (a start with a 2-tile stub and a neutral town with no road, both in such pockets, MapGen Dev 19:58), over loot before guards (the
		// four-way run over a guard won over the eight-way run over two piles at (30,95))
		let refused = false;
		if (!path || path.length > maxJoin) {
			const softOk = softBlocked() && process.env.VMAPGEN_TOWN_ROAD_SOFT !== '0';
			const tries = softOk ? [[softLoot, DIRS4], [softLoot, DIRS8], [soft, DIRS4], [soft, DIRS8]] : [[blocked, DIRS8]];
			let last = null;
			for (const [sb, dirs] of tries) {
				const ok = c => !(sb[l * W * H + c] & OCCUPIED);
				const f2 = front.some(ok) ? front.filter(ok) : [...door].filter(ok);
				if (!f2.length) continue;
				let p = dirs === DIRS4 && here.size ? route(f2, here, W, H, sb, l, R, DIRS4, n => plan.zone[n] === z) : null;
				// eight ways: a corner-only step only where nothing else gets out (the Opus Reviewer's R27: staircases on K's road map seed 2090106454)
				if (!p || p.length > 120) p = route(f2, away, W, H, sb, l, R, dirs, null, dirs === DIRS8 ? DIAG_COST : null);
				// the costed run can be longer in tiles than the limit where the plain one is not (a neutral town on 180x180 seed 669067840 left bare)
				if (dirs === DIRS8 && (!p || p.length > maxJoin)) { const q = route(f2, away, W, H, sb, l, R, dirs); if (q && (!p || q.length < p.length)) p = q; }
				if (dirs === DIRS4 && p && (!last || p.length < last[0].length)) last = [p, sb];
				// opts.noCorner (the first call): an eight-way path with a step between two blocked side tiles is refused, so the clearing pass opens a
				// straight way first (plan.js clearWayToRoad, then the second call)
				if (p && dirs === DIRS8 && opts.noCorner && cornerSteps(p, W, sb, l * W * H, OCCUPIED)) { out.cornerRefused = (out.cornerRefused || 0) + 1; refused = true; continue; }
				if (p && p.length <= maxJoin) { path = p; bl = sb; if (dirs === DIRS8) out.diag = (out.diag || 0) + 1; last = null; break; }
			}
			// none short enough: the longest-reach fallbacks below get the four-way soft run as before
			if (last && softOk) { path = last[0]; bl = last[1]; }
		}
		// a zone with no road of its own (an island zone alone on its island): the road runs from the door to the nearest object a hero visits
		// in the zone, so the town has a road and it leads somewhere
		// a way to the net refused for its corner steps: the clearing and the second call come first, the road to an object in the zone after them (a
		// start's 7-tile stub to an object on 108x108 eight players free seed 3, MapGen Dev 15:01)
		if (refused && (!path || path.length > maxJoin)) { out.left++; continue; }
		if ((!path || path.length > (bl === blocked ? maxJoin : maxJoin * 2)) && !here.size) {
			const goal = new Set();
			for (const q of plan.objects) {
				if (q === o || (q.l || 0) !== l || !q.template || !VISIT_GOAL.test(q.type)) continue;
				// never the town itself (a second entry of the same town stood as a goal and left a 4-tile stub, K's islands seed 2094259455)
				// and GOAL_OFF tiles off at least, so the road it makes is no stub itself (an object 4 tiles off left a 7-tile road, i108 seed 1)
				if (visitableCells(q.template, q.x, q.y).some(([qx, qy]) => vis.some(c => Math.max(Math.abs(c % W - qx), Math.abs(((c / W) | 0) - qy)) < GOAL_OFF))) continue;
				for (const [vx, vy] of visitableCells(q.template, q.x, q.y))
					for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
						const x = vx + dx, y = vy + dy;
						if (x < 0 || y < 0 || x >= W || y >= H) continue;
						const c = y * W + x;
						if (plan.zone[c] === z && !(blocked[l * W * H + c] & OCCUPIED)) goal.add(c);
					}
			}
			// no mine, gate, monolith or other town in the zone (an island zone): the road on the town's own front tile and nothing more, so the town has
			// its road and the road ends at the town (K's islands seed 2094259455, town (131,65), MapGen Dev 13:28; a road run on to another building ended
			// at an object, which the engine's maps never do: f144p2u (19,7,L1), the Opus Reviewer's islands s455 (124,69))
			if (!goal.size && process.env.VMAPGEN_TOWN_FRONT_ONLY !== '0') {
				const fr = front.filter(c => !(blocked[l * W * H + c] & OCCUPIED));
				if (fr.length) { for (const c of vis) R.add(c); for (const c of fr) R.add(c); out.joined++; out.frontOnly = (out.frontOnly || 0) + 1; continue; }
			}
			let p2 = goal.size ? route(from, goal, W, H, blocked, l, R, DIRS4, n => plan.zone[n] === z) : null;
			// no object it can reach: the zone's shore, where a hero's boat lands (a neutral island town in a pocket with the coast, i108 seed 2)
			const wat = plan.p && plan.p.water;
			if (false && (!p2 || p2.length > 60) && wat) {
				const shore = new Set();
				for (let c = 0; c < W * H; c++) {
					if (plan.zone[c] !== z || wat[c] || (blocked[l * W * H + c] & OCCUPIED)) continue;
					const x = c % W, y = (c / W) | 0;
					if (vis.some(v => Math.max(Math.abs(v % W - x), Math.abs(((v / W) | 0) - y)) < GOAL_OFF)) continue;
					for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < W && ny < H && wat[ny * W + nx]) { shore.add(c); break; } }
				}
				const p3 = shore.size ? route(from, shore, W, H, blocked, l, R, DIRS4, n => plan.zone[n] === z) : null;
				if (p3 && p3.length <= 60) p2 = p3;
			}
			// over loot and monsters too, as the zone-road join does (a way the clearing pass found with nothing to clear crossed them, i108 seed 2)
			let blp = blocked;
			if ((!p2 || p2.length > 60) && softBlocked()) { const sb = softBlocked(), sOpen = c => !(sb[l * W * H + c] & OCCUPIED), fs = front.some(sOpen) ? front.filter(sOpen) : [...door].filter(sOpen); const p4 = fs.length ? route(fs, goal, W, H, sb, l, R, DIRS4, n => plan.zone[n] === z) : null; if (p4 && p4.length <= 60) { p2 = p4; blp = sb; } }
			// none of those reached: the nearer goals, 4 tiles off (a cave start whose zone's other objects stood far beyond rock)
			if (!p2 || p2.length > 60) {
				const g4 = roadlessGoals(plan, W, H, l, blocked, OCCUPIED, visitableCells, o, vis, z, 4);
				let p5 = g4.size ? route(from, g4, W, H, blocked, l, R, DIRS4, n => plan.zone[n] === z) : null;
				if ((!p5 || p5.length > 60) && g4.size && softBlocked()) { const sb = softBlocked(), sOpen = c => !(sb[l * W * H + c] & OCCUPIED), fs2 = front.some(sOpen) ? front.filter(sOpen) : [...door].filter(sOpen); p5 = fs2.length ? route(fs2, g4, W, H, sb, l, R, DIRS4, n => plan.zone[n] === z) : null; if (p5 && p5.length <= 60) blp = sb; }
				if (p5 && p5.length <= 60) p2 = p5;
			}
			if (p2 && p2.length <= 60) { path = p2; bl = blp; out.toObject = (out.toObject || 0) + 1; (plan.roadEndsKept || (plan.roadEndsKept = new Set())).add(p2[p2.length - 1]); }
			if (process.env.VMAPGEN_TOWNROAD_TRACE) console.error(`[townroad] (${o.x},${o.y}) zone ${z}: to an object, goal tiles ${goal.size}, path ${p2 ? p2.length + " ending " + (p2[p2.length - 1] % W) + "," + ((p2[p2.length - 1] / W) | 0) : "none"}`);
		}
		if (!path || path.length > (bl === blocked ? maxJoin : maxJoin * 2)) { if (process.env.VMAPGEN_TOWNROAD_TRACE) { const sb = softBlocked() || blocked, seen = new Set(), q = [...(front.filter(c => !(sb[l * W * H + c] & OCCUPIED)))]; for (const c of q) seen.add(c); let touched = 0; for (let h = 0; h < q.length; h++) { const c = q[h], x = c % W, y = (c / W) | 0; if (R.has(c) && !stub.has(c)) touched++; for (const [dx, dy] of DIRS4) { const u = x + dx, v = y + dy; if (u < 0 || v < 0 || u >= W || v >= H) continue; const n = v * W + u; if (seen.has(n) || (sb[l * W * H + n] & OCCUPIED)) continue; seen.add(n); q.push(n); } } console.error(`[jbt] (${o.x},${o.y}) zone ${z} left: path ${path ? path.length : 'none'}, soft ${bl !== blocked}, from ${from.length}, here ${here.size}, stub ${stub.size}; free-ground flood from the front reaches ${seen.size} tiles, ${touched} of them road`); } out.left++; continue; }
		for (const c of addElbows(path, W, H, bl, l)) R.add(c);
		for (const c of vis) R.add(c);
		for (const c of front) if (!(bl[l * W * H + c] & OCCUPIED)) R.add(c);
		out.joined++;
	}
	return out;
}

/**
 * The tile in front of a town's entrance is open ground, so a road can end on it (K, 2026-10-06: an underground pavilion whose front tile was cave
 * rock, a start on a coast whose front tile was water; both with the road ending one tile to the side). Scenery on it is taken away whole (not a
 * piece on a zone line), rock is opened, and water becomes land where the water round it stays one piece. The shipyard's boat goes two tiles below the
 * entrance and one to the side (CGTownInstance::getOutOffsets), so the front tile itself is never what a shipyard needs. Returns { cleared, rock, water, left }.
 */
function openTownFronts(plan, W, H, l, blocked, d) {
	const { OCCUPIED, visitableCells, blockingCells, clearScenery, isDecor } = d;
	const out = { cleared: 0, rock: 0, water: 0, left: 0 };
	const base = l * W * H, water = plan.p && plan.p.water, zone = plan.zone;
	if (!zone) return out;
	const at = (x, y) => (x >= 0 && y >= 0 && x < W && y < H ? y * W + x : -1);
	const onLine = c => { for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const n = at((c % W) + dx, ((c / W) | 0) + dy); if (n >= 0 && zone[n] !== zone[c]) return true; } return false; };
	// the water round c stays one piece without c
	const waterKeeps = c => {
		const x = c % W, y = (c / W) | 0, nb = [];
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const n = at(x + dx, y + dy); if ((dx || dy) && n >= 0 && water[n]) nb.push(n); }
		if (nb.length <= 1) return true;
		const seen = new Set([nb[0]]), stack = [nb[0]];
		while (stack.length) {
			const i = stack.pop(), ix = i % W, iy = (i / W) | 0;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				const n = at(ix + dx, iy + dy);
				if ((!dx && !dy) || n < 0 || n === c || seen.has(n) || !water[n] || Math.abs(n % W - x) > 6 || Math.abs(((n / W) | 0) - y) > 6) continue;
				seen.add(n); stack.push(n);
			}
		}
		return nb.every(n => seen.has(n));
	};
	for (const o of plan.objects) {
		if ((o.l || 0) !== l || !o.template || !/^(town|randomTown)$/.test(o.type)) continue;
		for (const [vx, vy] of visitableCells(o.template, o.x, o.y)) {
			const f = at(vx, vy + 1);
			if (f < 0 || vx < 1 || vy + 1 >= H - 1 || vx >= W - 1) continue;
			const home = at(vx, vy);
			if (zone[f] < 0 && home >= 0) zone[f] = zone[home];
			if (zone[f] < 0) continue;
			if (blocked[base + f] & OCCUPIED) {
				const on = plan.objects.filter(q => q !== o && (q.l || 0) === l && q.template && q.template.mask
					&& blockingCells(q.template, q.x, q.y).some(([a, b]) => a === vx && b === vy + 1));
				if (on.length) {
					if (!on.every(isDecor) || on.some(q => blockingCells(q.template, q.x, q.y).some(([a, b]) => at(a, b) >= 0 && onLine(at(a, b))))) { out.left++; continue; }
					out.cleared += clearScenery(plan, l, W, H, blocked, { gone: new Set(on) });
				} else if (plan.openMask && !plan.openMask[f]) {
					plan.openMask[f] = 1; blocked[base + f] &= ~OCCUPIED; out.rock++;
				} else { out.left++; continue; }
			} else if (plan.openMask && !plan.openMask[f]) { plan.openMask[f] = 1; out.rock++; }
			if (water && water[f]) {
				if (!waterKeeps(f)) { out.left++; continue; }
				water[f] = 0; out.water++;
			}
		}
	}
	return out;
}


/**
 * A road passes an object, it does not run through it (K, 2026-10-06, an underground monolith in a narrow passage: "this underground monolith really
 * should have had the road jog around the left side of it, in addition to T'ing off to its steps ... running right under it doesn't serve the road's
 * purpose as a thoroughfare"). The engine's maps have no road that touches an object's visiting tile and also the road on a side the object cannot be
 * entered from (0 of 1,800 objects with a road); ours had 270 of 798 monoliths, 92 of 516 gates and 154 of 4,553 mines. For each such object the road
 * tiles on its back side go, and the road they carried runs round the object's footprint to the tiles it is entered from, the visiting tile joining
 * that road as a spur. A way of 30 tiles or less within the object's zone; no way leaves the road as it was. Returns { fixed, left }.
 */
function roadsPastObjects(plan, W, H, l, blocked, d) {
	const out = { fixed: 0, left: 0 };
	const R = plan.roadCells;
	if (!R || !R.size || !plan.zone) return out;
	const { OCCUPIED, visitableCells, blockingCells, allowedDirs } = d;
	const { route, addElbows, DIRS4 } = require('./roadnet');
	const at = (x, y) => (x >= 0 && y >= 0 && x < W && y < H ? y * W + x : -1);
	for (const o of plan.objects) {
		if ((o.l || 0) !== l || !o.template || !o.template.mask || /^(monster|randomMonster)/.test(o.type)) continue;
		const vis = visitableCells(o.template, o.x, o.y).map(([x, y]) => at(x, y)).filter(c => c >= 0);
		if (!vis.length || !vis.some(c => R.has(c))) continue;
		const foot = new Set(blockingCells(o.template, o.x, o.y).map(([x, y]) => at(x, y)).filter(c => c >= 0));
		const app = new Set(), near = new Set();
		for (const c of vis) {
			const x = c % W, y = (c / W) | 0;
			for (const [dx, dy] of allowedDirs(o.template)) { const n = at(x + dx, y + dy); if (n >= 0 && !foot.has(n)) app.add(n); }
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const n = at(x + dx, y + dy); if (n >= 0 && n !== c) near.add(n); }
		}
		const back = [...near].filter(c => R.has(c) && !app.has(c) && !foot.has(c));
		if (!back.length) continue;
		const forbidden = new Set([...foot, ...vis, ...[...near].filter(c => !app.has(c))]);
		const z = plan.zone[vis[0]];
		const ends = new Set();
		for (const b of back) for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0], [1, -1], [1, 1], [-1, 1], [-1, -1]]) { const n = at((b % W) + dx, ((b / W) | 0) + dy); if (n >= 0 && R.has(n) && !forbidden.has(n)) ends.add(n); }
		const removed = [...back, ...vis.filter(c => R.has(c))];
		for (const c of removed) R.delete(c);
		const front = [...app].filter(c => R.has(c));
		const goal = front.length ? new Set(front) : new Set([...app].filter(c => !(blocked[l * W * H + c] & OCCUPIED) && !forbidden.has(c)));
		const from = ends.size ? [...ends] : [...app].filter(c => R.has(c));
		const ok = n => !forbidden.has(n) && plan.zone[n] === z;
		let path = goal.size && from.length ? route(from, goal, W, H, blocked, l, R, DIRS4, ok) : null;
		if (process.env.VMAPGEN_ROAD_TRACE) console.error(`[past] ${o.type} (${o.x},${o.y}) L${l}: back ${back.map(c => (c % W) + ',' + ((c / W) | 0))} ends ${[...ends].map(c => (c % W) + ',' + ((c / W) | 0))} goal ${[...goal].map(c => (c % W) + ',' + ((c / W) | 0))} path ${path ? path.length : 'none'}`);
		if (!path || path.length > 30) { for (const c of removed) R.add(c); out.left++; continue; }
		const laid = addElbows(path, W, H, blocked, l);
		// every other end of the road that was cut joins the way just laid, or the road it was
		const reach = new Set([...goal, ...laid]);
		const extra = [];
		let cut = false;
		for (const e of from) if (!reach.has(e)) {
			const p2 = route([e], reach, W, H, blocked, l, R, DIRS4, ok);
			if (p2 && p2.length <= 30) extra.push(...addElbows(p2, W, H, blocked, l)); else cut = true;
		}
		// an end that cannot join (a guard on its tile, a wall) would be left hanging: the road stays as it was
		if (cut) { for (const c of removed) R.add(c); out.left++; continue; }
		for (const c of laid) R.add(c);
		for (const c of extra) R.add(c);
		for (const c of vis) R.add(c);
		out.fixed++;
	}
	return out;
}


/**
 * Roads are one tile wide: none of the engine's maps has a 2x2 block of road. The passes that join a town's front, run a road round an object or
 * join a bare town can lay a tile beside road already there; of each 2x2 block of road one tile goes, never a visiting tile or the tile in front of
 * an entrance, and never one whose neighbours would then fall apart. Returns { thinned }.
 */
function thinRoadBlocks(plan, W, H, l, d) {
	const out = { thinned: 0 };
	const R = plan.roadCells;
	if (!R || R.size < 4) return out;
	const { visitableCells } = d;
	const keep = new Set();
	for (const o of plan.objects) {
		// only what roads are for: a road under a pile or a bank is not a road to keep
		if ((o.l || 0) !== l || !o.template || !o.template.mask || !SERVED.test(o.type)) continue;
		for (const [vx, vy] of visitableCells(o.template, o.x, o.y)) if (vx >= 0 && vy >= 0 && vx < W && vy < H) { keep.add(vy * W + vx); if (vy + 1 < H) keep.add((vy + 1) * W + vx); }
	}
	const at = (x, y) => (x >= 0 && y >= 0 && x < W && y < H ? y * W + x : -1);
	const stays = (c) => {
		// the road neighbours of c are still one piece without c
		const x = c % W, y = (c / W) | 0, nb = [];
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const n = at(x + dx, y + dy); if ((dx || dy) && n >= 0 && R.has(n)) nb.push(n); }
		if (nb.length <= 1) return true;
		// no neighbour is left an end: a road that ends at a pile or a bank is a road end the rule above refuses
		// (mapsight's reading: one road neighbour, or two that touch each other)
		const RING = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
		const endLike = (n, skip) => {
			const f = RING.map(([dx, dy]) => { const m = at((n % W) + dx, ((n / W) | 0) + dy); return m >= 0 && m !== skip && R.has(m) ? 1 : 0; });
			let k = 0, runs = 0;
			for (let i = 0; i < 8; i++) { k += f[i]; if (f[i] && !f[(i + 7) % 8]) runs++; }
			return k <= 1 || (k === 2 && runs === 1);
		};
		for (const n of nb) if (!endLike(n, -1) && endLike(n, c)) return false;
		const seen = new Set([nb[0]]), stack = [nb[0]];
		while (stack.length) {
			const i = stack.pop(), ix = i % W, iy = (i / W) | 0;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				const n = at(ix + dx, iy + dy);
				if ((!dx && !dy) || n < 0 || n === c || seen.has(n) || !R.has(n) || Math.abs(n % W - x) > 8 || Math.abs(((n / W) | 0) - y) > 8) continue;
				seen.add(n); stack.push(n);
			}
		}
		return nb.every(n => seen.has(n));
	};
	for (let pass = 0; pass < 4; pass++) {
		let any = false;
		for (const c of [...R]) {
			if (!R.has(c)) continue;
			const x = c % W, y = (c / W) | 0;
			const a = at(x + 1, y), b = at(x, y + 1), e = at(x + 1, y + 1);
			if (a < 0 || b < 0 || e < 0 || !R.has(a) || !R.has(b) || !R.has(e)) continue;
			// the corner tile of the block that is not a visiting tile or a front tile and whose removal keeps the road in one piece
			const pick = [e, a, b, c].find(t => !keep.has(t) && stays(t));
			if (pick === undefined) continue;
			R.delete(pick); out.thinned++; any = true;
		}
		if (!any) break;
	}
	return out;
}


/**
 * Two road tiles that touch only at a corner are not joined in the game: VCMI draws a road tile from its eight neighbours with ten
 * patterns (CDrawRoadsOperation), and a tile whose only neighbours are one on a side and one on a corner is drawn as a dead end, so the
 * road shows a gap there (K, 2026-10-10, 108x108 four players seed 2090106454: five such steps, three of them in the places he circled,
 * "roads are a mess"; 638 steps on the 72 grid maps of 62564c7). The routes take steps in eight directions and the thinning leaves some of
 * them. Every such step gets one of the two tiles beside it: free floor no object blocks (a pickup's or a monster's tile may carry road),
 * not water, and one that makes no 2x2 block with the road; failing that, a tile that only scenery stands on (not on a zone line) is cleared
 * and takes the road (d.clearScenery, d.isDecor). When neither takes one, the step stays and is counted. VMAPGEN_ROAD_DIAG=0 skips it.
 * Returns { closed, cleared, left }.
 */
function closeDiagonalSteps(plan, W, H, l, blocked, OCCUPIED, blockingCells, d = {}) {
	const out = { closed: 0, cleared: 0, left: 0 };
	const R = plan.roadCells;
	if (!R || R.size < 2) return out;
	const base = l * W * H, zone = plan.zone;
	const water = plan.p && plan.p.water, om = plan.openMask;
	const walkers = new Set();
	for (const o of plan.objects)
		if ((o.l || 0) === l && o.template && o.template.mask && /^(resource|randomResource|treasureChest|campfire|randomArtifact|artifact|spellScroll|pandoraBox|randomMonster|monster)/.test(o.type))
			for (const [fx, fy] of blockingCells(o.template, o.x, o.y)) if (fx >= 0 && fy >= 0 && fx < W && fy < H) walkers.add(fy * W + fx);
	const at = (x, y) => (x >= 0 && y >= 0 && x < W && y < H ? y * W + x : -1);
	const onLine = c => { if (!zone) return false; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const n = at((c % W) + dx, ((c / W) | 0) + dy); if (n >= 0 && zone[n] !== zone[c]) return true; } return false; };
	const walk = c => c >= 0 && !(water && water[c]) && (!om || om[c]) && (!(blocked[base + c] & OCCUPIED) || walkers.has(c));
	// the scenery on a tile that no road may cross: all of it decor, and clearing it opens no walk from one zone into another (each piece in one zone,
	// and none of its tiles on a zone line beside a tile of the other zone a hero stands on); null when something else stands there. The first rule
	// refused every piece touching a zone line, and a tree group one tile from a line kept a staircase round a cathedral's corner (K's road map seed
	// 2090106454, (55,28) to (58,25), the Opus Reviewer's R27)
	const sceneryOn = c => {
		if (!d.clearScenery || !d.isDecor || c < 0 || (water && water[c]) || (om && !om[c]) || !(blocked[base + c] & OCCUPIED)) return null;
		const on = plan.objects.filter(q => (q.l || 0) === l && q.template && q.template.mask && blockingCells(q.template, q.x, q.y).some(([a, b]) => at(a, b) === c));
		if (!on.length || !on.every(d.isDecor)) return null;
		for (const q of on) {
			const cells = blockingCells(q.template, q.x, q.y).map(([a, b]) => at(a, b)).filter(t => t >= 0);
			if (zone && new Set(cells.map(t => zone[t])).size > 1) return null;
			for (const t of cells) {
				if (!onLine(t)) continue;
				for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
					const n = at((t % W) + dx, ((t / W) | 0) + dy);
					if (n >= 0 && zone[n] !== zone[t] && walk(n)) return null;
				}
			}
		}
		return on;
	};
	// the tile joins no 2x2 block of road
	const noBlock = c => {
		const x = c % W, y = (c / W) | 0;
		for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
			const a = at(x + dx, y), b = at(x, y + dy), e = at(x + dx, y + dy);
			if (a >= 0 && b >= 0 && e >= 0 && R.has(a) && R.has(b) && R.has(e)) return false;
		}
		return true;
	};
	for (let pass = 0; pass < 3; pass++) {
		let any = false;
		for (const c of [...R]) {
			const x = c % W, y = (c / W) | 0;
			for (const [dx, dy] of [[1, 1], [1, -1]]) {
				const n = at(x + dx, y + dy), s1 = at(x + dx, y), s2 = at(x, y + dy);
				if (n < 0 || !R.has(n) || R.has(s1) || R.has(s2)) continue;
				let pick = [s1, s2].filter(t => walk(t) && noBlock(t))[0];
				if (pick === undefined) {
					const t = [s1, s2].find(t => noBlock(t) && sceneryOn(t));
					if (t === undefined) continue;
					out.cleared += d.clearScenery(plan, l, W, H, blocked, { gone: new Set(sceneryOn(t)) });
					pick = t;
				}
				R.add(pick); out.closed++; any = true;
			}
		}
		if (!any) break;
	}
	// A step left on the visiting tile of a mine (or any building but a town, a gate or a monolith, whose roads run onto that tile) loses that
	// tile's road when no side of it touches road and the road beside it stays one piece without it: the road then ends beside the entrance
	// and is drawn as an end, where the corner showed a gap (K's road map seed 670084743, the mine at (103,100) beside a town's road)
	if (d.visitableCells && process.env.VMAPGEN_DIAG_VISIT !== '0') {
		const visit = new Set();
		for (const o of plan.objects)
			if ((o.l || 0) === l && o.template && o.template.mask && !/^(randomTown|town|subterraneanGate|monolith|randomMonster|monster)/.test(o.type)
				&& !/^(resource|randomResource|treasureChest|campfire|randomArtifact|artifact|spellScroll|pandoraBox|prison)$/.test(o.type))
				for (const [vx, vy] of d.visitableCells(o.template, o.x, o.y)) { const c = at(vx, vy); if (c >= 0) visit.add(c); }
		const side = c => { const x = c % W, y = (c / W) | 0; return [at(x + 1, y), at(x - 1, y), at(x, y + 1), at(x, y - 1)].some(t => t >= 0 && R.has(t)); };
		const near = c => { const x = c % W, y = (c / W) | 0, r = []; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const t = at(x + dx, y + dy); if ((dx || dy) && t >= 0 && R.has(t)) r.push(t); } return r; };
		for (const c of [...R]) {
			if (!visit.has(c) || side(c)) continue;
			const nb = near(c);
			if (!nb.length) continue;
			// the road beside still meets without this tile (a walk over road tiles within 12 of it)
			const seen = new Set([c, nb[0]]), st = [nb[0]], x0 = c % W, y0 = (c / W) | 0;
			while (st.length) for (const t of near(st.pop())) if (!seen.has(t) && Math.abs(t % W - x0) <= 12 && Math.abs(((t / W) | 0) - y0) <= 12) { seen.add(t); st.push(t); }
			if (!nb.every(t => seen.has(t))) continue;
			R.delete(c); out.offVisit = (out.offVisit || 0) + 1;
		}
	}
	for (const c of R) {
		const x = c % W, y = (c / W) | 0;
		for (const [dx, dy] of [[1, 1], [1, -1]]) {
			const n = at(x + dx, y + dy);
			if (n >= 0 && R.has(n) && !R.has(at(x + dx, y)) && !R.has(at(x, y + dy))) {
				out.left++;
				if (process.env.VMAPGEN_DIAG_TRACE) for (const t of [at(x + dx, y), at(x, y + dy)]) {
					const on = t < 0 ? [] : plan.objects.filter(q => (q.l || 0) === l && q.template && q.template.mask && blockingCells(q.template, q.x, q.y).some(([a, b]) => at(a, b) === t));
					console.error(`[diag] L${l} (${x},${y})-(${x + dx},${y + dy}) side (${t % W},${(t / W) | 0}): walk ${walk(t)} noBlock ${noBlock(t)} scenery ${!!sceneryOn(t)} on ${on.map(q => q.type + '@' + q.x + ',' + q.y + (d.isDecor && d.isDecor(q) ? ' decor' : '')).join(' ')}`);
				}
			}
		}
	}
	return out;
}

module.exports = { roadlessGoals, teleportRoads, closeRoadGaps, trimRoadStubs, lonePieces, joinBareTowns, openTownFronts, roadsPastObjects, thinRoadBlocks, closeDiagonalSteps };
