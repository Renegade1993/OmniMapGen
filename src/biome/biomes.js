/**
 * biomes.js - biome graph layer over the tile WFC.
 *
 * The map is partitioned into Voronoi biome regions, each tagged with a
 * content class drawn from the Nostalgia-parameter distribution. Biome
 * assignment drives the tile-level WFC (each biome constrains its cells to
 * that biome's terrain family), and adjacency edges carry a connection type
 * (portal / open path with road / open path without road / none).
 *
 * All ratios live in BIOME_DEFAULTS and are caller-overridable.
 */
'use strict';

const { xorshift } = require('../wfc/solver');

/** Content classes a biome can belong to. */
const BIOME_CLASS = {
	PLAYER: 'player',          // a player's home zone (start town)
	TOWN: 'town',              // neutral town, not player-serving
	HIGH_LOOT: 'highLoot',     // dragon utopia / relic-rich zone
	STANDARD: 'standard',      // normal resource mix
	LOW_LOOT: 'lowLoot',       // open filler zone, resource generators
};

/**
 * Default parameter set (Nostalgia-style base case). Every knob is a
 * probability or count multiplier tuned against real templates:
 *   interconnectivity     - fraction of biome borders that get any opening
 *   interconnectPortal    - of the openings, fraction done via teleporter
 *   openPathNoRoad        - of non-portal openings, fraction without roads
 *   openPathRoad          - of non-portal openings, fraction with roads
 *   chokeGuardRatio       - fraction of path openings that get a monster guard
 *   artifactDensity       - global artifact objects per 100 cells
 *   artifactRichness      - 0..1, how good artifacts are (drives tier mix)
 *   highLootRatio         - fraction of non-player biomes that are high-loot
 *   townRatio             - fraction of non-player biomes with a neutral town
 *   lowLootRatio          - fraction of non-player biomes that are low-loot
 *   subterraneanGateRatio - gates per biome pair when underground present
 *   subterraneanNarrow    - how much of an underground level is tunnel rather
 *                           than chamber. 0 gives caverns, 1 gives corridors
 *   undergroundRock       - carve the underground out of solid rock at all
 *   mineDensity           - multiplier on the per-class mine counts
 *   resourceDensity       - multiplier on resource-pile counts
 *   pickupDensity         - multiplier on treasure chests and campfires
 *   starterMines          - place a wood and an ore mine beside every start
 *   dwellingDensity       - multiplier on creature dwelling counts
 *   guardDensity          - multiplier on wandering monster counts
 *   bonusDensity          - multiplier on shrines and one-visit stat buildings
 *   biomeWobble           - how far smooth noise bends a biome boundary away
 *                           from the straight Voronoi line. 0 is the old
 *                           straight-edged wedges; much above 1 and regions
 *                           start breaking into islands
 */
const BIOME_DEFAULTS = {
	interconnectivity: 0.6,
	interconnectPortal: 0.20,
	openPathNoRoad: 0.55,
	// 0.37 roaded ~40% of non-portal openings and, with the town-linking
	// network on top, landed 5.60% road cells vs the corpus's 4.15%.
	// 0.26 targets ~4.2%.
	openPathRoad: 0.26,
	chokeGuardRatio: 0.7,
	artifactDensity: 0.006,
	artifactRichness: 0.5,
	highLootRatio: 0.15,
	// 0.20 gave 0.69 neutral towns per 1000 cells against the corpus's
	// 1.16 - each town-class biome yields exactly one town, so the class
	// share IS the rate. 0.34 overshot on the repointed 75-map corpus
	// (towns 1.75x); 0.20 still ran 1.51x - TOWN biomes trend larger than
	// average, so the class share lands more than the ratio asks. 0.14
	// was set when the corpus read ~1.16; the repointed census says 0.59
	// and 0.14 actually lands 0.81 (1.38x). 0.10 targets ~0.58.
	townRatio: 0.10,
	lowLootRatio: 0.25,
	subterraneanGateRatio: 1.0,
	subterraneanNarrow: 0.6,
	// How much of an underground level ends up walkable. Chambers and tunnels
	// alone leave about a quarter of it open, which is what made our caves read
	// as a warren: the 32 two-level maps in the corpus average 56.8% open, and
	// a level with that little floor has nowhere to put the terrain features
	// that make one look real. Measured with `vmap_thickness.js --corpus`.
	subterraneanOpen: 0.57,
	// which starts go below on a two-level map (template.js assignLevels): 0
	// none, 1 the game's rule, 2 all of them
	undergroundStarts: 1,
	mineDensity: 1.0,
	resourceDensity: 1.0,
	pickupDensity: 1.0,
	starterMines: true,
	dwellingDensity: 1.0,
	guardDensity: 1.0,
	bonusDensity: 1.0,
	biomeWobble: 0.6,
	undergroundRock: true,
	decorDensity: 1.0,
	// ---- Levers added 2026-09-24 for the in-game MapGen UI (queue item 25).
	// Every default reproduces the calibrated output byte for byte; they only
	// turn values that used to be constants into things a player can move.
	// Zone layout: one zone per zoneCells cells of the level, at most zoneCap
	// zones per level (player starts included). zoneCap's default (queue
	// item 39, K, 2026-09-25) sits above what any map wants at the default
	// zoneCells (a 252x252 map wants 159), so density alone decides the
	// count on every map size unless a player deliberately pulls zoneCap
	// down for fewer, bigger zones. It used to be a flat 12, which bound on
	// every map bigger than about 72x72 and flattened the zone count (and
	// therefore the portal/gate/mine count) on every big map to the same
	// number regardless of size.
	zoneCells: 400,
	zoneCap: 300,
	// The free layout's start zones, together, as a share of the map's land,
	// split evenly between the players (at most MAX_START_SHARE each). Real
	// maps give their starts about half of it: over K's seven templates, 0.31
	// to 0.85 at each one's own player count, 0.56 on average (a zone's area
	// going with its size squared, CZonePlacer). A start zone used to be one
	// more Voronoi cell among the rest, 1 to 2% of the map in a corner, and
	// the smallest a twelfth of the largest: K found one "about 3 times bigger
	// than the castle" holding nothing but its town and a guard at the exit.
	startZoneShare: 0.5,
	// Border solidity, one scale for how zones are walled off from each other:
	//   1      solid rim band plus rim lobes (the engine's look, the default)
	//   0.5-1  rim band, lobes scaled down toward none at 0.5
	//   0.25-0.5  porous: the old one-cell walls with the denser interior
	//   under 0.25  no border scenery at all; a zone line is a terrain change
	borderSolidity: 1,
	// Monster placement: the share of each zone's monster budget posted on
	// objects (the rest roams), and how strongly mines and loot draw those
	// guards relative to the corpus odds (GUARD_CHANCE in content.js).
	// Chokepoint guards are chokeGuardRatio above.
	objectGuardShare: 0.75,
	mineGuardWeight: 1,
	lootGuardWeight: 1,
	// Monster strength, in creature levels added to every guard and roamer
	// (clamped to 1..7): the stock tab's weak / normal / strong read -1 / 0 / 1.
	monsterStrength: 0,
	// Stack size: 1 leaves each stack's count to the engine (the creature's
	// own adventure-map range); anything else writes counts from a per-level
	// reference curve scaled by this (content.js STACK_RANGE).
	stackScale: 1,
	// Guards per context, on (1) or off (0): treasure (artifacts, chests,
	// pandoras, banks...), mines, creature dwellings, zone doorways, and the
	// monoliths of portal links (off by default, as the corpus has none).
	guardTreasure: 1,
	guardMines: 1,
	guardDwellings: 1,
	guardBottlenecks: 1,
	guardPortals: 0,
	// The road network that links the towns: 1 on, 0 off. Roads cut through
	// zone openings follow openPathRoad either way.
	roadNetwork: 1,
	// Surface water (water.js, queue 25d): the share of the surface under
	// water, and where it goes (index into WATER_SHAPES: lakes, coastal,
	// continental, mediterranean, highland). 0 is a dry map, as before.
	waterCoverage: 0,
	waterShape: 0,
	// Harbours (waterfill.js): 0 none, 1 shipyards at player starts, 2 in
	// every town zone on the shore (the engine's rule), 3 also a boat in every
	// other shore zone. waterTreasure multiplies what lies on the water,
	// waterBuildings the sites a boat visits (mermaids, buoys, sirens,
	// whirlpools), as the land's own levers split pickups from buildings.
	waterAccess: 2,
	waterTreasure: 1,
	waterBuildings: 1,
};

/**
 * Border mode from borderSolidity (see BIOME_DEFAULTS). The rim band and the
 * zone-restricted interior field go together: at 0.5 and up the zone lines
 * are the engine's two-deep band; below that the old one-cell walls with the
 * denser interior (VMAPGEN_RIM=0 still forces that for A/B work).
 */
function rimModeOf(p) {
	return process.env.VMAPGEN_RIM !== '0'
		&& !(p && Number.isFinite(p.borderSolidity) && p.borderSolidity < 0.5);
}
/** Rim-lobe strength, 0..1: full at borderSolidity 1, none at 0.5 and below. */
function rimLobeScale(p) {
	const s = p && Number.isFinite(p.borderSolidity) ? p.borderSolidity : 1;
	return Math.max(0, Math.min(1, (s - 0.5) / 0.5));
}
/** No border scenery at all: zone lines are terrain changes only. */
function bordersOff(p) {
	return !!(p && Number.isFinite(p.borderSolidity) && p.borderSolidity < 0.25);
}

/**
 * Smooth value noise on a lattice, bilinearly interpolated.
 *
 * Coherent noise, not per-cell salt. Salt would make a boundary speckled,
 * which is worse than a straight one: Heroes 3 has no edge sprite for two
 * terrains meeting at a single corner, so a ragged border produces exactly the
 * arrangement the terrain art cannot draw.
 */
function valueNoise(seed, cellSize) {
	const hash = (ix, iy) => {
		let h = (ix * 374761393 + iy * 668265263 + seed * 2246822519) >>> 0;
		h = (h ^ (h >>> 13)) * 1274126177 >>> 0;
		return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
	};
	const fade = t => t * t * (3 - 2 * t);
	return (x, y) => {
		const fx = x / cellSize, fy = y / cellSize;
		const ix = Math.floor(fx), iy = Math.floor(fy);
		const tx = fade(fx - ix), ty = fade(fy - iy);
		const a = hash(ix, iy), b = hash(ix + 1, iy);
		const c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
		const top = a + (b - a) * tx, bot = c + (d - c) * tx;
		return top + (bot - top) * ty;          // 0..1
	};
}

/**
 * The border noise's two cell sizes, coarse and fine. They grew with the map,
 * (W + H) / 10 and (W + H) / 28, which suits zones that grow with it; a free
 * layout's zones keep one size (Biome size), so on a giant map a border saw
 * less than half a coarse wave and ran straight, and the minimap read as
 * facets (K, 2026-09-27, a 252x252: "geodesic"). Each is capped at what the
 * zones' own spacing gives: about 20 cells between free-layout seeds, waves
 * of 22 and 8, which is where the two rules agree, at 108x108. So nothing
 * changes up to that size, and above it the bends keep the zones' scale.
 * VMAPGEN_WOBBLE_SCALE=map keeps the map-sized waves, for measuring.
 */
function wobbleWaves(W, H, zones, land = W * H) {
	const bySize = { coarse: Math.round((W + H) / 10), fine: Math.round((W + H) / 28) };
	const spacing = Math.sqrt(land / Math.max(1, zones));
	const byZone = process.env.VMAPGEN_WOBBLE_SCALE === 'map' ? bySize
		: { coarse: Math.round(1.1 * spacing), fine: Math.round(0.4 * spacing) };
	return {
		coarse: Math.max(4, Math.min(bySize.coarse, byZone.coarse)),
		fine: Math.max(3, Math.min(bySize.fine, byZone.fine)),
	};
}

/**
 * Partition the level into `biomeCount` regions. Player start cells are fixed
 * seeds first so every player owns a biome.
 * Returns {zone: Int16Array, seeds: [{x,y}], count}.
 *
 * A plain Voronoi partition gives every region a straight-edged wedge, which
 * is the single clearest tell that a map was generated: real regions are
 * blobs. Each seed's distance field is warped by smooth noise, which bends the
 * boundaries without moving the seeds or changing how much ground each region
 * gets by much.
 *
 * The warp is multiplied by the distance rather than added to it, so it fades
 * to nothing at a seed. That matters: a player's own cell has to stay inside
 * the player's own region, and an additive warp could hand it to a neighbour.
 */
function partitionBiomes(W, H, playerStarts, targetCount, rng, params, water = null, startCells = 0) {
	const p = { ...BIOME_DEFAULTS, ...params };
	const seeds = playerStarts.map(pl => ({ x: pl.x, y: pl.y, player: true }));
	// with a start area asked for, no other zone's seed lands well inside the
	// disc that area fills around its start: the disc's radius grows until it
	// holds the area on the map, so a corner start's reaches twice as far as
	// one in open ground
	const reach = seeds.map(s => {
		if (!(startCells > 0)) return 0;
		let lo = 1, hi = W + H;
		for (let k = 0; k < 14; k++) {
			const r = (lo + hi) / 2, r2 = r * r;
			let n = 0;
			for (let y = Math.max(0, Math.floor(s.y - r)); y <= Math.min(H - 1, Math.ceil(s.y + r)); y++)
				for (let x = Math.max(0, Math.floor(s.x - r)); x <= Math.min(W - 1, Math.ceil(s.x + r)); x++)
					if ((x - s.x) ** 2 + (y - s.y) ** 2 <= r2 && !(water && water[y * W + x])) n++;
			if (n < startCells) lo = r; else hi = r;
		}
		return 0.8 * hi;
	});
	const nearStart = (x, y) => seeds.some((s, i) => s.player && Math.hypot(s.x - x, s.y - y) < reach[i]);
	// With surface water (water.js) a zone grows from dry land, and its seed is
	// the best of several dry candidates: far from the other seeds and not
	// hugging the shore, where half its Voronoi cell would be sea and the zone
	// would come out a sliver. Without water the draw is unchanged.
	const shore = water ? distanceToWater(W, H, water) : null;
	while (seeds.length < targetCount) {
		let x = 2 + (rng() * (W - 4)) | 0, y = 2 + (rng() * (H - 4)) | 0;
		for (let k = 0; k < 24 && nearStart(x, y); k++) {
			x = 2 + (rng() * (W - 4)) | 0; y = 2 + (rng() * (H - 4)) | 0;
		}
		if (water) {
			let best = null, bs = -Infinity;
			for (let k = 0; k < 16; k++) {
				if (k) { x = 2 + (rng() * (W - 4)) | 0; y = 2 + (rng() * (H - 4)) | 0; }
				if (water[y * W + x] || nearStart(x, y)) continue;
				let d = Infinity;
				for (const s of seeds) d = Math.min(d, Math.hypot(s.x - x, s.y - y));
				const score = Math.min(d, 1.5 * shore[y * W + x]);
				if (score > bs) { bs = score; best = { x, y }; }
			}
			({ x, y } = best || nearestLand(W, H, water, x, y));
		}
		seeds.push({ x, y, player: false });
	}
	// Island maps (water W3): every island gets a zone of its own. A random
	// draw can miss a small one, and its land would then belong to a zone
	// across the water. The island's seed goes on its driest cell.
	if (water && p.waterIslands) {
		const piece = new Int32Array(W * H).fill(-1);
		for (let c0 = 0; c0 < W * H; c0++) {
			if (water[c0] || piece[c0] >= 0) continue;
			const q = [c0];
			piece[c0] = c0;
			for (let h = 0; h < q.length; h++) {
				const c = q[h], x = c % W, y = (c / W) | 0;
				for (const [u, v] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]])
					if (u >= 0 && v >= 0 && u < W && v < H && !water[v * W + u] && piece[v * W + u] < 0) { piece[v * W + u] = c0; q.push(v * W + u); }
			}
			if (seeds.some(s => piece[s.y * W + s.x] === c0)) continue;
			let best = q[0];
			for (const c of q) if (shore[c] > shore[best]) best = c;
			seeds.push({ x: best % W, y: (best / W) | 0, player: false });
		}
	}
	const amp = p.biomeWobble;
	// one noise field per seed, so neighbouring regions push into each other
	// rather than every boundary bending the same way. Two octaves: the
	// coarse field bends the boundary, the fine one (about a third of the
	// amplitude at about a third of the wavelength) breaks up the straight
	// runs a single octave leaves between bends. The fine octave stays
	// coherent noise, not salt - a speckled border is worse than a straight
	// one because the terrain art has no edge sprite for a one-cell corner.
	let land = W * H;
	if (water) for (let c = 0; c < W * H; c++) if (water[c]) land--;
	const waves = wobbleWaves(W, H, seeds.length, land);
	const noise = amp > 0
		? seeds.map((_, i) => ({
			coarse: valueNoise(((rng() * 1e9) | 0) + i * 7919, waves.coarse),
			// VMAPGEN_EDGE=off drops the fine octave for A/B measurement
			fine: process.env.VMAPGEN_EDGE === 'off' ? null
				: valueNoise(((rng() * 1e9) | 0) + i * 15485863 + 3247, waves.fine),
		}))
		: null;

	const zone = new Int16Array(W * H).fill(-1);
	// each seed's squared distance field, noise and all, once
	const field = seeds.map((s, i) => {
		const f = new Float32Array(W * H);
		for (let y = 0; y < H; y++)
			for (let x = 0; x < W; x++) {
				const dx = x - s.x, dy = y - s.y;
				let d = dx * dx + dy * dy; // squared euclid, rounder blobs than Chebyshev
				if (noise) d *= 1 + amp * (noise[i].coarse(x, y) - 0.5)
					+ (noise[i].fine
						? amp * 0.35 * (noise[i].fine(x, y) - 0.5) : 0);
				f[y * W + x] = d;
			}
		return f;
	});
	const weight = seeds.map(() => 1);
	const assign = () => {
		for (let c = 0; c < W * H; c++) {
			let best = -1, bd = Infinity;
			for (let i = 0; i < seeds.length; i++) {
				const d = field[i][c] / weight[i];
				if (d < bd) { bd = d; best = i; }
			}
			zone[c] = best;
		}
	};
	assign();
	// Start zones grown to their area: a heavier seed wins ground farther
	// out (partitionSeeded), so each start's weight is nudged toward the
	// area it is owed until every start holds it to within a tenth. Equal
	// areas are the point: they are what keeps one player from starting in
	// a closet beside another's field (K, 2026-09-27).
	if (startCells > 0 && playerStarts.length) {
		for (let round = 0; round < 30; round++) {
			const area = new Array(seeds.length).fill(0);
			for (let c = 0; c < W * H; c++) if (!(water && water[c])) area[zone[c]]++;
			let off = 0;
			for (let i = 0; i < playerStarts.length; i++) {
				const r = startCells / Math.max(1, area[i]);
				off = Math.max(off, Math.abs(1 - r));
				weight[i] *= Math.max(0.5, Math.min(2.5, r ** 0.9));
			}
			if (off < 0.1) break;
			assign();
		}
	}
	return { zone, seeds, count: seeds.length };
}

// One start's zone at most, as a share of the land: a two-player map would
// otherwise hand each start a quarter of it; the largest start in K's
// templates holds about a fifth (Vortex, 0.21).
const MAX_START_SHARE = 0.2;

/**
 * The start a template zone's owner (a player number) names: the start that
 * carries that owner, or, when the starts carry none, the one at that place
 * in the list. With starts on both levels a level's list is not every
 * player's, so the place alone named the wrong player.
 */
function startOfOwner(playerStarts, owner) {
	const n = Number(owner);
	if (!n || !playerStarts) return undefined;
	if (playerStarts.some(s => s && s.owner)) return playerStarts.find(s => s && s.owner === n);
	return playerStarts[n - 1];
}

/** Steps from each cell to the nearest water cell (4-neighbour). */
function distanceToWater(W, H, water) {
	const d = new Float64Array(W * H).fill(Infinity);
	const q = [];
	for (let c = 0; c < W * H; c++) if (water[c]) { d[c] = 0; q.push(c); }
	for (let h = 0; h < q.length; h++) {
		const c = q[h], x = c % W, y = (c / W) | 0;
		for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
			if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
			const n = ny * W + nx;
			if (d[n] > d[c] + 1) { d[n] = d[c] + 1; q.push(n); }
		}
	}
	return d;
}

/** The dry cell nearest (x, y), searched ring by ring. */
function nearestLand(W, H, water, x, y) {
	for (let r = 1; r < W + H; r++)
		for (let dy = -r; dy <= r; dy++)
			for (let dx = -r; dx <= r; dx++) {
				if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
				const nx = x + dx, ny = y + dy;
				if (nx >= 0 && ny >= 0 && nx < W && ny < H && !water[ny * W + nx])
					return { x: nx, y: ny };
			}
	return { x, y };
}

/**
 * Partition into regions around explicit seeds with per-seed weights.
 *
 * Weight divides the distance: a zone twice as heavy wins ground twice as far
 * away, so area responds roughly quadratically, which is exactly what an RMG
 * template's zone `size` asks for (it is a radius, not an area -
 * CZonePlacer.cpp:565 normalizes size^2 sums).
 *
 * seeds: [{x,y,player}] in final order. Returns {zone, seeds, count}.
 */
function partitionSeeded(W, H, seeds, weights, rng, params) {
	const p = { ...BIOME_DEFAULTS, ...params };
	const amp = p.biomeWobble;
	const waves = wobbleWaves(W, H, seeds.length);
	const noise = amp > 0
		? seeds.map((_, i) => ({
			coarse: valueNoise(((rng() * 1e9) | 0) + i * 7919, waves.coarse),
			fine: process.env.VMAPGEN_EDGE === 'off' ? null
				: valueNoise(((rng() * 1e9) | 0) + i * 15485863 + 3247, waves.fine),
		}))
		: null;
	const zone = new Int16Array(W * H).fill(-1);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			let best = -1, bd = Infinity;
			for (let i = 0; i < seeds.length; i++) {
				const dx = x - seeds[i].x, dy = y - seeds[i].y;
				let d = dx * dx + dy * dy;
				if (noise) d *= 1 + amp * (noise[i].coarse(x, y) - 0.5)
					+ (noise[i].fine
						? amp * 0.35 * (noise[i].fine(x, y) - 0.5) : 0);
				d /= weights[i] || 1;
				if (d < bd) { bd = d; best = i; }
			}
			zone[y * W + x] = best;
		}
	return { zone, seeds, count: seeds.length };
}

/**
 * Eigenvalues and eigenvectors of a symmetric matrix, by cyclic Jacobi
 * rotations (the matrices here are a template's zone count across, at most a
 * few dozen). Returns {values, vectors}, ascending; vectors[k][i] is entry i.
 */
function symmetricEigen(M) {
	const n = M.length;
	const a = M.map(r => r.slice());
	const v = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
	for (let sweep = 0; sweep < 100; sweep++) {
		let off = 0;
		for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i][j] * a[i][j];
		if (off < 1e-20) break;
		for (let p = 0; p < n; p++)
			for (let q = p + 1; q < n; q++) {
				if (Math.abs(a[p][q]) < 1e-300) continue;
				const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
				const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
				const c = 1 / Math.sqrt(t * t + 1), s = t * c;
				for (let k = 0; k < n; k++) {
					const akp = a[k][p], akq = a[k][q];
					a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
				}
				for (let k = 0; k < n; k++) {
					const apk = a[p][k], aqk = a[q][k];
					a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
				}
				for (let k = 0; k < n; k++) {
					const vkp = v[k][p], vkq = v[k][q];
					v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
				}
			}
	}
	const order = [...Array(n).keys()].sort((i, j) => a[i][i] - a[j][j]);
	return { values: order.map(i => a[i][i]), vectors: order.map(i => v.map(row => row[i])) };
}

/**
 * A graph's spectral drawing: each node at (v2, v3), the eigenvectors of the
 * Laplacian for the two smallest non-zero eigenvalues. Neighbours land near
 * each other and a grid or ring comes out as one. null when the graph has
 * fewer than three nodes or is in pieces (a second zero eigenvalue).
 */
function spectralCoords(adj) {
	const n = adj.length;
	if (n < 3) return null;
	const L = Array.from({ length: n }, () => new Array(n).fill(0));
	for (let i = 0; i < n; i++)
		for (const j of adj[i]) { L[i][j] -= 1; L[i][i] += 1; }
	const { values, vectors } = symmetricEigen(L);
	if (values[1] < 1e-9) return null;
	return vectors[1].map((x, i) => ({ x, y: vectors[2][i] }));
}

/**
 * The turn, uniform scale and shift (mirrored if that fits better) that best
 * carries points `from` onto points `to`, least squares. Returns the map.
 */
function fitSimilarity(from, to) {
	const m = from.length;
	const mean = ps => ({ x: ps.reduce((s, q) => s + q.x, 0) / m, y: ps.reduce((s, q) => s + q.y, 0) / m });
	const fit = mirror => {
		const f = from.map(q => ({ x: mirror ? -q.x : q.x, y: q.y }));
		const fm = mean(f), tm = mean(to);
		let a = 0, b = 0, ss = 0;
		for (let i = 0; i < m; i++) {
			const px = f[i].x - fm.x, py = f[i].y - fm.y, qx = to[i].x - tm.x, qy = to[i].y - tm.y;
			a += px * qx + py * qy; b += px * qy - py * qx; ss += px * px + py * py;
		}
		const scale = ss ? Math.hypot(a, b) / ss : 1, th = Math.atan2(b, a);
		const cs = scale * Math.cos(th), sn = scale * Math.sin(th);
		const apply = q => {
			const x = (mirror ? -q.x : q.x) - fm.x, y = q.y - fm.y;
			return { x: tm.x + cs * x - sn * y, y: tm.y + sn * x + cs * y };
		};
		let err = 0;
		for (let i = 0; i < m; i++) { const r = apply(from[i]); err += (r.x - to[i].x) ** 2 + (r.y - to[i].y) ** 2; }
		return { apply, err };
	};
	const plain = fit(false), mirrored = fit(true);
	return (mirrored.err < plain.err ? mirrored : plain).apply;
}

/**
 * Lay out zone seeds so the template's connection graph mostly lands on real
 * shared borders.
 *
 * playerStart/cpuStart zones are pinned to their owner's start cell, as the
 * player has to start where the header says. Every other zone is positioned
 * by a few rounds of force layout: connected zones attract to just inside
 * touching distance, all zones repel to their combined radii. The radii use
 * the engine's own normalization - zone radius = template size scaled so the
 * size^2 sum matches the map area (CZonePlacer.cpp:565-585).
 *
 * Whatever still does not share a border after partitioning is wired up with
 * a portal pair by the caller, the same mechanism VCMI's RMG uses for links
 * it cannot draw as land.
 *
 * opts.init 'barycentric' (the default) starts each free zone where its links
 * put it rather than anywhere: with the starts held, every free zone moves to
 * the mean of the zones it links to until that settles (Tutte's embedding), so
 * a zone linking two starts begins between them and a hub begins among its
 * spokes. From random places the force layout often never recovered: Golem
 * Foundry's central Foundry ended on the map's edge, and 2 to 6 of its 12
 * links fell back to portals on every seed. opts.jitter moves each free zone
 * off that place by up to that many cells (zones with the same links would
 * otherwise sit on one point); 'random' is the old start.
 */
function layoutZoneSeeds(zoneSpecs, conns, W, H, playerStarts, rng, opts = {}) {
	const n = zoneSpecs.length;
	const sizes = zoneSpecs.map(z => z.size || 10);
	const mass = sizes.reduce((s, v) => s + v * v, 0);
	const prescaler = Math.sqrt((W * H) / (mass * Math.PI));
	const radius = sizes.map(s => Math.max(2, s * prescaler));

	const pos = zoneSpecs.map((z, i) => {
		const pinned = (z.type === 'playerStart' || z.type === 'cpuStart')
			&& z.owner && startOfOwner(playerStarts, z.owner);
		if (pinned) return { x: startOfOwner(playerStarts, z.owner).x, y: startOfOwner(playerStarts, z.owner).y, pin: true };
		return { x: 6 + rng() * (W - 12), y: 6 + rng() * (H - 12), pin: false };
	});

	const adj = Array.from({ length: n }, () => []);
	for (const c of conns) {
		const i = c.aRef && c.aRef.i, j = c.bRef && c.bRef.i;
		if (i === undefined || j === undefined || i === j) continue;
		adj[i].push(j); adj[j].push(i);
	}
	const jit = opts.jitter !== undefined ? opts.jitter : 1.5;
	// 'spectral': the link graph's own drawing, from the two smallest non-zero
	// eigenvectors of its Laplacian (spectralCoords), which unfolds grids and
	// rings the way they are meant to sit; held zones stay put and the drawing
	// is turned, scaled and moved onto them (fitSimilarity). Falls through to
	// the barycentric start when the link graph is in pieces.
	if (opts.init === 'spectral') {
		const sc = spectralCoords(adj);
		if (sc) {
			const held = [...Array(n).keys()].filter(i => pos[i].pin);
			let place;
			if (held.length >= 2) {
				const f = fitSimilarity(held.map(i => sc[i]), held.map(i => pos[i]));
				place = q => f(q);
			} else {
				// turned the way that fills the map best (a drawing from two
				// equal eigenvalues can come out at any angle), then stretched to it
				let bestA = 0, bestArea = Infinity;
				for (let deg = 0; deg < 90; deg += 7.5) {
					const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
					const xs = sc.map(q => c * q.x - s * q.y), ys = sc.map(q => s * q.x + c * q.y);
					const area = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
					if (area < bestArea - 1e-12) { bestArea = area; bestA = r; }
				}
				const c0 = Math.cos(bestA), s0 = Math.sin(bestA);
				for (const q of sc) { const x = q.x; q.x = c0 * x - s0 * q.y; q.y = s0 * x + c0 * q.y; }
				const xs = sc.map(q => q.x), ys = sc.map(q => q.y);
				const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
				place = q => ({ x: 6 + (q.x - x0) / ((x1 - x0) || 1) * (W - 12),
					y: 6 + (q.y - y0) / ((y1 - y0) || 1) * (H - 12) });
			}
			for (let i = 0; i < n; i++) {
				if (pos[i].pin) continue;
				const q = place(sc[i]);
				pos[i].x = Math.min(W - 4, Math.max(3, q.x + (rng() - 0.5) * 2 * jit));
				pos[i].y = Math.min(H - 4, Math.max(3, q.y + (rng() - 0.5) * 2 * jit));
			}
		} else opts = { ...opts, init: 'barycentric' };
	}
	if ((opts.init || 'barycentric') === 'barycentric' && pos.some(q => q.pin)) {
		// only zones linked, however indirectly, to a held one: a group with
		// none would shrink onto one point
		const held = pos.map(q => q.pin);
		for (let q = held.map((h, i) => (h ? i : -1)).filter(i => i >= 0), k = 0; k < q.length; k++)
			for (const j of adj[q[k]]) if (!held[j]) { held[j] = true; q.push(j); }
		for (let it = 0; it < 400; it++)
			for (let i = 0; i < n; i++) {
				if (pos[i].pin || !held[i] || !adj[i].length) continue;
				let sx = 0, sy = 0;
				for (const j of adj[i]) { sx += pos[j].x; sy += pos[j].y; }
				pos[i].x = sx / adj[i].length; pos[i].y = sy / adj[i].length;
			}
		for (const q of pos)
			if (!q.pin) {
				q.x = Math.min(W - 4, Math.max(3, q.x + (rng() - 0.5) * 2 * jit));
				q.y = Math.min(H - 4, Math.max(3, q.y + (rng() - 0.5) * 2 * jit));
			}
	}

	// opts.anchors: a point per zone or null, where the zones it links to on a
	// level already laid out sit (plan.js crossLevelAnchors). The engine places
	// both levels as one drawing, where a link between levels pulls its zones
	// together against everything else pushing them about; such a zone starts
	// on its anchor here and the level's own forces settle it from there. A
	// spring holding it on the anchor made nearly every link a gate pair; the
	// start alone lands where the corpus is (the late corpus's four two-level
	// maps: 70 gates and 78 monoliths against its 68 and 88; with a spring 74
	// and 76-82; without anchors 2 and 126).
	const anchors = opts.anchors || null;
	if (anchors)
		for (let i = 0; i < n; i++)
			if (anchors[i] && !pos[i].pin) {
				pos[i].x = Math.min(W - 4, Math.max(3, anchors[i].x + (rng() - 0.5) * 2 * jit));
				pos[i].y = Math.min(H - 4, Math.max(3, anchors[i].y + (rng() - 0.5) * 2 * jit));
			}
	for (let it = 0, iters = opts.iterations || 90; it < iters; it++) {
		const fx = new Array(n).fill(0), fy = new Array(n).fill(0);
		for (let i = 0; i < n; i++) {
			for (let j = i + 1; j < n; j++) {
				const dx = pos[j].x - pos[i].x, dy = pos[j].y - pos[i].y;
				const d = Math.hypot(dx, dy) || 0.01;
				const ux = dx / d, uy = dy / d;
				const want = radius[i] + radius[j];
				// repel to combined radius, gently
				if (d < want) {
					const f = (want - d) * 0.06;
					fx[i] -= ux * f; fy[i] -= uy * f;
					fx[j] += ux * f; fy[j] += uy * f;
				}
			}
		}
		// connected zones pull toward touching distance
		for (const c of conns) {
			const i = c.aRef && c.aRef.i, j = c.bRef && c.bRef.i;
			if (i === undefined || j === undefined) continue;
			const dx = pos[j].x - pos[i].x, dy = pos[j].y - pos[i].y;
			const d = Math.hypot(dx, dy) || 0.01;
			const want = (radius[i] + radius[j]) * 0.95;
			const f = (d - want) * 0.02;
			if (f <= 0) continue;
			const ux = dx / d, uy = dy / d;
			if (!pos[i].pin) { fx[i] += ux * f; fy[i] += uy * f; }
			if (!pos[j].pin) { fx[j] -= ux * f; fy[j] -= uy * f; }
		}
		// a repulsive link pushes its zones apart at any distance, as the
		// engine's placer does (CZonePlacer.cpp:694-700)
		for (const [i, j] of opts.repulse || []) {
			if (!pos[i] || !pos[j]) continue;
			const dx = pos[j].x - pos[i].x, dy = pos[j].y - pos[i].y;
			const d = Math.hypot(dx, dy) || 0.01;
			const f = (W + H) * 0.004;
			if (!pos[i].pin) { fx[i] -= dx / d * f; fy[i] -= dy / d * f; }
			if (!pos[j].pin) { fx[j] += dx / d * f; fy[j] += dy / d * f; }
		}
		for (let i = 0; i < n; i++) {
			if (pos[i].pin) continue;
			pos[i].x = Math.min(W - 4, Math.max(3, pos[i].x + fx[i]));
			pos[i].y = Math.min(H - 4, Math.max(3, pos[i].y + fy[i]));
		}
	}
	// A held start is its town's cell, and a start town sits near the map's
	// edge; a zone seeded right there keeps only a corner of the map, while a
	// central zone takes the middle (Jebus Cross: starts of size 30 got
	// 300-1900 cells of 11664, its size-40 centre 7000). The engine places the
	// zone and puts the town inside it, so the seed moves in from the town,
	// toward the map's middle, by half the zone's radius (opts.startInset,
	// 0 keeps the old seeding); the town stays where it is, and the caller
	// checks that its cell still falls in its own zone.
	const inset = opts.startInset !== undefined ? opts.startInset : 0.5;
	return zoneSpecs.map((z, i) => {
		let x = pos[i].x, y = pos[i].y;
		if (pos[i].pin && inset > 0) {
			const dx = W / 2 - x, dy = H / 2 - y, d = Math.hypot(dx, dy);
			const step = Math.min(inset * radius[i], d / 2);
			if (d > 0) { x += dx / d * step; y += dy / d * step; }
		}
		return { x: Math.round(x), y: Math.round(y),
			player: z.type === 'playerStart' || z.type === 'cpuStart' };
	});
}

/**
 * BFS distance over the biome-adjacency graph, seeded at every player biome.
 * Returns an array of hop counts per biome index; a biome with no path to a
 * player (possible before ensureConnected runs) counts as far, which is the
 * honest answer for a sealed pocket.
 */
function zoneDistances(seeds, edges) {
	const n = seeds.length;
	const adj = Array.from({ length: n }, () => []);
	for (const e of edges) { adj[e.a].push(e.b); adj[e.b].push(e.a); }
	const d = new Array(n).fill(Infinity);
	const q = [];
	for (let i = 0; i < n; i++)
		if (seeds[i].player) { d[i] = 0; q.push(i); }
	for (let qi = 0; qi < q.length; qi++)
		for (const b of adj[q[qi]])
			if (d[b] === Infinity) { d[b] = d[q[qi]] + 1; q.push(b); }
	for (let i = 0; i < n; i++) if (d[i] === Infinity) d[i] = 99;
	return d;
}

/**
 * Physical distance from the nearest player start, averaged per biome.
 * zoneDistances ranks by graph hops, but the corpus value gradient is
 * measured in cells: a treasure zone two hops away can still sit right
 * next to a start, and its 950/cell budget then lands inside the near
 * band. Ordering classes by mean cell distance lines the ranking up with
 * the metric that grades it.
 */
function physZoneDistances(zone, W, H, playerStarts, water = null, sail = false) {
	const dist = new Float64Array(W * H).fill(-1);
	const q = [];
	for (const s of playerStarts) {
		const c = s.y * W + s.x;
		if (dist[c] < 0) { dist[c] = 0; q.push(c); }
	}
	// over land only when there is water: nobody walks across a lake. On an
	// island map the sea is the road, so it counts as distance like land does.
	const dry = c => sail || !water || !water[c];
	for (let qi = 0; qi < q.length; qi++) {
		const c = q[qi], x = c % W, y = (c / W) | 0, nd = dist[c] + 1;
		if (x > 0 && dist[c - 1] < 0 && dry(c - 1)) { dist[c - 1] = nd; q.push(c - 1); }
		if (x < W - 1 && dist[c + 1] < 0 && dry(c + 1)) { dist[c + 1] = nd; q.push(c + 1); }
		if (y > 0 && dist[c - W] < 0 && dry(c - W)) { dist[c - W] = nd; q.push(c - W); }
		if (y < H - 1 && dist[c + W] < 0 && dry(c + W)) { dist[c + W] = nd; q.push(c + W); }
	}
	const sum = new Map(), cnt = new Map();
	let maxZ = -1;
	for (let c = 0; c < W * H; c++) {
		if (dist[c] < 0 || (sail && water && water[c])) continue;
		const z = zone[c];
		if (z > maxZ) maxZ = z;
		sum.set(z, (sum.get(z) || 0) + dist[c]);
		cnt.set(z, (cnt.get(z) || 0) + 1);
	}
	const out = new Array(maxZ + 1).fill(0);
	for (let i = 0; i <= maxZ; i++)
		if (cnt.has(i)) out[i] = sum.get(i) / cnt.get(i);
	return out;
}

/**
 * Assign content classes to non-player biomes per the ratio parameters.
 * Returns an array of BIOME_CLASS per biome index.
 *
 * With `dist` (zone-graph distance from the nearest player start, from
 * zoneDistances) the same class counts are kept but ordered by distance:
 * the nearest non-player zones draw lowLoot, the farthest draw highLoot,
 * standard fills the middle. VCMI zones carry an explicit treasure band
 * and the corpus shows the gradient (far zones run ~4x the value density
 * of start rings); a flat roll puts a rich zone next to a start half the
 * time. Town zones stay random - real maps put neutral towns in start
 * zones and treasure zones alike.
 */
function assignClasses(seeds, params, rng, dist = null) {
	const p = { ...BIOME_DEFAULTS, ...params };
	const classes = seeds.map(s => s.player ? BIOME_CLASS.PLAYER : null);
	const free = [];
	for (let i = 0; i < seeds.length; i++) if (!seeds[i].player) free.push(i);
	if (!dist) {
		// deterministic order, weighted fill
		for (const i of free) {
			const roll = rng();
			if (roll < p.townRatio) classes[i] = BIOME_CLASS.TOWN;
			else if (roll < p.townRatio + p.highLootRatio) classes[i] = BIOME_CLASS.HIGH_LOOT;
			else if (roll < p.townRatio + p.highLootRatio + p.lowLootRatio) classes[i] = BIOME_CLASS.LOW_LOOT;
			else classes[i] = BIOME_CLASS.STANDARD;
		}
		return classes;
	}
	const nT = Math.round(free.length * p.townRatio);
	const nH = Math.round(free.length * p.highLootRatio);
	const nL = Math.round(free.length * p.lowLootRatio);
	const towns = new Set();
	while (towns.size < nT && towns.size < free.length)
		towns.add(free[(rng() * free.length) | 0]);
	const sorted = free.filter(i => !towns.has(i))
		.sort((a, b) => dist[a] - dist[b] || a - b);
	for (let i = 0; i < nL && i < sorted.length; i++)
		classes[sorted[i]] = BIOME_CLASS.LOW_LOOT;
	for (let i = 0; i < nH && i < sorted.length; i++)
		classes[sorted[sorted.length - 1 - i]] = BIOME_CLASS.HIGH_LOOT;
	for (const i of sorted) if (!classes[i]) classes[i] = BIOME_CLASS.STANDARD;
	for (const i of towns) classes[i] = BIOME_CLASS.TOWN;
	return classes;
}

/**
 * Adjacency list over biomes: for every pair sharing a border, one edge.
 * Returns [{a, b, borderCells:[idx...]}].
 */
function biomeEdges(zone, W, H, count, water = null) {
	const edges = new Map(); // key = min*100000+max
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			const a = zone[y * W + x];
			// zones meet on land only; a zone line running on into the water
			// is no border anyone can cross
			if (water && water[y * W + x]) continue;
			if (x + 1 < W && zone[y * W + x + 1] !== a && !(water && water[y * W + x + 1])) {
				const b = zone[y * W + x + 1];
				const k = Math.min(a, b) * 100000 + Math.max(a, b);
				if (!edges.has(k)) edges.set(k, { a: Math.min(a, b), b: Math.max(a, b), borderCells: [] });
				edges.get(k).borderCells.push(y * W + x);
			}
			if (y + 1 < H && zone[(y + 1) * W + x] !== a && !(water && water[(y + 1) * W + x])) {
				const b = zone[(y + 1) * W + x];
				const k = Math.min(a, b) * 100000 + Math.max(a, b);
				if (!edges.has(k)) edges.set(k, { a: Math.min(a, b), b: Math.max(a, b), borderCells: [] });
				edges.get(k).borderCells.push(y * W + x);
			}
		}
	}
	return [...edges.values()];
}

// Portal/gate fidelity was tuned (interconnectPortal, subterraneanGateRatio)
// back when zoneCap capped every big map at 12 zones. The zoneCap fix (queue
// item 39, K, 2026-09-25: "density stays the same, you just get more zones")
// lets big maps carry far more zones and therefore far more zone-border
// edges, and both interconnectPortal and the gate-count formula are a flat
// share OF edges/openings, so absolute portal and gate counts scaled up with
// them: the free-layout lens read 2.33x corpus on portals and 5.23x on gates
// once zone counts actually grew (fidelity lens, 2026-09-25). The corpus
// doesn't scale portal/gate count with zone count the same way it scales
// zone count with area, so both are rescaled back down past REF_ZONES, the
// old effective ceiling every prior fidelity pass (including today's own
// gate-ratio tuning) was implicitly calibrated against.
const REF_ZONES = 12;
const portalGateScale = zoneCount => Math.min(1, REF_ZONES / Math.max(1, zoneCount));
// Portals take the square root of that. Scaling the portal share by
// REF_ZONES/zones held the portal count flat as maps grew (edges grow with
// zones, the share fell as 1/zones), while the corpus's count keeps rising
// with size: 0.42x the corpus on 144x144 and 0.54x on 144x144+U, against
// 1.0-1.2x on 36x36 and 72x72 (fidelity lens run T10, 2026-09-25). Gates keep
// portalGateScale; they read 1.19x with it.
const portalScale = zoneCount => Math.min(1, Math.sqrt(REF_ZONES / Math.max(1, zoneCount)));

/**
 * Decide the connection type per biome edge.
 * Returns map edgeKey -> 'portal' | 'openNoRoad' | 'openRoad' | 'blocked'.
 */
function assignConnections(edges, params, rng, zoneCount) {
	const p = { ...BIOME_DEFAULTS, ...params };
	const portalChance = p.interconnectPortal * portalScale(zoneCount);
	const out = new Map();
	for (const e of edges) {
		const key = e.a * 100000 + e.b;
		if (rng() >= p.interconnectivity) { out.set(key, 'blocked'); continue; }
		if (rng() < portalChance) { out.set(key, 'portal'); continue; }
		out.set(key, rng() < p.openPathNoRoad / (p.openPathNoRoad + p.openPathRoad)
			? 'openNoRoad' : 'openRoad');
	}
	return out;
}

/**
 * Force enough blocked borders open that every biome is reachable.
 *
 * assignConnections decides each border on its own coin flip, which says
 * nothing about whether the result is a connected map. Measured over fifteen
 * seeds per size, the main walkable region held 88% of open ground on a 36x36
 * and 83% on a 72x72 on average, but the tail was bad enough to ruin a map:
 * seed 5 on a 36x36 gave 43%, seed 17 on a 48x48 gave 29%, and seed 13 on a
 * 72x72 gave 6.4%, meaning both players spent the game inside one small pocket
 * of a large map. Nothing was broken in the sense a validator would catch,
 * since the fill keeps content inside the reachable region, and that is
 * precisely why it went unnoticed.
 *
 * Runs a union-find over the borders that are already open, then opens the
 * widest border joining an unreachable biome to a reachable one, repeating
 * until one component covers every biome. The widest border is chosen because
 * a wide shared edge gives the opening room to sit away from a corner.
 *
 * Mutates `connections` and returns how many borders it had to open.
 */
function ensureConnected(edges, connections, seedCount, params, rng) {
	const p = { ...BIOME_DEFAULTS, ...params };
	const parent = Array.from({ length: seedCount }, (_, i) => i);
	const find = a => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
	const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
	const key = e => e.a * 100000 + e.b;

	for (const e of edges)
		if (connections.get(key(e)) !== 'blocked') union(e.a, e.b);

	// biome 0 is a player start (partitionBiomes seeds those first), so its
	// component is the one the game is played in
	const root = () => find(0);
	let opened = 0;
	for (let guard = 0; guard < seedCount + 1; guard++) {
		const outside = [];
		for (let i = 0; i < seedCount; i++) if (find(i) !== root()) outside.push(i);
		if (!outside.length) break;
		// widest border between the main component and anything outside it
		let best = null;
		for (const e of edges) {
			const inA = find(e.a) === root(), inB = find(e.b) === root();
			if (inA === inB) continue;
			if (!best || e.borderCells.length > best.borderCells.length) best = e;
		}
		if (!best) {
			// nothing borders the main component. On an island map the other
			// islands are like that, and each still has to be one piece of its
			// own: open the widest border between any two components left.
			for (const e of edges) {
				if (find(e.a) === find(e.b)) continue;
				if (!best || e.borderCells.length > best.borderCells.length) best = e;
			}
			if (!best) break;   // biome with no shared border at all, nothing to open
		}
		const roadShare = p.openPathRoad / (p.openPathNoRoad + p.openPathRoad || 1);
		connections.set(key(best), rng() < roadShare ? 'openRoad' : 'openNoRoad');
		union(best.a, best.b);
		opened++;
	}
	return opened;
}

module.exports = { BIOME_CLASS, BIOME_DEFAULTS, partitionBiomes, partitionSeeded, wobbleWaves,
	layoutZoneSeeds, symmetricEigen, spectralCoords, fitSimilarity, assignClasses, zoneDistances, physZoneDistances,
	biomeEdges, assignConnections, ensureConnected, valueNoise,
	rimModeOf, rimLobeScale, bordersOff, nearestLand,
	REF_ZONES, portalGateScale, portalScale, MAX_START_SHARE, startOfOwner };
