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
// a prison is no pickup to a road: a road laid under one is a building standing on the road until its hero is freed (K, 2026-10-31, in a live game:
// "have a prison on the road in nate's biome on our game now....unacceptable"; teleportRoads ran a monolith's road under the prison at (41,39) of his
// 180x180 seed 1157895410). Walkers still count a prison as gone once visited (sight.js, approachclose.js); a gate or monolith whose only way to a
// road is under a prison is left without one (the engine has no road on the visiting tile of 28% of its monolith ends; the 2026-10-15 case: 72x72 underground, (50,2), (57,24))
const PICKUP = /^(resource|randomResource|treasureChest|campfire|randomArtifact|artifact|spellScroll|pandoraBox)/;
// gone once visited, as a pickup is: a town's road may run under one (K's 72x72 s710452006, 2026-10-08: a scholar in the one way out of a
// castle's front pocket left the castle with no road, the break he circled)
const ONE_VISIT = /^(scholar|seaChest|flotsam)$/;
// anchored: a mod building named "townGate" matched "town" and kept a road ending beside it (grid, 108x108 seed 1, 2026-10-09)
const SERVED = /^(mine|abandonedMine|monolith|subterraneanGate)|^(town|randomTown)$/;
// a step under a building's picture counts as this many, as the engine divides a placement's weight by ten where it hides a road
const HIDE_COST = 10;
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
	// a prison in the pocket's only mouth: the last try runs over its tiles and the prison moves off the run (no road under a prison, K's
	// 2026-10-31 order, and the pocket still joined: test/teleport-road-prison.test.js, the 2026-10-15 case 72x72 underground (50,2), (57,24)).
	// VMAPGEN_PRISON_MOVE=0 leaves such an end without a road, as 802e1ed did.
	const prisonAt = new Map();
	if (blockingCells && process.env.VMAPGEN_PRISON_MOVE !== '0')
		for (const o of plan.objects)
			if ((o.l || 0) === l && o.type === 'prison' && o.template && o.template.mask)
				for (const [fx, fy] of blockingCells(o.template, o.x, o.y)) if (fx >= 0 && fy >= 0 && fx < W && fy < H) prisonAt.set(fy * W + fx, o);
	const overPrison = c => floor(c) && prisonAt.has(c);
	// the prison steps to the nearest spot within 4 tiles whose tiles are free floor off every road and off the run, its visiting tile free too
	const movePrison = (o, run) => {
		const own = blockingCells(o.template, o.x, o.y).map(([x, y]) => y * W + x);
		const zone = plan.zone;
		for (let r = 1; r <= 4; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
			if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
			const nx = o.x + dx, ny = o.y + dy;
			const cells = blockingCells(o.template, nx, ny), vis = visitableCells(o.template, nx, ny);
			const okCell = ([x, y]) => x >= 1 && y >= 1 && x < W - 1 && y < H - 1;
			if (!cells.every(okCell) || !vis.every(okCell)) continue;
			const ids = cells.map(([x, y]) => y * W + x), vids = vis.map(([x, y]) => y * W + x);
			const clear = c => floor(c) && !R.has(c) && !run.has(c) && !guard.has(c) && (own.includes(c) ? false : !(blocked[base + c] & OCCUPIED));
			if (!ids.every(clear) || !vids.every(c => floor(c) && !run.has(c) && !(blocked[base + c] & OCCUPIED))) continue;
			if (zone && zone[ny * W + nx] !== zone[o.y * W + o.x]) continue;
			for (const c of own) { blocked[base + c] &= ~OCCUPIED; prisonAt.delete(c); }
			for (const c of ids) { blocked[base + c] |= OCCUPIED; prisonAt.set(c, o); }
			o.x = nx; o.y = ny;
			if (o.instanceName) o.instanceName = `${o.type}_${nx}_${ny}_${l}`;
			return true;
		}
		return false;
	};
	// the tiles a building a hero visits (not scenery, which is everywhere and partly from mods) is drawn over (its whole mask, the picture above its feet included): a run under them is a road the building hides,
	// which the engine penalises tenfold where it places an object (TreasurePlacer, "objects hiding roads"). A run under them costs HIDE_COST a step, so a run off them
	// wins unless it is ten times longer (K, 2026-10-31, the prison at (41,39) of his 180x180 seed 1157895410: with the road off its tiles it still ran behind its picture;
	// and "a illegal route of a road under a alchemists lab to reach it's front door": the lab (46,48) whose road left its door under its own roof). The end's own
	// building counts too: its road leaves by the tiles in front of it.
	// VMAPGEN_TELEPORT_ROAD_SHOWN=0 as before.
	const hide = new Set();
	if (process.env.VMAPGEN_TELEPORT_ROAD_SHOWN !== '0') {
		const { footprintCells } = require('./content'), decor = new Set(require('./decor').DECOR_TYPES);
		for (const o of plan.objects)
			if ((o.l || 0) === l && o.template && o.template.mask && !PICKUP.test(o.type) && !/^(randomMonster|monster)/.test(o.type) && !decor.has(o.type) && visitableCells(o.template, o.x, o.y).length)
				for (const [fx, fy] of footprintCells(o.template, o.x, o.y)) if (fx >= 0 && fy >= 0 && fx < W && fy < H) hide.add(fy * W + fx);
	}
	const ends = [], endObj = new Map();
	for (const o of plan.objects)
		if ((o.l || 0) === l && o.template && types.test(o.type) && (chance >= 1 || rng() < chance))
			for (const [vx, vy] of visitableCells(o.template, o.x, o.y))
				if (vx >= 0 && vy >= 0 && vx < W && vy < H) { ends.push(vy * W + vx); endObj.set(vy * W + vx, o); }
	if (!R.size) return out;
	for (const v of ends) {
		if (R.has(v)) continue;
		// a mine's (any building's but a gate's or a monolith's) road reaches its door from in front, never from under its own roof: the engine's 98 maps
		// have no such door, ours 19 mines on 33 grid maps (K, 2026-10-31: "a illegal route of a road under a alchemists lab to reach it's front door").
		// Gates and monoliths are entered from under their arch in the engine's maps too (391 doors), and keep the run as it was. VMAPGEN_OWN_ROOF=0 off.
		const eo = endObj.get(v), roof = new Set();
		if (eo && !TYPES.test(eo.type) && process.env.VMAPGEN_OWN_ROOF !== '0')
			for (const [fx, fy, ch] of require('./content').footprintCells(eo.template, eo.x, eo.y)) if (ch !== 'A' && ch !== 'T' && fx >= 0 && fy >= 0 && fx < W && fy < H) roof.add(fy * W + fx);
		// a road tile beside the visiting tile, even only across a corner (a gate in a wall is entered diagonally): the tile joins it
		const vx0 = v % W, vy0 = (v / W) | 0;
		let beside = false;
		for (let dy = -1; dy <= 1 && !beside; dy++) for (let dx = -1; dx <= 1; dx++)
			if ((dx || dy) && vx0 + dx >= 0 && vy0 + dy >= 0 && vx0 + dx < W && vy0 + dy < H && R.has((vy0 + dy) * W + vx0 + dx)) { beside = true; break; }
		if (beside) { R.add(v); out.onto++; continue; }
		let prev, hit = -1, viaPrison = false;
		// four ways first, eight only where no straight run reaches a road (an eight-way run drew staircases of corner-only steps, which the game
		// shows as dead ends: a gold mine's road on K's 180x180 seed 669067840, (14,46), the Opus Reviewer's R27)
		for (const dirs of [D8.slice(0, 4), D8]) {
		// off the map's outermost row first: a run along it is the only floor once the rim fill closes round it (pw_010, 36x36: a monolith's
		// road along the bottom row, ten tiles; the lead, 2026-10-17 15:30). VMAPGEN_ROAD_RIM=1 takes the old order
		const OKS = [free, c => free(c) || under(c), c => free(c) || under(c) || overPrison(c)];
		for (let k = 0; k < OKS.length; k++) {
			const ok = OKS[k];
			if (k === 1 && !pick.size) continue;
			if (k === 2 && !prisonAt.size) break;
			viaPrison = k === 2;
			// cheapest run, a step under a building's picture costing HIDE_COST (1 without the hidden set: the shortest, as before)
			prev = new Map([[v, -1]]);
			const cost = new Map([[v, 0]]), steps = new Map([[v, 0]]), heap = [[0, v]];
			const push = e => { heap.push(e); for (let i = heap.length - 1; i > 0;) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
			const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; for (let i = 0; ;) { const a = 2 * i + 1, b = a + 1; let s = i; if (a < heap.length && heap[a][0] < heap[s][0]) s = a; if (b < heap.length && heap[b][0] < heap[s][0]) s = b; if (s === i) break; [heap[s], heap[i]] = [heap[i], heap[s]]; i = s; } } return top; };
			while (heap.length && hit < 0) {
				const [cc, c] = pop();
				if (cc > cost.get(c)) continue;
				if (R.has(c) && c !== v) { hit = c; break; }
				if (steps.get(c) >= reach) continue;
				const x = c % W, y = (c / W) | 0;
				for (const [dx, dy] of dirs) {
					const nx = x + dx, ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
					const m = ny * W + nx;
					if (roof.has(m) || (!R.has(m) && !ok(m))) continue;
					const nc = cc + (R.has(m) ? 1 : hide.has(m) ? HIDE_COST : 1);
					if (cost.has(m) && cost.get(m) <= nc) continue;
					cost.set(m, nc); steps.set(m, steps.get(c) + 1); prev.set(m, c); push([nc, m]);
				}
			}
			if (hit >= 0) break;
		}
			if (hit >= 0) break;
		}
		if (hit < 0) { out.none++; continue; }
		if (viaPrison) {
			const run = new Set();
			for (let c = prev.get(hit); c >= 0; c = prev.get(c)) run.add(c);
			const on = [...new Set([...run].filter(c => prisonAt.has(c)).map(c => prisonAt.get(c)))];
			if (!on.every(o => movePrison(o, run))) { out.none++; continue; }
			out.prisonMoved = (out.prisonMoved || 0) + on.length;
		}
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
	// what serves an end, more narrowly: the visiting tile itself, or a step from a tile it is entered from that a hero can stand on. Beside
	// the object's body is not at its door: a monolith entered from below kept a road end a diagonal step off its corner, (47,97) beside the
	// monolith at (45,98) (K, 2026-10-16, his 144x144 six players seed 2042393645: "roads still ending randomly"; the end was planned before
	// the monolith had its place). VMAPGEN_ROAD_SERVE_ENTRY=0 is the old reading.
	const strictServe = process.env.VMAPGEN_ROAD_SERVE_ENTRY !== '0';
	const onVisit = new Set(), entry = new Set(), body = new Set();
	for (const o of plan.objects) {
		if ((o.l || 0) !== l || !o.template || !o.template.mask) continue;
		if (/^(randomMonster|monster)/.test(o.type)) { if (process.env.VMAPGEN_ROAD_END_AT_MONSTER !== '1') continue; for (const [fx, fy] of blockingCells(o.template, o.x, o.y)) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) at(fx + dx, fy + dy); at(o.x, o.y); continue; }
		if (!SERVED.test(o.type)) continue;       // roads go to towns, mines, monoliths and gates (mapsight ROAD_DEST); a pickup or a bank is not an end
		const dirs = allowedDirs ? allowedDirs(o.template) : D8;
		for (const [fx, fy] of blockingCells(o.template, o.x, o.y)) if (fx >= 0 && fy >= 0 && fx < W && fy < H) body.add(fy * W + fx);
		for (const [vx, vy] of visitableCells(o.template, o.x, o.y)) {
			at(vx, vy); if (vx >= 0 && vy >= 0 && vx < W && vy < H) onVisit.add(vy * W + vx);
			for (const [dx, dy] of dirs) { at(vx + dx, vy + dy); const u = vx + dx, v = vy + dy; if (u >= 0 && v >= 0 && u < W && v < H) entry.add(v * W + u); }
		}
	}
	for (const c of body) if (!onVisit.has(c)) entry.delete(c);
	// the end of a roadless zone's town road (joinBareTowns: to an object of the zone or its shore) is an end too: trimmed back as one at nothing,
	// it left a start's 16-tile road a 4-tile stub (islands 144 eight players seed 1, 2026-10-09)
	for (const c of plan.roadEndsKept || []) { at(c % W, (c / W) | 0); entry.add(c); }
	const near = strictServe ? entry : hit;
	const serve = { has: c => { if (strictServe && onVisit.has(c)) return true; const x = c % W, y = (c / W) | 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const u = x + dx, v = y + dy; if (u >= 0 && v >= 0 && u < W && v < H && near.has(v * W + u)) return true; } return false; } };
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
		let joinCap = 0;   // the object route's own limit, when it gave the way (below)
		if ((!path || path.length > (bl === blocked ? maxJoin : maxJoin * 2)) && !here.size) {
			// how far the road may run to the object: as far as the zone is wide (1.5 times the root of its area), 60 tiles at least. The 60 alone
			// fit an island zone; pw_034's town (73,43) on level 1 stood in a zone of 3,700 walkable tiles with no road (its only other road end,
			// a monolith, in a part of the zone its ground does not reach), and its zone's mine was 61 tiles off (grid pg-c152, 2026-10-18).
			// VMAPGEN_TOWN_OBJECT_CAP=0 keeps 60.
			let zoneArea = 0;
			if (process.env.VMAPGEN_TOWN_OBJECT_CAP !== '0') for (let c = 0; c < W * H; c++) if (plan.zone[c] === z) zoneArea++;
			const objCap = Math.max(60, Math.round(1.5 * Math.sqrt(zoneArea)));
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
			if (false && (!p2 || p2.length > objCap) && wat) {
				const shore = new Set();
				for (let c = 0; c < W * H; c++) {
					if (plan.zone[c] !== z || wat[c] || (blocked[l * W * H + c] & OCCUPIED)) continue;
					const x = c % W, y = (c / W) | 0;
					if (vis.some(v => Math.max(Math.abs(v % W - x), Math.abs(((v / W) | 0) - y)) < GOAL_OFF)) continue;
					for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < W && ny < H && wat[ny * W + nx]) { shore.add(c); break; } }
				}
				const p3 = shore.size ? route(from, shore, W, H, blocked, l, R, DIRS4, n => plan.zone[n] === z) : null;
				if (p3 && p3.length <= objCap) p2 = p3;
			}
			// over loot and monsters too, as the zone-road join does (a way the clearing pass found with nothing to clear crossed them, i108 seed 2)
			let blp = blocked;
			if ((!p2 || p2.length > objCap) && softBlocked()) { const sb = softBlocked(), sOpen = c => !(sb[l * W * H + c] & OCCUPIED), fs = front.some(sOpen) ? front.filter(sOpen) : [...door].filter(sOpen); const p4 = fs.length ? route(fs, goal, W, H, sb, l, R, DIRS4, n => plan.zone[n] === z) : null; if (p4 && p4.length <= objCap) { p2 = p4; blp = sb; } }
			// none of those reached: the nearer goals, 4 tiles off (a cave start whose zone's other objects stood far beyond rock)
			if (!p2 || p2.length > objCap) {
				const g4 = roadlessGoals(plan, W, H, l, blocked, OCCUPIED, visitableCells, o, vis, z, 4);
				let p5 = g4.size ? route(from, g4, W, H, blocked, l, R, DIRS4, n => plan.zone[n] === z) : null;
				if ((!p5 || p5.length > objCap) && g4.size && softBlocked()) { const sb = softBlocked(), sOpen = c => !(sb[l * W * H + c] & OCCUPIED), fs2 = front.some(sOpen) ? front.filter(sOpen) : [...door].filter(sOpen); p5 = fs2.length ? route(fs2, g4, W, H, sb, l, R, DIRS4, n => plan.zone[n] === z) : null; if (p5 && p5.length <= objCap) blp = sb; }
				if (p5 && p5.length <= objCap) p2 = p5;
			}
			if (p2 && p2.length <= objCap) { path = p2; bl = blp; joinCap = objCap; out.toObject = (out.toObject || 0) + 1; (plan.roadEndsKept || (plan.roadEndsKept = new Set())).add(p2[p2.length - 1]); }
			if (process.env.VMAPGEN_TOWNROAD_TRACE) console.error(`[townroad] (${o.x},${o.y}) zone ${z}: to an object, goal tiles ${goal.size}, path ${p2 ? p2.length + " ending " + (p2[p2.length - 1] % W) + "," + ((p2[p2.length - 1] / W) | 0) : "none"}`);
		}
		if (!path || path.length > Math.max(joinCap, bl === blocked ? maxJoin : maxJoin * 2)) { if (process.env.VMAPGEN_TOWNROAD_TRACE) { const sb = softBlocked() || blocked, seen = new Set(), q = [...(front.filter(c => !(sb[l * W * H + c] & OCCUPIED)))]; for (const c of q) seen.add(c); let touched = 0; for (let h = 0; h < q.length; h++) { const c = q[h], x = c % W, y = (c / W) | 0; if (R.has(c) && !stub.has(c)) touched++; for (const [dx, dy] of DIRS4) { const u = x + dx, v = y + dy; if (u < 0 || v < 0 || u >= W || v >= H) continue; const n = v * W + u; if (seen.has(n) || (sb[l * W * H + n] & OCCUPIED)) continue; seen.add(n); q.push(n); } } console.error(`[jbt] (${o.x},${o.y}) zone ${z} left: path ${path ? path.length : 'none'}, soft ${bl !== blocked}, from ${from.length}, here ${here.size}, stub ${stub.size}; free-ground flood from the front reaches ${seen.size} tiles, ${touched} of them road`); } out.left++; continue; }
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
		// and off the rest of its picture (its roof), but for a gate or monolith, entered from under its arch in the engine's maps too (K's alchemist's lab,
		// 2026-10-31; teleportRoads keeps the same rule). VMAPGEN_OWN_ROOF=0 off.
		if (!/^(subterraneanGate|monolith)/.test(o.type) && process.env.VMAPGEN_OWN_ROOF !== '0')
			for (const [fx, fy, ch] of require('./content').footprintCells(o.template, o.x, o.y)) { const c = at(fx, fy); if (c >= 0 && ch !== 'A' && ch !== 'T' && !app.has(c)) forbidden.add(c); }
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
		// every other end of the road that was cut joins the way just laid, or the road it was, or any free tile the object is entered from: an end
		// beside another way in has reached the object. Joined only to the first, a cut end ran round the guard on the way in it stood beside and
		// closed a loop (K, 2026-10-31: "weird loops abound in the mapgen version i have installed"; his 180x180 seed 1157895410, the monolith at
		// (38,172): the end (36,171) went round the guard at (38,173) to (39,172) where (37,172) was a way in; 42 loops on the 0.3.20 grid, stock 0)
		const reach = new Set([...goal, ...laid, ...[...app].filter(c => !(blocked[l * W * H + c] & OCCUPIED) && ok(c))]);
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
const DETOUR_FROM = Number(process.env.VMAPGEN_DIAG_DETOUR_FROM || 8), DETOUR_LEN = Number(process.env.VMAPGEN_DIAG_DETOUR_LEN || 12);
// the way round over scenery (linkRoundDecor) reaches further: round a town five tiles wide takes about ten (tb72 s7104, a road between a dragon utopia and a town)
const DECOR_LEN = Number(process.env.VMAPGEN_DIAG_DECOR_LEN || 20);
const DIAG_LAST_DEPTH = Number(process.env.VMAPGEN_DIAG_LAST_DEPTH || 9), DIAG_LAST_Q = Number(process.env.VMAPGEN_DIAG_LAST_Q || 400);
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
		if (d.finalClear) return on;
		return opensZones(on) ? null : on;
	};
	// clearing these pieces opens a walk from one zone into another: a piece over two zones, or one of its tiles on a zone line beside a tile of the other
	// zone a hero stands on
	const opensZones = on => {
		for (const q of on) {
			const cells = blockingCells(q.template, q.x, q.y).map(([a, b]) => at(a, b)).filter(t => t >= 0);
			if (zone && new Set(cells.map(t => zone[t])).size > 1) return true;
			for (const t of cells) {
				if (!onLine(t)) continue;
				for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
					const n = at((t % W) + dx, ((t / W) | 0) + dy);
					if (n >= 0 && zone[n] !== zone[t] && walk(n)) return true;
				}
			}
		}
		return false;
	};
	// the tiles a road keeps: a town's, a gate's or a monolith's own tiles and the tiles it is entered from (d.visitOf, d.dirsOf), and every
	// object's own blocked tile. The whole ring round them was kept first, and a road tile behind a gate that met its door at a corner could
	// never go (the pairwise grid's pw_028, Coldshadow 36x36: (29,14) beside the gate at (30,15), whose door is entered from below only).
	// VMAPGEN_ROAD_LINK_KEEP_RING=1 keeps the ring
	let keep = null;
	const keepSet = () => {
		if (keep) return keep;
		keep = new Set();
		const ring = !d.visitOf || !d.dirsOf || process.env.VMAPGEN_ROAD_LINK_KEEP_RING === '1';
		for (const o of plan.objects) if ((o.l || 0) === l && o.template && o.template.mask && /^(randomTown|town)$|^(subterraneanGate|monolith)/.test(o.type)) {
			for (const [fx, fy] of blockingCells(o.template, o.x, o.y)) for (let ey = -1; ey <= 1; ey++) for (let ex = -1; ex <= 1; ex++) { const t = at(fx + ex, fy + ey); if (t >= 0 && (ring || (!ex && !ey))) keep.add(t); }
			if (!ring) for (const [vx, vy] of d.visitOf(o.template, o.x, o.y)) for (const [ex, ey] of d.dirsOf(o.template)) { const t = at(vx + ex, vy + ey); if (t >= 0) keep.add(t); }
		}
		return keep;
	};
	const keepRingOld = !d.visitOf || !d.dirsOf || process.env.VMAPGEN_ROAD_LINK_KEEP_RING === '1';
	// taking t leaves a corner step: two road tiles beside t that touch at a corner, with t the one tile joining them on a side
	const opensStep = t => {
		const x = t % W, y = (t / W) | 0;
		for (const [ax, ay, bx, by, ox, oy] of [[-1, 0, 0, -1, -1, -1], [1, 0, 0, -1, 1, -1], [-1, 0, 0, 1, -1, 1], [1, 0, 0, 1, 1, 1]]) {
			const a = at(x + ax, y + ay), b = at(x + bx, y + by), o = at(x + ox, y + oy);
			if (a >= 0 && b >= 0 && R.has(a) && R.has(b) && !(o >= 0 && R.has(o))) return true;
		}
		return false;
	};
	// the road tiles reached from 'from' by eight-way steps without the step from 'a' to 'b' (either way)
	const pieceWithout = (from, a, b, skip = -1) => {
		const seen = new Set([from]), q = [from];
		for (let h = 0; h < q.length; h++) {
			const cur = q[h];
			for (const [ex, ey] of D8) {
				const t = at((cur % W) + ex, ((cur / W) | 0) + ey);
				if (t < 0 || t === skip || seen.has(t) || !R.has(t) || (cur === a && t === b) || (cur === b && t === a)) continue;
				seen.add(t); q.push(t);
			}
		}
		return seen;
	};
	// t comes off when the road stays in one piece without it: every road tile round it is still reached from the first
	const spare = t => {
		if ((blocked[base + t] & OCCUPIED) || keepSet().has(t) || (!keepRingOld && opensStep(t))) return false;
		const ring = D8.map(([ex, ey]) => at((t % W) + ex, ((t / W) | 0) + ey)).filter(u => u >= 0 && R.has(u));
		if (!ring.length) return false;
		const reach = pieceWithout(ring[0], -1, -1, t);
		return ring.every(u => reach.has(u));
	};
	const linkRound = (c, n) => {
		let side = pieceWithout(c, c, n);
		if (!side.has(n)) {
			// the step's two sides are two pieces: the shortest side-to-side way over free ground from c's piece (near the step) to n's
			const prev = new Map(), q = [];
			const cx = c % W, cy = (c / W) | 0;
			// from the road within DETOUR_FROM of the step, over at most DETOUR_LEN free tiles (4 and 5 before: a step between two objects a short
			// way could not pass stayed, pw_004 with 0024 on opus-fg1020, (51,14)-(52,13) between an ore pit and a cyclops stockpile)
			for (const t of side) if (Math.max(Math.abs(t % W - cx), Math.abs(((t / W) | 0) - cy)) <= DETOUR_FROM) { prev.set(t, -1); q.push(t); }
			let hit = -1;
			const depth = t => { let k = 0; for (let u = t; prev.get(u) >= 0; u = prev.get(u)) k++; return k; };
			for (let h = 0; h < q.length && hit < 0; h++) {
				const cur = q[h];
				if (depth(cur) >= DETOUR_LEN) continue;
				for (const [ex, ey] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
					const t = at((cur % W) + ex, ((cur / W) | 0) + ey);
					if (t < 0 || prev.has(t)) continue;
					if (R.has(t)) { if (!side.has(t) && !side.has(cur)) { prev.set(t, cur); hit = t; break; } if (!side.has(t) && side.has(cur)) continue; continue; }
					if (!walk(t)) continue;
					prev.set(t, cur); q.push(t);
				}
			}
			if (hit < 0) return null;
			for (let t = prev.get(hit); t >= 0 && !R.has(t); t = prev.get(t)) R.add(t);
			side = pieceWithout(c, c, n);
			if (!side.has(n)) return null;
		}
		// now one piece either way: the step's tile that is spare goes (n first: c is the loop's own tile)
		if (spare(n)) { R.delete(n); return 'n'; }
		if (spare(c)) { R.delete(c); return 'c'; }
		return null;
	};
	// the last call (d.finalClear), where the way round over free ground failed: the same way round may cross scenery (decor with no visiting
	// cell, d.isDecor), cleared only when clearing it opens no walk from one zone into another and only once the step's own tile is known to come
	// off. The road moves round the buildings; no building goes. The steps the final pass of 1549876 left on the 114 panel cases were all between
	// two buildings (a gate's body, mines, creature banks, towns) with trees, hills or a mountain on the only way round (mn108 s8201: a magic well
	// and a black market, the way below them over a mountain). VMAPGEN_ROAD_DIAG_LINK_DECOR=0 skips it
	const linkRoundDecor = (c, n) => {
		const side = pieceWithout(c, c, n);
		if (side.has(n)) return null;
		const prev = new Map(), q = [];
		const cx = c % W, cy = (c / W) | 0;
		for (const t of side) if (Math.max(Math.abs(t % W - cx), Math.abs(((t / W) | 0) - cy)) <= DETOUR_FROM) { prev.set(t, -1); q.push(t); }
		const decorOn = new Map();
		const crossable = t => {
			if (walk(t)) return true;
			if (!decorOn.has(t)) { const on = sceneryOn(t); decorOn.set(t, on && !opensZones(on) ? on : null); }
			return !!decorOn.get(t);
		};
		let hit = -1;
		const depth = t => { let k = 0; for (let u = t; prev.get(u) >= 0; u = prev.get(u)) k++; return k; };
		for (let h = 0; h < q.length && hit < 0; h++) {
			const cur = q[h];
			if (depth(cur) >= DECOR_LEN) continue;
			for (const [ex, ey] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
				const t = at((cur % W) + ex, ((cur / W) | 0) + ey);
				if (t < 0 || prev.has(t)) continue;
				if (R.has(t)) { if (!side.has(t) && !side.has(cur)) { prev.set(t, cur); hit = t; break; } continue; }
				if (!crossable(t)) continue;
				prev.set(t, cur); q.push(t);
			}
		}
		const tr = process.env.VMAPGEN_DIAG_TRACE ? s => console.error(`[diag] L${l} (${c % W},${(c / W) | 0})-(${n % W},${(n / W) | 0}) decor round: ${s}`) : () => {};
		if (hit < 0) { tr(`no way within ${DECOR_LEN} tiles (searched ${q.length})`); return null; }
		const added = [];
		for (let t = prev.get(hit); t >= 0 && !R.has(t); t = prev.get(t)) { R.add(t); added.push(t); }
		const undo = why => { for (const t of added) R.delete(t); tr(why); return null; };
		if (!pieceWithout(c, c, n).has(n)) return undo('the way round leaves two pieces');
		let off = spare(n) ? n : spare(c) ? c : -1;
		// a tile that would leave a corner step behind it comes off with the road moved a tile (moveTile), as in moveOver: a road from the north that
		// meets a gate's door at a corner, the door entered from below (tb144x2 s7402 on c9f5964, (75,127) to the door (76,128))
		let moved = false;
		if (off < 0 && process.env.VMAPGEN_ROAD_DIAG_MOVE !== '0') { off = moveTile(n) ? n : moveTile(c) ? c : -1; moved = off >= 0; }
		if (off < 0) return undo(`neither tile comes off (keeper n ${keepSet().has(n)} c ${keepSet().has(c)}, opens a step n ${opensStep(n)} c ${opensStep(c)})`);
		const gone = new Set();
		for (const t of added) if (!walk(t)) for (const o of decorOn.get(t) || []) gone.add(o);
		if (gone.size) out.cleared += d.clearScenery(plan, l, W, H, blocked, { gone });
		if (!moved) R.delete(off);
		out.decorRound = (out.decorRound || 0) + 1;
		return off === c ? 'c' : 'n';
	};
	// t comes off the road and the free tile (or scenery that opens no walk between zones) at the other corner of each pair of its neighbours that
	// would then touch at a corner only takes the road; refused for a building's tile, a town's, gate's or monolith's own or entry tile, a 2x2 patch,
	// or where the road would part. Returns whether it moved
	const moveTile = t => {
		if ((blocked[base + t] & OCCUPIED) || keepSet().has(t)) return false;
		const x = t % W, y = (t / W) | 0, fill = [];
		for (const [ax, ay, bx, by, ox, oy] of [[-1, 0, 0, -1, -1, -1], [1, 0, 0, -1, 1, -1], [-1, 0, 0, 1, -1, 1], [1, 0, 0, 1, 1, 1]]) {
			const a = at(x + ax, y + ay), b = at(x + bx, y + by), o = at(x + ox, y + oy);
			if (!(a >= 0 && b >= 0 && R.has(a) && R.has(b)) || (o >= 0 && R.has(o))) continue;
			if (o < 0) return false;
			if (walk(o)) { fill.push([o, null]); continue; }
			const on = sceneryOn(o);
			if (!on || opensZones(on)) return false;
			fill.push([o, on]);
		}
		if (!fill.length) return false;
		for (const [o] of fill) R.add(o);
		R.delete(t);
		const ring = D8.map(([ex, ey]) => at(x + ex, y + ey)).filter(u => u >= 0 && R.has(u));
		const reach = ring.length ? pieceWithout(ring[0], -1, -1, t) : new Set();
		if (!ring.length || !ring.every(u => reach.has(u)) || fill.some(([o]) => !noBlock(o))) { R.add(t); for (const [o] of fill) R.delete(o); return false; }
		const gone = new Set();
		for (const [, on] of fill) for (const q of on || []) gone.add(q);
		if (gone.size) out.cleared += d.clearScenery(plan, l, W, H, blocked, { gone });
		out.moved = (out.moved || 0) + 1;
		return true;
	};
	// the last call, the step's two tiles already in one piece and neither able to come off because taking it would leave two of its neighbours
	// touching at a corner: the road moves a tile. The step's tile comes off and the free tile at the other corner of each such pair takes the road
	// (free ground or scenery that opens no walk between zones), so the road runs side to side round it. Never a building's tile, nor a town's, gate's
	// or monolith's own or entry tile (tb108 s7202 on the 114 panel cases: (21,66) beside a mine's door, the road moved to (20,65)).
	// VMAPGEN_ROAD_DIAG_MOVE=0 skips it
	const moveOver = (c, n) => {
		const tr = process.env.VMAPGEN_DIAG_TRACE ? s => console.error(`[diag] L${l} (${c % W},${(c / W) | 0})-(${n % W},${(n / W) | 0}) move: ${s}`) : () => {};
		if (!pieceWithout(c, c, n).has(n)) { tr('two pieces'); return null; }
		for (const t of [n, c]) {
			if ((blocked[base + t] & OCCUPIED) || keepSet().has(t)) { tr(`(${t % W},${(t / W) | 0}) occupied or kept`); continue; }
			if (moveTile(t)) return t === c ? 'c' : 'n';
		}
		return null;
	};
	// a gate's or a monolith's door (its visiting tile) and the free tiles it is entered from (d.visitOf, d.dirsOf)
	let doors = null;
	const doorFronts = () => {
		if (doors) return doors;
		doors = new Map();
		for (const o of plan.objects) if ((o.l || 0) === l && o.template && o.template.mask && /^(subterraneanGate|monolith)/.test(o.type)) {
			const own = new Set(blockingCells(o.template, o.x, o.y).map(([a, b]) => at(a, b)));
			for (const [vx, vy] of d.visitOf(o.template, o.x, o.y)) {
				const g = at(vx, vy);
				if (g < 0) continue;
				const f = d.dirsOf(o.template).map(([ex, ey]) => at(vx + ex, vy + ey)).filter(t => t >= 0 && !own.has(t));
				doors.set(g, [...(doors.get(g) || []), ...f]);
			}
		}
		return doors;
	};
	// a step on a gate's or a monolith's door: the road reaches the door from behind or beside, where the door is entered from below only (the
	// pairwise grid's pw_035, 144x144 two levels: the gate at (64,37) on level 1, the road at (65,36) above its corner, rock below the door but
	// one tile). The road is linked to a free tile the door is entered from when none carries road (side to side, at most 6 tiles), then the
	// door's own tile gives up its road when the road stays one piece without it: the road ends before the door. A town keeps its door's road,
	// and so does a door on a road of fewer than 12 tiles, whose end the gate is (pw_032: a start's 8 tiles underground to the gate beside it).
	// Returns the tile taken off, or -1. VMAPGEN_ROAD_DIAG_DOOR=0 skips it
	const doorRound = (c, n) => {
		for (const g of [n, c]) {
			const fr = doorFronts().get(g);
			if (!fr) continue;
			const added = [];
			if (!fr.some(t => R.has(t))) {
				const goal = new Set(fr.filter(walk));
				if (!goal.size) continue;
				const prev = new Map(), q = [];
				const gx = g % W, gy = (g / W) | 0;
				for (const t of R) if (t !== g && Math.max(Math.abs(t % W - gx), Math.abs(((t / W) | 0) - gy)) <= 5) { prev.set(t, -1); q.push(t); }
				let hit = -1;
				const depth = t => { let k = 0; for (let u = t; prev.get(u) >= 0; u = prev.get(u)) k++; return k; };
				for (let h = 0; h < q.length && hit < 0; h++) {
					const cur = q[h];
					if (depth(cur) >= 6) continue;
					for (const [ex, ey] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
						const t = at((cur % W) + ex, ((cur / W) | 0) + ey);
						if (t < 0 || prev.has(t) || t === g || R.has(t) || !walk(t)) continue;
						prev.set(t, cur); q.push(t);
						if (goal.has(t)) { hit = t; break; }
					}
				}
				if (hit < 0) continue;
				for (let t = hit; t >= 0 && !R.has(t); t = prev.get(t)) { R.add(t); added.push(t); }
			}
			const ring = D8.map(([ex, ey]) => at((g % W) + ex, ((g / W) | 0) + ey)).filter(u => u >= 0 && R.has(u));
			const reach = ring.length ? pieceWithout(ring[0], -1, -1, g) : new Set();
			if (ring.length && ring.every(u => reach.has(u)) && reach.size >= 12 && !opensStep(g)) { R.delete(g); return g; }
			for (const t of added) R.delete(t);
		}
		return -1;
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
	// a road on the map's outermost row or column moves a tile in (d.rimIn, the last call): the tile straight inward from each rim road tile
	// joins the road where it is free floor or only scenery off a zone line stands on it (cleared), and then each rim tile the road stays one
	// piece without comes off; the corner steps this leaves are joined below. Rim road showed on 18 of the 98 pairwise maps (the Opus Reviewer,
	// pass 129: Coldshadow 108's corner steps on the last row; the lead, 2026-10-17: block the edge row, keep the passage a tile in). Only maps
	// with rim road change. VMAPGEN_ROAD_RIM_IN=0 leaves it
	if (d.rimIn && process.env.VMAPGEN_ROAD_RIM_IN !== '0') {
		const edge = c => c % W === 0 || c % W === W - 1 || ((c / W) | 0) === 0 || ((c / W) | 0) === H - 1;
		const inward = c => { const x = c % W, y = (c / W) | 0; return at(x === 0 ? 1 : x === W - 1 ? W - 2 : x, y === 0 ? 1 : y === H - 1 ? H - 2 : y); };
		const rimTiles = [...R].filter(edge);
		for (const t of rimTiles) {
			const u = inward(t);
			if (u < 0 || edge(u) || R.has(u)) continue;
			if (!walk(u)) {
				const on = sceneryOn(u);
				if (!on) continue;
				out.cleared += d.clearScenery(plan, l, W, H, blocked, { gone: new Set(on) });
				if (!walk(u)) continue;
			}
			R.add(u); out.rimIn = (out.rimIn || 0) + 1;
		}
		for (let pass = 0; pass < 4 && rimTiles.length; pass++) {
			let any = false;
			for (const t of [...R].filter(edge)) {
				const ring = D8.map(([ex, ey]) => at((t % W) + ex, ((t / W) | 0) + ey)).filter(u => u >= 0 && R.has(u));
				if (!ring.length) continue;
				const reach = pieceWithout(ring[0], -1, -1, t);
				if (ring.every(u => reach.has(u))) { R.delete(t); out.rimOff = (out.rimOff || 0) + 1; any = true; }
			}
			if (!any) break;
		}
	}
	let townGate = null, wetObj = null, wetTown = false;
	for (let pass = 0; pass < 3; pass++) {
		let any = false;
		for (const c of [...R]) {
			const x = c % W, y = (c / W) | 0;
			for (const [dx, dy] of [[1, 1], [1, -1]]) {
				const n = at(x + dx, y + dy), s1 = at(x + dx, y), s2 = at(x, y + dy);
				if (n < 0 || !R.has(n) || R.has(s1) || R.has(s2)) continue;
				let pick = [s1, s2].filter(t => walk(t) && noBlock(t))[0];
				// the last call (d.allowBlock, after the last thinning): a tile beside the step that only a 2x2 block of road refused takes it; a
				// patch two tiles wide is drawn as joined road, a corner step as two dead ends (K, 2026-10-16, his seed 2042393645: "roads still
				// ending randomly", the steps round the guard of the monolith at (45,98); the Template Factory's road-corners check failed 222 of 346
				// frozen maps). VMAPGEN_ROAD_DIAG_BLOCK=0 keeps refusing.
				if (pick === undefined && d.allowBlock && process.env.VMAPGEN_ROAD_DIAG_BLOCK !== '0') { pick = [s1, s2].find(t => walk(t)); if (pick !== undefined) out.blocks = (out.blocks || 0) + 1; }
				// and where neither tile beside the step can carry road (a mine's body on one side, a dwelling on the other: the same map, (114,25) to
				// (115,26) on the way to a mine's door), the short arm past the step goes when it ends there and serves no town, gate or monolith: the
				// road then ends a step from that door instead of showing two dead ends (VMAPGEN_ROAD_DIAG_BLOCK=0 keeps it)
				// or a short way round over free ground, side to side only, from one tile of the step to the other (at most 8 tiles): both tiles
				// beside the step taken, the arms past it too long to take up (the pairwise grid's pw_004, Coldshadow 108: 5 steps left)
				if (pick === undefined && d.allowBlock && process.env.VMAPGEN_ROAD_DIAG_BLOCK !== '0') {
					const prev = new Map([[c, -1]]), q = [c]; let found = false;
					for (let h = 0; h < q.length && !found && q.length < DIAG_LAST_Q; h++) {
						const cur = q[h]; let depth = 0; for (let t = cur; prev.get(t) >= 0; t = prev.get(t)) depth++;
						if (depth >= DIAG_LAST_DEPTH) continue;
						for (const [ex, ey] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
							const t = at((cur % W) + ex, ((cur / W) | 0) + ey);
							if (t < 0 || prev.has(t)) continue;
							if (t === n) { prev.set(t, cur); found = true; break; }
							if (!walk(t) || (R.has(t) && t !== n)) continue;
							prev.set(t, cur); q.push(t);
						}
					}
					if (found) { for (let t = prev.get(n); t !== c && t >= 0; t = prev.get(t)) R.add(t); out.detours = (out.detours || 0) + 1; out.closed++; any = true; continue; }
				}
				// a road end on an object's own cell (a portal's or a gate's tile) that meets the road at a corner only comes off it: the road ends on the
				// tile beside it a hero steps in from (the pairwise grid's pw_015, 180x180: the two-way monolith at (103,66), its guard on the road at
				// (104,67), the monolith's body and the sea on the two sides). Never a town's or a gate's tile: a town's door and a gate keep their road
				// (taking it off two towns' doors failed start-road on the pairwise grid's pw_014). VMAPGEN_ROAD_DIAG_ENDOFF=0 keeps it
				if (pick === undefined && d.allowBlock && process.env.VMAPGEN_ROAD_DIAG_ENDOFF !== '0') {
					if (!townGate) { townGate = new Set(); for (const o of plan.objects) if ((o.l || 0) === l && o.template && o.template.mask && /^(randomTown|town)$|^subterraneanGate/.test(o.type)) for (const [fx, fy] of blockingCells(o.template, o.x, o.y)) { const t = at(fx, fy); if (t >= 0) townGate.add(t); } }
					const deg = t => { let k = 0; for (const [ex, ey] of D8) { const u = at((t % W) + ex, ((t / W) | 0) + ey); if (u >= 0 && R.has(u)) k++; } return k; };
					const off = [n, c].find(t => (blocked[base + t] & OCCUPIED) && !walkers.has(t) && !townGate.has(t) && deg(t) === 1 && walk(t === c ? n : c));
					if (off !== undefined) { R.delete(off); out.endsOff = (out.endsOff || 0) + 1; any = true; if (off === c) break; continue; }
				}
				// underground, a rock tile beside the step is dug out for the road when every open tile around it is of the step's own zone (no new way
				// from one zone into another): the road squeezed between a town's body and the cave wall (pw_013, 108x108 two levels, (18,6) to (19,7)
				// on level 1). VMAPGEN_ROAD_DIAG_CARVE=0 leaves the rock
				if (pick === undefined && d.allowBlock && om && zone && process.env.VMAPGEN_ROAD_DIAG_CARVE !== '0') {
					const zc = zone[c];
					// and no rock beside it is left outside every 2x2 block of rock: this runs after the late thin-rock pass, and a spike left here showed
					// as a black square (72x72 four players two levels seed 1, (16,69) on level 1 beside the dug (17,69); test/thin-rock-late)
					const rockAt = (u, cut) => u >= 0 && u !== cut && !om[u];
					const inBlock = (u, cut) => { const ux = u % W, uy = (u / W) | 0; for (const [bx, by] of [[0, 0], [-1, 0], [0, -1], [-1, -1]]) { const cs = [at(ux + bx, uy + by), at(ux + bx + 1, uy + by), at(ux + bx, uy + by + 1), at(ux + bx + 1, uy + by + 1)]; if (cs.every(v => rockAt(v, cut))) return true; } return false; };
					const leavesSpike = t => D8.some(([ex, ey]) => { const u = at((t % W) + ex, ((t / W) | 0) + ey); return u >= 0 && rockAt(u, t) && !(water && water[u]) && inBlock(u, -1) && !inBlock(u, t); });
					const carveSafe = t => { const tx = t % W, ty = (t / W) | 0; if (tx < 1 || ty < 1 || tx >= W - 1 || ty >= H - 1 || zone[n] !== zc) return false; for (const [ex, ey] of D8) { const u = at(tx + ex, ty + ey); if (u >= 0 && om[u] && !(water && water[u]) && zone[u] !== zc) return false; } return process.env.VMAPGEN_ROAD_DIAG_CARVE_SPIKE === '0' || !leavesSpike(t); };
					const t = [s1, s2].find(t => t >= 0 && !om[t] && !(water && water[t]) && !(blocked[base + t] & OCCUPIED) && carveSafe(t));
					if (t !== undefined) { om[t] = 1; pick = t; out.carved = (out.carved || 0) + 1; }
					// the last call: where digging the tile would leave a spike of rock, the spike is dug with it, when every open tile round each spike is of
					// the step's own zone and the two together leave no other spike (tb144x2 seeds 7408, 7409 and 7412 on the 114 panel cases: a road beside
					// a town's or a creature bank's body and the cave wall). VMAPGEN_ROAD_DIAG_CARVE_WITH_SPIKE=0 skips it
					if (pick === undefined && d.finalClear && process.env.VMAPGEN_ROAD_DIAG_CARVE_WITH_SPIKE !== '0') {
						const zoneOk = u => { const ux = u % W, uy = (u / W) | 0; if (ux < 1 || uy < 1 || ux >= W - 1 || uy >= H - 1 || zone[n] !== zc || (water && water[u]) || (blocked[base + u] & OCCUPIED)) return false; for (const [ex, ey] of D8) { const v = at(ux + ex, uy + ey); if (v >= 0 && om[v] && !(water && water[v]) && zone[v] !== zc) return false; } return true; };
						const rockOut = (v, S) => v >= 0 && !S.has(v) && !om[v];
						const blockOut = (v, S) => { const vx = v % W, vy = (v / W) | 0; for (const [bx, by] of [[0, 0], [-1, 0], [0, -1], [-1, -1]]) { const cs = [at(vx + bx, vy + by), at(vx + bx + 1, vy + by), at(vx + bx, vy + by + 1), at(vx + bx + 1, vy + by + 1)]; if (cs.every(w => rockOut(w, S))) return true; } return false; };
						const spikesOf = S => { const sp = new Set(); for (const s of S) for (const [ex, ey] of D8) { const v = at((s % W) + ex, ((s / W) | 0) + ey); if (rockOut(v, S) && !(water && water[v]) && blockOut(v, new Set()) && !blockOut(v, S)) sp.add(v); } return sp; };
						for (const t0 of [s1, s2]) {
							if (t0 < 0 || om[t0] || !zoneOk(t0)) continue;
							const S = new Set([t0, ...spikesOf(new Set([t0]))]);
							if (S.size > 3 || [...S].some(u => !zoneOk(u)) || spikesOf(S).size) continue;
							for (const u of S) om[u] = 1;
							pick = t0; out.carved = (out.carved || 0) + S.size; out.spikesDug = (out.spikesDug || 0) + S.size - 1;
							break;
						}
					}
				}
				// on the surface, a shore tile beside the step becomes land for the road when every land tile round it is of the step's own zone, no
				// object stands on it or within two of it on the water (a boat's or a shipyard's water), and the sea round it stays one piece: the road
				// squeezed between a town's corner and the shore (the pairwise grid's pw_004, Coldshadow 108: (69,99) to (70,100) before the town at
				// (72,99)). VMAPGEN_ROAD_DIAG_FILL=0 leaves the water
				if (pick === undefined && d.allowBlock && water && zone && process.env.VMAPGEN_ROAD_DIAG_FILL !== '0') {
					const zc = zone[c];
					if (!wetObj) { wetObj = new Set(); for (const o of plan.objects) if ((o.l || 0) === l && o.template && o.template.mask) for (const [fx, fy] of blockingCells(o.template, o.x, o.y).concat([[o.x, o.y]])) for (let ey = -2; ey <= 2; ey++) for (let ex = -2; ex <= 2; ex++) { const t = at(fx + ex, fy + ey); if (t >= 0 && water[t] && (!ex && !ey || /^(boat|shipyard|buoy|whirlpool|flotsam|seaChest|shipwreckSurvivor)/.test(o.type))) wetObj.add(t); } }
					// and a coastal town's own boat tiles (CGTownInstance::getOutOffsets: its visiting tile plus (-1,+2) and (+1,+2); the Opus Reviewer's
					// pass 127: a step beside a town's door could take one)
					if (!wetTown) { wetTown = true; if (d.visitOf) for (const o of plan.objects) if ((o.l || 0) === l && o.template && o.template.mask && /^(randomTown|town)$/.test(o.type)) for (const [vx, vy] of d.visitOf(o.template, o.x, o.y)) for (const [ex, ey] of [[-1, 2], [1, 2]]) { const t = at(vx + ex, vy + ey); if (t >= 0 && water[t]) wetObj.add(t); } }
					const seaKeeps = t => {
						const x = t % W, y = (t / W) | 0, nb = [];
						for (const [ex, ey] of D8) { const u = at(x + ex, y + ey); if (u >= 0 && water[u]) nb.push(u); }
						if (nb.length <= 1) return nb.length === 1;
						const seen = new Set([nb[0]]), st = [nb[0]];
						while (st.length) { const i = st.pop(); for (const [ex, ey] of D8) { const u = at((i % W) + ex, ((i / W) | 0) + ey); if (u < 0 || u === t || seen.has(u) || !water[u] || Math.abs(u % W - x) > 6 || Math.abs(((u / W) | 0) - y) > 6) continue; seen.add(u); st.push(u); } }
						return nb.every(u => seen.has(u));
					};
					const fillSafe = t => { const tx = t % W, ty = (t / W) | 0; if (tx < 1 || ty < 1 || tx >= W - 1 || ty >= H - 1 || zone[n] !== zc || wetObj.has(t) || (blocked[base + t] & OCCUPIED)) return false; for (const [ex, ey] of D8) { const u = at(tx + ex, ty + ey); if (u >= 0 && !water[u] && zone[u] !== zc && (!om || om[u])) return false; } return seaKeeps(t); };
					const t = [s1, s2].find(t => t >= 0 && water[t] && fillSafe(t));
					if (t !== undefined) { water[t] = 0; if (zone[t] !== zc) zone[t] = zc; pick = t; out.filled = (out.filled || 0) + 1; }
				}
				if (pick === undefined && d.allowBlock && process.env.VMAPGEN_ROAD_DIAG_BLOCK !== '0' && !sceneryOn(s1) && !sceneryOn(s2)) {
					// the road piece on one side that meets the rest only through this step: at most 6 tiles, else null
					const arm = (from, other) => { const out2 = [from], seen = new Set([from, other]); for (let h = 0; h < out2.length; h++) { const cur = out2[h]; for (const [ex, ey] of D8) { const t = at((cur % W) + ex, ((cur / W) | 0) + ey); if (t >= 0 && R.has(t) && !seen.has(t)) { seen.add(t); out2.push(t); if (out2.length > 6) return null; } } } return out2; };
					const keepers = new Set();
					for (const o of plan.objects) if ((o.l || 0) === l && o.template && o.template.mask && /^(randomTown|town|subterraneanGate|monolith)/.test(o.type))
						for (const [fx, fy] of blockingCells(o.template, o.x, o.y)) for (let ey = -1; ey <= 1; ey++) for (let ex = -1; ex <= 1; ex++) { const t = at(fx + ex, fy + ey); if (t >= 0) keepers.add(t); }
					const cuts = [arm(c, n), arm(n, c)].filter(a2 => a2 && a2.length <= 6 && !a2.some(t => keepers.has(t))).sort((p2, q2) => p2.length - q2.length);
					if (cuts.length) { for (const t of cuts[0]) R.delete(t); out.armsCut = (out.armsCut || 0) + 1; any = true; break; }
				}
				if (pick === undefined) {
					// (the last call takes a tile that makes a 2x2 patch here too, as above)
					const t = [s1, s2].find(t => noBlock(t) && sceneryOn(t)) ?? (d.allowBlock && process.env.VMAPGEN_ROAD_DIAG_BLOCK !== '0' ? [s1, s2].find(t => sceneryOn(t)) : undefined);
					if (t === undefined) {
						// a link round: the road on the step's one side reaches the road on its other side over at most 5 free tiles (side to side), and the
						// step's own tile then goes when the road stays in one piece without it. The Reviewer's pass 115, Coldshadow 108 Mediterranean seed 9:
						// green's doorway road stepped (90,22)-(91,23)-(92,24) down the shore round the guard at (93,22), the sea on one side and an oak on
						// the zone line on the other; (92,22) joins it straight to the guard. VMAPGEN_ROAD_DIAG_LINK=0 skips it
						// (after the arm cut and the scenery: a short dead-end arm or a tree cleared is the plainer fix)
						if (d.allowBlock && process.env.VMAPGEN_ROAD_DIAG_LINK !== '0') {
							const r = linkRound(c, n);
							if (r) { out.linked = (out.linked || 0) + 1; out.closed++; any = true; if (r === 'c') break; continue; }
						}
						if (d.allowBlock && d.finalClear && process.env.VMAPGEN_ROAD_DIAG_LINK_DECOR !== '0') {
							const r = linkRoundDecor(c, n);
							if (r) { out.linked = (out.linked || 0) + 1; out.closed++; any = true; if (r === 'c') break; continue; }
						}
						if (d.allowBlock && d.finalClear && process.env.VMAPGEN_ROAD_DIAG_MOVE !== '0') {
							const r = moveOver(c, n);
							if (r) { out.closed++; any = true; if (r === 'c') break; continue; }
						}
						if (d.allowBlock && d.visitOf && d.dirsOf && process.env.VMAPGEN_ROAD_DIAG_DOOR !== '0') {
							const g = doorRound(c, n);
							if (g >= 0) { out.doorsOff = (out.doorsOff || 0) + 1; out.closed++; any = true; if (g === c) break; continue; }
						}
						// last: the dead-end arm past the step goes when it is up to 12 tiles and serves no town, gate or monolith, where nothing beside
						// the step can carry road and no way round exists: a pocket entered only on that diagonal (the pairwise grid's pw_004 with 0024,
						// (31,86) to (32,85): a town's body and surface rock beside the step, 8 tiles of road on to a mine in a treasure pocket). The
						// pocket stays a step away on foot; the road ends before it instead of showing two dead ends. VMAPGEN_ROAD_DIAG_ARM12=0 keeps it
						if (d.allowBlock && process.env.VMAPGEN_ROAD_DIAG_BLOCK !== '0' && process.env.VMAPGEN_ROAD_DIAG_ARM12 !== '0') {
							const arm12 = (from, other) => { const a2 = [from], seen = new Set([from, other]); for (let h = 0; h < a2.length; h++) { const cur = a2[h]; for (const [ex, ey] of D8) { const t = at((cur % W) + ex, ((cur / W) | 0) + ey); if (t >= 0 && R.has(t) && !seen.has(t)) { seen.add(t); a2.push(t); if (a2.length > 12) return null; } } } return a2; };
							// (a town's, a gate's or a monolith's own tiles, its door and the tiles it is entered from: the step's tile beside a town's body
							// is not its door)
							const keepers12 = new Set();
							for (const o of plan.objects) if ((o.l || 0) === l && o.template && o.template.mask && /^(randomTown|town|subterraneanGate|monolith)/.test(o.type)) {
								for (const [fx, fy] of blockingCells(o.template, o.x, o.y)) { const t = at(fx, fy); if (t >= 0) keepers12.add(t); }
								if (d.visitOf && d.dirsOf) for (const [vx, vy] of d.visitOf(o.template, o.x, o.y)) { const g0 = at(vx, vy); if (g0 >= 0) keepers12.add(g0); for (const [ex, ey] of d.dirsOf(o.template)) { const t = at(vx + ex, vy + ey); if (t >= 0) keepers12.add(t); } }
								else for (const [fx, fy] of blockingCells(o.template, o.x, o.y)) for (let ey = -1; ey <= 1; ey++) for (let ex = -1; ex <= 1; ex++) { const t = at(fx + ex, fy + ey); if (t >= 0) keepers12.add(t); }
							}
							const cuts12 = [arm12(c, n), arm12(n, c)].filter(a2 => a2 && !a2.some(t => keepers12.has(t))).sort((p2, q2) => p2.length - q2.length);
							if (cuts12.length) { for (const t of cuts12[0]) R.delete(t); out.armsCut = (out.armsCut || 0) + 1; any = true; break; }
						}
						continue;
					}
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

/**
 * A road tile that meets the road on one side only, beside a road that runs on past it, is drawn by the game as a stub one tile long: K's
 * seed 2042393645 (2026-10-16, "roads still ending randomly") kept one above and two below the road past the monolith at (45,98) once the
 * corner steps there were joined. Such a tile goes when it is no visiting tile and no tile a destination (town, mine, monolith, gate) is
 * entered from, and every road tile at its corners meets that one side, so nothing is cut off. A plain road end (no road at its corners)
 * is trimRoadStubs' to judge. VMAPGEN_ROAD_NUBS=0 skips it. Returns { cut }.
 */
function roadNubs(plan, W, H, l, visitableCells, allowedDirs) {
	const R = plan.roadCells, out = { cut: 0 };
	if (!R || R.size < 3 || process.env.VMAPGEN_ROAD_NUBS === '0') return out;
	const keep = new Set();
	for (const o of plan.objects) {
		if ((o.l || 0) !== l || !o.template || !o.template.mask || !SERVED.test(o.type)) continue;
		const dirs = allowedDirs ? allowedDirs(o.template) : D8;
		for (const [vx, vy] of visitableCells(o.template, o.x, o.y)) { if (vx >= 0 && vy >= 0 && vx < W && vy < H) keep.add(vy * W + vx); for (const [dx, dy] of dirs) { const u = vx + dx, v = vy + dy; if (u >= 0 && v >= 0 && u < W && v < H) keep.add(v * W + u); } }
	}
	for (const c of plan.roadEndsKept || []) keep.add(c);
	const at = (x, y) => (x >= 0 && y >= 0 && x < W && y < H ? y * W + x : -1);
	for (let pass = 0; pass < 3; pass++) {
		let any = false;
		for (const c of [...R]) {
			if (!R.has(c) || keep.has(c)) continue;
			const x = c % W, y = (c / W) | 0;
			const sides = [at(x + 1, y), at(x - 1, y), at(x, y + 1), at(x, y - 1)].filter(t => t >= 0 && R.has(t));
			if (sides.length !== 1) continue;
			const e = sides[0], ex = e % W, ey = (e / W) | 0;
			const corners = [at(x + 1, y + 1), at(x + 1, y - 1), at(x - 1, y + 1), at(x - 1, y - 1)].filter(t => t >= 0 && R.has(t));
			if (!corners.length || !corners.every(t => Math.abs(t % W - ex) + Math.abs(((t / W) | 0) - ey) === 1)) continue;
			R.delete(c); out.cut++; any = true;
		}
		if (!any) break;
	}
	return out;
}

/**
 * A road end on one of a destination's entry tiles goes when the road already passes another of its entry tiles: the game draws it as a
 * stub one tile long beside the object (K's seed 2042393645, the two-way monolith at (45,98): the road runs along row 99 past its guard,
 * and one tile at (44,98) climbed to the portal's left side; the lead, 2026-10-16: "a one-tile stub beside a portal reads as the same
 * thing in game" as the stubs K reported). The road passes a destination when its front (the tile below its visiting tile) or the visiting
 * tile itself carries road; the front is never taken, and an object entered from no front keeps every door. Such a tile's road neighbours make one unbroken run round it, so taking it cuts nothing off (on
 * K's map the portal's own tile carries road too, so (44,98) had two road tiles on its sides, and roadNubs' one-side test kept it). It stays when it is a visiting tile, or when for any destination it is an entry
 * tile of, no other entry tile carries road. VMAPGEN_ROAD_SIDE_DOOR=0 skips it. Returns { cut }.
 */
function sideDoorStubs(plan, W, H, l, visitableCells, allowedDirs) {
	const R = plan.roadCells, out = { cut: 0 };
	if (!R || R.size < 3 || process.env.VMAPGEN_ROAD_SIDE_DOOR === '0') return out;
	const at = (x, y) => (x >= 0 && y >= 0 && x < W && y < H ? y * W + x : -1);
	// each destination's front (the tile straight below its visiting tile, where the checks and the engine look for its road; a town keeps a road
	// there, start-road and town-road read it: taking it failed pw_028) and its own visiting tiles; a side door is any other entry tile
	const visit = new Set(), front = new Set(), doorsOf = new Map();
	for (const o of plan.objects) {
		if ((o.l || 0) !== l || !o.template || !o.template.mask || !SERVED.test(o.type)) continue;
		const dirs = allowedDirs ? allowedDirs(o.template) : D8, d = { main: [] };
		const hasFront = dirs.some(([dx, dy]) => dx === 0 && dy === 1);
		const e = new Set();
		for (const [vx, vy] of visitableCells(o.template, o.x, o.y)) {
			const v = at(vx, vy); if (v >= 0) { visit.add(v); d.main.push(v); }
			const f = hasFront ? at(vx, vy + 1) : -1; if (f >= 0) { front.add(f); d.main.push(f); }
			for (const [dx, dy] of dirs) { const u = at(vx + dx, vy + dy); if (u >= 0) e.add(u); }
		}
		if (!hasFront) continue;            // no front to pass: its side doors are its only doors
		for (const t of e) { if (!doorsOf.has(t)) doorsOf.set(t, []); doorsOf.get(t).push(d); }
	}
	const kept = new Set(plan.roadEndsKept || []);
	const stub = c => {
		const ring = D8RING.map(([dx, dy]) => { const t = at((c % W) + dx, ((c / W) | 0) + dy); return t >= 0 && R.has(t) ? 1 : 0; });
		let n = 0, runs = 0; for (let k = 0; k < 8; k++) { n += ring[k]; if (ring[k] && !ring[(k + 7) % 8]) runs++; }
		return n >= 1 && n < 8 && runs === 1;
	};
	for (let pass = 0; pass < 3; pass++) {
		let any = false;
		for (const [t, es] of doorsOf) {
			if (!R.has(t) || visit.has(t) || front.has(t) || kept.has(t) || !stub(t)) continue;
			if (!es.every(d => d.main.some(u => u !== t && R.has(u)))) continue;
			R.delete(t); out.cut++; any = true;
		}
		if (!any) break;
	}
	return out;
}

module.exports = { roadlessGoals, teleportRoads, closeRoadGaps, trimRoadStubs, lonePieces, joinBareTowns, openTownFronts, roadsPastObjects, thinRoadBlocks, closeDiagonalSteps, roadNubs, sideDoorStubs };
