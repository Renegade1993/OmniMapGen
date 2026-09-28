/**
 * plan.js - biome-level planner: partition -> classify -> connect -> carve.
 *
 * Produces, per level:
 *   - zone assignment (Int16Array cell->biome)
 *   - per-biome terrain domain (a tile-id mask the WFC must satisfy)
 *   - barrier cells (decorative blocking objects)
 *   - openings: path holes (roaded or not) and portal object pairs
 *   - chokepoint guards (monster placeholders)
 *   - subterranean gates when the level is underground-linked
 *
 * Every tunable lands in BIOME_DEFAULTS; callers pass overrides per the
 * Nostalgia parameter list.
 */
'use strict';

const { BitSet } = require('../wfc/bitset');
const { xorshift } = require('../wfc/solver');
const {
	BIOME_CLASS, BIOME_DEFAULTS,
	partitionBiomes, partitionSeeded, layoutZoneSeeds,
	assignClasses, zoneDistances, physZoneDistances, biomeEdges,
	assignConnections, ensureConnected, rimModeOf, nearestLand,
	portalGateScale, MAX_START_SHARE, startOfOwner,
} = require('./biomes');
const { settleZonesOnLand } = require('./water');
const { fitCave } = require('./cavefit');
const { placeHarbours, fillWater, sailLinksFor } = require('./waterfill');
const { ZONE_CLASS, MONSTER_BAND, MINE_SUBTYPE, guardToLevel,
	pileLoot } = require('../rmg/template');
const { zoneTownTypes } = require('./zoneTowns');
const { carveBoundaries, placeChokeGuards } = require('./boundaries');
const { buildRoadNetwork, pruneOrphanRoads, approach: roadApproach } = require('./roadnet');
const { planRoads, joinFailed, pruneTails } = require('./roadplan');
const { phase } = require('../main/phases');
const { linkBook } = require('./portals');
const { fillBiome, blockingCells, footprintFits, footprintBlock, entranceOpen,
	visitableCells, reserveCell, makeConnectivityGuard, floodFrom, OCCUPIED,
	RESERVED, APPROACH, markApproach, allowedDirs, REMOVABLE_TYPES,
	weldsMasses, MONSTER_OPTIONS, monsterOptions, zoneGuardPool, engineGuard,
	reachOnReserved } = require("./content");
const { mineTemplate, STARTER_MINES, MINES_PER_PLAYER, STRUCTURES,
	STRUCTURE_SUBTYPE, barrierTemplate, pileTemplate,
	chestTemplate } = require('./economy');
const { wallClusters, singleTemplate, packFor, DECOR_TYPES,
	mergedTemplate } = require('./decor');
const { retileLevel } = require('./retile');
const { fillRimRows } = require('./rimfill');
const DECOR_TYPES_SET = new Set(DECOR_TYPES);
const { OBJECT_TEMPLATES } = require('../stitch/zones');

/**
 * visitableFrom is a 3x3 grid of the directions a hero may arrive from, and
 * ---/+-+/+++ is the front-facing one nearly every real object uses: not from
 * the north row, from anywhere else.
 *
 * An earlier comment claimed the field never restricts movement because
 * visitDir showed up only in ObjectTemplate and the RMG. That was wrong:
 * CMap::checkForVisitableDir (CMap.cpp:346-358) consults it on the
 * destination tile AND the source tile of every step, so a front-facing
 * object cannot be entered or left through its north face. Approach cells
 * everywhere in this file are the visitableFrom-permitted ones.
 */
const VISIT_FRONT = ['---', '+-+', '+++'];
const OBJECT_DEFS = {
	monolithTwoWay: STRUCTURES.monolithTwoWay,
	subterraneanGate: STRUCTURES.subterraneanGate,
	// Both halves are plain AvTCave. This used to be hota/subgates/HAExit01,
	// a mod-scoped path on a map whose header declares no mod requirements, so
	// anyone without HotA installed got a gate with no sprite.
	subterraneanGateUnder: STRUCTURES.subterraneanGateUnder,
	randomHero: { animation: 'avxhero', mask: ['VB', 'VA'], visitableFrom: VISIT_FRONT },
};

/**
 * Biome class -> preferred terrain families (land only), weighted.
 *
 * Reweighted 2026-09-24 (queue item 24) against the corpus's surface mix over
 * core terrains (`.tmp/opus/surfacemix.js`; mod terrains, a third of corpus
 * floor, left out): dirt 22.9%, grass 23.4, snow 20.2, rough 10.8, sand 9.9,
 * swamp 8.3, lava 4.5. The old lists put rough in three classes and gave
 * lava a third of the high-loot draws, and ours ran dirt 15.1, grass 21.9,
 * snow 13.2, rough 16.1, sand 12.5, swamp 9.8, lava 11.4 (lava 15.6% of
 * 144x144 surfaces). The engine draws a zone's terrain from the template's
 * allowed list and gives a town zone its faction's native ground, with no
 * notion of a "hostile" terrain for loot zones. Player starts are pinned to
 * their faction's native terrain after this (castle, rampart and conflux
 * grass; necropolis and dungeon dirt; tower snow; inferno lava; stronghold
 * rough; fortress swamp), so these weights only steer the other zones.
 */
const CLASS_TERRAIN_HINT = {
	[BIOME_CLASS.PLAYER]:    ['grass', 'dirt'],
	// First weights (grass 3 in town and standard, swamp in town, dirt 2 in
	// high loot) landed grass 27.9 / dirt 18.2 / swamp 11.7 on a 12-map
	// probe; nudged once, inside the ~3-point noise of ~150 zone draws.
	[BIOME_CLASS.TOWN]:      [['grass', 2], ['dirt', 3], ['snow', 2], ['rough', 1]],
	[BIOME_CLASS.HIGH_LOOT]: [['snow', 3], ['dirt', 3], ['rough', 2], ['sand', 2], ['lava', 1], ['swamp', 1]],
	[BIOME_CLASS.STANDARD]:  [['grass', 2], ['dirt', 3], ['snow', 3], ['rough', 1], ['sand', 2], ['swamp', 1]],
	// cactus only lives on sa, so sand keeps a real share here
	[BIOME_CLASS.LOW_LOOT]:  [['dirt', 3], ['snow', 2], ['sand', 2], ['rough', 2], ['grass', 1]],
};

/**
 * The same, for a carved level, where the surface hints name nothing that
 * exists.
 *
 * Only three terrains allow the underground layer at all: subterranean, lava
 * and the modded stardust. None of them is grass, dirt, rough, snow, swamp or
 * sand, so every class except HIGH_LOOT matched nothing, fell through to the
 * whole pool and rolled a coin. HIGH_LOOT hints 'lava' and always took it. The
 * result was a cave system 73.9% lava.
 *
 * Real undergrounds are subterranean stone with lava for the hot corners:
 * across the corpus's 32 two-level maps, 80.6% subterranean, 9.0% lava, 8.2%
 * stardust, 2.2% ice. Dropping the two modded terrains, which a core-only map
 * cannot use anyway, that is about 90 to 10.
 */
const CLASS_TERRAIN_HINT_UNDERGROUND = {
	// Entries carry weights: [hint, weight]. The draw used to be even between
	// the listed hints, so lava's share was whatever share of the zones was
	// high-loot - nothing on a small map, a fifth on a 96x96. The corpus's
	// undergrounds run about one tenth lava no matter the size, and the only
	// way to hold that is to weight the draw itself.
	[BIOME_CLASS.TOWN]:      [['subterra', 9], ['lava', 1]],
	[BIOME_CLASS.HIGH_LOOT]: [['subterra', 9], ['lava', 1]],
	[BIOME_CLASS.STANDARD]:  [['subterra', 9], ['lava', 1]],
	[BIOME_CLASS.LOW_LOOT]:  [['subterra', 9], ['lava', 1]],
};

/**
 * Choose one terrain shortId per biome, biased by the biome's class.
 *
 * Two kinds of terrain are excluded before anything else, and both used to get
 * through. Impassable terrain was eligible: rock carries a negative move cost
 * and is meant as the solid filler around underground passages, so a biome
 * assigned rock became a hole in the map that nothing could cross. A generated
 * 36x36 test map came out 35 percent rock this way. Water was eligible too,
 * which strands any hero without a boat. Terrain must also belong to the level
 * it is placed on, since subterranean stone is underground only and most
 * ground types are surface only.
 *
 * The class hint used to be matched on its FIRST LETTER against the two
 * character short code, so 'grass' matched 'rg' (rough) as readily as 'gr',
 * and 'dirt' matched a modded 'sd' stardust terrain. Matching now runs against
 * the terrain's real identifier.
 */
function assignTerrains(classes, terrainShortIds, rng, terrainInfo, underground, terrainPrefs) {
	const layer = underground ? 'underground' : 'surface';
	const usable = terrainShortIds.filter(id => {
		const t = terrainInfo && terrainInfo.get(id);
		if (!t) return false;
		if (!(t.moveCost > 0)) return false;               // rock
		const layers = t.allowedLayers || [];
		if (!layers.length) return false;                  // water and rock
		return layers.includes(layer);
	});
	// never return an empty pool: an unusable map beats no map only in that it
	// is easier to notice, so fall back loudly rather than throwing
	const pool = usable.length ? usable : [...terrainShortIds];
	if (!usable.length)
		console.error(`[gen] no passable ${layer} terrain indexed, falling back to all`);
	const nameOf = id => {
		const t = terrainInfo && terrainInfo.get(id);
		const n = t && t.name ? String(t.name) : String(id);
		return n.slice(n.lastIndexOf(':') + 1).toLowerCase();
	};
	// A template zone takes its terrain the engine's way
	// (TerrainPainter::initTerrainType, ZoneOptions::getTerrainTypes): one drawn
	// evenly from its terrainTypes, or when it lists none from every passable
	// land terrain the map may use less its bannedTerrains, either level's;
	// then a terrain its level does not allow becomes dirt on the surface and
	// subterranean underground. A start zone's town terrain is laid over this
	// afterwards (matchTerrainToTown, planMap). Class hints drew core terrains,
	// grass most of all: the late corpus's template maps run grass at 6.3% of
	// their cells and mod terrains at 18.7%, ours ran 24.7% and 3.7%
	// (.tmp\opus\terrain_mix.js, lens run t26L, 2026-09-26).
	const landAll = terrainShortIds.filter(id => {
		const t = terrainInfo && terrainInfo.get(id);
		return t && t.moveCost > 0 && (t.allowedLayers || []).length;
	});
	const coreNamed = name => {
		let any = null;
		for (const [id, t] of terrainInfo || []) {
			if (t.identifier !== name || !terrainShortIds.includes(id)) continue;
			if (String(t.name).startsWith('core:')) return id;
			any = any || id;
		}
		return any;
	};
	const demote = id => {
		const t = terrainInfo && terrainInfo.get(id);
		if (!t || (t.allowedLayers || []).includes(layer)) return id;
		return coreNamed(underground ? 'subterra' : 'dirt') || id;
	};
	const tplTerrain = z => {
		const names = (z.terrainTypes || []).map(s => String(s).slice(String(s).lastIndexOf(':') + 1).toLowerCase());
		const banned = new Set((z.bannedTerrains || []).map(s => String(s).slice(String(s).lastIndexOf(':') + 1).toLowerCase()));
		let from = names.length ? landAll.filter(id => names.includes(nameOf(id)))
			: landAll.filter(id => !banned.has(nameOf(id)));
		if (!from.length) from = landAll.length ? landAll : pool;
		return demote(from[(rng() * from.length) | 0]);
	};
	return classes.map((cls, i) => {
		const zoneRec = terrainPrefs && terrainPrefs[i];
		// a template zone's own record (planMap passes the zones themselves);
		// VMAPGEN_TPL_TERRAIN=class keeps the class hints for a measurement run
		const isZone = zoneRec && typeof zoneRec === 'object' && !Array.isArray(zoneRec);
		if (isZone && process.env.VMAPGEN_TPL_TERRAIN !== 'class') return tplTerrain(zoneRec);
		// the class hints: a template's terrainTypes list, an explicit name
		// set, wins over them; a name nothing indexed is ignored rather than
		// fatal, since modded terrain lists often name things this install lacks
		const pref = isZone ? zoneRec.terrainTypes : zoneRec;
		const table = underground ? CLASS_TERRAIN_HINT_UNDERGROUND : CLASS_TERRAIN_HINT;
		const entry = table[cls] || table[BIOME_CLASS.STANDARD];
		// Entries of [hint, weight] pairs are drawn weighted; a template's
		// terrainTypes override is a plain name list and stays an even pick.
		const weighted = !pref && typeof entry[0] === 'object';
		const hints = pref && pref.length
			? pref.map(s => String(s).toLowerCase())
			: (weighted ? entry.map(e => e[0]) : entry);
		const match = pool.filter(id => hints.some(h => nameOf(id).includes(h)));
		const from = match.length ? match : pool;
		if (weighted && match.length) {
			let sum = 0;
			const w = from.map(id => {
				const wi = hints.findIndex(h => nameOf(id).includes(h));
				sum += entry[wi][1];
				return entry[wi][1];
			});
			let roll = rng() * sum;
			for (let k = 0; k < from.length; k++) {
				roll -= w[k];
				if (roll <= 0) return from[k];
			}
			return from[from.length - 1];
		}
		return from[(rng() * from.length) | 0];
	});
}

/**
 * Per-cell domain masks: every cell restricted to the tile ids belonging to
 * its biome's terrain. tiles: dictionary [{shortId,...}]; tileIdsByShort:
 * Map<shortId, number[]>.
 */
function buildCellDomains(zone, biomeTerrain, tileIdsByShort, numTiles) {
	const domainByBiome = new Map(); // biome -> BitSet
	const getDomain = b => {
		if (!domainByBiome.has(b)) {
			const d = new BitSet(numTiles);
			for (const tid of tileIdsByShort.get(biomeTerrain[b]) || []) d.set(tid);
			domainByBiome.set(b, d);
		}
		return domainByBiome.get(b);
	};
	// Return one BitSet per cell (shared references - solver only reads them)
	return cell => getDomain(zone[cell]);
}

function objectEntry(type, x, y, l, tpl, subtype = 'object', opts) {
	const template = { animation: tpl.animation, editorAnimation: '', mask: tpl.mask };
	if (tpl.visitableFrom) template.visitableFrom = tpl.visitableFrom;
	const entry = {
		instanceName: `${type}_${x}_${y}_${l}`,
		l, x, y, type, subtype,
		template,
	};
	if (opts) entry.options = opts;
	return entry;
}

/** A monolith of a channel (portals.js); a mod's channel declares its mod. */
function monolithEntry(x, y, l, ch) {
	const e = objectEntry('monolithTwoWay', x, y, l, ch.tpl, ch.subtype);
	if (ch.mod) e.mod = ch.mod;
	return e;
}

/**
 * The largest walkable region of a level, as a Uint8Array flag per cell.
 *
 * Eight way flood fill, matching how heroes move. When the level has player
 * starts, the region containing them wins regardless of size, since that is
 * the one the game is played in. Otherwise the biggest region wins, which is
 * the right answer for an underground level reached through gates.
 */
function mainComponent(W, H, levelIndex, blocked, playerStarts) {
	const base = levelIndex * W * H;
	const seen = new Uint8Array(W * H);
	const best = new Uint8Array(W * H);
	let bestSize = 0, bestHasStart = false;
	const startCells = new Set((playerStarts || []).map(s => s.y * W + s.x));

	for (let seed = 0; seed < W * H; seed++) {
		if (seen[seed] || (blocked[base + seed] & OCCUPIED)) continue;
		const region = [];
		const stack = [seed];
		seen[seed] = 1;
		let hasStart = false;
		while (stack.length) {
			const c = stack.pop();
			region.push(c);
			const x = c % W, y = (c / W) | 0;
			for (let dy = -1; dy <= 1; dy++)
				for (let dx = -1; dx <= 1; dx++) {
					if (!dx && !dy) continue;
					const nx = x + dx, ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
					const n = ny * W + nx;
					if (seen[n] || (blocked[base + n] & OCCUPIED)) continue;
					seen[n] = 1;
					stack.push(n);
				}
		}
		// a start's own cell is blocked by its town, so check the neighborhood
		for (const c of region) {
			const x = c % W, y = (c / W) | 0;
			for (const st of startCells) {
				const sx = st % W, sy = (st / W) | 0;
				if (Math.abs(sx - x) <= 3 && Math.abs(sy - y) <= 3) { hasStart = true; break; }
			}
			if (hasStart) break;
		}
		const better = hasStart && !bestHasStart
			|| (hasStart === bestHasStart && region.length > bestSize);
		if (better) {
			best.fill(0);
			for (const c of region) best[c] = 1;
			bestSize = region.length;
			bestHasStart = hasStart;
		}
	}
	return best;
}

/**
 * The union of everything floodable from a set of entry cells. mainComponent
 * picks ONE region, which is wrong once the underground is entered through
 * gates and portal endpoints that each open their own pocket: a chamber that
 * is only reachable by teleport is still reachable. Seeds are the open cells
 * a hero stands on to use the entrance (its approach cells), computed by the
 * caller, so nothing floods a pocket that merely touches an entrance wall.
 */
function reachableUnion(W, H, levelIndex, blocked, seedCells) {
	const out = new Uint8Array(W * H);
	const scratch = new Uint8Array(W * H);
	for (const c of seedCells || []) {
		if (c < 0 || out[c] || (blocked[levelIndex * W * H + c] & OCCUPIED)) continue;
		floodFrom(blocked, levelIndex, W, H, c, scratch);
		for (let k = 0; k < W * H; k++) if (scratch[k]) out[k] = 1;
	}
	return out;
}

/**
 * Grow a reach mask along links (queue 27, water W3). A link is a pair of cell
 * lists: the open ground in front of each end of a two-way monolith pair, or a
 * boat's boarding cells and the shore of the water it sails. Reaching any cell
 * of one side opens every cell of the other, and the walk carries on 8-way
 * from there over whatever `isBlocked` leaves open. A boat link is one-way
 * (third element true): its boarding ground reaches every shore, but standing
 * on a shore gives nobody a boat. Mutates and returns `seen`.
 */
function followLinks(seen, links, W, H, isBlocked) {
	if (!links || !links.length) return seen;
	const used = new Uint8Array(links.length);
	for (let grew = true; grew;) {
		grew = false;
		for (let i = 0; i < links.length; i++) {
			if (used[i]) continue;
			const [a, b, oneWay] = links[i];
			const inA = a.some(c => seen[c]), inB = !oneWay && b.some(c => seen[c]);
			if (!inA && !inB) continue;
			used[i] = 1;
			grew = true;
			const stack = [];
			for (const c of inA ? b : a)
				if (!seen[c] && !isBlocked(c)) { seen[c] = 1; stack.push(c); }
			while (stack.length) {
				const c = stack.pop();
				const x = c % W, y = (c / W) | 0;
				for (let dy = -1; dy <= 1; dy++)
					for (let dx = -1; dx <= 1; dx++) {
						if (!dx && !dy) continue;
						const nx = x + dx, ny = y + dy;
						if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
						const n = ny * W + nx;
						if (!seen[n] && !isBlocked(n)) { seen[n] = 1; stack.push(n); }
					}
			}
		}
	}
	return seen;
}

/** Open cells a hero stands on to use an object placed at (x,y) - only the
 * directions its visitableFrom permits. */
function approachCells(tpl, x, y, l, W, H, blocked) {
	const out = [];
	for (const [vx, vy] of visitableCells(tpl, x, y))
		for (const [dx, dy] of allowedDirs(tpl)) {
			const nx = vx + dx, ny = vy + dy;
			if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
			const c = ny * W + nx;
			if (!(blocked[l * W * H + c] & OCCUPIED)) out.push(c);
		}
	return out;
}

/**
 * The engine joins every link of a zone to the zone's free paths
 * (ConnectionsPlacer: each connection's path is connected to
 * zone.freePaths(), which starts at the zone's centre), and no object or guard
 * may stand on them or over them (TreasurePlacer.cpp:1071). Our roads join
 * only the links that carry one, so a zone whose links have none (a treasure
 * zone below, reached by a gate and a monolith) held no way between them, and
 * a treasure guard could take its only corridor: on [HotA] Nostalgia seed 5001
 * one did in zone 7, and purple was cut off from blue's group. Here each
 * zone's gates, monoliths, town gate, doorways and roads are joined by paths
 * held clear (RESERVED), laid around every guard standing so far. Returns the
 * cells newly held.
 */
function holdFreePaths(plan, l, W, H, blocked) {
	const N = W * H, base = l * N, zone = plan.zone;
	const reach = new Set();
	const groups = new Map();
	const addGroup = (z, cells) => {
		const g = cells.filter(c => c >= 0 && c < N && zone[c] === z && !(blocked[base + c] & OCCUPIED));
		if (!g.length) return;
		if (!groups.has(z)) groups.set(z, []);
		groups.get(z).push(new Set(g));
	};
	for (const o of plan.objects) {
		if (!o.template || (o.l || 0) !== l) continue;
		if (/^(monster|randomMonster)/.test(o.type)) {
			for (const [vx, vy] of visitableCells(o.template, o.x, o.y))
				for (let dy = -1; dy <= 1; dy++)
					for (let dx = -1; dx <= 1; dx++) {
						const nx = vx + dx, ny = vy + dy;
						if (nx >= 0 && ny >= 0 && nx < W && ny < H) reach.add(ny * W + nx);
					}
			continue;
		}
		if (o.type !== 'monolithTwoWay' && o.type !== 'subterraneanGate'
				&& !(/town/i.test(o.type) && !/gate/i.test(o.type))) continue;
		const cells = approachCells(o.template, o.x, o.y, l, W, H, blocked);
		if (cells.length) addGroup(zone[cells[0]], cells);
	}
	for (const o of plan.openings || [])
		for (const z of [o.a, o.b]) addGroup(z, o.hole || []);
	const roadsBy = new Map();
	for (const c of plan.roadCells || []) {
		if (!roadsBy.has(zone[c])) roadsBy.set(zone[c], []);
		roadsBy.get(zone[c]).push(c);
	}
	for (const [z, cells] of roadsBy) addGroup(z, cells);
	let held = 0;
	for (const [z, gs] of groups) {
		if (gs.length < 2) continue;
		const joined = new Set(gs[0]);
		const rest = gs.slice(1);
		while (rest.length) {
			// out from what is joined to the nearest cell of a group not yet
			const prev = new Map();
			const q = [...joined];
			for (const c of q) prev.set(c, -1);
			let hit = -1;
			for (let qi = 0; qi < q.length && hit < 0; qi++) {
				const c = q[qi], x = c % W, y = (c / W) | 0;
				for (let dy = -1; dy <= 1 && hit < 0; dy++)
					for (let dx = -1; dx <= 1; dx++) {
						if (!dx && !dy) continue;
						const nx = x + dx, ny = y + dy;
						if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
						const n = ny * W + nx;
						if (prev.has(n) || zone[n] !== z || (blocked[base + n] & OCCUPIED)) continue;
						const target = rest.some(g => g.has(n));
						if (reach.has(n) && !target) continue;
						prev.set(n, c);
						if (target) { hit = n; break; }
						q.push(n);
					}
			}
			// the rest lie past a guard or a wall already: nothing to hold
			if (hit < 0) break;
			for (let c = hit; c >= 0 && !joined.has(c); c = prev.get(c)) {
				if (!(blocked[base + c] & RESERVED)) { blocked[base + c] |= RESERVED; held++; }
				joined.add(c);
			}
			for (let i = rest.length - 1; i >= 0; i--)
				if (rest[i].has(hit)) { for (const c of rest[i]) joined.add(c); rest.splice(i, 1); }
		}
	}
	return held;
}

/**
 * True when an object at (x, y) stands wholly in zone z, the ground before it
 * too. A portal or gate anchored in its zone but facing across the zone line
 * opened into the neighbour: on [HotA] Nostalgia 144x2 a gate of the 7-15
 * link was entered from zone 10's side, and the starts met through it.
 */
function inZone(tpl, x, y, zone, z, W, H) {
	for (const [a, b] of blockingCells(tpl, x, y))
		if (a < 0 || b < 0 || a >= W || b >= H || zone[b * W + a] !== z) return false;
	for (const [vx, vy] of visitableCells(tpl, x, y))
		for (const [dx, dy] of allowedDirs(tpl)) {
			const nx = vx + dx, ny = vy + dy;
			if (nx >= 0 && ny >= 0 && nx < W && ny < H && zone[ny * W + nx] !== z) return false;
		}
	return true;
}

/**
 * Place the mines every player is guaranteed to start with.
 *
 * Wood and ore are what the opening week of construction actually spends, so
 * leaving them to the random fill means one player can start beside a sawmill
 * and another eight biomes away from one. Rings outward from the town and
 * takes the first cell the footprint fits, preferring cells inside the
 * player's own biome so the walk there never has to pass a carved boundary.
 */
// Starter mines, which the seal pass may not take out: kept apart from the
// object itself so nothing extra reaches objects.json
const STARTER_MINES_PLACED = new WeakSet();

function placeStarterMines(start, zone, biomeTerrain, levelIndex, W, H, blocked, rng, p, reachable, connectivity, kinds = STARTER_MINES) {
	const out = [];
	// false from code, 0 from the player lever (--bio.starterMines 0)
	if (!p.starterMines) return out;
	const homeBiome = zone[start.y * W + start.x];
	const terrain = biomeTerrain[homeBiome];
	const base = levelIndex * W * H;
	// Walking steps from the town's gate over ground nothing stands on yet.
	// A mine is judged by the walk to its entrance: the first fit on a
	// random ring up to 14 out put starter mines behind the town or across a
	// wall, 30-38 steps away on foot, where the corpus puts a start's wood
	// and ore 5-11 steps from its gate.
	const walk = new Int32Array(W * H).fill(-1);
	const queue = [];
	for (const c of approachCells(OBJECT_TEMPLATES.randomTown, start.x, start.y, levelIndex, W, H, blocked))
		if (walk[c] < 0) { walk[c] = 0; queue.push(c); }
	for (let i = 0; i < queue.length; i++) {
		const c = queue[i], cx = c % W, cy = (c / W) | 0;
		for (let dy = -1; dy <= 1; dy++)
			for (let dx = -1; dx <= 1; dx++) {
				const nx = cx + dx, ny = cy + dy;
				if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const n = ny * W + nx;
				if (walk[n] >= 0 || (blocked[base + n] & OCCUPIED)) continue;
				walk[n] = walk[c] + 1;
				queue.push(n);
			}
	}
	const placedHere = [];
	for (const subtype of kinds) {
		const tpl = mineTemplate(subtype, terrain);
		let placed = null;
		// pass 0 stays inside the player's biome, pass 1 accepts any cell.
		// A cornered start exhausts r=14 while still inside its own apron:
		// 72x72 s31 shipped with NO starter mines for red at all (nearest
		// mine 57 cells off) and nothing logged it. Pass 1 reaches r=24 -
		// a mine that far is still better than none - and failure is loud.
		for (let pass = 0; pass < 2 && !placed; pass++) {
			const cands = [];
			for (let r = 3; r <= (pass ? 24 : 14); r++) {
				const ring = [];
				for (let dy = -r; dy <= r; dy++)
					for (let dx = -r; dx <= r; dx++)
						if (Math.max(Math.abs(dx), Math.abs(dy)) === r) ring.push([dx, dy]);
				// ties go round the ring from a random point, otherwise both
				// mines land on the same side of every town
				const spin = (rng() * ring.length) | 0;
				for (let k = 0; k < ring.length; k++) {
					const [dx, dy] = ring[(k + spin) % ring.length];
					const x = start.x + dx, y = start.y + dy;
					if (x < 0 || y < 0 || x >= W || y >= H) continue;
					if (pass === 0 && zone[y * W + x] !== homeBiome) continue;
					if (!footprintFits(tpl, x, y, levelIndex, W, H, blocked)) continue;
					// A mine wedged between the town and the map edge walls
					// itself in: its own footprint plus the castle plus the
					// border leaves its entrance with nothing beside it. That
					// stranded every starter mine on one seed, four of them,
					// and nothing in the pipeline noticed.
					if (!entranceOpen(tpl, x, y, levelIndex, W, H, blocked, reachable)) continue;
					const own = new Set(blockingCells(tpl, x, y).map(([a, b]) => b * W + a));
					// one way in is one guard or one tree from none: on 72x72
					// p2 s31 red's sawmill was entered only past a neutral
					// town's corner, a guard stood on that cell, trees closed
					// the town's side, and the sweep dropped the mine. Such a
					// spot ranks last rather than never (a cramped start may
					// have nothing else; refusing it left starts without one).
					const ways = approachCells(tpl, x, y, levelIndex, W, H, blocked).filter(c => !own.has(c));
					let steps = Infinity;
					for (const c of ways)
						if (walk[c] >= 0 && walk[c] < steps) steps = walk[c];
					if (ways.length < 2) steps += 12;
					// the second mine keeps its distance from the first
					if (placedHere.some(m => Math.max(Math.abs(m.x - x), Math.abs(m.y - y)) < 4)) steps += 6;
					cands.push({ x, y, steps, order: cands.length });
				}
			}
			// Nearest is not the target either: the corpus puts a start's
			// wood and ore 7 steps out at the median (p90 9, from the gate to
			// the entrance), and ranking by the shortest walk sat them on the
			// gate. A walk of 6 here reads as 7 from the gate.
			const aim = s => Math.abs(s - 6);
			cands.sort((u, v) => aim(u.steps) - aim(v.steps) || u.order - v.order);
			// The ranking walked ground the mine itself will stand on. Walk
			// again with its own cells blocked: a mine behind the town or
			// against the map edge cuts off the only ground in front of its
			// entrance (72x72 p4 s5: red's ore pit at (2,1), dropped later as
			// unreachable), which the guard's two-cell tolerance lets through.
			// Strict first (no longer than the ranking said, give or take
			// four), then any mine whose entrance is still reachable at all.
			const exactSteps = (x, y, own) => {
				const d = new Int32Array(W * H).fill(-1);
				const q2 = [];
				for (const c of approachCells(OBJECT_TEMPLATES.randomTown, start.x, start.y, levelIndex, W, H, blocked))
					if (!own.has(c) && d[c] < 0) { d[c] = 0; q2.push(c); }
				for (let i = 0; i < q2.length; i++) {
					const c = q2[i], cx = c % W, cy = (c / W) | 0;
					if (d[c] >= 48) continue;
					for (let dy = -1; dy <= 1; dy++)
						for (let dx = -1; dx <= 1; dx++) {
							const nx = cx + dx, ny = cy + dy;
							if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
							const n = ny * W + nx;
							if (d[n] >= 0 || own.has(n) || (blocked[base + n] & OCCUPIED)) continue;
							d[n] = d[c] + 1;
							q2.push(n);
						}
				}
				let best = Infinity;
				for (const c of approachCells(tpl, x, y, levelIndex, W, H, blocked))
					if (!own.has(c) && d[c] >= 0 && d[c] < best) best = d[c];
				return best;
			};
			for (const strict of [true, false]) {
				for (const { x, y, steps } of cands) {
					const walls = blockingCells(tpl, x, y).map(([a, b]) => b * W + a);
					const real = exactSteps(x, y, new Set(walls));
					if (real === Infinity || (strict && real > steps + 4)) continue;
					if (connectivity && !connectivity.accepts(walls)) continue;
					if (weldsMasses(walls, blocked, levelIndex, W, H, 2)) continue;
					placed = objectEntry('mine', x, y, levelIndex, tpl, subtype);
					footprintBlock(tpl, x, y, levelIndex, W, H, blocked);
					markApproach(tpl, x, y, levelIndex, W, H, blocked);
					if (connectivity) connectivity.refresh();
					placedHere.push({ x, y });
					break;
				}
				if (placed) break;
			}
		}
		if (placed) {
			STARTER_MINES_PLACED.add(placed);
			out.push(placed);
		} else {
			console.error(`[gen] level ${levelIndex}: no cell for starter `
				+ `${subtype} within 24 of (${start.x},${start.y}) - `
				+ 'player starts without it');
		}
	}
	return out;
}

/**
 * Remove the fewest barrier cells that puts the level back in one piece.
 *
 * `ensureConnected` works on the biome graph, which is the right idea and not
 * quite enough. Once biome boundaries are bent by noise a single biome can
 * come out as two separate blobs, and opening one border between two biome IDs
 * then connects only one of them. A 36x36 map lost a third of its ground that
 * way on two seeds out of fifteen.
 *
 * This works on cells instead, which cannot be fooled by the shape of a
 * region: flood from the player starts, find every open cell that did not come
 * back, and take out a barrier that touches both sides. Runs before any content
 * is placed, so removing a barrier costs nothing but a little scenery.
 */
function openSealedPockets(barriers, W, H, levelIndex, blocked, playerStarts, links = [], water = null) {
	const isBlocked = c => (blocked[levelIndex * W * H + c] & OCCUPIED) || barriers.has(c);
	const flood = seeds => {
		const seen = new Uint8Array(W * H);
		const stack = seeds.filter(c => !isBlocked(c));
		for (const c of stack) seen[c] = 1;
		while (stack.length) {
			const c = stack.pop();
			const x = c % W, y = (c / W) | 0;
			for (let dy = -1; dy <= 1; dy++)
				for (let dx = -1; dx <= 1; dx++) {
					if (!dx && !dy) continue;
					const nx = x + dx, ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
					const n = ny * W + nx;
					if (seen[n] || isBlocked(n)) continue;
					seen[n] = 1; stack.push(n);
				}
		}
		return seen;
	};

	// Seed from ONE start, not all of them. Seeding from every start floods
	// both sides of a wall that separates two players, so the pass sees one
	// connected map and does nothing: on a 36x36 seed 1 a barrier wall ran the
	// full height of the map with a player on each side and this reported
	// itself satisfied. Everything not reachable from the first start,
	// including the other players, is something to open a way to.
	// Island maps (one-way boat links) check EVERY start: a boat carries a
	// player from its own harbour to every shore, so reaching the others says
	// nothing about whether each start can walk to a harbour of its own.
	const perStart = !!water && links.some(k => k[2]);
	const island = perStart ? landPieces8(water, W, H) : null;
	const firsts = perStart ? (playerStarts || []) : [(playerStarts || [])[0]];
	// and a start's way off is a boat it can walk to: a shipyard sells one,
	// but an AI that cannot buy it is stranded, and the help text promises a
	// boat waiting
	const ways = perStart ? links.filter(k => !k[2] || k[3] === 'boat') : links;
	// a barrier touching both sides: taking it out joins them
	const bridge = (main, out) => {
		for (const b of barriers) {
			const x = b % W, y = (b / W) | 0;
			let touchesMain = false, touchesOut = false;
			for (let dy = -1; dy <= 1; dy++)
				for (let dx = -1; dx <= 1; dx++) {
					const nx = x + dx, ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
					const n = ny * W + nx;
					if (main[n]) touchesMain = true;
					if (out[n]) touchesOut = true;
				}
			if (touchesMain && touchesOut) return b;
		}
		return -1;
	};
	let removed = 0;
	for (const first of firsts) {
		let seeds = [];
		if (first)
			for (let dy = -4; dy <= 4; dy++)
				for (let dx = -4; dx <= 4; dx++) {
					const nx = first.x + dx, ny = first.y + dy;
					if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
					seeds.push(ny * W + nx);
				}
		if (!seeds.length) {
			for (let c = 0; c < W * H; c++) if (!isBlocked(c)) { seeds = [c]; break; }
		}
		if (!seeds.length) return removed;

		for (let round = 0; round < 64; round++) {
			// portal pairs (and, on island maps, boats) join what walking cannot
			const main = followLinks(flood(seeds), ways, W, H, isBlocked);
			let outside = -1;
			for (let c = 0; c < W * H; c++)
				if (!isBlocked(c) && !main[c]) { outside = c; break; }
			if (outside < 0) break;
			let best = bridge(main, flood([outside]));
			if (best < 0 && perStart) {
				// that pocket may be on an island this start cannot reach yet:
				// try every pocket on the islands it stands on
				const touched = new Set();
				for (let c = 0; c < W * H; c++) if (main[c] && island[c] >= 0) touched.add(island[c]);
				const near = new Uint8Array(W * H);
				for (let c = 0; c < W * H; c++)
					if (!isBlocked(c) && !main[c] && touched.has(island[c])) near[c] = 1;
				best = bridge(main, near);
			}
			if (best < 0) break;          // sealed by something other than barriers
			barriers.delete(best);
			removed++;
		}
	}
	return removed;
}

/** Each dry cell's piece of land, 8-connected as heroes walk (-1 on water). */
function landPieces8(water, W, H) {
	const piece = new Int32Array(W * H).fill(-1);
	let k = 0;
	for (let c0 = 0; c0 < W * H; c0++) {
		if (water[c0] || piece[c0] >= 0) continue;
		const q = [c0];
		piece[c0] = k;
		for (let h = 0; h < q.length; h++) {
			const c = q[h], x = c % W, y = (c / W) | 0;
			for (let dy = -1; dy <= 1; dy++)
				for (let dx = -1; dx <= 1; dx++) {
					const u = x + dx, v = y + dy;
					if (u < 0 || v < 0 || u >= W || v >= H) continue;
					const d = v * W + u;
					if (!water[d] && piece[d] < 0) { piece[d] = k; q.push(d); }
				}
		}
		k++;
	}
	return piece;
}

/**
 * The same idea as openSealedPockets, run on the finished structure.
 *
 * Opening the barrier SET is not enough, because a chokepoint guard or a
 * monolith goes in afterwards and can close a doorway the pass just opened. On
 * a 36x36 seed 29 that left a diagonal wall across the whole map with a player
 * on each side, and the barrier pass reported itself satisfied because it had
 * run before the wall was finished.
 *
 * Only the one-cell scenery is eligible. A guard or a portal is there for a
 * reason; a rock is not.
 */
function openSealedByObjects(objects, W, H, levelIndex, blocked, playerStarts, towns, links = [], water = null, seedAll = false) {
	const base = levelIndex * W * H;
	// Eligible victims are scenery of any footprint. The one-cell-only
	// version could not open a mouth sealed by a mountain, which is what a
	// pocket wall is made of; a 36x36 seed 13 sealed a start behind one and
	// shipped an islanded player. Smallest footprint wins so the pass takes
	// out a shrub before it takes out a range.
	const isScenery = o => (o.l || 0) === levelIndex && o.template
		&& (DECOR_TYPES_SET.has(o.type)
			|| (Array.isArray(o.template.mask) && o.template.mask.length === 1
				&& o.template.mask[0] === 'B'));
	// When scenery alone cannot open a pocket, the last cells are held by
	// objects the fill has not placed yet: neutral towns, gates, choke
	// objects. A droppable fallback beats an islanded player - on 72x72 s5
	// a neutral town plus its apron held the only door out of green's
	// corner and the scenery pass removed 74 pieces without opening it.
	// Player towns, teleports and quest objects stay protected: losing any
	// of those breaks the map worse than the pocket does.
	const PROTECT = new Set(['subterraneanGate', 'monolithTwoWay', 'borderGuard',
		'questGuard', 'hero', 'randomHero', 'prison', 'boat', 'pandoraBox',
		'grail', 'keymasterTent', 'borderGate']);
	// A start's own sawmill and ore pit stay too: the droppable stage peeled
	// them off the map edge to open pockets a few cells wide, and on 72x72
	// p4 s13 red lost both (nearest wood or ore mine then 36 steps off).
	const isDroppable = o => (o.l || 0) === levelIndex && o.template
		&& !PROTECT.has(o.type)
		&& !(o.options && o.options.owner)
		&& !STARTER_MINES_PLACED.has(o);
	// A cell held only by objects a hero uses up (a guard he fights, a pile he
	// picks up) is ground he gets through, as the stranded sweep and
	// check_reach count it. Flooded as walls, every guard sealed what it
	// guards: a start behind its link's guard was "dug out" through the
	// scenery beside the guard, and after the fill a treasure nook got a
	// scenery piece removed from its wall, a back door around its guard.
	const wall = c => {
		if (!(blocked[base + c] & OCCUPIED)) return false;
		const own = cellObjs.get(c);
		return !own || !own.length || !own.every(o => REMOVABLE_TYPES.has(o.type));
	};
	const flood = seeds => {
		const seen = new Uint8Array(W * H);
		const stack = seeds.filter(c => !wall(c));
		for (const c of stack) seen[c] = 1;
		while (stack.length) {
			const c = stack.pop();
			const x = c % W, y = (c / W) | 0;
			for (let dy = -1; dy <= 1; dy++)
				for (let dx = -1; dx <= 1; dx++) {
					if (!dx && !dy) continue;
					const nx = x + dx, ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
					const n = ny * W + nx;
					if (seen[n] || wall(n)) continue;
					seen[n] = 1; stack.push(n);
				}
		}
		return seen;
	};

	// Seed from the first player's town gate approach cells, the same place
	// the engine and check_reach seed reachability. A blob around the town
	// anchor swallows a sealed gate pocket whole - the pocket cell sits in
	// the seed set, the flood calls it main, and the wall around it is
	// never inspected. 36x36 seed 13 shipped a start reaching exactly one
	// tile that way.
	const gate = town => {
		const out = [];
		const own = new Set(blockingCells(town.template, town.x,
			town.y).map(([a, b]) => b * W + a));
		for (const [vx, vy] of visitableCells(town.template, town.x, town.y))
			for (const [dx, dy] of allowedDirs(town.template)) {
				const nx = vx + dx, ny = vy + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const c = ny * W + nx;
				if (!own.has(c)) out.push(c);
			}
		return out;
	};
	// Island maps (one-way boat links): every player's town, each on its own,
	// for the reason openSealedPockets gives
	const perStart = !!water && links.some(k => k[2]);
	const island = perStart ? landPieces8(water, W, H) : null;
	const ways = perStart ? links.filter(k => !k[2] || k[3] === 'boat') : links;
	let seeds = [];
	const firstTown = objects.find(o => (o.l || 0) === levelIndex
		&& o.options && o.options.owner);
	if (firstTown) seeds = gate(firstTown);
	// seedAll (a level below the surface): every start on it and every way in
	// counts as reached. Its starts may meet only through the surface (a
	// template's start zones below, each linked up to the centre), and seeded
	// from one, the pass dug and peeled at the other's whole zone as a pocket.
	if (seedAll) {
		for (const o of objects)
			if ((o.l || 0) === levelIndex && o.options && o.options.owner && o !== firstTown) seeds.push(...gate(o));
		for (const c of playerStarts || []) if (Number.isInteger(c)) seeds.push(c);
	}
	const first = (playerStarts || [])[0];
	// Underground callers hand over entrance approach cells (plain indexes),
	// not {x,y} starts - first.x on a number is NaN, and NaN seeds silently
	// flooded forever because a typed-array never stores seen[NaN].
	if (!seeds.length && typeof first === 'number')
		seeds = playerStarts.filter(c => Number.isInteger(c) && c >= 0 && c < W * H);
	if (!seeds.length && first && Number.isFinite(first.x))
		for (let dy = -4; dy <= 4; dy++)
			for (let dx = -4; dx <= 4; dx++) {
				const nx = first.x + dx, ny = first.y + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				seeds.push(ny * W + nx);
			}
	seeds = seeds.filter(c => Number.isInteger(c) && c >= 0 && c < W * H);
	if (!seeds.length)
		for (let c = 0; c < W * H; c++)
			if (!(blocked[base + c] & OCCUPIED)) { seeds = [c]; break; }
	if (!seeds.length) return 0;

	// Two objects may legally own the same blocking cell - pack and weld
	// pieces overlap by design, matching the corpus's shared mask cells.
	// Freeing a victim's cell while a second object still claims it punches
	// a hole no object stands in: the floods then see through a wall the
	// map file keeps, which is exactly how 72x72 s5 shipped green sealed
	// behind a lake the pass believed it had opened. Count owners so a
	// shared cell stays blocked until its last owner goes.
	const ownerCount = new Map();
	const cellObjs = new Map();
	for (const o of objects) {
		if (!o.template || !o.template.mask) continue;
		for (const [fx, fy] of blockingCells(o.template, o.x, o.y)) {
			if (fx < 0 || fy < 0 || fx >= W || fy >= H) continue;
			const c = fy * W + fx;
			ownerCount.set(c, (ownerCount.get(c) || 0) + 1);
			if (!cellObjs.has(c)) cellObjs.set(c, []);
			cellObjs.get(c).push(o);
		}
	}
	const removeAt = (i, cells) => {
		const gone = objects[i];
		if (process.env.VMAPGEN_DROP_TRACE && (process.env.VMAPGEN_DROP_TRACE === 'all' || !DECOR_TYPES_SET.has(gone.type)))
			console.error(`[drop] pocket pass removed ${gone.type} at (${gone.x},${gone.y})`);
		for (const c of cells) {
			const own = cellObjs.get(c);
			if (own) { const k = own.indexOf(gone); if (k >= 0) own.splice(k, 1); }
			const n = (ownerCount.get(c) || 0) - 1;
			if (n > 0) { ownerCount.set(c, n); continue; }
			ownerCount.delete(c);
			blocked[base + c] &= ~OCCUPIED;
		}
		objects.splice(i, 1);
		if (towns)
			for (let t = towns.length - 1; t >= 0; t--)
				if (towns[t].instanceName === gone.instanceName)
					towns.splice(t, 1);
	};
	const cellsOf = o => blockingCells(o.template, o.x, o.y)
		.filter(([a, b]) => a >= 0 && b >= 0 && a < W && b < H)
		.map(([a, b]) => b * W + a);

	// A player's town left in a pocket opens first, along the cheapest
	// corridor from the reached ground to its gate: a scenery cell costs 1, a
	// cell other droppable objects hold costs 25, terrain and protected
	// objects never open. The pocket loop below removes at most 128 objects,
	// smallest first, and on a 216x216 map with the decor lever at 2 the
	// one-cell cracks used all 128 while tan's whole start stayed shut (fuzz
	// seed 23 case 12, 2026-09-25: tan reached 196 tiles).
	const gates = objects.filter(o => (o.l || 0) === levelIndex && o.options && o.options.owner)
		.map(gate).filter(g => g.length);
	const cellCost = c => {
		if (!wall(c)) return 0;
		if (water && water[c]) return Infinity;
		const own = cellObjs.get(c);
		if (!own || !own.length) return Infinity;
		let w = 0;
		for (const o of own) {
			if (isScenery(o)) w = Math.max(w, 1);
			else if (isDroppable(o)) w = Math.max(w, 25);
			else return Infinity;
		}
		return w;
	};
	const digToStarts = () => {
		let dug = 0, opened = 0;
		const failed = new Set();
		for (let tries = 0; tries < 2 * gates.length + 2; tries++) {
			const main = followLinks(flood(seeds), ways, W, H, wall);
			const shut = gates.findIndex((g, i) => !failed.has(i) && !g.some(c => main[c]));
			if (shut < 0) break;
			const target = new Set(gates[shut]);
			const dist = new Float64Array(W * H).fill(Infinity);
			const from = new Int32Array(W * H).fill(-1);
			const heap = [];
			const push = (d, c) => {
				heap.push([d, c]);
				for (let i = heap.length - 1; i > 0;) {
					const p = (i - 1) >> 1;
					if (heap[p][0] <= heap[i][0]) break;
					[heap[p], heap[i]] = [heap[i], heap[p]]; i = p;
				}
			};
			const pop = () => {
				const top = heap[0], last = heap.pop();
				if (heap.length) {
					heap[0] = last;
					for (let i = 0; ;) {
						const a = 2 * i + 1, b = a + 1;
						let m = i;
						if (a < heap.length && heap[a][0] < heap[m][0]) m = a;
						if (b < heap.length && heap[b][0] < heap[m][0]) m = b;
						if (m === i) break;
						[heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
					}
				}
				return top;
			};
			for (let c = 0; c < W * H; c++) if (main[c]) { dist[c] = 0; push(0, c); }
			let hit = -1;
			while (heap.length) {
				const [d, c] = pop();
				if (d > dist[c]) continue;
				if (target.has(c)) { hit = c; break; }
				const x = c % W, y = (c / W) | 0;
				for (let dy = -1; dy <= 1; dy++)
					for (let dx = -1; dx <= 1; dx++) {
						if (!dx && !dy) continue;
						const nx = x + dx, ny = y + dy;
						if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
						const n = ny * W + nx;
						const w = cellCost(n);
						if (w === Infinity || d + w >= dist[n]) continue;
						dist[n] = d + w; from[n] = c; push(d + w, n);
					}
			}
			if (hit < 0) { failed.add(shut); continue; }
			const victims = new Set();
			for (let c = hit; c >= 0 && !main[c]; c = from[c])
				if (wall(c))
					for (const o of cellObjs.get(c) || []) victims.add(o);
			for (const o of victims) {
				const i = objects.indexOf(o);
				if (i >= 0) { removeAt(i, cellsOf(o)); dug++; }
			}
			opened++;
		}
		if (dug)
			console.error(`[gen] level ${levelIndex}: dug ${opened} sealed start(s) out, `
				+ `${dug} object(s) removed`);
		return dug;
	};

	const seedSets = perStart
		? objects.filter(o => (o.l || 0) === levelIndex && o.options && o.options.owner)
			.map(gate).filter(s => s.length)
		: [seeds];
	let removed = 0;
	for (const setSeeds of seedSets) {
		seeds = setSeeds;
		removed += digToStarts();
		let stage = 0;
		for (let round = 0; round < 128; round++) {
			const main = followLinks(flood(seeds), ways, W, H, wall);
			// only pockets on land this start can walk to: another island is
			// reached by boat or not at all, and peeling it would gain nothing
			let touched = null;
			if (island) {
				touched = new Set();
				for (let c = 0; c < W * H; c++) if (main[c] && island[c] >= 0) touched.add(island[c]);
			}
			// Every unreachable pocket, not just the first: the first may be a
			// crack sealed by terrain with no scenery to remove, and breaking on
			// it skips the pocket a whole player is sitting in (64x64 s42).
			// label each pocket once so a pocket with no legal victim does not
			// stop the others being tried
			// one labelling walk over the level; a full flood and scan per
			// pocket cost W*H each, hundreds of times a round on a big map
			const outOf = new Int32Array(W * H).fill(-1);
			let pockets = 0;
			const q = [];
			for (let c = 0; c < W * H; c++) {
				if (wall(c) || main[c] || outOf[c] >= 0)
					continue;
				if (touched && !touched.has(island[c])) continue;
				outOf[c] = pockets; q.push(c);
				while (q.length) {
					const k = q.pop(), x = k % W, y = (k / W) | 0;
					for (let dy = -1; dy <= 1; dy++)
						for (let dx = -1; dx <= 1; dx++) {
							if (!dx && !dy) continue;
							const nx = x + dx, ny = y + dy;
							if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
							const n = ny * W + nx;
							if (outOf[n] >= 0 || wall(n)) continue;
							outOf[n] = pockets; q.push(n);
						}
				}
				pockets++;
			}
			if (!pockets) break;
			const eligible = stage === 0 ? isScenery : isDroppable;
			let victim = -1, victimCells = null, victimSize = 1e9;
			let peel = -1, peelCells = null, peelSize = 1e9;
			for (let i = 0; i < objects.length; i++) {
				const o = objects[i];
				// a guard or a pile seals nothing (wall above): taking it opens nothing
				if (!eligible(o) || REMOVABLE_TYPES.has(o.type)) continue;
				const cells = blockingCells(o.template, o.x, o.y)
					.filter(([a, b]) => a >= 0 && b >= 0 && a < W && b < H)
					.map(([a, b]) => b * W + a);
				if (!cells.length
						|| !cells.every(c => blocked[base + c] & OCCUPIED))
					continue;
				let touchesMain = false, pocket = -1;
				for (const c of cells) {
					const cx0 = c % W, cy0 = (c / W) | 0;
					for (let dy = -1; dy <= 1; dy++)
					for (let dx = -1; dx <= 1; dx++) {
						const nx = cx0 + dx, ny = cy0 + dy;
						if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
						const n = ny * W + nx;
						if (main[n]) touchesMain = true;
						if (outOf[n] >= 0) pocket = outOf[n];
					}
				}
				if (touchesMain && pocket >= 0 && cells.length < victimSize) {
					victim = i; victimCells = cells; victimSize = cells.length;
				} else if (pocket >= 0 && cells.length < peelSize) {
					// A wall thicker than one object has no single bridge:
					// peel the pocket's inner face, smallest first, until a
					// bridge object is exposed at the thinnest crossing.
					peel = i; peelCells = cells; peelSize = cells.length;
				}
			}
			if (victim < 0) { victim = peel; victimCells = peelCells; }
			if (victim < 0 && stage === 0) { stage = 1; round--; continue; }
			if (victim < 0) break;    // every pocket sealed by protected structure
			removeAt(victim, victimCells);
			removed++;
		}
	}
	return removed;
}

/**
 * A carved level's doorway: the cells of its two zones around the cell its
 * guard takes (placeChokeGuards: the hole's middle cell). A doorway's hole
 * runs up to three cells either side of its pivot along a jagged zone line,
 * and carving all of it, with the ground beside, opened a passage wider than
 * the guard's reach: on [HotA] Nostalgia 144x2 the starts met below ground
 * around their link guards. Held to the guard's own eight neighbours, every
 * way through is a fight.
 */
function doorCells(o, zone, W, H) {
	const mid = o.hole[(o.hole.length / 2) | 0];
	const mx = mid % W, my = (mid / W) | 0, out = [];
	for (let dy = -1; dy <= 1; dy++)
		for (let dx = -1; dx <= 1; dx++) {
			const x = mx + dx, y = my + dy;
			if (x < 0 || y < 0 || x >= W || y >= H) continue;
			const c = y * W + x;
			if (zone[c] === o.a || zone[c] === o.b) out.push(c);
		}
	return out;
}

/**
 * True when opening cell c puts no open ground of another zone beside it
 * (heroes move 8-way), but where both are a doorway's cells.
 */
function zoneLineSafe(open, zone, W, H, c, doorCell = null) {
	const x = c % W, y = (c / W) | 0, z = zone[c];
	for (let dy = -1; dy <= 1; dy++)
		for (let dx = -1; dx <= 1; dx++) {
			if (!dx && !dy) continue;
			const nx = x + dx, ny = y + dy;
			if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
			const n = ny * W + nx;
			if (open[n] && zone[n] !== z && !(doorCell && doorCell[n] && doorCell[c])) return false;
		}
	return true;
}

/**
 * Cut a tunnel inside zone z from the cells `from` to the first cell `goal`
 * accepts, `radius` wide, along the cheapest route over a noise field so it
 * wanders. Only cells zoneLineSafe allows open. Returns false when no route
 * exists.
 */
function tunnelInZone(open, zone, W, H, from, z, radius, noise, doorCell, goal) {
	const N = W * H;
	const passable = c => zone[c] === z && (open[c] || zoneLineSafe(open, zone, W, H, c, doorCell));
	const dist = new Float64Array(N).fill(Infinity);
	const prev = new Int32Array(N).fill(-1);
	const heap = [];
	const push = (d, c) => {
		heap.push([d, c]);
		for (let i = heap.length - 1; i > 0;) {
			const q = (i - 1) >> 1;
			if (heap[q][0] <= heap[i][0]) break;
			[heap[q], heap[i]] = [heap[i], heap[q]]; i = q;
		}
	};
	const pop = () => {
		const top = heap[0], last = heap.pop();
		if (heap.length) {
			heap[0] = last;
			for (let i = 0; ;) {
				const a = 2 * i + 1, b = a + 1;
				let m = i;
				if (a < heap.length && heap[a][0] < heap[m][0]) m = a;
				if (b < heap.length && heap[b][0] < heap[m][0]) m = b;
				if (m === i) break;
				[heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
			}
		}
		return top;
	};
	for (const c of from) if (c >= 0 && c < N && zone[c] === z) { dist[c] = 0; push(0, c); }
	let hit = -1;
	while (heap.length) {
		const [d, c] = pop();
		if (d > dist[c]) continue;
		if (goal(c)) { hit = c; break; }
		const x = c % W, y = (c / W) | 0;
		for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
			const nx = x + dx, ny = y + dy;
			if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
			const n = ny * W + nx;
			if (!passable(n)) continue;
			const nd = d + noise[n];
			if (nd < dist[n]) { dist[n] = nd; prev[n] = c; push(nd, n); }
		}
	}
	if (hit < 0) return false;
	const r2 = radius * radius, rr = Math.ceil(radius);
	for (let c = hit; c >= 0; c = prev[c]) {
		if (!open[c] && zoneLineSafe(open, zone, W, H, c, doorCell)) open[c] = 1;
		const cx = c % W, cy = (c / W) | 0;
		for (let y = Math.max(0, cy - rr); y <= Math.min(H - 1, cy + rr); y++)
			for (let x = Math.max(0, cx - rr); x <= Math.min(W - 1, cx + rr); x++) {
				const k = y * W + x;
				if ((x - cx) ** 2 + (y - cy) ** 2 > r2 || open[k] || zone[k] !== z) continue;
				if (zoneLineSafe(open, zone, W, H, k, doorCell)) open[k] = 1;
			}
	}
	return true;
}

/**
 * Which cells of an underground level are open ground rather than solid rock.
 *
 * The underground was generated by exactly the same code as the surface, so it
 * came out as a second open landscape with a roof on it. A real Heroes 3
 * underground is mostly solid rock with chambers cut into it and tunnels
 * between them, which is how VCMI's own generator builds one: its RockFiller
 * paints rock over everything outside the carved zones.
 *
 * A chamber per zone at the ground nearest its centre, sized from its area,
 * and for every link that is a path, a tunnel from each side's chamber to the
 * link's doorway (`doors`: carveBoundaries' openings; doorCells). Everywhere
 * else a zone line stays rock: no cell opens beside another
 * zone's open ground (zoneLineSafe). The tunnels used to run chamber to chamber
 * in a line, across whatever zones lay between, and the cave grew over zone
 * lines, so neighbouring zones met at many points and a link's guard, standing
 * in one of them, guarded nothing (Golems Aplenty 72, two levels: three starts
 * walked to each other below ground unopposed). Without `doors` the old carve
 * runs. The biome graph is guaranteed connected by ensureConnected, so the
 * tunnels inherit that.
 *
 * Returns a Uint8Array flag per cell, 1 for open (and `open.tunnelsFailed`,
 * the doorway sides no route reached).
 */
function carveUnderground(W, H, zone, seeds, edges, connections, p, rng, doors = null) {
	const open = new Uint8Array(W * H);
	const area = new Array(seeds.length).fill(0);
	for (const z of zone) area[z]++;

	// `subterraneanNarrow` has sat in BIOME_DEFAULTS since the start read by
	// nothing at all. It means what it says here: how much of the underground
	// is tunnel rather than chamber. 0 gives caverns, 1 gives corridors.
	const narrow = Math.max(0, Math.min(1, p.subterraneanNarrow));
	const doorCell = doors ? new Uint8Array(W * H) : null;
	if (doors)
		for (const o of doors)
			if (o.kind !== 'portal' && o.hole.length) for (const c of doorCells(o, zone, W, H)) doorCell[c] = 1;
	// with doorways, a disc opens only its own zone's cells, and only where no
	// other zone's open ground lies beside them
	const disc = (cx, cy, r, z = -1) => {
		const r2 = r * r;
		for (let y = Math.max(0, cy - r | 0); y <= Math.min(H - 1, cy + r); y++)
			for (let x = Math.max(0, cx - r | 0); x <= Math.min(W - 1, cx + r); x++) {
				const dx = x - cx, dy = y - cy;
				if (dx * dx + dy * dy > r2) continue;
				const c = y * W + x;
				if (doors && (zone[c] !== z || !zoneLineSafe(open, zone, W, H, c, doorCell))) continue;
				open[c] = 1;
			}
	};

	// Chambers sit at each biome's CENTROID, not at its seed. A seed can land
	// anywhere inside its region, including against a neighbour, and three
	// seeds that happen to cluster produce one blob instead of three chambers:
	// the first 36x36 cave came out as a single lobe covering a third of the
	// level with nothing anywhere else. Voronoi regions tile the map, so their
	// centroids are spread by construction. (A zone bent round a neighbour can
	// have its centroid outside it; with doorways the chamber sits on the
	// zone's own cell nearest the centroid.)
	const cx = new Float64Array(seeds.length), cy = new Float64Array(seeds.length);
	for (let c = 0; c < W * H; c++) { cx[zone[c]] += c % W; cy[zone[c]] += (c / W) | 0; }
	const centre = [];
	for (let i = 0; i < seeds.length; i++)
		centre.push(area[i]
			? { x: Math.round(cx[i] / area[i]), y: Math.round(cy[i] / area[i]) }
			: { x: seeds[i].x, y: seeds[i].y });
	const anchor = centre.map(() => -1);
	if (doors) {
		const bestD = centre.map(() => Infinity);
		for (let c = 0; c < W * H; c++) {
			const i = zone[c], d = (c % W - centre[i].x) ** 2 + (((c / W) | 0) - centre[i].y) ** 2;
			if (d < bestD[i]) { bestD[i] = d; anchor[i] = c; }
		}
		// a start's chamber opens round its own cell, where its town stands
		// (the free layout's starts stay on their cell; a template's move to
		// their zone's centre, which is where this puts the chamber anyway)
		seeds.forEach((sd, i) => { if (sd.player && zone[sd.y * W + sd.x] === i) anchor[i] = sd.y * W + sd.x; });
		anchor.forEach((c, i) => { if (c >= 0) centre[i] = { x: c % W, y: (c / W) | 0 }; });
	}

	for (let i = 0; i < seeds.length; i++) {
		// a chamber holding a share of its biome's ground, with a little jitter
		// so they are not all the same circle; a start's holds half its zone, the
		// open share a start has on the surface, or a start below began in a
		// closet beside the surface starts' fields (free layout 72x72 s3: 137
		// tiles against 1,352)
		const want = area[i] * (seeds[i] && seeds[i].player ? 0.5 : (1 - narrow) * 0.5);
		const r = Math.max(2, Math.sqrt(want / Math.PI) * (0.85 + rng() * 0.3));
		disc(centre[i].x, centre[i].y, r, i);
		if (doors && anchor[i] >= 0 && !open[anchor[i]] && zoneLineSafe(open, zone, W, H, anchor[i], doorCell))
			open[anchor[i]] = 1;
	}

	const width = 1 + Math.round((1 - narrow) * 2);
	let tunnelsFailed = 0;
	if (doors) {
		// each path link's doorway, open, and a tunnel from each side of it to
		// that side's chamber; the noise makes the tunnels wander
		const noise = new Float64Array(W * H);
		for (let c = 0; c < W * H; c++) noise[c] = 1 + rng() * 2;
		for (const o of doors) {
			if (o.kind === 'portal' || !o.hole.length) continue;
			const door = doorCells(o, zone, W, H);
			for (const c of door) open[c] = 1;
			for (const z of [o.a, o.b]) {
				const from = door.filter(c => zone[c] === z);
				// to the zone's open ground: its chamber, or a tunnel already
				// run to it
				if (!tunnelInZone(open, zone, W, H, from, z, width / 2 + 0.4, noise, doorCell,
					c => (open[c] && !doorCell[c]) || c === anchor[z]))
					tunnelsFailed++;
			}
		}
	} else {
		// tunnels: a wandering line from seed to seed along every open border
		for (const e of edges) {
			if (connections.get(e.a * 100000 + e.b) === 'blocked') continue;
			const A = centre[e.a], B = centre[e.b];
			let x = A.x, y = A.y;
			for (let step = 0; step < (W + H) * 2; step++) {
				disc(x, y, width / 2 + 0.4);
				if (x === B.x && y === B.y) break;
				// step toward the target, with an occasional sideways wobble so the
				// tunnel is not a ruler-straight line
				if (rng() < 0.2) {
					if (rng() < 0.5) x += (rng() < 0.5 ? 1 : -1);
					else y += (rng() < 0.5 ? 1 : -1);
				} else if (Math.abs(B.x - x) > Math.abs(B.y - y)) {
					x += Math.sign(B.x - x);
				} else if (B.y !== y) {
					y += Math.sign(B.y - y);
				} else {
					x += Math.sign(B.x - x);
				}
				x = Math.max(0, Math.min(W - 1, x));
				y = Math.max(0, Math.min(H - 1, y));
			}
		}
	}

	// Chambers and tunnels alone leave roughly a quarter of the level walkable,
	// against 56.8% across the corpus's 32 two-level maps. That shortfall is
	// what makes our undergrounds read as a warren: on a 96x96 level we put 456
	// blocked cells of terrain feature against about 3900 on a real one, not
	// because the decor pass is weak but because there is no floor to put it on.
	//
	// Grow the cave outward instead of inflating every chamber into a bigger
	// circle. Dilation only ever opens a cell that already touches open ground,
	// so a connected cave stays connected and the gates keep the area they open
	// into. Following the existing outline also keeps the walls ragged, where a
	// larger radius would just give rounder rooms.
	//
	// The skip roll is what keeps an edge from advancing as one smooth front:
	// a cell left closed this round is usually taken the next, so the boundary
	// frays the way a cave wall does.
	const target = Math.max(0, Math.min(1, p.subterraneanOpen));
	const wanted = target * W * H;
	let openCount = 0;
	for (let c = 0; c < W * H; c++) if (open[c]) openCount++;
	// bounded: a cave that cannot reach the target (a tiny level, or a target
	// of 1) stops at the cap rather than looping
	for (let round = 0; round < 24 && openCount < wanted; round++) {
		const edge = [];
		for (let y = 0; y < H; y++)
			for (let x = 0; x < W; x++) {
				const c = y * W + x;
				if (open[c]) continue;
				if ((x > 0 && open[c - 1]) || (x < W - 1 && open[c + 1])
						|| (y > 0 && open[c - W]) || (y < H - 1 && open[c + W]))
					edge.push(c);
			}
		if (!edge.length) break;
		let grew = 0;
		for (const c of edge) {
			if (openCount + grew >= wanted) break;
			if (rng() < 0.25) continue;
			// the cave grows up to a zone line, not over it
			if (doors && !zoneLineSafe(open, zone, W, H, c, doorCell)) continue;
			open[c] = 1; grew++;
		}
		if (!grew) break;
		openCount += grew;
	}
	open.tunnelsFailed = tunnelsFailed;
	return open;
}

/**
 * Plan one level. Returns {
 *   zone, classes, biomeTerrain, barriers(Set), roadCells(Set),
 *   objects:[...], openings, guards
 * }
 */
/**
 * Layout figures for analysis (the water compatibility matrix reads them
 * through VMAPGEN_PLAN_ONLY): the ground each zone ended up with, the
 * template's own size weights and types, and the links the layout could not
 * draw as a shared border.
 */
function layoutStats(zone, seeds, tplZones, tplConns, unfulfilled, forced, W, H, water, openMask, landCells) {
	const zoneLand = new Array(seeds.length).fill(0);
	for (let c = 0; c < W * H; c++)
		if (water ? !water[c] : (!openMask || openMask[c])) zoneLand[zone[c]]++;
	return { zoneLand, landCells, forcedLinks: forced,
		sizes: tplZones ? tplZones.map(z => z.size || 10) : null,
		types: tplZones ? tplZones.map(z => z.type) : null,
		links: tplConns.filter(isLandLink).length, unfulfilled: unfulfilled.length };
}

/**
 * For each zone of level l, the mean seed of the zones it links to on levels
 * already laid out, and of the starts pinned on levels still to come (null for
 * a zone with no such link): where the layout pulls it, so a link between
 * levels has ground both zones share. A start's zone is laid round its own
 * town whatever its partners do, so a zone linked to a start below has to come
 * to it: with half of [HotA] Nostalgia's starts below (template.js
 * assignLevels), 2 of its 14 gate sites found the start's zone under them and
 * 4 links made gate pairs where the corpus has 10 or 11.
 */
function crossLevelAnchors(zonePlan, plans, l, starts = null, W = 0, H = 0) {
	const n = (zonePlan.perLevel[l] || []).length;
	const sum = Array.from({ length: n }, () => ({ x: 0, y: 0, k: 0 }));
	for (const c of zonePlan.connections || []) {
		if (!c.aRef || !c.bRef || c.aRef.l === c.bRef.l) continue;
		const [here, there] = c.aRef.l === l ? [c.aRef, c.bRef] : c.bRef.l === l ? [c.bRef, c.aRef] : [null, null];
		if (!here || here.i >= n) continue;
		const s = there.l < l ? plans[there.l] && plans[there.l].seeds && plans[there.l].seeds[there.i]
			: pinnedStartSeed(zonePlan, there, starts, W, H);
		if (!s) continue;
		sum[here.i].x += s.x; sum[here.i].y += s.y; sum[here.i].k++;
	}
	return sum.map(a => (a.k ? { x: a.x / a.k, y: a.y / a.k, k: a.k } : null));
}

/**
 * Where the zone of a start pinned on its level will have its seed, before
 * that level is laid out: the town's cell moved toward the map's middle by
 * half the zone's radius, as layoutZoneSeeds moves it (startInset 0.5). Null
 * for any zone that is not a start on that level.
 */
function pinnedStartSeed(zonePlan, ref, starts, W, H) {
	const zones = (zonePlan.perLevel || [])[ref.l] || [];
	const z = zones[ref.i];
	if (!z || (z.type !== 'playerStart' && z.type !== 'cpuStart') || !z.owner || !W) return null;
	const st = startOfOwner(starts, z.owner);
	if (!st || (st.l || 0) !== ref.l) return null;
	const mass = zones.reduce((a, q) => a + (q.size || 10) ** 2, 0);
	const radius = Math.max(2, (z.size || 10) * Math.sqrt((W * H) / (mass * Math.PI)));
	const dx = W / 2 - st.x, dy = H / 2 - st.y, d = Math.hypot(dx, dy);
	if (!d) return { x: st.x, y: st.y };
	const step = Math.min(0.5 * radius, d / 2);
	return { x: st.x + dx / d * step, y: st.y + dy / d * step };
}

/**
 * The cheapest way the template itself gives between two zones: over every
 * link that can be walked (not fictive or repulsive; a wide one costs
 * nothing), the path whose strongest guard is the weakest, and that guard.
 * Returns (la, a, lb, b) => strength, Infinity when no path joins them.
 */
function templateBottleneck(zonePlan) {
	const adj = new Map();
	const key = (l, i) => `${l}:${i}`;
	for (const c of zonePlan.connections || []) {
		if (!c.aRef || !c.bRef || c.type === 'fictive' || c.type === 'repulsive') continue;
		const w = c.type === 'wide' ? 0 : Number(c.guard) || 0;
		const a = key(c.aRef.l, c.aRef.i), b = key(c.bRef.l, c.bRef.i);
		if (!adj.has(a)) adj.set(a, []);
		if (!adj.has(b)) adj.set(b, []);
		adj.get(a).push([b, w]); adj.get(b).push([a, w]);
	}
	const memo = new Map();
	const from = src => {
		if (memo.has(src)) return memo.get(src);
		const best = new Map([[src, 0]]);
		const done = new Set();
		for (;;) {
			let u = null, bu = Infinity;
			for (const [k, v] of best) if (!done.has(k) && v < bu) { u = k; bu = v; }
			if (u === null) break;
			done.add(u);
			for (const [v, w] of adj.get(u) || []) {
				const m = Math.max(bu, w);
				if (m < (best.has(v) ? best.get(v) : Infinity)) best.set(v, m);
			}
		}
		memo.set(src, best);
		return best;
	};
	return (la, a, lb, b) => {
		const d = from(key(la, a)).get(key(lb, b));
		return d === undefined ? Infinity : d;
	};
}

/**
 * The template links between level l and a level below it, each with the
 * zones at both ends and its index in the plan's connection list (the key a
 * held gate site is found by on both levels).
 */
function crossLinks(zonePlan, l) {
	const out = [];
	(zonePlan.connections || []).forEach((c, k) => {
		if (!c.aRef || !c.bRef || c.aRef.l === c.bRef.l) return;
		const [lo, hi] = c.aRef.l < c.bRef.l ? [c.aRef, c.bRef] : [c.bRef, c.aRef];
		if (lo.l === l || hi.l === l) out.push({ k, lo, hi });
	});
	return out;
}

/** A subterranean gate's ground held: the footprint OCCUPIED, the cells before it RESERVED. */
function holdGateGround(tpl, x, y, l, W, H, blocked) {
	for (const [a, b] of blockingCells(tpl, x, y)) blocked[l * W * H + b * W + a] |= OCCUPIED;
	for (const [vx, vy] of visitableCells(tpl, x, y))
		for (const [dx, dy] of allowedDirs(tpl)) {
			const nx = vx + dx, ny = vy + dy;
			if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
			reserveCell(blocked, l, W, H, ny * W + nx);
		}
}

/** The held ground given back, for the gate pass to place the gate on it. */
function releaseGateGround(tpl, x, y, l, W, H, blocked) {
	for (const [a, b] of blockingCells(tpl, x, y))
		if (a >= 0 && b >= 0 && a < W && b < H) blocked[l * W * H + b * W + a] &= ~(OCCUPIED | RESERVED);
	for (const [vx, vy] of visitableCells(tpl, x, y))
		for (const [dx, dy] of allowedDirs(tpl)) {
			const nx = vx + dx, ny = vy + dy;
			if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
			blocked[l * W * H + ny * W + nx] &= ~RESERVED;
		}
}

/** A template link a shared border has to carry: guarded (the default) or wide. */
const isLandLink = c => !c.type || c.type === 'guarded' || c.type === 'wide';

/**
 * A template level's zone layout: several attempts, each partitioned, and the
 * one whose zones realize the most template links is kept (fewest portal
 * fallbacks; then the zone areas nearest the sizes' shares). The engine's zone
 * placer also keeps the best of its attempts (CZonePlacer::placeZones).
 * Attempts take turns among three starts (layoutZoneSeeds): spectral, barycentric
 * and random. The spectral one draws grids and rings the way they are meant to
 * sit; the barycentric one suits three or more held starts, and with two it
 * lays every free zone on the line between them.
 * Each attempt has its own random stream, so the level's own is untouched.
 * VMAPGEN_LAYOUT_TRIES sets the count (default 8); VMAPGEN_LAYOUT_INIT=random
 * makes every start random. preset: a layout already made for this level (one
 * {x, y} per zone), tried first; generate.js passes the free layout its start
 * cells came from.
 * Returns {seeds, zone, missing, links, sizeErr, k, tries}; k is -1 for the preset.
 */
function chooseTemplateLayout({ tplZones, tplConns, W, H, playerStarts, water = null, seed = 1,
	levelIndex = 0, p, tries: triesIn, preset = null, anchors = null }) {
	const weights = tplZones.map(z => Math.max(1, z.size || 10));
	const want = weights.map(s => s * s / weights.reduce((a, v) => a + v * v, 0));
	const wantedLinks = new Set(tplConns.filter(isLandLink).map(c => Math.min(c.a, c.b) * 100000 + Math.max(c.a, c.b)));
	const layoutConns = tplConns.filter(c => c.type !== 'repulsive' && c.type !== 'forcePortal');
	const repulse = tplConns.filter(c => c.type === 'repulsive').map(c => [c.a, c.b]);
	const tries = triesIn || Math.max(1, Math.round(Number(process.env.VMAPGEN_LAYOUT_TRIES) || 8));
	const usePreset = preset && preset.length === tplZones.length;
	let best = null;
	for (let k = usePreset ? -1 : 0; k < tries; k++) {
		const lrng = xorshift(((seed * 2654435761) + levelIndex * 97 + k * 7919 + 13) >>> 0);
		lrng(); lrng();
		// the starts in turn: spectral, barycentric, random, each later round
		// with more jitter and a longer settle
		const round = Math.floor(Math.max(0, k) / 3), kind = ['spectral', 'barycentric', 'random'][Math.max(0, k) % 3];
		const opts = process.env.VMAPGEN_LAYOUT_INIT === 'random' || kind === 'random'
			? { init: 'random', iterations: round ? 150 : 90 }
			: { init: kind, jitter: round ? 2 + 2 * round : 1.5, iterations: round ? 150 : 90 };
		const s = k < 0
			? preset.map((q, i) => ({ x: q.x, y: q.y,
				player: tplZones[i].type === 'playerStart' || tplZones[i].type === 'cpuStart' }))
			: layoutZoneSeeds(tplZones, layoutConns, W, H, playerStarts, lrng, { ...opts, repulse, anchors });
		if (water)
			for (const q of s)
				if (water[q.y * W + q.x]) Object.assign(q, nearestLand(W, H, water, q.x, q.y));
		const { zone: z } = partitionSeeded(W, H, s, weights, lrng, p);
		if (water) settleZonesOnLand(z, s, W, H, water);
		const touching = new Set(biomeEdges(z, W, H, s.length, water)
			.map(e => Math.min(e.a, e.b) * 100000 + Math.max(e.a, e.b)));
		let missing = 0;
		for (const key of wantedLinks) if (!touching.has(key)) missing++;
		// a start's town cell has to fall in its own zone (the seed sits
		// inward of the town, layoutZoneSeeds startInset)
		let lost = 0;
		tplZones.forEach((zs, i) => {
			const st = (zs.type === 'playerStart' || zs.type === 'cpuStart') && zs.owner && startOfOwner(playerStarts, zs.owner);
			if (st && z[st.y * W + st.x] !== i) lost++;
		});
		const area = new Array(s.length).fill(0);
		let land = 0;
		for (let c = 0; c < W * H; c++) if (z[c] >= 0 && !(water && water[c])) { area[z[c]]++; land++; }
		const sizeErr = area.reduce((e, a, i) => e + Math.abs(a / (land || 1) - want[i]), 0);
		if (!best || lost < best.lost || (lost === best.lost && (missing < best.missing
				|| (missing === best.missing && sizeErr < best.sizeErr - 1e-9))))
			best = { seeds: s, zone: z, missing, sizeErr, k, lost };
		if (!missing && !lost && k < 0) break;
	}
	return { ...best, links: wantedLinks.size, tries };
}

/**
 * Whether a town anchored at (x, y) stands wholly in zone b: every cell it
 * blocks and the ground before its gate inside the zone and off the zone's
 * walls (barriers), two cells clear of the map's edge, on free ground, with
 * its gate open. The engine's own test is the same in substance: the object
 * inside the zone's free area, its way in overlapping it
 * (ObjectManager::findPlaceForObject).
 */
function townFitsZone(zone, b, x, y, W, H, levelIndex, blocked, barriers) {
	const tpl = OBJECT_TEMPLATES.randomTown;
	const inZone = c => zone[c] === b && !(barriers && barriers.has(c));
	if (blockingCells(tpl, x, y).some(([a, b2]) => a < 2 || b2 < 2 || a > W - 3 || b2 > H - 3
		|| !inZone(b2 * W + a))) return false;
	for (const [vx, vy] of visitableCells(tpl, x, y))
		for (const [dx, dy] of allowedDirs(tpl)) {
			const nx = vx + dx, ny = vy + dy;
			if (nx < 0 || ny < 0 || nx >= W || ny >= H || !inZone(ny * W + nx)) return false;
		}
	return footprintFits(tpl, x, y, levelIndex, W, H, blocked)
		&& entranceOpen(tpl, x, y, levelIndex, W, H, blocked, null);
}

/** Zone b's cells (off the water) in order of their town gate's distance from the zone's centre of mass. */
function cellsByCentre(zone, b, W, H, water) {
	const cells = [];
	let sx = 0, sy = 0;
	for (let c = 0; c < W * H; c++) {
		if (zone[c] !== b || (water && water[c])) continue;
		cells.push(c);
		sx += c % W;
		sy += (c / W) | 0;
	}
	if (!cells.length) return cells;
	const cx = sx / cells.length, cy = sy / cells.length;
	const [gx, gy] = visitableCells(OBJECT_TEMPLATES.randomTown, 0, 0)[0] || [0, 0];
	const d = c => (c % W + gx - cx) ** 2 + (((c / W) | 0) + gy - cy) ** 2;
	return cells.sort((p, q) => d(p) - d(q) || p - q);
}

/**
 * Where the engine puts a zone's first town (TownPlacer::placeMainTown): its
 * gate on the cell nearest the centre of mass of the zone's ground, the
 * zone's position once the zones are laid (Zone::moveToCenterOfMass).
 * Returns {x, y}, or null when a town fits nowhere in the zone.
 */
function townNearCentre(zone, b, W, H, levelIndex, blocked, water, barriers) {
	for (const c of cellsByCentre(zone, b, W, H, water)) {
		const x = c % W, y = (c / W) | 0;
		if (townFitsZone(zone, b, x, y, W, H, levelIndex, blocked, barriers)) return { x, y };
	}
	return null;
}

function planLevel({ W, H, levelIndex, playerStarts, alignPlayers, towns,
	params, terrainShortIds, tileIdsByShort, numTiles, blocked, underground,
	objectPools, terrainInfo }) {
	const p = { ...BIOME_DEFAULTS, ...params };
	const rng = xorshift((params.seed || 1) + levelIndex * 911 + (underground ? 17 : 0));

	// Surface water (water.js), built by the caller before the starts were
	// fixed. It is occupied ground from the first pass on, the way an
	// underground level's rock is, so nothing is ever placed on it; zones
	// partition the land it leaves and meet only on land.
	const water = levelIndex === 0 && !underground && p.waterMask ? p.waterMask : null;
	p.water = water;
	let landCells = W * H;
	if (water) {
		for (let c = 0; c < W * H; c++)
			if (water[c]) { blocked[levelIndex * W * H + c] |= OCCUPIED; landCells--; }
		console.error(`[gen] level ${levelIndex}: ${W * H - landCells} cells of water `
			+ `(${(100 * (W * H - landCells) / (W * H)).toFixed(1)}%)`);
	}

	// Template mode: params.zonePlan carries the RMG template's zones for this
	// level (index == biome index) plus its connection graph. Zone layout,
	// class, terrain and borders all follow the template instead of the
	// free-running ratios.
	const tplZones = p.zonePlan && p.zonePlan.perLevel[levelIndex];
	let zone, seeds, classes, edgeInfo, unfulfilled, zdist = null;
	const tplConns = tplZones ? p.zonePlan.connections
		.filter(c => c.aRef && c.bRef
			&& c.aRef.l === levelIndex && c.bRef.l === levelIndex)
		.map(c => ({ ...c, a: c.aRef.i, b: c.bRef.i })) : [];
	// the links a shared border has to carry (guarded and wide), and those the
	// template always wants as a monolith pair (forcePortal); fictive and
	// repulsive links only steer the layout (template.js buildZonePlan)
	const landConns = tplConns.filter(isLandLink);
	const forcedPortals = tplConns.filter(c => c.type === 'forcePortal');
	phase('sculpt');
	if (tplZones && tplZones.length) {
		const best = chooseTemplateLayout({ tplZones, tplConns, W, H, playerStarts, water,
			seed: params.seed || 1, levelIndex, p,
			preset: p.zonePlan.presetSeeds && p.zonePlan.presetSeeds[levelIndex], anchors: p.layoutAnchors || null });
		({ seeds, zone } = best);
		if (best.tries > 1)
			console.error(`[gen] level ${levelIndex}: ${best.k < 0 ? 'the free layout the starts came from' : `zone layout ${best.k + 1} of ${best.tries}`} kept, `
				+ `${best.missing} of ${best.links} template links without a shared border`);
		classes = tplZones.map(z => {
			// a start zone for a player the map does not have becomes a
			// prize zone with a neutral town rather than a dead start
			if ((z.type === 'playerStart' || z.type === 'cpuStart')
				&& !startOfOwner(playerStarts, z.owner)) return BIOME_CLASS.HIGH_LOOT;
			return ZONE_CLASS[z.type] || BIOME_CLASS.STANDARD;
		});
	} else {
		// Biome count scales with area; Nostalgia-style ~1 biome per 400 cells,
		// clamped so small maps still get structure. zoneCells and zoneCap are
		// the player's biome-size levers (defaults 400 and 300; zoneCap only
		// binds if a player pulls it below what zoneCells implies for this
		// map, or at the extreme of a huge map with a tiny zoneCells).
		// With water the count follows the land: zoneCells is dry ground per zone.
		// The starts first: each takes its share of the land (startZoneShare,
		// biomes.js), and the other zones split the rest at zoneCells each.
		const startCells = playerStarts.length
			? Math.min(p.startZoneShare / playerStarts.length, MAX_START_SHARE) * landCells : 0;
		const target = Math.max(playerStarts.length + 2,
			Math.min(p.zoneCap, playerStarts.length + Math.round(
				(landCells - playerStarts.length * startCells) / Math.max(50, p.zoneCells))));
		({ zone, seeds } = partitionBiomes(W, H, playerStarts, target, rng, p, water, startCells));
		if (water) {
			settleZonesOnLand(zone, seeds, W, H, water);
			const land = new Array(seeds.length).fill(0);
			for (let c = 0; c < W * H; c++) if (!water[c]) land[zone[c]]++;
			console.error(`[gen] level ${levelIndex}: ${seeds.length} zones on `
				+ `${landCells} land cells, smallest ${Math.min(...land)}, `
				+ `largest ${Math.max(...land)}`);
		}
		zdist = zoneDistances(seeds, biomeEdges(zone, W, H, seeds.length, water));
		// class assignment orders non-player zones by physical distance from
		// the starts - near is poor, far is rich, like a template's
		// playerStart vs treasure zones. Graph hops said "far" about zones
		// that sat right beside a start, so the 950/cell budget landed in the
		// near band while the true far cells ran standard: the corpus
		// distance-vs-value gradient is measured in cells, not hops.
		classes = assignClasses(seeds, p, rng,
			physZoneDistances(zone, W, H, playerStarts, water, !!p.waterIslands));
	}
	phase('lands');
	const biomeTerrain = assignTerrains(classes, terrainShortIds, rng,
		terrainInfo, underground,
		tplZones || null);

	// A player start takes its rolled faction's native terrain across the
	// whole home biome - the engine's matchTerrainToTown. A terrain that
	// cannot appear on this layer demotes the way the engine demotes it:
	// dirt on the surface, subterranean underground. Two starts sharing
	// one biome keep the first winner; the second keeps the class draw.
	const nativeClaims = new Map();
	for (const s of playerStarts) {
		if (!s.native) continue;
		let shortId = null;
		for (const [id, t] of terrainInfo || [])
			if (t.identifier === s.native && String(t.name).startsWith('core:'))
				{ shortId = id; break; }
		if (!shortId)
			for (const [id, t] of terrainInfo || [])
				if (t.identifier === s.native) { shortId = id; break; }
		if (!shortId || !terrainShortIds.includes(shortId)) {
			console.error(`[gen] level ${levelIndex}: no terrain named `
				+ `"${s.native}" indexed for ${s.color}'s faction - `
				+ 'keeping the class draw');
			continue;
		}
		const layer = underground ? 'underground' : 'surface';
		const t = terrainInfo.get(shortId);
		if (!(t.allowedLayers || []).includes(layer)) {
			const fb = layer === 'surface' ? 'dirt' : 'subterra';
			for (const [id, t2] of terrainInfo)
				if (t2.identifier === fb) { shortId = id; break; }
		}
		const b = zone[s.y * W + s.x];
		if (nativeClaims.has(b)) {
			console.error(`[gen] level ${levelIndex}: ${s.color}'s start `
				+ `shares biome ${b} with ${nativeClaims.get(b)} - `
				+ 'keeping the class draw');
			continue;
		}
		nativeClaims.set(b, s.color);
		biomeTerrain[b] = shortId;
	}

	// Every other template zone rolls its town type first and is painted that
	// faction's native terrain, as the engine does it (TownPlacer::placeTowns,
	// then TerrainPainter::initTerrainType under matchTerrainToTown, on by
	// default): a zone with towns rolls one of the factions it allows, one
	// without stays neutral one time in four and rolls one otherwise. A neutral
	// zone, or one with matchTerrainToTown off, keeps the even draw above. The
	// roll is also the zone's first town (zoneMeta.townType, content.js).
	const zoneTownType = [];
	const tp = objectPools && objectPools.towns;
	if (tplZones && tp && tp.factions && process.env.VMAPGEN_TPL_TERRAIN !== 'class') {
		const layer = underground ? 'underground' : 'surface';
		const unscope = s => String(s).slice(String(s).lastIndexOf(':') + 1).toLowerCase();
		const terrainNamed = name => {
			let any = null;
			for (const [id, t] of terrainInfo || []) {
				if (unscope(t.identifier) !== name || !terrainShortIds.includes(id)) continue;
				if (String(t.name).startsWith('core:')) return id;
				any = any || id;
			}
			return any;
		};
		tplZones.forEach((z, i) => {
			if (z.owner && startOfOwner(playerStarts, z.owner)) return;   // a start: its player's faction
			const types = zoneTownTypes(z, tp.factions);
			if (!types.length) return;
			const nt = z.neutralTowns || {};
			const towns = (nt.castles || 0) + (nt.towns || 0);
			const faction = towns || rng() >= 0.25 ? types[(rng() * types.length) | 0] : null;
			zoneTownType[i] = faction;
			if (!faction || !faction.native || z.matchTerrainToTown === false || nativeClaims.has(i)) return;
			let id = terrainNamed(unscope(faction.native));
			if (!id) return;
			if (!((terrainInfo.get(id) || {}).allowedLayers || []).includes(layer))
				id = terrainNamed(underground ? 'subterra' : 'dirt') || id;
			biomeTerrain[i] = id;
		});
	}

	// Per-zone fill overrides for template mode. Town counts come from
	// playerTowns/neutralTowns (the start castle is already emitted at the
	// start cell, so it is discounted); mines and monsters pass through with
	// the engine's names translated in fillBiome; treasure bands become a
	// loot multiplier against the template's own median zone.
	// each zone's town type as the engine's treasure piles see it: the owner's
	// faction in a start zone, the rolled one elsewhere, neutral for a zone that
	// rolled none; and how many zones share it, which prices its dwellings
	// (TreasurePlacer::addDwellings; counted on this level, the level below
	// not being rolled yet)
	const zoneFaction = tplZones ? tplZones.map((z, i) => {
		const ownerStart = z.owner && startOfOwner(playerStarts, z.owner);
		const tp = objectPools && objectPools.towns;
		const f = ownerStart && tp && tp.pinned ? tp.pinned.get(ownerStart.color) : zoneTownType[i];
		return f && f.bare ? f.bare : 'neutral';
	}) : [];
	const zoneMeta = tplZones && tplZones.map((z, zi) => {
		const ownerStart = z.owner && startOfOwner(playerStarts, z.owner);
		const townWishes = [];
		const pt = z.playerTowns || {}, nt = z.neutralTowns || {};
		// in the engine's order (TownPlacer::placeTowns): the owner's castles
		// and towns, then neutral castles, then neutral towns; a castle starts
		// with its fort
		for (let k = Math.max(0, (pt.castles || 0) - (ownerStart ? 1 : 0)); k > 0; k--)
			townWishes.push({ owner: ownerStart && ownerStart.color, fort: true });
		for (let k = pt.towns || 0; k > 0; k--)
			townWishes.push({ owner: ownerStart && ownerStart.color, fort: false });
		for (let k = nt.castles || 0; k > 0; k--)
			townWishes.push({ owner: null, fort: true });
		for (let k = nt.towns || 0; k > 0; k--)
			townWishes.push({ owner: null, fort: false });
		return {
			mines: z.mines, towns: townWishes,
			// the player whose start this zone is, whose faction is the zone's
			// town type
			ownerColor: ownerStart ? ownerStart.color : null,
			// any other zone's rolled town type, which its terrain follows
			townType: zoneTownType[tplZones.indexOf(z)] || null,
			faction: zoneFaction[zi],
			nativeZones: zoneFaction.filter(f => f === zoneFaction[zi]).length,
			totalZones: (p.zonePlan && p.zonePlan.zones && p.zonePlan.zones.length) || tplZones.length,
			loot: pileLoot(z),
			guardScale: MONSTER_BAND[z.monsters || 'normal'] ?? 1,
			monsterShift: z.monsters === 'weak' ? -1
				: z.monsters === 'strong' ? 1 : 0,
			spec: z,
		};
	});

	const edges = biomeEdges(zone, W, H, seeds.length, water);
	let connections;
	if (tplZones && tplZones.length) {
		({ connections, edgeInfo, unfulfilled } =
			templateConnections(edges, landConns, rng, p));
	} else {
		connections = assignConnections(edges, p, rng, seeds.length);
		edgeInfo = new Map();
		unfulfilled = [];
	}
	// interconnectivity is a per-border coin flip, so it can leave a biome, or
	// a whole group of them, with every border sealed. Open the minimum number
	// of extra borders that puts every biome back in one piece.
	// A template level whose zones meet only through the other level (two
	// starts below, each linked up to the centre) still opens a border here:
	// the passes that keep a level in one piece count one level at a time, and
	// without it they cut the wall open with no guard (Coldshadow's Fantasy
	// 144x2). The border gets the guard of the strongest link either zone has
	// (placeChokeGuards' forcedStrength), so it parts the zones as the
	// template's own links do.
	const forced = ensureConnected(edges, connections, seeds.length, p, rng);
	if (forced)
		console.error(`[gen] level ${levelIndex}: opened ${forced} extra biome `
			+ 'border(s) to keep the map in one piece');
	// A start leaves its zone on foot. Since portal borders seal (queue 27) a
	// start zone whose open borders all drew portals boxed its player into
	// 35-74 walkable cells with monoliths as the only way out (36x36 p8 s2,
	// 72x72 p4 s17: start value spreads x14 and x13.5). Such a zone opens its
	// widest portal border, or its widest sealed one, as a road. Templates
	// keep their own links.
	if (!(tplZones && tplZones.length)) {
		let reopened = 0;
		seeds.forEach((s, i) => {
			if (!s.player) return;
			const mine = edges.filter(e => e.a === i || e.b === i);
			const kindOf = e => connections.get(e.a * 100000 + e.b);
			if (!mine.length || mine.some(e => /^open/.test(kindOf(e)))) return;
			const pick = kind => mine.filter(e => kindOf(e) === kind)
				.sort((x, y) => y.borderCells.length - x.borderCells.length)[0];
			const e = pick('portal') || pick('blocked');
			if (!e) return;
			connections.set(e.a * 100000 + e.b, 'openRoad');
			reopened++;
		});
		if (reopened)
			console.error(`[gen] level ${levelIndex}: gave ${reopened} start zone(s) `
				+ 'a land border (their open borders were all portals)');
	}
	// A portal link takes a monolith channel of its own, and the map has
	// eight (portals.js): a free layout's portal borders past the channels
	// still free open as doorways instead, so no two links share one.
	if (!(tplZones && tplZones.length) && p._links) {
		let left = p._links.left(), opened = 0;
		for (const e of edges) {
			const k = e.a * 100000 + e.b;
			if (connections.get(k) !== 'portal') continue;
			if (left > 0) { left--; continue; }
			connections.set(k, 'openNoRoad');
			opened++;
		}
		if (opened)
			console.error(`[gen] level ${levelIndex}: ${opened} portal border(s) opened as doorways, `
				+ 'the monolith channels all taken');
	}
	// layout only (VMAPGEN_PLAN_ONLY, for analysis): zones and links are
	// decided, which is all the water compatibility matrix measures
	if (p.layoutOnly)
		return { zone, classes, levelIndex, stats: layoutStats(zone, seeds, tplZones,
			tplConns, unfulfilled, forced, W, H, water, null, landCells) };
	// Underground: cut chambers and tunnels out of solid rock, and mark the
	// rock as occupied so every later pass routes around it without knowing
	// anything about caves.
	let openMask = null, carvedBounds = null;
	if (underground && p.undergroundRock !== false) {
		// the doorways first: the carve runs each path link's tunnel through its
		// own doorway and keeps the rest of every zone line rock
		carvedBounds = carveBoundaries(edges, connections, zone, W, H,
			{ ...p, underground: true }, rng, edgeInfo);
		openMask = carveUnderground(W, H, zone, seeds, edges, connections, p, rng, carvedBounds.openings);
		if (openMask.tunnelsFailed)
			console.error(`[gen] level ${levelIndex}: ${openMask.tunnelsFailed} doorway side(s) no tunnel reached`);
		const doorCell = new Uint8Array(W * H);
		for (const o of carvedBounds.openings)
			if (o.kind !== 'portal' && o.hole.length) for (const c of doorCells(o, zone, W, H)) doorCell[c] = 1;
		// under each gate site the level above held (gateSites, above), floor
		// for this half: a small chamber, and a tunnel from it to the chamber
		// of the zone the link names, so the gate does not open into a sealed
		// pocket; only where that zone lies under the site
		if (p.zonePlan && p.gateSitesAbove && p.gateSitesAbove.length) {
			const links = new Map(crossLinks(p.zonePlan, levelIndex).filter(c => c.hi.l === levelIndex).map(c => [c.k, c]));
			// the zone's own cells only, and never beside another zone's open
			// ground (the zone line stays rock, carveUnderground)
			const open = (x, y, r) => {
				for (let yy = Math.max(0, Math.floor(y - r)); yy <= Math.min(H - 1, Math.ceil(y + r)); yy++)
					for (let xx = Math.max(0, Math.floor(x - r)); xx <= Math.min(W - 1, Math.ceil(x + r)); xx++) {
						const k = yy * W + xx;
						if ((xx - x) ** 2 + (yy - y) ** 2 <= r * r && zone[k] === zone[y * W + x]
								&& zoneLineSafe(openMask, zone, W, H, k, doorCell)) openMask[k] = 1;
					}
			};
			const flat = new Float64Array(W * H).fill(1);
			for (const s of p.gateSitesAbove) {
				const c = links.get(s.k);
				if (!c || zone[s.y * W + s.x] !== c.hi.i) continue;
				const carved = openMask.slice();
				open(s.x, s.y, 2.6);
				// and a tunnel from it to the ground the carve opened in that zone
				tunnelInZone(openMask, zone, W, H, [s.y * W + s.x], c.hi.i, 1.1, flat, doorCell,
					k => carved[k] && !doorCell[k]);
			}
		}
		// shape the carve for the terrain art before anything reads it (queue
		// 26): no sprite fits one-cell rock or one-cell notches
		if (p.caveChecker) {
			// a doorway's cells stay open: its guard stands in one of them
			const fit = fitCave(openMask, zone, W, H, p.caveChecker, 12, doorCell);
			console.error(`[gen] level ${levelIndex}: cave shaped for the terrain art, `
				+ `${fit.before} -> ${fit.after} cell(s) no sprite fits `
				+ `(${fit.opened} opened, ${fit.closed} closed)`);
		}
		let rock = 0;
		for (let c = 0; c < W * H; c++)
			if (!openMask[c]) { blocked[levelIndex * W * H + c] |= OCCUPIED; rock++; }
		console.error(`[gen] level ${levelIndex}: ${rock} cells of solid rock, `
			+ `${W * H - rock} carved open`);
	}
	// the lower halves of the held gates, on the floor opened for them
	const gateSitesHere = [];
	if (p.zonePlan && p.gateSitesAbove && p.gateSitesAbove.length) {
		const links = new Map(crossLinks(p.zonePlan, levelIndex).filter(c => c.hi.l === levelIndex).map(c => [c.k, c]));
		const tpl = OBJECT_DEFS.subterraneanGateUnder;
		for (const s of p.gateSitesAbove) {
			const c = links.get(s.k);
			if (process.env.VMAPGEN_GATE_TRACE && c)
				console.error(`[gate] link ${s.k}: below (${s.x},${s.y}) is zone ${zone[s.y * W + s.x]}, `
					+ `the link wants ${c.hi.i} (seed ${seeds[c.hi.i] ? seeds[c.hi.i].x + ',' + seeds[c.hi.i].y : '-'})`);
			if (!c || !inZone(tpl, s.x, s.y, zone, c.hi.i, W, H)) continue;
			if (!footprintFits(tpl, s.x, s.y, levelIndex, W, H, blocked)) continue;
			if (!entranceOpen(tpl, s.x, s.y, levelIndex, W, H, blocked, null)) continue;
			holdGateGround(tpl, s.x, s.y, levelIndex, W, H, blocked);
			gateSitesHere.push({ k: s.k, x: s.x, y: s.y });
		}
		console.error(`[gen] level ${levelIndex}: ground held below ${gateSitesHere.length} of the `
			+ `${p.gateSitesAbove.length} gate site(s) above`);
	}
	// Underground lava is a floor share, not a zone share: the per-class
	// 9:1 draw picks lava for about a tenth of ZONES, but a lava zone on a
	// four-zone level is a quarter of the floor by itself, which is where
	// the 23.3% readings came from (corpus: 9.0%). Now that the carve is
	// known, walk the share into range: demote the biggest lava zones while
	// over ~11% of open cells, promote the smallest free-draw zone while
	// under ~7%, and never touch a zone with an explicit template
	// terrainTypes - that list is a contract, not a draw.
	if (openMask && underground && terrainInfo) {
		const nameHas = (id, frag) => {
			const t = terrainInfo.get(id);
			const n = t && t.name ? String(t.name) : String(id);
			return n.slice(n.lastIndexOf(':') + 1).toLowerCase().includes(frag);
		};
		const prefs = tplZones && tplZones.map(z => z.terrainTypes);
		const pinned = i => prefs && prefs[i] && prefs[i].length;
		// demote target: the subterranean id, else whatever non-lava terrain
		// most zones already drew (guaranteed underground-legal by the pool)
		let subId = terrainShortIds.find(id => nameHas(id, 'subterra'));
		if (!subId) {
			const use = new Map();
			for (let i = 0; i < classes.length; i++)
				if (!nameHas(biomeTerrain[i], 'lava'))
					use.set(biomeTerrain[i], (use.get(biomeTerrain[i]) || 0) + 1);
			for (const [id, n] of use)
				if (!subId || n > use.get(subId)) subId = id;
		}
		const lavaId = terrainShortIds.find(id => nameHas(id, 'lava'));
		const openSize = new Map();
		let open = 0;
		for (let c = 0; c < W * H; c++)
			if (openMask[c]) {
				open++;
				openSize.set(zone[c], (openSize.get(zone[c]) || 0) + 1);
			}
		const lavaZones = new Set();
		for (let i = 0; i < classes.length; i++)
			if (nameHas(biomeTerrain[i], 'lava')) lavaZones.add(i);
		let lavaCells = 0;
		for (const i of lavaZones) lavaCells += openSize.get(i) || 0;
		while (open && lavaCells / open > 0.11 && lavaZones.size) {
			let big = -1, bs = -1;
			for (const i of lavaZones) {
				const s = openSize.get(i) || 0;
				if (s > bs && !pinned(i)) { bs = s; big = i; }
			}
			if (big < 0) break;          // every lava zone left is pinned
			lavaZones.delete(big);
			biomeTerrain[big] = subId;
			lavaCells -= bs;
		}
		while (open && lavaCells / open < 0.07 && lavaId) {
			let small = -1, ss = Infinity;
			for (let i = 0; i < classes.length; i++) {
				if (lavaZones.has(i) || pinned(i)) continue;
				const s = openSize.get(i) || 0;
				if (s && s < ss) { ss = s; small = i; }
			}
			// stop rather than jump past the band: on a three-zone level
			// the smallest zone is a third of the floor
			if (small < 0 || (lavaCells + ss) / open > 0.14) break;
			lavaZones.add(small);
			biomeTerrain[small] = lavaId;
			lavaCells += ss;
		}
		if (lavaZones.size || lavaCells)
			console.error(`[gen] level ${levelIndex}: lava share `
				+ `${(100 * lavaCells / open).toFixed(1)}% of carved floor `
				+ `(${lavaZones.size} zone(s))`);
	}

	phase('borders');
	const { barriers, openings, rim } = carvedBounds || carveBoundaries(edges, connections, zone,
		W, H, { ...p, underground: !!openMask }, rng, edgeInfo);
	const book = p._links || (p._links = linkBook());
	for (const o of openings)
		if (o.kind !== 'portal') book.join(`${levelIndex}:${o.a}`, `${levelIndex}:${o.b}`);
	// VMAPGEN_OPENINGS_TRACE: every zone border's verdict and the doorways cut
	if (process.env.VMAPGEN_OPENINGS_TRACE) {
		seeds.forEach((s, i) => console.error(`[zones] ${levelIndex}: zone ${i} seed (${s.x},${s.y})${s.player ? ' player' : ''}`));
		for (const e of edges)
			console.error(`[zones] ${levelIndex}: border ${e.a}-${e.b} ${e.borderCells.length} cells: `
				+ `${connections.get(e.a * 100000 + e.b)}`);
		for (const o of openings)
			console.error(`[zones] ${levelIndex}: opening ${o.a}-${o.b} ${o.kind} hole ${o.hole.length} ${o.hole.map(c => `(${c % W},${(c / W) | 0})`).join(" ")}`);
	}
	// A template link whose zones ended up not touching still has to exist, so
	// it is bridged with a monolith pair on cells deep inside each zone.
	if (unfulfilled.length || forcedPortals.length) {
		const cellsByBiome = new Map();
		for (let i = 0; i < zone.length; i++) {
			if (!cellsByBiome.has(zone[i])) cellsByBiome.set(zone[i], []);
			cellsByBiome.get(zone[i]).push(i);
		}
		const nearSeed = (cells, b) => {
			const s = seeds[b];
			let best = cells[0], bd = Infinity;
			for (const c of cells) {
				const d = (c % W - s.x) ** 2 + (((c / W) | 0) - s.y) ** 2;
				if (d < bd) { bd = d; best = c; }
			}
			return best;
		};
		// a forcePortal link is always a monolith pair (ConnectionsPlacer.cpp:132)
		for (const c of [...unfulfilled, ...forcedPortals]) {
			const cellsA = cellsByBiome.get(c.a), cellsB = cellsByBiome.get(c.b);
			if (!cellsA || !cellsA.length || !cellsB || !cellsB.length) continue;
			openings.push({ a: c.a, b: c.b, kind: 'portal', hole: [],
				portalA: nearSeed(cellsA, c.a), portalB: nearSeed(cellsB, c.b),
				inner: [], tplGuard: c.guard || 0, road: c.road === true });
			const zid = i => (tplZones && tplZones[i] && tplZones[i].id) || i;
			if (c.type === 'forcePortal')
				console.error(`[gen] level ${levelIndex}: template link ${zid(c.a)}-${zid(c.b)} is a portal pair by the template`);
			else
				console.error(`[gen] level ${levelIndex}: template link ${zid(c.a)}-${zid(c.b)} has no shared `
					+ 'border; bridged with a portal pair');
		}
	}
	// a template level's border the template has no link for: guarded as the
	// strongest link either zone has, across the levels too, and never below
	// the template's own cheapest way between the two (templateBottleneck).
	// With the strongest link alone, two zones whose links were all free got
	// a free border: [HotA] Nostalgia's two groups of four starts, apart by
	// its 12,500 links, met through one below (seed 5002, starts underground).
	const bottleneck = tplZones && tplZones.length && p.zonePlan ? templateBottleneck(p.zonePlan) : null;
	const forcedStrength = bottleneck
		? (a, b) => {
			let g = 0;
			for (const c of p.zonePlan.connections)
				for (const r of [c.aRef, c.bRef])
					if (r && r.l === levelIndex && (r.i === a || r.i === b)) g = Math.max(g, c.guard || 0);
			const t = bottleneck(levelIndex, a, levelIndex, b);
			return Math.max(g, Number.isFinite(t) ? t : 0);
		} : null;
	const guards = placeChokeGuards(openings, classes, rng, p, edgeInfo,
		objectPools && objectPools.guards && zoneMeta
			? z => zoneGuardPool(objectPools.guards, zoneMeta[z] && zoneMeta[z].spec) : null, forcedStrength);
	// Hold the doorways clear. A path opening is two or three cells wide and
	// the chokepoint guard takes one of them, so a single object dropped on
	// the rest turns a connected map into two sealed halves. Reserved ground
	// stays walkable; it just may not be built on.
	const guardCells = new Set(guards.map(g => g.cell));
	for (const o of openings)
		for (const c of o.hole.concat(o.inner || []))
			if (!guardCells.has(c)) reserveCell(blocked, levelIndex, W, H, c);
	// The guard's own cell is held as a doorstep: nothing is built on it and
	// the corridor web counts it as its own, but it is not reserved, which the
	// guard's placement refuses. Left bare, the corridor pass widened its web
	// onto it (every free cell beside a reserved one) and a doorway whose hole
	// ran straight lost its guard: all four of Jebus Cross's 45000 links on
	// 108 s5001, every start walking into the centre unopposed.
	for (const c of guardCells) blocked[levelIndex * W * H + c] |= APPROACH;

	// A template start's town stands at its zone's centre, where the engine
	// puts it: once the zones are laid each one's position moves to the centre
	// of mass of its ground (Zone::moveToCenterOfMass, CZonePlacer.cpp:1017) and
	// the main town goes on the cell nearest it (TownPlacer::placeMainTown). The
	// start cell only seeds the zone. Standing on it, a corner seed put the town
	// in its zone's corner against the map's edge, with the zone's other towns
	// beside it and its roads a fraction of the engine's (Jebus Cross 108: 356
	// road tiles against the corpus's 613). VMAPGEN_START_CENTRE=0 keeps the cell.
	phase('capitals');
	if (tplZones && tplZones.length && process.env.VMAPGEN_START_CENTRE !== '0')
		tplZones.forEach((z, b) => {
			const s = (z.type === 'playerStart' || z.type === 'cpuStart') && z.owner && startOfOwner(playerStarts, z.owner);
			if (!s) return;
			const at = townNearCentre(zone, b, W, H, levelIndex, blocked, water, barriers);
			if (!at || (at.x === s.x && at.y === s.y)) return;
			console.error(`[gen] level ${levelIndex}: ${s.color || 'a player'}'s town to its zone's centre, `
				+ `(${s.x},${s.y}) -> (${at.x},${at.y})`);
			s.x = at.x;
			s.y = at.y;
		});

	// Player starts claim their footprints FIRST so barriers, guards and
	// portals placed later route around them. owner on the randomTown makes
	// CGTownInstance::randomizeFaction resolve to that player's PRE-GAME
	// castle pick (getIthPlayersSettings(owner).castle), so the town follows
	// the faction selected or randomized in the lobby. No randomHero here:
	// header mainTown.generateHero spawns the starting hero itself.
	const objects = [];
	// towns is the caller's cross-level registry: dwellings on any level can
	// link to the nearest town's instanceName (the instanceNames map is
	// map-global, so a level-1 dwelling may legally chain a surface town).
	//
	// The town is the one object placed without a fits check in front of it,
	// because the player start has to win its cell. footprintBlock now refuses
	// an out-of-bounds footprint instead of wrapping onto the previous row, and
	// an anchor that cannot hold the town at all is worth saying out loud
	// rather than generating a map with a broken start.
	for (const s of playerStarts) {
		const entry = objectEntry('randomTown', s.x, s.y, levelIndex,
			OBJECT_TEMPLATES.randomTown, 'object',
			s.color ? { owner: s.color } : undefined);
		objects.push(entry);
		towns.push({ instanceName: entry.instanceName, x: s.x, y: s.y,
			l: levelIndex, gates: visitableCells(OBJECT_TEMPLATES.randomTown, s.x, s.y) });
		if (!footprintBlock(OBJECT_TEMPLATES.randomTown, s.x, s.y, levelIndex, W, H, blocked))
			console.error(`[gen] town for ${s.color || 'player'} at (${s.x},${s.y}) `
				+ 'does not fit on the map; its footprint was not reserved');
		// Hold the ground in front of the gate. A castle's own walls cover
		// every side but one, so a single object dropped on the wrong cell
		// seals the player in. On one underground seed the stranded sweep then
		// deleted the town itself and the map shipped with a player who had no
		// start at all.
		for (const [vx, vy] of visitableCells(OBJECT_TEMPLATES.randomTown, s.x, s.y))
			for (const [dx, dy] of allowedDirs(OBJECT_TEMPLATES.randomTown)) {
				const nx = vx + dx, ny = vy + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				reserveCell(blocked, levelIndex, W, H, ny * W + nx);
			}
		// The approach cell alone is not enough: the ground past it can be a
		// dead pocket walled by the town on one side and a mass on the rest,
		// and the first object to fill its mouth seals the start. Two cells
		// of apron around each gate cell stays reserved so the throat keeps
		// an exit even when a bank or a mine wants the same corner. 36x36
		// seed 42 islanded a player through a two-cell nook this way.
		for (const [vx, vy] of visitableCells(OBJECT_TEMPLATES.randomTown, s.x, s.y))
			for (const [dx, dy] of allowedDirs(OBJECT_TEMPLATES.randomTown)) {
				const ax = vx + dx, ay = vy + dy;
				for (let py = -2; py <= 2; py++)
					for (let px = -2; px <= 2; px++) {
						const nx = ax + px, ny = ay + py;
						if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
						reserveCell(blocked, levelIndex, W, H, ny * W + nx);
					}
			}
	}

	// Neutral towns for TOWN-class zones go here with the player towns, not
	// down in fillBiome: by the time a zone's fill pass ran, the ridge and
	// wall passes had already spent ~60% of its cells and a 5x3 town fit
	// nowhere - the census read 0.59 neutral towns/1k against the corpus's
	// 1.16, and the measured remainder was entirely player towns. Placed
	// here the later passes route around it the same way they route around
	// a start.
	// The connectivity guard at fillBiome time does not exist yet, so this
	// pass carries its own: a 5x3 in a narrow corridor plugs it and seals
	// whatever pocket lies past it (72x72 s5 islanded green this way).
	phase('towns');
	const townGuard = makeConnectivityGuard(blocked, levelIndex, W, H, 2);
	const townZones = [];
	for (let b = 0; b < classes.length; b++)
		if (classes[b] === BIOME_CLASS.TOWN) townZones.push(b);
	// Towns per acre (queue item 19). townRatio works on zones and the zone
	// count caps at 12, so 72x72 and 108x108 both came out with about one
	// neutral town: 0.43 towns per 1000 floor cells on 108x108 against the
	// corpus's 1.04, 0.34 on 144x144 against 0.58. The corpus surface runs
	// 1.0 per 1000 cells up to 108x108, 0.58 at 144x144, 0.42 at 180x180.
	// The shortfall goes to non-player zones, one town each, farthest from
	// any start first (a neutral town beside one start is a free second
	// castle for that player alone; the corpus's templates park neutral towns
	// in treasure zones), through the same placement as a TOWN zone. The zone
	// keeps its class, so a loot zone keeps its loot. Template maps carry
	// their own town lists.
	// The underground gets its towns the same way, per acre of carved floor:
	// the corpus's two-level maps carry 7.9 neutral towns underground a map
	// against our 0.9 while this ran on the surface only (fidelity lens,
	// 2026-09-25, 32 two-level maps matched to the corpus).
	if (!tplZones) {
		const A = W * H;
		const perK = A <= 11664 ? 1.0
			: A <= 20736 ? 1.0 + (0.58 - 1.0) * (A - 11664) / (20736 - 11664)
			: A <= 32400 ? 0.58 + (0.42 - 0.58) * (A - 20736) / (32400 - 20736) : 0.42;
		// towns per acre of land: the size class sets the rate, water takes
		// ground away from it, rock takes it away underground
		let acres = landCells;
		if (underground && openMask) {
			acres = 0;
			for (let c = 0; c < W * H; c++) if (openMask[c]) acres++;
		}
		const extra = Math.max(0, Math.round(acres / 1000 * perK)
			- playerStarts.length - townZones.length);
		if (extra) {
			const far = b => playerStarts.reduce((m, s) =>
				Math.min(m, (s.x - seeds[b].x) ** 2 + (s.y - seeds[b].y) ** 2), Infinity);
			const cand = [];
			for (let b = 0; b < classes.length; b++)
				if (classes[b] !== BIOME_CLASS.PLAYER && classes[b] !== BIOME_CLASS.TOWN) cand.push(b);
			cand.sort((a, b) => far(b) - far(a) || a - b);
			townZones.push(...cand.slice(0, extra));
			console.error(`[gen] level ${levelIndex}: ${Math.min(extra, cand.length)} extra `
				+ `neutral town(s) for map area`);
		}
	}
	for (const b of townZones) {
		const cells = [];
		for (let i = 0; i < zone.length; i++) if (zone[i] === b) cells.push(i);
		// Try cells nearest the zone seed first so the town reads as the
		// region's centre rather than whatever edge survived.
		const seed = seeds[b];
		cells.sort((p, q) => {
			const d = i => (i % W - seed.x) ** 2 + (((i / W) | 0) - seed.y) ** 2;
			return d(p) - d(q);
		});
		let done = false;
		for (const i of cells) {
			const x = i % W, y = (i / W) | 0;
			// No neutral town within 12 cells of a start: on corpus 108x108
			// maps 2 of 103 owned towns have one within 10 (median nearest
			// 22), and ours had 3 of 16, one at 6, which hands that player a
			// second castle on day one.
			if (playerStarts.some(s =>
				Math.max(Math.abs(s.x - x), Math.abs(s.y - y)) < 12)) continue;
			if (!footprintFits(OBJECT_TEMPLATES.randomTown, x, y, levelIndex,
					W, H, blocked)) continue;
			if (!entranceOpen(OBJECT_TEMPLATES.randomTown, x, y, levelIndex,
					W, H, blocked, null)) continue;
			const walls = blockingCells(OBJECT_TEMPLATES.randomTown, x, y)
				.map(([a, b2]) => b2 * W + a);
			if (!townGuard.accepts(walls)) continue;
			const np = playerStarts.length
				? playerStarts.reduce((m, s) =>
						(s.x - x) ** 2 + (s.y - y) ** 2 < (m.x - x) ** 2 + (m.y - y) ** 2 ? s : m)
				: null;
			const entry = objectEntry('randomTown', x, y, levelIndex,
				OBJECT_TEMPLATES.randomTown, 'object',
				np && np.color ? { alignmentToPlayer: np.color } : undefined);
			objects.push(entry);
			towns.push({ instanceName: entry.instanceName, x, y,
				l: levelIndex,
				gates: visitableCells(OBJECT_TEMPLATES.randomTown, x, y) });
			footprintBlock(OBJECT_TEMPLATES.randomTown, x, y, levelIndex, W, H, blocked);
			townGuard.refresh();
			// Same apron rule as a player start: the cells a hero steps on to
			// open the gate stay reserved, so nothing seals the town in.
			for (const [vx, vy] of visitableCells(OBJECT_TEMPLATES.randomTown, x, y))
				for (const [dx, dy] of allowedDirs(OBJECT_TEMPLATES.randomTown)) {
					const nx = vx + dx, ny = vy + dy;
					if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
					reserveCell(blocked, levelIndex, W, H, ny * W + nx);
				}
			done = true;
			break;
		}
		if (!done)
			console.error(`[gen] level ${levelIndex}: no cell fits a neutral town `
				+ `in zone ${b} (${classes[b]}, ${cells.length} cells)`);
	}

	// A template zone's own towns are put down in its fill, and by then the
	// ridge and wall passes had spent most of the zone: 8XM8 lost one to
	// three of its nine neutral towns a map for want of room. The engine
	// places a zone's towns before anything else in it (TownPlacer), so their
	// ground is held here: the footprint (as OCCUPIED) and the apron before the
	// gate (RESERVED), so every later pass routes around it. The fill puts the
	// town on the held spot (content.js, zoneMeta.townSpots).
	// Where they go is the engine's rule too: a zone's first town nearest its
	// centre (TownPlacer::placeMainTown; a start zone's first is its player's),
	// and each town after it on the ground farthest from everything the zone
	// holds by then, its towns and the guards in its doorways
	// (ObjectManager::createRequiredObjects, OptimizeType::DISTANCE). All of
	// them used to go nearest the zone's seed, which in a start zone is the
	// start itself: Jebus Cross put a player's two extra towns against their own,
	// where the engine spreads them to the zone's far corners.
	// VMAPGEN_TOWN_SPREAD=0 keeps the seed order.
	if (tplZones && zoneMeta) {
		const townTpl = OBJECT_TEMPLATES.randomTown;
		const spread = process.env.VMAPGEN_TOWN_SPREAD !== '0';
		zoneMeta.forEach((meta, b) => {
			const want = meta && meta.towns ? meta.towns.length : 0;
			if (!want) return;
			meta.townSpots = [];
			const cells = [];
			for (let i = 0; i < zone.length; i++) if (zone[i] === b) cells.push(i);
			const sd = seeds[b];
			const bySeed = cells.slice().sort((p2, q) => ((p2 % W - sd.x) ** 2 + (((p2 / W) | 0) - sd.y) ** 2)
				- ((q % W - sd.x) ** 2 + (((q / W) | 0) - sd.y) ** 2));
			// what the zone's later towns keep away from
			const held = [];
			for (const s of playerStarts)
				if (zone[s.y * W + s.x] === b)
					for (const [a, b2] of blockingCells(townTpl, s.x, s.y)) held.push(b2 * W + a);
			for (const o of openings)
				if (o.a === b || o.b === b) held.push(...o.hole);
			const hasStart = playerStarts.some(s => zone[s.y * W + s.x] === b);
			const order = () => {
				if (!spread) return bySeed;
				if (!hasStart && !meta.townSpots.length) return cellsByCentre(zone, b, W, H, water);
				const far = new Map();
				for (const c of cells) {
					const x = c % W, y = (c / W) | 0;
					let m = Infinity;
					for (const h of held) {
						const d = (h % W - x) ** 2 + (((h / W) | 0) - y) ** 2;
						if (d < m) m = d;
					}
					far.set(c, m);
				}
				return cells.slice().sort((p2, q) => far.get(q) - far.get(p2) || p2 - q);
			};
			while (meta.townSpots.length < want) {
				let spot = -1;
				for (const i of order()) {
					const x = i % W, y = (i / W) | 0;
					// the same distance rule as the neutral towns above, except in a
					// player's own zone, whose extra towns are that player's
					if (!meta.ownerColor && playerStarts.some(s =>
						Math.max(Math.abs(s.x - x), Math.abs(s.y - y)) < 12)) continue;
					// two cells clear of the map edge: one held against the edge let
					// later walls close a pocket behind it, which the pocket pass then
					// opened by removing the town (2SM4d seed 101). Spread to the
					// zone's edges, a town also keeps inside the zone and off its walls.
					if (spread ? !townFitsZone(zone, b, x, y, W, H, levelIndex, blocked, barriers)
						: blockingCells(townTpl, x, y).some(([a, b2]) => a < 2 || b2 < 2 || a > W - 3 || b2 > H - 3)
							|| !footprintFits(townTpl, x, y, levelIndex, W, H, blocked)
							|| !entranceOpen(townTpl, x, y, levelIndex, W, H, blocked, null)) continue;
					const walls = blockingCells(townTpl, x, y).map(([a, b2]) => b2 * W + a);
					if (!townGuard.accepts(walls)) continue;
					// the footprint as OCCUPIED, which it will be: every pass keeps off
					// that (the map-edge rim fill covered a merely RESERVED footprint)
					for (const c of walls) blocked[levelIndex * W * H + c] |= OCCUPIED;
					townGuard.refresh();
					for (const [vx, vy] of visitableCells(townTpl, x, y))
						for (const [dx, dy] of allowedDirs(townTpl)) {
							const nx = vx + dx, ny = vy + dy;
							if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
							reserveCell(blocked, levelIndex, W, H, ny * W + nx);
						}
					held.push(...walls);
					spot = i;
					break;
				}
				if (spot < 0) break;
				meta.townSpots.push(spot);
			}
			if (meta.townSpots.length < want)
				console.error(`[gen] level ${levelIndex}: zone ${meta.spec && meta.spec.id} holds ground for `
					+ `${meta.townSpots.length} of its ${want} town(s)`);
		});
	}

	// The ground of each subterranean gate a template link down to the next
	// level will need. The engine places a zone's connections before any of its
	// objects (ConnectionsPlacer), and a gate pair needs one x,y open in both
	// zones; left to the end, the surface half found its ground spent and the
	// cave half found rock, so [HotA] Nostalgia's 24 links between levels made
	// 0-5 gate pairs and monoliths took the rest (corpus: 21 gates a map). The
	// site is in this end's zone, nearest where the zone at the other end is
	// laid out (crossLevelAnchors puts it on the mean of its partners here),
	// held as a town's ground is; the level below opens its cave under it and
	// holds the other half, and the gate pass tries the pair there first.
	const gateSites = [];
	if (tplZones && p.zonePlan && !underground && (p.zonePlan.perLevel || []).length > levelIndex + 1) {
		const links = crossLinks(p.zonePlan, levelIndex).filter(c => c.lo.l === levelIndex);
		const partners = new Map();
		for (const c of links) {
			if (!partners.has(c.hi.i)) partners.set(c.hi.i, []);
			partners.get(c.hi.i).push(c.lo.i);
		}
		const tpl = OBJECT_DEFS.subterraneanGate;
		for (const c of links) {
			const ps = partners.get(c.hi.i).map(i => seeds[i]).filter(Boolean);
			if (!ps.length || !seeds[c.lo.i]) continue;
			// a start pinned below lays its zone round its own town, not on the
			// mean of its partners here
			const pin = pinnedStartSeed(p.zonePlan, c.hi, alignPlayers || playerStarts, W, H);
			const ax = pin ? pin.x : ps.reduce((s, q) => s + q.x, 0) / ps.length;
			const ay = pin ? pin.y : ps.reduce((s, q) => s + q.y, 0) / ps.length;
			const cells = [];
			for (let i = 0; i < zone.length; i++) if (zone[i] === c.lo.i && !(water && water[i])) cells.push(i);
			cells.sort((a, b) => ((a % W - ax) ** 2 + (((a / W) | 0) - ay) ** 2) - ((b % W - ax) ** 2 + (((b / W) | 0) - ay) ** 2));
			for (const i of cells) {
				const x = i % W, y = (i / W) | 0;
				if (blockingCells(tpl, x, y).some(([a, b]) => a < 3 || b < 3 || a > W - 4 || b > H - 4)) continue;
				if (!footprintFits(tpl, x, y, levelIndex, W, H, blocked)) continue;
				if (!inZone(tpl, x, y, zone, c.lo.i, W, H)) continue;
				if (!entranceOpen(tpl, x, y, levelIndex, W, H, blocked, null)) continue;
				const walls = blockingCells(tpl, x, y).map(([a, b]) => b * W + a);
				if (!townGuard.accepts(walls)) continue;
				holdGateGround(tpl, x, y, levelIndex, W, H, blocked);
				townGuard.refresh();
				gateSites.push({ k: c.k, x, y });
				if (process.env.VMAPGEN_GATE_TRACE)
					console.error(`[gate] link ${c.k}: zone ${c.lo.i} to ${c.hi.i} below${pin ? ' (a start)' : ''}, `
						+ `aimed at (${ax.toFixed(0)},${ay.toFixed(0)}), site (${x},${y})`);
				break;
			}
		}
		if (links.length)
			console.error(`[gen] level ${levelIndex}: ground held for ${gateSites.length} of ${links.length} gate(s) down`);
	}

	// Boats and shipyards (waterfill.js, water W2) go in with the towns, so
	// every later pass routes around them and their boarding cells stay free.
	// Their own stream, so a dry map draws exactly what it did before.
	phase('harbours');
	const harbours = water ? placeHarbours({ W, H, l: levelIndex, water, zone, blocked,
		rng: xorshift(((params.seed || 1) ^ 0x5eaf00d) >>> 0), p, objects, towns,
		playerStarts, objectEntry, islands: !!p.waterIslands }) : [];

	// Portal links (queue 27) go in with the towns. A portal border is all
	// wall, so the monolith pair is the only way between its two zones, and
	// every later pass routes around the pair and follows it as a link (the
	// open ground in front of one end reaches the ground in front of the
	// other). They used to be placed near the end, on cells the rim pass had
	// already reserved, so no pair ever went down.
	// guardPortals (off by default): a monster in front of each end, its level
	// chosen the way a doorway guard's is, so a portal costs a fight too.
	const links = [];
	const openBeside = (tpl, x, y) => {
		const own = new Set(blockingCells(tpl, x, y).map(([a, b]) => b * W + a));
		const out = [];
		for (const [vx, vy] of visitableCells(tpl, x, y))
			for (const [dx, dy] of allowedDirs(tpl)) {
				const nx = vx + dx, ny = vy + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const c = ny * W + nx;
				if (!own.has(c) && !(blocked[levelIndex * W * H + c] & OCCUPIED)) out.push(c);
			}
		return out;
	};
	// the planned cell, or the nearest cell of the same zone where a monolith
	// fits with open ground in front of it
	// A portal is a fight to use when its entrance, or every cell a hero can
	// step to it from, lies in a monster's 3x3. Out of reach of the guards
	// already standing on this level where it can be, and four cells or more
	// from any other gate or monolith, so neither one's guard can stand over
	// the other: on [HotA] Nostalgia seed 5002 teal's free monolith went down
	// three cells from the next portal, whose guard then had no cell that did
	// not cover it, and teal was cut off from the three starts it shares
	// ground with.
	const inGuardReach = () => {
		const reach = new Set(), ends = [];
		for (const o of objects) {
			if ((o.l || 0) !== levelIndex || !o.template) continue;
			if (/^(monster|randomMonster)/.test(o.type))
				for (const [vx, vy] of visitableCells(o.template, o.x, o.y))
					for (let dy = -1; dy <= 1; dy++)
						for (let dx = -1; dx <= 1; dx++) reach.add((vy + dy) * W + vx + dx);
			else if (o.type === 'monolithTwoWay' || o.type === 'subterraneanGate')
				ends.push(...visitableCells(o.template, o.x, o.y));
		}
		reach.ends = ends;
		return reach;
	};
	const guardedAt = (reach, monoTpl, x, y) => {
		const mine = visitableCells(monoTpl, x, y);
		if (mine.some(([vx, vy]) => reach.has(vy * W + vx))) return true;
		if (mine.some(([vx, vy]) => reach.ends.some(([ex, ey]) => Math.max(Math.abs(ex - vx), Math.abs(ey - vy)) < 4)))
			return true;
		const ways = openBeside(monoTpl, x, y);
		return ways.length > 0 && ways.every(c => reach.has(c));
	};
	// on a template map, whose links the template leaves free or guards; the
	// free layout places its portals as it always has (its starts' fairness
	// and parity were measured on them, and on 36x36 for eight the spacing
	// left a start with no ground to top up)
	const portalSpot = (cell, z, monoTpl) => {
		const cx = cell % W, cy = (cell / W) | 0;
		const reach = inGuardReach();
		for (const clear of tplZones ? [true, false] : [false])
			for (let r = 0; r <= 6; r++)
				for (let dy = -r; dy <= r; dy++)
					for (let dx = -r; dx <= r; dx++) {
						if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
						const x = cx + dx, y = cy + dy;
						if (x < 0 || y < 0 || x >= W || y >= H || !inZone(monoTpl, x, y, zone, z, W, H)) continue;
						if (!footprintFits(monoTpl, x, y, levelIndex, W, H, blocked)) continue;
						if (!entranceOpen(monoTpl, x, y, levelIndex, W, H, blocked, null)) continue;
						if (clear && guardedAt(reach, monoTpl, x, y)) continue;
						if (!clear && process.env.VMAPGEN_GATE_TRACE)
							console.error(`[gate] level ${levelIndex}: portal in zone ${z} at (${x},${y}) stands in a guard's reach`);
						return [x, y];
					}
		return null;
	};
	// Guards at bottlenecks off (guardBottlenecks 0) leaves every way between
	// biomes open, portals and gates as well as passages
	const linkGuardsOff = Number(p.guardBottlenecks) === 0;
	// a portal's guard cells, those whose reach covers nothing but the portal
	// first (content.js reachOnReserved): a guard over the next portal made a
	// link the template leaves free a fight ([HotA] Nostalgia seed 5002, two
	// monoliths side by side in teal's zone)
	const guardSpots = (monoTpl, mx, my) => {
		if (!tplZones) {
			const out = openBeside(monoTpl, mx, my);
			out.clear = new Set(out);
			return out;
		}
		const monster = OBJECT_TEMPLATES.randomMonster;
		const mine = new Set(openBeside(monoTpl, mx, my));
		for (const [vx, vy] of visitableCells(monoTpl, mx, my)) mine.add(vy * W + vx);
		const cells = openBeside(monoTpl, mx, my);
		const clear = cells.filter(c => !reachOnReserved(monster, c % W, (c / W) | 0, levelIndex, W, H, blocked, mine));
		const out = [...clear, ...cells.filter(c => !clear.includes(c))];
		out.clear = new Set(clear);
		return out;
	};
	const portalGuard = (monoTpl, mx, my, toZone) => {
		if (linkGuardsOff) return false;
		const monster = OBJECT_TEMPLATES.randomMonster;
		for (const c of guardSpots(monoTpl, mx, my)) {
			const gx = c % W, gy = (c / W) | 0;
			const cls = classes[toZone];
			const base = cls === BIOME_CLASS.HIGH_LOOT ? 5 + ((rng() * 3) | 0)
				: cls === BIOME_CLASS.TOWN ? 4 + ((rng() * 2) | 0) : 1 + ((rng() * 4) | 0);
			const level = Math.max(1, Math.min(7, base + Math.round(p.monsterStrength || 0)));
			objects.push(objectEntry(`randomMonsterLevel${level}`, gx, gy, levelIndex,
				monster, 'object', monsterOptions(level, p, rng)));
			footprintBlock(monster, gx, gy, levelIndex, W, H, blocked);
			markApproach(monster, gx, gy, levelIndex, W, H, blocked);
			return true;
		}
		return false;
	};
	// A template link that became a portal pair keeps its guard: the engine
	// places each monolith as a required object guarded with the link's full
	// strength, chosen from its own zone's creatures (ConnectionsPlacer::
	// placeMonolithConnection), so both ends get one, sized like a doorway
	// guard (engineGuard, zone-link rule).
	const linkPortalGuard = (monoTpl, mx, my, z, strength) => {
		if (linkGuardsOff) return false;
		const concrete = !!(objectPools && objectPools.guards && zoneMeta);
		const g = engineGuard(strength, 1 + Math.round(p.monsterStrength || 0), rng, true,
			concrete ? zoneGuardPool(objectPools.guards, zoneMeta[z] && zoneMeta[z].spec) : undefined);
		if (!g) return false;
		const monster = OBJECT_TEMPLATES.randomMonster;
		const spots = guardSpots(monoTpl, mx, my);
		for (const c of spots) {
			const gx = c % W, gy = (c / W) | 0;
			if (!footprintFits(monster, gx, gy, levelIndex, W, H, blocked, true)) continue;
			if (!spots.clear.has(c) && process.env.VMAPGEN_GATE_TRACE)
				console.error(`[gate] level ${levelIndex}: the guard of the portal at (${mx},${my}) stands at (${gx},${gy}) over other ground`);
			const e = objectEntry(`randomMonsterLevel${g.level}`, gx, gy, levelIndex, monster, 'object',
				{ character: 'hostile', amount: g.amount });
			if (concrete) e.guardCreature = g.creature;
			objects.push(e);
			footprintBlock(monster, gx, gy, levelIndex, W, H, blocked);
			markApproach(monster, gx, gy, levelIndex, W, H, blocked);
			return true;
		}
		return false;
	};
	phase('monoliths');
	// a channel per link (portals.js); the links whose zones are still apart
	// go first, and once the channels are all taken a link whose zones are
	// joined already is left out
	const pendingPortals = openings.filter(o => o.kind === 'portal');
	const zoneKey = z => `${levelIndex}:${z}`;
	let portalsLeftOut = 0;
	while (pendingPortals.length) {
		let at = pendingPortals.findIndex(o => !book.joined(zoneKey(o.a), zoneKey(o.b)));
		if (at < 0) at = 0;
		const o = pendingPortals.splice(at, 1)[0];
		let ch = book.next();
		if (!ch) {
			if (book.joined(zoneKey(o.a), zoneKey(o.b))) { portalsLeftOut++; continue; }
			ch = book.shared();
		}
		const monoTpl = ch.tpl;
		const A = portalSpot(o.portalA, o.a, monoTpl);
		if (!A) continue;
		footprintBlock(monoTpl, A[0], A[1], levelIndex, W, H, blocked);
		const B = portalSpot(o.portalB, o.b, monoTpl);
		if (!B) {
			// both ends or neither: a lone monolith is a door onto nothing
			for (const [fx, fy] of blockingCells(monoTpl, A[0], A[1]))
				blocked[levelIndex * W * H + fy * W + fx] &= ~OCCUPIED;
			console.error(`[gen] level ${levelIndex}: no room for a portal pair `
				+ `between zones ${o.a} and ${o.b}`);
			continue;
		}
		footprintBlock(monoTpl, B[0], B[1], levelIndex, W, H, blocked);
		markApproach(monoTpl, A[0], A[1], levelIndex, W, H, blocked);
		markApproach(monoTpl, B[0], B[1], levelIndex, W, H, blocked);
		book.take(ch);
		book.join(zoneKey(o.a), zoneKey(o.b));
		objects.push(monolithEntry(A[0], A[1], levelIndex, ch));
		objects.push(monolithEntry(B[0], B[1], levelIndex, ch));
		if (o.tplGuard > 0 && process.env.VMAPGEN_PORTAL_GUARD !== '0') {
			linkPortalGuard(monoTpl, A[0], A[1], o.a, o.tplGuard);
			linkPortalGuard(monoTpl, B[0], B[1], o.b, o.tplGuard);
		} else if (Number(p.guardPortals) > 0) {
			portalGuard(monoTpl, A[0], A[1], o.b);
			portalGuard(monoTpl, B[0], B[1], o.a);
		} else if (!tplZones) {
			// a free layout's portal out of a start is guarded at the start's
			// end, as a passage out of a start always is, and that is one fight
			// either way through it. Unguarded, it was a way out for free: on
			// 72x72 two-level seed 3 green walked through two into two more
			// zones and on to a neutral town, 987 cells against 342-467
			if (classes[o.a] === BIOME_CLASS.PLAYER) portalGuard(monoTpl, A[0], A[1], o.b);
			if (classes[o.b] === BIOME_CLASS.PLAYER) portalGuard(monoTpl, B[0], B[1], o.a);
		}
		links.push([openBeside(monoTpl, A[0], A[1]), openBeside(monoTpl, B[0], B[1])]);
		// a link with a road has one to each monolith (ConnectionsPlacer::
		// placeMonolithConnection: both are road nodes); roadplan.js lays them
		if (o.road) o.roadNodes = [[o.a, openBeside(monoTpl, A[0], A[1])], [o.b, openBeside(monoTpl, B[0], B[1])]];
	}
	const portalLinks = openings.filter(o => o.kind === 'portal').length;
	if (portalLinks)
		console.error(`[gen] level ${levelIndex}: ${links.length} of ${portalLinks} portal link(s) placed`
			+ (portalsLeftOut ? `, ${portalsLeftOut} left out (the monolith channels all taken, their zones joined another way)` : ''));

	// Roads first (K, 2026-09-27: "roads be build off splines early on, not to
	// be broken up by things placed around them"), in the engine's order: its
	// RoadPlacer runs once a zone's towns, links and monoliths stand and before
	// any treasure or obstacle. So they go down here, on the engine's model
	// (roadplan.js), before the zone walls become objects and before the
	// ridges, and every later pass builds around the reserved road. Laid after
	// the ridges, a road found its zone cut into pockets a hero crosses
	// diagonally and a four-connected road cannot (Jebus Cross 108 s5001: one
	// zone roadless). The held gate sites of links with a road are nodes too.
	// VMAPGEN_ROADS=late keeps the old order, roads routed after the fill.
	phase('roads');
	const roadCells = new Set();
	const roadFailed = [];
	if (process.env.VMAPGEN_ROADS !== 'late') {
		const roadTowns = towns.filter(t => (t.l || 0) === levelIndex && t.gates);
		(zoneMeta || []).forEach(meta => {
			for (const i of (meta && meta.townSpots) || []) {
				const x = i % W, y = (i / W) | 0;
				roadTowns.push({ x, y, l: levelIndex, gates: visitableCells(OBJECT_TEMPLATES.randomTown, x, y) });
			}
		});
		// The free layout links its towns the engine's way too (CRoadRandomizer):
		// the roaded passages the player's levers drew join their zones first;
		// then the other open passages, shuffled, take a road where they join
		// two groups of zones not yet joined, one of them holding a town; and a
		// townless zone left with one road that way loses it. The roads then go
		// down here with the rest, before anything is built. The town net used
		// to be routed after the fill, around whatever stood there (K: "broken
		// up by things placed around them"). Road network Off keeps only the
		// passages' own roads.
		if (!tplZones && p.roadNetwork !== 0) {
			const holding = new Set(roadTowns.map(t => zone[t.y * W + t.x]));
			const doors = openings.filter(o => o.kind === 'openRoad' || o.kind === 'openNoRoad');
			const parent = new Map(), town = new Map();
			for (const o of doors) for (const z of [o.a, o.b])
				if (!parent.has(z)) { parent.set(z, z); town.set(z, holding.has(z)); }
			const find = z => { while (parent.get(z) !== z) { parent.set(z, parent.get(parent.get(z))); z = parent.get(z); } return z; };
			const join = (a, b) => { const ra = find(a), rb = find(b); parent.set(ra, rb); town.set(rb, town.get(ra) || town.get(rb)); };
			for (const o of doors) if (o.kind === 'openRoad' && find(o.a) !== find(o.b)) join(o.a, o.b);
			// its own stream, so the rest of the map draws what it drew before
			const trng = xorshift((((params.seed || 1) ^ 0x70ad5) + levelIndex * 131) >>> 0);
			const rest = doors.filter(o => o.kind === 'openNoRoad');
			for (let i = rest.length - 1; i > 0; i--) {
				const j = (trng() * (i + 1)) | 0;
				[rest[i], rest[j]] = [rest[j], rest[i]];
			}
			const linked = new Set();
			for (const o of rest) {
				const ra = find(o.a), rb = find(o.b);
				if (ra === rb || !(town.get(ra) || town.get(rb))) continue;
				join(o.a, o.b);
				o.kind = 'openRoad';
				linked.add(o);
			}
			// the engine trims every road, the levers' own included: a passage's
			// road into a townless zone it leaves by no other road is a tail
			let trimmed = 0;
			for (let changed = true; changed;) {
				changed = false;
				for (const z of parent.keys()) {
					if (holding.has(z)) continue;
					const roads = doors.filter(o => o.kind === 'openRoad' && (o.a === z || o.b === z));
					if (roads.length !== 1) continue;
					roads[0].kind = 'openNoRoad';
					if (!linked.delete(roads[0])) trimmed++;
					changed = true;
				}
			}
			if (linked.size || trimmed)
				console.error(`[gen] level ${levelIndex}: the towns linked through ${linked.size} more roaded passage(s), `
					+ `${trimmed} passage road(s) leading nowhere dropped`);
			if (process.env.VMAPGEN_ROAD_TRACE)
				for (const z of [...holding].sort((a, b) => a - b))
					console.error(`[roads] level ${levelIndex}: town zone ${z}: doors `
						+ doors.filter(o => o.a === z || o.b === z).map(o => `${o.a}-${o.b}:${o.kind}`).join(' ')
						+ `; portals ${openings.filter(o => o.kind === 'portal' && (o.a === z || o.b === z)).length}`);
		}
		const gateNodes = [];
		for (const [sites, tpl] of [[gateSites, OBJECT_DEFS.subterraneanGate],
			[gateSitesHere, OBJECT_DEFS.subterraneanGateUnder]])
			for (const s of sites) {
				const c = p.zonePlan && p.zonePlan.connections[s.k];
				if (c && c.road === true) gateNodes.push(approachCells(tpl, s.x, s.y, levelIndex, W, H, blocked));
			}
		const r = planRoads({ plan: { zone, openings, roadCells, roadNodes: gateNodes, p }, towns: roadTowns,
			W, H, blocked, l: levelIndex, approach: t => roadApproach(t, W, H, blocked, levelIndex),
			// a wall cell held clear (a doorway's side, a town's apron) never
			// takes a wall object (footprintFits vetoes RESERVED), so a road may
			avoid: c => barriers.has(c) && !(blocked[levelIndex * W * H + c] & RESERVED),
			standOn: guardCells });
		// what could not be reached yet is joined after the fill (planMap)
		roadFailed.push(...r.failedNodes);
		if (r.cells)
			console.error(`[gen] level ${levelIndex}: roads first, ${r.cells} cells in ${r.zones} zone(s)`
				+ (r.failed ? `, ${r.failed} node(s) left for after the fill` : ''));
	}

	// Island maps (water W3): a boat is the way between islands. A harbour's
	// boarding ground links to every shore of the water it sails, so the
	// passes below count a landing as a way in, the way they count a portal.
	// On the other water layouts the land is one piece and boats add nothing.
	const sailLinks = water ? sailLinksFor(harbours, water, W, H) : [];
	if (p.waterIslands) links.push(...sailLinks);

	// Before any barrier becomes an object, make sure the wall they form does
	// not cut the level. The biome-graph pass above cannot see a biome that
	// noise has split into two blobs; this can, because it counts cells.
	const freed = openSealedPockets(barriers, W, H, levelIndex, blocked, playerStarts, links, water);
	if (freed)
		console.error(`[gen] level ${levelIndex}: removed ${freed} barrier(s) that `
			+ 'sealed part of the level off');

	// Objects: barriers next (they own their cells), then guards, portals,
	// per-biome content fill.
	//
	// A barrier is a one-cell decoration matched to the terrain under it. The
	// old pair (a "mountain" drawn as avlmnt and a "trees" drawn as avttree)
	// used two animation names that exist nowhere in the game, so every border
	// on every map we have made is an invisible wall: it blocks correctly, the
	// validators are satisfied, and the player walks into open ground that will
	// not let them past.
	//
	// Where the wall is thick enough, one real terrain feature covers several
	// wall cells instead of an ornament sitting on each. Real maps put 97
	// percent of their scenery in multi-cell clusters and ours was putting a
	// third of it in single cells strung along these borders, which is what
	// made a generated map read as a hedge maze rather than as terrain.
	//
	// A cluster anchored on the wall may lean past it into free ground - that
	// is what makes a border a mountain range instead of a hedge of one-cell
	// ornaments. Requiring every blocking cell to sit ON the wall (the old
	// rule) meant nothing bigger than a shrub ever fitted, because the wall
	// is one cell thick.
	//
	// Spill is bounded by two guards rather than a fixed count:
	//   - a spill cell must be genuinely free ground: not reserved (doorways
	//     and town gates stay clear), not a choke-guard cell, not another
	//     wall's cell, and inside the map
	//   - the wall's own connectivity guard, built over a world where the
	//     whole remaining wall is already down, refuses a spill that would
	//     cut the open region - so the seal sweep never has to delete a
	//     cluster and leave the wall bare where it stood
	// Underground the solid rock is already the wall between zones, and a
	// barrier ornament standing in a carved tunnel mouth is a cork: the tunnel
	// between two zones wanders across intervening zone borders on its way, so
	// every blocked border it crossed plugged it shut. The carve mask alone
	// decides what is passage and what is rock, so carved levels emit no
	// border barriers at all.
	phase('mountains');
	const wallLeft = new Set(barriers);
	let wallClustersPlaced = 0;
	// A cluster may lean off the wall, but not onto a player's doorstep:
	// each spill step can sit under the connectivity guard's tolerance, and
	// enough of them stacked beside a town still seals its gate. The town is
	// the one object whose loss turns the map unplayable, so it gets a
	// distance rule rather than a probability.
	const nearStart = k => {
		const kx = k % W, ky = (k / W) | 0;
		for (const s of playerStarts)
			if (Math.max(Math.abs(kx - s.x), Math.abs(ky - s.y)) <= 5) return true;
		return false;
	};
	let wallBlocked = null, wallGuard = null;
	if (!openMask && barriers.size) {
		wallBlocked = blocked.slice();
		for (const c of barriers) wallBlocked[levelIndex * W * H + c] |= OCCUPIED;
		wallGuard = makeConnectivityGuard(wallBlocked, levelIndex, W, H, 2);
	}
	// Two sweeps: a cluster covering several wall cells is how the corpus
	// builds a border, and the first pass leaves strays no piece reached.
	// The second sweep catches them before the single-cell fallback fills
	// the wall with rock one cell at a time.
	for (let sweep = 0; sweep < 2; sweep++)
	for (const c of openMask ? [] : barriers) {
		if (!wallLeft.has(c)) continue;
		const x = c % W, y = (c / W) | 0;
		const terrain = biomeTerrain[zone[c]];
		let done = false;
		for (const d of wallClusters(terrain, rng, 14)) {
			if (d.cells < 2) continue;
			const own = blockingCells(d.tpl, x, y).map(([a, b]) => b * W + a);
			if (own.length < 2) continue;
			const spill = [], covered = [];
			let legal = own.length > 1;
			for (const k of own) {
				if (k < 0 || k >= W * H) { legal = false; break; }
				if (wallLeft.has(k)) covered.push(k);
				else if (!blocked[levelIndex * W * H + k] && !barriers.has(k)
						&& !guardCells.has(k) && !nearStart(k)) spill.push(k);
				else { legal = false; break; }
			}
			// a border feature must hug the border: at least a third of its
			// blocking cells on the wall itself, else it is interior decor
			// wearing a wall's address
			if (!legal || covered.length * 3 < own.length) continue;
			if (!footprintFits(d.tpl, x, y, levelIndex, W, H, blocked)) continue;
			if (wallGuard && !wallGuard.accepts(spill)) continue;
			wallClustersPlaced++;
			objects.push(objectEntry(d.type, x, y, levelIndex, d.tpl, d.subtype));
			footprintBlock(d.tpl, x, y, levelIndex, W, H, blocked);
			for (const k of spill) wallBlocked[levelIndex * W * H + k] |= OCCUPIED;
			if (wallGuard) wallGuard.refresh();
			for (const k of covered) wallLeft.delete(k);
			done = true;
			break;
		}
		if (done) continue;
		// first sweep tries clusters only: the single-cell fallback runs
		// once, on the last pass, for the cells no piece could cover
		if (sweep === 0) continue;
		// Pair leftovers before resorting to singles: two adjacent uncovered
		// wall cells take one two-cell piece, which is how the corpus covers
		// its wall ends - the one-cell fallback is the last resort, not the
		// shape of the wall. (Roomy is measured on 2x2 windows; the cells the
		// wall poisons are poisoned either way, but the census cares how many
		// objects did it.)
		let paired = false;
		for (let dy = -1; dy <= 1 && !paired; dy++)
			for (let dx = -1; dx <= 1 && !paired; dx++) {
				if (!dx && !dy) continue;
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const d = ny * W + nx;
				// the neighbour may be another leftover (paired cover) or a
				// wall cell already covered (the piece welds into it); only
				// genuinely open floor is off limits. Spilling onto open
				// floor was tried and reverted: the spill cells create new
				// unroomy notches the settle pass then fills, which nets
				// MORE one-cell objects, not fewer.
				if (!wallLeft.has(d)
						&& !(wallBlocked[levelIndex * W * H + d] & OCCUPIED))
					continue;
				for (const pc of wallClusters(terrain, rng, 4, 2)) {
					if (pc.cells > 3) continue;
					const raw = blockingCells(pc.tpl, x, y);
					if (raw.some(([a, b]) => a < 0 || b < 0 || a >= W || b >= H))
						continue;
					const pown = raw.map(([a, b]) => b * W + a);
					if (pown.length < 2 || !pown.includes(d)) continue;
					// every cell lands on the wall itself or on ground the
					// wall already blocks - no spilling onto open floor
					if (!pown.every(k => wallLeft.has(k)
						|| (wallBlocked[levelIndex * W * H + k] & OCCUPIED)))
						continue;
					// wallLeft membership is not enough on its own: a border
					// cell inside a town's gate apron is wall AND reserved,
					// and covering it seals the player in (108x108 s7).
					if (!footprintFits(pc.tpl, x, y, levelIndex, W, H, blocked))
						continue;
					objects.push(objectEntry(pc.type, x, y, levelIndex,
						pc.tpl, pc.subtype || 'object'));
					footprintBlock(pc.tpl, x, y, levelIndex, W, H, blocked);
					for (const k of pown) wallLeft.delete(k);
					paired = true;
					break;
				}
			}
		if (paired) continue;
		// The corpus's lone one-cell decor is a mixed bag - logs, mushrooms,
		// cactus, rocks - not only the four-piece barrier set. Drawing a
		// third of the leftovers from the harvested single pool gets those
		// types onto the mass edges where the corpus puts them (measured:
		// log 414/414 edge-adjacent, cactus 718/719, subRocks 2870/2968)
		// and thins the barrier types that read HIGH on the census.
		let b = (rng() < 0.33 ? singleTemplate(terrain, rng) : null)
			|| barrierTemplate(terrain, rng);
		// a harvested single can reach past its cell onto ground held clear
		// (a road, an apron); the wall cell still has to close, so the one-cell
		// barrier takes it. Skipping it left the cell open, a gap in the zone
		// wall (7 of 1280 wall cells on Jebus Cross 108 s5001, roads laid first)
		if (!footprintFits(b.tpl, x, y, levelIndex, W, H, blocked)) {
			b = barrierTemplate(terrain, rng);
			if (!footprintFits(b.tpl, x, y, levelIndex, W, H, blocked)) continue;
		}
		objects.push(objectEntry(b.type, x, y, levelIndex, b.tpl, b.subtype));
		footprintBlock(b.tpl, x, y, levelIndex, W, H, blocked);
		wallLeft.delete(c);
	}
	// VMAPGEN_GATES (queue 4f): "wall covers the rest" is a claim the sweeps
	// above only honour when footprintFits passes. A barrier cell that is
	// RESERVED (town apron, corridor) stays uncovered and stays OPEN - an
	// undocumented second doorway, which is where the 1.68-openings-per-pair
	// tail came from. Waiving APPROACH was tried here and reverted inside
	// the flag's own bounds: it walls the doorstep of an already-placed
	// object and stranded a resource pile on 144x144 s8. Under the flag the
	// leftovers are only counted and the doorway width is narrowed; the
	// cover itself keeps the same veto set as every other wall cell.
	let gatesLeftover = 0;
	if (process.env.VMAPGEN_GATES && !openMask && wallLeft.size)
		gatesLeftover = wallLeft.size;
	if (!openMask && barriers.size)
		console.error(`[gen] level ${levelIndex}: ${barriers.size} border cells, `
			+ `${wallClustersPlaced} multi-cell wall cluster(s) placed`
			+ (gatesLeftover ? `, ${gatesLeftover} uncovered leftover(s)` : ''));

	/*
	 * Corpus-authored interior packs go in HERE, before the ridge scatter
	 * spends the interior. The fill-time pack pass measured "want 63 cells,
	 * placed 0" on every biome of a traced map (2026-09-23): with the walls,
	 * ridges and objects already down, no 20-50 cell authored mass plus its
	 * moat fits anywhere, so the whole corpus-skeleton path was dead and
	 * mountain ran 0.74x corpus on singles alone. Placed early, the packs
	 * claim the open ground the corridor markers then walk around - the
	 * corridor seeds are RESERVED/APPROACH cells and start moats, which a
	 * pack can never cover.
	 *
	 * Budget is a conservative share of free floor; the fill-time pass asks
	 * for share-minus-preBlocked, so whatever lands here is automatically
	 * deducted from the later ask.
	 */
	if (process.env.VMAPGEN_WALL_TRACE) {
		const open = [...barriers].filter(c => !(blocked[levelIndex * W * H + c] & OCCUPIED));
		const flags = {};
		for (const c of open) { const f = blocked[levelIndex * W * H + c]; const k = (f & RESERVED ? 'R' : '') + (f & APPROACH ? 'A' : '') + (roadCells.has(c) ? 'road' : '') || 'none'; flags[k] = (flags[k] || 0) + 1; }
		console.error(`[walls] level ${levelIndex}: ${open.length} of ${barriers.size} barrier cells left open: ${JSON.stringify(flags)}`);
	}
	phase('valleys');
	if (!openMask && p.decorDensity > 0) {
		const packGuard = makeConnectivityGuard(blocked, levelIndex, W, H, 2);
		const foreignAt = (x, y, r) => {
			for (let dy = -r; dy <= r; dy++)
				for (let dx = -r; dx <= r; dx++) {
					if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
					const nx = x + dx, ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
					if (blocked[levelIndex * W * H + ny * W + nx] & OCCUPIED)
						return true;
				}
			return false;
		};
		const tryPack = (pack, i, mode) => {
			const x = i % W, y = (i / W) | 0;
			const cells = pack.cells.map(([dx, dy]) => [x + dx, y + dy]);
			for (const [bx, by] of cells) {
				if (bx < 0 || by < 0 || bx >= W || by >= H) return null;
				if (blocked[levelIndex * W * H + by * W + bx]) return null;
			}
			let touch = false;
			for (const [bx, by] of cells)
				if (foreignAt(bx, by, 1)) { touch = true; break; }
			if (mode === 'detached' && touch) return null;
			if (mode === 'merge' && !touch) return null;
			const walls = cells.map(([a, b]) => b * W + a);
			if (packGuard && !packGuard.accepts(walls)) return null;
			if (weldsMasses(walls, blocked, levelIndex, W, H, 2)) return null;
			for (const o of pack.objects) {
				const tpl = { animation: o.animation, mask: o.mask };
				if (o.visitableFrom) tpl.visitableFrom = o.visitableFrom;
				// this file's objectEntry takes the subtype sixth (content.js's
				// takes options first): with `undefined` here every mod pack piece
				// went out as "<type>::object", which the engine refuses
				objects.push(objectEntry(o.type, x + o.dx, y + o.dy,
					levelIndex, tpl, o.subtype || 'object'));
				footprintBlock(tpl, x + o.dx, y + o.dy, levelIndex, W, H, blocked);
			}
			if (packGuard) packGuard.refresh();
			return cells;
		};
		const freeBy = new Map();
		for (let i = 0; i < zone.length; i++) {
			if (blocked[levelIndex * W * H + i]) continue;
			if (!freeBy.has(zone[i])) freeBy.set(zone[i], []);
			freeBy.get(zone[i]).push(i);
		}
		// merge packs anchor beside existing blocking and extend the web;
		// islanding every pack with its own moat frayed the open ground
		// (roomy 64% vs corpus 82). 0.35 tried: roomy flat at ~70 while
		// blocked rose to 58, so the fray is the singles leftovers
		// (Opus-reserved item), not the pack mix - stays 0.25.
		const webFrontier = [];
		const growFrontier = cells => {
			for (const [bx, by] of cells)
				for (let dy = -1; dy <= 1; dy++)
					for (let dx = -1; dx <= 1; dx++) {
						if (!dx && !dy) continue;
						const nx = bx + dx, ny = by + dy;
						if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
						const n = ny * W + nx;
						if (!blocked[levelIndex * W * H + n])
							webFrontier.push(n);
					}
		};
		let packsPlaced = 0, packsCells = 0;
		for (const [b, free] of freeBy) {
			const wantCells = free.length * 0.10 * p.decorDensity;
			const centres = [];
			let placedCells = 0, failed = 0;
			while (placedCells < wantCells && failed < 15) {
				const wantPk = Math.min(wantCells - placedCells, 90)
					/ (1 + failed * 0.5);
				const prefer = rng() < 0.35 ? 'mountain' : null;
				const pk = packFor(biomeTerrain[b], rng, wantPk, prefer);
				if (!pk) break;
				const merge = webFrontier.length && rng() < 0.25;
				const src = merge ? webFrontier : free;
				let done = null, ax = 0, ay = 0;
				for (let t = 0; t < 60 && !done; t++) {
					const i = src[(rng() * src.length) | 0];
					const x = i % W, y = (i / W) | 0;
					if (!merge && centres.some(c => (c.x - x) * (c.x - x)
							+ (c.y - y) * (c.y - y) < 100)) continue;
					done = tryPack(pk, i, merge ? 'merge' : 'detached');
					if (done) { ax = x; ay = y; }
				}
				if (!done) { failed++; continue; }
				centres.push({ x: ax, y: ay });
				growFrontier(done);
				placedCells += pk.size;
				packsPlaced++;
				packsCells += pk.size;
			}
		}
		if (packsPlaced)
			console.error(`[gen] level ${levelIndex}: ${packsPlaced} interior `
				+ `pack(s) placed early (${packsCells} cells)`);
	}

	// Interior masses, the way VCMI's own generator grows them: a zone's
	// open ground is a corridor network about nine cells wide (its
	// fractalization keeps passages roughly freeDistance apart), and
	// everything farther than blockDistance from a corridor becomes mass.
	// We reproduce it directly: seed the corridors with the doorway cells
	// the barrier pass reserved plus the player-start moats, walk fresh
	// corridors to whatever open cell is farthest from the network until
	// none remain, then mark every open cell more than six cells out.
	// The marks get covered by the same cluster machinery a border gets.
	// Cells inside the corridors are never markable, so a pocket mouth can
	// never be closed - the corridors ARE the connectivity guarantee.
	const ridgeCells = new Set();
	const ridgeBiome = new Map();   // mark cell -> biome index, for terrain art
	const markDist = new Float64Array(W * H);
	if (!openMask) {
		const cleared = new Set();
		for (let i = 0; i < W * H; i++)
			if (blocked[levelIndex * W * H + i] & (RESERVED | APPROACH))
				cleared.add(i);
		for (const s of playerStarts)
			for (let dy = -5; dy <= 5; dy++)
				for (let dx = -5; dx <= 5; dx++) {
					const nx = s.x + dx, ny = s.y + dy;
					if (nx >= 0 && ny >= 0 && nx < W && ny < H)
						cleared.add(ny * W + nx);
				}
		// distance-to-corridor field, reflowed after each new corridor.
		// In rim mode (the default; VMAPGEN_RIM=0 is the old path) the field
		// stays inside each zone, as the engine's does (Zone::fractalize
		// measures to the zone's OWN free paths): a corridor across a zone
		// line no longer holds this side of the line open.
		const rimMode = rimModeOf(p);
		const dist = markDist;
		const reflow = () => {
			dist.fill(Infinity);
			const q = [];
			for (const c of cleared) { dist[c] = 0; q.push(c); }
			for (let qi = 0; qi < q.length; qi++) {
				const c = q[qi], x = c % W, y = (c / W) | 0;
				for (let dy = -1; dy <= 1; dy++)
					for (let dx = -1; dx <= 1; dx++) {
						if (!dx && !dy) continue;
						const nx = x + dx, ny = y + dy;
						if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
						const n = ny * W + nx;
						if (rimMode && zone[n] !== zone[c]) continue;
						const step = dx && dy ? 2 : 1;
						if (dist[c] + step < dist[n]) {
							dist[n] = dist[c] + step;
							q.push(n);
						}
					}
			}
		};
		// Corridor spacing. With the rim band carrying the zone lines, 15
		// lands the interior at the corpus's ~45% blocked (72x72, 3 seeds:
		// 11 gave 36-44% and 52% overall, 15 gave 42-50% and 57%, corpus
		// 45-49% and 60%) and keeps roomy at 74 against the old 67.
		const FREE_D = rimMode ? 15 : 11;
		// Blocking distance varies per biome: dense biomes mark cells only a
		// few cells off their corridors, so their mass is one fat region the
		// corridor still runs through, while open biomes keep the wide bands
		// that make the small and medium masses. The corpus's dominant mass
		// is a dense biome's interior.
		const biomeBlockD = new Map();
		// The engine blocks a tile once it is more than sqrt(81 x 0.45), about
		// 6 cells, from its zone's paths (Zone.cpp:270-310). In this field's
		// 1/2 step metric a Euclidean 6 reads 6 to 8.5, hence 7 under the rim;
		// the old 3-5 made up for the thin border with a denser interior.
		// 8 since the rim lobes (rimfill.js) took over the blocking near zone
		// lines: at 7 the interiors ran 48-51% blocked against the corpus's
		// 45-46% and 72x72 totalled 63% against 60 (item 21, 2026-09-24).
		// VMAPGEN_RIDGE_D overrides it for A/B runs.
		const rimBlockD = +process.env.VMAPGEN_RIDGE_D || 8;
		for (const b of new Set(zone)) {
			if (b < 0) continue;
			const r = rng();
			const d = 3 + (rng() * 3 | 0);
			biomeBlockD.set(b, rimMode ? rimBlockD : d);
		}
		reflow();
		// Fractalize: while some open cell sits far from the corridor web,
		// carve a corridor to it by descending the distance field, so the
		// corridor ends where the web already runs. Corridor cells are marked
		// RESERVED so nothing downstream may stand on them.
		for (let iter = 0; iter < 60; iter++) {
			let pick = -1, found = 0;
			for (let i = 0; i < W * H; i++) {
				if (blocked[levelIndex * W * H + i] || cleared.has(i)) continue;
				if (dist[i] <= FREE_D) continue;
				if (rng() * ++found < 1) pick = i;
			}
			if (pick < 0) break;
			let x = pick % W, y = (pick / W) | 0;
			for (let s = 0; s < 500 && dist[y * W + x] > 0; s++) {
				const c = y * W + x;
				if (!cleared.has(c)) {
					cleared.add(c);
					blocked[levelIndex * W * H + c] |= RESERVED;
					// corridors run a cell or two wide
					if (rng() < 0.5) {
						const nx = x + ((rng() * 3) | 0) - 1,
							ny = y + ((rng() * 3) | 0) - 1;
						if (nx >= 0 && ny >= 0 && nx < W && ny < H
								&& !(blocked[levelIndex * W * H + ny * W + nx])) {
							cleared.add(ny * W + nx);
							blocked[levelIndex * W * H + ny * W + nx] |= RESERVED;
						}
					}
				}
				let bx = 0, by = 0, bd = dist[c];
				for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1],
						[1, 1], [-1, -1], [1, -1], [-1, 1]]) {
					const nx = x + dx, ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
					const d = dist[ny * W + nx];
					if (d < bd || (d === bd && rng() < 0.3)) {
						bd = d; bx = dx; by = dy;
					}
				}
				if (!bx && !by) break;
				x += bx; y += by;
			}
			reflow();
		}
		// Widen every corridor to a real passage: a one-cell skeleton lets
		// masses touch diagonally across it and weld into one web. Two wide
		// keeps masses apart without eating the bands packs need to sit in.
		for (const c of [...cleared]) {
			const x = c % W, y = (c / W) | 0;
			for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const n = ny * W + nx;
				if (cleared.has(n)) continue;
				if (blocked[levelIndex * W * H + n] & OCCUPIED) continue;
				cleared.add(n);
				blocked[levelIndex * W * H + n] |= RESERVED;
			}
		}
		reflow();
		// Mark: every open cell more than its biome's blocking distance from
		// a corridor is mass.
		for (let i = 0; i < W * H; i++) {
			if (cleared.has(i)) continue;
			if (blocked[levelIndex * W * H + i]) continue;
			if (dist[i] > (biomeBlockD.get(zone[i]) || 6)) {
				ridgeCells.add(i);
				ridgeBiome.set(i, zone[i]);
			}
		}
		// Pinch-fill what is left: a cell whose blocked ring is all one
		// connected piece can join the mass without sealing a gap, and
		// iterating it closes the marks up to the corridor walls the way
		// the engine's own pass does.
		// Not in rim mode. It runs before any content, updates as it scans,
		// and even one pass closed the interior back to ~56% blocked with
		// roomy at 65 (0, 1, 2, 4 passes measured, 72x72 x3). The engine's
		// version runs after objects and roads; a post-fill port was tried
		// too (1-3 layers) and cut roomy to 54-59, so neither is used.
		const pinchPasses = rimMode ? 0 : 12;
		for (let pass = 0; pass < pinchPasses; pass++) {
			let any = false;
			for (let i = 0; i < W * H; i++) {
				if (cleared.has(i)) continue;
				const f = blocked[levelIndex * W * H + i];
				if ((f & (OCCUPIED | RESERVED)) || ridgeCells.has(i)) continue;
				const x = i % W, y = (i / W) | 0;
				const ring = [];
				for (let dy = -1; dy <= 1; dy++)
					for (let dx = -1; dx <= 1; dx++) {
						if (!dx && !dy) continue;
						const nx = x + dx, ny = y + dy;
						let n = -1;
						if (nx < 0 || ny < 0 || nx >= W || ny >= H) {
							n = -2;   // off-map counts as blocking
						} else {
							const k = ny * W + nx;
							if ((blocked[levelIndex * W * H + k] & OCCUPIED)
									|| ridgeCells.has(k)) n = k;
						}
						ring.push(n);
					}
				const parts = [...new Set(ring.filter(n => n !== -1))];
				if (!parts.length) continue;
				// the blocking ring must be one connected piece: if it were
				// two, filling the cell would seal the corridor between them.
				// Off-map (-2) counts as one connected group - the map frame.
				const seen = new Set([parts[0]]);
				const st = [parts[0]];
				while (st.length) {
					const c = st.pop();
					const cx = c % W, cy = (c / W) | 0;
					for (const n of ring) {
						if (n === -1 || seen.has(n)) continue;
						if (c === -2 && n === -2) { seen.add(n); st.push(n); continue; }
						if (n < 0 || c < 0) continue;
						const nx = n % W, ny = (n / W) | 0;
						if (Math.abs(nx - cx) <= 1 && Math.abs(ny - cy) <= 1) {
							seen.add(n); st.push(n);
						}
					}
				}
				if (seen.size === parts.length) {
					ridgeCells.add(i);
					ridgeBiome.set(i, zone[i]);
					any = true;
				}
			}
			if (!any) break;
		}
	}
	if (ridgeCells.size && process.env.VMAPGEN_MARK_TRACE) {
		const cid = new Map();
		const sizes = [];
		for (const c of ridgeCells) {
			if (cid.has(c)) continue;
			const id = sizes.length; const st = [c]; cid.set(c, id); let sz = 0;
			while (st.length) {
				const k = st.pop(); sz++;
				const x = k % W, y = (k / W) | 0;
				for (let dy = -1; dy <= 1; dy++)
					for (let dx = -1; dx <= 1; dx++) {
						const nx = x + dx, ny = y + dy;
						const nk = ny * W + nx;
						if (ridgeCells.has(nk) && !cid.has(nk)) {
							cid.set(nk, id); st.push(nk);
						}
					}
			}
			sizes.push(sz);
		}
		sizes.sort((a, b) => b - a);
		console.error(`[marks] l${levelIndex}: ${ridgeCells.size} mark cell(s), `
			+ `${sizes.length} components, largest ${sizes[0]}`
			+ ` (${Math.round(100 * sizes[0] / ridgeCells.size)}%)`);
	}
	// Covered exactly the way a border is: a cluster anchors on marked cells
	// it owns and may lean onto open ground beside them, but never onto a
	// cell that would weld two masses into one or leave the one-cell gap
	// neither mass can be roomy through. The guard sees the live map rather
	// than a world where the whole mark set is already down, because a
	// marked region has no doorways: the only thing keeping it from sealing
	// a pocket shut is the refusal of the piece that would close it.
	// The corpus's dominant mass is the border web grown fat: the zone-edge
	// wall plus every interior mass that could reach it. Some masses join,
	// some keep their moat - which is decided per mark component here.
	// Labels: 0 is the pre-existing web (border walls, earlier objects) and
	// i+1 is mark component i's mass once it has pieces down. A piece may
	// neighbour only its own component's cells, and the web only if its
	// component is allowed to attach - so masses either merge into the web
	// or keep a two-cell gap, never weld to each other, and never leave the
	// one-cell slit neither side can be roomy through.
	const markComp = new Map();     // mark cell -> component id
	const compAttach = [];          // comp id -> may weld onto the web
	const compSize = [];            // comp id -> mark count
	const compWeb = [];             // comp id -> already joined the web
	for (const c of ridgeCells) {
		if (markComp.has(c)) continue;
		const id = compAttach.length, st = [c];
		let n = 0;
		markComp.set(c, id);
		while (st.length) {
			const k = st.pop(); n++;
			const x = k % W, y = (k / W) | 0;
			for (let dy = -1; dy <= 1; dy++)
				for (let dx = -1; dx <= 1; dx++) {
					if (!dx && !dy) continue;
					const nx = x + dx, ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
					const nk = ny * W + nx;
					if (ridgeCells.has(nk) && !markComp.has(nk)) {
						markComp.set(nk, id); st.push(nk);
					}
				}
		}
		compAttach.push(rng() < 0.6);
		compWeb.push(false);
		compSize.push(n);
	}
	// The biggest mark region always joins the web - a corpus map's dominant
	// mass is never a fluke of coin flips
	{
		let big = -1, bs = 0;
		for (let i = 0; i < compSize.length; i++)
			if (compSize[i] > bs) { bs = compSize[i]; big = i; }
		if (big >= 0) compAttach[big] = true;
	}
	const massComp = new Map();     // placed cell -> label (0 web, n comp)
	// attach-eligible comps may weld to each other as well as to the web:
	// union-find over comps, compWeb[root] once any part reached the web.
	// Pre-union: two attach-eligible comps whose marks come within two
	// cells of each other are one mass waiting to happen - their packs
	// will bridge the gap, so they share a label from the start.
	const parent = compAttach.map((_, i) => i);
	const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
	{
		for (const c of ridgeCells) {
			const x = c % W, y = (c / W) | 0;
			for (let dy = -2; dy <= 2; dy++)
				for (let dx = -2; dx <= 2; dx++) {
					const nx = x + dx, ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
					const nk = ny * W + nx;
					if (!ridgeCells.has(nk)) continue;
					const a = find(markComp.get(c)), b = find(markComp.get(nk));
					if (a !== b && compAttach[a] && compAttach[b])
						parent[b] = a;
				}
		}
	}
	// The corpus's dominant mass is sticky: the union with the most foreign
	// neighbours has the biggest absorbing surface, so it is picked as the
	// dominant mass and may weld to whatever it touches, consent or not.
	const unionSize = new Map(), unionNbr = new Map();
	for (const c of ridgeCells) {
		const r = find(markComp.get(c));
		unionSize.set(r, (unionSize.get(r) || 0) + 1);
		const x = c % W, y = (c / W) | 0;
		for (let dy = -2; dy <= 2; dy++)
			for (let dx = -2; dx <= 2; dx++) {
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const nk = ny * W + nx;
				if (!ridgeCells.has(nk)) continue;
				const o = find(markComp.get(nk));
				if (o !== r) {
					if (!unionNbr.has(r)) unionNbr.set(r, new Set());
					unionNbr.get(r).add(o);
				}
			}
	}
	const webNbr = new Map();   // blocked cell -> [comp root, mark count]
	for (const c of ridgeCells) {
		const x = c % W, y = (c / W) | 0;
		const r = find(markComp.get(c));
		for (let dy = -1; dy <= 1; dy++)
			for (let dx = -1; dx <= 1; dx++) {
				if (!dx && !dy) continue;
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const n = ny * W + nx;
				if (!(blocked[levelIndex * W * H + n] & OCCUPIED)) continue;
				if (!webNbr.has(n)) webNbr.set(n, [r, 1]);
				else {
					const e = webNbr.get(n);
					if (e[0] !== r) e[0] = -1; else e[1]++;
				}
			}
	}
	// The frame is the blocked mass touching the map edge: the corpus's
	// dominant range is that frame grown fat, which the attach coin-flip
	// already produces on big maps. The moat opens only for INTERIOR web
	// cells embedded in a comp's marks - obstacles inside its territory,
	// not the frame. Free welding of the frame is what welded 96% of the
	// 108x108 blocking into one mass.
	const frameSet = new Set();
	{
		const st = [];
		for (let x = 0; x < W; x++) {
			if (blocked[levelIndex * W * H + x] & OCCUPIED) st.push(x);
			const b = (H - 1) * W + x;
			if (blocked[levelIndex * W * H + b] & OCCUPIED) st.push(b);
		}
		for (let y = 0; y < H; y++) {
			if (blocked[levelIndex * W * H + y * W] & OCCUPIED) st.push(y * W);
			const r = y * W + W - 1;
			if (blocked[levelIndex * W * H + r] & OCCUPIED) st.push(r);
		}
		while (st.length) {
			const k = st.pop();
			if (frameSet.has(k)) continue;
			frameSet.add(k);
			const x = k % W, y = (k / W) | 0;
			for (let dy = -1; dy <= 1; dy++)
				for (let dx = -1; dx <= 1; dx++) {
					if (!dx && !dy) continue;
					const nx = x + dx, ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
					const nk = ny * W + nx;
					if ((blocked[levelIndex * W * H + nk] & OCCUPIED)
							&& !frameSet.has(nk)) st.push(nk);
				}
		}
	}
	const webOwner = new Map(), ownedBy = new Map();
	const ownedOn = process.env.VMAPGEN_OWNED !== 'off';
	for (const [n, e] of webNbr)
		if (ownedOn && !frameSet.has(n) && e[0] >= 0 && e[1] >= 3) {
			webOwner.set(n, e[0]);
			ownedBy.set(e[0], (ownedBy.get(e[0]) || 0) + 1);
		}
	// The corpus's dominant mass is the border web grown fat: pick the
	// union positioned to grow into it - the one that owns the most wall
	// cells embedded in its marks. The old pick (most foreign neighbours)
	// chose the most moat-fenced comp, which often placed nothing at all.
	// Fall back to the neighbour score when nothing owns a wall.
	let DOM = -1, domN = -1;
	for (const [r, n] of ownedBy)
		if (n > domN) { domN = n; DOM = r; }
	if (DOM < 0)
		for (const [r, n] of unionSize) {
			const score = (unionNbr.get(r) || new Set()).size * 40 + n;
			if (score > domN) { domN = score; DOM = r; }
		}
	// A/B kill-switch for measurement: VMAPGEN_MOAT=off restores the
	// pre-change consent rules (and the pre-change label behaviour).
	const condMoat = process.env.VMAPGEN_MOAT !== 'off';
	// Every union may weld the wall cells embedded in its own marks, but
	// only until its placed mass reaches ~45% of the mark cells: without a
	// cap, a big map's frame absorbs comp after comp into one 96%
	// super-mass. The cap leaves room for several fat ranges instead. DOM
	// runs the same cap here and a hard growth stop at 55% of marks below -
	// the dominant mass is meant to be the biggest blob, not the only one.
	const unionMass = new Map();
	const compOf = n => {
		if (!massComp.has(n)) return 0;
		const v = massComp.get(n);
		return v > 0 && compWeb[find(v - 1)] ? 0 : find(v - 1) + 1;
	};
	const ridgeLeft = new Set(ridgeCells);
	const ridgeGuard = ridgeLeft.size
		? makeConnectivityGuard(blocked, levelIndex, W, H, 2) : null;
	const coverReject = { legal: 0, cover: 0, fits: 0, guard: 0,
		bounds: 0, web: 0, foreign: 0, busyOcc: 0, busyRes: 0,
		busyBar: 0, busyGuard: 0, busyStart: 0, busyDist: 0 };
	let ridgeClustersPlaced = 0;
	// Screen a piece's blocked cells: bounds, free ground, mark coverage, and
	// the mass-consent rule - a piece may merge into only its own comp, the
	// web if its comp is web-eligible, or a foreign comp that is itself
	// attach-eligible. Returns { legal, covered, spill, merge, touchWeb }.
	const checkPiece = (own, mc, spillD) => {
		const ownSet = new Set(own);
		const spill = [], covered = [];
		let legal = true, touchWeb = false, touchOwn = false,
			joinWeb = false;
		const merge = new Set();
		for (const k of own) {
			if (!legal) break;
			if (k < 0 || k >= W * H) { legal = false; coverReject.bounds++; break; }
			if (ridgeLeft.has(k)) {
				covered.push(k);
				const fk = find(markComp.get(k));
				if (fk !== mc - 1) merge.add(fk);
			}
			else if (!blocked[levelIndex * W * H + k] && !barriers.has(k)
					&& !guardCells.has(k) && !nearStart(k)
					&& markDist[k] > spillD) spill.push(k);
			else {
				legal = false;
				const fb = blocked[levelIndex * W * H + k];
				if (fb & OCCUPIED) coverReject.busyOcc++;
				else if (fb) coverReject.busyRes++;
				else if (barriers.has(k)) coverReject.busyBar++;
				else if (guardCells.has(k)) coverReject.busyGuard++;
				else if (nearStart(k)) coverReject.busyStart++;
				else coverReject.busyDist++;
				break;
			}
			const kx = k % W, ky = (k / W) | 0;
			for (let dy = -2; dy <= 2 && legal; dy++)
				for (let dx = -2; dx <= 2 && legal; dx++) {
					if (!dx && !dy) continue;
					const nx = kx + dx, ny = ky + dy;
					if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
					const n = ny * W + nx;
					if (ownSet.has(n)
							|| !(blocked[levelIndex * W * H + n] & OCCUPIED))
						continue;
					const lab = compOf(n);
					const adjacent = Math.abs(dx) <= 1 && Math.abs(dy) <= 1;
					if (lab === 0) {
						if (!adjacent) continue;
						// an absorbed comp's own cells read as web; they are
						// still its mass. And a wall bounded by only this
						// comp's marks is the mass the marks describe, so it
						// welds without the attach coin-flip - but welding
						// owned cells keeps the comp's own label, while an
						// attach weld still dissolves it into the web.
						const v = massComp.get(n);
						const ownAbs = condMoat && v > 0
							&& find(v - 1) === find(mc - 1);
						if (compAttach[mc - 1] || ownAbs) {
							touchWeb = true; joinWeb = true;
						} else if (condMoat
								&& webOwner.get(n) === find(mc - 1)
								&& (unionMass.get(find(mc - 1)) || 0)
									< ridgeCells.size * 0.45) {
							// a wall embedded in the comp's own marks is
							// the mass the marks describe; welding it does
							// not join the web, so the moat stays between
							// different components
							touchWeb = true;
						} else { legal = false; coverReject.web++; }
						if (compWeb[mc - 1] || ownAbs) touchOwn = true;
					} else if (lab !== mc && adjacent) {
						merge.add(lab - 1);
					} else if (adjacent) touchOwn = true;
				}
		}
		// a piece that touches or covers a foreign comp welds it in - legal
		// when both masses agreed to attach, or when either side is the
		// dominant mass, which absorbs what it touches. DOM's absorb is
		// capped too: uncapped it chained union after union into a 90%
		// super-mass on 108x108. 40% of the mark cells lands DOM's
		// connected footprint inside the corpus band (44-84% of blocking)
		// across sizes - the welded web cells around it ride for free.
		const domOpen = () =>
			(unionMass.get(DOM) || 0) < ridgeCells.size * 0.40;
		for (const j of merge) {
			const fj = find(j), fm = find(mc - 1);
			if (fm === DOM || fj === DOM) {
				if (!domOpen()) { legal = false; coverReject.foreign++; break; }
				continue;
			}
			if (!(compAttach[mc - 1] && compAttach[j])) {
				legal = false; coverReject.foreign++; break;
			}
		}
		return { legal, covered, spill, merge, touchWeb, touchOwn, joinWeb };
	};
	// commit a screened piece: block its cells, union the comps it joined,
	// label them web if it welded to the wall web by attach consent
	const commitPiece = (own, mc, merge, joinWeb, entry, tpl, x, y) => {
		ridgeClustersPlaced++;
		objects.push(entry);
		footprintBlock(tpl, x, y, levelIndex, W, H, blocked);
		for (const j of merge) {
			const rj = find(j), rm = find(mc - 1);
			if (rj === rm) continue;
			// DOM is the one doing the absorbing: when a foreign union's
			// piece welds into it, the PLACING union merges into DOM, so
			// the dominant mass keeps its root instead of losing its label
			// to whatever touched it first. DOM cells were reading 0 on big
			// maps because the first contact reparented DOM under a comp.
			if (rj === DOM) {
				parent[rm] = rj;
				compWeb[rj] = compWeb[rj] || compWeb[rm];
				unionMass.set(rj,
					(unionMass.get(rj) || 0) + (unionMass.get(rm) || 0));
				continue;
			}
			parent[rj] = rm;
			if (rm !== DOM) compWeb[rm] = compWeb[rm] || compWeb[rj];
			unionMass.set(rm,
				(unionMass.get(rm) || 0) + (unionMass.get(rj) || 0));
		}
		const root = find(mc - 1);
		// the dominant mass keeps its own label even at the wall so foreign
		// pieces can still merge into it instead of hitting the web rule
		if (joinWeb && root !== DOM) compWeb[root] = true;
		massLive.add(root);
		unionMass.set(root, (unionMass.get(root) || 0) + own.length);
		// always store the comp label, never 0: compOf reads a webbed comp
		// as 0 through compWeb, while a stored 0 would come back as NaN and
		// turn the comp's own cells foreign to it the moment it welded.
		for (const k of own)
			massComp.set(k, condMoat ? root + 1 : (compWeb[root] ? 0 : root + 1));
		if (ridgeGuard) ridgeGuard.refresh();
	};
	const massLive = new Set();
	// One cover attempt at a mark: biggest fitting piece that keeps at least
	// `minCover` of its cells on marks, spills no closer than `spillD` to a
	// corridor, and - unless this is the comp's seed - touches the comp's
	// existing cells so the mass stays one blob.
	const tryCover = (c, spillD, minCells, minCover, isSeed = false) => {
		const x = c % W, y = (c / W) | 0;
		const terrain = biomeTerrain[ridgeBiome.get(c)];
		const mc = find(markComp.get(c)) + 1;
		// a full DOM stops growing - its uncovered marks read as moats
		if (mc - 1 === DOM
				&& (unionMass.get(DOM) || 0) >= ridgeCells.size * 0.40)
			return false;
		for (const d of wallClusters(terrain, rng, 16, 6)) {
			if (d.cells < minCells) continue;
			// per-draw mass cap: pieces past ~20 cells grow masses too fast
			// and leave the fringe to one-cell crumbs. DOM is exempt - a big
			// piece welding into the dominant mass is exactly the case where
			// the corpus still spends one.
			if (d.cells > 20 && mc - 1 !== DOM) continue;
			const own = blockingCells(d.tpl, x, y).map(([a, b]) => b * W + a);
			if (own.length < minCells) continue;
			const r = checkPiece(own, mc, spillD);
			if (!r.legal) { coverReject.legal++; continue; }
			if (!isSeed && !r.touchOwn) continue;
			if (r.covered.length * 5 < own.length * minCover) {
				coverReject.cover++; continue;
			}
			if (!footprintFits(d.tpl, x, y, levelIndex, W, H, blocked)) {
				coverReject.fits++; continue;
			}
			if (ridgeGuard && !ridgeGuard.accepts(own)) {
				coverReject.guard++; continue;
			}
			commitPiece(own, mc, r.merge, r.joinWeb,
				objectEntry(d.type, x, y, levelIndex, d.tpl, d.subtype),
				d.tpl, x, y);
			for (const k of r.covered) ridgeLeft.delete(k);
			return true;
		}
		return false;
	};
	// Each mark component is covered by whole packs replayed from the
	// corpus: one pack is one authored mass, so the comp keeps whatever
	// outline a real generator gave it. A pack is refused when any of its
	// cells sits on a corridor or would weld it to a mass it may not join.
	const compMarks = new Map();
	for (const c of ridgeCells) {
		const id = markComp.get(c);
		if (!compMarks.has(id)) compMarks.set(id, []);
		compMarks.get(id).push(c);
	}
	const compOrder = [...compMarks.keys()]
		.sort((a, b) => compMarks.get(b).length - compMarks.get(a).length);
	if (process.env.VMAPGEN_MARK_ASCII) {
		for (let y = 0; y < H; y += 1) {
			let row = '';
			for (let x = 0; x < W; x += 1) {
				const i = y * W + x;
				if (ridgeCells.has(i)) row += '#';
				else if (blocked[levelIndex * W * H + i]) row += '.';
				else row += ' ';
			}
			console.error(row);
		}
	}
	for (const id of compOrder) {
		const marks = compMarks.get(id);
		const mc = find(id) + 1;
		// DOM stops growing at the cap: its own packs count the same as
		// absorbed ones, or a union seeded big keeps placing own cells
		// long after the absorb cap shut (108x108 reached 70% of marks
		// that way). Its leftover marks stay open - they are moats.
		if (mc - 1 === DOM
				&& (unionMass.get(DOM) || 0) >= ridgeCells.size * 0.40)
			continue;
		const terrain = biomeTerrain[ridgeBiome.get(marks[0])];
		// packs anchor on the comp's deepest marks first - cells farthest
		// from corridors are where a fat authored mass can sit
		const deep = [...marks].sort((a, b) => markDist[b] - markDist[a]);
		let coveredHere = 0, failed = 0;
		while (coveredHere < marks.length * 0.8 && failed < 14) {
			// a pack is a whole authored mass; ask for one no bigger than
			// the region it has to share with the corridor moats. Same ~20
			// cell cap as tryCover, DOM exempt for the weld case.
			const want = Math.min(mc - 1 === DOM ? 60 : 20,
				(marks.length - coveredHere) * 0.7 + 8);
			const p = packFor(terrain, rng, want);
			if (!p) break;
			// the pack's cells offset from its bounding-box corner - centre
			// it on the anchor so thin mark regions can host it
			let cx = 0, cy = 0;
			for (const [dx, dy] of p.cells) { cx += dx; cy += dy; }
			cx = Math.round(cx / p.cells.length);
			cy = Math.round(cy / p.cells.length);
			let done = false;
			for (let t = 0; t < 40 && !done; t++) {
				const c = deep[(rng() * Math.min(deep.length, 12)) | 0];
				if (!ridgeLeft.has(c)) continue;
				const x = c % W - cx, y = (c / W | 0) - cy;
				const own = p.cells.map(([dx, dy]) => (y + dy) * W + x + dx);
				const r = checkPiece(own, mc, 0);
				if (!r.legal) { coverReject.legal++; continue; }
				// every object of the pack must fit its own mask
				let ok = true;
				for (const o of p.objects) {
					const tpl = { animation: o.animation, mask: o.mask };
					if (!footprintFits(tpl, x + o.dx, y + o.dy,
							levelIndex, W, H, blocked)) { ok = false; break; }
				}
				if (!ok) { coverReject.fits++; continue; }
				if (ridgeGuard && !ridgeGuard.accepts(own)) {
					coverReject.guard++; continue;
				}
				for (const o of p.objects) {
					const tpl = { animation: o.animation, mask: o.mask };
					if (o.visitableFrom) tpl.visitableFrom = o.visitableFrom;
					objects.push(objectEntry(o.type, x + o.dx, y + o.dy,
						levelIndex, tpl, o.subtype || 'object'));
					footprintBlock(tpl, x + o.dx, y + o.dy,
						levelIndex, W, H, blocked);
				}
				ridgeClustersPlaced++;
				for (const j of r.merge) {
					const rj = find(j), rm = find(mc - 1);
					if (rj === rm) continue;
					// DOM absorbs the placer's union, not the reverse -
					// keeps the dominant mass's root stable
					if (rj === DOM) {
						parent[rm] = rj;
						compWeb[rj] = compWeb[rj] || compWeb[rm];
						unionMass.set(rj, (unionMass.get(rj) || 0)
							+ (unionMass.get(rm) || 0));
						continue;
					}
					parent[rj] = rm;
					if (rm !== DOM)
						compWeb[rm] = compWeb[rm] || compWeb[rj];
					unionMass.set(rm, (unionMass.get(rm) || 0)
						+ (unionMass.get(rj) || 0));
				}
				if (r.joinWeb && find(mc - 1) !== DOM)
					compWeb[find(mc - 1)] = true;
				massLive.add(find(mc - 1));
				unionMass.set(find(mc - 1),
					(unionMass.get(find(mc - 1)) || 0) + own.length);
				for (const k of own)
					massComp.set(k, condMoat ? find(mc - 1) + 1
						: (compWeb[find(mc - 1)] ? 0 : find(mc - 1) + 1));
				if (ridgeGuard) ridgeGuard.refresh();
				for (const k of r.covered) ridgeLeft.delete(k);
				coveredHere += r.covered.length;
				done = true;
			}
			if (!done) failed++;
		}
	}
	// Packs take the fat cores; the leftover marks are fringe and thin
	// bands where a whole authored mass will not sit. Cover those with the
	// piece pass the same consent rules already drive.
	// rounds of seed + grow: a comp that has no mass yet gets seeded, a live
	// comp grows only at marks that touch it, so every mass stays one blob.
	// A mark the mass never reaches stays open - those are the moats.
	for (let round = 0; round < 8 && ridgeLeft.size; round++) {
		let placed = 0;
		for (const c of ridgeCells)
			if (ridgeLeft.has(c)
					&& tryCover(c, 0, 2, 2,
						!massLive.has(find(markComp.get(c)))))
				placed++;
		for (const c of ridgeCells)
			if (ridgeLeft.has(c)
					&& tryCover(c, 1, 1, 1,
						!massLive.has(find(markComp.get(c)))))
				placed++;
		if (!placed) break;
	}
	// Last pass, one-cell stones on the marks a shaped piece never fit: in
	// the moat between two attach-eligible masses such a stone welds them
	// into one mass, and on an open pocket it is the corpus's lone decor.
	for (const c of ridgeCells) {
		if (!ridgeLeft.has(c)) continue;
		const x = c % W, y = (c / W) | 0;
		const mc = find(markComp.get(c)) + 1;
		if (mc - 1 === DOM
				&& (unionMass.get(DOM) || 0) >= ridgeCells.size * 0.40)
			continue;
		const terrain = biomeTerrain[ridgeBiome.get(c)];
		for (let t = 0; t < 8; t++) {
			const s = singleTemplate(terrain, rng);
			if (!s) break;
			const own = blockingCells(s.tpl, x, y).map(([a, b]) => b * W + a);
			if (!own.length) continue;
			const r = checkPiece(own, mc, 0);
			if (!r.legal) continue;
			// a lone stone earns its place only where it joins or welds a
			// mass - a mark ringed by open ground stays open. And even then
			// only about half land: the corpus spends its leftover marks as
			// open moat, not as a rock every time - ours ran ~100 one-cell
			// decor per 1000 cells against the corpus's ~40.
			if (!r.touchOwn && !r.touchWeb && !r.merge.size) continue;
			if (rng() > 0.07) continue;
			if (!footprintFits(s.tpl, x, y, levelIndex, W, H, blocked))
				continue;
			if (ridgeGuard && !ridgeGuard.accepts(own)) continue;
			commitPiece(own, mc, r.merge, r.joinWeb,
				objectEntry(s.type, x, y, levelIndex, s.tpl, s.subtype),
				s.tpl, x, y);
			for (const k of r.covered) ridgeLeft.delete(k);
			break;
		}
	}
	if (ridgeCells.size) {
		// how much of what is left sits inside a comp's own mass shadow
		// (reachable but never fit) versus moat between masses
		let moat = 0, inside = 0;
		for (const c of ridgeLeft) {
			const x = c % W, y = (c / W) | 0;
			let foreign = false, own = false;
			for (let dy = -1; dy <= 1; dy++)
				for (let dx = -1; dx <= 1; dx++) {
					if (!dx && !dy) continue;
					const nx = x + dx, ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
					const n = ny * W + nx;
					if (!(blocked[levelIndex * W * H + n] & OCCUPIED)) continue;
					const lab = compOf(n);
					if (lab === 0 || lab !== find(markComp.get(c)) + 1)
						foreign = true;
					else own = true;
				}
			if (foreign) moat++; else if (own) inside++;
		}
		// union census after cover: how many unions, and DOM's real size
		const unionCells = new Map();
		for (const [cell, lab] of massComp) {
			const r = lab === 0 ? -1 : find(lab - 1);
			unionCells.set(r, (unionCells.get(r) || 0) + 1);
		}
		const domCells = unionCells.get(DOM) || 0;
		// LEAD-DIAG 2026-09-22: split the moat census - is a leftover mark
		// fenced by the WEB (label 0), by a FOREIGN union's mass, or only by
		// marks of a comp that never placed a piece (stillborn)?
		let moatWeb = 0, moatForeign = 0, stillborn = 0, attachL = 0;
		for (const c of ridgeLeft) {
			const x = c % W, y = (c / W) | 0;
			const mcRoot = find(markComp.get(c));
			if (!massLive.has(mcRoot)) stillborn++;
			if (compAttach[mcRoot]) attachL++;
			let w = false, f = false;
			for (let dy = -1; dy <= 1; dy++)
				for (let dx = -1; dx <= 1; dx++) {
					if (!dx && !dy) continue;
					const nx = x + dx, ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
					const n = ny * W + nx;
					if (!(blocked[levelIndex * W * H + n] & OCCUPIED)) continue;
					const lab = compOf(n);
					if (lab === 0) w = true;
					else if (lab !== mcRoot + 1) f = true;
				}
			if (w) moatWeb++; if (f) moatForeign++;
		}
		if (process.env.VMAPGEN_MARK_TRACE)
			console.error(`[diag] l${levelIndex} moat split: web ${moatWeb}, `
				+ `foreign ${moatForeign}, stillborn-comp ${stillborn}, `
				+ `attach-eligible ${attachL}, comps ${compAttach.length}, `
				+ `live ${massLive.size}, domRoot ${DOM} domCells ${domCells}`);
		console.error(`[gen] level ${levelIndex}: ${ridgeCells.size} interior `
			+ `ridge cell(s), ${ridgeClustersPlaced} range cluster(s) placed, `
			+ `${ridgeLeft.size} left (moat ${moat}, inside ${inside}), `
			+ `unions ${unionCells.size}, DOM cells ${domCells}, `
			+ `rejects ${JSON.stringify(coverReject)}`);
	}
	if (process.env.VMAPGEN_MARK_TRACE) {
		// how many 8-connected blocked masses exist right after the cover
		const seen = new Uint8Array(W * H), sizes = [];
		for (let i = 0; i < W * H; i++) {
			if (seen[i] || !(blocked[levelIndex * W * H + i] & OCCUPIED)) continue;
			const st = [i]; seen[i] = 1; let n = 0;
			while (st.length) {
				const k = st.pop(); n++;
				const x = k % W, y = (k / W) | 0;
				for (let dy = -1; dy <= 1; dy++)
					for (let dx = -1; dx <= 1; dx++) {
						if (!dx && !dy) continue;
						const nx = x + dx, ny = y + dy;
						if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
						const nk = ny * W + nx;
						if (!seen[nk] && (blocked[levelIndex * W * H + nk] & OCCUPIED)) {
							seen[nk] = 1; st.push(nk);
						}
					}
			}
			sizes.push(n);
		}
		sizes.sort((a, b) => b - a);
		const tot = sizes.reduce((s, v) => s + v, 0);
		console.error(`[cover] l${levelIndex}: ${tot} blocked, ${sizes.length} `
			+ `masses, largest ${sizes[0] || 0} `
			+ `(${Math.round(100 * (sizes[0] || 0) / (tot || 1))}%)`);
	}

	const guardsLost = [];
	// each zone's share of the doorway guards on its borders, half a guard
	// per side (fillLevel: a free zone's monster budget pays for them)
	const doorGuards = new Map();
	for (const g of guards) {
		const x = g.cell % W, y = (g.cell / W) | 0;
		if (!footprintFits(OBJECT_TEMPLATES.randomMonster, x, y, levelIndex, W, H,
				blocked, true)) {
			guardsLost.push(`${g.edge.join('-')} at (${x},${y}) flags ${blocked[levelIndex * W * H + g.cell]}`);
			continue;
		}
		const guardEntry = objectEntry(`randomMonsterLevel${g.level}`, x, y, levelIndex,
			OBJECT_TEMPLATES.randomMonster, 'object',
			g.amount ? { character: 'hostile', amount: g.amount } : monsterOptions(g.level, p, rng));
		// the creature the engine's rule picked, for generate.js to write
		if (g.creature) guardEntry.guardCreature = g.creature;
		objects.push(guardEntry);
		// Held, not walled: every flood that decides what the fill may reach
		// sees through a guard, as a hero does by fighting it. Walled, a guard
		// in a one-cell passage cut every zone behind it off the fill: on Jebus
		// Cross 108 s5001 three of the four start zones got no mines and no
		// towns. Reserved, nothing is built on its cell. (The passes that know
		// objects, the pocket pass and the stranded sweep, see the monster.)
		reserveCell(blocked, levelIndex, W, H, g.cell);
		markApproach(OBJECT_TEMPLATES.randomMonster, x, y, levelIndex, W, H, blocked);
		for (const z of g.edge) doorGuards.set(z, (doorGuards.get(z) || 0) + 0.5);
	}
	// a doorway left without its guard is an open way between two zones the
	// template (or the guard setting) meant closed
	if (guardsLost.length)
		console.error(`[gen] level ${levelIndex}: WARNING ${guardsLost.length} doorway guard(s) found no room: `
			+ guardsLost.join(', '));
	for (const o of openings)
		if (o.kind === 'openRoad') for (const c of o.hole) roadCells.add(c);

	// Everything that blocks is now in. Check once more that the level is in
	// one piece, because a chokepoint guard or a monolith can close a doorway
	// the barrier pass opened a moment earlier.
	const reopened = openSealedByObjects(objects, W, H, levelIndex, blocked,
		playerStarts, towns, links, water, levelIndex > 0);
	if (reopened)
		console.error(`[gen] level ${levelIndex}: removed ${reopened} scenery `
			+ 'object(s) that sealed part of the level off');

	// Structure only, on purpose. The content fill runs later, from
	// fillLevel(), because a subterranean gate has to claim ground on the
	// walkable part of BOTH levels and the fill consumes every walkable cell it
	// is given. Placing the gates after the fill meant that on a 36x36 two
	// level map not one of the 55 anchors where a gate footprint still fitted
	// had open reachable ground beside it, so zero gates were placed and the
	// entire underground was unreachable.
	return { zone, seeds, gateSites, gateSitesHere, classes, biomeTerrain, barriers, roadCells, roadFailed, objects, openings,
		guards, doorGuards, rng, p, levelIndex, playerStarts, alignPlayers, towns,
		objectPools, openMask, zoneMeta, zdist, rim, harbours, links, sailLinks,
		stats: layoutStats(zone, seeds, tplZones, tplConns, unfulfilled, forced, W, H, water, openMask, landCells) };
}

/**
 * Turn the template's connection list into the biome-edge connection map.
 * A template edge that exists geometrically opens with its declared road
 * flag; every geometric edge not in the template is walled, which is what
 * gives template zones their separate-rooms feel. Template edges the Voronoi
 * did not create (zones that ended up not touching) come back separately so
 * the caller can bridge them with a portal pair, the same mechanism the
 * engine's RMG uses for links it cannot draw as land.
 */
function templateConnections(edges, conns, rng, p) {
	const wanted = new Map();
	for (const c of conns)
		wanted.set(Math.min(c.a, c.b) * 100000 + Math.max(c.a, c.b), c);
	const connections = new Map();
	const edgeInfo = new Map();
	for (const e of edges) {
		const k = e.a * 100000 + e.b;
		const c = wanted.get(k);
		if (!c) { connections.set(k, 'blocked'); continue; }
		const share = p.openPathRoad / (p.openPathNoRoad + p.openPathRoad || 1);
		const road = c.road === null || c.road === undefined ? rng() < share : c.road;
		connections.set(k, road ? 'openRoad' : 'openNoRoad');
		edgeInfo.set(k, c);
		wanted.delete(k);
	}
	return { connections, edgeInfo, unfulfilled: [...wanted.values()] };
}

/**
 * Drop content into a level that already has all its structure.
 *
 * Reachability is worked out here rather than in planLevel because gates land
 * between the two passes: a mine behind a carved barrier is a mine nobody ever
 * takes, and reachability tools found 4 of 18 mines stranded on a 36x36 map
 * before this existed, with no other validator noticing.
 */
function fillLevel(plan, W, H, blocked) {
	const { zone, classes, biomeTerrain, levelIndex, playerStarts, alignPlayers,
		towns, objectPools, rng, p } = plan;
	const objects = plan.objects;
	// On a level with no player starts, the region that matters is the one the
	// gates open into, not simply the largest one. A cave can have a big
	// chamber the gates never reach, and filling it means content nobody can
	// ever take: a 108x108 two level map shipped six such objects.
	// Player starts describe one region: the component that holds them. Gate
	// and portal entrances each open a pocket of their own, so they union.
	const isOccupied = c => !!(blocked[levelIndex * W * H + c] & OCCUPIED);
	// ...and the ground a portal pair (or a boat) leads on to (queue 27)
	// Below the surface a level's starts may meet only through the surface (a
	// template's start zones there, each linked up to the centre): every
	// start's ground counts, with every way in, or the fill left all but one
	// start zone empty (Jebus Cross 108 on two levels: 14 of 14 mines).
	const nearStarts = () => {
		const cells = [...(plan.entrances || [])];
		for (const s of playerStarts)
			for (let dy = -3; dy <= 3; dy++)
				for (let dx = -3; dx <= 3; dx++) {
					const x = s.x + dx, y = s.y + dy;
					if (x >= 0 && y >= 0 && x < W && y < H) cells.push(y * W + x);
				}
		return cells;
	};
	const reachable = followLinks(playerStarts.length
		? (levelIndex > 0 ? reachableUnion(W, H, levelIndex, blocked, nearStarts())
			: mainComponent(W, H, levelIndex, blocked, playerStarts))
		: (plan.entrances && plan.entrances.length
			? reachableUnion(W, H, levelIndex, blocked, plan.entrances)
			: mainComponent(W, H, levelIndex, blocked, [])), plan.links, W, H, isOccupied);
	// One guard per LEVEL, not per biome: a wall built in one biome can seal
	// off another, so the check has to see the whole level. It is seeded from
	// the region a player actually starts in, or the largest one when the level
	// has no starts, which is the underground. Ground joined only by a portal
	// pair is a piece of its own, and each piece gets a guard of its own.
	const pieceSeeds = [];
	const inPiece = new Uint8Array(W * H);
	for (let i = 0; i < W * H; i++) {
		if (!reachable[i] || inPiece[i] || isOccupied(i)) continue;
		pieceSeeds.push(i);
		const stack = [i];
		inPiece[i] = 1;
		while (stack.length) {
			const c = stack.pop(), x = c % W, y = (c / W) | 0;
			for (let dy = -1; dy <= 1; dy++)
				for (let dx = -1; dx <= 1; dx++) {
					const nx = x + dx, ny = y + dy;
					if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
					const n = ny * W + nx;
					if (!inPiece[n] && reachable[n] && !isOccupied(n)) { inPiece[n] = 1; stack.push(n); }
				}
		}
	}
	const guards = (pieceSeeds.length ? pieceSeeds : [-1])
		.map(s => makeConnectivityGuard(blocked, levelIndex, W, H, 2, s));
	const connectivity = guards.length === 1 ? guards[0] : {
		get size() { return guards.reduce((s, g) => s + g.size, 0); },
		get reachable() {
			const r = new Uint8Array(W * H);
			for (const g of guards) for (let i = 0; i < W * H; i++) if (g.reachable[i]) r[i] = 1;
			return r;
		},
		accepts: cells => guards.every(g => g.accepts(cells)),
		refresh: () => guards.forEach(g => g.refresh()),
	};

	// Starter mines go in now rather than beside the town earlier, because
	// only now is it known which ground a hero can actually stand on.
	// With a template they are the start zone's own wood and ore, placed near
	// the town the way the engine places a start zone's first wood and ore
	// mines, and they count toward what the zone lists: the fidelity lens
	// (vmap_templatefit.js, 2026-09-25) found them stacked on top, 15.6
	// sawmills on Nostalgia against the engine's 8. A template start zone
	// that lists no wood or ore gets none.
	const RES_OF = { sawmill: 'wood', orePit: 'ore' };
	const starterDone = new Map();
	// the mines themselves, for the fill to lay their resources beside (content.js)
	const starterMines = new Map();
	for (const s of playerStarts) {
		const home = zone[s.y * W + s.x];
		const meta = plan.zoneMeta && plan.zoneMeta[home];
		const kinds = meta
			? STARTER_MINES.filter(k => ((meta.mines || {})[RES_OF[k]] || 0) > 0) : STARTER_MINES;
		const got = placeStarterMines(s, zone, biomeTerrain, levelIndex,
			W, H, blocked, rng, p, reachable, connectivity, kinds);
		objects.push(...got);
		const done = starterDone.get(home) || {};
		for (const o of got) done[RES_OF[o.subtype]] = (done[RES_OF[o.subtype]] || 0) + 1;
		starterDone.set(home, done);
		starterMines.set(home, [...(starterMines.get(home) || []), ...got]);
	}

	// Fill each biome's cells with class-appropriate content.
	const byBiome = new Map();
	for (let i = 0; i < zone.length; i++) {
		if (!byBiome.has(zone[i])) byBiome.set(zone[i], []);
		byBiome.get(zone[i]).push(i);
	}
	// TOWN-class biomes first so their towns enter the registry before other
	// biomes' dwellings look for a sameAsTown link target.
	const order = [...byBiome.keys()].sort((a, b) =>
		(classes[a] === BIOME_CLASS.TOWN ? 0 : 1) - (classes[b] === BIOME_CLASS.TOWN ? 0 : 1));
	for (const b of order) {
		// A free layout's start zone holds a share of the map (startZoneShare,
		// biomes.js), several of the old start zones' worth. Its ground nearest
		// the town, one biome's worth (zoneCells), is filled as a start, and the
		// rest as the standard zones it took the place of: filled as a start
		// all through, the start zones' low monster and high pile rates ran the
		// map's monsters down to 0.86 of the corpus and its dwellings up to 1.7.
		const parts = [[classes[b], byBiome.get(b)]];
		const home = !plan.zoneMeta && classes[b] === BIOME_CLASS.PLAYER
			&& playerStarts.find(s => zone[s.y * W + s.x] === b);
		if (home && byBiome.get(b).length > p.zoneCells) {
			const d2 = c => (c % W - home.x) ** 2 + (((c / W) | 0) - home.y) ** 2;
			const near = byBiome.get(b).slice().sort((a, c) => d2(a) - d2(c) || a - c);
			parts.splice(0, 1, [BIOME_CLASS.PLAYER, near.slice(0, p.zoneCells)],
				[BIOME_CLASS.STANDARD, near.slice(p.zoneCells)]);
		}
		// the zone's doorway guards stand on its edge, so its far part pays for them
		parts.forEach(([cls, cells], i) =>
			objects.push(...fillBiome(cls, cells, blocked, W, H,
				levelIndex, rng, { ...p, doorGuards: i === parts.length - 1 && plan.doorGuards ? plan.doorGuards.get(b) || 0 : 0 },
				towns, alignPlayers || playerStarts, objectPools,
				biomeTerrain[b], reachable, connectivity,
				plan.zoneMeta && plan.zoneMeta[b]
					&& { ...plan.zoneMeta[b], minesDone: starterDone.get(b) || {} }, plan.openMask,
				plan.zdist && plan.zdist[b], i === 0 ? starterMines.get(b) || [] : [])));
	}
	return plan;
}

/**
 * Plan a whole map (all levels). Underground gets the narrow/wide mix via
 * p.subterraneanNarrow and gates per p.subterraneanGateRatio linking the
 * surface cells to the underground.
 */
/**
 * The start-parity top-up. Runs once on the finished surface plan; the
 * metric is the same one vmap_startparity.js grades a written map with:
 * summed object values whose visitable cells lie within RADIUS BFS steps
 * of the town's entrance, over ground where only permanent blocking
 * counts (removable objects - monsters, piles, chests - walk through, so
 * a posted guard does not shrink a start's measured ring the way a real
 * wall would).
 *
 * The engine's own maps spread x1.1..x8.2 on this metric, so parity is
 * not about flattening to x1.0: the bar is bringing every start to two
 * thirds of the richest, which is the UNFAIR line the tool draws and a
 * starting position a contestant can still play out of.
 */
function balanceStarts(plan, W, H, blocked, playerStarts, rng) {
	const levelIndex = plan.levelIndex || 0;
	const objects = plan.objects;
	const zone = plan.zone;
	const RES_VALUE = { wood: 300, ore: 300, mercury: 1000, sulfur: 1000,
		crystal: 1000, gems: 1000, gold: 750, random: 750 };
	const ART_VALUE = { treasure: 5000, minor: 10000, major: 20000,
		relic: 30000, concrete: 10000, any: 10000 };
	const MINE_VALUE = { sawmill: 2000, orePit: 2000, alchemistLab: 3000,
		sulfurDune: 3000, crystalCavern: 3000, gemPond: 3000, goldMine: 5000 };
	const UTIL = { treasureChest: 1500, campfire: 600, pandoraBox: 8000,
		spellScroll: 3000, prison: 12000, seerHut: 6000, warriorsTomb: 8000,
		dragonUtopia: 25000, pyramid: 15000, crypt: 2500 };
	const RADIUS = 18;
	const objValue = o => {
		const t = o.type, s = String(o.subtype || '');
		if (t === 'resource') return RES_VALUE[s] || 500;
		if (t === 'randomResource') return 750;
		if (t === 'artifact') return ART_VALUE.concrete;
		const m = t.match(/^randomArtifact(Treasure|Minor|Major|Relic)$/);
		if (m) return ART_VALUE[m[1].toLowerCase()];
		if (t === 'randomArtifact') return ART_VALUE.any;
		if (t === 'creatureBank') return 15000;
		if (t === 'mine') return MINE_VALUE[s] || 2500;
		return UTIL[t] || 0;
	};
	// Cells an object can be entered from: mask 'V' or 'A' entries, the
	// same set the parity tool's cellsOf('VA') reads.
	const cellsVA = (tpl, x, y) => {
		const out = [];
		for (let i = 0; i < tpl.mask.length; i++) {
			const line = String(tpl.mask[i]);
			for (let j = 0; j < line.length; j++) {
				if (line[j] !== 'V' && line[j] !== 'A') continue;
				const fx = x - (line.length - 1 - j),
					fy = y - (tpl.mask.length - 1 - i);
				if (fx >= 0 && fy >= 0 && fx < W && fy < H)
					out.push(fy * W + fx);
			}
		}
		return out;
	};
	// Flood-blocked ground the way the tool reads it: only objects that
	// stay on the map count, since a removable one goes away when used.
	const soft = new Uint8Array(W * H);
	for (const o of objects) {
		if ((o.l || 0) !== levelIndex || !o.template || !o.template.mask)
			continue;
		if (REMOVABLE_TYPES.has(o.type)) continue;
		for (const [fx, fy] of blockingCells(o.template, o.x, o.y))
			if (fx >= 0 && fy >= 0 && fx < W && fy < H)
				soft[fy * W + fx] = 1;
	}
	// and water, which the tool reads as blocked too
	if (plan.p && plan.p.water)
		for (let c = 0; c < W * H; c++) if (plan.p.water[c]) soft[c] = 1;
	// The town's own cells start the walk even though its gate is a blocked
	// tile here: the tool reads the gate as open ground, and dropping it left
	// the walk starting from the town's two top corners alone, which on a
	// crowded map sit in a pocket behind the town (36x36 p8 s2: red and
	// orange measured 6,300 and 13,100 from behind their own walls).
	const bfs = seeds => {
		const dist = new Int32Array(W * H).fill(-1);
		const q = seeds.slice();
		for (const c of q) dist[c] = 0;
		for (let qi = 0; qi < q.length; qi++) {
			const c = q[qi], x = c % W, y = (c / W) | 0;
			for (let dy = -1; dy <= 1; dy++)
				for (let dx = -1; dx <= 1; dx++) {
					if (!dx && !dy) continue;
					const nx = x + dx, ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
					const n = ny * W + nx;
					if (soft[n] || dist[n] >= 0) continue;
					dist[n] = dist[c] + 1; q.push(n);
				}
		}
		return dist;
	};
	const entries = [];
	for (const s of playerStarts) {
		const town = objects.find(o => (o.l || 0) === levelIndex
			&& (o.type === 'town' || o.type === 'randomTown')
			&& o.options && o.options.owner === s.color);
		const seeds = town ? cellsVA(town.template, town.x, town.y)
			: [s.y * W + s.x];
		const dist = bfs(seeds.length ? seeds : [s.y * W + s.x]);
		const gateCell = town && visitableCells(town.template, town.x, town.y)
			.map(([gx, gy]) => gy * W + gx)[0];
		let value = 0;
		for (const o of objects) {
			if ((o.l || 0) !== levelIndex) continue;
			const v = objValue(o);
			if (!v) continue;
			for (const c of cellsVA(o.template, o.x, o.y))
				if (dist[c] >= 0 && dist[c] <= RADIUS) { value += v; break; }
		}
		entries.push({ s, dist, value, gateCell });
	}
	// Target off the median, not the best: one start that rolled two banks
	// and a relic should not force seven more to be showered with loot.
	const sorted = entries.map(e => e.value).sort((a, b) => a - b);
	const median = sorted[(sorted.length / 2) | 0];
	const target = median * 0.67;
	for (const e of entries) {
		if (e.value >= target) continue;
		// The guard protects the ground this start walks, seeded beside its
		// own gate. One guard seeded at the first start's anchor (a blocked
		// tile, so it fell back to the largest open region) left every start
		// outside that region unable to take a single pickup: on an island
		// map that is every island but the largest (72x72 p4 s1: red and
		// green drew all their candidate cells and placed nothing).
		// open ground in front of the gate, else any a step from the town
		let seed = -1;
		const byGate = c => e.gateCell !== undefined
			&& Math.max(Math.abs(c % W - e.gateCell % W),
				Math.abs(((c / W) | 0) - ((e.gateCell / W) | 0))) === 1;
		for (const near of [true, false])
			for (let c = 0; c < W * H && seed < 0; c++)
				if (e.dist[c] === 1 && (!near || byGate(c))
						&& !(blocked[levelIndex * W * H + c] & OCCUPIED)) seed = c;
		const connectivity = makeConnectivityGuard(blocked, levelIndex, W, H, 2, seed);
		const home = zone[e.s.y * W + e.s.x];
		// Home-biome cells first, then the rest of the ring: a poor start
		// whose own zone is crowded still deserves its kit, and a pickup
		// anywhere in the ring counts for that player the same way.
		const nearHome = [], rest = [];
		for (let c = 0; c < W * H; c++) {
			if (e.dist[c] < 2 || e.dist[c] > RADIUS) continue;
			if (blocked[levelIndex * W * H + c] & (OCCUPIED | RESERVED))
				continue;
			(zone[c] === home ? nearHome : rest).push(c);
		}
		// The kit climbs in value as the gap does: chests and piles close a
		// small shortfall, a deficit of artifact size needs an artifact to
		// move at all (a poor 8-player start can be 100k down, which is a
		// hundred resource piles of ground nobody has).
		let placed = 0, arts = 0;
		for (let tries = 0; tries < 128 && e.value < target && placed < 12;
				tries++) {
			const src = nearHome.length ? nearHome : rest;
			if (!src.length) break;
			const ci = (rng() * src.length) | 0;
			const c = src[ci];
			// A drawn cell is spent either way: an anchor that vetoes once
			// vetoes every time it is redrawn, and redrawing it was all that
			// happened on a start whose whole ring was already crowded.
			src.splice(ci, 1);
			const x = c % W, y = (c / W) | 0;
			const gap = target - e.value;
			let type, tpl, subtype, v;
			// the last cells the ring has left, or the last piece a start may take,
			// take a piece big enough to close the gap: a crowded start ran out of
			// ground a chest or a pile short (36x36 for eight, red at 97% of its
			// target with no cell left), and one ran out of pieces (purple at 82%,
			// twelve placed, twenty cells left)
			const closing = nearHome.length + rest.length <= 2 || placed === 11
				? [[750, 'randomResource'], [1500, 'treasureChest'], [5000, 'randomArtifactTreasure'], [10000, 'randomArtifactMinor'], [20000, 'randomArtifactMajor']]
					.find(([val]) => val >= gap) : null;
			if (closing) {
				[v, type] = closing;
			} else if (gap >= 15000 && arts < 3) {
				type = 'randomArtifactMajor'; v = 20000;
			} else if (gap >= 8000 && arts < 3) {
				type = 'randomArtifactMinor'; v = 10000;
			} else if (gap >= 4000 && arts < 3) {
				type = 'randomArtifactTreasure'; v = 5000;
			} else if (gap >= 1500) {
				type = 'treasureChest'; v = 1500;
			} else {
				type = 'randomResource'; v = 750;
			}
			if (type.startsWith('randomArtifact')) {
				tpl = OBJECT_TEMPLATES.randomArtifact;
				subtype = 'object';
				arts++;
			} else {
				tpl = type === 'treasureChest' ? chestTemplate()
					: pileTemplate('randomResource');
				subtype = type;
			}
			if (!footprintFits(tpl, x, y, levelIndex, W, H, blocked, true))
				continue;
			// Not null: balanceStarts runs after sweepStranded, so a pickup
			// dropped into a pocket the fill sealed off is never re-checked.
			// The pocket cell itself stays free ground, which is exactly what
			// a reach-blind entranceOpen counts as open.
			if (!entranceOpen(tpl, x, y, levelIndex, W, H, blocked,
				connectivity.reachable))
				continue;
			const walls = blockingCells(tpl, x, y).map(([a, b]) => b * W + a);
			if (!connectivity.accepts(walls)) continue;
			if (weldsMasses(walls, blocked, levelIndex, W, H, 1)) continue;
			objects.push(objectEntry(type, x, y, levelIndex, tpl, subtype));
			footprintBlock(tpl, x, y, levelIndex, W, H, blocked);
			markApproach(tpl, x, y, levelIndex, W, H, blocked);
			connectivity.refresh();
			placed++;
			e.value += v;
		}
		if (process.env.VMAPGEN_PARITY_DEBUG)
			console.error(`[parity] ${e.s.color}: value=${e.value} `
				+ `target=${Math.round(target)} cands=${nearHome.length}+`
				+ `${rest.length} placed=${placed}`);
		if (placed)
			console.error(`[gen] level ${levelIndex}: ${e.s.color}'s start `
				+ `topped up with ${placed} pickup(s)`);
	}
}

function planMap({ W, H, levels, playerStarts, params, terrainShortIds,
	tileIdsByShort, numTiles, objectPools, terrainInfo }) {
	const p = { ...BIOME_DEFAULTS, ...params };
	// Mines are budgeted per player AND per acre, whichever asks for more. A
	// small map still has to hand every player a full set, so its density
	// runs above a large map's; but per player alone left 108x108 at 0.35x
	// and 144x144 at 0.74x of the corpus per floor cell (queue item 19). The
	// corpus surface runs 3.6 mines per 1000 cells up to 108x108, 1.9 at
	// 144x144, 1.7 at 180x180 and up. MINE_LANDING covers what the rate loses
	// between budget and map: it is applied per zone to the ground still open
	// at fill time, and a per-player budget of 24 landed 15-20 on 108x108.
	// Converting the budget to a rate here lets the per-biome fill stay a
	// simple density like everything else.
	const A = W * H;
	const mineAcre = A <= 11664 ? 3.6
		: A <= 20736 ? 3.6 + (1.9 - 3.6) * (A - 11664) / (20736 - 11664)
		: A <= 32400 ? 1.9 + (1.7 - 1.9) * (A - 20736) / (32400 - 20736) : 1.7;
	// The share of the budget that survives placement grows with map area:
	// measured 2026-09-24 at a flat 1.4, 108x108 landed 0.85x of the corpus
	// mines-per-floor and 144x144 landed 1.03x (item 19 residual). The
	// factors below are the measured reciprocals at the class centres,
	// interpolated between them; 72x72 and under stay at 1.4 where the
	// per-player floor nearly binds anyway. 180x180 was first set to 1.30
	// on the guess that the trend kept falling; probed, it landed 1.44 per
	// 1000 floor cells against the 1.7 target, so it gets its reciprocal too.
	const MINE_LANDING = A <= 5184 ? 1.4
		: A <= 11664 ? 1.4 + (1.65 - 1.4) * (A - 5184) / (11664 - 5184)
		: A <= 20736 ? 1.65 + (1.36 - 1.65) * (A - 11664) / (20736 - 11664)
		: A <= 32400 ? 1.36 + (1.53 - 1.36) * (A - 20736) / (32400 - 20736)
		: 1.53;
	const mineBudget = Math.max(MINES_PER_PLAYER * Math.max(1, playerStarts.length),
		MINE_LANDING * mineAcre * A / 1000);
	// A rate per level's floor: every level runs at the one-level density.
	// The budget used to be spread over all levels, which halved a two-level
	// map's surface (0.61x the corpus's surface mines, against 0.75x on
	// one-level maps; fidelity lens run T11, 2026-09-25). The cave boost in
	// content.js was calibrated on that halved rate, so it is halved with it
	// and the underground keeps its count.
	p.mineRate = mineBudget / (W * H / 1000);
	const rng = xorshift(params.seed || 1);
	const blocked = new Uint8Array(W * H * levels);
	const plans = [];
	// the map's monolith channels and joined zones (portals.js), the active
	// mods' after the core's
	p._links = linkBook(p.monolithChannels || []);
	// a level's own starts (a template may put some below, template.js assignLevels)
	const startsOn = l => playerStarts.filter(s => (s.l || 0) === l);
	const towns = []; // cross-level sameAsTown registry (instanceNames are global)
	for (let l = 0; l < levels; l++) {
		const starts = startsOn(l);
		// A template zone linked to zones on a level already laid out is laid
		// out over them: the engine's zone placer draws both levels in one
		// plane, so a link between levels pulls its zones onto the same ground
		// and its subterranean gate pair (one x,y, both levels) finds a place.
		// Laid out apart, the zones rarely shared a cell: [HotA] Nostalgia made
		// 1 gate where the corpus has 21 and monoliths took the rest (47
		// against 30); Coldshadow's Fantasy 0 against 13 (lens t37L).
		// A zone linked to a start pinned on a level still to come starts on
		// that start's ground the same way (template.js assignLevels can put
		// starts below); on the surface only when some start is below, so a map
		// with none is laid out as before.
		const anchors = p.zonePlan ? crossLevelAnchors(p.zonePlan, plans, l, playerStarts, W, H) : null;
		const above = l > 0 && plans[l - 1].gateSites && plans[l - 1].gateSites.length ? plans[l - 1].gateSites : null;
		plans.push(planLevel({
			W, H, levelIndex: l, playerStarts: starts,
			alignPlayers: playerStarts, towns,
			params: anchors && (l > 0 || anchors.some(Boolean))
				? { ...p, layoutAnchors: anchors, ...(above ? { gateSitesAbove: above } : {}) } : p,
			terrainShortIds, tileIdsByShort, numTiles, blocked,
			underground: l > 0, objectPools, terrainInfo,
		}));
	}
	if (p.layoutOnly) return { plans, blocked };
	// Subterranean gates.
	//
	// These are the only way down, so a two-level map with none is a map whose
	// whole second level is dead weight. The old version took a single random
	// cell per gate and gave up on that gate if the footprint did not fit, and
	// it asked for as few as one gate, derived from the surface opening count.
	// A 36x36 two-level map came out with zero gates and thirty underground
	// objects nothing could ever touch, and no validator noticed, because
	// nothing in the pipeline checked that the levels are connected at all.
	//
	// Now: at least two pairs, placed between the structure pass and the
	// content fill so the walkable ground they need still exists, probed over
	// every anchor in a shuffled order rather than sampled a handful of times,
	// each half required to have open ground beside its entrance on its own
	// level, and a loud complaint if the map ends up with none.
	//
	// Both halves carry the same pairId so the stranded sweep can drop them
	// together. Half a pair is a door that opens onto nothing, because
	// CGSubterraneanGate::postInit gives an unmatched gate a channel of its own.
	if (levels > 1) {
		// one pair per two surface openings at the default ratio: one per four
		// gave two-level maps half the corpus's gates (7-8 against 13-18 a
		// map; fidelity lens, 2026-09-25). Surface opening count scales with
		// zone count same as the portal share does (see portalGateScale in
		// biomes.js), so it gets the same rescale past REF_ZONES or a bigger
		// map's gate count runs away the same way portals did (5.23x corpus,
		// fidelity lens 2026-09-25, before this rescale).
		const gateCount = Math.max(2,
			Math.round(plans[0].openings.length * p.subterraneanGateRatio / 2
				* portalGateScale(plans[0].classes.length)));
		const surfaceTpl = OBJECT_DEFS.subterraneanGate;
		const underTpl = OBJECT_DEFS.subterraneanGateUnder;
		const order = [];
		for (let i = 0; i < W * H; i++) order.push(i);
		for (let i = order.length - 1; i > 0; i--) {
			const j = (rng() * (i + 1)) | 0;
			[order[i], order[j]] = [order[j], order[i]];
		}
		// A gate is a twelve cell footprint with three blocking cells, and an
		// underground level is now a cave with tunnels a few cells wide, so a
		// gate can plug one. Everything else that places an object checks this;
		// the gates did not, and on a 36x36 cave they cut the level into 239,
		// 40 and 1, with both gates opening into the 40.
		const conn = [0, 1].map(l => makeConnectivityGuard(blocked, l, W, H));
		// Template connections whose zones landed on different levels cannot
		// become a border, so the engine's RMG draws them as a subterranean
		// gate pair (gates pair by shared x,y across levels) or a teleport.
		// Same here: try a shared coordinate inside zone A on the surface and
		// zone B underground; if no cell can hold both halves, a monolith
		// pair on open cells deep inside each zone carries the link instead.
		const crossConns = (p.zonePlan ? p.zonePlan.connections : [])
			.filter(c => c.aRef && c.bRef && c.aRef.l !== c.bRef.l);
		const reachNow = () => [0, 1].map(l =>
			mainComponent(W, H, l, blocked, startsOn(l)));
		const zoneCell = (l, zi, reach, tpl) => {
			// open reachable cell nearest the zone centroid
			const cells = [];
			let cx = 0, cy = 0, n = 0;
			for (let i = 0; i < W * H; i++)
				if (plans[l].zone[i] === zi) {
					cx += i % W; cy += (i / W) | 0; n++;
					cells.push(i);
				}
			if (!n) return -1;
			cx = cx / n | 0; cy = cy / n | 0;
			cells.sort((a, b) =>
				((a % W - cx) ** 2 + (((a / W) | 0) - cy) ** 2)
				- ((b % W - cx) ** 2 + (((b / W) | 0) - cy) ** 2));
			for (const c of cells) {
				const x = c % W, y = (c / W) | 0;
				if (footprintFits(tpl, x, y, l, W, H, blocked)
					&& inZone(tpl, x, y, plans[l].zone, zi, W, H)
					&& entranceOpen(tpl, x, y, l, W, H, blocked, reach))
					return c;
			}
			return -1;
		};
		phase('underworld');
		let crossGates = 0, crossPortals = 0, crossLeftOut = 0;
		const book = p._links;
		const node = r => `${r.l}:${r.i}`;
		// A cross-level link's guard in front of each end, as the engine guards
		// a gate or a monolith with the link's strength (ConnectionsPlacer.cpp:
		// selfSideIndirectConnection addGuard, placeMonolithConnection's
		// required objects). Placed without one, every gate and portal between
		// the levels was a free passage: on Coldshadow's Fantasy 144x2 one
		// start walked through them into 20 of the map's 23 towns unopposed.
		// Held clear like a doorway guard (planLevel), not walled.
		// A guard stands where it covers no other link's gate or monolith when
		// it can: a monster guards the 3x3 round it, and one beside another
		// link's end makes that link a fight too. On [HotA] Nostalgia seed 5001
		// a gate's 81 zombie lords stood by the monolith of a link the template
		// leaves free, and cut purple off from the three starts it shares ground
		// with.
		const otherEnds = (l, x, y) => {
			const out = new Set();
			for (const o of plans[l].objects)
				if ((o.type === 'monolithTwoWay' || o.type === 'subterraneanGate') && o.template
						&& !(o.x === x && o.y === y))
					for (const [vx, vy] of visitableCells(o.template, o.x, o.y)) out.add(vy * W + vx);
			return out;
		};
		const covers = (ends, monster, gx, gy) => visitableCells(monster, gx, gy).some(([vx, vy]) => {
			for (let dy = -1; dy <= 1; dy++)
				for (let dx = -1; dx <= 1; dx++) {
					const nx = vx + dx, ny = vy + dy;
					if (nx >= 0 && ny >= 0 && nx < W && ny < H && ends.has(ny * W + nx)) return true;
				}
			return false;
		});
		const guardEnd = (l, tpl, x, y, z, strength) => {
			if (!(strength > 0) || process.env.VMAPGEN_PORTAL_GUARD === '0' || Number(p.guardBottlenecks) === 0) return false;
			const meta = plans[l].zoneMeta;
			const concrete = !!(objectPools && objectPools.guards && meta);
			const g = engineGuard(strength, 1 + Math.round(p.monsterStrength || 0), rng, true,
				concrete ? zoneGuardPool(objectPools.guards, meta[z] && meta[z].spec) : undefined);
			if (!g) return false;
			const monster = OBJECT_TEMPLATES.randomMonster;
			const ends = otherEnds(l, x, y);
			const cells = approachCells(tpl, x, y, l, W, H, blocked);
			for (const clear of [true, false])
				for (const c of cells) {
					const gx = c % W, gy = (c / W) | 0;
					if (clear && covers(ends, monster, gx, gy)) continue;
					if (!footprintFits(monster, gx, gy, l, W, H, blocked, true)) continue;
					const e = objectEntry(`randomMonsterLevel${g.level}`, gx, gy, l, monster, 'object',
						{ character: 'hostile', amount: g.amount });
					if (concrete) e.guardCreature = g.creature;
					plans[l].objects.push(e);
					reserveCell(blocked, l, W, H, c);
					markApproach(monster, gx, gy, l, W, H, blocked);
					if (!clear && process.env.VMAPGEN_GATE_TRACE)
						console.error(`[gate] level ${l}: the guard at (${gx},${gy}) also covers another link's end`);
					return true;
				}
			return false;
		};
		// every held surface site is given back first, a pair or not, so none
		// stays a blocked footprint with nothing on it
		const heldPair = new Map();
		for (const s of plans[0].gateSites || []) {
			const down = (plans[1].gateSitesHere || []).find(d => d.k === s.k && d.x === s.x && d.y === s.y);
			releaseGateGround(surfaceTpl, s.x, s.y, 0, W, H, blocked);
			if (down) {
				releaseGateGround(underTpl, s.x, s.y, 1, W, H, blocked);
				heldPair.set(s.k, s.y * W + s.x);
			}
		}
		if (heldPair.size || (plans[0].gateSites || []).length) { conn[0].refresh(); conn[1].refresh(); }
		const needPortal = [];
		for (const c of crossConns) {
			const lo = c.aRef.l === 0 ? c.aRef : c.bRef;
			const hi = c.aRef.l === 0 ? c.bRef : c.aRef;
			const cand = [];
			for (let i = 0; i < W * H; i++)
				if (plans[0].zone[i] === lo.i && plans[1].zone[i] === hi.i)
					cand.push(i);
			for (let i = cand.length - 1; i > 0; i--) {
				const j = (rng() * (i + 1)) | 0;
				[cand[i], cand[j]] = [cand[j], cand[i]];
			}
			// the pair held for this link goes first
			const held = heldPair.get(p.zonePlan.connections.indexOf(c));
			if (held !== undefined) cand.unshift(held);
			const reach = reachNow();
			let done = false;
			for (const cell of cand) {
				const x = cell % W, y = (cell / W) | 0;
				if (!footprintFits(surfaceTpl, x, y, 0, W, H, blocked)) continue;
				if (!footprintFits(underTpl, x, y, 1, W, H, blocked)) continue;
				if (!inZone(surfaceTpl, x, y, plans[0].zone, lo.i, W, H)
					|| !inZone(underTpl, x, y, plans[1].zone, hi.i, W, H)) continue;
				if (!entranceOpen(surfaceTpl, x, y, 0, W, H, blocked, reach[0])) continue;
				// the underground half is itself the way in, so its pocket
				// does not have to be reachable before the gate exists
				if (!entranceOpen(underTpl, x, y, 1, W, H, blocked, null)) continue;
				const wallsS = blockingCells(surfaceTpl, x, y).map(([a, b]) => b * W + a);
				const wallsU = blockingCells(underTpl, x, y).map(([a, b]) => b * W + a);
				if (!conn[0].accepts(wallsS) || !conn[1].accepts(wallsU)) continue;
				const pairId = `gate_${x}_${y}`;
				for (const l of [0, 1]) {
					const tpl = l === 0 ? surfaceTpl : underTpl;
					const entry = objectEntry('subterraneanGate', x, y, l, tpl,
						STRUCTURE_SUBTYPE.subterraneanGate);
					entry.pairId = pairId;
					plans[l].objects.push(entry);
					footprintBlock(tpl, x, y, l, W, H, blocked);
					markApproach(tpl, x, y, l, W, H, blocked);
					conn[l].refresh();
					// approach cells, not the anchor: this pocket becomes
					// reachable through the gate, wherever it sits
					(plans[l].entrances = plans[l].entrances || [])
						.push(...approachCells(tpl, x, y, l, W, H, blocked));
					// a link with a road has one to the gate on each level
					// (ConnectionsPlacer.cpp: placeObject(gate, ..., allowRoad))
					if (c.road === true)
						(plans[l].roadNodes = plans[l].roadNodes || []).push(approachCells(tpl, x, y, l, W, H, blocked));
					// the visitable cell itself is where the hero lands;
					// sweepStranded seeds standable ground from it
					(plans[l].arrivals = plans[l].arrivals || [])
						.push(...visitableCells(tpl, x, y)
							.filter(([a, b]) => a >= 0 && b >= 0 && a < W && b < H)
							.map(([a, b]) => b * W + a));
				}
				guardEnd(0, surfaceTpl, x, y, lo.i, c.guard);
				guardEnd(1, underTpl, x, y, hi.i, c.guard);
				book.join(node(lo), node(hi));
				crossGates++;
				done = true;
				break;
			}
			if (!done) needPortal.push(c);
		}
		// The links no gate could carry become monolith pairs, a channel each
		// (portals.js): the ones still joining zones apart first, and once the
		// channels are all taken a link whose zones are joined another way is
		// left out.
		while (needPortal.length) {
			let at = needPortal.findIndex(k => !book.joined(node(k.aRef), node(k.bRef)));
			if (at < 0) at = 0;
			const c = needPortal.splice(at, 1)[0];
			const lo = c.aRef.l === 0 ? c.aRef : c.bRef;
			const hi = c.aRef.l === 0 ? c.bRef : c.aRef;
			let ch = book.next();
			if (!ch) {
				if (book.joined(node(lo), node(hi))) { crossLeftOut++; continue; }
				ch = book.shared();
			}
			const tpl = ch.tpl;
			const reach = reachNow();
			// same asymmetry as the gate: the surface monolith must be on
			// ground a hero can already walk to, the underground one just has
			// to stand on open carved floor, whatever pocket that is
			const ca = zoneCell(0, lo.i, reach[0], tpl);
			const cb = zoneCell(1, hi.i, null, tpl);
			if (ca < 0 || cb < 0) {
				console.error(`[gen] cross-level link zone ${lo.i}<->${hi.i}: `
					+ 'no gate, and the portal side '
					+ `${ca < 0 ? 'surface' : ''}${ca < 0 && cb < 0 ? '+' : ''}`
					+ `${cb < 0 ? 'underground' : ''} found no open cell`);
				continue;
			}
			book.take(ch);
			book.join(node(lo), node(hi));
			const subtype = ch.subtype;
			const ax = ca % W, ay = (ca / W) | 0, bx = cb % W, by = (cb / W) | 0;
			const pairId = `portal_${subtype}`;
			const e0 = monolithEntry(ax, ay, 0, ch);
			const e1 = monolithEntry(bx, by, 1, ch);
			e0.pairId = e1.pairId = pairId;
			plans[0].objects.push(e0);
			plans[1].objects.push(e1);
			footprintBlock(tpl, ax, ay, 0, W, H, blocked);
			footprintBlock(tpl, bx, by, 1, W, H, blocked);
			markApproach(tpl, ax, ay, 0, W, H, blocked);
			markApproach(tpl, bx, by, 1, W, H, blocked);
			guardEnd(0, tpl, ax, ay, lo.i, c.guard);
			guardEnd(1, tpl, bx, by, hi.i, c.guard);
			// the underground end is an entrance in its own right: the hero
			// teleports in, so whatever pocket it sits in is played space
			(plans[1].entrances = plans[1].entrances || [])
				.push(...approachCells(tpl, bx, by, 1, W, H, blocked));
			(plans[1].arrivals = plans[1].arrivals || [])
				.push(...visitableCells(tpl, bx, by)
					.filter(([a, b]) => a >= 0 && b >= 0 && a < W && b < H)
					.map(([a, b]) => b * W + a));
			// a link with a road has one to each monolith, as a gate's has
			if (c.road === true) {
				(plans[0].roadNodes = plans[0].roadNodes || []).push(approachCells(tpl, ax, ay, 0, W, H, blocked));
				(plans[1].roadNodes = plans[1].roadNodes || []).push(approachCells(tpl, bx, by, 1, W, H, blocked));
			}
			crossPortals++;
		}
		if (crossConns.length)
			console.error(`[gen] ${crossConns.length} cross-level template `
				+ `link(s): ${crossGates} gate pair(s), ${crossPortals} portal pair(s)`
				+ (crossLeftOut ? `, ${crossLeftOut} left out (the monolith channels all taken, their zones joined another way)` : ''));
		// Gates of the map's own, anywhere both levels fit: the free layout's
		// way between the levels, and a template's when none of its own links
		// could be placed. A template whose links stand gets no more: the
		// engine adds none, and these unguarded ones were free passages
		// between zones the template keeps apart.
		let placed = 0, cursor = 0;
		for (let i = 0; i < (crossGates + crossPortals ? 0 : gateCount); i++) {
			// reachability shifts as each pair lands, so recompute per gate; below
			// the surface the largest region, as before starts could lie there
			const reach = [0, 1].map(l => mainComponent(W, H, l, blocked,
				l === 0 ? startsOn(l) : []));
			let done = false;
			for (; cursor < order.length && !done; cursor++) {
				const c = order[cursor];
				const x = c % W, y = (c / W) | 0;
				// never inside a start's zone, on either level: these gates carry no
				// guard, and one there was a way out of the start past its guarded
				// doorways, into another start's ground (free layout, 72x72 s4)
				if ([0, 1].some(l => plans[l].classes && plans[l].classes[plans[l].zone[c]] === BIOME_CLASS.PLAYER)) continue;
				// a gate pair must fit and be usable on BOTH levels, else neither
				// half is placed: one lone gate is a channel with no other end
				if (!footprintFits(surfaceTpl, x, y, 0, W, H, blocked)) continue;
				if (!footprintFits(underTpl, x, y, 1, W, H, blocked)) continue;
				if (!entranceOpen(surfaceTpl, x, y, 0, W, H, blocked, reach[0])) continue;
				if (!entranceOpen(underTpl, x, y, 1, W, H, blocked, reach[1])) continue;
				const wallsS = blockingCells(surfaceTpl, x, y).map(([a, b]) => b * W + a);
				const wallsU = blockingCells(underTpl, x, y).map(([a, b]) => b * W + a);
				if (!conn[0].accepts(wallsS)) continue;
				if (!conn[1].accepts(wallsU)) continue;
				const pairId = `gate_${x}_${y}`;
				for (const l of [0, 1]) {
					const tpl = l === 0 ? surfaceTpl : underTpl;
					const entry = objectEntry('subterraneanGate', x, y, l, tpl,
						STRUCTURE_SUBTYPE.subterraneanGate);
					entry.pairId = pairId;
					plans[l].objects.push(entry);
					footprintBlock(tpl, x, y, l, W, H, blocked);
					markApproach(tpl, x, y, l, W, H, blocked);
					conn[l].refresh();
					// the underground's only way in, and therefore what
					// "reachable" has to mean down there
					(plans[l].entrances = plans[l].entrances || [])
						.push(...approachCells(tpl, x, y, l, W, H, blocked));
					(plans[l].arrivals = plans[l].arrivals || [])
						.push(...visitableCells(tpl, x, y)
							.filter(([a, b]) => a >= 0 && b >= 0 && a < W && b < H)
							.map(([a, b]) => b * W + a));
				}
				placed++;
				done = true;
			}
			if (!done) break;
		}
		// No gate fit: a gate needs its twelve-cell footprint free at the same
		// x,y on both levels, which a crowded small map with water can refuse
		// everywhere (fuzz seed 41 case 12: 72x72, seven players, 7SB0c,
		// water, the whole underground unreachable). A monolith pair needs
		// neither, so pairs of them carry the traffic instead: the surface
		// end on ground a hero can walk to, the underground end in the
		// cave's largest open region.
		let standIns = 0;
		if (!placed && !crossPortals && !crossGates) {
			const spot = (l, reach, used, tpl) => {
				for (const c of order) {
					const x = c % W, y = (c / W) | 0;
					if (used.some(u => Math.abs(u % W - x) + Math.abs(((u / W) | 0) - y) < 12)) continue;
					if (!footprintFits(tpl, x, y, l, W, H, blocked)) continue;
					if (!entranceOpen(tpl, x, y, l, W, H, blocked, reach)) continue;
					if (!conn[l].accepts(blockingCells(tpl, x, y).map(([a, b]) => b * W + a))) continue;
					return c;
				}
				return -1;
			};
			const usedUp = [], usedDown = [];
			for (let i = 0; i < gateCount; i++) {
				const reach = reachNow();
				// the only way down: a channel of its own, or the least-used one
				const ch = book.next() || book.shared();
				const tpl = ch.tpl;
				const ca = spot(0, reach[0], usedUp, tpl), cb = spot(1, reach[1], usedDown, tpl);
				if (ca < 0 || cb < 0) break;
				usedUp.push(ca); usedDown.push(cb);
				book.take(ch);
				const subtype = ch.subtype;
				const pairId = `portal_${subtype}`;
				const ends = [[ca % W, (ca / W) | 0], [cb % W, (cb / W) | 0]];
				ends.forEach(([x, y], l) => {
					const e = monolithEntry(x, y, l, ch);
					e.pairId = pairId;
					plans[l].objects.push(e);
					footprintBlock(tpl, x, y, l, W, H, blocked);
					markApproach(tpl, x, y, l, W, H, blocked);
					conn[l].refresh();
				});
				const [bx, by] = ends[1];
				(plans[1].entrances = plans[1].entrances || [])
					.push(...approachCells(tpl, bx, by, 1, W, H, blocked));
				(plans[1].arrivals = plans[1].arrivals || [])
					.push(...visitableCells(tpl, bx, by)
						.filter(([a, b]) => a >= 0 && b >= 0 && a < W && b < H)
						.map(([a, b]) => b * W + a));
				standIns++;
			}
		}
		// a template's own links, when any stand, are the way down (the random
		// gates above only run without them)
		if (!placed && !crossPortals && !crossGates && standIns)
			console.error(`[gen] no subterranean gate fit both levels; ${standIns} `
				+ 'monolith pair(s) link the surface and the underground instead');
		else if (!placed && !crossPortals && !crossGates)
			console.error('[gen] no subterranean gate could be placed: the '
				+ 'underground level is unreachable and everything on it is wasted');
		else if (!placed && !crossGates)
			console.error('[gen] no gate pair fit both levels without sealing '
				+ `a corridor; the ${crossPortals} portal pair(s) carry the `
				+ 'cross-level traffic');
		else
			console.error(`[gen] ${placed} subterranean gate pair(s) placed`);
	}

	// The roads went down in planLevel, before the walls and ridges. The gates
	// and monoliths of links with a road that landed here rather than on a
	// held site join them now, over whatever ground is left (roadplan.js).
	const roadsFirst = process.env.VMAPGEN_ROADS !== 'late';
	if (roadsFirst)
		for (let l = 0; l < levels; l++) {
			if (!(plans[l].roadNodes || []).length) continue;
			const r = planRoads({ plan: { zone: plans[l].zone, openings: [], roadCells: plans[l].roadCells,
				roadNodes: plans[l].roadNodes, p: plans[l].p }, towns: [],
				W, H, blocked, l, approach: t => roadApproach(t, W, H, blocked, l) });
			(plans[l].roadFailed = plans[l].roadFailed || []).push(...r.failedNodes);
			if (r.cells)
				console.error(`[gen] level ${l}: gates and monoliths placed late joined the roads, `
					+ `${r.cells} cells in ${r.zones} zone(s)`
					+ (r.failed ? `, ${r.failed} node(s) no road reached` : ''));
		}
	// the engine's free paths between each zone's links (holdFreePaths), on a
	// template map, where the fill keeps its guards off them
	if (p.zonePlan)
		for (let l = 0; l < levels; l++) {
			const held = holdFreePaths(plans[l], l, W, H, blocked);
			if (held) console.error(`[gen] level ${l}: ${held} cell(s) held clear between each zone's links`);
		}

	// Content fill runs last, after the gates have claimed their ground.
	phase('resources');
	for (const plan of plans) fillLevel(plan, W, H, blocked);

	// Roads go in after the fill, so they route around what is actually there.
	// A roaded biome opening on its own is two or three cells of road surface
	// leading nowhere; a network between the towns is what a real map has, and
	// cobblestone at 50 movement against 100 for open ground is worth real
	// distance per day to whoever walks it.
	for (let l = 0; l < levels; l++) {
		const here = towns.filter(t => (t.l || 0) === l && t.gates);
		// A one-player map with no neutral town has a single town, and a
		// network of one town is no network: those maps came out with no road
		// at all. Fall back to running the road from the town to the mines,
		// which is where its owner will be walking anyway.
		if (here.length === 1) {
			const mines = plans[l].objects
				.filter(o => o.type === 'mine' && (o.l || 0) === l)
				.map(o => ({ x: o.x, y: o.y, l,
					gates: visitableCells(o.template, o.x, o.y) }))
				.sort((a, b) => {
					const t = here[0];
					return (a.x - t.x) ** 2 + (a.y - t.y) ** 2
						- ((b.x - t.x) ** 2 + (b.y - t.y) ** 2);
				})
				.slice(0, 4);
			here.push(...mines);
		}
		const before = plans[l].roadCells.size;
		// roadNetwork 0 (player lever): no town-linking net; roads cut through
		// zone openings (openPathRoad) stay
		// With roads first, a template's roads are the engine's alone: towns
		// joined through the links that carry a road (CRoadRandomizer), and a
		// link without one, or a portal, leaves the towns it parts unjoined by
		// road, as in the engine. Routing them together after the fill is what
		// ran roads round objects and along the map's edge. The free layout's
		// towns were linked first where its passages allow (planLevel); a start
		// whose only passage leads into a dead end, or out by portal, would be
		// left with no road at all, so its town net still runs, riding the roads
		// already laid. A lone town still gets its road to the mines here.
		const templateRoads = roadsFirst && (plans[l].zoneMeta || []).some(m => m && m.spec);
		const added = (roadsFirst ? joinFailed(plans[l].roadFailed, plans[l].roadCells, plans[l].zone, W, H, blocked, l) : 0)
			+ (p.roadNetwork === 0 || (templateRoads && towns.filter(t => (t.l || 0) === l && t.gates).length > 1) ? 0
				: buildRoadNetwork(here, plans[l].roadCells, W, H, blocked, l));
		const orphans = pruneOrphanRoads(plans[l].roadCells, W, H);
		// Road ends that lead to nothing go (K: "tails going nowhere"), back to
		// the last junction, unless they end at a town, a mine or a passage
		// between levels: an opening's road patch the network passed by, a spur
		// the late network left.
		let tails = 0;
		if (roadsFirst) {
			const dest = new Set();
			const near = (vx, vy, r) => {
				for (let dy = -r; dy <= r; dy++)
					for (let dx = -r; dx <= r; dx++) {
						const x = vx + dx, y = vy + dy;
						if (x >= 0 && y >= 0 && x < W && y < H) dest.add(y * W + x);
					}
			};
			for (const t of here) for (const [gx, gy] of t.gates || []) near(gx, gy, 3);
			for (const o of plans[l].objects)
				if ((o.l || 0) === l && o.template && /^(mine|subterraneanGate|monolith)/.test(o.type))
					for (const [vx, vy] of visitableCells(o.template, o.x, o.y)) near(vx, vy, 1);
			tails = pruneTails(plans[l].roadCells, dest, W, H);
		}
		if (added || orphans || tails)
			console.error(`[gen] level ${l}: ${plans[l].roadCells.size} road cells `
				+ `(${before} before the town net, +${added} from it) `
				+ `linking ${here.length} place(s), ${orphans} orphan tile(s) and ${tails} tail tile(s) dropped`);
	}
	phase('edges');
	// Item 21: the rows just inside each zone's rim and along the map edge,
	// blocked the way the engine's post-object pass blocks them (rimfill.js).
	// After the fill and the roads so it costs neither anything; before the
	// seal sweeps and the retile so both see the final blocked set. Surface
	// only: a carved level's rock is already its zone wall.
	{
		const n = fillRimRows(plans[0], W, H, 0, blocked, rng, objectEntry,
			o => DECOR_TYPES_SET.has(o.type) && o.template && o.template.mask
				&& !o.template.mask.some(r => /[AT]/.test(r)));
		if (n) console.error(`[gen] level 0: rim rows filled, ${n} cell(s) blocked`);
	}
	phase('paths');
	// The content fill can close a pocket the structure-time pass opened:
	// settle fills and placed objects land after openSealedByObjects ran, so
	// a gate pocket sealed at fill time was never inspected. Sweep seals
	// once more on the finished level before the stranded sweep grades it.
	for (let l = 0; l < levels; l++) {
		const opened = openSealedByObjects(plans[l].objects, W, H, l, blocked,
			l > 0 ? (plans[l].entrances || []) : startsOn(l), null, plans[l].links,
			plans[l].p.water, l > 0);
		if (opened)
			console.error(`[gen] level ${l}: removed ${opened} scenery `
				+ 'object(s) that sealed part of the level off');
	}
	// The sweep needs each level's own starts. planLevel already passes none
	// for the underground, but this loop used to hand every level the surface
	// starts, so mainComponent preferred whichever underground pocket sat under
	// the surface towns instead of the largest region, and deleted everything
	// outside it as unreachable.
	const droppedPairs = new Set();
	for (let l = 0; l < levels; l++) {
		sweepStranded(plans[l], W, H, l,
			startsOn(l).length ? startsOn(l) : (plans[l].entrances || []), droppedPairs);
	}

	// Even out what each player's start ring offers. The ring here is the
	// same metric vmap_startparity.js measures a finished map with: object
	// values whose visitable cells lie within 18 BFS steps of the town's
	// entrance, over ground nothing but rock and water blocks - removable
	// objects walk through. An 8-player map can leave one start with a
	// fifth of another's ring value purely by draw luck, which is a match
	// decided before turn one. Where a start lands under two thirds of the
	// best, drop small pickups into its own biome inside the ring until it
	// catches up. Chests for a big gap, piles to close it out; both are
	// removable pickups, so the placement is the same guarded path the
	// content fill uses and can never wall anything in.
	// Each level's starts against each other (a template may put some below):
	// the ring is walked on one level. startFairness.js (generate.js) weighs
	// the starts across the levels.
	for (let l = 0; l < levels && playerStarts.length > 1; l++) {
		if (startsOn(l).length < 2) continue;
		balanceStarts(plans[l], W, H, blocked, startsOn(l), rng);
		// balanceStarts lands after the sweep above and its own drops can seal
		// a pocket another pickup sits in; grade the level once more so nothing
		// it added ships stranded.
		sweepStranded(plans[l], W, H, l, startsOn(l), droppedPairs);
	}
	// Scenery art, chosen the way the engine chooses it (retile.js): every
	// earlier pass decided WHICH cells are blocked; here the decor on them is
	// replaced by the zone's own obstacle sets, largest piece first. Measured
	// on the 29-map sweep before landing: surface decor 178 -> 140 objects per
	// 1k floor (corpus 95), the 5+ cell classes at corpus rate, and zones that
	// draw mountains from one set and trees from one or two, as 98% / 80% of
	// corpus zones do. Blocked cells are identical before and after.
	// VMAPGEN_RETILE=off keeps the older single-merging pass below instead.
	// VMAPGEN_RIM_TRACE: where do rim-band cells end up open, and why
	if (process.env.VMAPGEN_RIM_TRACE)
		for (let l = 0; l < levels; l++) {
			const rim = plans[l].rim;
			if (!rim) continue;
			const own = new Uint8Array(W * H);
			for (const o of plans[l].objects)
				if ((o.l || 0) === l && o.template && o.template.mask)
					for (const [x, y] of blockingCells(o.template, o.x, o.y))
						if (x >= 0 && y >= 0 && x < W && y < H) own[y * W + x] = 1;
			const t = { band: 0, blocked: 0, passage: 0, reserved: 0, approach: 0, other: 0 };
			for (let c = 0; c < W * H; c++) {
				if (!rim.band[c]) continue;
				t.band++;
				const f = blocked[l * W * H + c];
				if (own[c]) t.blocked++;
				else if (rim.passage[c]) t.passage++;
				else if (f & RESERVED) t.reserved++;
				else if (f & APPROACH) t.approach++;
				else t.other++;
			}
			console.error(`[rim] level ${l}: band ${t.band}, blocked ${t.blocked}, `
				+ `passage ${t.passage}, open-reserved ${t.reserved}, `
				+ `open-approach ${t.approach}, open-other ${t.other}`);
		}
	phase('forests');
	const retileOn = process.env.VMAPGEN_RETILE !== 'off';
	if (retileOn)
		for (let l = 0; l < levels; l++) {
			if (!plans[l].zone || !plans[l].biomeTerrain) continue;
			const res = retileLevel({ objects: plans[l].objects, zone: plans[l].zone,
				biomeTerrain: plans[l].biomeTerrain, W, H, l, rng,
				isScenery: o => DECOR_TYPES_SET.has(o.type) && o.template && o.template.mask
					&& o.template.mask.some(r => /[BH]/.test(r))
					&& !o.template.mask.some(r => /[AT]/.test(r)),
				blockingCells, entry: objectEntry });
			plans[l].objects = res.objects;
			if (res.before)
				console.error(`[gen] level ${l}: scenery retiled ${res.before} -> `
					+ `${res.after} object(s), ${res.kept} kept where no set fits`);
		}
	// The item-4 fringe, second reach: a lone one-cell decor object often
	// gains its blocked neighbours only after it is placed (pack members,
	// wall stones, early settle fills), which is why the in-fill merge
	// cannot see them. On the finished level, swap each eligible single
	// for a domino or L piece covering its cell plus neighbours that are
	// already blocked - the blocked set does not change, so nothing here
	// can seal or open anything; only the object size mix moves.
	for (let l = 0; l < levels && !retileOn; l++) {
		let merged = 0;
		const plan = plans[l], base = l * W * H;
		for (const o of plan.objects) {
			if (!DECOR_TYPES_SET.has(o.type)) continue;
			const own = blockingCells(o.template, o.x, o.y);
			if (own.length !== 1) continue;
			const [x, y] = own[0];
			if (x < 0 || y < 0 || x >= W || y >= H) continue;
			const terr = plan.biomeTerrain
				&& plan.biomeTerrain[plan.zone[y * W + x]];
			if (!terr) continue;
			let done = false;
			for (let t = 0; t < 8 && !done; t++) {
				const m = mergedTemplate(terr, rng);
				if (!m) break;
				const mh = m.tpl.mask.length;
				for (const [bj, br, rl] of m.cells) {
					const ax = x + (rl - 1 - bj), ay = y + (mh - 1 - br);
					const cover = blockingCells(m.tpl, ax, ay);
					let ok = cover.length >= 2;
					for (const [cx, cy] of cover) {
						const ci = cy * W + cx;
						const isOwn = cx === x && cy === y;
						if (isOwn) continue;
						if (cx < 0 || cy < 0 || cx >= W || cy >= H
								|| !(blocked[base + ci] & OCCUPIED)
								|| (blocked[base + ci]
									& (RESERVED | APPROACH))) {
							ok = false; break;
						}
					}
					if (!ok) continue;
					o.template = m.tpl; o.x = ax; o.y = ay; o.type = m.type; o.subtype = m.subtype || 'object';
					done = true; merged++;
					break;
				}
			}
		}
		if (merged)
			console.error(`[gen] level ${l}: merged ${merged} lone decor `
				+ 'object(s) into their masses');
	}
	// second pass: a pair whose other half was dropped on the level that ran
	// first has to go too, in both directions
	if (droppedPairs.size)
		for (const plan of plans) {
			const before = plan.objects.length;
			plan.objects = plan.objects.filter(o => !(o.pairId && droppedPairs.has(o.pairId)));
			if (plan.objects.length !== before)
				console.error(`[gen] dropped ${before - plan.objects.length} orphaned `
					+ 'subterranean gate half/halves');
		}
	for (const plan of plans) for (const o of plan.objects) delete o.pairId;

	// A dwelling follows its linked town's faction, so a link to a town the
	// sweeps removed leaves the engine resolving against nothing. Re-point
	// those at the nearest surviving town, or drop the link if none is left,
	// which falls back to a fully random faction rather than a broken one.
	const survivingTowns = [];
	for (const plan of plans)
		for (const o of plan.objects)
			if (o.type === 'randomTown' || o.type === 'town') survivingTowns.push(o);
	const names = new Set(survivingTowns.map(o => o.instanceName));
    let relinked = 0, cleared = 0;
	for (const plan of plans)
		for (const o of plan.objects) {
			const link = o.options && o.options.sameAsTown;
			if (!link || names.has(link)) continue;
			if (survivingTowns.length) {
				let best = survivingTowns[0], bd = Infinity;
				for (const t of survivingTowns) {
					const d = (t.x - o.x) ** 2 + (t.y - o.y) ** 2;
					if (d < bd) { bd = d; best = t; }
				}
				o.options.sameAsTown = best.instanceName;
				relinked++;
			} else { delete o.options.sameAsTown; cleared++; }
		}
	if (relinked || cleared)
		console.error(`[gen] re-pointed ${relinked} and cleared ${cleared} dwelling `
			+ 'link(s) whose town did not survive');

	// A map with obelisks buries one grail for the puzzle to point at, the way
	// every one of the corpus maps does. The marker is special-cased by the
	// engine reader (MapFormatJson.cpp:1150) and carries no template or
	// subtype. The cell is open reachable ground recorded during the fill,
	// since a hero has to be able to stand on it to dig.
	if (objectPools.obeliskCount) {
		const open = (objectPools.grailCandidates || [])
			.filter(c => !(blocked[c.l * W * H + c.y * W + c.x] & OCCUPIED));
		if (open.length) {
			const c = open[(rng() * open.length) | 0];
			plans[c.l].objects.push({ instanceName: 'grail', type: 'grail',
				l: c.l, x: c.x, y: c.y, options: { radius: 0 } });
		} else {
			console.error('[gen] obelisks placed but no open cell took the grail');
		}
	}

	// Water treasure and scenery (waterfill.js, water W2), last: on water only,
	// where a harbour's boat can sail, after every pass that prunes objects it
	// judges unreachable over land.
	for (const plan of plans)
		if (plan.harbours && plan.harbours.length)
			fillWater({ W, H, l: plan.levelIndex, water: plan.p.water, harbours: plan.harbours,
				rng: xorshift(((params.seed || 1) ^ 0x7a7e2) >>> 0), p: plan.p,
				objects: plan.objects, objectEntry });

	// Integrity audit: every blocking cell of every written object must carry
	// OCCUPIED in `blocked`. A cell that lost its mark is a hole the floods
	// see through while the file keeps the wall - 72x72 s5 shipped green
	// sealed behind a lake whose mouth cell had been unmarked that way.
	for (let l = 0; l < levels; l++) {
		for (const o of plans[l].objects) {
			if (!o.template || !o.template.mask) continue;
			for (const [fx, fy] of blockingCells(o.template, o.x, o.y)) {
				if (fx < 0 || fy < 0 || fx >= W || fy >= H) continue;
				if (!(blocked[l * W * H + fy * W + fx] & OCCUPIED))
					console.error(`[gen] level ${l}: ${o.instanceName} `
						+ `(${o.type}@${o.x},${o.y}) lost its mark on ${fx},${fy}`);
			}
		}
	}
	return { plans, blocked };
}

/**
 * Drop objects nothing can ever reach.
 *
 * Placement checks each object's entrance as it goes, but the map keeps
 * changing underneath: an object placed with clear ground beside it can be
 * sealed in by whatever lands next to it a moment later. This runs once at the
 * end, when the map has stopped moving, and removes whatever ended up walled
 * off. It leaves a map where every object a hero could want is a hero can
 * actually get to.
 *
 * Decorative barriers are skipped. Mountains and trees carry no visitable cell
 * by design, so judging them by their entrance would delete every one of them
 * and with it the whole biome boundary system.
 */
function sweepStranded(plan, W, H, levelIndex, playerStarts, droppedPairs) {
	const objs = plan.objects.filter(o => (o.l || 0) === levelIndex);

	// A cell is hard-blocked when the carve mask walls it off or a
	// non-removable object claims it. One held only by removable objects -
	// monsters, pickups, guards - is soft: it opens the moment its holder is
	// used, which is how every guard nest on a real map works. The check
	// mirrors check_reach.py: flood, clear every removable object whose
	// permitted approach is reached, reflood, repeat.
	const hard = new Uint8Array(W * H);
	if (plan.openMask)
		for (let c = 0; c < W * H; c++) if (!plan.openMask[c]) hard[c] = 1;
	// water is no ground to walk on: a boat crosses it (sails, below)
	const water = plan.p && plan.p.water;
	if (water)
		for (let c = 0; c < W * H; c++) if (water[c]) hard[c] = 1;
	const owners = new Map();
	for (const o of objs) {
		const tpl = o.template || {};
		if (!tpl.mask) continue;   // the grail marker carries no template
		for (const [bx, by] of blockingCells(tpl, o.x, o.y)) {
			if (bx < 0 || by < 0 || bx >= W || by >= H) continue;
			const c = by * W + bx;
			if (!owners.has(c)) owners.set(c, []);
			owners.get(c).push(o);
		}
	}
	for (const [c, list] of owners)
		if (list.some(o => !REMOVABLE_TYPES.has(o.type))) hard[c] = 1;

	// Per object: its visitable cells and the approach cells its
	// visitableFrom permits. An absent visitableFrom gives no permitted
	// direction at all - readJson leaves visitDir 0x00 and the object is
	// enterable from nothing.
	const meta = new Map();
	for (const o of objs) {
		const tpl = o.template || {};
		const dirs = allowedDirs(tpl);
		const vis = [], appr = [];
		for (const [vx, vy] of tpl.mask ? visitableCells(tpl, o.x, o.y) : []) {
			if (vx < 0 || vy < 0 || vx >= W || vy >= H) continue;
			vis.push(vy * W + vx);
			for (const [dx, dy] of dirs) {
				const nx = vx + dx, ny = vy + dy;
				if (nx >= 0 && ny >= 0 && nx < W && ny < H)
					appr.push(ny * W + nx);
			}
		}
		meta.set(o, { vis, appr });
	}

	const cleared = new Set();
	const walkable = c => !hard[c]
		&& (owners.get(c) || []).every(o => cleared.has(o.instanceName));

	// Standable seeds are visitable cells a hero occupies without walking:
	// the gate of an owned town at game start, a teleport's arrival cell.
	// From a visitable cell the hero may only step off through directions the
	// object's own visitableFrom permits, so those cells carry their allowed
	// exits; approach cells join the walk once they are genuinely open.
	const reach = new Uint8Array(W * H);
	const exitDirs = new Map();   // standable visitable cell -> its dirs
	const pending = [];           // approach cells, activated when walkable
	const stack = [];
	const portals = [];
	// a boat's boarding ground, once reached, lands on every shore of its
	// water (water W3)
	const sails = (plan.sailLinks || []).map(link => ({ link, used: false }));
	const arrivals = new Set(plan.arrivals || []);
	const stand = (o, m) => {
		for (const c of m.vis)
			if (!reach[c]) { reach[c] = 1; exitDirs.set(c, m.dirsSet); stack.push(c); }
		pending.push(...m.appr);
	};
	for (const o of objs) {
		const m = meta.get(o);
		const isPortal = o.type === 'subterraneanGate' || o.type === 'monolithTwoWay';
		const isStart = (o.type === 'randomTown' || o.type === 'town') && o.options && o.options.owner;
		const isArrival = isPortal && m.vis.some(c => arrivals.has(c));
		if (isStart || isArrival) {
			m.dirsSet = allowedDirs(o.template || {});
			stand(o, m);
		}
		if (isPortal) portals.push({ o, m, opened: isArrival });
	}
	// No seeds at all would drop every visitable object on the level. That
	// should never happen (level 0 always has the player towns and deeper
	// levels have gate ends), but if it does, fall back to treating every
	// open cell as reached - the pre-fixpoint behaviour - rather than ship a
	// level emptied by a bookkeeping slip.
	if (!stack.length && !pending.length)
		for (let c = 0; c < W * H; c++) if (walkable(c)) pending.push(c);

	const ALL_DIRS = [];
	for (let dy = -1; dy <= 1; dy++)
		for (let dx = -1; dx <= 1; dx++) if (dx || dy) ALL_DIRS.push([dx, dy]);

	let progress = true;
	while (progress) {
		progress = false;
		for (let i = 0; i < pending.length; i++) {
			const c = pending[i];
			if (!reach[c] && walkable(c)) { reach[c] = 1; stack.push(c); }
		}
		while (stack.length) {
			const c = stack.pop();
			const x = c % W, y = (c / W) | 0;
			for (const [dx, dy] of exitDirs.get(c) || ALL_DIRS) {
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const n = ny * W + nx;
				if (reach[n] || !walkable(n)) continue;
				reach[n] = 1;
				stack.push(n);
			}
		}
		// A portal whose approach is reached becomes a standing place itself,
		// and a monolith opens every same-subtype end on this level: one
		// subtype is one channel. A gate's partner lives on another level and
		// is that level's seed, not this one's.
		for (const p of portals) {
			if (p.opened) continue;
			// walkable matters: a portal's stand() seed marks its own
			// visitable cells reach[] without them being standable ground,
			// and an approach cell that IS a visitable cell of some opened
			// portal is not somewhere a hero can stand. Without this test a
			// sealed monolith certified itself: once its channel opened, its
			// sibling visitable cells counted as their own approach cells.
			if (!p.m.appr.some(c => reach[c] && walkable(c))) continue;
			const ends = p.o.type === 'monolithTwoWay'
				? portals.filter(q => q.o.type === 'monolithTwoWay'
					&& q.o.subtype === p.o.subtype)
				: [p];
			for (const q of ends) {
				if (q.opened) continue;
				q.opened = true;
				q.m.dirsSet = allowedDirs(q.o.template || {});
				stand(q.o, q.m);
			}
			progress = true;
		}
		for (const s of sails) {
			if (s.used || !s.link[0].some(c => reach[c] && walkable(c))) continue;
			s.used = true;
			pending.push(...s.link[1]);
			progress = true;
		}
		// Clearing: a removable object goes away once the hero can stand on an
		// approach cell its own visitableFrom permits.
		const freed = [];
		for (const o of objs) {
			const m = meta.get(o);
			if (!m || cleared.has(o.instanceName) || !REMOVABLE_TYPES.has(o.type))
				continue;
			if (m.appr.some(c => reach[c] && walkable(c))) {
				cleared.add(o.instanceName);
				progress = true;
				if (o.template && o.template.mask)
					for (const [bx, by] of blockingCells(o.template, o.x, o.y))
						if (bx >= 0 && by >= 0 && bx < W && by < H) freed.push(by * W + bx);
			}
		}
		// The ground a cleared object stood on is open now, and the walk has to
		// go on from it: the flood above skipped these cells while they were
		// held and nothing looked at them again, so everything past a guard or
		// a pickup read as sealed. A mine whose three ways in held an
		// artifact, a resource and its guard was dropped with all three
		// cleared and reached ground all round (Headquarters seed 1001).
		for (const c of freed) {
			if (reach[c] || !walkable(c)) continue;
			const x = c % W, y = (c / W) | 0;
			let touches = false;
			for (let dy = -1; dy <= 1 && !touches; dy++)
				for (let dx = -1; dx <= 1 && !touches; dx++) {
					if (!dx && !dy) continue;
					const nx = x + dx, ny = y + dy;
					if (nx >= 0 && ny >= 0 && nx < W && ny < H && reach[ny * W + nx]
							&& !exitDirs.has(ny * W + nx)) touches = true;
				}
			if (touches) { reach[c] = 1; stack.push(c); }
		}
	}

	const kept = [];
	let dropped = 0;
	const droppedTowns = [];
	const droppedTypes = {};
	for (const o of plan.objects) {
		if ((o.l || 0) !== levelIndex) { kept.push(o); continue; }
		const m = meta.get(o);
		// barriers, scenery and the maskless grail marker have no entrance to
		// keep open; they are kept as placed
		if (!m || !m.vis.length) { kept.push(o); continue; }
		// A player's own town is never deleted. If its gate is sealed the map
		// is broken and needs regenerating, which is worth shouting about;
		// quietly removing the start is the one outcome worse than that.
		const ownedTown = (o.type === 'randomTown' || o.type === 'town') && o.options && o.options.owner;
		const ok = m.appr.some(c => reach[c] && walkable(c));
		if (ok || ownedTown) {
			if (!ok && ownedTown)
				console.error(`[gen] level ${levelIndex}: ${o.options.owner}'s town at `
					+ `(${o.x},${o.y}) has no open ground at its gate; the map is `
					+ 'unplayable for that player and should be regenerated');
			kept.push(o);
		} else {
			dropped++;
			if (o.pairId && droppedPairs) droppedPairs.add(o.pairId);
			if (o.type === 'town' || o.type === 'randomTown') droppedTowns.push(`(${o.x},${o.y})`);
			droppedTypes[o.type] = (droppedTypes[o.type] || 0) + 1;
			if (process.env.VMAPGEN_DROP_TRACE && o.type === 'mine')
				console.error(`[drop] unreachable mine at (${o.x},${o.y}), its approach ${meta.get(o).appr.slice(0, 3).map(c => `${c % W},${(c / W) | 0}`).join(' ')}`);
		}
	}
	if (dropped)
		console.error(`[gen] level ${levelIndex}: dropped ${dropped} object(s) `
			+ 'nothing could reach' + (droppedTowns.length ? `, among them the neutral town(s) at ${droppedTowns.join(' ')}` : '')
			+ (process.env.VMAPGEN_DROP_TRACE ? ` [${Object.entries(droppedTypes).map(([k, v]) => `${k} ${v}`).join(', ')}]` : ''));
	plan.objects = kept;
}

module.exports = { planLevel, fillLevel, planMap, chooseTemplateLayout, OBJECT_DEFS,
	CLASS_TERRAIN_HINT, mainComponent, sweepStranded, openSealedPockets,
	openSealedByObjects, carveUnderground, templateBottleneck, crossLevelAnchors, pinnedStartSeed,
	holdFreePaths };
