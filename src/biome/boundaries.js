/**
 * boundaries.js - biome boundary carving.
 *
 * Every biome edge is either blocked (mountains/trees/decor fill the shared
 * border) or connected (portal object pair / open path, optionally roaded).
 * This module decides which border cells get barrier objects and which get
 * openings, per the interconnectivity parameters. The tile WFC then treats
 * barrier cells as impassable terrain (blocked) so AC-3 keeps the separation.
 */
'use strict';

const { BIOME_DEFAULTS, rimModeOf, bordersOff } = require('./biomes');
const { engineGuard } = require('./content');

/**
 * For each biome edge, pick opening cells from the shared border.
 * A path opening punches a contiguous hole of `width` cells in the barrier;
 * a portal opening places a monolith object pair (one on each side).
 *
 * Returns { barriers: Set<cellIdx>, openings: [{a,b,cells,kind}] }.
 */
function carveBoundaries(edges, connections, zone, W, H, params, rng, edgeInfo) {
	const p = { ...BIOME_DEFAULTS, ...params };
	const barriers = new Set();
	const openings = [];

	for (const e of edges) {
		const kind = connections.get(e.a * 100000 + e.b);
		const border = e.borderCells;
		if (!border.length) continue;

		if (kind === 'blocked') {
			for (const c of border) barriers.add(c);
			continue;
		}

		// Opening: pick a random pivot on the border, widen to `width`.
		// A template connection typed "wide" gets the broad cut it asks for.
		// VMAPGEN_GATES (queue 4f): corpus zone pairs open with a 1-2 cell
		// doorway, not the 2-4 the spread below draws; narrow the hole under
		// the flag so the wall pass, not the doorway, decides the border.
		const info = edgeInfo && edgeInfo.get(e.a * 100000 + e.b);
		const pivot = border[(rng() * border.length) | 0];
		const px = pivot % W, py = (pivot / W) | 0;
		const narrow = !!process.env.VMAPGEN_GATES;
		const width = kind === 'portal' ? 1
			: (info && info.wide ? 4
				: narrow ? 2 : 2 + ((rng() * 2) | 0));
		const hole = new Set();

		// walk the border around the pivot, collecting `width` cells
		hole.add(pivot);
		for (const c of border) {
			if (hole.size >= width) break;
			const cx = c % W, cy = (c / W) | 0;
			if (Math.max(Math.abs(cx - px), Math.abs(cy - py)) <= width) hole.add(c);
		}

		// The opening also needs cells INSIDE each biome adjacent to the hole
		// (a portal needs one per side; a path needs the gap cells left clear).
		const inner = { a: new Set(), b: new Set() };
		for (const c of hole) {
			const cx = c % W, cy = (c / W) | 0;
			for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
				const nx = cx + dx, ny = cy + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const zi = zone[ny * W + nx];
				if (zi === e.a) inner.a.add(ny * W + nx);
				else if (zi === e.b) inner.b.add(ny * W + nx);
			}
		}

		if (kind === 'portal') {
			// A portal link joins the two zones through a monolith pair and
			// nothing else, so the whole border stays wall. It used to keep the
			// pivot cell open, which made every portal link a one-cell doorway
			// as well (queue 27). The anchors start beside the pivot; the rim
			// pass moves them past the band.
			const aCell = [...inner.a][0] ?? border[0];
			const bCell = [...inner.b][0] ?? border[0];
			openings.push({ a: e.a, b: e.b, kind, hole: [],
				portalA: aCell, portalB: bCell, inner: [] });
			for (const c of border) barriers.add(c);
			continue;
		} else {
			// `inner` is the ground either side of the doorway. It is carried
			// out so the planner can hold it clear of content: once object art
			// stopped reserving ground, the fill packed tightly enough to build
			// across a two cell gap and wall a whole region off behind it.
			openings.push({ a: e.a, b: e.b, kind, hole: [...hole],
				inner: [...inner.a, ...inner.b] });
		}

		// Everything else on the border becomes barrier
		for (const c of border) if (!hole.has(c)) barriers.add(c);
	}

	// surface only: a carved level's rock is already its zone wall
	const water = p.water || null;
	const rim = rimModeOf(p) && !p.underground
		? addRimBand(zone, W, H, connections, edgeInfo, barriers, openings, water) : null;

	// Seal diagonal leaks: heroes move 8-way, so two diagonally-adjacent
	// barrier cells can be cut through at the corner when the other two
	// cells of that 2x2 sit in different zones. Block one of them.
	const holeCells = new Set();
	for (const o of openings) for (const c of o.hole) holeCells.add(c);
	let changed = true;
	while (changed) {
		changed = false;
		for (const c of barriers) {
			const cx = c % W, cy = (c / W) | 0;
			for (const [dx, dy] of [[1, 1], [1, -1]]) {
				const d = (cy + dy) * W + (cx + dx);
				if (cx + dx < 0 || cx + dx >= W || cy + dy < 0 || cy + dy >= H) continue;
				if (!barriers.has(d)) continue;
				// other two corners of the 2x2
				const o1 = cy * W + (cx + dx), o2 = (cy + dy) * W + cx;
				if (barriers.has(o1) || barriers.has(o2)) continue;
				if (holeCells.has(o1) || holeCells.has(o2)) continue;
				// a corner on the water is already closed
				if (water && (water[o1] || water[o2])) continue;
				const z1 = zone[o1], z2 = zone[o2];
				if (z1 !== z2 && z1 >= 0 && z2 >= 0) {
					// seal the corner: block the corner inside the smaller zone
					barriers.add(o1);
					changed = true;
				}
			}
		}
	}
	// borderSolidity under 0.25: no border scenery at all. Openings stay (they
	// carry roads and portal pairs); the zone line is only a terrain change.
	// Surface only: a carved level's zone walls are its rock.
	if (bordersOff(p) && !p.underground) barriers.clear();
	return { barriers, openings, rim };
}

const DIRS4 = [[0, -1], [1, 0], [0, 1], [-1, 0]];

/**
 * The engine's zone border (ConnectionsPlacer::createBorder,
 * ConnectionsPlacer.cpp:482-527): each zone blocks its own border tiles, those
 * with any of the 8 neighbours in another on-map zone, plus their direct
 * neighbours inside the zone. Both zones of a pair do it, so a zone line is a
 * solid band about four cells deep. Tiles a connection passage already uses
 * are skipped, and so is the shared border of a WIDE connection.
 *
 * Measured over the 71-map corpus: 98.9% of floor on a zone line is blocked
 * and 98.4% one cell in, against our 70.0% / 58.7% with the one-sided,
 * one-cell wall biomeEdges gives us.
 *
 * Every opening then gets a one-cell passage through the band on each side:
 * a shortest walk from its doorway cells, inside that zone, to the first
 * cell past the band. The passage is appended to `inner`, which the planner
 * reserves, so no content can plug it. VMAPGEN_RIM=0 turns this off (and
 * the per-zone interior field in plan.js with it).
 */
function addRimBand(zone, W, H, connections, edgeInfo, barriers, openings, water = null) {
	const N = W * H;
	const wide = new Set();
	if (edgeInfo)
		for (const [k, info] of edgeInfo) if (info && info.wide) wide.add(k);
	// water is no zone: a coast is not a zone line and gets no band
	const wet = c => !!(water && water[c]);
	const isBorder = new Uint8Array(N);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const c = y * W + x, z = zone[c];
			if (z < 0 || wet(c)) continue;
			for (let dy = -1; dy <= 1 && !isBorder[c]; dy++)
				for (let dx = -1; dx <= 1; dx++) {
					if (!dx && !dy) continue;
					const nx = x + dx, ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
					const nz = zone[ny * W + nx];
					if (nz === z || nz < 0 || wet(ny * W + nx)) continue;
					if (wide.has(Math.min(z, nz) * 100000 + Math.max(z, nz))) continue;
					isBorder[c] = 1;
					break;
				}
		}
	const band = new Uint8Array(N);
	for (let c = 0; c < N; c++) {
		if (!isBorder[c]) continue;
		band[c] = 1;
		const x = c % W, y = (c / W) | 0;
		for (const [dx, dy] of DIRS4) {
			const nx = x + dx, ny = y + dy;
			if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
			const n = ny * W + nx;
			if (zone[n] === zone[c] && !wet(n)) band[n] = 1;
		}
	}

	// Passages. The engine cuts ONE path per connection through the border
	// (selfSideDirectConnection -> zone.connectPath) and corpus doorways are
	// 1-3 cells wide, 1.2 on average. Our doorway was the whole 2-3 cell hole
	// plus every cell beside it held open on both sides, which traced as the
	// band's biggest leak (74-130 open cells per 72x72). A path opening now
	// keeps one crossing pair on the zone line and a one-cell walk from each
	// side of it, inside that zone, to the first cell past the band.
	const passage = new Uint8Array(N);
	const walkOut = (from, side) => {
		const prev = new Int32Array(N).fill(-2);
		const q = [from];
		prev[from] = -1;
		let end = -1;
		for (let h = 0; h < q.length; h++) {
			const c = q[h];
			if (!band[c]) { end = c; break; }
			const x = c % W, y = (c / W) | 0;
			for (const [dx, dy] of DIRS4) {
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const n = ny * W + nx;
				if (prev[n] !== -2 || zone[n] !== side || wet(n)) continue;
				prev[n] = c; q.push(n);
			}
		}
		const cut = [];
		for (let c = end; c >= 0; c = prev[c]) cut.push(c);
		return cut.length ? cut : [from];
	};
	for (const o of openings) {
		if (o.kind === 'portal') {
			// Each monolith stands on the first open cell past the band on its
			// own side, and the band stays solid, so the pair is the only way
			// across (queue 27). It used to stand at the zone line with a
			// reserved passage cut to it, where nothing could ever place it.
			for (const [key, side] of [['portalA', o.a], ['portalB', o.b]]) {
				const cell = o[key];
				if (cell >= 0 && cell < N && zone[cell] === side) o[key] = walkOut(cell, side)[0];
			}
			o.inner = [];
			continue;
		}
		// one crossing pair: a hole cell and its neighbour across the line
		let pair = null;
		for (const h of o.hole) {
			const x = h % W, y = (h / W) | 0;
			for (const [dx, dy] of DIRS4) {
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const n = ny * W + nx;
				if (zone[n] !== zone[h] && (zone[n] === o.a || zone[n] === o.b)) { pair = [h, n]; break; }
			}
			if (pair) break;
		}
		if (!pair) continue;          // keep the old doorway as it was
		const [h, n] = pair;
		const cut = [...walkOut(h, zone[h]), ...walkOut(n, zone[n])];
		for (const c of cut) passage[c] = 1;
		// the rest of the old hole goes back to the wall
		for (const c of o.hole) if (!passage[c]) barriers.add(c);
		o.hole = [h, n];
		o.inner = cut.filter(c => c !== h && c !== n);
	}
	const keepOpen = new Set();
	for (const o of openings) for (const c of o.hole) keepOpen.add(c);
	let added = 0;
	for (let c = 0; c < N; c++)
		if (band[c] && !passage[c] && !keepOpen.has(c) && !barriers.has(c)) {
			barriers.add(c);
			added++;
		}
	console.error(`[gen] rim band: +${added} border cells`);
	return { band, passage };
}

/**
 * Chokepoint guards: for each path opening, maybe place a monster object on
 * the middle hole cell per chokeGuardRatio. Returns cells to receive a
 * randomMonster object (level scaled by biome class of the FAR side).
 *
 * poolFor(zone), when given, is the creatures a template zone allows
 * (content.js zoneGuardPool): a template link's guard is picked from its
 * first zone's, the one that places it in the engine (ConnectionsPlacer
 * asks its own zone's ObjectManager::chooseGuard), and comes back with its
 * creature for generate.js to write.
 */
function placeChokeGuards(openings, zoneClasses, rng, params, edgeInfo, poolFor = null) {
	const p = { ...BIOME_DEFAULTS, ...params };
	// guardBottlenecks 0: no monster in any doorway, the template's own
	// guarded links included (the player switched the context off)
	if (Number(p.guardBottlenecks) === 0) return [];
	// monsterStrength shifts every guard by whole creature levels, as the stock
	// tab's weak / strong setting does for the engine's own generator
	const shift = Math.round(p.monsterStrength || 0);
	const lv = v => Math.max(1, Math.min(7, v + shift));
	const guards = [];
	for (const o of openings) {
		if (o.kind === 'portal') continue;
		const info = edgeInfo && edgeInfo.get(o.a * 100000 + o.b);
		if (info) {
			// template-authored edge: the declared guard strength is the order
			// (0 means the connection is deliberately unguarded), sized the way
			// the engine sizes a zone-link guard (ObjectManager::chooseGuard,
			// map strength only; our Normal is the engine's weak, see
			// content.js engineGuard). Too weak a link stays unguarded there.
			if (!info.guard) continue;
			const g = engineGuard(info.guard, 1 + shift, rng, true, poolFor ? poolFor(o.a) : undefined);
			if (!g) continue;
			const mid = o.hole[(o.hole.length / 2) | 0];
			guards.push({ cell: mid, level: g.level, amount: g.amount, edge: [o.a, o.b],
				...(poolFor ? { creature: g.creature } : {}) });
			continue;
		}
		if (rng() >= p.chokeGuardRatio) continue;
		const mid = o.hole[(o.hole.length / 2) | 0];
		// guard strength keys off the destination biome class
		const cls = zoneClasses[o.b];
		const level = lv(cls === 'highLoot' ? 5 + ((rng() * 3) | 0)
			: cls === 'town' ? 4 + ((rng() * 2) | 0)
			: 1 + ((rng() * 4) | 0));
		guards.push({ cell: mid, level, edge: [o.a, o.b] });
	}
	return guards;
}

module.exports = { carveBoundaries, placeChokeGuards };
