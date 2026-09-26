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
// Land kept around a start town (Chebyshev radius from its anchor): the town,
// the reserved ground before its gate and room for the starter mines.
const START_CLEAR = 7;

function shapeOf(p) {
	const i = Math.round(Number(p && p.waterShape) || 0);
	return WATER_SHAPES[Math.max(0, Math.min(WATER_SHAPES.length - 1, i))];
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

function scoreField(W, H, shape, rng, starts = []) {
	const coarseCell = shape.id === 'highland' ? Math.max(4, Math.round((W + H) / 14))
		: Math.max(6, Math.round((W + H) / 7));
	const coarse = valueNoise((rng() * 1e9) | 0, coarseCell);
	const fine = valueNoise((rng() * 1e9) | 0, Math.max(3, Math.round((W + H) / 30)));
	const side = (rng() * 4) | 0;                    // coastal: which edge
	const stretch = 0.55 + rng() * 0.45;             // mediterranean: aspect
	const alongX = rng() < 0.5;
	const s = new Float64Array(W * H);
	const edgeBand = 0.1 * Math.min(W, H) + 3;
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
					v = -Math.hypot(a / ex, b / ey) + 0.35 * (n - 0.5);
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
 * on them. `forced` cells are always land.
 */
function settle(m, W, H, forced, startCells, opts = {}) {
	const N = W * H;
	// `wet` cells stay water whatever the rules below say (the straits between
	// two players' islands); `connect` false keeps islands apart (no bridges)
	const wet = opts.wet || null, connect = opts.connect !== false;
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
			const islet = Math.max(30, Math.round(0.01 * N));
			for (let k = 0; k < lc.sizes.length; k++) {
				if (k === main) continue;
				if (!withStart.has(k) && lc.sizes[k] < islet) {
					for (let c = 0; c < N; c++) if (lc.id[c] === k && !forced[c]) m[c] = 1;
					changed = true;
				} else if (connect) {
					bridge(m, W, H, lc.id, k, main);
					changed = true;
				}
				// islands: a start's island and any neutral island big enough stay
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
 *   { mask: Uint8Array (1 = water), starts: [{x, y, moved?}], shape, coverage }.
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
function repairShore(m, W, H, forced, check, wet = null) {
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
					const after = pieces();
					if (gain > 0 && (wet ? after === before : after <= before)) {
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
	const s = scoreField(W, H, shape, rng, base);
	const N = W * H;
	// island shapes: the straits between players stay water, islands stay apart
	const wet = shape.islands ? s.channel : null;
	const target = Math.round(cover * N);
	// A sea that covers a start's corner (judged by where the water would go
	// with no start in the way) moves the start inland: Coastal and
	// Continental. Lakes simply yield to a start's forced dry ground instead:
	// scattered lakes leave no fully dry square nearby, and a start sent
	// across the map to find one wrecks the layout.
	const moved = shape.relocate
		? relocateStarts(selectTop(s, target, null), base, W, H) : base.map(q => ({ ...q }));
	const forced = forcedAround(moved, W, H, START_CLEAR);
	const startCells = moved.map(q => q.y * W + q.x);
	// Cleaning loses water (thin arms, ponds) and bridging loses more, so
	// aim the selection a little high and correct it from the measured result.
	let k = target, mask = null, got = 0;
	for (let it = 0; it < 4; it++) {
		mask = selectTop(s, k, forced);
		if (wet) for (let c = 0; c < N; c++) if (wet[c] && !forced[c]) mask[c] = 1;
		settle(mask, W, H, forced, startCells, { wet, connect: !shape.islands });
		got = mask.reduce((a, v) => a + v, 0);
		if (!got || Math.abs(got - target) <= Math.max(8, 0.01 * N)) break;
		k = Math.max(1, Math.round(k * target / got));
	}
	const unfit = check ? repairShore(mask, W, H, forced, check, wet) : 0;
	got = mask.reduce((a, v) => a + v, 0);
	return { mask, starts: moved, shape: shape.id, coverage: got / N, unfit,
		islands: !!shape.islands };
}

/**
 * Zones on land only. The partition is a warped Voronoi over every cell, so a
 * zone can come out as pieces on both sides of a lake. Each zone keeps the
 * piece its seed stands on; every other piece goes to the neighbour it shares
 * the most border with. Water then takes the zone of the nearest land, so a
 * coast is never a zone line and the zone of every cell stays a real index.
 */
function settleZonesOnLand(zone, seeds, W, H, water) {
	const N = W * H;
	const core = new Uint8Array(N);
	const byZone = new Map();
	// flood each zone's own land from its seed
	for (let i = 0; i < seeds.length; i++) {
		const s0 = seeds[i].y * W + seeds[i].x;
		if (water[s0] || zone[s0] !== i) continue;
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

module.exports = { WATER_SHAPES, MAX_COVERAGE, START_CLEAR, buildWaterPlan,
	settleZonesOnLand, shapeOf };
