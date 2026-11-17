/**
 * startroads.js - every start town lies on the one road network (K, 2026-11-16, S277: green's town sat on an 11-tile piece of its own
 * and ended in open ground, while the other three starts shared a 698-tile piece; "path out routing completely failed, and that
 * player has an extremely unfair disadvantage").
 *
 * The road passes before this one each make a road that is right for the plan they saw; a later pass can still cut it (the zone
 * join scenery took a road tile, 2026-11-17, the cause on K's map: guardZoneJoins). This pass is the check at the end and the repair
 * for what is left: the pieces of road (eight-way connected) are counted per level, the piece most start towns touch is the network,
 * and each start that touches another piece or none gets a road to it, over open ground first and then over scenery that may go.
 * A start with no walk at all to the network (water or rock between, an islands layout) is left, and says so. A start that has a walk
 * and still has no road after this is an error: the map is not written (VMAPGEN_START_ROAD_FAIL=0 only logs).
 */
'use strict';

const { route } = require('./roadnet');

const D8 = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
const D4 = [[0, -1], [1, 0], [0, 1], [-1, 0]];

// pieces of road: { of: Map(cell -> index), list: [[cells]] }
function roadPieces(R, W, H) {
	const of = new Map(), list = [];
	for (const c of R) {
		if (of.has(c)) continue;
		const k = list.length, q = [c];
		of.set(c, k);
		for (let h = 0; h < q.length; h++) {
			const x = q[h] % W, y = (q[h] / W) | 0;
			for (const [dx, dy] of D8) {
				const u = x + dx, v = y + dy;
				if (u < 0 || v < 0 || u >= W || v >= H) continue;
				const m = v * W + u;
				if (R.has(m) && !of.has(m)) { of.set(m, k); q.push(m); }
			}
		}
		list.push(q);
	}
	return { of, list };
}

// the start towns of a level: owned towns, each with the cells its road would touch (a road tile within two of its anchor, the way
// the lead's reading and mapsight count it) and its visiting cells
function startTowns(plan, l, W, H, visitableCells) {
	const out = [];
	for (const o of plan.objects || []) {
		if ((o.l || 0) !== l || !o.template || !/^(town|randomTown)$/.test(o.type) || !(o.options && o.options.owner)) continue;
		const vis = visitableCells(o.template, o.x, o.y).filter(([x, y]) => x >= 0 && y >= 0 && x < W && y < H).map(([x, y]) => y * W + x);
		out.push({ o, vis, at: [o.x, o.y] });
	}
	return out;
}

function touched(R, st, W, H) {
	const hit = new Set();
	const [ax, ay] = st.at;
	for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
		const x = ax + dx, y = ay + dy;
		if (x >= 0 && y >= 0 && x < W && y < H && R.has(y * W + x)) hit.add(y * W + x);
	}
	return hit;
}

/**
 * Check and repair. d: { blockingCells, visitableCells, isDecor, clearScenery, blocked (the plan's blocked array) } .
 * Returns { starts, pieces, joined, tiles, cleared, noWalk: [colour], left: [colour], network }.
 */
function joinStartRoads(plan, W, H, l, d) {
	const R = plan.roadCells, N = W * H;
	const out = { starts: 0, pieces: 0, joined: 0, tiles: 0, cleared: 0, noWalk: [], left: [], network: 0 };
	if (!R || !R.size) return out;
	const towns = startTowns(plan, l, W, H, d.visitableCells);
	out.starts = towns.length;
	if (towns.length < 2) return out;
	const water = plan.p && plan.p.water, om = plan.openMask;
	// ground the road may not use at all (a building, a mine, a town, a gate: anything that is not scenery, a pickup or a stack) and
	// scenery that may go for it
	const hard = new Uint8Array(N), decor = new Uint8Array(N), decorOf = new Map();
	for (let c = 0; c < N; c++) if ((water && water[c]) || (om && !om[c])) hard[c] = 1;
	for (const o of plan.objects || []) {
		if ((o.l || 0) !== l || !o.template || !o.template.mask) continue;
		if (/^(resource|randomResource|treasureChest|campfire|randomArtifact|artifact|spellScroll|pandoraBox|randomMonster|monster)/.test(o.type)) continue;
		const cells = d.blockingCells(o.template, o.x, o.y).filter(([x, y]) => x >= 0 && y >= 0 && x < W && y < H);
		const scen = d.isDecor && d.isDecor(o) && !d.visitableCells(o.template, o.x, o.y).length;
		for (const [x, y] of cells) {
			if (scen) { decor[y * W + x] = 1; if (!decorOf.has(y * W + x)) decorOf.set(y * W + x, []); decorOf.get(y * W + x).push(o); }
			else hard[y * W + x] = 1;
		}
	}
	// route() reads (blocked[l * N + c] & 1) as occupied: a level-offset array of this pass's own
	const mk = (withDecor) => { const b = new Uint8Array((l + 1) * N); for (let c = 0; c < N; c++) if (hard[c] || (!withDecor && decor[c])) b[l * N + c] = 1; return b; };
	// is there a walk at all (eight ways, over what a road could be laid on) from a cell to a set
	const walkTo = (from, goal) => {
		const seen = new Uint8Array(N), q = [];
		for (const c of from) if (!hard[c] && !seen[c]) { seen[c] = 1; q.push(c); }
		for (let h = 0; h < q.length; h++) {
			if (goal.has(q[h])) return true;
			const x = q[h] % W, y = (q[h] / W) | 0;
			for (const [dx, dy] of D8) {
				const u = x + dx, v = y + dy;
				if (u < 0 || v < 0 || u >= W || v >= H) continue;
				const m = v * W + u;
				if (!seen[m] && !hard[m]) { seen[m] = 1; q.push(m); }
			}
		}
		return false;
	};
	const colour = t => (t.o.options && t.o.options.owner) || '?';
	for (let round = 0; round < towns.length + 1; round++) {
		const free = mk(false), freeDecor = mk(true);
		const P = roadPieces(R, W, H);
		out.pieces = P.list.length;
		const hits = towns.map(t => { const s = new Set(); for (const c of touched(R, t, W, H)) s.add(P.of.get(c)); return s; });
		// the network: the piece the most starts touch (the larger on a tie)
		const votes = new Map();
		for (const s of hits) for (const k of s) votes.set(k, (votes.get(k) || 0) + 1);
		let main = -1;
		for (const [k, n] of votes) if (main < 0 || n > votes.get(main) || (n === votes.get(main) && P.list[k].length > P.list[main].length)) main = k;
		if (main < 0) main = 0;
		if (round === 0) out.network = P.list[main] ? P.list[main].length : 0;
		const off = towns.filter((t, i) => !hits[i].has(main) && !out.noWalk.includes(colour(t)) && !out.left.includes(colour(t)));
		if (!off.length) break;
		const goal = new Set(P.list[main]);
		// the start with the shortest way first, one per round (a join can serve the next)
		let best = null;
		for (const t of off) {
			const i = towns.indexOf(t);
			const src = new Set(t.vis);
			for (const k of hits[i]) for (const c of P.list[k]) src.add(c);
			let path = route([...src].filter(c => !hard[c]), goal, W, H, free, l, R, D4);
			let withScenery = false;
			if (!path) { path = route([...src].filter(c => !hard[c]), goal, W, H, freeDecor, l, R, D4); withScenery = !!path; }
			if (!path) {
				if (walkTo(src, goal)) out.left.push(colour(t)); else out.noWalk.push(colour(t));
				continue;
			}
			if (!best || path.length < best.path.length) best = { t, path, withScenery };
		}
		if (!best) break;
		for (const c of best.path) {
			if (R.has(c)) continue;
			if (decor[c]) {
				const gone = new Set(decorOf.get(c) || []);
				if (gone.size && d.clearScenery) {
					d.clearScenery(plan, l, W, H, d.blocked, { gone });
					out.cleared += gone.size;
					for (const [k, v] of [...decorOf]) {
						const keep = v.filter(o => !gone.has(o));
						if (keep.length === v.length) continue;
						if (keep.length) decorOf.set(k, keep); else { decorOf.delete(k); decor[k] = 0; }
					}
				}
			}
			R.add(c); out.tiles++;
		}
		out.joined++;
	}
	return out;
}

module.exports = { joinStartRoads, roadPieces, startTowns };
