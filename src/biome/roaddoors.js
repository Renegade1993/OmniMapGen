/**
 * roaddoors.js - a road that ends beside a door goes on to it (K, 2026-11-16, S281, "still seeing improper road terminations": a cobbled road
 * climbs to a stack that stands in front of a house and stops one or two tiles short of the door; mapsight called it proper because an approach tile
 * of the door lay in the 3x3 round the end).
 *
 * An end (a road tile with at most one road neighbour on its ring, or two on one side) that lies within three tiles of the entry tile of a town, mine,
 * monolith or gate, and is not on that entry tile or beside it on a side, is joined to it: the shortest four-way run over ground no building stands on
 * (pickups, stacks and scenery pieces that may go are crossed) to the entry tile or to a tile beside it the object is entered from. The run is
 * side to side, so no corner-only step is made. VMAPGEN_ROAD_DOORS=0 skips it. Returns { ends, joined, tiles, left }.
 */
'use strict';

const D4 = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const D8RING = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
const DEST = /^(town|randomTown|mine|abandonedMine|monolith|subterraneanGate)/;

function joinRoadEndsToDoors(plan, W, H, l, d) {
	const R = plan.roadCells, out = { ends: 0, joined: 0, tiles: 0, left: 0 };
	if (!R || !R.size) return out;
	// water lies on the surface only (generate.js reads the mask for level 0 alone)
	const N = W * H, water = l === 0 && plan.p && plan.p.water, om = plan.openMask;
	const walkers = new Set(), hard = new Uint8Array(N);
	for (let c = 0; c < N; c++) if ((water && water[c]) || (om && !om[c])) hard[c] = 1;
	const dests = [];
	for (const o of plan.objects || []) {
		if ((o.l || 0) !== l || !o.template || !o.template.mask) continue;
		const cells = d.blockingCells(o.template, o.x, o.y).filter(([x, y]) => x >= 0 && y >= 0 && x < W && y < H).map(([x, y]) => y * W + x);
		if (/^(resource|randomResource|treasureChest|campfire|randomArtifact|artifact|spellScroll|pandoraBox|randomMonster|monster)/.test(o.type)) { for (const c of cells) walkers.add(c); continue; }
		for (const c of cells) hard[c] = 1;
		if (DEST.test(o.type)) dests.push({ o, entries: d.visitableCells(o.template, o.x, o.y).filter(([x, y]) => x >= 0 && y >= 0 && x < W && y < H), dirs: d.allowedDirs(o.template) });
	}
	// the visiting tile of a destination belongs to its body in the blocking cells of some templates: a road may lie on it
	for (const t of dests) for (const [x, y] of t.entries) hard[y * W + x] = 0;
	const has = (x, y) => x >= 0 && y >= 0 && x < W && y < H && R.has(y * W + x);
	const isEnd = c => {
		const x = c % W, y = (c / W) | 0;
		const ring = D8RING.map(([dx, dy]) => (has(x + dx, y + dy) ? 1 : 0));
		const n = ring.reduce((a, b) => a + b, 0);
		let runs = 0; for (let k = 0; k < 8; k++) if (ring[k] && !ring[(k + 7) % 8]) runs++;
		return n <= 1 || (n === 2 && runs === 1);
	};
	for (const e of [...R]) {
		if (!R.has(e) || !isEnd(e)) continue;
		const ex = e % W, ey = (e / W) | 0;
		const near = dests.filter(t => t.entries.some(([x, y]) => Math.max(Math.abs(x - ex), Math.abs(y - ey)) <= 3));
		if (!near.length) continue;
		if (near.some(t => t.entries.some(([x, y]) => Math.abs(x - ex) + Math.abs(y - ey) <= 1))) continue;
		out.ends++;
		// the entry tile, and the tiles beside it on a side the object is entered from
		const goal = new Set();
		for (const t of near) for (const [x, y] of t.entries) {
			goal.add(y * W + x);
			for (const [dx, dy] of t.dirs || []) if (Math.abs(dx) + Math.abs(dy) === 1) { const u = x + dx, v = y + dy; if (u >= 0 && v >= 0 && u < W && v < H && !hard[v * W + u]) goal.add(v * W + u); }
		}
		goal.delete(e);
		const prev = new Map([[e, -1]]), q = [e], depth = new Map([[e, 0]]);
		let hit = -1;
		for (let h = 0; h < q.length && hit < 0; h++) {
			const c = q[h], cd = depth.get(c);
			if (cd >= 5) continue;
			const x = c % W, y = (c / W) | 0;
			for (const [dx, dy] of D4) {
				const u = x + dx, v = y + dy;
				if (u < 0 || v < 0 || u >= W || v >= H) continue;
				const m = v * W + u;
				if (prev.has(m) || hard[m]) continue;
				prev.set(m, c); depth.set(m, cd + 1); q.push(m);
				if (goal.has(m)) { hit = m; break; }
			}
		}
		if (hit < 0) { out.left++; continue; }
		for (let c = hit; c !== e && c >= 0; c = prev.get(c)) if (!R.has(c)) { R.add(c); out.tiles++; }
		out.joined++;
	}
	return out;
}

module.exports = { joinRoadEndsToDoors };
