'use strict';
/**
 * emptyrock.js - underground floor nothing uses becomes rock, as the engine's does.
 *
 * The engine's underground is rock but for its paths and the ground its objects stand on (RockPlacer turns every tile
 * no object, guard or path took into rock). Ours carves tunnels and clearings first and fills them after, and wherever
 * the fill ran out of things to put the floor stayed bare: halls of hundreds of tiles with nothing in them (K's own
 * look at Coldshadow's Fantasy seed 1, zone 8, 2026-10-02: "this looks like absolute trash"). No count or average saw
 * it. So, on the final layout of each carved level:
 *
 *   1. kept: every tile within EMPTY_ROCK_R (2) steps of an object other than scenery, of the tiles it is visited
 *      from, or of a road; scenery touching kept ground keeps all its tiles;
 *   2. every other open tile becomes rock, its scenery removed with it;
 *   3. but no two things a hero could walk between before are parted: the kept pieces that held a way in are joined
 *      again through the fewest removed tiles (0-1 breadth first over the old floor);
 *   4. the new rock is shaped for the terrain art (cavefit.js), never closing a kept tile.
 *
 * VMAPGEN_EMPTY_ROCK=0 skips it; VMAPGEN_EMPTY_ROCK_R sets the reach.
 */
const { fitCave } = require('./cavefit');

const N8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

function emptyToRock(plan, W, H, l, blocked, OCCUPIED, REMOVABLE, blockingCells, visitableCells, isScenery, checker) {
	const open = plan.openMask;
	if (!open || process.env.VMAPGEN_EMPTY_ROCK === '0') return null;
	const R = Number(process.env.VMAPGEN_EMPTY_ROCK_R || 2);
	const N = W * H, base = l * N;
	const inb = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
	const objs = plan.objects.filter(o => (o.l || 0) === l && o.template && o.template.mask);
	const cellsOf = (o, f) => f(o.template, o.x, o.y).filter(([x, y]) => inb(x, y)).map(([x, y]) => y * W + x);
	// hard: a tile an object that stays blocks
	const hard = new Uint8Array(N);
	for (const o of objs) if (!REMOVABLE.has(o.type)) for (const c of cellsOf(o, blockingCells)) hard[c] = 1;
	const walk = c => open[c] && !hard[c];
	// 1. seeds and the kept ground round them
	const keep = new Uint8Array(N), fixed = new Uint8Array(N), terminal = new Uint8Array(N);
	const dist = new Int16Array(N).fill(-1), q = [];
	const seed = c => { if (dist[c] < 0) { dist[c] = 0; q.push(c); } fixed[c] = 1; };
	for (const o of objs) {
		if (isScenery(o)) continue;
		for (const c of cellsOf(o, blockingCells)) seed(c);
		for (const c of cellsOf(o, visitableCells)) {
			seed(c);
			const x = c % W, y = (c / W) | 0;
			for (const [dx, dy] of N8) if (inb(x + dx, y + dy)) { const m = (y + dy) * W + x + dx; if (open[m]) { seed(m); if (walk(m)) terminal[m] = 1; } }
		}
	}
	for (const c of plan.roadCells || []) { seed(c); if (walk(c)) terminal[c] = 1; }
	for (let h = 0; h < q.length; h++) {
		const c = q[h];
		if (dist[c] >= R) continue;
		const x = c % W, y = (c / W) | 0;
		for (const [dx, dy] of N8) {
			if (!inb(x + dx, y + dy)) continue;
			const m = (y + dy) * W + x + dx;
			if (open[m] && dist[m] < 0) { dist[m] = dist[c] + 1; q.push(m); }
		}
	}
	for (let c = 0; c < N; c++) if (open[c] && dist[c] >= 0) keep[c] = 1;
	const scenery = objs.filter(isScenery);
	for (const o of scenery) { const cs = cellsOf(o, blockingCells); if (cs.some(c => keep[c])) for (const c of cs) if (open[c]) keep[c] = 1; }
	// 3. ways kept: within each piece of the old floor, the kept pieces holding a terminal are joined again
	const label = pred => {
		const comp = new Int32Array(N).fill(-1);
		let n = 0;
		for (let s = 0; s < N; s++) {
			if (comp[s] >= 0 || !pred(s)) continue;
			const st = [s]; comp[s] = n;
			while (st.length) {
				const c = st.pop(), x = c % W, y = (c / W) | 0;
				for (const [dx, dy] of N8) { if (!inb(x + dx, y + dy)) continue; const m = (y + dy) * W + x + dx; if (comp[m] < 0 && pred(m)) { comp[m] = n; st.push(m); } }
			}
			n++;
		}
		return comp;
	};
	const old = label(walk);
	let restored = 0;
	for (let guard = 0; guard < 400; guard++) {
		const now = label(c => walk(c) && keep[c]);
		// per old piece, the kept pieces with a terminal
		const groups = new Map();
		for (let c = 0; c < N; c++) {
			if (!terminal[c] || now[c] < 0) continue;
			if (!groups.has(old[c])) groups.set(old[c], new Set());
			groups.get(old[c]).add(now[c]);
		}
		const split = [...groups.values()].find(s => s.size > 1);
		if (!split) break;
		const pieces = [...split], start = pieces[0], others = new Set(pieces.slice(1));
		// 0-1 breadth first from the start piece over the old floor; kept tiles cost 0, removed ones 1
		const cost = new Int32Array(N).fill(-1), prev = new Int32Array(N).fill(-1), dq = [];
		let head = 0;
		for (let c = 0; c < N; c++) if (now[c] === start) { cost[c] = 0; dq.push(c); }
		let hit = -1;
		const order = [];
		while (head < dq.length || order.length) {
			const c = order.length ? order.pop() : dq[head++];
			if (others.has(now[c])) { hit = c; break; }
			const x = c % W, y = (c / W) | 0;
			for (const [dx, dy] of N8) {
				if (!inb(x + dx, y + dy)) continue;
				const m = (y + dy) * W + x + dx;
				if (!walk(m) || old[m] !== old[c]) continue;
				const w = keep[m] ? 0 : 1, nc = cost[c] + w;
				if (cost[m] >= 0 && cost[m] <= nc) continue;
				cost[m] = nc; prev[m] = c;
				if (w === 0) order.push(m); else dq.push(m);
			}
		}
		if (hit < 0) break;
		for (let k = hit; k >= 0; k = prev[k]) if (!keep[k]) { keep[k] = 1; restored++; }
	}
	// 2b. a zone keeps at least its type's floor share (the engine with K's mods, Coldshadow's Fantasy underground: start
	// zones 0.48 of their tiles open, treasure 0.42, junctions 0.25): an underground start whose objects stood in its
	// tunnels kept only the ground beside them, 0.29 of its tiles, and its loot stood packed (K, 2026-10-03: "the bottom
	// right corners are still getting stacked to the gills with loot"). The floor nearest the kept ground is kept first.
	// The shares are of open ground no object blocks, as measured. Floor cut off from all kept ground stays rock: nothing
	// stands there and no hero reaches it. VMAPGEN_EMPTY_ROCK_SHARE overrides, e.g. "start:0.48,treasure:0.42,junction:0.25"
	// (=off: no floor share); VMAPGEN_EMPTY_ROCK_TRACE prints each zone's accounting and what was turned.
	const shareSpec = process.env.VMAPGEN_EMPTY_ROCK_SHARE;
	const zl = plan.zone, tz = plan.p && plan.p.zonePlan && plan.p.zonePlan.perLevel ? plan.p.zonePlan.perLevel[l] : null;
	let shareKept = 0;
	if (shareSpec !== 'off' && zl && tz && tz.length) {
		const share = { start: 0.48, treasure: 0.42, junction: 0.25 };
		if (shareSpec) for (const kv of shareSpec.split(',')) { const [k, v] = kv.split(':'); if (k && Number(v) >= 0) share[k.trim()] = Number(v); }
		const typeOf = zi => { const t = (tz[zi] && tz[zi].type) || ''; return /start/i.test(t) ? 'start' : t; };
		const tiles = new Map(), floor = new Map();
		for (let c = 0; c < N; c++) { const z = zl[c]; if (z === undefined || z < 0) continue; tiles.set(z, (tiles.get(z) || 0) + 1); if (open[c] && keep[c] && !(blocked[base + c] & OCCUPIED)) floor.set(z, (floor.get(z) || 0) + 1); }
		// distance from the kept ground over the floor that would go
		const d2 = new Int32Array(N).fill(-1), q2 = [];
		for (let c = 0; c < N; c++) if (open[c] && keep[c]) { d2[c] = 0; q2.push(c); }
		for (let h = 0; h < q2.length; h++) {
			const c = q2[h], x = c % W, y = (c / W) | 0;
			for (const [dx, dy] of N8) { if (!inb(x + dx, y + dy)) continue; const m = (y + dy) * W + x + dx; if (open[m] && d2[m] < 0) { d2[m] = d2[c] + 1; q2.push(m); } }
		}
		const spare = new Map();
		for (let c = 0; c < N; c++) if (open[c] && !keep[c] && d2[c] >= 0) { const z = zl[c]; if (!spare.has(z)) spare.set(z, []); spare.get(z).push(c); }
		for (const [z, list] of spare) {
			const want = Math.round((share[typeOf(z)] ?? 0) * (tiles.get(z) || 0)) - (floor.get(z) || 0);
			if (process.env.VMAPGEN_EMPTY_ROCK_TRACE) console.error(`[emptyrock] level ${l} zone ${z} ${typeOf(z)}: tiles ${tiles.get(z)}, kept floor ${floor.get(z) || 0}, spare ${list.length}, want ${want}`);
			if (want <= 0) continue;
			list.sort((a2, b2) => d2[a2] - d2[b2]);
			for (let i = 0; i < Math.min(want, list.length); i++) { keep[list[i]] = 1; shareKept++; }
		}
	}
	// 2. the rest becomes rock, its scenery with it
	let turned = 0;
	const gone = new Set();
	for (const o of scenery) if (cellsOf(o, blockingCells).every(c => !keep[c])) gone.add(o);
	plan.objects = plan.objects.filter(o => !gone.has(o));
	const turnedAt = process.env.VMAPGEN_EMPTY_ROCK_TRACE ? new Uint8Array(N) : null;
	for (let c = 0; c < N; c++) {
		if (!open[c] || keep[c]) continue;
		open[c] = 0;
		if (turnedAt) turnedAt[c] = 1;
		blocked[base + c] |= OCCUPIED;
		turned++;
	}
	if (plan.roadCells) for (const c of plan.roadCells) if (!open[c]) plan.roadCells.delete(c);
	// 4. the new rock shaped for the terrain art; nothing kept closes
	const before = open.slice();
	const fit = checker && plan.zone ? fitCave(open, plan.zone, W, H, checker, 12, fixed, open.sealed || null) : null;
	if (fit) for (let c = 0; c < N; c++) {
		if (open[c] === before[c]) continue;
		if (open[c]) blocked[base + c] &= ~OCCUPIED;   // opened: bare rock before, nothing stands there
		else blocked[base + c] |= OCCUPIED;
	}
	if (process.env.VMAPGEN_EMPTY_ROCK_TRACE) { const m = new Map(); for (let c = 0; c < N; c++) if (plan.zone && turnedAt && turnedAt[c]) m.set(plan.zone[c], (m.get(plan.zone[c]) || 0) + 1); console.error(`[emptyrock] level ${l}: turned by zone ${JSON.stringify([...m])}`); }
	return { turned, restored, scenery: gone.size, fit };
}

module.exports = { emptyToRock };
