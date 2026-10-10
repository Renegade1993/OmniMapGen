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

const { BIOME_DEFAULTS, BIOME_CLASS, rimModeOf, bordersOff } = require('./biomes');
const { engineGuard, creepTier, scaledLinkGuard } = require('./content');

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
	const water = p.water || null;

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
		// the doorway away from where a third zone meets this border: a doorway at a three-zone corner opens onto the
		// third zone as well, a passage the template never makes (mapsight zones, Coldshadow's Fantasy 2026-10-02: the
		// leaks left after the zone warp were all doorways at corners). VMAPGEN_DOOR_CLEAR=0 picks from the whole border.
		const clearOfThird = (c, R = 4) => {
			const x = c % W, y = (c / W) | 0;
			for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const z = zone[ny * W + nx];
				if (z >= 0 && z !== e.a && z !== e.b) return false;
			}
			return true;
		};
		// and on solid ground: 4+ tiles from the map's edge, with 12+ tiles of each zone within 3 (a doorway on a zone's
		// thin strip along the edge opened onto ground the edge rows then filled: one-level Coldshadow seed 3, zone 5)
		const solid = c => {
			const x = c % W, y = (c / W) | 0;
			if (x < 4 || y < 4 || x >= W - 4 || y >= H - 4) return false;
			let na = 0, nb = 0;
			for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { const z = zone[(y + dy) * W + x + dx]; if (z === e.a) na++; else if (z === e.b) nb++; }
			return na >= 12 && nb >= 12;
		};
		// and dry: no water beside the doorway, so both its sides are land a hero walks on (K's water settings, one-level
		// 144 2 players seed 11: a doorway's far side was a water inlet, the zone behind it was reached by nothing and swept empty)
		const wetNear = (c, R) => {
			const x = c % W, y = (c / W) | 0;
			for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < W && ny < H && water[ny * W + nx]) return true; }
			return false;
		};
		// 4 tiles clear if the border allows, else 3, else 2 (small zones on a crowded level), else anywhere
		let pool = [];
		if (water && p.zonePlan && kind !== 'portal' && process.env.VMAPGEN_DOOR_DRY !== '0')
			for (const wr of [1]) {
				for (const R of [4, 3, 2]) { pool = border.filter(c => clearOfThird(c, R) && solid(c) && !wetNear(c, wr)); if (pool.length) break; }
				if (pool.length) break;
			}
		if (process.env.VMAPGEN_DOOR_CLEAR !== '0' && !pool.length) {
			for (const R of [4, 3, 2]) { pool = border.filter(c => clearOfThird(c, R) && solid(c)); if (pool.length) break; }
			if (!pool.length) for (const R of [4, 3, 2]) { pool = border.filter(c => clearOfThird(c, R)); if (pool.length) break; }
		}
		const from = pool.length ? pool : border;
		const pivot = from[(rng() * from.length) | 0];
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
			if (Math.max(Math.abs(cx - px), Math.abs(cy - py)) <= width && !(water && p.zonePlan && kind !== 'portal' && wetNear(c, 1) && !wetNear(pivot, 1))) hole.add(c);
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
	const rim = rimModeOf(p) && !p.underground
		? addRimBand(zone, W, H, connections, edgeInfo, barriers, openings, water, !!p.zonePlan) : null;

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
const RIM_INWARD_MIN = Number(process.env.VMAPGEN_RIM_INWARD_MIN ?? 450);

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
function addRimBand(zone, W, H, connections, edgeInfo, barriers, openings, water = null, template = false) {
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
	// A zone under RIM_INWARD_MIN cells keeps only its line cells in the band, without the ring inside them: the
	// engine's band is four cells across a zone line, and on a small map with a big template (Coldshadow's Fantasy at
	// 36x36 two levels, about 100 cells a zone; the engine refuses it below 144) that band took most of each zone and
	// left 14-29% of the lowest zones standable (K: "top right biome is half untraversable", 2026-10-04). Template
	// maps only (p.zonePlan; a level's edge info can be empty when every link it has runs through the other level);
	// the free layout's zones keep the engine's band.
	const area = new Map();
	for (let c = 0; c < N; c++) if (zone[c] >= 0) area.set(zone[c], (area.get(zone[c]) || 0) + 1);
	const inward = z => !template || (area.get(z) || 0) >= RIM_INWARD_MIN;
	const band = new Uint8Array(N);
	for (let c = 0; c < N; c++) {
		if (!isBorder[c]) continue;
		band[c] = 1;
		if (!inward(zone[c])) continue;
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
// a template's zone links at the default Bottleneck guard share: open on a map of at most LINK_OPEN_BELOW of the template's own tiles, all guarded
// from LINK_KEEP_FROM up
const LINK_OPEN_BELOW = 0.05, LINK_KEEP_FROM = 0.2;
function placeChokeGuards(openings, zoneClasses, rng, params, edgeInfo, poolFor = null, forcedStrength = null) {
	const p = { ...BIOME_DEFAULTS, ...params };
	// guardBottlenecks 0: no monster in any doorway, the template's own
	// guarded links included (the player switched the context off)
	if (Number(p.guardBottlenecks) === 0) return [];
	// monsterStrength shifts every guard by whole creature levels, as the stock
	// tab's weak / strong setting does for the engine's own generator
	const shift = Math.round(p.monsterStrength || 0);
	const scaled = s => scaledLinkGuard(s, p);   // a map smaller than the template's smallest (plan.js linkGuardScale)
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
			// Bottleneck guard share on a template: its own links are 1x (the default share). Below it a guarded link, never a start's, loses
			// its guard with probability 1 - share / default, and none keeps one at 0; above it a link the template leaves free gains a guard
			// of the weakest strength a link of its two zones carries, at (share - default) / (1 - default). The link itself stays either way.
			// No random draw at the default, so a default map is as it was. VMAPGEN_CHOKE_SHARE=0 leaves the template's guards.
			// A map far below the template's own size keeps fewer of them at the default (K, 2026-10-09: "Zone links: yes, but should respond to
			// lever"): none at 5% of the template's tiles or less (36x36 Coldshadow is 3%, where half its stacks were link guards and 11.6% of
			// stacks crowded), all from 20% up, in between by the share; the slider scales that down to none at 0 and up to every link at 1.
			const dflt = BIOME_DEFAULTS.chokeGuardRatio, share = Number(p.chokeGuardRatio);
			const a = Number.isFinite(p.tplAreaShare) ? p.tplAreaShare : 1;
			const sizeKeep = Math.min(1, Math.max(0, (a - LINK_OPEN_BELOW) / (LINK_KEEP_FROM - LINK_OPEN_BELOW)));
			const s = Number.isFinite(share) ? share : dflt;
			const keep = s <= dflt ? sizeKeep * s / dflt : sizeKeep + (1 - sizeKeep) * (s - dflt) / (1 - dflt);
			const tplShare = process.env.VMAPGEN_CHOKE_SHARE !== '0' && (Number.isFinite(share) && share !== dflt || keep < 1);
			const atStart = zoneClasses[o.a] === BIOME_CLASS.PLAYER || zoneClasses[o.b] === BIOME_CLASS.PLAYER;
			let strength = info.guard;
			// the draws are the link's own (a hash of its zones and the seed): the rest of the map is laid as at the default, and a link kept at
			// one value of the slider is kept at every higher one, so each step changes the guards one way
			const own = k => { const v = Math.sin(o.a * 12.9898 + o.b * 78.233 + (Number(p.seed) || 1) * 0.0137 + k * 3.7) * 43758.5453; return v - Math.floor(v); };
			// a start's links keep their guards, except below the default on a map below the template's size, where the rest are open already:
			// there the slider thins them too, none at 0 (MapGen Dev, 2026-10-09: 0, 0.25 and 0.5 gave the same 47% of links on such a map)
			if (tplShare && atStart && info.guard && sizeKeep < 1 && s < dflt && own(1) >= s / dflt) continue;
			if (tplShare && !atStart) {
				if (info.guard && keep < 1 && own(0) >= keep) continue;
				if (!info.guard && share > dflt) {
					if (!(own(2) < (share - dflt) / (1 - dflt))) continue;
					let weakest = 0;
					for (const [k, e] of edgeInfo) { const ka = Math.floor(k / 100000), kb = k % 100000; if ((ka === o.a || kb === o.a || ka === o.b || kb === o.b) && e && e.guard > 0 && (!weakest || e.guard < weakest)) weakest = e.guard; }
					strength = weakest;
				}
			}
			if (!strength) continue;
			const g = engineGuard(scaled(strength), 1 + shift, rng, true, poolFor ? poolFor(o.a) : undefined);
			if (!g) continue;
			const mid = o.hole[(o.hole.length / 2) | 0];
			guards.push({ cell: mid, level: g.level, amount: g.amount, edge: [o.a, o.b],
				...(poolFor ? { creature: g.creature } : {}) });
			continue;
		}
		// a border a template level opened to keep itself in one piece: the
		// strongest link its zones have (planLevel), sized the same way
		if (forcedStrength) {
			const strength = forcedStrength(o.a, o.b);
			const g = strength > 0 ? engineGuard(scaled(strength), 1 + shift, rng, true, poolFor ? poolFor(o.a) : undefined) : null;
			if (!g) continue;
			const mid = o.hole[(o.hole.length / 2) | 0];
			guards.push({ cell: mid, level: g.level, amount: g.amount, edge: [o.a, o.b],
				...(poolFor ? { creature: g.creature } : {}) });
			continue;
		}
		// a doorway out of a start is always guarded: left open, a start ran on
		// into its neighbour's ground, another start's among them, with no fight
		// (a template's start links carry their guard too)
		const fromStart = zoneClasses[o.a] === BIOME_CLASS.PLAYER || zoneClasses[o.b] === BIOME_CLASS.PLAYER;
		if (rng() >= p.chokeGuardRatio && !fromStart) continue;
		const mid = o.hole[(o.hole.length / 2) | 0];
		// guard strength keys off the destination biome class, drawn the way
		// that zone's own monsters are (creepTier): the doorway guard comes
		// out of the zone's monster budget (content.js), so the map's level
		// mix stays the corpus's. The old bands (high-loot 5-7, town 4-5, the
		// rest 1-4) put the free layout's levels 3 and 4 at 1.23x the corpus
		// once the doorway guards stopped being lost.
		const level = creepTier(zoneClasses[o.b], rng, shift);
		guards.push({ cell: mid, level, edge: [o.a, o.b] });
	}
	return guards;
}

module.exports = { carveBoundaries, placeChokeGuards };
