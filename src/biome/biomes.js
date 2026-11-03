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
	// Layout family (familyConnections): 0 Mixed (each border on its own draw, as before), 1 Tree, 2 Sparse mesh, 3 Hub, 4 Pairs, 5 Ring,
	// 6 Chain, 7 Random (one of 1 to 6 from the seed)
	layoutFamily: 0,
	interconnectPortal: 0.20,
	openPathNoRoad: 0.55,
	// 0.37 roaded ~40% of non-portal openings and, with the town-linking
	// network on top, landed 5.60% road cells vs the corpus's 4.15%.
	// 0.26 targets ~4.2%.
	openPathRoad: 0.26,
	chokeGuardRatio: 0.7,
	// Guard gradient (2026-10-16): 0 leaves the guards between biomes as they are; up to 1 they run weaker near the starts and stronger
	// far from them (boundaries.js placeChokeGuards)
	guardGradient: 0,
	// Guards by distance (2026-10-21): 0 leaves every stack as it is; up to 1 the stacks nearest the starts run a level weaker and the
	// farthest a level stronger (guardDistance.js)
	guardDistance: 0,
	artifactDensity: 0.006,
	artifactRichness: 0.5,
	// 0.15 while the starts were small; once they took half the land (start
	// ZoneShare) the treasure biomes held half as much of the map, and the free
	// layout's level 6 and 7 guards read 0.62-0.69 of the corpus. 0.25 puts the
	// treasure biomes' share of the map back: levels 6-7 0.94-0.98, guards 1.05-
	// 1.08, banks 1.05-1.11 (lens t59F, 2026-09-27).
	highLootRatio: 0.25,
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
	// none, 1 the game's rule, 2 all of them. 0 by default (K, 2026-10-03, on a huge two-level map:
	// "4 players apparently spawned underground which should not be allowed by default on templates")
	// 0 All Overworld, 1 Mixed, 2 All Underground, 3 Random, 4 Template preference (stockChoices.js resolveUndergroundStarts).
	// 4 by default; the tab sends it like any default, so a Reset replaces whatever an earlier run stored (K, 2026-10-03)
	undergroundStarts: 4,
	mineDensity: 1.0,
	resourceDensity: 1.0,
	pickupDensity: 1.0,
	starterMines: true,
	// Obelisks and Grail (K, 2026-11-03): 0 as the template places them, 1 on any map, 2 none (and no Grail); applied after placement (generate.js)
	obelisks: 0,
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
	// Biome size variety: 0 every zone that is not a start the same size weight; up to 1 they draw unequal ones (partitionBiomes, and on a
	// template plan.js chooseTemplateLayout)
	zoneSizeVariety: 0,
	// Rich zones: 0 Far (the farthest from the starts; a template's own), 1 Centre, 2 Between the starts, 3 Random (plan.js richKeys)
	richPlacement: 0,
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
	guardShare: 1,
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
	guardPortals: 2,
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
	// Island shape (water.js adoptWater): 0 round islands, 1 ragged (K, 2026-10-14)
	islandShape: 1,
	dragonIslandLayout: 0,
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
/**
 * The Border wobble's scale on one seed's distance at one tile: 1 + amp (coarse - 0.5) + 0.35 amp (fine - 0.5). Its lowest value is
 * 1 - 0.675 amp, zero at wobble 1.48 and below zero at the slider's top (1.5): a seed whose noise dips there measured a distance of
 * nothing or less to every tile, took ground at any range, and no weight could win it back (2026-10-16). The floor keeps a distance
 * a distance; above it the wobble is unchanged, so the slider still bends borders up to its top. VMAPGEN_WOBBLE_FLOOR=0 is the old rule.
 */
const WOBBLE_FLOOR = 0.15;
// floor is WOBBLE_FLOOR, or -Infinity with the old rule; the caller reads the switch once per partition: read on every tile it made the
// template layouts about four times slower (the Opus Reviewer, pass 105: Coldshadow 108 Mediterranean seed 9, 35 s to 127 to 175 s)
const wobbleFloor = () => (process.env.VMAPGEN_WOBBLE_FLOOR === '0' ? -Infinity : WOBBLE_FLOOR);
function wobbleFactor(amp, coarse, fine, floor = WOBBLE_FLOOR) {
	const k = 1 + amp * (coarse - 0.5) + amp * 0.35 * (fine - 0.5);
	return k < floor ? floor : k;
}

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
	// the same domain warp as partitionSeeded (the free layout's borders wandered no more than a template's did), scaled by the Border
	// wobble slider as there: unscaled, wobble 0 was not straight lines and the slider moved border length a few percent at most
	// (MapGen Dev's lever test, the lead, 2026-10-14)
	const wobbleFree = Number.isFinite(Number(p.biomeWobble)) ? Math.min(2, Math.max(0, Number(p.biomeWobble)) / BIOME_DEFAULTS.biomeWobble) : 1;
	const warpK = process.env.VMAPGEN_ZONE_WARP !== undefined ? Number(process.env.VMAPGEN_ZONE_WARP) : (p.zoneWarp ?? 1.7) * wobbleFree;
	let wx = null, wy = null;
	if (warpK > 0) {
		const spacing = Math.sqrt(land / Math.max(1, seeds.length));
		const big = Math.max(6, Math.round(0.7 * spacing)), small = Math.max(3, Math.round(0.18 * spacing));
		const s0 = (rng() * 1e9) | 0;
		const n = [valueNoise(s0 + 11, big), valueNoise(s0 + 23, big), valueNoise(s0 + 37, small), valueNoise(s0 + 41, small)];
		const A = warpK * 0.28 * spacing, a2 = warpK * 0.07 * spacing * Number(process.env.VMAPGEN_ZONE_WARP_FINE || p.zoneWarpFine || 1);
		wx = new Float32Array(W * H); wy = new Float32Array(W * H);
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
			wx[y * W + x] = x + A * (n[0](x, y) - 0.5) * 2 + a2 * (n[2](x, y) - 0.5) * 2;
			wy[y * W + x] = y + A * (n[1](x, y) - 0.5) * 2 + a2 * (n[3](x, y) - 0.5) * 2;
		}
	}
	// A start keeps its own middle under any wobble (cause 4 of the playable gate, 2026-10-16): at Border wobble 1.5 the warp moves a
	// tile up to about a zone's spacing, so the tiles round a corner start were measured from far off and went to its neighbours (72x72,
	// 4 players, seed 1: the start's zone 20 tiles, a treasure zone 1546, the start walking 20 tiles). For a start's own distance the
	// warp fades out towards it: none within 0.2 of the reach its owed area gives it, all of it from 0.6 on, so its borders bend as
	// much as any other. Only for a start whose own tile the layout drawn the old way gave to a neighbour (below), so a layout where every
	// start keeps its tile is drawn as before (applied to every layout, it re-drew maps that were fine, and one redrawn 36x36 eight-player
	// seed 2 boxed a start in through a fill defect). VMAPGEN_START_WARP_GUARD=0 is the old rule.
	const startGuard = process.env.VMAPGEN_START_WARP_GUARD !== '0';
	const wfl = wobbleFloor();
	const spacing0 = Math.sqrt(land / Math.max(1, seeds.length));
	// each seed's squared distance field, noise and all, once (again with the guard when a start needs it)
	const fieldsOf = guarded => seeds.map((s, i) => {
		const f = new Float32Array(W * H);
		const R = s.player && guarded && guarded.has(i) && wx ? (reach[i] > 0 ? reach[i] / 0.8 : 0.5 * spacing0) : 0;
		for (let y = 0; y < H; y++)
			for (let x = 0; x < W; x++) {
				let px = wx ? wx[y * W + x] : x, py = wy ? wy[y * W + x] : y;
				if (R > 0) {
					const t = Math.min(1, Math.max(0, (Math.hypot(x - s.x, y - s.y) / R - 0.2) / 0.4));
					px = x + t * (px - x); py = y + t * (py - y);
				}
				const dx = px - s.x, dy = py - s.y;
				let d = dx * dx + dy * dy; // squared euclid, rounder blobs than Chebyshev
				if (noise) d *= wobbleFactor(amp, noise[i].coarse(x, y), noise[i].fine ? noise[i].fine(x, y) : 0.5, wfl);
				f[y * W + x] = d;
			}
		return f;
	});
	let field = fieldsOf(null);
	// Biome size variety (zoneSizeVariety, 0 to 1; 2026-10-16, the Template Factory's coverage table: 99 of the engine's 181 templates have
	// zones of unequal size, the largest at least twice the smallest): each zone that is not a start draws a size weight exp(1.5 v u), u from -1
	// to 1. Measured on 96x96, 4 starts, 14 zones, 12 seeds: the tenth-largest zone against the tenth-smallest 4.2 to 1 at 0, 7.2 at 0.5, 16.3 at 1. Starts keep theirs (the balancing below sizes them). Drawn only when it is
	// above 0, so a map at 0 is as before. VMAPGEN_ZONE_VARIETY=0 off.
	const variety = process.env.VMAPGEN_ZONE_VARIETY === '0' ? 0 : Math.min(1, Math.max(0, Number(p.zoneSizeVariety) || 0));
	const weight = seeds.map(s => (variety > 0 && !s.player ? Math.exp(1.5 * variety * (2 * rng() - 1)) : 1));
	const assign = () => {
		for (let c = 0; c < W * H; c++) {
			let best = -1, bd = Infinity;
			for (let i = 0; i < seeds.length; i++) {
				const d = field[i][c] / weight[i];
				if (d < bd) { bd = d; best = i; }
			}
			zone[c] = best;
		}
		// each zone in one piece before the areas are counted: run after the balancing, it moved whole pieces from
		// start to start (72x72, 4 starts, seed 1: 649, 529, 649, 794 of 648 each, 2026-10-02). Not with water: there a
		// zone's pieces on two islands are meant (each island has its own seed), and joining them across the water cut
		// players off from their boats (islands.test.js, 108x108 seed 1 and 72x72 seed 7)
		if (process.env.VMAPGEN_ZONE_WHOLE !== '0' && !water) zonesWhole(zone, W, H, seeds);
	};
	const grow = () => {
	assign();
	// Start zones grown to their area: a heavier seed wins ground farther
	// out (partitionSeeded), so each start's weight is nudged toward the
	// area it is owed until every start holds it to within a tenth. Equal
	// areas are the point: they are what keeps one player from starting in
	// a closet beside another's field (K, 2026-09-27).
	// The steps get gentler after the first few and the closest layout seen is kept: with each zone made whole inside
	// the loop, a piece changing hands could swing the areas back and forth past the tenth (144x144, 8 starts, seed 3,
	// 2026-10-02).
	if (startCells > 0 && playerStarts.length) {
		let best = Infinity, bestZone = null;
		for (let round = 0; round < 30; round++) {
			const area = new Array(seeds.length).fill(0);
			for (let c = 0; c < W * H; c++) if (!(water && water[c])) area[zone[c]]++;
			let off = 0;
			for (let i = 0; i < playerStarts.length; i++) off = Math.max(off, Math.abs(1 - startCells / Math.max(1, area[i])));
			if (off < best) { best = off; bestZone = zone.slice(); }
			if (off < 0.1) break;
			const step = round < 6 ? 0.9 : 0.45;
			for (let i = 0; i < playerStarts.length; i++)
				weight[i] *= Math.max(0.5, Math.min(2.5, (startCells / Math.max(1, area[i])) ** step));
			assign();
		}
		if (bestZone) zone.set(bestZone);
		// The weights move a whole lobe at a time, and a start whose border runs along one swung past its area both ways for all thirty
		// rounds (36x36 eight players seed 2: zone 4 at 39, 59 and 233 tiles in turn, kept at 59 of 81). What the loop leaves off by more
		// than a tenth is settled tile by tile against the zones beside it that are not starts: a short start takes their border tiles
		// nearest its own start, a large one gives them its border tiles farthest from it, then each zone is made whole again.
		// VMAPGEN_START_TRIM=0 off.
		if (process.env.VMAPGEN_START_TRIM !== '0') {
			const nS = playerStarts.length;
			const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
			const land = c => !(water && water[c]);
			for (let i = 0; i < nS; i++) {
				const sx = seeds[i].x, sy = seeds[i].y, d2 = c => (c % W - sx) ** 2 + (((c / W) | 0) - sy) ** 2;
				let area = 0;
				for (let c = 0; c < W * H; c++) if (zone[c] === i && land(c)) area++;
				for (let guard = 0; guard < W * H && (area < 0.9 * startCells || area > 1.1 * startCells); guard++) {
					const grow = area < 0.9 * startCells;
					let pick = -1, pz = -1, pd = grow ? Infinity : -1;
					for (let c = 0; c < W * H; c++) {
						if (!land(c)) continue;
						const x = c % W, y = (c / W) | 0;
						if (grow ? zone[c] < nS || zone[c] < 0 : zone[c] !== i) continue;
						let touches = -1;
						for (const [dx, dy] of dirs) {
							const nx = x + dx, ny = y + dy;
							if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
							const z2 = zone[ny * W + nx];
							if (grow ? z2 === i : z2 >= nS) { touches = grow ? zone[c] : z2; break; }
						}
						if (touches < 0) continue;
						const dd = d2(c);
						if (grow ? dd < pd : dd > pd) { pd = dd; pick = c; pz = touches; }
					}
					if (pick < 0) break;
					zone[pick] = grow ? i : pz;
					area += grow ? 1 : -1;
				}
			}
			if (process.env.VMAPGEN_ZONE_WHOLE !== '0' && !water) zonesWhole(zone, W, H, seeds);
		}
	}
	};
	grow();
	if (startGuard && wx && playerStarts.length) {
		// the starts whose own tile went to a neighbour: the town's ground handed back later (plan.js VMAPGEN_START_GROUND) is then cut off
		// from the zone's body, and the pass that keeps each zone in one piece keeps the town's patch and gives the body away (72x72 four
		// players wobble 1.5 seed 1: the start held 412 of the 649 tiles round it, then 20)
		const lostSet = new Set(playerStarts.map((s0, i) => i).filter(i => zone[seeds[i].y * W + seeds[i].x] !== i));
		const lost = lostSet.size > 0;
		if (lost) {
			field = fieldsOf(lostSet);
			for (let i = 0; i < playerStarts.length; i++) weight[i] = 1;
			grow();
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
/**
 * Each zone in one piece. A warped partition (zone warp, above) can leave a zone a main body and a few detached
 * fragments; a doorway that lands on a fragment opens onto nothing (Coldshadow's Fantasy seed 4, 2026-10-02: zones 8
 * and 16 cut off below, 535 objects dropped). Every fragment but the zone's largest joins the neighbouring zone it
 * shares the most border with. The cells that hold a seed always stay with it. Mutates zone; returns cells moved.
 */
// Repeated until a pass moves nothing (four at most): one pass could leave a fragment, a piece handed to a neighbour cutting
// another zone in two (72x72 two levels four players seed 7003: two cells of zone 4 left between zones 6 and 2, the only place
// zones 2 and 4 met, so their one doorway opened on those two cells and the rest of zone 4, 559 cells, had none and was
// swept empty). Each fragment goes to the neighbour it shares the most border with.
function zonesWhole(zone, W, H, seeds) {
	let moved = 0;
	for (let k = 0; k < 4; k++) { const m = zonesWholeOnce(zone, W, H, seeds); moved += m; if (!m) break; }
	return moved;
}

function zonesWholeOnce(zone, W, H, seeds) {
	const N = W * H, comp = new Int32Array(N).fill(-1), pieces = [];
	for (let c = 0; c < N; c++) {
		if (zone[c] < 0 || comp[c] >= 0) continue;
		const z = zone[c], cells = [c], id = pieces.length;
		comp[c] = id;
		for (let k = 0; k < cells.length; k++) {
			const x = cells[k] % W, y = (cells[k] / W) | 0;
			for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const m = ny * W + nx;
				if (zone[m] === z && comp[m] < 0) { comp[m] = id; cells.push(m); }
			}
		}
		pieces.push({ z, cells });
	}
	const keep = new Map();   // zone -> piece id to keep: the seed's, else the largest
	pieces.forEach((pc, id) => { const k = keep.get(pc.z); if (k === undefined || pieces[k].cells.length < pc.cells.length) keep.set(pc.z, id); });
	(seeds || []).forEach((s, i) => { const c = s.y * W + s.x; if (c >= 0 && c < N && zone[c] === i) keep.set(i, comp[c]); });
	let moved = 0;
	// small fragments first, so a fragment can join one that has already joined its neighbour
	const order = pieces.map((_, id) => id).filter(id => keep.get(pieces[id].z) !== id).sort((a, b) => pieces[a].cells.length - pieces[b].cells.length);
	for (const id of order) {
		const pc = pieces[id], count = new Map();
		for (const c of pc.cells) {
			const x = c % W, y = (c / W) | 0;
			for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const n = zone[ny * W + nx];
				if (n >= 0 && n !== pc.z) count.set(n, (count.get(n) || 0) + 1);
			}
		}
		let best = -1, bn = 0;
		for (const [n, k] of count) if (k > bn) { bn = k; best = n; }
		if (best < 0) continue;
		for (const c of pc.cells) zone[c] = best;
		moved += pc.cells.length;
	}
	return moved;
}

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
	const wfl = wobbleFloor();
	// Domain warp: each tile's position is pushed by a two-scale noise field before the distances are compared, so the
	// borders wander and zones take uneven outlines. Without it every zone was a straight-sided polygon (K, 2026-10-01:
	// "every single overworld biome is a fucking pentagon"; mapsight shape: zone ragged 1.00 against the engine's
	// 1.07 to 1.17). VMAPGEN_ZONE_WARP=0 turns it off; the number scales its strength (default 1).
	// The Border wobble slider scales it too (it read the same at 0, 0.6 and 1.5 on templates: the warp is most of what bends a
	// border, and "0 gives straight lines"): 1x at the default 0.6, none at 0, up to 2x at 1.2 and over.
	const wobbleK = Number.isFinite(p.biomeWobble) ? Math.min(2, Math.max(0, p.biomeWobble) / BIOME_DEFAULTS.biomeWobble) : 1;
	const warpK = process.env.VMAPGEN_ZONE_WARP !== undefined ? Number(process.env.VMAPGEN_ZONE_WARP)
		: (p.zoneWarp ?? 1) * wobbleK;
	let warp = null;
	if (warpK > 0) {
		const spacing = Math.sqrt(W * H / Math.max(1, seeds.length));
		const big = Math.max(6, Math.round(0.7 * spacing)), small = Math.max(3, Math.round(0.18 * spacing));
		const s0 = (rng() * 1e9) | 0;
		const n = [valueNoise(s0 + 11, big), valueNoise(s0 + 23, big), valueNoise(s0 + 37, small), valueNoise(s0 + 41, small)];
		const A = warpK * 0.28 * spacing, a2 = warpK * 0.07 * spacing * Number(process.env.VMAPGEN_ZONE_WARP_FINE || p.zoneWarpFine || 1);
		warp = (x, y) => [x + A * (n[0](x, y) - 0.5) * 2 + a2 * (n[2](x, y) - 0.5) * 2,
			y + A * (n[1](x, y) - 0.5) * 2 + a2 * (n[3](x, y) - 0.5) * 2];
	}
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			let best = -1, bd = Infinity;
			const [wx, wy] = warp ? warp(x, y) : [x, y];
			for (let i = 0; i < seeds.length; i++) {
				const dx = wx - seeds[i].x, dy = wy - seeds[i].y;
				let d = dx * dx + dy * dy;
				if (noise) d *= wobbleFactor(amp, noise[i].coarse(x, y), noise[i].fine ? noise[i].fine(x, y) : 0.5, wfl);
				d /= weights[i] || 1;
				if (d < bd) { bd = d; best = i; }
			}
			zone[y * W + x] = best;
		}
	if (process.env.VMAPGEN_ZONE_WHOLE !== '0') zonesWhole(zone, W, H, seeds);
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
		// an anchor with pin: true holds its zone's seed at that point, as a start's is held (MapGen Dev's centralized
		// dragon island, 2026-10-03: springs alone let the cluster drift apart); the zone's area share still comes from
		// the balancing and evenZoneAreas (plan.js)
		const a = opts.anchors && opts.anchors[i];
		if (a && a.pin) return { x: Math.min(W - 4, Math.max(3, a.x)), y: Math.min(H - 4, Math.max(3, a.y)), pin: true, held: true };
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

	// opts.anchors: a point per zone or null ({x, y, k} pulls the zone with strength k; {x, y, pin: true} holds it there,
	// above), where the zones it links to on a
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
		// a link to a zone on another level pulls in the plane with no rest
		// length: the engine's placer pulls both ends alike, and zones on two
		// levels "can overlap completely" (CZonePlacer::attractConnectedZones).
		// The other end is fixed here (a level laid out already, or a start
		// pinned below), so each such link is a spring to the anchor. Without
		// it the anchor was only where the zone began, and once starts could
		// lie below (template.js assignLevels) a level's pinned starts dragged
		// its zones off their anchors: [HotA] Nostalgia's gate sites found the
		// linked zone under them 2 to 5 times in 14. VMAPGEN_ANCHOR_PULL=0 turns
		// it off, for measuring.
		if (anchors && process.env.VMAPGEN_ANCHOR_PULL !== '0')
			for (let i = 0; i < n; i++) {
				const a = anchors[i];
				if (!a || pos[i].pin) continue;
				fx[i] += (a.x - pos[i].x) * 0.02 * (a.k || 1);
				fy[i] += (a.y - pos[i].y) * 0.02 * (a.k || 1);
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
		if (pos[i].pin && !pos[i].held && inset > 0) {
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
		if (zone[c] > maxZ) maxZ = zone[c];
		if (dist[c] < 0 || (sail && water && water[c])) continue;
		const z = zone[c];
		sum.set(z, (sum.get(z) || 0) + dist[c]);
		cnt.set(z, (cnt.get(z) || 0) + 1);
	}
	// a zone no start reaches is as far as a zone gets, as zoneDistances reads one no hop reaches
	const out = new Array(maxZ + 1).fill(Infinity);
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
function assignClasses(seeds, params, rng, dist = null, richKey = null) {
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
	if (richKey) {
		// Rich zones set to Centre or Between the starts (plan.js richKeys): the treasure zones are the best placed by that key, the
		// low-loot ones the nearest the starts of the rest
		const rich = sorted.slice().sort((a, b) => richKey.get(a) - richKey.get(b) || a - b).slice(0, nH);
		rich.forEach(i => { classes[i] = BIOME_CLASS.HIGH_LOOT; });
		const rest = sorted.filter(i => !classes[i]);
		for (let i = 0; i < nL && i < rest.length; i++) classes[rest[i]] = BIOME_CLASS.LOW_LOOT;
		for (const i of sorted) if (!classes[i]) classes[i] = BIOME_CLASS.STANDARD;
		for (const i of towns) classes[i] = BIOME_CLASS.TOWN;
		return classes;
	}
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
 * The links of a free layout of one family (Layout family, BIOME_DEFAULTS.layoutFamily): a skeleton chosen over the cut's borders, the
 * other borders closed. The cut stays as it is, so the zones and the starts' share of the land do not move. Mixed (0) never comes here:
 * assignConnections draws each border on its own, and ensureConnected then opens borders until every biome joins, so the borders that
 * carry links are whatever the cut gives and a layout ends near a tree plus the cut's loops (the Template Factory's Nostalgia rows: 0.91
 * and 0.96 open links a zone against the engine's 0.65 and 0.45, roster\BRIEF-MapVision-LayoutFamily.md).
 *   1 Tree: a spanning tree, widest borders first (each weighted by its length and a draw), one way between any two biomes.
 *   2 Sparse mesh: the tree and about one loop for every five biomes, each the border whose two biomes the tree keeps farthest apart.
 *   3 Hub: the biome nearest the map's middle that is not a start is the hub, and every start links to it; the other biomes hang off the
 *     hub or a start as a tree. No two starts meet directly.
 *   4 Pairs: the starts paired nearest first, each pair linked; the pairs and the other biomes joined by a tree. No two starts meet
 *     directly but a pair.
 *   5 Ring: the biomes on the map's rim linked round it in a circle; the inner biomes hang off it as a tree, so the ring is the one loop.
 *   6 Chain: the ring without the link farthest round it from every start: a line, its inner biomes hanging off as a tree.
 *   (7 Random is resolved by plan.js to one of 1 to 6 before this is called.)
 * From Hub on a link between two biomes that share no border is a portal pair, pushed onto ctx.pairs as [a, b] (plan.js bridges it
 * as it does a template link with no shared border, and ensureConnected counts it as joined); a start whose links are all such pairs also
 * takes its widest border to a biome that is not a start, so it leaves its zone on foot. ctx: { seeds (x, y, player), W, H, zone, water,
 * pairs }. A level with too few starts for Hub or Pairs, or too few rim biomes for Ring or Chain, is laid as Tree.
 * Biome connections (interconnectivity) opens up to a quarter of the remaining borders on top (none at 0; from Hub on never one between
 * two starts, and never Chain's left-out link), and Portal share (interconnectPortal) is the share of the links that are portal pairs.
 * Returns the same map as assignConnections.
 */
function familyConnections(family, edges, seedCount, params, rng, ctx = {}) {
	const p = { ...BIOME_DEFAULTS, ...params };
	const key = e => e.a * 100000 + e.b;
	const parent = Array.from({ length: seedCount }, (_, i) => i);
	const find = a => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
	const chosen = new Set();
	const adj = Array.from({ length: seedCount }, () => []);
	const take = e => { chosen.add(key(e)); adj[e.a].push(e.b); adj[e.b].push(e.a); };
	const order = edges.map(e => ({ e, w: e.borderCells.length * (0.5 + rng()) })).sort((u, v) => v.w - u.w).map(o => o.e);
	// from Hub on: the shape's own links first, then the tree over what is left
	const seeds = ctx.seeds || [], pairs = ctx.pairs || [];
	const isStart = i => !!(seeds[i] && seeds[i].player);
	const bordered = new Set();
	for (const e of edges) { bordered.add(e.a); bordered.add(e.b); }
	const starts = [...bordered].filter(isStart).sort((a, b) => a - b);
	const others = [...bordered].filter(i => !isStart(i)).sort((a, b) => a - b);
	// Ring and Chain: the biomes on the map's rim in the order a walk round its edge meets them (a biome met twice counts where it is met
	// first; water on the edge parts its two neighbours, whose link is then a portal pair)
	const rim = [];
	if ((family === 5 || family === 6) && ctx.zone && ctx.W && ctx.H) {
		const { zone, water, W, H } = ctx, seen = new Set();
		const at = (x, y) => { const c = y * W + x, z = zone[c]; if (!(water && water[c]) && bordered.has(z) && !seen.has(z)) { seen.add(z); rim.push(z); } };
		for (let x = 0; x < W; x++) at(x, 0);
		for (let y = 1; y < H; y++) at(W - 1, y);
		for (let x = W - 2; x >= 0; x--) at(x, H - 1);
		for (let y = H - 2; y >= 1; y--) at(0, y);
	}
	let dropped = -1;
	const shaped = (family === 3 && others.length > 0 && starts.length > 0) || (family === 4 && starts.length > 1)
		|| ((family === 5 || family === 6) && rim.length >= 3);
	if (shaped) {
		const unite = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
		const link = (a, b) => {
			const e = edges.find(e => e.a === Math.min(a, b) && e.b === Math.max(a, b));
			if (e) take(e);
			else { pairs.push([a, b]); adj[a].push(b); adj[b].push(a); }
			unite(a, b);
		};
		const d2 = (i, x, y) => (seeds[i].x - x) ** 2 + (seeds[i].y - y) ** 2;
		if (family === 3) {
			const mx = (ctx.W || 0) / 2, my = (ctx.H || 0) / 2;
			const hub = others.reduce((best, i) => (d2(i, mx, my) < d2(best, mx, my) ? i : best), others[0]);
			for (const s of starts) link(s, hub);
		} else if (family === 5 || family === 6) {
			// Chain leaves out the ring link farthest round the ring from every start on it (ties from a draw), so no start ends the line where
			// the ring has room (eight starts on a rim of eleven biomes leave every link beside a start)
			const n = rim.length, at = new Map(rim.map((z, i) => [z, i]));
			let cut = -1;
			if (family === 6) {
				const off = (rng() * n) | 0, onRim = starts.filter(s => at.has(s)).map(s => at.get(s));
				const round = (i, j) => Math.min(Math.abs(i - j), n - Math.abs(i - j));
				let best = -1;
				for (let j = 0; j < n; j++) {
					const k = (off + j) % n;
					const d = onRim.length ? Math.min(...onRim.map(s => Math.min(round(s, k), round(s, (k + 1) % n)))) : 0;
					if (d > best) { best = d; cut = k; }
				}
				const a = rim[cut], b = rim[(cut + 1) % n];
				dropped = Math.min(a, b) * 100000 + Math.max(a, b);
			}
			for (let k = 0; k < n; k++) if (k !== cut) link(rim[k], rim[(k + 1) % n]);
		} else {
			const cand = [];
			for (let i = 0; i < starts.length; i++) for (let j = i + 1; j < starts.length; j++)
				cand.push([starts[i], starts[j], d2(starts[i], seeds[starts[j]].x, seeds[starts[j]].y)]);
			cand.sort((u, v) => u[2] - v[2] || u[0] - v[0] || u[1] - v[1]);
			const paired = new Set();
			for (const [a, b] of cand) if (!paired.has(a) && !paired.has(b)) { paired.add(a); paired.add(b); link(a, b); }
		}
		// a start whose links are all portal pairs walks out too: its widest border to a biome that is not a start, one not joined yet first
		for (const s of starts) {
			if (adj[s].some(n => chosen.has(Math.min(s, n) * 100000 + Math.max(s, n)))) continue;
			const out = e => (e.a === s || e.b === s) && !isStart(e.a === s ? e.b : e.a);
			const e = order.find(e => out(e) && find(e.a) !== find(e.b)) || order.find(out);
			if (e) { take(e); unite(e.a, e.b); }
		}
	}
	for (const e of order) {
		if (shaped && isStart(e.a) && isStart(e.b)) continue;
		const ra = find(e.a), rb = find(e.b);
		if (ra === rb) continue;
		parent[rb] = ra;
		take(e);
	}
	const hops = (a, b) => {
		const d = new Array(seedCount).fill(-1), q = [a];
		d[a] = 0;
		for (let h = 0; h < q.length; h++) for (const n of adj[q[h]]) if (d[n] < 0) { d[n] = d[q[h]] + 1; q.push(n); }
		return d[b] < 0 ? Infinity : d[b];
	};
	if (family === 2) {
		const loops = Math.max(1, Math.round(seedCount / 5));
		for (let k = 0; k < loops; k++) {
			let best = null, bd = 2;
			for (const e of edges) {
				if (chosen.has(key(e))) continue;
				const d = hops(e.a, e.b);
				if (d !== Infinity && d > bd) { bd = d; best = e; }
			}
			if (!best) break;
			take(best);
		}
	}
	const rest = edges.filter(e => !chosen.has(key(e)) && !(shaped && isStart(e.a) && isStart(e.b)) && key(e) !== dropped);
	for (let i = rest.length - 1; i > 0; i--) { const j = (rng() * (i + 1)) | 0; [rest[i], rest[j]] = [rest[j], rest[i]]; }
	const extra = Math.round(Math.max(0, Math.min(1, Number(p.interconnectivity) || 0)) * 0.25 * rest.length);
	for (let i = 0; i < extra; i++) take(rest[i]);
	const noRoad = p.openPathNoRoad / ((p.openPathNoRoad + p.openPathRoad) || 1);
	const out = new Map();
	// Hub and Pairs: a start keeps one land link whatever Portal share draws
	const land = new Map();
	const keepWay = family >= 3;
	if (keepWay) for (const e of edges) if (chosen.has(key(e))) for (const z of [e.a, e.b]) if (isStart(z)) land.set(z, (land.get(z) || 0) + 1);
	const lastWay = e => keepWay && [e.a, e.b].some(z => isStart(z) && land.get(z) === 1);
	for (const e of edges) {
		if (!chosen.has(key(e))) { out.set(key(e), 'blocked'); continue; }
		if (rng() < p.interconnectPortal && !lastWay(e)) {
			for (const z of [e.a, e.b]) if (isStart(z)) land.set(z, land.get(z) - 1);
			out.set(key(e), 'portal'); continue;
		}
		out.set(key(e), rng() < noRoad ? 'openNoRoad' : 'openRoad');
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
function ensureConnected(edges, connections, seedCount, params, rng, joined = []) {
	const p = { ...BIOME_DEFAULTS, ...params };
	const parent = Array.from({ length: seedCount }, (_, i) => i);
	const find = a => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
	const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
	const key = e => e.a * 100000 + e.b;

	for (const e of edges)
		if (connections.get(key(e)) !== 'blocked') union(e.a, e.b);
	// pairs already joined some other way: a monolith pair, or both reaching the other level (plan.js)
	for (const [a, b] of joined) if (a >= 0 && b >= 0 && a < seedCount && b < seedCount) union(a, b);

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
	biomeEdges, assignConnections, familyConnections, ensureConnected, valueNoise, zonesWhole,
	rimModeOf, rimLobeScale, bordersOff, nearestLand,
	REF_ZONES, portalGateScale, portalScale, MAX_START_SHARE, startOfOwner };
