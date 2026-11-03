/**
 * startwalk.js - after everything is placed, every start walks to the middle without entering another start's zone (the Reviewer,
 * 2026-11-03, finding 3: the links can promise a way the tiles do not keep; 4 of 130 starts on the 30-map sweep, a 5-player seed's green
 * boxed in its corner on three settings). Fights are allowed (a guard's tile is walked), pickups are walked over. A start that cannot is
 * given the cheapest way: scenery (objects with nothing to visit) standing on it is taken off, never a building, never another start's
 * zone, water or closed rock. One that has no such way is left and said. Free layouts only; VMAPGEN_START_REACH=0 off (VMAPGEN_START_WALK is the older start-ground pass in plan.js).
 */
'use strict';
const PICKUP = /^(resource|randomResource|treasureChest|campfire|randomArtifact|artifact|spellScroll|pandoraBox|seaChest|prison|flotsam|seaBarrel|jetsam|vialOfMana|shipwreckSurvivor)/;
const MONSTER = /^(monster|randomMonster)/;
/**
 * W, H; objects (this level's, changed in place: scenery on a repair taken out); zone[c]; closed(c) (water or rock); starts: [{x, y}] the
 * town positions; cellsOf(o) -> { block: [[x, y]...], visit: [[x, y]...] }. Returns { fixed, left, removed, middle }.
 */
function startWalk(W, H, objects, zone, closed, starts, cellsOf) {
	const N = W * H, N8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
	const building = new Uint8Array(N), scenery = new Int32Array(N).fill(-1), sceneryAll = new Map(), townCells = new Map(), ring = new Uint8Array(N);
	objects.forEach((o, k) => {
		if (o && o.template && o.template.mask && MONSTER.test(String(o.type))) { for (const [vx, vy] of cellsOf(o).visit) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const u = vx + dx, v = vy + dy; if (u >= 0 && v >= 0 && u < W && v < H) ring[v * W + u] = 1; } return; }
		if (!o || !o.template || !o.template.mask || PICKUP.test(String(o.type))) return;
		const { block, visit } = cellsOf(o);
		const isScenery = !visit.length;
		for (const [x, y] of [...block, ...visit]) {
			if (x < 0 || y < 0 || x >= W || y >= H) continue;
			const c = y * W + x;
			if (isScenery) { if (!building[c]) scenery[c] = k; if (!sceneryAll.has(c)) sceneryAll.set(c, []); sceneryAll.get(c).push(k); } else { building[c] = 1; scenery[c] = -1; }
		}
		if (/^(town|randomTown)$/.test(String(o.type))) townCells.set(`${o.x},${o.y}`, visit);
	});
	const walk = c => !closed(c) && !building[c] && scenery[c] < 0;
	if (process.env.VMAPGEN_START_REACH_PROBE) for (const p of process.env.VMAPGEN_START_REACH_PROBE.split(';')) { const [x, y] = p.split(',').map(Number), c = y * W + x; console.error(`[startwalk] probe ${x},${y}: zone ${zone[c]} closed ${closed(c)} building ${building[c]} scenery ${scenery[c] >= 0 ? objects[scenery[c]].type + '@' + objects[scenery[c]].x + ',' + objects[scenery[c]].y : '-'}; objects at all ${objects.length}`); }
	const startZones = new Map();
	const seeds = starts.map(s => {
		const v = townCells.get(`${s.x},${s.y}`) || [[s.x, s.y]];
		const out = [];
		for (const [x, y] of v) for (const [dx, dy] of N8) { const u = x + dx, w = y + dy; if (u >= 0 && w >= 0 && u < W && w < H && walk(w * W + u)) out.push(w * W + u); }
		const z = v.length ? zone[v[0][1] * W + v[0][0]] : -1;
		startZones.set(z, true);
		return { s, z, cells: out };
	});
	let mid = -1, md = Infinity;
	for (let c = 0; c < N; c++) { if (!walk(c) || startZones.has(zone[c]) || zone[c] < 0) continue; const d = ((c % W) + 0.5 - W / 2) ** 2 + (((c / W) | 0) + 0.5 - H / 2) ** 2; if (d < md) { md = d; mid = zone[c]; } }
	const res = { fixed: 0, left: 0, removed: 0, middle: mid };
	const dropped = new Set();
	if (mid < 0) return res;
	const flood = (from, ok) => { const seen = new Uint8Array(N), q = []; for (const c of from) if (!seen[c] && ok(c)) { seen[c] = 1; q.push(c); } for (let h = 0; h < q.length; h++) { const c = q[h], x = c % W, y = (c / W) | 0; for (const [dx, dy] of N8) { const u = x + dx, w = y + dy; if (u < 0 || w < 0 || u >= W || w >= H) continue; const n = w * W + u; if (!seen[n] && ok(n)) { seen[n] = 1; q.push(n); } } } return seen; };
	const midCells = []; for (let c = 0; c < N; c++) if (zone[c] === mid && walk(c)) midCells.push(c);
	for (const st of seeds) {
		const notOther = c => !(startZones.has(zone[c]) && zone[c] !== st.z);
		const mine = flood(st.cells, c => walk(c) && notOther(c));
		if (midCells.some(c => mine[c])) continue;
		// the middle's side: what walks to the middle without entering any start's zone but this one
		const theirs = flood(midCells, c => walk(c) && notOther(c));
		// cheapest way from mine to theirs: open ground 0, a scenery tile 1 (0-1 BFS), never a building, another start's zone or closed ground
		const dist = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1), dq = [];
		for (let c = 0; c < N; c++) if (mine[c]) { dist[c] = 0; dq.push(c); }
		let goal = -1;
		for (let h = 0; h < dq.length && goal < 0; h++) {
			// a simple label-correcting pass is enough at this size
			const c = dq[h];
			if (theirs[c]) { goal = c; break; }
			const x = c % W, y = (c / W) | 0;
			for (const [dx, dy] of N8) {
				const u = x + dx, w = y + dy; if (u < 0 || w < 0 || u >= W || w >= H) continue;
				const n = w * W + u;
				if (closed(n) || building[n] || !notOther(n)) continue;
				// into another zone only past a guard: a way opened through a zone wall with no stack in it handed a start loot it had to fight for
				// (the Reviewer, 11-03: s108p8 seed 13, green 1 zone -> 2 fight-free; s144p6 seed 12, red reached zone 28 and a major artifact)
				if (zone[n] !== zone[c] && !ring[n] && !ring[c]) continue;
				const nd = dist[c] + (scenery[n] >= 0 ? 1 : 0);
				if (nd < dist[n]) { dist[n] = nd; prev[n] = c; dq.push(n); }
			}
		}
		let posted = null;
		if (goal < 0) {
			// no way past a guard: the cheapest way through the walls, and a guard posted where it enters the next zone, a copy of that zone's
			// nearest stack (a start with no way out at all is worse than a fight: the lead, 11-03, s108p8 seed 13)
			dist.fill(Infinity); prev.fill(-1); const dq2 = [];
			for (let c = 0; c < N; c++) if (mine[c]) { dist[c] = 0; dq2.push(c); }
			for (let h = 0; h < dq2.length && goal < 0; h++) {
				const c = dq2[h]; if (theirs[c]) { goal = c; break; }
				const x = c % W, y = (c / W) | 0;
				for (const [dx, dy] of N8) { const u = x + dx, w = y + dy; if (u < 0 || w < 0 || u >= W || w >= H) continue; const n = w * W + u; if (closed(n) || building[n] || !notOther(n)) continue; const nd = dist[c] + (scenery[n] >= 0 ? 1 : 0); if (nd < dist[n]) { dist[n] = nd; prev[n] = c; dq2.push(n); } }
			}
			if (goal < 0) { res.left++; continue; }
			// the first tile of the way in a zone that is not the start's
			const way = []; for (let c = goal; c >= 0; c = prev[c]) way.unshift(c);
			const cross = way.find(c => !mine[c]);
			if (cross === undefined) { res.left++; continue; }
			const cx = cross % W, cy = (cross / W) | 0;
			let tpl = null, bd = Infinity;
			for (const o of objects) if (o && MONSTER.test(String(o.type)) && o.template) { const v = cellsOf(o).visit[0] || [o.x, o.y]; const d = Math.max(Math.abs(v[0] - cx), Math.abs(v[1] - cy)) + (zone[v[1] * W + v[0]] === zone[cross] ? 0 : 1000); if (d < bd) { bd = d; tpl = o; } }
			if (!tpl) { res.left++; continue; }
			const v0 = cellsOf(tpl).visit[0] || [tpl.x, tpl.y];
			posted = { ...JSON.parse(JSON.stringify(tpl)), x: tpl.x + (cx - v0[0]), y: tpl.y + (cy - v0[1]) };
			posted.instanceName = `${posted.type}_${posted.x}_${posted.y}_${posted.l || 0}`;
			delete posted.__startWalkDrop;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const u = cx + dx, w = cy + dy; if (u >= 0 && w >= 0 && u < W && w < H) ring[w * W + u] = 1; }
		}
		const drop = new Set();
		// every scenery object on a tile of the way: two may overlap one tile (s108p8 seed 13: the one left kept the way shut)
		for (let c = goal; c >= 0; c = prev[c]) if (scenery[c] >= 0) for (const k of sceneryAll.get(c) || []) drop.add(k);
		for (const k of drop) { const o = objects[k]; if (o) o.__startWalkDrop = true; }
		if (process.env.VMAPGEN_START_REACH_TRACE) console.error('[startwalk] start ' + st.s.x + ',' + st.s.y + ' zone ' + st.z + ' goal ' + (goal % W) + ',' + ((goal / W) | 0) + ' cost ' + dist[goal] + ' drop ' + [...drop].map(k => objects[k].type + '@' + objects[k].x + ',' + objects[k].y).join(' ') + ' seeds ' + st.cells.length);
		res.removed += drop.size; res.fixed++;
		if (posted) { (res.posted = res.posted || []).push(posted); }
		// the dropped scenery no longer stands for the next start
		for (const k of drop) dropped.add(k);
		for (const [c, ks] of sceneryAll) if (scenery[c] >= 0 && dropped.has(scenery[c])) { const left = ks.find(k => !dropped.has(k)); scenery[c] = left === undefined ? -1 : left; }
	}
	return res;
}
module.exports = { startWalk };
