/**
 * water.js - surface water (queue item 25d, phase W1).
 *
 * The engine's own generator makes water out of template WATER zones:
 * WaterAdopter paints them, WaterProxy adds shipyards, boats and water
 * treasure, WaterRoutes lays ship lanes between land zones. This generator's
 * zones are land, so water is laid down first, as a mask over the surface,
 * from two levers: waterCoverage (the share of the map that is water) and
 * waterShape (where it goes, named after the classic RTS map types). The
 * planner then treats water the way it treats underground rock: occupied
 * ground every later pass routes around, and zones partition the land alone.
 *
 * W1 builds the shapes that leave all land in one piece, so nobody needs a
 * boat. Islands and Archipelago need boats, shipyards and ship lanes (W2/W3).
 *
 * The mask is also shaped for the terrain art. Every water cell sits in at
 * least one 2x2 block of water: the pattern table draws a shore on a water
 * tile from its eight neighbours, and a one-cell channel or a lone pond cell
 * is an arrangement it has no sprite for. The engine's draw operation reshapes
 * such tiles; doing it here keeps the smoothing pass off the coast.
 */
'use strict';

const { valueNoise } = require('./biomes');
const { xorshift } = require('../wfc/solver');

/** Stored as an index in settings (the UI writes numbers). */
const WATER_SHAPES = [
	{ id: 'lakes', label: 'Lakes',
		help: 'a few inland lakes, with land all along the map edge.' },
	{ id: 'coastal', label: 'Coastal', relocate: true,
		help: 'a sea along one side of the map. Starts on that side move inland.' },
	{ id: 'continental', label: 'Continental', relocate: true,
		help: 'sea all around the map edge and one land mass in the middle. Starts move inland onto it.' },
	{ id: 'mediterranean', label: 'Mediterranean',
		help: 'a sea in the middle of the map with land all around it.' },
	{ id: 'highland', label: 'Highland',
		help: 'many small lakes scattered through the land.' },
	// Island shapes (W3): the land is in pieces, boats are the way across
	{ id: 'islands', label: 'Islands', islands: true, perStart: 0,
		help: 'every player on an island of their own, with open sea between. Each player starts with a shipyard and a boat on the shore, and boats are the only way across. The straits take water of their own, so a small amount comes out higher.' },
	{ id: 'archipelago', label: 'Archipelago', islands: true, perStart: 2, inset: 0.14, startWeight: 1.6,
		help: 'many islands, every player on one of their own and the rest neutral, waiting for whoever sails there first. Needs about a quarter of a small map under water.' },
];

const MAX_COVERAGE = 0.6;
// random islands: the share of the map their discs fill before the water lever grows the coasts, and the open sea held between two islands
const ISLAND_PACK = 0.32, ISLAND_EVEN = 1.2;
// the strait grows with the room each island has: 4 tiles on a 72x72 with 6 islands, 6 on a 108 or 144 with 4 to 6, 4 on a 108 Archipelago
const straitWidth = (W, H, K) => Math.max(3, Math.min(6, Math.round(Math.sqrt(W * H / Math.max(1, K)) / 8)));
// Land kept around a start town (Chebyshev radius from its anchor): the town,
// the reserved ground before its gate and room for the starter mines.
const START_CLEAR = 7;

/** Whether a Water layout value (an index into WATER_SHAPES) is one of the island layouts. */
const isleShape = v => v !== null && v !== undefined && !!(WATER_SHAPES[Math.round(Number(v) || 0)] || {}).islands;

function shapeOf(p) {
	let i = Math.round(Number(p && p.waterShape) || 0);
	if (i >= WATER_SHAPES.length) i = 0;      // Random and Template (7, 8) are settled before the plan (stockChoices applyWaterContent)
	return WATER_SHAPES[Math.max(0, i)];
}

/**
 * Per-cell water score for a shape: the mask takes the highest-scoring cells.
 * Smooth noise bends every coastline; the shape term decides where the water
 * gathers.
 */
/**
 * Island sites: every start, plus neutral islands for Archipelago (perStart
 * per player, spread by best candidate). Each site is an island; the sea
 * runs where two sites' Voronoi cells meet.
 */
function islandSites(W, H, shape, starts, rng) {
	const sites = starts.map(s => ({ x: s.x, y: s.y, start: true }));
	const extra = Math.round((shape.perStart || 0) * Math.max(1, starts.length));
	// The strait between a start's island and a neutral one runs where the
	// weighted distances meet, w / (1 + w) of the way out from the start. It
	// has to clear the start's dry ground, or that ground squeezes it to a
	// one-cell channel no shore sprite fits; a small map gets fewer islands.
	const w = shape.startWeight || 1.35;
	const minFromStart = (START_CLEAR + 3) * (1 + w) / w;
	for (let k = 0; k < extra; k++) {
		let best = null, bd = -1;
		for (let t = 0; t < 24; t++) {
			const x = 4 + (rng() * (W - 8)) | 0, y = 4 + (rng() * (H - 8)) | 0;
			let d = Infinity;
			for (const q of sites) d = Math.min(d, Math.hypot(q.x - x, q.y - y));
			if (starts.some(q => Math.hypot(q.x - x, q.y - y) < minFromStart)) continue;
			// two neutral islands closer than this leave islets the cleanup
			// sinks, and the map floods
			if (d < 12) continue;
			if (d > bd) { bd = d; best = { x, y, start: false }; }
		}
		if (best) sites.push(best);
	}
	return sites;
}

/**
 * Random islands (P2; K, 2026-09-30: "We need actual, random islands... WAYYYY MORE VARIABILITY", islands that are
 * "two blob masses that are near mirrors of each other"). The old layout was a Voronoi diagram of the players' starts
 * (islandSites): four starts in four corners made four equal cells and a water cross, every roll. Here the islands
 * come from the seed alone:
 *   - a count (the players' and a random number of neutral ones), each with its own area share (log-normal, so one is
 *     big and one small) and a bounding radius from it;
 *   - positions by dart throwing, no two islands closer than their radii and a gap, the larger first;
 *   - a shape of its own: two to four lobes along a random axis with lateral jitter, the union bent by a warp noise;
 *   - each player moved onto an island of its own (the nearest free one to where the layout had put them) at a random
 *     spot with room for the start's dry ground.
 * Returns { field, starts }: field is high on land and falls off outside, or null when the map is too small to hold
 * the players' islands with their dry ground (the caller keeps the Voronoi layout there).
 */
function randomIslands(W, H, shape, starts, rng, noise, cover) {
	const nP = Math.max(1, starts.length);
	const minR = START_CLEAR + 4;                     // a player's island must hold the start's dry ground and a shore
	// the discs fill a packing share of the map, and the water lever's own selection then grows every coast to the amount asked: discs thrown
	// at random fill little more than half a square, and sized to the whole land (55% at 45% water) the start islands found no room on most
	// maps (72x72 4 players 12 of 12, 108 7 of 12, 144 8 players 12 of 12; 2026-10-09)
	const land = Math.min(1 - cover, ISLAND_PACK) * W * H;
	const gap = 4;
	const bound = f => Math.sqrt(f / Math.PI);
	// area shares: players around 1, neutrals smaller, both spread
	const shares = [];
	// no start on this level (every player underground): the islands are all neutral, four to seven of a start island's size, not one start-sized
	// island and a neutral one (two land masses on a 144x144 for eight players, 2026-10-09)
	const noStarts = !starts.length;
	const neutral = noStarts ? 4 + Math.floor(rng() * 4) : Math.round((shape.perStart || 0) * nP) + (shape.perStart ? 0 : Math.floor(rng() * (nP + 1)));
	const logn = sd => Math.exp((rng() + rng() + rng() - 1.5) * 2 * sd);
	// every player's island the same share (a start on a big island against one on a small one was 3.3 to 1 on 144x144); the neutrals vary
	if (!noStarts) for (let i = 0; i < nP; i++) shares.push({ start: true, w: 1 });
	for (let i = 0; i < neutral; i++) shares.push({ start: false, w: noStarts ? logn(0.35) : 0.35 * logn(0.5) });
	const tot = shares.reduce((a, q) => a + q.w, 0);
	for (const q of shares) q.R = Math.max(q.start ? minR : 6, bound(land * q.w / tot));
	// the players' islands must fit at all
	if (shares.filter(q => q.start).reduce((a, q) => a + Math.PI * q.R * q.R, 0) > 0.8 * W * H) return null;
	// the players' islands first (they must fit), then the neutrals, each larger first
	shares.sort((a, b) => (b.start - a.start) || (b.R - a.R));
	// a round that leaves a player without room starts again with every island smaller, and from the third round with half the neutrals
	let placed = null;
	for (let round = 0; round < 5 && !placed; round++) {
		placed = [];
		const sc = Math.pow(0.88, round);
		const list = round < 2 ? shares : shares.filter((q, i) => q.start || i % 2 === 0);
		for (const q of list) {
			let ok = null;
			for (let shrink = 0; shrink < 6 && !ok; shrink++) {
				const R = Math.max(q.start ? minR : 6, q.R * sc) * Math.pow(0.9, shrink);
				if (q.start && R < minR) break;
				for (let t = 0; t < 200; t++) {
					const x = R + 2 + rng() * (W - 2 * R - 4), y = R + 2 + rng() * (H - 2 * R - 4);
					if (!(x > 0) || !(y > 0)) continue;
					if (placed.every(o => Math.hypot(o.x - x, o.y - y) >= (o.R + R) * 1.15 + gap)) { ok = { x, y, R, start: q.start }; break; }
				}
			}
			if (ok) placed.push(ok);
			else if (q.start) {
				if (process.env.VMAPGEN_ISLAND_TRACE) console.error("[isl] no room for start island R", q.R.toFixed(1), "placed", placed.length, "round", round);
				placed = null;
				break;
			}
		}
	}
	if (!placed) return null;
	// each island's lobes
	for (const isl of placed) {
		// a player's island keeps three lobes of one size (its turn and bend still random), so the start islands come out near one area;
		// a neutral one takes two to four of any size
		const n = isl.start ? 3 : 2 + Math.floor(rng() * 3), ang = rng() * Math.PI;
		isl.lobes = [];
		for (let k = 0; k < n; k++) {
			const t = n === 1 ? 0 : -0.55 + 1.1 * (k / (n - 1));
			const lat = (rng() - 0.5) * 0.5;
			const r = isl.start ? 0.65 : 0.5 + rng() * 0.3;
			isl.lobes.push({ x: isl.x + isl.R * (t * Math.cos(ang) - lat * Math.sin(ang)) * 0.8,
				y: isl.y + isl.R * (t * Math.sin(ang) + lat * Math.cos(ang)) * 0.8, r: isl.R * r });
		}
	}
	const warp = 3 + 0.06 * (W + H) / 2;
	const wx = noise.a, wy = noise.b;
	// signed distance to each island's shore (negative inside), the two nearest islands per cell: the land score is
	// the nearest, and where the two are within a few cells the strait between them is held open (straitWidth: a crack of one or two
	// tiles left the islands nearly touching, 2026-10-09)
	const field = new Float64Array(W * H), strait = new Uint8Array(W * H), sw = straitWidth(W, H, placed.length);
	const scale = Math.sqrt(W * H / placed.length) / 2;
	const K = placed.length, G = new Float32Array(W * H * K);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const px = x + (wx(x, y) - 0.5) * 2 * warp, py = y + (wy(x, y) - 0.5) * 2 * warp;
			placed.forEach((isl, i) => {
				let g = Infinity;
				for (const l of isl.lobes) { const d = Math.hypot(px - l.x, py - l.y) - l.r; if (d < g) g = d; }
				G[(y * W + x) * K + i] = g;
			});
		}
	// the field and the straits with island i's coast moved out by bias[i] tiles (in, when negative)
	const draw = (bias = null) => {
		for (let c = 0; c < W * H; c++) {
			let g1 = Infinity, g2 = Infinity;
			for (let i = 0; i < K; i++) {
				const g = G[c * K + i] - (bias ? bias[i] : 0);
				if (g < g1) { g2 = g1; g1 = g; } else if (g < g2) g2 = g;
			}
			field[c] = -g1 / scale;
			strait[c] = g2 - g1 <= sw ? 1 : 0;
		}
		return { field, strait };
	};
	draw();
	// the players: each to the nearest free island, at a random inner spot with room for the start's ground
	const free = placed.map((isl, i) => ({ isl, i })), moved = [];
	const order = starts.map((q, i) => i).sort(() => rng() - 0.5);
	const out = new Array(starts.length), startIsland = new Array(starts.length);
	for (const si of order) {
		const q = starts[si];
		free.sort((a, b) => Math.hypot(a.isl.x - q.x, a.isl.y - q.y) - Math.hypot(b.isl.x - q.x, b.isl.y - q.y));
		const pick = free.findIndex(f => f.isl.start);
		const took = free.splice(pick >= 0 ? pick : 0, 1)[0], isl = took.isl;
		startIsland[si] = took.i;
		// a spot on one of the island's lobes, near its centre: the dry ground a start needs is forced round it
		// afterwards (buildWaterPlan's forcedAround), which the island's own coast then bulges to meet
		const m = START_CLEAR + 1;
		let bx = -1, by = -1;
		for (let t = 0; t < 200 && bx < 0; t++) {
			const l = isl.lobes[Math.floor(rng() * isl.lobes.length)];
			const x = Math.round(l.x + (rng() - 0.5) * 0.6 * l.r), y = Math.round(l.y + (rng() - 0.5) * 0.6 * l.r);
			if (x < m || y < m || x >= W - m || y >= H - m) continue;
			if (field[y * W + x] >= 0.25 * l.r / scale) { bx = x; by = y; }
		}
		if (bx < 0) { if (process.env.VMAPGEN_ISLAND_TRACE) console.error('[isl] no start spot on island R', isl.R.toFixed(1)); return null; }
		out[si] = { ...q, x: bx, y: by, moved: true };
	}
	return { field, strait, starts: out, count: placed.length, startIsland, draw };
}

function scoreField(W, H, shape, rng, starts = [], cover = 0.4) {
	const coarseCell = shape.id === 'highland' ? Math.max(4, Math.round((W + H) / 14))
		: Math.max(6, Math.round((W + H) / 7));
	const coarse = valueNoise((rng() * 1e9) | 0, coarseCell);
	const fine = valueNoise((rng() * 1e9) | 0, Math.max(3, Math.round((W + H) / 30)));
	const side = (rng() * 4) | 0;                    // coastal: which edge
	const stretch = 0.55 + rng() * 0.45;             // mediterranean: aspect
	const alongX = rng() < 0.5;
	// Mediterranean: the sea varies from seed to seed, an oval the rare case (K, 2026-10-12, a six-player open Mediterranean: "strange
	// ovular central ocean....i don't think this should be outlawed, but it should definitely be the exception not the rule ... i always
	// prefer variability and some real variation range"). One seed in six keeps the plain oval; the others move the sea's centre up to a
	// tenth of the map off the middle and give its shore two or three lobes (bays and peninsulas) of their own size, with a rougher coast.
	// Drawn only for this layout, so no other layout's rolls move; a template's crossroads (a start marked hub: Jebus Cross) keeps the
	// sea round the middle, the island it needs. VMAPGEN_MED_VARY=0 keeps the oval.
	const med = { ox: 0, oy: 0, lobes: [], rough: 0.35, ring: process.env.VMAPGEN_MED_VARY !== '0' && !starts.some(q => q && q.hub) };
	if (shape.id === 'mediterranean' && process.env.VMAPGEN_MED_VARY !== '0' && !starts.some(q => q && q.hub) && rng() >= 1 / 6) {
		med.ox = (rng() - 0.5) * 0.2; med.oy = (rng() - 0.5) * 0.2;
		const n = 2 + (rng() < 0.5 ? 1 : 0);
		for (let i = 0; i < n; i++) med.lobes.push([2 + ((rng() * 4) | 0), 0.08 + rng() * 0.22, rng() * Math.PI * 2]);
		med.rough = 0.35 + rng() * 0.3;
	}
	const s = new Float64Array(W * H);
	const edgeBand = 0.1 * Math.min(W, H) + 3;
	// the Islands and Archipelago layouts (K, 2026-10-08: "the static/deterministic corner growth algorithm for map generation which i hate");
	// the Voronoi of the starts below is left only for a map too small to hold the players' islands
	if (shape.islands) {
		const warpNoise = { a: valueNoise((rng() * 1e9) | 0, Math.max(5, Math.round((W + H) / 12))), b: valueNoise((rng() * 1e9) | 0, Math.max(5, Math.round((W + H) / 12))) };
		const isl = randomIslands(W, H, shape, starts, rng, warpNoise, cover);
		if (isl) {
			const channel = new Uint8Array(W * H);
			const fill = ({ field, strait }) => {
				for (let c = 0; c < W * H; c++) {
					const x = c % W, y = (c / W) | 0;
					const edge = Math.max(0, 1 - Math.min(x, y, W - 1 - x, H - 1 - y) / edgeBand);
					s[c] = -field[c] + 0.5 * edge + 0.12 * (fine(x, y) - 0.5);
					// the strait between any two islands, and open sea well clear of every island
					channel[c] = strait[c] || field[c] < -1.2 ? 1 : 0;
				}
			};
			fill(isl);
			s.recoast = bias => fill(isl.draw(bias));
			s.startIsland = isl.startIsland;
			s.islandCount = isl.count;
			s.channel = channel;
			s.starts = isl.starts;
			return s;
		}
	}
	if (shape.islands) {
		// water where two islands' cells meet (d2 - d1 small) and along the
		// map edge; the noise bends the channels
		const sites = islandSites(W, H, shape, starts, rng);
		const scale = Math.sqrt(W * H / Math.max(1, sites.length));
		const channel = new Uint8Array(W * H);
		for (let y = 0; y < H; y++)
			for (let x = 0; x < W; x++) {
				let d1 = Infinity, d2 = Infinity, i1 = -1, i2 = -1;
				for (let i = 0; i < sites.length; i++) {
					// a player's island draws more ground than a neutral one
					const d = Math.hypot(sites[i].x - x, sites[i].y - y) / (sites[i].start ? (shape.startWeight || 1.35) : 1);
					if (d < d1) { d2 = d1; i2 = i1; d1 = d; i1 = i; } else if (d < d2) { d2 = d; i2 = i; }
				}
				const n = 0.65 * coarse(x, y) + 0.35 * fine(x, y);
				const edge = Math.max(0, 1 - Math.min(x, y, W - 1 - x, H - 1 - y) / edgeBand);
				s[y * W + x] = -(d2 - d1) / scale + 0.5 * edge + 0.35 * (n - 0.5);
				// the strait between any two islands is always open sea
				if (i2 >= 0 && d2 - d1 <= 2.5) channel[y * W + x] = 1;
			}
		s.channel = channel;
		return s;
	}
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const n = 0.65 * coarse(x, y) + 0.35 * fine(x, y);
			const a = Math.abs(2 * x / (W - 1) - 1), b = Math.abs(2 * y / (H - 1) - 1);
			let v;
			switch (shape.id) {
				case 'coastal': {
					const t = side === 0 ? y / (H - 1) : side === 1 ? 1 - x / (W - 1)
						: side === 2 ? 1 - y / (H - 1) : x / (W - 1);
					v = (1 - t) + 0.3 * (n - 0.5);
					break;
				}
				case 'continental':
					v = Math.pow(a ** 4 + b ** 4, 0.25) + 0.3 * (n - 0.5);
					break;
				case 'mediterranean': {
					const ex = alongX ? 1 : stretch, ey = alongX ? stretch : 1;
					const dx = (2 * x / (W - 1) - 1 - med.ox) / ex, dy = (2 * y / (H - 1) - 1 - med.oy) / ey, an = Math.atan2(dy, dx);
					const lobe = Math.max(0.4, 1 + med.lobes.reduce((m, [k, amp, ph]) => m + amp * Math.sin(k * an + ph), 0));
					// and a ring of land to the map's edges, whatever the lobes do (the oval reached the top and bottom edges on 3 of 12 seeds)
					const de = Math.min(x, y, W - 1 - x, H - 1 - y), on = med.ring;
					v = -Math.hypot(dx, dy) / lobe + med.rough * (n - 0.5) - (on ? 0.4 * Math.max(0, 1 - de / edgeBand) + (de < 4 ? 5 : 0) : 0);
					break;
				}
				default: {                           // lakes, highland
					const d = Math.min(x, y, W - 1 - x, H - 1 - y);
					v = n - 0.6 * Math.max(0, 1 - d / edgeBand);
				}
			}
			s[y * W + x] = v;
		}
	return s;
}

/** The `k` best-scoring cells that are not forced land. */
function selectTop(s, k, forced) {
	const order = [];
	for (let c = 0; c < s.length; c++) if (!forced || !forced[c]) order.push(c);
	order.sort((p, q) => s[q] - s[p] || p - q);
	const m = new Uint8Array(s.length);
	for (let i = 0; i < Math.min(k, order.length); i++) m[order[i]] = 1;
	return m;
}

const DIRS4 = [[0, -1], [1, 0], [0, 1], [-1, 0]];

/** 4-connected components of cells where m[c] === val. */
function components(m, W, H, val) {
	const id = new Int32Array(W * H).fill(-1);
	const sizes = [];
	for (let c0 = 0; c0 < W * H; c0++) {
		if (m[c0] !== val || id[c0] >= 0) continue;
		const k = sizes.length;
		let n = 0;
		const q = [c0];
		id[c0] = k;
		for (let h = 0; h < q.length; h++) {
			const c = q[h];
			n++;
			const x = c % W, y = (c / W) | 0;
			for (const [dx, dy] of DIRS4) {
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const d = ny * W + nx;
				if (m[d] === val && id[d] < 0) { id[d] = k; q.push(d); }
			}
		}
		sizes.push(n);
	}
	return { id, sizes };
}

/** A water cell the shore art can draw: part of some 2x2 block of water. */
function inWaterBlock(m, W, H, x, y) {
	for (const [ox, oy] of [[0, 0], [-1, 0], [0, -1], [-1, -1]]) {
		const x0 = x + ox, y0 = y + oy;
		if (x0 < 0 || y0 < 0 || x0 + 1 >= W || y0 + 1 >= H) continue;
		if (m[y0 * W + x0] && m[y0 * W + x0 + 1] && m[(y0 + 1) * W + x0] && m[(y0 + 1) * W + x0 + 1])
			return true;
	}
	return false;
}

/**
 * Clean a raw mask in place: majority smoothing, thin water out, tiny ponds
 * out, then one land mass. Land pieces cut off from the main mass become
 * water when small and are bridged to it when large or when a start stands
 * on them, except a piece holding an `apart` cell, which stays an island.
 * `forced` cells are always land.
 */
function settle(m, W, H, forced, startCells, opts = {}) {
	const N = W * H;
	// `wet` cells stay water whatever the rules below say (the straits between
	// two players' islands); `connect` false keeps islands apart (no bridges)
	const wet = opts.wet || null, connect = opts.connect !== false;
	// `apart`: cells of ground the sea may leave on an island of its own, with no bridge to the
	// main mass (the template's crossroads, when boats sail there: buildWaterPlan)
	const apart = opts.apart || [];
	const keepWet = c => !!(wet && wet[c]);
	for (let round = 0; round < 2; round++) {
		const next = m.slice();
		for (let y = 0; y < H; y++)
			for (let x = 0; x < W; x++) {
				const c = y * W + x;
				if (forced[c] || keepWet(c)) continue;
				let wetN = 0;
				for (let dy = -1; dy <= 1; dy++)
					for (let dx = -1; dx <= 1; dx++) {
						if (!dx && !dy) continue;
						const nx = x + dx, ny = y + dy;
						// off the map counts as more of the same, so a sea that
						// meets the edge is not eaten from it
						wetN += (nx < 0 || ny < 0 || nx >= W || ny >= H) ? m[c] : m[ny * W + nx];
					}
				if (wetN >= 5) next[c] = 1;
				else if (wetN <= 3) next[c] = 0;
			}
		m.set(next);
	}
	for (let pass = 0; pass < 12; pass++) {
		let changed = false;
		// thin water: a cell in no 2x2 block of water becomes land
		for (let it = 0; it < 30; it++) {
			let n = 0;
			for (let y = 0; y < H; y++)
				for (let x = 0; x < W; x++)
					if (m[y * W + x] && !keepWet(y * W + x) && !inWaterBlock(m, W, H, x, y)) { m[y * W + x] = 0; n++; }
			if (!n) break;
			changed = true;
		}
		// thin land: a spur or strip one cell wide between water on both sides
		// has no shore sprite either, and water takes it
		for (let it = 0; it < 30; it++) {
			let n = 0;
			for (let y = 0; y < H; y++)
				for (let x = 0; x < W; x++) {
					const c = y * W + x;
					if (m[c] || forced[c]) continue;
					const wetAt = (dx, dy) => {
						const nx = x + dx, ny = y + dy;
						return nx >= 0 && ny >= 0 && nx < W && ny < H && m[ny * W + nx] === 1;
					};
					if ((wetAt(-1, 0) && wetAt(1, 0)) || (wetAt(0, -1) && wetAt(0, 1))) { m[c] = 1; n++; }
				}
			if (!n) break;
			changed = true;
		}
		// a pinched diagonal channel: water with land on two opposite corners
		// and water on all four sides has no sprite; the channel widens (or,
		// against a start's forced ground, the pinch closes)
		for (let y = 1; y < H - 1; y++)
			for (let x = 1; x < W - 1; x++) {
				const c = y * W + x;
				if (!m[c] || !m[c - 1] || !m[c + 1] || !m[c - W] || !m[c + W]) continue;
				for (const [a, b] of [[c - W + 1, c + W - 1], [c - W - 1, c + W + 1]]) {
					if (m[a] || m[b]) continue;
					if (forced[a] || forced[b]) { if (!keepWet(c)) m[c] = 0; }
					else { m[a] = 1; m[b] = 1; }
					changed = true;
					break;
				}
			}
		// ponds too small to read as water
		const wc = components(m, W, H, 1);
		for (let c = 0; c < N; c++)
			if (m[c] && !keepWet(c) && wc.sizes[wc.id[c]] < 12) { m[c] = 0; changed = true; }
		// one land mass
		const lc = components(m, W, H, 0);
		if (lc.sizes.length > 1) {
			let main = -1;
			for (const c of startCells) if (lc.id[c] >= 0) { main = lc.id[c]; break; }
			if (main < 0) main = lc.sizes.indexOf(Math.max(...lc.sizes));
			const withStart = new Set(startCells.map(c => lc.id[c]).filter(k => k >= 0));
			const held = new Set(apart.map(c => lc.id[c]).filter(k => k >= 0));
			// on an island plan a zone's own island stays down to 30 tiles: at 1% of the map (207 tiles on 144x144) the whole island of a zone of 272
			// to 364 cells went under, an empty zone (Voronoi zones at 144, Archipelago). VMAPGEN_ISLET_ZONE=0: 1% as before
			const islet = !connect && process.env.VMAPGEN_ISLET_ZONE !== '0' ? 30 : Math.max(30, Math.round(0.01 * N));
			for (let k = 0; k < lc.sizes.length; k++) {
				if (k === main) continue;
				// a held island stays whatever its size: a dragon junction's under 1% of the map was drowned here (K's 1583610596, 2026-10-14)
				if (!withStart.has(k) && !held.has(k) && lc.sizes[k] < islet) {
					for (let c = 0; c < N; c++) if (lc.id[c] === k && !forced[c]) m[c] = 1;
					changed = true;
				} else if (connect && !held.has(k)) {
					bridge(m, W, H, lc.id, k, main);
					changed = true;
				}
				// islands: a start's island and any neutral island big enough stay,
				// and so does an `apart` island (its way in is a boat)
			}
		}
		if (!changed) break;
	}
}

/** Shortest walk over water from land piece `k` to piece `main`, made land
 * three cells wide. */
function bridge(m, W, H, id, k, main) {
	const N = W * H;
	const prev = new Int32Array(N).fill(-2);
	const q = [];
	for (let c = 0; c < N; c++) if (id[c] === k) { prev[c] = -1; q.push(c); }
	let end = -1;
	for (let h = 0; h < q.length && end < 0; h++) {
		const c = q[h];
		const x = c % W, y = (c / W) | 0;
		for (const [dx, dy] of DIRS4) {
			const nx = x + dx, ny = y + dy;
			if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
			const d = ny * W + nx;
			if (prev[d] !== -2) continue;
			prev[d] = c;
			if (id[d] === main) { end = c; break; }
			if (m[d]) q.push(d);
		}
	}
	for (let c = end; c >= 0 && prev[c] !== -1; c = prev[c]) {
		const x = c % W, y = (c / W) | 0;
		m[c] = 0;
		for (const [dx, dy] of DIRS4) {
			const nx = x + dx, ny = y + dy;
			if (nx >= 0 && ny >= 0 && nx < W && ny < H) m[ny * W + nx] = 0;
		}
	}
}

function forcedAround(starts, W, H, r) {
	const f = new Uint8Array(W * H);
	for (const s of starts)
		for (let dy = -r; dy <= r; dy++)
			for (let dx = -r; dx <= r; dx++) {
				const x = s.x + dx, y = s.y + dy;
				if (x >= 0 && y >= 0 && x < W && y < H) f[y * W + x] = 1;
			}
	return f;
}

/**
 * Move each start that would stand in or beside the water to the nearest spot
 * with START_CLEAR cells of dry ground around it, keeping clear of the starts
 * already placed. Straight inland from a coast, diagonally in from a corner a
 * Continental sea took. A start that finds no spot stays put and the water
 * yields to it instead.
 */
function relocateStarts(raw, starts, W, H) {
	const clear = (x, y) => {
		const r = START_CLEAR + 1;
		if (x - r < 0 || y - r < 0 || x + r >= W || y + r >= H) {
			// the map edge is fine; only water counts against a spot
			for (let dy = -r; dy <= r; dy++)
				for (let dx = -r; dx <= r; dx++) {
					const nx = x + dx, ny = y + dy;
					if (nx >= 0 && ny >= 0 && nx < W && ny < H && raw[ny * W + nx]) return false;
				}
			return true;
		}
		for (let dy = -r; dy <= r; dy++)
			for (let dx = -r; dx <= r; dx++) if (raw[(y + dy) * W + x + dx]) return false;
		return true;
	};
	// candidate offsets nearest first, ties in a fixed order; built on first use
	let offsets = null;
	const nearestFirst = () => {
		if (offsets) return offsets;
		const R = Math.max(W, H);
		offsets = [];
		for (let dy = -R; dy <= R; dy++)
			for (let dx = -R; dx <= R; dx++) if (dx || dy) offsets.push([dx, dy, dx * dx + dy * dy]);
		offsets.sort((a, b) => a[2] - b[2] || a[1] - b[1] || a[0] - b[0]);
		return offsets;
	};
	const placed = [];
	const apart = (x, y) => placed.every(q =>
		Math.max(Math.abs(q.x - x), Math.abs(q.y - y)) >= 2 * START_CLEAR);
	return starts.map(s => {
		let out = { ...s };
		if (!clear(s.x, s.y)) {
			const margin = START_CLEAR;
			for (const [dx, dy] of nearestFirst()) {
				const x = s.x + dx, y = s.y + dy;
				if (x < margin || y < margin || x >= W - margin || y >= H - margin) continue;
				if (clear(x, y) && apart(x, y)) { out = { ...s, x, y, moved: true }; break; }
			}
		}
		placed.push(out);
		return out;
	});
}

/**
 * Build the surface water plan.
 *   starts: [{x, y}] town anchors on the surface.
 * Returns null when there is no water, else
 *   { mask: Uint8Array (1 = water), starts: [{x, y, moved?, hub?}], shape, coverage, hubCells }.
 * A start marked `hub` is the template's crossroads: kept dry like a start, and left on an
 * island of its own, with no bridge, when boats sail there (waterAccess above None);
 * hubCells are the cells of those left apart.
 * Deterministic in (W, H, starts, seed, levers); it draws from its own stream
 * so the planner's stream is untouched.
 */
/**
 * Last resort against the real pattern table. `check(mask)` returns the cells
 * no shore sprite fits (the caller renders the mask as water against a land
 * terrain through the engine's own patterns). Each bad cell tries flipping
 * itself or one of its eight neighbours and keeps the first flip that lowers
 * the count without cutting the land in two. settle() leaves about one mask
 * in 160 with a bad pair, where its thin-land and thin-water rules undo each
 * other at the root of a one-cell strip.
 */
function repairShore(m, W, H, forced, check, wet = null, hold = false) {
	// `check` is a maskcheck.js checker ({full, around}) or a plain function
	// returning the bad cells of a whole mask
	const full = typeof check === 'function' ? mm => check(mm) : mm => check.full(mm, W, H);
	// a flip changes which sprites fit only within two cells of it, so the
	// windowed count before and after is the whole difference
	const around = typeof check === 'function' ? null : (x, y) => check.around(m, W, H, x, y, 2);
	const count = a => a.reduce((s, v) => s + v, 0);
	const pieces = () => components(m, W, H, 0).sizes.length;
	let bad = full(m), total = count(bad);
	for (let round = 0; round < 8 && total; round++) {
		let improved = false;
		for (let c = 0; c < W * H && total; c++) {
			if (!bad[c]) continue;
			const x = c % W, y = (c / W) | 0;
			const before = pieces();
			let done = false;
			for (let dy = -1; dy <= 1 && !done; dy++)
				for (let dx = -1; dx <= 1 && !done; dx++) {
					const nx = x + dx, ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
					const d = ny * W + nx;
					if (forced[d] && !m[d]) continue;          // a start's ground stays dry
					// a strait cell may go (the dead end of a strait the start's
					// dry ground cut short), as long as no two islands join
					const was = around ? around(nx, ny) : 0;
					m[d] ^= 1;
					const gain = around ? was - around(nx, ny) : total - count(full(m));
					// island maps keep their island count exactly: no flip joins two
					// (and a crossroads island held apart stays apart)
					const after = pieces();
					if (gain > 0 && (wet || hold ? after === before : after <= before)) {
						total -= gain; done = true; improved = true;
					} else m[d] ^= 1;
				}
		}
		if (!improved) break;
		bad = full(m);
		total = count(bad);
	}
	return total;
}

function buildWaterPlan(W, H, p, starts, seed, check = null) {
	const cover = Math.min(MAX_COVERAGE, Math.max(0, Number(p && p.waterCoverage) || 0));
	if (!(cover > 0)) return null;
	const shape = shapeOf(p);
	const rng = xorshift(((seed || 1) ^ 0x3a7e11) >>> 0);
	rng(); rng();
	// Archipelago: a start pinned near a corner gets an island the map edge
	// cuts in half, so starts move in from the edge first, and the islands
	// are laid out around where they end up
	let base = starts;
	if (shape.inset) {
		const m = Math.round(shape.inset * Math.min(W, H));
		base = starts.map(q => {
			const x = Math.min(Math.max(q.x, m), W - 1 - m), y = Math.min(Math.max(q.y, m), H - 1 - m);
			return x !== q.x || y !== q.y ? { ...q, x, y, moved: true } : { ...q };
		});
	}
	const N = W * H;
	// random islands are laid again until every player has an island of its own and the largest start island is at most ISLAND_EVEN times
	// the smallest (one start on a big island against one on a small one was 3.3 to 1 on 144x144); the most even of ten is kept
	let best = null;
	for (let attempt = 0; attempt < 10; attempt++) {
		let r = layWater(W, H, p, shape, rng, base, cover, N);
		// not islands at all, or a random layout with no room for the players (the Voronoi of the starts stands in): kept only when no try lays islands
		if (!shape.islands) { best = r; break; }
		if (!r.s.starts) { if (!best) best = { ...r, even: Infinity, fallback: true }; continue; }
		// the start islands' own areas, the islands each start stands on
		const judge = q => {
			const pieces = components(q.mask, W, H, 0);
			const homes = q.startCells.map(c => pieces.id[c]);
			const sizes = homes.map(h => (h >= 0 ? pieces.sizes[h] : 0));
			q.sizes = sizes;
			q.even = new Set(homes).size === homes.length && Math.min(...sizes) > 0 ? Math.max(...sizes) / Math.min(...sizes) : Infinity;
		};
		judge(r);
		// an island by the map edge or crowded by its neighbours keeps less land than one in open sea: each start island's coast moves out or
		// in by the land it lacks or has over the start islands' mean, spread round its shore, until they are within ISLAND_EVEN
		if (r.s.recoast && Number.isFinite(r.even)) {
			const bias = new Array(r.s.islandCount).fill(0);
			for (let round = 0; round < 6 && r.even > ISLAND_EVEN; round++) {
				const mean = r.sizes.reduce((a, v) => a + v, 0) / r.sizes.length;
				r.sizes.forEach((a, k) => { bias[r.s.startIsland[k]] += 0.9 * (mean - a) / (2 * Math.sqrt(Math.PI * Math.max(1, a))); });
				r.s.recoast(bias);
				const q = layWater(W, H, p, shape, rng, base, cover, N, r.s);
				judge(q);
				if (!(q.even < r.even)) break;
				r = q;
			}
		}
		if (!best || r.even < best.even) best = r;
		if (best.even <= ISLAND_EVEN) break;
	}
	if (process.env.VMAPGEN_ISLAND_TRACE && best.even) console.error('[isl] start islands largest/smallest', best.even.toFixed(2));
	const { mask, moved, forced, startCells, apart, wet } = best;
	let got = best.got;
	const unfit = check ? repairShore(mask, W, H, forced, check, wet, apart.length > 0) : 0;
	got = mask.reduce((a, v) => a + v, 0);
	// the crossroads cells the sea did leave on land of their own, for the planner
	const pieces = components(mask, W, H, 0);
	const mainPiece = startCells.length ? pieces.id[startCells[0]] : -1;
	const hubCells = apart.filter(c => pieces.id[c] >= 0 && pieces.id[c] !== mainPiece);
	return { mask, starts: moved, shape: shape.id, coverage: got / N, unfit,
		islands: !!shape.islands, hubCells };
}

/** One water plan for buildWaterPlan: the score field, the starts it moves, and the mask cleaned to the amount asked */
function layWater(W, H, p, shape, rng, base, cover, N, given = null) {
	const s = given || scoreField(W, H, shape, rng, base, cover);
	// island shapes: the straits between players stay water, islands stay apart
	const wet = shape.islands ? s.channel : null;
	const target = Math.round(cover * N);
	// A sea that covers a start's corner (judged by where the water would go
	// with no start in the way) moves the start inland: Coastal and
	// Continental. Lakes simply yield to a start's forced dry ground instead:
	// scattered lakes leave no fully dry square nearby, and a start sent
	// across the map to find one wrecks the layout.
	const moved = s.starts ? s.starts.map(q => ({ ...q }))
		: shape.relocate ? relocateStarts(selectTop(s, target, null), base, W, H) : base.map(q => ({ ...q }));
	const forced = forcedAround(moved, W, H, START_CLEAR);
	const startCells = moved.map(q => q.y * W + q.x);
	// The template's crossroads (a start the caller marks `hub`) may be left an island of its own,
	// with no land bridge, when boats can sail there: a harbour setting above None. K, 2026-09-29,
	// Jebus Cross with Mediterranean water: "I NEVER ASKED FOR A ROAD PATH OVER THE WATER. IT'S
	// MEDITERANEAN, AND THEY CAN GET THERE BY BOAT." With None nobody could get there, so it stays
	// bridged. waterHubBoats 0 (the generator's own fallback) bridges it whatever the setting.
	const access = Math.round(Number.isFinite(p && p.waterAccess) ? p.waterAccess : 2);
	const apart = !shape.islands && access >= 1 && !(p && p.waterHubBoats === 0)
		? moved.filter(q => q.hub).map(q => q.y * W + q.x) : [];
	// Cleaning loses water (thin arms, ponds) and bridging loses more, so
	// aim the selection a little high and correct it from the measured result.
	let k = target, mask = null, got = 0;
	for (let it = 0; it < 4; it++) {
		mask = selectTop(s, k, forced);
		if (wet) for (let c = 0; c < N; c++) if (wet[c] && !forced[c]) mask[c] = 1;
		settle(mask, W, H, forced, startCells, { wet, connect: !shape.islands, apart });
		got = mask.reduce((a, v) => a + v, 0);
		if (!got || Math.abs(got - target) <= Math.max(8, 0.01 * N)) break;
		k = Math.max(1, Math.round(k * target / got));
	}
	return { s, mask, moved, forced, startCells, apart, wet, got };
}

/**
 * Zones on land only. The partition is a warped Voronoi over every cell, so a
 * zone can come out as pieces on both sides of a lake. Each zone keeps the
 * piece its seed stands on; every other piece goes to the neighbour it shares
 * the most border with. Water then takes the zone of the nearest land, so a
 * coast is never a zone line and the zone of every cell stays a real index.
 * `apart`: the cells of a crossroads island the sea left on land of its own
 * (buildWaterPlan's hubCells). Its zone keeps the island, and keeps its own
 * biggest other piece too: the seed stands on the island, so by the rule above
 * the whole shore ring round the sea would go to the players' zones, and the
 * crossroads would be left an island no template link reaches.
 */
function settleZonesOnLand(zone, seeds, W, H, water, apart = null) {
	const N = W * H;
	const core = new Uint8Array(N);
	const byZone = new Map();
	// flood each zone's own land from its seed
	for (let i = 0; i < seeds.length; i++) {
		const s0 = seeds[i].y * W + seeds[i].x;
		if (water[s0]) continue;
		// a seed owns its own tile: the warp could hand it to a neighbour, and then the zone had no core on its island and the island's land
		// stayed labelled for zones across the water (random islands, 72x72 Archipelago seed 3, 2026-10-09)
		zone[s0] = i;
		const q = [s0];
		core[s0] = 1;
		for (let h = 0; h < q.length; h++) {
			const c = q[h];
			const x = c % W, y = (c / W) | 0;
			for (const [dx, dy] of DIRS4) {
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const d = ny * W + nx;
				if (!core[d] && !water[d] && zone[d] === i) { core[d] = 1; q.push(d); }
			}
		}
		byZone.set(i, q.length);
	}
	for (const a of apart || []) {
		const i = zone[a];
		if (water[a] || i < 0 || i >= seeds.length) continue;
		// the zone's ground round the island, then its biggest piece that is not core yet
		const grow = c0 => {
			const q = [c0];
			core[c0] = 1;
			for (let h = 0; h < q.length; h++) {
				const c = q[h];
				const x = c % W, y = (c / W) | 0;
				for (const [dx, dy] of DIRS4) {
					const nx = x + dx, ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
					const d = ny * W + nx;
					if (!core[d] && !water[d] && zone[d] === i) { core[d] = 1; q.push(d); }
				}
			}
		};
		// the seed is on the island only when the flood above already took it; a seed on the
		// mainland leaves the island the one piece to add
		if (!core[a]) { grow(a); continue; }
		const mark = new Uint8Array(N);
		let big = null;
		for (let c0 = 0; c0 < N; c0++) {
			if (water[c0] || core[c0] || mark[c0] || zone[c0] !== i) continue;
			const q = [c0];
			mark[c0] = 1;
			for (let h = 0; h < q.length; h++) {
				const c = q[h];
				const x = c % W, y = (c / W) | 0;
				for (const [dx, dy] of DIRS4) {
					const nx = x + dx, ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
					const d = ny * W + nx;
					if (!mark[d] && !core[d] && !water[d] && zone[d] === i) { mark[d] = 1; q.push(d); }
				}
			}
			if (!big || q.length > big.size) big = { size: q.length, cell: c0 };
		}
		if (big) grow(big.cell);
	}
	// stray land joins a neighbouring zone's core, growing inward
	let moved = 0;
	for (let it = 0; it < N; it++) {
		let n = 0;
		for (let c = 0; c < N; c++) {
			if (water[c] || core[c]) continue;
			const x = c % W, y = (c / W) | 0;
			const votes = new Map();
			for (const [dx, dy] of DIRS4) {
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const d = ny * W + nx;
				if (core[d]) votes.set(zone[d], (votes.get(zone[d]) || 0) + 1);
			}
			if (!votes.size) continue;
			let best = -1, bv = 0;
			for (const [z, v] of votes) if (v > bv || (v === bv && z < best)) { best = z; bv = v; }
			zone[c] = best;
			core[c] = 1;
			n++;
		}
		moved += n;
		if (!n) break;
	}
	// water takes the zone of the nearest land
	const q = [];
	const seen = new Uint8Array(N);
	for (let c = 0; c < N; c++) if (!water[c]) { seen[c] = 1; q.push(c); }
	for (let h = 0; h < q.length; h++) {
		const c = q[h];
		const x = c % W, y = (c / W) | 0;
		for (const [dx, dy] of DIRS4) {
			const nx = x + dx, ny = y + dy;
			if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
			const d = ny * W + nx;
			if (!seen[d]) { seen[d] = 1; zone[d] = zone[c]; q.push(d); }
		}
	}
	return moved;
}

/**
 * The engine's way of making water on a template map, over our zone layout (MapGen Dev, 2026-10-02, branch
 * water-islands). VCMI's WaterAdopter takes each LAND zone of the surface on its own, after the zones are laid out:
 * ISLANDS turns the zone's border and every tile of it farther than the zone's size from its centre into water, so
 * every zone is an island; NORMAL turns the outer part of the zone into water except a slice of at least a quarter
 * of its coast, so the water is a lake at each place the zones meet. Both then cut inlets (random tiles at each depth
 * from the coast, each pulling a channel down to the coast), fill coves, and drop tiny lakes. Measured on the engine's
 * own template maps (tier-1 grid, 93 templates): Normal 20% water in about 10 pieces on one land mass, Islands 47% in
 * about 8 land masses. Ours made 1 to 3 lakes, and under Islands a dry map on 57 of 93 template groups.
 *
 * zoneOf: level 0's zone index per cell (-1 where none); content 'normal' or 'islands'; forced: cells that stay land
 * (the starts' rings); keep: fraction of a zone's cells left as land by the radius rule before inlets (calibration
 * constants, see ADOPT below). Returns the water mask.
 */
// calibration points (map width: share of a zone left land by the radius rule), from the engine's own maps: its water
// share falls with the size of the map (Islands 0.55 at 36x36 down to 0.40 at 144x144) because the border band is a
// fixed width and a start keeps its ring of land. VMAPGEN_ADOPT_KEEP_ISLANDS / _NORMAL="36:0.5,72:0.6,..." override.
const KEEP_POINTS = {
	islands: process.env.VMAPGEN_ADOPT_KEEP_ISLANDS || '36:0.30,72:0.58,108:0.70,144:0.75',
	normal: process.env.VMAPGEN_ADOPT_KEEP_NORMAL || '36:0.38,72:0.65,108:0.78,144:0.76',
};
function keepFor(content, W) {
	const pts = KEEP_POINTS[content].split(',').map(s => s.split(':').map(Number));
	if (W <= pts[0][0]) return pts[0][1];
	for (let i = 1; i < pts.length; i++)
		if (W <= pts[i][0]) return pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * (W - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0]);
	return pts[pts.length - 1][1];
}
const ADOPT = {
	islands: { border: 1, inlets: 0.5 },
	normal: { border: 0, inlets: 0.5 },
};
function adoptWater(W, H, zoneOf, content, rng, forced, centres = null, shape = null, wetScale = 1, maxWetGiven = null, islandZones = null, isleRag = 1) {
	const N = W * H;
	// an island layout (Archipelago; Islands is content Islands already, stockChoices) makes island water whatever the content: on a template
	// map the Archipelago button with K's default content Normal made one land mass on 18 of 18 maps (MapGen Dev's gap table, the lead's
	// ruling 2026-10-14: the layout button makes its layout, the content and the amount only change how much). VMAPGEN_ADOPT_ISLE_SHAPE=0 off.
	const isl = content === 'islands' || (process.env.VMAPGEN_ADOPT_ISLE_SHAPE !== '0' && isleShape(shape));
	const cfg = isl ? ADOPT.islands : ADOPT[content] || ADOPT.normal;
	// The Water layout on a template map's Normal water (it was ignored: the water is each zone's outer part). The shape sets how wet
	// each zone is, by where its centre lies, around the same overall amount: Coastal wets the zones toward one side of the map
	// (picked from the seed), Continental those toward the edge, Mediterranean those toward the middle; Lakes and Highland leave
	// every zone as it was. A factor of 1 is the old water, and Lakes (the default) draws nothing extra from the generator.
	const shapeId = content !== 'islands' && shape !== null ? (WATER_SHAPES[Math.max(0, Math.min(WATER_SHAPES.length - 1, Math.round(Number(shape) || 0)))] || {}).id : null;
	const side = shapeId === 'coastal' ? rng() * Math.PI * 2 : 0;
	const wetFactor = (cx, cy) => {
		if (shapeId === 'coastal') { const t = ((cx - W / 2) * Math.cos(side) + (cy - H / 2) * Math.sin(side)) / (Math.hypot(W, H) / 2); return Math.max(0.2, 1 + 1.6 * t); }
		if (shapeId === 'continental' || shapeId === 'mediterranean') {
			const t = Math.min(1, Math.hypot(cx - W / 2, cy - H / 2) / (Math.hypot(W, H) / 2 * 0.75));
			return shapeId === 'continental' ? 0.3 + 1.4 * t : 1.7 - 1.4 * t;
		}
		return 1;
	};
	const mask = new Uint8Array(N);
	const zones = new Map();
	for (let c = 0; c < N; c++) {
		const z = zoneOf[c];
		if (z < 0) continue;
		if (!zones.has(z)) zones.set(z, []);
		zones.get(z).push(c);
	}
	const dirs4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
	// Mediterranean: one sea in the middle of the map with one ring of land round it out to the edges (K, 2026-10-11: "DO YOU EVEN KNOW WHAT A
	// MEDITERRANEAN IS?!", and his reference, the Age of Empires map wikis' Mediterranean: a sea of about a quarter to a third of the map, a ragged
	// shore, no scattered islands, no web of channels; `! LLM Files\Research\2026-10-11_Mediterranean-map-type-reference.md`). The rule below wetted
	// each zone's own outer part and drew channels between all the zones. Here every zone gives up its cells nearest the map's centre, one wandering
	// radius for the whole map; a zone whose centre lies inside the sea may lose up to 85% of its ground and keeps its outer edge, which joins the
	// ring as shore; the others keep their share (maxWetGiven). wetScale sets the amount as for the other layouts. VMAPGEN_MED_SEA=0 keeps the old rule.
	if (shapeId === 'mediterranean' && process.env.VMAPGEN_MED_SEA !== '0') {
		const target = Math.round(N * Math.min(0.9, (1 - keepFor(content, W)) * wetScale));
		const cap = maxWetGiven !== null ? maxWetGiven : 0.7;
		const mx = W / 2, my = H / 2;
		// the shore wanders: the radius swells and shrinks round the circle (four waves from the seed, the reference's shore is ragged), and the sea is a
		// little longer one way
		const ph1 = rng() * Math.PI * 2, ph2 = rng() * Math.PI * 2, ph3 = rng() * Math.PI * 2, ph4 = rng() * Math.PI * 2, st = 0.85 + rng() * 0.3;
		const distAt = (x, y) => { const dx = (x - mx) * st, dy = (y - my) / st, an = Math.atan2(dy, dx); return Math.hypot(dx, dy) / (1 + 0.12 * Math.sin(3 * an + ph1) + 0.08 * Math.sin(5 * an + ph2) + 0.05 * Math.sin(9 * an + ph3) + 0.04 * Math.sin(14 * an + ph4)); };
		const seaDist = c => distAt(c % W, (c / W) | 0);
		const r0 = Math.sqrt(target / Math.PI);
		const capOf = new Map(), order = [];
		// A template's dragon junctions are islands in the sea (K, 2026-10-12, his XL Mediterranean on Coldshadow: "Coldshadow dragon
		// junctions are on the edges. Would prefer these either as a large single island or four smaller ones in the middle"; the two
		// that the layout put near the middle were drowned to 35 and 20 tiles). Each gets a round island of its share of the land near
		// the middle, a moat of sea round it; the island is reached by boat (buildAdoptedPlan: settle leaves it apart, hubCells), and
		// the map's layout holds the junction's seed on it (isleAt; generate.js isleAnchors). VMAPGEN_MED_ISLES=0 drowns them as before.
		const isle = [], isleAt = [], kept = new Set(), isleZ = new Set();
		// the island is the zone's share of the land, as the map's layout will give it: at 80% of its dry cells it was 1.45 times that on
		// K's 1583610596, and the layout handed the surplus to an unplayed start and four treasure zones. It is a round piece with a
		// wandering shore about the zone's deepest tile, drawn a little toward the middle when it would reach the ring of land: the zone's
		// own deepest cells made a spine six tiles wide on a long zone, a road down it and its loot and guards packed along it (seed 55,
		// 2026-10-14)
		// the land share (VMAPGEN_MED_ISLE_FACTOR scales it; at 0.8 the 108 start below was freed but w_mediterranean_144_s7001 lost a start's way out). At the full share a start on a 108 stood boxed in at the shore (22 tiles, w_mediterranean_108_s7001),
		// and widening the start's own dry ground instead drowned other zones (the Opus Reviewer, pass 52 on 0.3.9: K's 1583610596)
		const keepShare = Number(process.env.VMAPGEN_MED_ISLE_KEEP) || Math.min(0.8, Math.max(0.3, (Number(process.env.VMAPGEN_MED_ISLE_FACTOR) || 1) * (1 - target / N)));
		if (islandZones && process.env.VMAPGEN_MED_ISLES !== '0') for (const [z, cells] of zones) {
			if (!islandZones.has(z)) continue;
			let cx = 0, cy = 0;
			for (const c of cells) { cx += c % W; cy += (c / W) | 0; }
			cx /= cells.length; cy /= cells.length;
			// every junction gets its island, wherever the dry layout put it (its middle is drawn in below): one whose centre lay outside
			// the sea had none, and the second layout's four did not match the first's three (seed 66, 2026-10-14)
			isleZ.add(z);
			const own = new Set(cells), depth = new Map();
			let front = cells.filter(c => dirs4.some(([dx, dy]) => { const u = c % W + dx, v = ((c / W) | 0) + dy; return u < 0 || v < 0 || u >= W || v >= H || !own.has(v * W + u); }));
			for (const c of front) depth.set(c, 1);
			for (let d = 2; front.length; d++) {
				const next = [];
				for (const c of front) for (const [dx, dy] of dirs4) { const u = c % W + dx, v = ((c / W) | 0) + dy, n = v * W + u; if (u >= 0 && v >= 0 && u < W && v < H && own.has(n) && !depth.has(n)) { depth.set(n, d); next.push(n); } }
				front = next;
			}
			const deep = cells.slice().sort((p, q) => (depth.get(q) || 0) - (depth.get(p) || 0) || p - q)[0];
			// at least 150 tiles, room for a junction's dwellings and its guarded loot
			const area = Math.max(150, Math.round(keepShare * cells.length)), R = Math.sqrt(area / Math.PI);
			let ox = deep % W, oy = (deep / W) | 0;
			// and within a fifth of the side from the middle, so the whole island stays inside gatherDragons' 28%: at the sea's edge the
			// dwellings of an island out there were carried to another with one guard and stood open (six seeds, 29% of dwellings, 2026-10-14)
			const inner = 0.2 * Math.min(W, H);
			for (let t = 0; t < 60 && (distAt(ox, oy) > r0 - R - 4 || Math.hypot(ox - mx, oy - my) > inner); t++) { ox += (mx - ox) * 0.08; oy += (my - oy) * 0.08; }
			ox = Math.round(ox); oy = Math.round(oy);
			const ph = (Math.imul(z + 1, 2654435761) >>> 0) / 4294967296 * Math.PI * 2;
			const cand = [];
			const box = Math.ceil(2 * R) + 2;
			for (let y = Math.max(0, oy - box); y <= Math.min(H - 1, oy + box); y++) for (let x = Math.max(0, ox - box); x <= Math.min(W - 1, ox + box); x++) {
				const c = y * W + x;
				if (forced[c] || kept.has(c) || distAt(x, y) > r0 - 3) continue;
				const an = Math.atan2(y - oy, x - ox);
				cand.push([Math.hypot(x - ox, y - oy) / (1 + 0.2 * Math.sin(3 * an + ph) + 0.1 * Math.sin(5 * an + 2 * ph)), c]);
			}
			cand.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
			for (const [, c] of cand.slice(0, area)) { kept.add(c); isle.push(c); }
			// the zone's own seed goes on the island's middle: the map's layout is drawn again with this water, and unheld it moved the
			// junctions into the sea and gave three of the four islands to treasure zones (K's 1583610596, 2026-10-14)
			isleAt.push({ z, x: ox, y: oy });
		}
		for (const [z, cells] of zones) {
			let cx = 0, cy = 0;
			for (const c of cells) { cx += c % W; cy += (c / W) | 0; }
			cx /= cells.length; cy /= cells.length;
			const inSea = distAt(cx, cy) < r0;
			capOf.set(z, isleZ.has(z) ? 1 : inSea ? Math.max(cap, 0.85) : cap);
			for (const c of cells) if (!forced[c] && !kept.has(c)) order.push([seaDist(c), c]);
		}
		order.sort((u, v) => u[0] - v[0]);
		const used = new Map();
		let got = 0;
		for (const [, c] of order) {
			if (got >= target) break;
			const z = zoneOf[c], n = used.get(z) || 0;
			if (n >= Math.floor(capOf.get(z) * zones.get(z).length)) continue;
			used.set(z, n + 1); mask[c] = 1; got++;
		}
		// an island's ring of sea, whatever the radius left dry round it: two tiles of water all round the kept core (settle keeps them
		// wet; one tile alone it dries as too thin)
		const moat = new Uint8Array(N);
		if (isle.length) {
			for (const c of isle) for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
				const u = c % W + dx, v = ((c / W) | 0) + dy, n = v * W + u;
				if (u >= 0 && v >= 0 && u < W && v < H && !kept.has(n) && !forced[n]) { if (!mask[n]) got++; mask[n] = 1; moat[n] = 1; }
			}
		}
		mask.isle = isle;
		mask.isleAt = isleAt;
		mask.moat = moat;
		return mask;
	}
	// each zone's factor, scaled so the area-weighted mean is 1 (the overall amount of water stays what the layout asked for)
	const zoneFactor = new Map();
	if (shapeId) {
		let sum = 0, area = 0;
		for (const [z, cells] of zones) {
			let cx = 0, cy = 0;
			for (const c of cells) { cx += c % W; cy += (c / W) | 0; }
			cx /= cells.length; cy /= cells.length;
			if (centres && centres[z]) { cx = centres[z].x; cy = centres[z].y; }
			const f = wetFactor(cx, cy);
			zoneFactor.set(z, f); sum += f * cells.length; area += cells.length;
		}
		for (const [z, f] of zoneFactor) zoneFactor.set(z, f * area / Math.max(1e-9, sum));
	}
	for (const [z, cells] of zones) {
		// the zone's centre: the given one, else the centroid snapped to a cell of the zone
		let cx = 0, cy = 0;
		for (const c of cells) { cx += c % W; cy += (c / W) | 0; }
		cx /= cells.length; cy /= cells.length;
		if (centres && centres[z]) { cx = centres[z].x; cy = centres[z].y; }
		// depth from the zone's edge: 1 on a cell beside a cell of another zone, growing inward
		const depth = new Map();
		let front = [];
		for (const c of cells) {
			const x = c % W, y = (c / W) | 0;
			let edge = false;
			for (const [dx, dy] of dirs4) {
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				if (zoneOf[ny * W + nx] !== z) { edge = true; break; }
			}
			if (edge) { depth.set(c, 1); front.push(c); }
		}
		for (let d = 2; front.length; d++) {
			const next = [];
			for (const c of front) {
				const x = c % W, y = (c / W) | 0;
				for (const [dx, dy] of dirs4) {
					const nx = x + dx, ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
					const n = ny * W + nx;
					if (zoneOf[n] === z && !depth.has(n)) { depth.set(n, d); next.push(n); }
				}
			}
			front = next;
		}
		for (const c of cells) if (!depth.has(c)) depth.set(c, 1);
		// the radius rule: the cells farthest from the centre, so that `keep` of the zone stays land
		let dist = c => Math.hypot(c % W - cx, ((c / W) | 0) - cy);
		// island shapes (K, 2026-10-14, on the Archipelago picture: "islands should be way less strictly circular", then "too round, and its okay
		// to have one or two, but most of them look round. we need a great variety and variability"): on island water the land a zone keeps is cut
		// by a distance stretched, turned, bent and lobed, with noise on the coast, each zone drawing its own amounts from the seed; about one
		// island in six stays near round. The Island shape lever scales all of it (islandShape: 0 round, as before; 1 ragged, the default).
		const rag = isl ? Math.max(0, Math.min(1.5, Number(isleRag) || 0)) : 0;
		if (rag > 0) {
			const R0 = Math.max(2, Math.sqrt(cells.length / Math.PI));
			// a start's island stays compact (at the full amount a pinched start island put its second town past a neck and a guard, K's XL options
			// seed 1583610596): its zone holds the start's ring of kept land
			const startIsle = cells.some(c => forced[c]);
			const amt = rag * (rng() < 1 / 6 ? 0.12 : 0.45 + 0.75 * rng()) * (startIsle ? 0.45 : 1);
			const th = rng() * Math.PI, ct = Math.cos(th), st = Math.sin(th);
			const se = Math.sqrt(1 + amt * (0.2 + 1.8 * Math.pow(rng(), 1.3)));      // stretch, 1 to about 3 along the long axis
			const bend = amt * (rng() - 0.5) * 1.8;                                   // a banana or a crescent
			const harm = [2, 3, 4, 5, 7].map(k => [k, amt * rng() * 0.42 / Math.sqrt(k - 1), rng() * Math.PI * 2]);
			// two layers of coast noise: headlands and bays from the coarse one, points and coves from the fine one
			const nz = valueNoise((rng() * 1e9) | 0, Math.max(3, Math.round(R0 / 1.6))), nf = valueNoise((rng() * 1e9) | 0, Math.max(2, Math.round(R0 / 4)));
			dist = c => {
				const x = c % W - cx, y = ((c / W) | 0) - cy;
				const u = (x * ct + y * st) / se, v = (-x * st + y * ct) * se - bend * (x * ct + y * st) ** 2 / (se * se * R0);
				const an = Math.atan2(v, u);
				let f = 1;
				for (const [k, a, ph] of harm) f += a * Math.sin(k * an + ph);
				return Math.hypot(u, v) / Math.max(0.35, f) + amt * R0 * (0.8 * (nz(c % W, (c / W) | 0) - 0.5) + 0.45 * (nf(c % W, (c / W) | 0) - 0.5));
			};
		}
		const ranked = cells.map(c => [dist(c), c]).sort((a, b) => a[0] - b[0]);
		// the most of a zone the radius rule may wet on Normal water (buildAdoptedPlan tries 0.7 down to 0.55 until every zone keeps ground): Mediterranean
		// on a 180x180 Coldshadow's Fantasy with 45% water wet the middle zones to 70% and drowned two of them (K, 2026-10-10: "huge mediterranean
		// coldshadow ... extremely strange"). Islands keep their own rule.
		// an island layout on Normal content keeps the cap (the Opus Reviewer, pass 59: Archipelago left a zone 6% land, seed 22)
		const maxWet = content === 'islands' ? 0.95 : maxWetGiven !== null ? maxWetGiven : 0.95;
		const keepRule = shapeId || wetScale !== 1 ? 1 - Math.max(0, Math.min(maxWet, (1 - keepFor(content, W)) * (shapeId ? zoneFactor.get(z) : 1) * wetScale)) : keepFor(content, W);
		// a template's dragon junction on island water keeps an island of 150 tiles or more and no inlets, as the Mediterranean's do: on
		// Archipelago one was left a 12-tile islet holding a monolith and its sea loot, no dragon dwelling (K's XL options, seed 22, 2026-10-14)
		const held = isl && islandZones && islandZones.has(z) && process.env.VMAPGEN_ISLE_HOLD !== '0';
		const keepZone = held ? Math.max(keepRule, Math.min(0.85, 150 / Math.max(1, cells.length))) : keepRule;
		// ragged islands get a strait two tiles deep on each side: with one, two ragged coasts met across it and the shore repair joined two
		// start islands (K's XL options, Archipelago, seed 24)
		const border = cfg.border && rag >= 0.5 ? cfg.border + 1 : cfg.border;
		const wet = new Set();
		// a ragged island, and a held junction's, is grown in one piece inside the strait from the zone's middle (and its start), the lowest of the
		// distance first, until it holds `keepZone` of the zone: cut by the distance alone, the strait, the inlets and the pieces the lobes left
		// apart (drowned later as islets) took the zone's land under its share, and a stretched or bent island left only a strip along one edge
		// (the Opus Reviewer, passes 69 and 71: K's 144 six-player options, Archipelago, seed 2042393646, 6 zones under 40% land with ragged
		// islands, 0 round; junctions of 70 and 133 tiles against the 150 held). VMAPGEN_ISLE_GROW=0 cuts by the distance as before.
		const grow = isl && (rag > 0 || held) && process.env.VMAPGEN_ISLE_GROW !== '0';
		if (grow) {
			const inZone = new Set(cells.filter(c => !(border && depth.get(c) <= border)));
			const target = Math.min(inZone.size, Math.round(cells.length * keepZone));
			// a start's zone grows round the start as well as round its middle: from the middle alone the start's ground came last and its town
			// stood on a point with its door on two tiles of shore (K's XL options, Archipelago, seed 25, start (48,109))
			const own = cells.filter(c => forced[c]);
			let sx = 0, sy = 0;
			for (const c of own) { sx += c % W; sy += (c / W) | 0; }
			if (own.length) { sx /= own.length; sy /= own.length; }
			// (within 10 tiles of it only: further out the start's island keeps its ragged coast; with no limit K's seed 1583610596 came out with
			// 52% of its islands round)
			const dS = c => Math.hypot(c % W - sx, ((c / W) | 0) - sy);
			const dv = new Map(ranked.map(([d, c]) => [c, own.length && dS(c) <= 10 ? Math.min(d, dS(c)) : d]));
			// a binary heap on the distance
			const hp = [];
			const push = c => { hp.push(c); let i = hp.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (dv.get(hp[p]) <= dv.get(hp[i])) break; [hp[p], hp[i]] = [hp[i], hp[p]]; i = p; } };
			const pop = () => { const top = hp[0], last = hp.pop(); if (hp.length) { hp[0] = last; let i = 0; for (;;) { const a = 2 * i + 1, b = a + 1; let m = i; if (a < hp.length && dv.get(hp[a]) < dv.get(hp[m])) m = a; if (b < hp.length && dv.get(hp[b]) < dv.get(hp[m])) m = b; if (m === i) break; [hp[m], hp[i]] = [hp[i], hp[m]]; i = m; } } return top; };
			const seeds = [...inZone].filter(c => forced[c]);
			let mid = -1, md = Infinity;
			for (const c of inZone) { const d = Math.hypot(c % W - cx, ((c / W) | 0) - cy); if (d < md) { md = d; mid = c; } }
			if (mid >= 0) seeds.push(mid);
			const land = new Set(), queued = new Set(seeds);
			for (const c of seeds) push(c);
			while (hp.length && land.size < target) {
				const c = pop();
				land.add(c);
				const x = c % W, y = (c / W) | 0;
				for (const [dx, dy] of dirs4) {
					const nx = x + dx, ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
					const n = ny * W + nx;
					if (inZone.has(n) && !queued.has(n)) { queued.add(n); push(n); }
				}
			}
			for (const c of cells) if (!land.has(c)) wet.add(c);
		} else {
			const R = ranked[Math.min(ranked.length - 1, Math.floor(ranked.length * keepZone))][0];
			for (const [d, c] of ranked) if (d > R) wet.add(c);
			if (border) for (const c of cells) if (depth.get(c) <= border) wet.add(c);
		}
		// NORMAL: a slice of at least a quarter of the coast stays dry
		if (!isl) {
			const angle = c => Math.atan2(((c / W) | 0) - cy, c % W - cx);
			// the engine keeps one slice dry; several narrower ones (the same share in all) cut a zone's water into more
			// lakes, which is what its maps show (about 11 pieces on the 36 to 108 size, 20 on 144)
			const nSlice = Math.max(1, Math.round(Number(process.env.VMAPGEN_ADOPT_SLICES || 6)));
			const total = Math.PI * 2 * (0.25 + 0.15 * rng());
			const slices = [];
			for (let k = 0; k < nSlice; k++) slices.push([rng() * Math.PI * 2, total / nSlice]);
			const inSlice = c => slices.some(([a0, span]) => { let a = (angle(c) - a0) % (Math.PI * 2); if (a < 0) a += Math.PI * 2; return a < span; });
			for (const c of [...wet]) if (inSlice(c)) wet.delete(c);
		}
		// coast irregularity: random cells at each depth, each pulling a channel of falling depth to the coast
		const byDepth = new Map();
		for (const c of cells) { const d = depth.get(c); if (!byDepth.has(d)) byDepth.set(d, []); byDepth.get(d).push(c); }
		const maxD = Math.max(...byDepth.keys());
		const checked = new Set();
		const queue = [];
		const passed = new Set();
		// an inlet is a short, wandering channel: no deeper than 6 tiles from the coast, and each cell of it passes on to one neighbour, not to all that are
		// one step nearer the coast (all of them cut a straight slot 2 to 3 wide and up to 14 long into the land, K's islands; slots.js counted 6 on his map)
		for (let d = held || grow ? 0 : Math.min(maxD, Math.round(Math.sqrt(cells.length) / 2), 6); d >= 1; d--) {
			const ring = byDepth.get(d) || [];
			const n = Math.floor(ring.length / (d + 3) * cfg.inlets);
			for (let k = 0; k < n; k++) {
				const c = ring[(rng() * ring.length) | 0];
				if (checked.has(c) || forced[c]) continue;
				if (!isl && d > 1 && !wet.has(c)) continue; // a lake grows only from water that is there
				queue.push(c); checked.add(c);
			}
		}
		while (queue.length) {
			const c = queue.shift();
			if (wet.has(c) && !isl) { /* already water, keep pulling */ }
			wet.add(c);
			const x = c % W, y = (c / W) | 0;
			for (const [dx, dy] of dirs4) {
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const n = ny * W + nx;
				if (checked.has(n) || zoneOf[n] !== z) continue;
				if (depth.get(c) - depth.get(n) === 1 && !passed.has(c) && rng() < 0.6) { passed.add(c); queue.push(n); checked.add(n); }
			}
		}
		for (const c of wet) if (!forced[c]) mask[c] = 1;
	}
	return mask;
}

/** The water plan of a template map made the engine's way (adoptWater), cleaned as buildWaterPlan's is. */
function buildAdoptedPlan(W, H, zoneOf, content, starts, seed, check = null, groups = null, shape = null, coverage = null, islandZones = null, isleRag = 1) {
	// zones that make one island (a centralized island of several zones): their cells count as one zone to the water
	const zoneOrig = zoneOf;
	if (groups && groups.length) {
		const to = new Map();
		for (const g of groups) for (const z of g) to.set(z, g[0]);
		zoneOf = zoneOf.map(z => (to.has(z) ? to.get(z) : z));
	}
	const forced = forcedAround(starts, W, H, START_CLEAR);
	const startCells = starts.map(q => q.y * W + q.x);
	// Amount of water (K, 2026-10-05: "this is not 45% water"): the engine's own calibration (keepFor) fixed the share whatever the
	// slider said, 0.14 to 0.19 on a template map. The wet share of every zone is now scaled until the surface comes out at the
	// amount asked, within 2 points, in at most twelve tries per cap; no amount given runs once as before.
	const want = Number(coverage) > 0 ? Number(coverage) : null;
	let scale = 1, mask = null, got = 0, unfit = 0, aimed = null;
	// Zones left ground (K, 2026-10-10): the sea of a high amount took 70% of the middle zones of a 180x180 map and drowned two. The amount is
	// tried with the most any zone may lose falling from 0.7 to 0.55 of its radius, and the first that leaves every zone of 60 cells or more
	// 40% land is kept (the amount falls short when none reaches it, and says so in the log). VMAPGEN_ADOPT_MAX_WET fixes one cap.
	const isl = content === 'islands' || (process.env.VMAPGEN_ADOPT_ISLE_SHAPE !== '0' && isleShape(shape));
	// the caps hold for an island layout on Normal content too: only content Islands keeps its own rule (the Opus Reviewer, pass 59)
	const caps = !want || content === 'islands' ? [null] : process.env.VMAPGEN_ADOPT_MAX_WET ? [Number(process.env.VMAPGEN_ADOPT_MAX_WET)] : [0.7, 0.65, 0.6, 0.55];
	const area = new Map();
	for (let c = 0; c < W * H; c++) if (zoneOf[c] >= 0) area.set(zoneOf[c], (area.get(zoneOf[c]) || 0) + 1);
	const minLand = m => {
		const wet = new Map();
		for (let c = 0; c < W * H; c++) if (m[c] && zoneOf[c] >= 0) wet.set(zoneOf[c], (wet.get(zoneOf[c]) || 0) + 1);
		let low = 1;
		// a dragon junction made an island is mostly sea by design: it is not a zone the sea may not drown (the Opus Reviewer, pass 51: with it
		// counted the low was about 0 on every island map, all four caps ran and the last was kept whatever it left the others)
		for (const [z, n] of area) if (n >= 60 && !(islandZones && islandZones.has(z))) low = Math.min(low, 1 - (wet.get(z) || 0) / n);
		return low;
	};
	for (const cap of caps) {
		scale = 1;
		for (let t = 0; t < (want ? 12 : 1); t++) {
			const rng = xorshift(((seed || 1) ^ 0x5b3e17) >>> 0);
			rng(); rng();
			mask = adoptWater(W, H, zoneOf, content, rng, forced, null, shape, scale, cap, islandZones, isleRag);
			const isle = mask.isle || [], isleAt = mask.isleAt || [], moat = mask.moat || null;
			settle(mask, W, H, forced, startCells, { connect: !isl, apart: isle, ...(isle.length ? { wet: moat } : {}) });
			mask.isle = isle;
			mask.isleAt = isleAt;
			unfit = check ? repairShore(mask, W, H, forced, check, null, false) : 0;
			got = mask.reduce((a, v) => a + v, 0);
			if (process.env.VMAPGEN_WATER_TRACE) console.error('[water] cap ' + cap + ' try ' + t + ' scale ' + scale.toFixed(2) + ' got ' + (100 * got / (W * H)).toFixed(1) + '% minLand ' + minLand(mask).toFixed(2));
			// the islands come out of the sea as far as 1 point of water (the loop below lands within 2 of its aim), the rest out of the land ring: all from the ring, it lost their 1300
			// tiles and starts' second towns stood 8 to 11 tiles from the first (3 of 12 seeds, K's Mediterranean options); all from the sea,
			// a 72x72 at 30% asked came out at 18.5% water (test/water-amount.test.js), 2026-10-14
			const aim = want ? Math.max(0.05, want - Math.min(0.01, (mask.isle ? mask.isle.length : 0) / (W * H))) : want;
			aimed = aim;
			if (!want || Math.abs(got / (W * H) - aim) <= 0.02) break;
			scale = Math.max(0.1, Math.min(30, scale * aim / Math.max(0.01, got / (W * H))));
		}
		if (cap === null || minLand(mask) >= 0.4) break;
	}
	// each member of such an island keeps 30% of its own cells as land, grown from the island into the member's sea (the lead, 2026-10-15 10:58:
	// a dragon junction of the one large island kept 11%, seed 2042393646). VMAPGEN_GROUP_FLOOR=0 off.
	if (groups && groups.length && isl && process.env.VMAPGEN_GROUP_FLOOR !== '0')
		for (const g of groups) for (const z of g) {
			const cells = [];
			for (let c = 0; c < W * H; c++) if (zoneOrig[c] === z) cells.push(c);
			let land = cells.filter(c => !mask[c]).length;
			const need = Math.ceil(0.3 * cells.length);
			if (land >= need) continue;
			const inG = new Set(g), seen = new Set(), q = [];
			const touchesIsle = c => { const x = c % W, y = (c / W) | 0; return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => { const u = x + dx, v = y + dy; return u >= 0 && v >= 0 && u < W && v < H && !mask[v * W + u] && inG.has(zoneOrig[v * W + u]); }); };
			for (const c of cells) if (mask[c] && touchesIsle(c)) { q.push(c); seen.add(c); }
			for (let h = 0; h < q.length && land < need; h++) {
				const c = q[h];
				if (mask[c]) { mask[c] = 0; land++; got--; }
				const x = c % W, y = (c / W) | 0;
				for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const u = x + dx, v = y + dy, n = v * W + u; if (u >= 0 && v >= 0 && u < W && v < H && !seen.has(n) && zoneOrig[n] === z && mask[n]) { seen.add(n); q.push(n); } }
			}
		}
	if (want && !isl && Math.abs(got / (W * H) - (aimed || want)) > 0.02)
		console.error(`[gen] water: ${(100 * got / (W * H)).toFixed(1)}% reached of the ${(100 * want).toFixed(0)}% asked, the lowest zone keeps ${(100 * minLand(mask)).toFixed(0)}% land`);
	return { mask, starts: starts.map(q => ({ ...q, moved: false })), shape: isl ? 'islands' : 'lakes',
		coverage: got / (W * H), unfit, islands: isl, hubCells: (mask.isle || []).filter(c => !mask[c]), isleAt: mask.isleAt || [], adopted: content };
}

module.exports = { WATER_SHAPES, MAX_COVERAGE, START_CLEAR, buildWaterPlan,
	settleZonesOnLand, shapeOf, adoptWater, buildAdoptedPlan };
