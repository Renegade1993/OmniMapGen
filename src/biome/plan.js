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
const { zoneTownTypes, townTemplate, townMods } = require('./zoneTowns');
const { carveBoundaries, placeChokeGuards } = require('./boundaries');
const { buildRoadNetwork, pruneOrphanRoads, approach: roadApproach } = require('./roadnet');
const { planRoads, joinFailed, pruneTails } = require('./roadplan');
const { phase, setPhaseLevel } = require('../main/phases');
const { linkBook } = require('./portals');
const { fillBiome, blockingCells, footprintFits, footprintBlock, entranceOpen,
	visitableCells, reserveCell, makeConnectivityGuard, floodFrom, OCCUPIED,
	RESERVED, APPROACH, markApproach, allowedDirs, REMOVABLE_TYPES,
	weldsMasses, MONSTER_OPTIONS, monsterOptions, scaledAmount, zoneGuardPool, engineGuard, scaledLinkGuard,
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
	if (process.env.VMAPGEN_SRC_TRACE && /^randomMonster/.test(type)) entry.__src = new Error().stack.split('\n').slice(2, 6).map(x => (/at (\S+)/.exec(x) || [])[1]).join('<');
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
 * Whether a template's levels may each be in several pieces joined through the other level. On Coldshadow's
 * Fantasy the engine's surface is four start pieces and a centre that meet only by subterranean gates, and making
 * each level one piece opened borders the template never has (tools/mapsight zones, 2026-10-01).
 * VMAPGEN_LEVEL_LINKS=0 is the old one-piece behaviour.
 */
function splitLevels(p) {
	return process.env.VMAPGEN_LEVEL_LINKS !== '0' && !!(p && p.zonePlan && (p.zonePlan.connections || [])
		.some(c => c.aRef && c.bRef && c.aRef.l !== c.bRef.l));
}

/**
 * The ground a game is played on when a level is in several pieces (splitLevels): every walkable region that holds
 * the most of some zone's open cells, or a player start. mainComponent's one region would leave every other
 * piece's towns, mines and gates with no room.
 */
function zonePieces(W, H, levelIndex, blocked, zone, playerStarts) {
	const base = levelIndex * W * H;
	const label = new Int32Array(W * H).fill(-1);
	const regions = [];
	for (let seed = 0; seed < W * H; seed++) {
		if (label[seed] >= 0 || (blocked[base + seed] & OCCUPIED)) continue;
		const id = regions.length, cells = [seed];
		label[seed] = id;
		for (let k = 0; k < cells.length; k++) {
			const c = cells[k], x = c % W, y = (c / W) | 0;
			for (let dy = -1; dy <= 1; dy++)
				for (let dx = -1; dx <= 1; dx++) {
					const nx = x + dx, ny = y + dy;
					if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
					const n = ny * W + nx;
					if (label[n] >= 0 || (blocked[base + n] & OCCUPIED)) continue;
					label[n] = id;
					cells.push(n);
				}
		}
		regions.push(cells);
	}
	const keep = new Set();
	const most = new Map();   // zone -> [region, count]
	regions.forEach((cells, id) => {
		const per = new Map();
		for (const c of cells) per.set(zone[c], (per.get(zone[c]) || 0) + 1);
		for (const [z, n] of per) if (!most.has(z) || most.get(z)[1] < n) most.set(z, [id, n]);
	});
	for (const [, [id]] of most) keep.add(id);
	for (const s of playerStarts || [])
		for (let dy = -3; dy <= 3; dy++)
			for (let dx = -3; dx <= 3; dx++) {
				const x = s.x + dx, y = s.y + dy;
				if (x >= 0 && y >= 0 && x < W && y < H && label[y * W + x] >= 0) keep.add(label[y * W + x]);
			}
	const out = new Uint8Array(W * H);
	for (const id of keep) for (const c of regions[id]) out[c] = 1;
	return out;
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
		// mines too (the starter mines, placed by now): the engine joins every required object to the free paths, and a
		// start's ore pit sealed behind a guard and scenery had its first ore cost a fight (startkit.js, 2 of 10 seeds,
		// 2026-10-03)
		if (o.type !== 'monolithTwoWay' && o.type !== 'subterraneanGate' && o.type !== 'mine'
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
		const why = { zone: 0, fits: 0, entrance: 0, unreached: 0, connect: 0, welds: 0, cands: 0 };
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
					if (pass === 0 && zone[y * W + x] !== homeBiome) { why.zone++; continue; }
					if (!footprintFits(tpl, x, y, levelIndex, W, H, blocked)) { why.fits++; continue; }
					// A mine wedged between the town and the map edge walls
					// itself in: its own footprint plus the castle plus the
					// border leaves its entrance with nothing beside it. That
					// stranded every starter mine on one seed, four of them,
					// and nothing in the pipeline noticed.
					if (!entranceOpen(tpl, x, y, levelIndex, W, H, blocked, reachable)) { why.entrance++; continue; }
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
					why.cands++;
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
					if (real === Infinity || (strict && real > steps + 4)) { if (!strict) why.unreached++; continue; }
					if (connectivity && !connectivity.accepts(walls)) { if (!strict) why.connect++; continue; }
					if (weldsMasses(walls, blocked, levelIndex, W, H, 2)) { if (!strict) why.welds++; continue; }
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
				+ `player starts without it (cells refused: ${Object.entries(why).map(([k, v]) => `${k} ${v}`).join(', ')})`);
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
			if (process.env.VMAPGEN_DROP_TRACE)
				console.error(`[drop] barrier pass opened (${best % W},${(best / W) | 0}) on level ${levelIndex}, toward (${outside % W},${(outside / W) | 0})`);
			barriers.delete(best);
			removed++;
		}
	}
	return removed;
}

/**
 * The entrance tile of every town, monolith and gate on level l joins the road that reaches it: when a
 * road tile lies beside the entrance (the road planner stops on the ring of open ground round it) the tile
 * itself carries road, and when the nearest road is up to three tiles off, the free tiles between join too.
 * An entrance no road comes near stays as it is. Returns the tiles added.
 */
function gateStubs(plan, towns, l, W, H, blocked) {
	const base = l * W * H, roads = plan.roadCells;
	const ends = [];
	for (const t of towns) for (const g of t.gates || []) ends.push(g);
	for (const o of plan.objects)
		if ((o.l || 0) === l && o.template && /^(subterraneanGate|monolithTwoWay)/.test(o.type))
			for (const g of visitableCells(o.template, o.x, o.y)) ends.push(g);
	let added = 0;
	for (const [gx, gy] of ends) {
		if (gx < 0 || gy < 0 || gx >= W || gy >= H) continue;
		const g = gy * W + gx;
		if (roads.has(g)) continue;
		// the nearest road within three tiles over ground that is not an object's footprint
		const prev = new Map([[g, -1]]);
		const q = [[g, 0]];
		let hit = -1;
		for (let h = 0; h < q.length && hit < 0; h++) {
			const [c, d] = q[h];
			if (d >= 3) continue;
			const x = c % W, y = (c / W) | 0;
			for (let dy = -1; dy <= 1 && hit < 0; dy++)
				for (let dx = -1; dx <= 1; dx++) {
					if (!dx && !dy) continue;
					const nx = x + dx, ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
					const n = ny * W + nx;
					if (prev.has(n)) continue;
					if (roads.has(n)) { prev.set(n, c); hit = n; break; }
					if (blocked[base + n] & OCCUPIED) continue;
					prev.set(n, c);
					q.push([n, d + 1]);
				}
		}
		if (hit < 0) continue;
		for (let c = prev.get(hit); c >= 0; c = prev.get(c)) if (!roads.has(c)) { roads.add(c); added++; }
	}
	return added;
}

/**
 * Roads one tile wide: while any 2x2 block of road remains, one of its tiles goes, if the road tiles round it
 * stay joined without it (so no road is cut and none ends up shorter than its neighbours reach). Returns the
 * tiles dropped.
 */
function thinRoads(roads, W, H) {
	const has = (x, y) => x >= 0 && y >= 0 && x < W && y < H && roads.has(y * W + x);
	const joinedWithout = (x, y) => {
		const nb = [];
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && has(x + dx, y + dy)) nb.push([x + dx, y + dy]);
		if (nb.length < 2) return nb.length === 0 ? false : true;
		// the neighbours, joined to each other through each other (8-way), with this tile left out
		const seen = new Set([nb[0].join()]);
		const q = [nb[0]];
		for (let h = 0; h < q.length; h++)
			for (const n of nb) {
				if (seen.has(n.join())) continue;
				if (Math.max(Math.abs(n[0] - q[h][0]), Math.abs(n[1] - q[h][1])) <= 1) { seen.add(n.join()); q.push(n); }
			}
		return seen.size === nb.length;
	};
	let dropped = 0;
	for (let pass = 0; pass < 8; pass++) {
		let changed = false;
		const cells = [...roads].sort((a, b) => a - b);
		for (const c of cells) {
			const x = c % W, y = (c / W) | 0;
			if (!roads.has(c)) continue;
			let block = false;
			for (const [ox, oy] of [[0, 0], [-1, 0], [0, -1], [-1, -1]])
				if (has(x + ox, y + oy) && has(x + ox + 1, y + oy) && has(x + ox, y + oy + 1) && has(x + ox + 1, y + oy + 1)) block = true;
			if (!block || !joinedWithout(x, y)) continue;
			roads.delete(c);
			dropped++;
			changed = true;
		}
		if (!changed) break;
	}
	return dropped;
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
function openSealedByObjects(objects, W, H, levelIndex, blocked, playerStarts, towns, links = [], water = null, seedAll = false, zoneOf = null) {
	const base = levelIndex * W * H;
	// Nothing standing on a zone border is taken out: a pocket opened through a border wall is a passage between zones
	// the template may never link. With wandering borders (biomes.js zone warp) this pass cut 2 to 7 such holes a map
	// on Coldshadow's Fantasy (2026-10-02). VMAPGEN_BORDER_KEEP=0 lets it take them as before.
	const keepBorder = zoneOf && process.env.VMAPGEN_BORDER_KEEP !== '0';
	const onBorder = c => {
		const x = c % W, y = (c / W) | 0, z = zoneOf[c];
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
			const nx = x + dx, ny = y + dy;
			if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
			const n = zoneOf[ny * W + nx];
			if (n >= 0 && z >= 0 && n !== z) return true;
		}
		return false;
	};
	// Every subterranean gate of the level leads to the other level's network and back, so the zones that hold one are
	// joined to each other that way. Counting the level alone, this pass took scenery out of zone borders to join
	// zones the template only joins through the other level (Coldshadow's Fantasy; tools/mapsight zones found the
	// holes). VMAPGEN_LEVEL_LINKS=0 is the old count.
	if (process.env.VMAPGEN_LEVEL_LINKS !== '0') {
		// a monolith alone on this level in its channel has its pair on the other level: a way down like a gate
		const mono = new Map();
		for (const o of objects) if ((o.l || 0) === levelIndex && o.template && o.type === 'monolithTwoWay') mono.set(o.subtype, (mono.get(o.subtype) || 0) + 1);
		const gates = objects.filter(o => (o.l || 0) === levelIndex && o.template
			&& (/^subterraneanGate/.test(o.type) || (o.type === 'monolithTwoWay' && mono.get(o.subtype) === 1)));
		const around = o => { const out = []; for (const [vx, vy] of visitableCells(o.template, o.x, o.y)) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const x = vx + dx, y = vy + dy; if (x >= 0 && y >= 0 && x < W && y < H) out.push(y * W + x); } return out; };
		if (gates.length > 1) { links = links.slice(); for (let k = 1; k < gates.length; k++) links.push([around(gates[0]), around(gates[k])]); }
	}
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
	// towns too: a neutral town was taken out to open a pocket, and the template zone lost one of its two towns
	// (Coldshadow's Fantasy, 4 of 8 seeds on 2026-10-02, VMAPGEN_DROP_TRACE: "pocket pass removed town")
	const PROTECT = new Set(['subterraneanGate', 'monolithTwoWay', 'borderGuard',
		'questGuard', 'hero', 'randomHero', 'prison', 'boat', 'pandoraBox',
		'grail', 'keymasterTent', 'borderGate', 'town', 'randomTown']);
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
		if (keepBorder && onBorder(c)) return Infinity;
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
			if (process.env.VMAPGEN_DROP_TRACE) {
				const c0 = gates[shut][0], piece = flood(gates[shut]);
				const inPiece = objects.filter(o => (o.l || 0) === levelIndex && o.template && /^(subterraneanGate|monolithTwoWay)/.test(o.type)
					&& visitableCells(o.template, o.x, o.y).some(([vx, vy]) => { for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const k = (vy + dy) * W + vx + dx; if (piece[k]) return true; } return false; }));
				let size = 0; for (let c = 0; c < W * H; c++) size += piece[c];
				console.error(`[drop] start at (${c0 % W},${(c0 / W) | 0}) level ${levelIndex} shut: its piece ${size} cells, ways out ${inPiece.map(o => `${o.type}(${o.x},${o.y})`).join(' ') || 'none'}; ${ways.length} links`);
			}
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
				if (keepBorder && cells.some(onBorder)) continue;
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
	// a network of curved tunnels, the default since 2026-10-01 (splinecave.js); VMAPGEN_CAVE=chambers is the old
	// chamber-and-growth carve below
	if (process.env.VMAPGEN_CAVE !== 'chambers')
		return require('./splinecave').carveSplines(W, H, zone, seeds, edges, connections, p, rng, doors, { doorCells, zoneLineSafe });
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
 * cells came from. hubs: the cells of a crossroads island the sea left apart
 * (water.js hubCells), whose zone keeps the shore ring round the sea with it.
 * Returns {seeds, zone, missing, links, sizeErr, k, tries}; k is -1 for the preset.
 */
/**
 * Zone areas brought to their shares by moving border tiles. The weight balancing in chooseTemplateLayout cannot move a
 * zone its neighbours and the map edge have boxed in, and does not settle: on XL seed 4 every one of the 8 candidate
 * layouts kept a zone 2 to 6 times its share (zone 17 at 9646 tiles against 1696), and more rounds made it worse
 * (VMAPGEN_LAYOUT_TRACE, 2026-10-03). Each sweep hands a border tile from the zone furthest over its share to a
 * neighbour further under, while the tile is not a zone seed or near a start, the giving zone stays in one piece around
 * it, and no template link's shared border gets shorter than it was. Stops when every zone is within a quarter of its share or a
 * sweep moves nothing. VMAPGEN_ZONE_EVEN=0 off. Returns the tiles moved.
 */
function evenZoneAreas(zone, seeds, W, H, water, share, wantedLinks, playerStarts) {
	const N = W * H, n = seeds.length;
	const land = c => zone[c] >= 0 && !(water && water[c]);
	const area = new Array(n).fill(0);
	let total = 0;
	for (let c = 0; c < N; c++) if (land(c)) { area[zone[c]]++; total++; }
	const target = share.map(f => Math.max(1, f * total));
	const keep = new Uint8Array(N);
	for (const q of seeds) for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
		const x = q.x + dx, y = q.y + dy;
		if (x >= 0 && y >= 0 && x < W && y < H) keep[y * W + x] = 1;
	}
	for (const st of playerStarts || []) for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
		const x = st.x + dx, y = st.y + dy;
		if (x >= 0 && y >= 0 && x < W && y < H) keep[y * W + x] = 1;
	}
	// shared border per template link, counted over 4-neighbour pairs
	const key = (a, b) => Math.min(a, b) * 100000 + Math.max(a, b);
	const pair = new Map();
	const D4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
	const RING = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
	for (let c = 0; c < N; c++) {
		if (!land(c)) continue;
		const x = c % W, y = (c / W) | 0;
		for (const [dx, dy] of [[1, 0], [0, 1]]) {
			const u = x + dx, v = y + dy;
			if (u >= W || v >= H) continue;
			const m = v * W + u;
			if (land(m) && zone[m] !== zone[c]) { const k = key(zone[c], zone[m]); pair.set(k, (pair.get(k) || 0) + 1); }
		}
	}
	// a template link's shared border never gets shorter than it was: shrunk to a pair or two, a medium one-level
	// Coldshadow's link 8-16 still counted as shared but had no room for a doorway, got no portal, and zone 8 came out sealed
	const floor = new Map();
	for (const k of wantedLinks) floor.set(k, pair.get(k) || 0);
	// removing c keeps A in one piece around it: A's tiles in c's ring form one run
	const simple = (c, A) => {
		const x = c % W, y = (c / W) | 0;
		const inA = RING.map(([dx, dy]) => { const u = x + dx, v = y + dy; return u >= 0 && v >= 0 && u < W && v < H && zone[v * W + u] === A; });
		let runs = 0;
		for (let i = 0; i < 8; i++) if (inA[i] && !inA[(i + 7) % 8]) runs++;
		if (runs === 0) return false;
		if (runs === 1) return true;
		return false;
	};
	let moved = 0;
	for (let sweep = 0; sweep < 60; sweep++) {
		const r = area.map((a, i) => a / target[i]);
		if (r.every(v => v > 0.8 && v < 1.25)) break;
		let did = 0;
		for (let c = 0; c < N; c++) {
			if (!land(c) || keep[c]) continue;
			const A = zone[c];
			const rA = area[A] / target[A];
			if (rA <= 1) continue;
			const x = c % W, y = (c / W) | 0;
			let B = -1, rB = Infinity;
			for (const [dx, dy] of D4) {
				const u = x + dx, v = y + dy;
				if (u < 0 || v < 0 || u >= W || v >= H) continue;
				const m = v * W + u;
				if (!land(m) || zone[m] === A) continue;
				const rr = area[zone[m]] / target[zone[m]];
				if (rr < rB) { rB = rr; B = zone[m]; }
			}
			if (B < 0 || rA - rB < 0.15) continue;
			// the receiving zone takes only a tile it already touches on two sides or more (its hollows), so it grows
			// smoothly; a tile touched on one side grew tentacles the 4-tile border band then cut off, and the sweep dropped
			// what lay beyond (XL two levels, two players, seed 1: 405 + 371 objects, 2026-10-03)
			let b4 = 0;
			for (const [dx, dy] of D4) { const u = x + dx, v = y + dy; if (u >= 0 && v >= 0 && u < W && v < H && zone[v * W + u] === B) b4++; }
			if (b4 < 2) continue;
			if (!simple(c, A)) continue;
			// the link counts after the move
			const delta = new Map();
			for (const [dx, dy] of D4) {
				const u = x + dx, v = y + dy;
				if (u < 0 || v < 0 || u >= W || v >= H) continue;
				const m = v * W + u;
				if (!land(m)) continue;
				const Z = zone[m];
				if (Z !== A) delta.set(key(A, Z), (delta.get(key(A, Z)) || 0) - 1);
				if (Z !== B) delta.set(key(B, Z), (delta.get(key(B, Z)) || 0) + 1);
			}
			let ok = true;
			for (const [k, d] of delta) if (d < 0 && wantedLinks.has(k) && (pair.get(k) || 0) + d < Math.max(1, floor.get(k) || 0)) { ok = false; break; }
			if (!ok) continue;
			for (const [k, d] of delta) pair.set(k, (pair.get(k) || 0) + d);
			zone[c] = B; area[A]--; area[B]++;
			did++;
		}
		moved += did;
		if (!did) break;
	}
	return moved;
}

/**
 * Every zone one piece (in place): a zone keeps its largest piece (a start zone the piece its seed and town stand on), and each
 * other piece goes to the neighbouring zone it shares the most border with. The engine's zones are never split; ours
 * came out split once the balancing rounds nudged the weights (zonearea.js #N: Coldshadow's Fantasy XL seeds 1, 2, 4,
 * a giant map's underground start in two corners, its whole loot packed into the corner its objects reached,
 * 2026-10-03). Water cells (water) are left as they are. VMAPGEN_ZONE_ONE_PIECE=0 off.
 */
function oneZonePiece(zone, seeds, W, H, water = null) {
	const N = W * H, label = new Int32Array(N).fill(-1);
	const D8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
	for (let round = 0; round < 4; round++) {
		label.fill(-1);
		const pieces = [];
		for (let c0 = 0; c0 < N; c0++) {
			if (label[c0] >= 0 || zone[c0] < 0 || (water && water[c0])) continue;
			const z = zone[c0], cells = [c0];
			label[c0] = pieces.length;
			for (let i = 0; i < cells.length; i++) {
				const c = cells[i], x = c % W, y = (c / W) | 0;
				for (const [dx, dy] of D8) {
					const u = x + dx, v = y + dy;
					if (u < 0 || v < 0 || u >= W || v >= H) continue;
					const m = v * W + u;
					if (label[m] < 0 && zone[m] === z && !(water && water[m])) { label[m] = pieces.length; cells.push(m); }
				}
			}
			pieces.push({ z, cells });
		}
		const keep = new Map();
		for (let i = 0; i < pieces.length; i++) {
			const pz = pieces[i].z, sd = seeds[pz];
			// the largest piece, or a start's own: its town stands on its seed (a seed elsewhere is only a layout point)
			const holdsSeed = sd && sd.player && label[sd.y * W + sd.x] === i;
			const k = keep.get(pz);
			if (k === undefined || holdsSeed || (!keep.seedHeld?.has(pz) && pieces[i].cells.length > pieces[k].cells.length)) {
				keep.set(pz, i);
				if (holdsSeed) { keep.seedHeld = keep.seedHeld || new Set(); keep.seedHeld.add(pz); }
			}
		}
		let moved = 0;
		for (let i = 0; i < pieces.length; i++) {
			const { z, cells } = pieces[i];
			if (keep.get(z) === i) continue;
			const border = new Map();
			for (const c of cells) {
				const x = c % W, y = (c / W) | 0;
				for (const [dx, dy] of D8) {
					const u = x + dx, v = y + dy;
					if (u < 0 || v < 0 || u >= W || v >= H) continue;
					const m = v * W + u, o = zone[m];
					if (o >= 0 && o !== z && !(water && water[m])) border.set(o, (border.get(o) || 0) + 1);
				}
			}
			if (!border.size) continue;
			const to = [...border].sort((p1, p2) => p2[1] - p1[1])[0][0];
			for (const c of cells) zone[c] = to;
			moved += cells.length;
		}
		if (!moved) break;
	}
}

/**
 * Zones grown to their share instead of cut by distance (VMAPGEN_LAYOUT_GROW=1). A warped weighted Voronoi gives a
 * zone every tile nearer its seed than any other, so a zone with no neighbour near it keeps the leftover whatever its
 * weight: Coldshadow's Fantasy's underground zone 8 came out 4622 and 6988 tiles against the engine's 1840-3520
 * (2026-10-04). After the lane-anchored growth in K's deep research (2026-10-04-GeminiDR-Opus-2): each template link
 * is first drawn as a straight lane between its two seeds, each half claimed by the nearer zone, so linked zones touch;
 * then every zone grows from its seed and its lane tiles over a noisy cost field, cheapest first, and a zone that has
 * reached its share of the land stops claiming until every other zone has stopped too. Returns { zone }.
 */
function laneGrowPartition(W, H, seeds, share, wantedLinks, water, rng) {
	const N = W * H, zone = new Int16Array(N).fill(-1), n = seeds.length;
	let land = 0;
	for (let c = 0; c < N; c++) if (!(water && water[c])) land++;
	const target = share.map(s => s * land), area = new Array(n).fill(0);
	// smooth noise on the step cost (cells of about 7 tiles, bilinear), so borders wander as the warp made them
	const G = 7, gw = Math.ceil(W / G) + 2, gh = Math.ceil(H / G) + 2, grid = new Float64Array(gw * gh);
	for (let i = 0; i < grid.length; i++) grid[i] = rng();
	const noise = c => {
		const x = (c % W) / G, y = ((c / W) | 0) / G, x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
		const g = (a, b) => grid[b * gw + a];
		return g(x0, y0) * (1 - fx) * (1 - fy) + g(x0 + 1, y0) * fx * (1 - fy) + g(x0, y0 + 1) * (1 - fx) * fy + g(x0 + 1, y0 + 1) * fx * fy;
	};
	const step = c => 1 + 1.6 * noise(c);
	const heap = [];
	const push = (d, c, i) => { heap.push([d, c, i]); let k = heap.length - 1; while (k) { const q = (k - 1) >> 1; if (heap[q][0] <= heap[k][0]) break; [heap[q], heap[k]] = [heap[k], heap[q]]; k = q; } };
	const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let k = 0; for (;;) { const a = 2 * k + 1, b = a + 1; let m = k; if (a < heap.length && heap[a][0] < heap[m][0]) m = a; if (b < heap.length && heap[b][0] < heap[m][0]) m = b; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };
	const sx = i => Math.max(0, Math.min(W - 1, Math.round(seeds[i].x))), sy = i => Math.max(0, Math.min(H - 1, Math.round(seeds[i].y)));
	// the lanes: a straight line between linked seeds, each tile to the nearer seed (VMAPGEN_LAYOUT_GROW_LANES=0 off)
	for (const key of process.env.VMAPGEN_LAYOUT_GROW_LANES === '0' ? [] : wantedLinks) {
		const a = Math.floor(key / 100000), b = key % 100000;
		if (a >= n || b >= n) continue;
		const ax = sx(a), ay = sy(a), bx = sx(b), by = sy(b), len = Math.max(Math.abs(bx - ax), Math.abs(by - ay)) || 1;
		for (let t = 0; t <= len; t++) {
			const x = Math.round(ax + (bx - ax) * t / len), y = Math.round(ay + (by - ay) * t / len), c = y * W + x;
			push(0, c, t * 2 <= len ? a : b);
		}
	}
	for (let i = 0; i < n; i++) push(0, sy(i) * W + sx(i), i);
	// VMAPGEN_LAYOUT_GROW=2: the zones take turns by how full they are, the emptiest claiming its cheapest frontier tile,
	// so a junction pinned at the edge stakes its ground as fast, in proportion, as the start zones beside it
	if (process.env.VMAPGEN_LAYOUT_GROW === '2') {
		const fr = Array.from({ length: n }, () => []);
		const fpush = (h, d, c) => { h.push([d, c]); let k = h.length - 1; while (k) { const q = (k - 1) >> 1; if (h[q][0] <= h[k][0]) break; [h[q], h[k]] = [h[k], h[q]]; k = q; } };
		const fpop = h => { const top = h[0], last = h.pop(); if (h.length) { h[0] = last; let k = 0; for (;;) { const a = 2 * k + 1, b = a + 1; let m = k; if (a < h.length && h[a][0] < h[m][0]) m = a; if (b < h.length && h[b][0] < h[m][0]) m = b; if (m === k) break; [h[m], h[k]] = [h[k], h[m]]; k = m; } } return top; };
		for (const [d, c, i] of heap) fpush(fr[i], d, c);
		// compactness: a zone whose cheapest next tile lies past 1.8 of its natural radius from its seed sits out until the
		// end (seed 4's zones 17 and 18 grew into strips wrapping round the others); what is left goes by nearness after
		const radius = target.map(t => Math.sqrt(Math.max(1, t) / Math.PI)), far = process.env.VMAPGEN_LAYOUT_GROW_COMPACT === '0' ? Infinity : Number(process.env.VMAPGEN_LAYOUT_GROW_FAR || 1.8);
		let open = true;
		for (;;) {
			let best = -1, bf = Infinity;
			for (let i = 0; i < n; i++) {
				while (fr[i].length && zone[fr[i][0][1]] >= 0) fpop(fr[i]);
				if (!fr[i].length) continue;
				if (open) { const c0 = fr[i][0][1]; if (Math.hypot(c0 % W - sx(i), ((c0 / W) | 0) - sy(i)) > far * radius[i]) continue; }
				const f = area[i] / Math.max(1, target[i]);
				if (f < bf) { bf = f; best = i; }
			}
			if (best < 0) { if (open) { open = false; continue; } break; }
			const [d, c] = fpop(fr[best]);
			zone[c] = best;
			if (!(water && water[c])) area[best]++;
			const x = c % W, y = (c / W) | 0;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				if (!dx && !dy) continue;
				const u = x + dx, v = y + dy;
				if (u < 0 || v < 0 || u >= W || v >= H) continue;
				const m = v * W + u;
				if (zone[m] < 0) fpush(fr[best], d + step(m) * (dx && dy ? 1.414 : 1), m);
			}
		}
		for (let c = 0; c < N; c++) if (zone[c] < 0) zone[c] = 0;   // nothing should be left; a stray goes to zone 0 and oneZonePiece repairs
		return { zone };
	}
	const BIG = 1e7;
	while (heap.length) {
		const [d, c, i] = pop();
		if (zone[c] >= 0) continue;
		// a zone at its share gives way: the tile waits until no zone still short of its share reaches it
		if (d < BIG && area[i] >= target[i]) { push(d + BIG, c, i); continue; }
		zone[c] = i;
		if (!(water && water[c])) area[i]++;
		const x = c % W, y = (c / W) | 0;
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
			if (!dx && !dy) continue;
			const u = x + dx, v = y + dy;
			if (u < 0 || v < 0 || u >= W || v >= H) continue;
			const m = v * W + u;
			if (zone[m] >= 0) continue;
			// a zone further from its share advances faster (the report's capacity speed), so a small zone is not boxed in
			const fill = Math.min(1.5, area[i] / Math.max(1, target[i]));
			push(d + step(m) * (dx && dy ? 1.414 : 1) * (0.3 + fill), m, i);
		}
	}
	return { zone };
}

function chooseTemplateLayout({ tplZones, tplConns, W, H, playerStarts, water = null, seed = 1,
	levelIndex = 0, p, tries: triesIn, preset = null, anchors = null, hubs = null, balance = true }) {
	// Biome size on a template (K, 2026-10-05: every lever acts on every template; it read the free layout only): the zones are the template's,
	// so the setting moves land between them. 400 cells a biome is the template's own sizes; bigger biomes give the neutral zones more of the land
	// and the starts less, smaller the other way, each non-start zone's size weight scaled by the square root of the ratio, 0.6 to 1.8.
	{
		const q = p && Number.isFinite(Number(p.zoneCells)) ? Number(p.zoneCells) / 400 : 1;
		if (Math.abs(q - 1) > 1e-9) {
			const f = Math.max(0.6, Math.min(1.8, Math.sqrt(q)));
			tplZones = tplZones.map(z => (z.type === 'playerStart' || z.type === 'cpuStart' ? z : { ...z, size: (z.size || 10) * f }));
		}
	}
	const weights = tplZones.map(z => Math.max(1, z.size || 10));
	// each zone's share of its level: the engine's follow the template size to about the 0.8th power (Coldshadow's
	// Fantasy: size-30 zones 11 to 14% of their level, size-15 zones 6 to 9%, 12 engine seeds, 2026-10-02); the square,
	// used to pick among layouts, overshot the big zones. The 0.8 target is the balancing's (below, off by default);
	// picking layouts by it failed the Jebus Cross water tests (the crossroads castle pushed 28 tiles off centre, a start
	// cut off from the crossroads island), so the pick keeps the square. VMAPGEN_ZONE_SHARE_EXP sets the pick's power,
	// VMAPGEN_ZONE_BALANCE_EXP the balancing's.
	const shareOf = e => weights.map(s => s ** e / weights.reduce((a, v) => a + v ** e, 0));
	const want = shareOf(Number(process.env.VMAPGEN_ZONE_SHARE_EXP || 2));
	const wantBal = shareOf(Number(process.env.VMAPGEN_ZONE_BALANCE_EXP || 0.8));
	const wantedLinks = new Set(tplConns.filter(isLandLink).map(c => Math.min(c.a, c.b) * 100000 + Math.max(c.a, c.b)));
	const layoutConns = tplConns.filter(c => c.type !== 'repulsive' && c.type !== 'forcePortal');
	const repulse = tplConns.filter(c => c.type === 'repulsive').map(c => [c.a, c.b]);
	const tries = triesIn || Math.max(1, Math.round(Number(process.env.VMAPGEN_LAYOUT_TRIES) || 8));
	// a layout with pinned zones (surfaceCluster, MapGen Dev's islands) is never the preset: the preset ignores pins
	const usePreset = preset && preset.length === tplZones.length && !(anchors && anchors.some(a => a && a.pin));
	let best = null;
	// up to twice the tries while the best layout still loses a start, starves a zone or misses a link: K's 252 eight-player seed
	// 620090276 with the stretch pick laid its underground from new anchors, and none of the eight candidates kept every link (two
	// missing). VMAPGEN_LAYOUT_EXTRA=0 stops at the tries.
	const extra = process.env.VMAPGEN_LAYOUT_EXTRA === '0' ? tries : 2 * tries;
	let ran = 0;
	for (let k = usePreset ? -1 : 0; k < tries || (k < extra && best && (best.lost || best.starved || best.missing)); k++) {
		ran = Math.max(ran, k + 1);
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
		// the surface's borders wander more than the underground's (mapsight shape against Coldshadow's Fantasy:
		// surface 1.7 brings zone ragged and compactness inside the engine's range, below 1.0 does)
		const warpHere = p.zoneWarp ?? (levelIndex ? Number(process.env.VMAPGEN_ZONE_WARP_BELOW || 1)
			// tuned with 11 zones on the level; 21 on one level (a one-level Coldshadow's Fantasy) came out too contorted, and
			// with the square root of 12/zones (1.29 at 21) seed 4 crushed zones 14 and 15 to 0.2 and 0.5% of the map, their towns
			// and mines with no room; 12/zones (0.97) did too; (12/zones)^1.5 (0.73) kept every zone on seeds 1 to 4. Before that
			// (compactness 2.2 against the engine's 1.1 to 1.9) and towns found no room in the thin zones
			: Number(process.env.VMAPGEN_ZONE_WARP_SURFACE || 1.7) * Math.min(1, (12 / Math.max(1, s.length)) ** 1.5));
		// Each zone's share of the level's land brought toward its template share: a few rounds, each weight nudged by
		// how far its zone's area is from its share. Coldshadow's Fantasy came out with zones from 0.59 to 1.67 of the
		// engine's areas, and their contents followed (2026-10-02). On by default since 2026-10-03 (VMAPGEN_ZONE_BALANCE=0 off), to size^0.8 shares: Coldshadow's treasure zones came out 10 to 2125 tiles
		// a seed without it, 816 to 2475 with it (the engine's 943 to 2650). Before, balanced to
		// size-squared shares it grew the start zones to 1.25-1.71 of the engine's; the engine's areas follow size, not its
		// square. Retarget before turning it on.
		// The warp noise is drawn from its own stream, so every round warps the same way.
		const wts = weights.slice();
		let z = null;
		// a layout made only to be compared with another (the water judge, the start arrangements) is not balanced
		const rounds = balance && !(p && p.layoutOnly) && process.env.VMAPGEN_ZONE_BALANCE !== '0' ? Number(process.env.VMAPGEN_ZONE_BALANCE_ROUNDS || 6) : 1;
		const lrngCopy = xorshift(((seed * 2654435761) + levelIndex * 97 + k * 7919 + 13 + 104729) >>> 0);
		const warpSeed = (lrngCopy() * 1e9) | 0;
		for (let round = 0; round < rounds; round++) {
			const rr = xorshift(warpSeed >>> 0);
			if (process.env.VMAPGEN_LAYOUT_GROW === '1' || process.env.VMAPGEN_LAYOUT_GROW === '2') {
				({ zone: z } = laneGrowPartition(W, H, s, wantBal, wantedLinks, water, rr));
				if (process.env.VMAPGEN_ZONE_ONE_PIECE !== '0') oneZonePiece(z, s, W, H, water);
				break;
			}
			({ zone: z } = partitionSeeded(W, H, s, wts, rr, { ...p, zoneWarp: warpHere })); if (process.env.VMAPGEN_ZONE_ONE_PIECE !== '0') oneZonePiece(z, s, W, H, water);
			if (round === rounds - 1) break;
			const ar = new Array(s.length).fill(0);
			let landA = 0;
			for (let c = 0; c < W * H; c++) if (z[c] >= 0 && !(water && water[c])) { ar[z[c]]++; landA++; }
			let worst = 0;
			for (let i = 0; i < s.length; i++) {
				const target = wantBal[i] * landA;
				if (!(ar[i] > 0) || !(target > 0)) continue;
				const r = target / ar[i];
				worst = Math.max(worst, Math.abs(Math.log(r)));
				wts[i] *= Math.max(0.6, Math.min(1.6, Math.pow(r, 0.8)));
			}
			if (worst < 0.08) break;
		}
		if (water) settleZonesOnLand(z, s, W, H, water, hubs);
		if (process.env.VMAPGEN_ZONE_ONE_PIECE !== '0') oneZonePiece(z, s, W, H, water);
		// only where zones are big enough to give tiles away: on a medium one-level Coldshadow (21 zones, about 250 tiles
		// each) the moves left thin strips the 4-tile border band filled, a zone was cut in two, the sweep dropped the
		// portals behind the cut and 362 objects with them, 20 towns among them (K's 72x72 seed 1805021841, "huge step
		// backwards", 2026-10-03). VMAPGEN_ZONE_EVEN_MIN tiles a zone on average (500).
		// OFF by default since 2026-10-03 23:50 (VMAPGEN_ZONE_EVEN=1 on): on XL two levels with two players it grew tentacles
		// that cascaded the same way (seed 1: 405 + 371 objects dropped); oversized zones are the lesser fault.
		const meanZone = (W * H - (water ? water.reduce((m, v) => m + (v ? 1 : 0), 0) : 0)) / Math.max(1, s.length);
		// a zone left with no land (islands laid before the zones: several seeds settle on one island and a zone is crushed
		// to nothing, 2 to 3 zones on every candidate of a one-level islands Coldshadow, seed 7204) gets a seed patch on the
		// nearest land first, so the repair below can grow it (reviveZones)
		if (water && process.env.VMAPGEN_ZONE_REVIVE !== '0') reviveZones(z, s, W, H, water, wantBal);
		if (rounds > 1 && process.env.VMAPGEN_ZONE_EVEN === '1' && meanZone >= Number(process.env.VMAPGEN_ZONE_EVEN_MIN || 500))
			evenZoneAreas(z, s, W, H, water, wantBal, wantedLinks, playerStarts);
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
		// balanced layouts are picked against the balancing's own target (size^0.8); unbalanced ones against the square
		// (the Jebus Cross water tests failed when an unbalanced pick used 0.8)
		const wantPick = rounds > 1 ? wantBal : want;
		const sizeErr = area.reduce((e, a, i) => e + Math.abs(a / (land || 1) - wantPick[i]), 0);
		// a zone under half its share is starved, and ranks before a missing link: on a 36x36 two-player Coldshadow a
		// layout with every link kept gave red's start 118 tiles and blue's 632, and red had no room for its second town,
		// sawmill or ore pit (2026-10-03)
		// (and one over twice its share is bloated; XL seed 4's zone 8 at 6988 tiles grows after the layout, not in it:
		// a 1.6 limit left it as it was and made seed 1 worse)
		const starved = area.reduce((n, a, i) => n + (a < 0.5 * (land || 1) * wantPick[i] || a > 2 * (land || 1) * wantPick[i] ? 1 : 0), 0);
		// a zone with no tiles at all is lost as surely as a start outside its zone: medium one-level seed 5 kept a layout
		// with zone 16 at 0 tiles over one that kept every zone, on a size error of 0.114 against 0.116, and zone 8, whose one
		// link was to zone 16, came out sealed
		// and so is one left a sliver: on islands every candidate starves a zone, and the one with the fewest starved kept
		// zone 9 at 13 of its 443 tiles (144 one-level islands, seeds 4 to 6, MapGen Dev 2026-10-04: K's zone 14 at 17 tiles,
		// the loot-bare middle with no room for its dragon dwelling). Under a tenth of its share counts as lost.
		lost += area.reduce((n, a, i) => n + (a === 0 || a < 0.1 * (land || 1) * wantPick[i] ? 1 : 0), 0);
		// the size error plus STRETCH_WEIGHT for each zone's reach past STRETCH_OK (layoutStretch): K's 252 eight-player seed
		// 620090276 kept a layout at 0.058 error with zones 2, 5, 7 and the centre zone 16 reaching 2.1 to 3.5 radii from their
		// seeds over one at 0.075 with every zone but 7 at 2.1 or less. VMAPGEN_STRETCH_WEIGHT=0 is the size error alone.
		const stretch = layoutStretch(z, s, W, H, area);
		const shapeErr = sizeErr + STRETCH_WEIGHT * stretch.over;
		if (!best || lost < best.lost || (lost === best.lost && (starved < best.starved || (starved === best.starved
				&& (missing < best.missing || (missing === best.missing && shapeErr < best.shapeErr - 1e-9))))))
			best = { seeds: s, zone: z, missing, sizeErr, shapeErr, k, lost, starved };
		if (process.env.VMAPGEN_LAYOUT_TRACE) console.error(`[layout] L${levelIndex} k${k} lost ${lost} starved ${starved} missing ${missing} err ${sizeErr.toFixed(3)} stretch ${stretch.over.toFixed(2)} | ` + tplZones.map((zs, i) => `${zs.id}:${area[i]}/${Math.round((land || 1) * wantPick[i])}s${stretch.per[i].toFixed(1)}`).join(' '));
		// the preset (the free layout the starts came from) ends the search only if no zone is off its share by over 2x:
		// taken on links alone it left Coldshadow's central zone 21 a quarter of its size on a seed (2026-10-03)
		const worst = area.reduce((w, a, i) => Math.max(w, Math.abs(Math.log(Math.max(1, a) / Math.max(1, (land || 1) * wantPick[i])))), 0);
		if (!missing && !lost && !starved && k < 0 && worst < Math.log(2)) break;
	}
	if (process.env.VMAPGEN_LAYOUT_TRACE && anchors) console.error('[layout] pinned: ' + tplZones.map((zs, i) => anchors[i] && anchors[i].pin ? `${zs.id} anchor ${anchors[i].x},${anchors[i].y} seed ${best.seeds[i].x},${best.seeds[i].y}` : null).filter(Boolean).join(' | '));
	return { ...best, links: wantedLinks.size, tries: Math.max(tries, ran) };
}

/**
 * How far each zone reaches from its seed: the farthest cell of the zone in 8-way steps over the zone, over the radius of a disc
 * of the zone's area (1 is a round zone around its seed). over sums each zone's excess past STRETCH_OK. K, 2026-10-04, on a 252
 * eight-player Coldshadow: "this biome stretches into the middle like a peepee, poor guy's second town is put in the spotlight"
 * (zone 2 from the top edge to the centre, 1.5 to 2.5 against the engine's 1.1 to 1.7 on its 252 maps).
 */
const STRETCH_OK = Number(process.env.VMAPGEN_STRETCH_OK || 1.8);
const STRETCH_WEIGHT = process.env.VMAPGEN_STRETCH_WEIGHT !== undefined ? Number(process.env.VMAPGEN_STRETCH_WEIGHT) : 0.02;
function layoutStretch(z, s, W, H, area) {
	const per = new Array(s.length).fill(0);
	const d = new Int32Array(W * H);
	for (let i = 0; i < s.length; i++) {
		if (!area[i]) continue;
		let c0 = s[i].y * W + s[i].x;
		if (z[c0] !== i) { // a seed off its zone (moved onto land, or cut off): start from the zone's first cell
			c0 = -1;
			for (let c = 0; c < W * H; c++) if (z[c] === i) { c0 = c; break; }
		}
		d.fill(-1);
		const q = [c0];
		d[c0] = 0;
		let far = 0;
		for (let h = 0; h < q.length; h++) {
			const c = q[h], x = c % W, y = (c / W) | 0;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				const u = x + dx, v = y + dy;
				if (u < 0 || v < 0 || u >= W || v >= H) continue;
				const m = v * W + u;
				if (z[m] !== i || d[m] >= 0) continue;
				d[m] = d[c] + 1;
				if (d[m] > far) far = d[m];
				q.push(m);
			}
		}
		per[i] = far / Math.sqrt(area[i] / Math.PI);
	}
	return { per, over: per.reduce((t, v) => t + Math.max(0, v - STRETCH_OK), 0) };
}

/**
 * Whether a town anchored at (x, y) stands wholly in zone b: every cell it
 * blocks and the ground before its gate inside the zone and off the zone's
 * walls (barriers), two cells clear of the map's edge, on free ground, with
 * its gate open. The engine's own test is the same in substance: the object
 * inside the zone's free area, its way in overlapping it
 * (ObjectManager::findPlaceForObject).
 */
function townFitsZone(zone, b, x, y, W, H, levelIndex, blocked, barriers, band = false) {
	const tpl = OBJECT_TEMPLATES.randomTown;
	// band: the town may stand on the border band's inner cells, never on the zone line itself (a cell beside another zone)
	const onLine = c => {
		const cx = c % W, cy = (c / W) | 0;
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
			const u = cx + dx, v = cy + dy;
			if (u >= 0 && v >= 0 && u < W && v < H && zone[v * W + u] !== b) return true;
		}
		return false;
	};
	const inZone = c => zone[c] === b && !(barriers && barriers.has(c) && (!band || onLine(c)));
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
/**
 * Steps from each tile to the nearest tile of another zone (8-connected, capped at 8): the far-from-objects rule for
 * gates and monoliths drifted to zone rims, where the rim walls later closed a gate's way in, and a whole zone reached
 * through it was swept away (Coldshadow's Fantasy seed 4 with zone balancing, zone 5, 2026-10-02). The engine never
 * offers border tiles (its possible area stops short of them).
 */
function rimDistance(zone, W, H) {
	const d = new Uint8Array(W * H).fill(8), q = [];
	for (let c = 0; c < W * H; c++) {
		const x = c % W, y = (c / W) | 0;
		for (let dy = -1; dy <= 1 && d[c]; dy++) for (let dx = -1; dx <= 1; dx++) {
			const nx = x + dx, ny = y + dy;
			if (nx < 0 || ny < 0 || nx >= W || ny >= H || zone[ny * W + nx] !== zone[c]) { d[c] = 0; q.push(c); break; }
		}
	}
	for (let h = 0; h < q.length; h++) {
		const c = q[h], x = c % W, y = (c / W) | 0;
		if (d[c] >= 7) continue;
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
			const nx = x + dx, ny = y + dy;
			if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
			const m = ny * W + nx;
			if (d[m] > d[c] + 1) { d[m] = d[c] + 1; q.push(m); }
		}
	}
	return d;
}

/**
 * The start's cell in a zone that holds a second town: the centre spot (`at`) when some fitting spot of the zone lies TOWN_WALK walking tiles from
 * its door, else the fitting cell nearest the centre that leaves one (up to 300 tried); null when none does, and the start keeps the centre.
 */
const START_MOVE = 4;
function startForSpacing(zone, b, W, H, levelIndex, blocked, water, barriers, at) {
	const base = levelIndex * W * H, N = W * H, tpl = OBJECT_TEMPLATES.randomTown;
	// the walk crosses into other zones as the spot pass's does (townWalk): a way round through the next zone is still a way
	const walkable = c => !(blocked[base + c] & OCCUPIED) && !(water && water[c]);
	const door = (x, y) => { const v = visitableCells(tpl, x, y)[0]; return v ? v[1] * W + v[0] : -1; };
	const fits = [];
	// the town spots' own edge rule too (the whole picture on the map: anchor 5 rows and columns in)
	const inX = Math.max(5, Math.max(...tpl.mask.map(r => r.length)) - 1), inY = Math.max(5, tpl.mask.length - 1);
	for (const c of cellsByCentre(zone, b, W, H, water))
		if ((c / W | 0) >= inY && c % W >= inX && townFitsZone(zone, b, c % W, (c / W) | 0, W, H, levelIndex, blocked, barriers)) fits.push(c);
	const leavesRoom = c => {
		const x = c % W, y = (c / W) | 0, body = new Set(blockingCells(tpl, x, y).map(([a, b2]) => b2 * W + a));
		const d0 = door(x, y), dist = new Int32Array(N).fill(-1), q = [];
		if (d0 < 0) return false;
		dist[d0] = 0; q.push(d0);
		for (let h = 0; h < q.length; h++) {
			const k = q[h], kx = k % W, ky = (k / W) | 0;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				const nx = kx + dx, ny = ky + dy, m = ny * W + nx;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H || dist[m] >= 0 || !walkable(m) || body.has(m)) continue;
				dist[m] = dist[k] + 1; q.push(m);
			}
		}
		// a partner: a fitting spot whose door is TOWN_WALK steps off, or on ground this town's door does not reach at all, and whose
		// footprint keeps off this town's
		for (const f of fits) {
			const fd = door(f % W, (f / W) | 0);
			if (fd < 0 || (dist[fd] >= 0 && dist[fd] < TOWN_WALK)) continue;
			if (blockingCells(tpl, f % W, (f / W) | 0).some(([a, b2]) => body.has(b2 * W + a))) continue;
			if (dist[fd] < 0 && !q.length) continue;
			return true;
		}
		return false;
	};
	const c0 = at.y * W + at.x;
	if (leavesRoom(c0)) return at;
	let tries = 0;
	for (const c of fits) {
		if (c === c0) continue;
		// the start moves START_MOVE tiles at most: moved 6 off its centre on a 72x72 for four, it left a treasure zone beside it empty (one monster
		// in 190 tiles, the grid's mapsight check, 2026-10-09); farther, the pair keeps the widest gap the zone holds (the lead's option a)
		if (Math.max(Math.abs(c % W - at.x), Math.abs(((c / W) | 0) - at.y)) > START_MOVE) continue;
		if (leavesRoom(c)) return { x: c % W, y: (c / W) | 0 };
		if (++tries >= 300) break;
	}
	return null;
}

function townNearCentre(zone, b, W, H, levelIndex, blocked, water, barriers) {
	// A town that plugs a neck of its zone cuts the zone in two: in a carved cave the centre of mass can fall in a
	// tunnel the town fills from wall to wall, and everything past it was later dropped as unreachable (Coldshadow's
	// Fantasy 144 for eight, seed 1001: purple's whole zone but 326 tiles, 2026-10-02). The town goes on the first fit
	// whose gate still reaches nine tenths of the zone's open ground; when none does, on the first fit.
	const base = levelIndex * W * H;
	const open = c => zone[c] === b && !(blocked[base + c] & OCCUPIED) && !(water && water[c]) && !(barriers && barriers.has(c));
	let total = 0;
	for (let c = 0; c < W * H; c++) if (open(c)) total++;
	const tpl = OBJECT_TEMPLATES.randomTown;
	const keepsWhole = (x, y) => {
		const body = new Set(blockingCells(tpl, x, y).map(([a, b2]) => b2 * W + a));
		const seen = new Uint8Array(W * H), st = [];
		for (const [vx, vy] of visitableCells(tpl, x, y))
			for (const [dx, dy] of allowedDirs(tpl)) {
				const nx = vx + dx, ny = vy + dy, c = ny * W + nx;
				if (nx >= 0 && ny >= 0 && nx < W && ny < H && open(c) && !body.has(c) && !seen[c]) { seen[c] = 1; st.push(c); }
			}
		let n = 0;
		while (st.length) {
			const k = st.pop(), kx = k % W, ky = (k / W) | 0;
			n++;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				const nx = kx + dx, ny = ky + dy, m = ny * W + nx;
				if (nx >= 0 && ny >= 0 && nx < W && ny < H && !seen[m] && open(m) && !body.has(m)) { seen[m] = 1; st.push(m); }
			}
		}
		return n + body.size >= 0.9 * total;
	};
	let first = null, tries = 0;
	for (const c of cellsByCentre(zone, b, W, H, water)) {
		const x = c % W, y = (c / W) | 0;
		if (!townFitsZone(zone, b, x, y, W, H, levelIndex, blocked, barriers)) continue;
		if (!first) first = { x, y };
		if (process.env.VMAPGEN_TOWN_WHOLE === '0' || keepsWhole(x, y)) return { x, y };
		if (++tries >= 400) break;
	}
	return first;
}

/**
 * A fixed template's own neutralTowns counts, scaled by the player's Neutral
 * town biomes setting (K, 2026-09-28: Jebus Cross at townRatio 0 still
 * placed its authored 2, the slider silently ignored for every fixed
 * template - the same principle as C1, a setting never goes silently
 * overridden). Scaled against the slider's own default so a template's
 * calibrated count is unchanged at the default and responds either way past it.
 */
function neutralTownScale(p) {
	return p.townRatio / BIOME_DEFAULTS.townRatio;
}

function scaledNeutralTowns(z, p) {
	const nt = z.neutralTowns || {};
	const scale = neutralTownScale(p);
	return { castles: Math.round((nt.castles || 0) * scale), towns: Math.round((nt.towns || 0) * scale) };
}

/**
 * The neutral towns a map smaller than the template's own smallest keeps, zone id -> how many of its neutral town
 * wishes stay (castles before towns). The engine never builds such a map; ours kept every town the template names,
 * so a 72x72 one-level Coldshadow's Fantasy held 25 towns, 4.82 per 1000 tiles against the engine's 0.60 at 144 two
 * levels, and a start rode to 6-12 of them by day 2 against the engine's 2-3 (K, 2026-10-04: "i got a SEVERELY
 * advantaged spawn with like 4 castles in 2-day's ride. we need slightly more balance in place"). The neutral towns
 * outside the seated starts scale by the area shortfall itself: the engine's own templates made at 36 to 108 hold
 * 0.69-2.31 towns per 1000 tiles, which this lands in (72 one level about 1.35, 108 one level 0.9, 36 two levels 2.1);
 * the square root (the rich piles' and link guards' rule) left 72 one level at 1.93. The stand-in towns of start zones
 * with no player go first, then the rest one zone at a time, the zone with most left first. A seated start's zone
 * keeps every town, and a zone's loot is untouched. Returns null when nothing changes. VMAPGEN_TOWN_SCALE=0 off.
 */
function keptNeutralTowns(p, playerStarts, W, H) {
	if (process.env.VMAPGEN_TOWN_SCALE === '0' || !p.zonePlan || !p.zonePlan.minTiles) return null;
	const levels = (p.zonePlan.perLevel || [[]]);
	const f = W * H * levels.length / p.zonePlan.minTiles;
	if (f >= 1) return null;
	const zones = levels.flat().filter(z => !(z.owner && startOfOwner(playerStarts, z.owner)))
		.sort((a, b) => Number(a.id) - Number(b.id));
	const scale = neutralTownScale(p);
	const wishes = [];       // [zone id, castle?, stand-in?]
	for (const z of zones) {
		const seated = false;
		const pt = z.playerTowns || {}, nt = scaledNeutralTowns(z, p);
		const n = [];
		if (!seated) {
			for (let k = Math.round((pt.castles || 0) * scale); k > 0; k--) n.push([z.id, true, true]);
			for (let k = Math.round((pt.towns || 0) * scale); k > 0; k--) n.push([z.id, false, true]);
		}
		for (let k = nt.castles || 0; k > 0; k--) n.push([z.id, true, false]);
		for (let k = nt.towns || 0; k > 0; k--) n.push([z.id, false, false]);
		wishes.push(...n);
	}
	let drop = wishes.length - Math.max(0, Math.round(wishes.length * f));
	const keep = new Map(zones.map(z => [z.id, wishes.filter(w => w[0] === z.id).length]));
	// stand-ins first, then one town a zone at a time over the rest, the zone with most left first
	for (const w of wishes.filter(w => w[2])) if (drop > 0) { keep.set(w[0], keep.get(w[0]) - 1); drop--; }
	while (drop > 0) {
		const z = [...keep].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]))[0];
		if (!z) break;
		keep.set(z[0], z[1] - 1); drop--;
	}
	return keep;
}

/**
 * The mines a map smaller than the template's own smallest keeps, zone id -> { resource: count }, for zones outside
 * the seated starts (those keep every mine, their starter sawmill and ore pit included). Same rule and same reason as
 * keptNeutralTowns: Coldshadow's Fantasy kept all its mines on a 72x72 map, and with guards ignored one start owned
 * 20-80 more by day 5 (tools/geometry/travelweb.js, 2026-10-04). They scale by the area ratio; one mine at a time goes
 * from the zone with most left, its most plentiful resource first, so a zone keeps its variety. Returns null when
 * nothing changes. VMAPGEN_MINE_SCALE=0 off.
 */
/** VMAPGEN_LEAK_AT="x,y;x,y" (level VMAPGEN_LEAK_L, 0): at each checkpoint, whether those tiles are blocked, barrier,
 * and what stands there; for tracing which pass opens a wall between zones. */
function leakTrace(label, blocked, W, H, l, objects, barriers) {
	const at = process.env.VMAPGEN_LEAK_AT;
	if (!at || l !== Number(process.env.VMAPGEN_LEAK_L || 0)) return;
	const out = at.split(';').map(s => s.split(',').map(Number)).map(([x, y]) => {
		const c = y * W + x;
		const occ = blocked ? ((blocked[l * W * H + c] & OCCUPIED) ? 'occ' : 'free') : '?';
		const objs = (objects || []).filter(o => (o.l || 0) === l && o.template && o.template.mask
			&& blockingCells(o.template, o.x, o.y).some(([fx, fy]) => fx === x && fy === y)).map(o => o.type).join('+');
		return `${x},${y} ${occ}${barriers && barriers.has(c) ? ' barrier' : ''}${objs ? ' ' + objs : ''}`;
	});
	console.error(`[leak] L${l} ${label}: ${out.join(' | ')}`);
}

const MINE_DROP_ORDER = ['wood', 'ore', 'mercury', 'sulfur', 'crystal', 'gems', 'gold'];
/**
 * The Mines slider on a template map: its mines per zone (already scaled to the map's size by keptMines) times the slider, 1x being
 * the template's own count, so the slider adjusts around the default for the template and size, as the Neutral town slider does
 * (neutralTownScale). The fraction left over carries to the next resource of the zone, so 0.5x halves a zone's mines and does not
 * round every single mine up. VMAPGEN_MINE_SLIDER=0 leaves the template's count.
 */
function scaledMines(mines, density) {
	const d = Number(density);
	if (!mines || !Number.isFinite(d) || d === 1 || process.env.VMAPGEN_MINE_SLIDER === '0') return mines;
	const out = {};
	let carry = 0;
	for (const [res, n] of Object.entries(mines)) {
		const want = (n || 0) * d + carry;
		const k = Math.max(0, Math.floor(want + 1e-9));
		carry = want - k;
		out[res] = k;
	}
	return out;
}
function keptMines(p, playerStarts, W, H) {
	if (process.env.VMAPGEN_MINE_SCALE === '0' || !p.zonePlan || !p.zonePlan.minTiles) return null;
	const levels = (p.zonePlan.perLevel || [[]]);
	const f = W * H * levels.length / p.zonePlan.minTiles;
	if (f >= 1) return null;
	const zones = levels.flat().filter(z => !(z.owner && startOfOwner(playerStarts, z.owner)))
		.sort((a, b) => Number(a.id) - Number(b.id));
	const keep = new Map(zones.map(z => [z.id, { ...(z.mines || {}) }]));
	const total = [...keep.values()].reduce((a, m) => a + Object.values(m).reduce((b, n) => b + (n || 0), 0), 0);
	let drop = total - Math.round(total * f);
	const left = m => Object.values(m).reduce((b, n) => b + (n || 0), 0);
	while (drop > 0) {
		const z = [...keep].filter(([, m]) => left(m) > 0).sort((a, b) => left(b[1]) - left(a[1]) || Number(a[0]) - Number(b[0]))[0];
		if (!z) break;
		const m = z[1];
		const res = Object.keys(m).filter(r => m[r] > 0)
			.sort((a, b) => m[b] - m[a] || MINE_DROP_ORDER.indexOf(a) - MINE_DROP_ORDER.indexOf(b))[0];
		m[res]--; drop--;
	}
	return keep;
}

function planLevel({ W, H, levelIndex, playerStarts, alignPlayers, towns,
	params, terrainShortIds, tileIdsByShort, numTiles, blocked, underground,
	objectPools, terrainInfo }) {
	setPhaseLevel(levelIndex);
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
			preset: p.zonePlan.presetSeeds && p.zonePlan.presetSeeds[levelIndex],
			anchors: p.layoutAnchors || (!water && p.zonePlan.perLevel.length === 1 ? surfaceCluster(tplZones, tplConns, W, H, levelIndex, new Set((p.zonePlan.zones || []).filter(z => z.forcedLevel === 'underground').map(z => z.id))) : null),
			hubs: water && p.hubCells && p.hubCells.length ? p.hubCells : null });
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
			const nt = scaledNeutralTowns(z, p);
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
	const townKeep = tplZones ? keptNeutralTowns(p, playerStarts, W, H) : null;
	const mineKeep = tplZones ? keptMines(p, playerStarts, W, H) : null;
	if (mineKeep && levelIndex === 0) {
		const all = [...mineKeep.values()].reduce((a, m) => a + Object.values(m).reduce((b, n) => b + (n || 0), 0), 0);
		console.error(`[gen] template accommodation: a map smaller than the template's smallest keeps ${all} mine(s) outside the seated starts (VMAPGEN_MINE_SCALE=0 keeps them all)`);
	}
	if (townKeep && levelIndex === 0) {
		const all = [...townKeep.values()].reduce((a, b) => a + b, 0);
		console.error(`[gen] template accommodation: a map smaller than the template's smallest keeps ${all} neutral town(s) (VMAPGEN_TOWN_SCALE=0 keeps them all)`);
	}
	// Treasure biomes and Open low-loot biomes on a template (K, 2026-10-05: every lever acts on every template; both read the free layout only):
	// the zones stay, their treasure grows or shrinks. 0.25 is the template's own. A treasure zone's bands (piles and so the guards sized from them)
	// run at 0.5 + 0.5 x ratio / 0.25 of their value (0 half, 0.5 one and a half, 1 two and a half); a junction zone, the template's light-loot
	// ground, at 1 / (0.5 + 0.5 x ratio / 0.25) (0 twice, 1 two fifths). Start zones are not touched.
	const lootLeaned = z => {
		const hi = Number.isFinite(Number(p.highLootRatio)) ? Number(p.highLootRatio) : 0.25;
		const lo = Number.isFinite(Number(p.lowLootRatio)) ? Number(p.lowLootRatio) : 0.25;
		const f = z.type === 'treasure' ? Math.max(0.5, Math.min(2.5, 0.5 + 0.5 * hi / 0.25))
			: z.type === 'junction' ? Math.max(0.4, Math.min(2, 1 / (0.5 + 0.5 * lo / 0.25))) : 1;
		if (Math.abs(f - 1) < 1e-9 || !(z.treasure || []).length) return z;
		return { ...z, treasure: z.treasure.map(b => ({ ...b, min: Math.round(b.min * f), max: Math.round(b.max * f) })) };
	};
	const zoneMeta = tplZones && tplZones.map((z0, zi) => {
		const z = lootLeaned(z0);
		const ownerStart = z.owner && startOfOwner(playerStarts, z.owner);
		const townWishes = [];
		const pt = z.playerTowns || {}, nt = scaledNeutralTowns(z, p);
		// in the engine's order (TownPlacer::placeTowns): the owner's castles
		// and towns, then neutral castles, then neutral towns; a castle starts
		// with its fort. A start zone past the player count has no owner: its
		// own playerTowns becomes a neutral town instead of a player's
		// (TownPlacer, "no player - randomize town"), and that substitution
		// had never gone through the slider either - K hit it directly,
		// 2026-09-28, Jebus Cross at 2 players Large: 0% and 25% left the same
		// 2 neutral towns unmoved, one from each spare start, since this reads
		// playerTowns, not neutralTowns, and scaledNeutralTowns only touches
		// the latter. Scaled the same way now, the owned case untouched (a
		// real player's own extra castle has nothing to do with this slider).
		if (ownerStart) {
			for (let k = Math.max(0, (pt.castles || 0) - 1); k > 0; k--)
				townWishes.push({ owner: ownerStart.color, fort: true });
			for (let k = pt.towns || 0; k > 0; k--)
				townWishes.push({ owner: ownerStart.color, fort: false });
		}
		const neutral = [];
		for (let k = nt.castles || 0; k > 0; k--)
			neutral.push({ owner: null, fort: true });
		for (let k = nt.towns || 0; k > 0; k--)
			neutral.push({ owner: null, fort: false });
		const standIn = [];
		if (!ownerStart) {
			const scale = neutralTownScale(p);
			for (let k = Math.round((pt.castles || 0) * scale); k > 0; k--)
				standIn.push({ owner: null, fort: true });
			for (let k = Math.round((pt.towns || 0) * scale); k > 0; k--)
				standIn.push({ owner: null, fort: false });
		}
		// a map smaller than the template's smallest keeps fewer (keptNeutralTowns): the stand-ins go first
		const kept = [...neutral, ...standIn];
		if (townKeep && townKeep.has(z.id)) kept.length = Math.min(kept.length, townKeep.get(z.id));
		// in the engine's order: a stand-in (the start's own castle) before the zone's neutral towns
		townWishes.push(...kept.filter(w => standIn.includes(w)), ...kept.filter(w => neutral.includes(w)));
		return {
			mines: scaledMines(mineKeep && mineKeep.has(z.id) ? mineKeep.get(z.id) : z.mines, p.mineDensity), towns: townWishes,
			// the player whose start this zone is, whose faction is the zone's
			// town type
			ownerColor: ownerStart ? ownerStart.color : null,
			// any other zone's rolled town type, which its terrain follows
			townType: zoneTownType[zi] || null,
			faction: zoneFaction[zi],
			zoneCount: tplZones.length,
			nativeZones: zoneFaction.filter(f => f === zoneFaction[zi]).length,
			totalZones: (p.zonePlan && p.zonePlan.zones && p.zonePlan.zones.length) || tplZones.length,
			loot: pileLoot(z),
			guardScale: MONSTER_BAND[z.monsters || 'normal'] ?? 1,
			monsterShift: z.monsters === 'weak' ? -1
				: z.monsters === 'strong' ? 1 : 0,
			spec: z,
		};
	});
	// The engine counts a zone for a faction once per TOWN placed in it (TownPlacer registerZone), and its total
	// is the zones that registered, not the template's: a zone with no town (Coldshadow's neutral junctions)
	// counts for nobody, and the dwellings it prices run at 1 x, not at the 3 x the all-zones count gave them,
	// which priced the Azure and Crystal Dragon dwellings out of its piles (harness, 2026-10-01).
	// one-level map: the zones the template forces underground count their rich piles on 1.5 times their cells
	// (content.js templatePiles). VMAPGEN_ONE_LEVEL_RICH sets the factor (1 off).
	if (zoneMeta && p.zonePlan && (p.zonePlan.perLevel || []).length === 1) {
		const f = Number(process.env.VMAPGEN_ONE_LEVEL_RICH || 1.5);
		zoneMeta.forEach((m, i) => { if (tplZones[i] && (tplZones[i].forcedLevel === 'underground' || tplZones[i].wasUnderground)) m.richScale = f; });
	}
	// A map smaller than the template's own smallest (Coldshadow's Fantasy is xl+u; K's medium two-level map, a
	// quarter of it, came out with no dwelling in its dragon zones, 2026-10-03): the engine never makes one, it
	// writes the template's smallest size instead. To keep what the template is for, every zone counts its rich
	// piles (bands from 50000) on its cells times the square root of the shortfall (x2 at a quarter of the area,
	// x1.41 at a half); the rest of its loot shrinks with the map. VMAPGEN_SMALL_MAP_RICH=0 off.
	if (zoneMeta && p.zonePlan && p.zonePlan.minTiles && process.env.VMAPGEN_SMALL_MAP_RICH !== '0') {
		const have = W * H * (p.zonePlan.perLevel || [[]]).length;
		const f = Math.sqrt(p.zonePlan.minTiles / have);
		if (f > 1) zoneMeta.forEach(m => { m.richScale = Math.max(m.richScale || 1, f); });
	}
	p.linkGuardScale = linkGuardScale(p, W, H);
	p.tplAreaShare = tplAreaShare(p, W, H);
	if (zoneMeta) {
		const townsOf = m => m.towns.length + (m.ownerColor ? 1 : 0);
		const total = zoneMeta.reduce((a, m) => a + townsOf(m), 0);
		for (const m of zoneMeta) {
			m.totalZones = total || 1;
			m.nativeZones = zoneMeta.reduce((a, o) => a + (o.faction === m.faction ? townsOf(o) : 0), 0);
		}
	}

	const edges = biomeEdges(zone, W, H, seeds.length, water);
	let connections;
	if (tplZones && tplZones.length) {
		({ connections, edgeInfo, unfulfilled } =
			templateConnections(edges, landConns, rng, p, i => !!(tplZones[i] && /^(playerStart|cpuStart)$/.test(tplZones[i].type))));
		evenStartLinks(tplZones, landConns, connections, edgeInfo, unfulfilled, playerStarts, levelIndex);
		// a doorway needs a dry tile on the zone line: where the whole shared border runs along the water, no door can open onto land on
		// both sides, and the zone behind it was reached by nothing and swept empty (K's water settings, one-level 144, 2 players, seed 11:
		// zone 1's only link was such a door). The link becomes a monolith pair, as one with no shared border does. VMAPGEN_DOOR_DRY=0 off.
		if (water && process.env.VMAPGEN_DOOR_DRY !== '0') {
			const wet1 = c => { const x = c % W, y = (c / W) | 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const u = x + dx, v = y + dy; if (u >= 0 && v >= 0 && u < W && v < H && water[v * W + u]) return true; } return false; };
			let n = 0;
			for (const e of edges) {
				const k = e.a * 100000 + e.b, kind = connections.get(k);
				if (kind !== 'openRoad' && kind !== 'openNoRoad') continue;
				if (e.borderCells.some(c => !wet1(c))) continue;
				const c = edgeInfo.get(k);
				if (!c) continue;
				connections.set(k, 'blocked'); edgeInfo.delete(k); unfulfilled.push(c); n++;
			}
			if (n) console.error(`[gen] level ${levelIndex}: ${n} template link(s) whose shared border lies along the water become monolith pairs`);
		}
		// Portal share on a template: its own links are 1x (the default share). Above it a share (r - default) / (1 - default) of its doorway links, a
		// start's never, become monolith pairs with their guard and road kept; below it the template's portals stay (nothing to take out). No random
		// draw at or below the default, so a default map is as it was. VMAPGEN_PORTAL_SHARE=0 leaves the template's links.
		const portalShare = Number(p.interconnectPortal), portalDefault = BIOME_DEFAULTS.interconnectPortal;
		if (process.env.VMAPGEN_PORTAL_SHARE !== '0' && Number.isFinite(portalShare) && portalShare > portalDefault) {
			const startZone = i => !!(tplZones[i] && /^(playerStart|cpuStart)$/.test(tplZones[i].type));
			const prob = (portalShare - portalDefault) / (1 - portalDefault);
			let n = 0;
			for (const e of edges) {
				const k = e.a * 100000 + e.b, kind = connections.get(k);
				if (kind !== 'openRoad' && kind !== 'openNoRoad') continue;
				const c = edgeInfo.get(k);
				if (!c || startZone(e.a) || startZone(e.b) || !(rng() < prob)) continue;
				connections.set(k, 'blocked'); edgeInfo.delete(k); unfulfilled.push(c); n++;
			}
			if (n) console.error(`[gen] level ${levelIndex}: Portal share ${portalShare}: ${n} template doorway link(s) become monolith pairs`);
		}
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
	// A template level is in one piece through its own links and through the other level: two zones that each link
	// to the other level are joined by it, as the engine's are (Coldshadow's Fantasy: most of its zones meet only by
	// subterranean gates). Counting one level alone opened borders the template never has, guarded with the strongest
	// link's guard (tools/mapsight zones: 12.5 such links a map against the engine's 1). VMAPGEN_LEVEL_LINKS=0 is the
	// old count.
	const joined = [];
	if (tplZones && tplZones.length && process.env.VMAPGEN_LEVEL_LINKS !== '0') {
		for (const c of unfulfilled || []) joined.push([c.a, c.b]);
		for (const c of forcedPortals) joined.push([c.a, c.b]);
		const viaOther = [];
		for (const c of p.zonePlan.connections || []) {
			if (!c.aRef || !c.bRef || c.aRef.l === c.bRef.l) continue;
			if (c.aRef.l === levelIndex) viaOther.push(c.aRef.i);
			else if (c.bRef.l === levelIndex) viaOther.push(c.bRef.i);
		}
		for (let k = 1; k < viaOther.length; k++) joined.push([viaOther[0], viaOther[k]]);
	}
	const forced = ensureConnected(edges, connections, seeds.length, p, rng, joined);
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
		// a zone's tunnels as wide as its type's floor share asks (splinecave.js caveZoneScale); VMAPGEN_CAVE_TYPE_WIDTH
		// overrides, e.g. "start:1.6,treasure:1.2,junction:0.75" (=off: every zone alike)
		const typeWidth = { start: 1.6, treasure: 1.2, junction: 0.75 };
		const tw = process.env.VMAPGEN_CAVE_TYPE_WIDTH;
		if (tw && tw !== 'off') for (const kv of tw.split(',')) { const [k, v] = kv.split(':'); if (k && Number(v) > 0) typeWidth[k.trim()] = Number(v); }
		const caveZoneScale = tw === 'off' || !(tplZones && tplZones.length) ? null
			: tplZones.map(z => typeWidth[/start/i.test(z.type || '') ? 'start' : z.type] || 1);
		// The Narrow tunnels and Open cave floor sliders reach the tunnel network (they were read by the old chamber carve only, so the
		// default splines ignored them: the underground read 0.265 blocked at both ends of each, 2026-10-05). Narrow scales the
		// tunnel width by 2 ** (its distance below the default 0.6), 1.5x to 0.76x; Open scales the open share, which goes with width over
		// waypoint spacing, by moving the spacing. Both factors are 1 at the defaults, which leave the map as it was.
		const caveP = { ...p, ...(caveZoneScale ? { caveZoneScale } : {}) };
		const narrowD = Number.isFinite(p.subterraneanNarrow) ? BIOME_DEFAULTS.subterraneanNarrow - p.subterraneanNarrow : 0;
		const openK = Number.isFinite(p.subterraneanOpen) ? p.subterraneanOpen / BIOME_DEFAULTS.subterraneanOpen : 1;
		if (narrowD) caveP.caveWidth = (Number(p.caveWidth) || 6) * 2 ** narrowD;
		if (openK !== 1) caveP.caveSpacing = Math.max(5, (Number(p.caveSpacing) || 12) / Math.min(1.4, Math.max(0.6, openK)));
		openMask = carveUnderground(W, H, zone, seeds, edges, connections, caveP, rng, carvedBounds.openings);
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
	leakTrace('borders carved', blocked, W, H, levelIndex, [], barriers);
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
	if (tplZones) console.error(`[gen] level ${levelIndex}: doorway guards ${guards.length} of ${openings.filter(o => o.kind !== 'portal').length} doorway link(s)`);
	// A doorway's guard stands on its middle cell; where that cell is taken
	// already (water under a doorway along a shore), or a start's town will
	// stand on it or it would stand over the ground before the town's gate,
	// it moves to the nearest open cell of the same doorway. On water it was
	// lost, and the doorway left open (72x72 for five, seed 1104); over a
	// gate it boxed the start in, home 0 (Golems Aplenty 72 for six, 2130).
	const townCells = new Set();
	for (const st of playerStarts) {
		for (const [a, b] of blockingCells(OBJECT_TEMPLATES.randomTown, st.x, st.y)) townCells.add(b * W + a);
		for (const [vx, vy] of visitableCells(OBJECT_TEMPLATES.randomTown, st.x, st.y))
			for (const [dx, dy] of allowedDirs(OBJECT_TEMPLATES.randomTown))
				for (let ry = -1; ry <= 1; ry++)
					for (let rx = -1; rx <= 1; rx++) {
						const nx = vx + dx + rx, ny = vy + dy + ry;
						if (nx >= 0 && ny >= 0 && nx < W && ny < H) townCells.add(ny * W + nx);
					}
	}
	const taken = c => (blocked[levelIndex * W * H + c] & OCCUPIED) || townCells.has(c);
	for (const g of guards) {
		if (!taken(g.cell)) continue;
		const o = openings.find(q => q.hole.includes(g.cell));
		if (!o) continue;
		const at = o.hole.indexOf(g.cell);
		const open = o.hole.map((c, i) => [c, Math.abs(i - at)])
			.filter(([c]) => !taken(c))
			.sort((a, b) => a[1] - b[1]);
		if (process.env.VMAPGEN_GUARDCELL_TRACE)
			console.error(`[guardcell] level ${levelIndex} doorway ${g.edge.join('-')}: (${g.cell % W},${(g.cell / W) | 0}) taken, `
				+ (open.length ? `moved to (${open[0][0] % W},${(open[0][0] / W) | 0})` : `no other cell in its ${o.hole.length}`));
		if (open.length) g.cell = open[0][0];
	}
	// Hold the doorways clear. A path opening is two or three cells wide and
	// the chokepoint guard takes one of them, so a single object dropped on
	// the rest turns a connected map into two sealed halves. Reserved ground
	// stays walkable; it just may not be built on.
	const guardCells = new Set(guards.map(g => g.cell));
	// VMAPGEN_GUARDCELL_TRACE: each doorway guard cell something has taken, the
	// first phase it is seen taken in (a guard with no room is a doorway open)
	const gcSeen = new Set();
	const gcTrace = !process.env.VMAPGEN_GUARDCELL_TRACE ? () => {} : tag => {
		for (const c of guardCells) {
			const f = blocked[levelIndex * W * H + c];
			if ((f & (OCCUPIED | RESERVED)) && !gcSeen.has(c)) {
				gcSeen.add(c);
				console.error(`[guardcell] level ${levelIndex} ${tag}: (${c % W},${(c / W) | 0}) flags ${f}`);
			}
		}
	};
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
	gcTrace('before capitals');
	if (tplZones && tplZones.length && process.env.VMAPGEN_START_CENTRE !== '0')
		tplZones.forEach((z, b) => {
			const s = (z.type === 'playerStart' || z.type === 'cpuStart') && z.owner && startOfOwner(playerStarts, z.owner);
			if (!s) return;
			let at = townNearCentre(zone, b, W, H, levelIndex, blocked, water, barriers);
			// a start zone that holds a second town: the start leaves room for it TOWN_WALK walking tiles off (K's town spacing)
			const extra = zoneMeta && zoneMeta[b] && zoneMeta[b].towns ? zoneMeta[b].towns.length : 0;
			if (at && extra && process.env.VMAPGEN_TOWN_WALK !== '0') {
				const pair = startForSpacing(zone, b, W, H, levelIndex, blocked, water, barriers, at);
				if (pair && (pair.x !== at.x || pair.y !== at.y)) {
					console.error(`[gen] level ${levelIndex}: ${s.color || 'a player'}'s town off its zone's centre, (${at.x},${at.y}) -> (${pair.x},${pair.y}), so its second town can stand ${TOWN_WALK} walking tiles off`);
					at = pair;
				}
			}
			if (!at || (at.x === s.x && at.y === s.y)) return;
			console.error(`[gen] level ${levelIndex}: ${s.color || 'a player'}'s town to its zone's centre, `
				+ `(${s.x},${s.y}) -> (${at.x},${at.y})`);
			s.x = at.x;
			s.y = at.y;
		});
	// A free layout's start keeps its cell, but not one whose gate opens into another zone: the carve and the fill follow the
	// zones, so the town's way out lay under the next zone's cave rock and the start was shut (72x72 two levels 8 players seed
	// 896026, MapGen Dev's fuzz). Such a town goes to its zone's centre, as a template start's does. VMAPGEN_START_GATE_ZONE=0 off.
	if (!(tplZones && tplZones.length) && process.env.VMAPGEN_START_GATE_ZONE !== '0') {
		const vis = visitableCells(OBJECT_TEMPLATES.randomTown, 0, 0), dirs = allowedDirs(OBJECT_TEMPLATES.randomTown);
		for (const s of playerStarts) {
			const b = zone[s.y * W + s.x];
			if (b === undefined || b < 0) continue;
			let out = false;
			for (const [vx, vy] of vis) for (const [dx, dy] of dirs) {
				const x = s.x + vx + dx, y = s.y + vy + dy;
				if (x < 0 || y < 0 || x >= W || y >= H || zone[y * W + x] !== b) out = true;
			}
			if (!out) continue;
			const at = townNearCentre(zone, b, W, H, levelIndex, blocked, water, barriers);
			if (!at || (at.x === s.x && at.y === s.y)) continue;
			console.error(`[gen] level ${levelIndex}: ${s.color || 'a player'}'s town's gate opened into another zone, `
				+ `(${s.x},${s.y}) -> (${at.x},${at.y})`);
			s.x = at.x;
			s.y = at.y;
		}
	}

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
				if (nx < 0 || ny < 0 || nx >= W || ny >= H || guardCells.has(ny * W + nx)) continue;
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
						// a doorway's guard may stand in the apron: reserved, the
						// doorway out of the start lost its guard (36x36 for
						// eight, seed 1110; Golems Aplenty 72, seed 2130)
						if (nx < 0 || ny < 0 || nx >= W || ny >= H || guardCells.has(ny * W + nx)) continue;
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
	leakTrace('before towns', blocked, W, H, levelIndex, objects, barriers);
	phase('towns');
	gcTrace('before towns');
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
	// the faction of each town biome of a free layout (b -> bare id), for the fill's dwellings
	const freeFaction = new Map();
	// a faction's native terrain as this level paints it: the core terrain by name, dirt (surface) or
	// subterranean (below) when the layer does not take it, null when the map has no such terrain
	const nativeShort = native => {
		if (!native) return null;
		const name = String(native).slice(String(native).lastIndexOf(':') + 1).toLowerCase();
		let id = null;
		for (const [sid, t] of terrainInfo || [])
			if (String(t.identifier).slice(String(t.identifier).lastIndexOf(':') + 1).toLowerCase() === name && terrainShortIds.includes(sid)) {
				if (String(t.name).startsWith('core:')) { id = sid; break; }
				id = id || sid;
			}
		if (!id) return null;
		const layer = underground ? 'underground' : 'surface';
		if (!((terrainInfo.get(id) || {}).allowedLayers || []).includes(layer)) {
			const fb = layer === 'surface' ? 'dirt' : 'subterra';
			for (const [sid, t2] of terrainInfo) if (t2.identifier === fb) { id = sid; break; }
		}
		return id;
	};
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
		// A free layout's neutral town is a town of a faction rolled here, not the random-town placeholder the
		// engine rolls at load: its biome takes the faction's native terrain and its dwellings are that
		// faction's (K, 2026-09-30: castle dwellings beside Conflux; the engine's matchTerrainToTown does the same).
		const tpF = objectPools && objectPools.towns;
		let facB = null, townTpl = OBJECT_TEMPLATES.randomTown;
		if (tpF && tpF.free && process.env.VMAPGEN_FREE_TOWNS !== '0') {
			const cands = tpF.factions.filter(f => townTemplate(f, false, tpF.useMods));
			if (cands.length) { facB = cands[(rng() * cands.length) | 0]; townTpl = townTemplate(facB, false, tpF.useMods); }
		}
		let done = false;
		// K's town spacing: the door TOWN_WALK walking tiles from every start's and every town's door on the level; a zone with no such spot
		// takes the old rule below, logged
		const doorOf = (tpl, x, y) => { const v = visitableCells(tpl, x, y)[0]; return v ? v[1] * W + v[0] : -1; };
		const walkDoors = [...playerStarts.map(s2 => doorOf(OBJECT_TEMPLATES.randomTown, s2.x, s2.y)),
			...towns.filter(t => (t.l || 0) === levelIndex).map(t => (t.gates && t.gates[0] ? t.gates[0][1] * W + t.gates[0][0] : -1))];
		const walk = process.env.VMAPGEN_TOWN_WALK === '0' ? null : townWalk(W, H, levelIndex, blocked, water, walkDoors);
		for (const pass of walk ? [0, 1] : [1]) {
		if (done) break;
		if (pass === 1 && walk) console.error(`[gen] level ${levelIndex}: zone ${b}'s neutral town has no spot ${TOWN_WALK} walking tiles from every other town`);
		// no spot keeps the rule: the zone's cells farthest from every other town come first, so the pair keeps the widest gap the zone allows
		// (the lead, 2026-10-09: close towns only where nothing else fits, and as far apart as they can be)
		const gapOf = c => { const dd = doorOf(townTpl, c % W, (c / W) | 0); if (dd < 0) return -1; if (walk[dd] < 1e9) return walk[dd]; let m = 1e9; for (const d of walkDoors) if (d >= 0) m = Math.min(m, Math.max(Math.abs(d % W - c % W), Math.abs(((d / W) | 0) - ((c / W) | 0)))); return m; };
		const order = pass === 1 && walk ? cells.slice().sort((p2, q) => gapOf(q) - gapOf(p2)) : cells;
		for (const i of order) {
			const x = i % W, y = (i / W) | 0;
			// No neutral town within 12 cells of a start: on corpus 108x108
			// maps 2 of 103 owned towns have one within 10 (median nearest
			// 22), and ours had 3 of 16, one at 6, which hands that player a
			// second castle on day one.
			if (playerStarts.some(s =>
				Math.max(Math.abs(s.x - x), Math.abs(s.y - y)) < 12)) continue;
			if (pass === 0) {
				const dd = doorOf(townTpl, x, y);
				if (dd < 0 || walk[dd] < TOWN_WALK) continue;
				// where the walk reaches nothing (a cave before its carve) the straight distance keeps the rule too
				if (walk[dd] >= 1e9 && walkDoors.some(c => c >= 0 && Math.max(Math.abs(c % W - x), Math.abs(((c / W) | 0) - y)) < TOWN_WALK)) continue;
			}
			if (!footprintFits(townTpl, x, y, levelIndex,
					W, H, blocked)) continue;
			if (!entranceOpen(townTpl, x, y, levelIndex,
					W, H, blocked, null)) continue;
			const walls = blockingCells(townTpl, x, y)
				.map(([a, b2]) => b2 * W + a);
			if (!townGuard.accepts(walls)) continue;
			const np = playerStarts.length
				? playerStarts.reduce((m, s) =>
						(s.x - x) ** 2 + (s.y - y) ** 2 < (m.x - x) ** 2 + (m.y - y) ** 2 ? s : m)
				: null;
			const entry = facB
				? objectEntry('town', x, y, levelIndex, townTpl, facB.bare, { hasFort: false })
				: objectEntry('randomTown', x, y, levelIndex,
					townTpl, 'object',
					np && np.color ? { alignmentToPlayer: np.color } : undefined);
			if (facB) {
				const mods = townMods(facB, tpF.useMods);
				if (mods.length) entry.mod = mods;
				freeFaction.set(b, facB.bare);
				const nt = nativeShort(facB.native);
				if (nt) biomeTerrain[b] = nt;
			}
			objects.push(entry);
			towns.push({ instanceName: entry.instanceName, x, y,
				l: levelIndex,
				gates: visitableCells(townTpl, x, y) });
			footprintBlock(townTpl, x, y, levelIndex, W, H, blocked);
			townGuard.refresh();
			// Same apron rule as a player start: the cells a hero steps on to
			// open the gate stay reserved, so nothing seals the town in.
			for (const [vx, vy] of visitableCells(townTpl, x, y))
				for (const [dx, dy] of allowedDirs(townTpl)) {
					const nx = vx + dx, ny = vy + dy;
					if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
					reserveCell(blocked, levelIndex, W, H, ny * W + nx);
				}
			done = true;
			break;
		}
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
		// K's town spacing: every door this level holds so far (the starts', the towns already put, each spot as it is taken)
		const doorAt = (x, y) => { const v = visitableCells(townTpl, x, y)[0]; return v ? v[1] * W + v[0] : -1; };
		const townDoors = process.env.VMAPGEN_TOWN_WALK === '0' ? null
			: [...playerStarts.map(s2 => doorAt(s2.x, s2.y)), ...towns.filter(t => (t.l || 0) === levelIndex).map(t => doorAt(t.x, t.y))];
		let walkNow = null;
		let walkShort = 0;
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
			const why = { near: 0, fit: 0, guard: 0, reach: 0 };
			// a start zone's extra towns keep a land way to the start: their door must be joined to the start's tile by the zone's ground
			// outside the town's own cells (a town on a neck of land with its door on the dead end beyond it, 4p 72x72 wet line seed 4: a town's door on a four-tile shore strip, Opus Map Vision 13:20).
			// VMAPGEN_TOWN_REACH=0 skips the rule
			let landFrom = null, landWay = [];
			const extraWalls = new Set();
			if (hasStart && water && process.env.VMAPGEN_TOWN_REACH !== '0') {
				const st = playerStarts.find(s => zone[s.y * W + s.x] === b);
				// the zone's ground joined to the start's tile without crossing `gone` (the cells a town would cover)
				landFrom = gone => {
					const seen = new Uint8Array(W * H);
					const par = new Int32Array(W * H).fill(-1); seen.par = par;
					const q = [st.y * W + st.x];
					seen[q[0]] = 1;
					for (let h = 0; h < q.length; h++) {
						const c = q[h], cx = c % W, cy = (c / W) | 0;
						for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
							const nx = cx + dx, ny = cy + dy;
							if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
							const m = ny * W + nx;
							if (seen[m] || zone[m] !== b || water[m] || gone.has(m) || extraWalls.has(m)) continue;
							seen[m] = 1; par[m] = c; q.push(m);
						}
					}
					return seen;
				};
			}
			let band = false, walkOff = !townDoors;
			while (meta.townSpots.length < want) {
				let spot = -1;
				if (!walkOff && !walkNow) walkNow = townWalk(W, H, levelIndex, blocked, water, townDoors);
				for (const i of order()) {
					const x = i % W, y = (i / W) | 0;
					if (!walkOff) { const dd = doorAt(x, y); if (dd < 0 || walkNow[dd] < TOWN_WALK || (walkNow[dd] >= 1e9 && townDoors.some(c => c >= 0 && Math.max(Math.abs(c % W - x), Math.abs(((c / W) | 0) - y)) < TOWN_WALK))) { why.walk = (why.walk || 0) + 1; continue; } }
					// the same distance rule as the neutral towns above, except in a
					// player's own zone, whose extra towns are that player's
					if (!meta.ownerColor && playerStarts.some(s =>
						Math.max(Math.abs(s.x - x), Math.abs(s.y - y)) < 12)) { why.near++; continue; }
					// two cells clear of the map edge: one held against the edge let
					// later walls close a pocket behind it, which the pocket pass then
					// opened by removing the town (2SM4d seed 101). Spread to the
					// zone's edges, a town also keeps inside the zone and off its walls.
					// the town's whole picture on the map (K, 2026-10-08, the top edge): a town is drawn over a 6x6 mask (the core towns'), so its anchor stands
					// 5 rows and columns in at least; held one row higher, the town was refused there later and laid 28 tiles off (K's XL map, (44,4))
					if (y < Math.max(5, townTpl.mask.length - 1) || x < Math.max(5, Math.max(...townTpl.mask.map(r => r.length)) - 1)) { why.fit++; continue; }
					if (spread ? !townFitsZone(zone, b, x, y, W, H, levelIndex, blocked, barriers, band)
						: blockingCells(townTpl, x, y).some(([a, b2]) => a < 2 || b2 < 2 || a > W - 3 || b2 > H - 3)
							|| !footprintFits(townTpl, x, y, levelIndex, W, H, blocked)
							|| !entranceOpen(townTpl, x, y, levelIndex, W, H, blocked, null)) { why.fit++; continue; }
					const walls = blockingCells(townTpl, x, y).map(([a, b2]) => b2 * W + a);
					if (landFrom) {
						landWay = [];
						const land = landFrom(new Set(walls));
						let reach = -1;
						for (const [vx, vy] of visitableCells(townTpl, x, y)) {
							for (const [dx, dy] of allowedDirs(townTpl)) {
								const nx = vx + dx, ny = vy + dy;
								if (reach < 0 && nx >= 0 && ny >= 0 && nx < W && ny < H && land[ny * W + nx]) reach = ny * W + nx;
							}
						}
						if (reach < 0) { why.reach++; continue; }
						landWay = [];
						for (let c = reach, k = 0; c >= 0 && k < 10; c = land.par[c], k++) landWay.push(c);
					}
					if (!townGuard.accepts(walls)) { why.guard++; continue; }
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
					for (const c of walls) extraWalls.add(c);
					// the first tiles of that way stay free of objects (reserved ground is walkable): scenery laid later closed the neck
					for (const c of landWay) if (!walls.includes(c)) reserveCell(blocked, levelIndex, W, H, c);
					landWay = [];
					spot = i;
					break;
				}
				// a small zone the border band fills (36x36 two-player Coldshadow: 255 tiles, every cell refused): once more with
				// the band's inner cells open to the town
				if (spot < 0 && spread && !band) { band = true; continue; }
				// no spot keeps K's town spacing in this zone: the old rules, counted
				if (spot < 0 && !walkOff) { if (process.env.VMAPGEN_TOWN_TRACE) console.error(`[town] zone ${meta.spec && meta.spec.id}: no spot ${TOWN_WALK} walking tiles away, refused ${JSON.stringify(why)}, zone ${cells.length} tiles`); walkOff = true; band = false; walkShort++; continue; }
				if (spot < 0) break;
				meta.townSpots.push(spot);
				if (townDoors) { townDoors.push(doorAt(spot % W, (spot / W) | 0)); walkNow = null; }
			}
			if (process.env.VMAPGEN_TOWN_TRACE) console.error(`[town] zone ${meta.spec && meta.spec.id}: land way rule ${landFrom ? 'on' : 'off'}, ${why.reach} spot(s) refused`);
			if (meta.townSpots.length < want)
				console.error(`[gen] level ${levelIndex}: zone ${meta.spec && meta.spec.id} holds ground for `
					+ `${meta.townSpots.length} of its ${want} town(s) (cells refused: near a start ${why.near}, no fit ${why.fit}, would cut the zone ${why.guard}, no land way to the start ${why.reach}; zone ${cells.length} tiles)`);
		});
		if (walkShort) console.error(`[gen] level ${levelIndex}: ${walkShort} town(s) with no spot ${TOWN_WALK} walking tiles from every other town (the old rule placed them)`);
		// Every start gets as many towns as the others: where one start zone found no room for its extra town, the other start
		// zones give theirs up too (K, 2026-10-05, small islands Coldshadow: "one start got two castles and the other didn't").
		// Counted on this level. VMAPGEN_START_TOWNS_EQUAL=0 off.
		if (process.env.VMAPGEN_START_TOWNS_EQUAL !== '0') {
			const startZones = [];
			zoneMeta.forEach((meta, b) => { if (meta && meta.townSpots && meta.towns && meta.towns.length && playerStarts.some(s => zone[s.y * W + s.x] === b)) startZones.push(meta); });
			if (startZones.length > 1) {
				const least = Math.min(...startZones.map(m => m.townSpots.length));
				let given = 0;
				for (const meta of startZones) {
					while (meta.townSpots.length > least) {
						const i = meta.townSpots.pop();
						for (const [a, b2] of blockingCells(townTpl, i % W, (i / W) | 0)) if (a >= 0 && b2 >= 0 && a < W && b2 < H) blocked[levelIndex * W * H + b2 * W + a] &= ~OCCUPIED;
						// and the apron held before its gate
						for (const [vx, vy] of visitableCells(townTpl, i % W, (i / W) | 0)) for (const [dx, dy] of allowedDirs(townTpl)) {
							const nx = vx + dx, ny = vy + dy;
							if (nx >= 0 && ny >= 0 && nx < W && ny < H) blocked[levelIndex * W * H + ny * W + nx] &= ~RESERVED;
						}
						given++;
					}
					meta.towns = meta.towns.slice(0, least);
				}
				if (given) { townGuard.refresh(); console.error(`[gen] level ${levelIndex}: start zones kept equal at ${least} extra town(s) each, ${given} given up`); }
			}
		}
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
	// Where a link's gate or monolith goes, by the engine's rule: on the ground farthest from every object its zone
	// holds by then, its towns and the guards in its doorways (ConnectionsPlacer::selfSideIndirectConnection weighs a
	// gate site by the two levels' nearest-object distances; ObjectManager::createRequiredObjects puts a monolith with
	// OptimizeType::DISTANCE). Ours went nearest the zone's seed or under its partner's, beside the town: gates and
	// monoliths 10 tiles from their zone's town against the engine's 26, and its roads, which run town to link end,
	// a third short (Coldshadow's Fantasy, mapsight gate, 2026-10-02). Distances past VMAPGEN_LINK_FAR_CAP (26) tie,
	// and the old aim breaks the tie, so the level below still lays its zone under the gate. VMAPGEN_LINK_FAR=0 is
	// the old aim alone. Gates keep the old aim unless VMAPGEN_LINK_FAR_GATES=1: the level below lays the partner zone
	// round it, and far sites left 10 of 12 with no ground under them (seed 1, 2026-10-02).
	const linkFar = !!tplZones && process.env.VMAPGEN_LINK_FAR !== '0';
	const LINK_CAP = Number(process.env.VMAPGEN_LINK_FAR_CAP || 26);
	const gateSitesSoFar = [];
	const farSources = () => {
		const src = [];
		for (const o of objects) if ((o.l || 0) === levelIndex && /^(town$|randomTown$|subterraneanGate|monolith|randomMonster|monster)/.test(o.type)) src.push([o.x, o.y]);
		for (const c of guardCells) src.push([c % W, (c / W) | 0]);
		for (const m of zoneMeta || []) for (const i of (m && m.townSpots) || []) src.push([i % W, (i / W) | 0]);
		for (const g of gateSitesSoFar) src.push([g.x, g.y]);
		return src;
	};
	const farScore = (src, c) => {
		const x = c % W, y = (c / W) | 0;
		let d = Infinity;
		for (const [a2, b2] of src) { const e = Math.hypot(a2 - x, b2 - y); if (e < d) d = e; }
		return Math.min(d, LINK_CAP);
	};
	gcTrace('before the gate sites');
	const gateSites = [];
	if (tplZones && p.zonePlan && !underground && (p.zonePlan.perLevel || []).length > levelIndex + 1) {
		const links = crossLinks(p.zonePlan, levelIndex).filter(c => c.lo.l === levelIndex);
		const partners = new Map();
		for (const c of links) {
			if (!partners.has(c.hi.i)) partners.set(c.hi.i, []);
			partners.get(c.hi.i).push(c.lo.i);
		}
		const tpl = OBJECT_DEFS.subterraneanGate;
		// The site, its approach and the ring round them stay off the zone's border wall. Aimed at the mean of
		// its partners, two zones gated to the same zone below (Coldshadow's Fantasy 15 and 16 to 20) put their
		// sites on the wall between them; the approach cells held there kept the wall open, an unguarded passage
		// between zones the template never joins (tools/mapsight zones, 2026-10-01). VMAPGEN_GATE_CLEAR_BORDER=0
		// is the old check.
		const clearOfBorder = (t, x, y, z) => {
			if (process.env.VMAPGEN_GATE_CLEAR_BORDER === '0') return true;
			const own = blockingCells(t, x, y).concat(visitableCells(t, x, y));
			for (const [vx, vy] of visitableCells(t, x, y)) for (const [dx, dy] of allowedDirs(t)) own.push([vx + dx, vy + dy]);
			for (const [a, b] of own)
				for (let dy = -1; dy <= 1; dy++)
					for (let dx = -1; dx <= 1; dx++) {
						const nx = a + dx, ny = b + dy;
						if (nx < 0 || ny < 0 || nx >= W || ny >= H) return false;
						const k = ny * W + nx;
						if (zone[k] !== z || barriers.has(k)) return false;
					}
			return true;
		};
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
			const aim = c2 => (c2 % W - ax) ** 2 + (((c2 / W) | 0) - ay) ** 2;
			if (linkFar && !pin && process.env.VMAPGEN_LINK_FAR_GATES === '1') {
				const src = farSources(), far = new Map(cells.map(c2 => [c2, farScore(src, c2)]));
				cells.sort((a, b) => far.get(b) - far.get(a) || aim(a) - aim(b));
			} else cells.sort((a, b) => aim(a) - aim(b));
			for (const i of cells) {
				const x = i % W, y = (i / W) | 0;
				if (blockingCells(tpl, x, y).some(([a, b]) => a < 3 || b < 3 || a > W - 4 || b > H - 4)) continue;
				if (!footprintFits(tpl, x, y, levelIndex, W, H, blocked)) continue;
				if (!inZone(tpl, x, y, zone, c.lo.i, W, H)) continue;
				if (!clearOfBorder(tpl, x, y, c.lo.i)) continue;
				if (!entranceOpen(tpl, x, y, levelIndex, W, H, blocked, null)) continue;
				// the ground held before it never takes a doorway guard's cell:
				// it did on Coldshadow's Fantasy 36 (seed 1124), and the doorway
				// stood open
				if (visitableCells(tpl, x, y).some(([vx, vy]) => allowedDirs(tpl)
					.some(([dx, dy]) => guardCells.has((vy + dy) * W + vx + dx)))) continue;
				const walls = blockingCells(tpl, x, y).map(([a, b]) => b * W + a);
				if (!townGuard.accepts(walls)) continue;
				holdGateGround(tpl, x, y, levelIndex, W, H, blocked);
				townGuard.refresh();
				gateSites.push({ k: c.k, x, y });
				gateSitesSoFar.push({ x, y });
				if (process.env.VMAPGEN_GATE_TRACE)
					console.error(`[gate] link ${c.k}: zone ${c.lo.i} to ${c.hi.i} below${pin ? ' (a start)' : ''}, `
						+ `aimed at (${ax.toFixed(0)},${ay.toFixed(0)}), site (${x},${y})`);
				break;
			}
		}
		if (links.length)
			console.error(`[gen] level ${levelIndex}: ground held for ${gateSites.length} of ${links.length} gate(s) down`);
	}
	gcTrace('after the gate sites');

	// Boats and shipyards (waterfill.js, water W2) go in with the towns, so
	// every later pass routes around them and their boarding cells stay free.
	// Their own stream, so a dry map draws exactly what it did before.
	leakTrace('before harbours', blocked, W, H, levelIndex, objects, barriers);
	phase('harbours');
	gcTrace('before harbours');
	const harbours = water ? placeHarbours({ W, H, l: levelIndex, water, zone, blocked,
		rng: xorshift(((params.seed || 1) ^ 0x5eaf00d) >>> 0), p, objects, towns,
		playerStarts, objectEntry, islands: !!p.waterIslands, keepClear: guardCells,
		hubCells: p.hubCells && p.hubCells.length ? p.hubCells : null }) : [];

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
				// a zone wall cell is not open ground, though its scenery comes later: a monolith's guard stood on one and its
				// ring kept the wall from being filled, a hole between zones the template never links (K's line, 72x72
				// seed 3, zones 9 and 19, 2026-10-04: mapsight road gap (24,26)). VMAPGEN_PORTAL_OFF_WALL=0 off.
				if (wallOff && barriers.has(c)) continue;
				if (!own.has(c) && !(blocked[levelIndex * W * H + c] & OCCUPIED)) out.push(c);
			}
		return out;
	};
	const wallOff = process.env.VMAPGEN_PORTAL_OFF_WALL !== '0';
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
		if (linkFar) {
			const src = farSources();
			const cells = [];
			for (let i = 0; i < zone.length; i++) if (zone[i] === z && !(water && water[i])) cells.push(i);
			const rim = rimDistance(zone, W, H);
			const far = new Map(cells.map(c2 => [c2, (rim[c2] >= 3 ? 100 : 0) + farScore(src, c2)]));
			const aim = c2 => (c2 % W - cx) ** 2 + (((c2 / W) | 0) - cy) ** 2;
			cells.sort((a, b) => far.get(b) - far.get(a) || aim(a) - aim(b));
			for (const clear of [true, false])
				for (const c2 of cells) {
					const x = c2 % W, y = (c2 / W) | 0;
					if (!inZone(monoTpl, x, y, zone, z, W, H)) continue;
					if (!footprintFits(monoTpl, x, y, levelIndex, W, H, blocked)) continue;
					if (!entranceOpen(monoTpl, x, y, levelIndex, W, H, blocked, null)) continue;
					if (clear && guardedAt(reach, monoTpl, x, y)) continue;
					// never beside another link end (K, 2026-10-02: "monoliths SHOULD NEVER be stacked like that")
					if (clear && (gateSitesSoFar.some(g => Math.max(Math.abs(g.x - x), Math.abs(g.y - y)) <= 5)
						|| objects.some(o => (o.l || 0) === levelIndex && /^(monolith|subterraneanGate)/.test(o.type) && Math.max(Math.abs(o.x - x), Math.abs(o.y - y)) <= 5))) continue;
					gateSitesSoFar.push({ x, y });
					return [x, y];
				}
		}
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
	// Guards at portals: 0 Off, 1 On, 2 Template (the default; a stored 1 from before was the old On)
	const portalMode = (p.guardPortals === undefined || p.guardPortals === null || !Number.isFinite(Number(p.guardPortals))) ? 2 : Math.max(0, Math.min(2, Math.round(Number(p.guardPortals))));
	// a portal's guard cells, those whose reach covers nothing but the portal
	// first (content.js reachOnReserved): a guard over the next portal made a
	// link the template leaves free a fight ([HotA] Nostalgia seed 5002, two
	// monoliths side by side in teal's zone)
	const guardSpots = (monoTpl, mx, my) => {
		// never a doorway guard's cell: a portal's guard took one on [HotA]
		// Nostalgia squeezed to 36x36 (seed 3126) and the doorway stood open
		const beside = openBeside(monoTpl, mx, my).filter(c => !guardCells.has(c));
		if (!tplZones) {
			const out = beside.slice();
			out.clear = new Set(out);
			return out;
		}
		const monster = OBJECT_TEMPLATES.randomMonster;
		const mine = new Set(openBeside(monoTpl, mx, my));
		for (const [vx, vy] of visitableCells(monoTpl, mx, my)) mine.add(vy * W + vx);
		// the tile whose ring covers most of the monolith's approach first, so its guard seals it (the engine's every
		// monolith is sealed behind its guard; ours 0.65 before this, mapsight score 2026-10-02); VMAPGEN_GUARD_COVER=0
		// keeps the approach order
		const cells = beside.slice();
		if (process.env.VMAPGEN_GUARD_COVER !== '0') {
			const appr = openBeside(monoTpl, mx, my);
			const unc = c => appr.filter(d => Math.abs(d % W - c % W) > 1 || Math.abs(((d / W) | 0) - ((c / W) | 0)) > 1).length;
			const u = new Map(cells.map(c => [c, unc(c)]));
			cells.sort((a2, b2) => u.get(a2) - u.get(b2));
		}
		const clear = cells.filter(c => !reachOnReserved(monster, c % W, (c / W) | 0, levelIndex, W, H, blocked, mine));
		const out = [...clear, ...cells.filter(c => !clear.includes(c))];
		out.clear = new Set(clear);
		return out;
	};
	const portalGuard = (monoTpl, mx, my, toZone) => {
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
		const concrete = !!(objectPools && objectPools.guards && zoneMeta);
		const g = engineGuard(scaledLinkGuard(strength, p), 1 + Math.round(p.monsterStrength || 0), rng, true,
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
				{ character: 'hostile', amount: scaledAmount(g.amount, p) });
			if (concrete) e.guardCreature = g.creature;
			objects.push(e);
			footprintBlock(monster, gx, gy, levelIndex, W, H, blocked);
			markApproach(monster, gx, gy, levelIndex, W, H, blocked);
			// the rest of the monolith's way in closes, as at a cross-level end (planMap guardEnd; VMAPGEN_END_SEAL=0)
			if (process.env.VMAPGEN_END_SEAL !== '0') {
				const cg = makeConnectivityGuard(blocked, levelIndex, W, H);
				for (const d of openBeside(monoTpl, mx, my)) {
					if (Math.abs(d % W - gx) <= 1 && Math.abs(((d / W) | 0) - gy) <= 1) continue;
					if (blocked[levelIndex * W * H + d] & (OCCUPIED | RESERVED)) continue;
					const terr = biomeTerrain && biomeTerrain[zone[d]];
					const sg = terr && singleTemplate(terr, rng);
					if (!sg || !sg.tpl.mask || sg.tpl.mask.length !== 1 || sg.tpl.mask[0].length !== 1) continue;
					if (!cg.accepts([d])) continue;
					objects.push(objectEntry(sg.type, d % W, (d / W) | 0, levelIndex, sg.tpl, sg.subtype || 'object'));
					footprintBlock(sg.tpl, d % W, (d / W) | 0, levelIndex, W, H, blocked);
					cg.refresh();
				}
			}
			return true;
		}
		return false;
	};
	leakTrace('before monoliths', blocked, W, H, levelIndex, objects, barriers);
	phase('monoliths');
	gcTrace('before monoliths');
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
		// the ways in, taken before the guard and its walls close all but one of them: the road comes to the guard there
		const besideA = openBeside(monoTpl, A[0], A[1]), besideB = openBeside(monoTpl, B[0], B[1]);
		// Guards at portals, three states (K, 2026-10-05): 0 Off, no monster in front of any portal end (portalends.js sweeps up what
		// another rule placed there); 1 On, one in front of every end, the link's own guard where the portal is a link; 2 Template
		// (the default), what the template does: the link's guard on a portal link and nothing on the rest; a free layout reads it as On.
		const portalState = portalMode;
		if (portalState === 0) {
			// no guard here
		} else if (o.tplGuard > 0 && process.env.VMAPGEN_PORTAL_GUARD !== '0') {
			const guardedA = linkPortalGuard(monoTpl, A[0], A[1], o.a, o.tplGuard);
			const guardedB = linkPortalGuard(monoTpl, B[0], B[1], o.b, o.tplGuard);
			// a link guard too weak for engineGuard (Nostalgia's 3000) places none; On still wants a monster in front of the end
			if (Number(p.guardPortals) === 1) {
				if (!guardedA) portalGuard(monoTpl, A[0], A[1], o.b);
				if (!guardedB) portalGuard(monoTpl, B[0], B[1], o.a);
			}
		} else if (portalState === 1 || !tplZones) {
			portalGuard(monoTpl, A[0], A[1], o.b);
			portalGuard(monoTpl, B[0], B[1], o.a);
		}
		links.push([openBeside(monoTpl, A[0], A[1]), openBeside(monoTpl, B[0], B[1])]);
		// a link with a road has one to each monolith (ConnectionsPlacer::
		// placeMonolithConnection: both are road nodes); roadplan.js lays them
		if (o.road) o.roadNodes = [[o.a, besideA], [o.b, besideB]];
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
	leakTrace('before roads', blocked, W, H, levelIndex, objects, barriers);
	phase('roads');
	gcTrace('before roads');
	const roadCells = new Set();
	const roadFailed = [];
	const roadEdges = [];
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
					// a town keeps one road out of its zone: on an island whose other zones hold no town the trim cut them all, and the
					// start town stood with no road while every other start had one (K's islands map, 2026-10-08)
					const other = roads[0].a === z ? roads[0].b : roads[0].a;
					if (holding.has(other) && doors.filter(o => o.kind === 'openRoad' && (o.a === other || o.b === other)).length === 1) continue;
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
		const r = planRoads({ plan: { zone, openings, roadCells, roadNodes: gateNodes, p, spine: openMask && openMask.spine, openMask }, towns: roadTowns,
			W, H, blocked, l: levelIndex, approach: t => roadApproach(t, W, H, blocked, levelIndex),
			// a wall cell held clear (a doorway's side, a town's apron) never
			// takes a wall object (footprintFits vetoes RESERVED), so a road may
			avoid: c => barriers.has(c) && !(blocked[levelIndex * W * H + c] & RESERVED),
			standOn: guardCells });
		// what could not be reached yet is joined after the fill (planMap)
		roadFailed.push(...r.failedNodes);
		roadEdges.push(...(r.edges || []));
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
	// Zones that hold a subterranean gate reach each other through the other level, so for this check every gate site
	// of the level is joined to every other (the engine's levels are in one piece only through their gates on
	// Coldshadow's Fantasy). Without it the pass cut walls open, unguarded, between zones the template never joins.
	const pocketLinks = links.slice();
	if (process.env.VMAPGEN_LEVEL_LINKS !== '0' && tplZones && tplZones.length) {
		const around = s => { const out = []; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const x = s.x + dx, y = s.y + dy; if (x >= 0 && y >= 0 && x < W && y < H) out.push(y * W + x); } return out; };
		const sites = [...gateSites, ...gateSitesHere];
		for (let k = 1; k < sites.length; k++) pocketLinks.push([around(sites[0]), around(sites[k])]);
	}
	const freed = openSealedPockets(barriers, W, H, levelIndex, blocked, playerStarts, pocketLinks, water);
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
	leakTrace('before mountains', blocked, W, H, levelIndex, objects, barriers);
	phase('mountains');
	gcTrace('before mountains');
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
		if (process.env.VMAPGEN_WALL_TRACE === 'cells')
			console.error(`[walls] level ${levelIndex} open cells: ${open.map(c => `${c % W},${(c / W) | 0}`).join(' ')}`);
	}
	leakTrace('before valleys', blocked, W, H, levelIndex, objects, barriers);
	phase('valleys');
	gcTrace('before valleys');
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

	leakTrace('before ridges', blocked, W, H, levelIndex, objects, barriers);
	phase('ridges');
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
		// The Scenery slider (decorDensity) moves it too: the distance is 8 at 1x, nearer a corridor at more (2x: 4) and
		// never at 0, so the lever reaches the mass inside a zone and not only the packs (it read 83, 126, 116 interior pieces
		// at 0x, 1x, 2x on 72x72 Coldshadow).
		const decorK = Number.isFinite(p.decorDensity) ? p.decorDensity : 1;
		const rimBlockD = decorK <= 0 ? Infinity : Math.max(3, (+process.env.VMAPGEN_RIDGE_D || 8) / decorK);
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
		// as many corridors as the level needs: a fixed 60 left every cell past their reach to become mass on a giant map, a
		// band 3-20 tiles deep at 62-66% blocked round each zone against the engine's 25-36% (K, 2026-10-04, 252x252: "borders got
		// scaled up directly with size and are like day's travel thick"). One corridor a 250 tiles, at least 60 (VMAPGEN_RIDGE_ITER sets it).
		const ridgeIter = Number(process.env.VMAPGEN_RIDGE_ITER) || Math.max(60, Math.ceil(W * H / 250));
		for (let iter = 0; iter < ridgeIter; iter++) {
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
	// never a ridge over a road: the roads went down first and a range laid across one broke it (seed 1, spline roads)
	const ridgeLeft = new Set([...ridgeCells].filter(c => !roadCells.has(c)));
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

	gcTrace('at the guards');
	const guardsLost = [];
	// each zone's share of the doorway guards on its borders, half a guard
	// per side (fillLevel: a free zone's monster budget pays for them)
	const doorGuards = new Map();
	const guarded = new Set();
	for (const g of guards) {
		const x = g.cell % W, y = (g.cell / W) | 0;
		// two doorways that meet on one cell (three zones' corner) share its
		// guard: its 3x3 holds both
		if (guarded.has(g.cell)) {
			for (const z of g.edge) doorGuards.set(z, (doorGuards.get(z) || 0) + 0.5);
			continue;
		}
		if (!footprintFits(OBJECT_TEMPLATES.randomMonster, x, y, levelIndex, W, H,
				blocked, true)) {
			guardsLost.push(`${g.edge.join('-')} at (${x},${y}) flags ${blocked[levelIndex * W * H + g.cell]}`);
			continue;
		}
		const guardEntry = objectEntry(`randomMonsterLevel${g.level}`, x, y, levelIndex,
			OBJECT_TEMPLATES.randomMonster, 'object',
			g.amount ? { character: 'hostile', amount: scaledAmount(g.amount, p) } : monsterOptions(g.level, p, rng));
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
		guarded.add(g.cell);
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
	// pocketLinks: the level's gate sites joined to each other through the other level (see openSealedPockets above)
	const reopened = openSealedByObjects(objects, W, H, levelIndex, blocked,
		playerStarts, towns, pocketLinks, water, levelIndex > 0, zone);
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
	leakTrace('level done', blocked, W, H, levelIndex, objects, barriers);
	return { zone, seeds, gateSites, gateSitesHere, classes, biomeTerrain, barriers, roadCells, roadFailed, roadEdges, objects, openings,
		guards, doorGuards, rng, p, levelIndex, playerStarts, alignPlayers, towns,
		objectPools, openMask, zoneMeta, zdist, rim, harbours, links, sailLinks, freeFaction,
		stats: layoutStats(zone, seeds, tplZones, tplConns, unfulfilled, forced, W, H, water, openMask, landCells) };
}

/**
 * A template link's guard on a map smaller than the template's own smallest, as a share of its strength: the square
 * root of the area shortfall (a hero reaches a link in that share of the days), at least LINK_GUARD_FLOOR of it, and
 * never so low that the link loses its guard (scaledLinkGuard). The engine never builds such a map; at full strength
 * K's 36x36 Coldshadow (s203860797) held its start behind 7 Ghost Dragons, 20 Drake Golems, 11 Jotunn Warlords and
 * 81 Black Knights, and in a 59-day engine game neither AI got past one (2026-10-04). VMAPGEN_LINK_GUARD_SCALE=0 off.
 */
/**
 * Walking steps (8-way, over land nothing stands on yet) from the nearest of `doors` to every tile of the level, for K's town spacing
 * (2026-10-08: "two castles within 15 grids walking of eachother from town to town should be the extreme exception rather than the rule").
 * Taken before the walls and the fill, so a later map only walks farther.
 */
// counted door to door; the grid check (grid_extra.js town-spacing) counts from the tiles round each door, plus one, which reads two less
const TOWN_WALK = 17;
function townWalk(W, H, l, blocked, water, doors) {
	const N = W * H, dist = new Int32Array(N).fill(1e9), q = new Int32Array(N);
	let qh = 0, qt = 0;
	for (const c of doors) if (c >= 0 && c < N && dist[c] > 0) { dist[c] = 0; q[qt++] = c; }
	while (qh < qt) {
		const c = q[qh++], x = c % W, y = (c / W) | 0, d = dist[c] + 1;
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
			const nx = x + dx, ny = y + dy;
			if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
			const n = ny * W + nx;
			if (dist[n] <= d || (water && water[n]) || (blocked[l * N + n] & OCCUPIED)) continue;
			dist[n] = d; q[qt++] = n;
		}
	}
	return dist;
}

const LINK_GUARD_FLOOR = 0.25;
/** The map's tiles (every level) as a share of the template's own smallest map; 1 with no template */
function tplAreaShare(p, W, H) {
	if (!p || !p.zonePlan || !p.zonePlan.minTiles) return 1;
	return W * H * (p.zonePlan.perLevel || [[]]).length / p.zonePlan.minTiles;
}
function linkGuardScale(p, W, H) {
	if (process.env.VMAPGEN_LINK_GUARD_SCALE === '0' || !p || !p.zonePlan || !p.zonePlan.minTiles) return 1;
	const have = W * H * (p.zonePlan.perLevel || [[]]).length;
	return Math.min(1, Math.max(LINK_GUARD_FLOOR, Math.sqrt(have / p.zonePlan.minTiles)));
}

/**
 * Every start that holds a player gets its links out of the start drawn the same way. A link the layout could not
 * draw as land becomes a monolith pair, so one start's way out was a monolith straight into the template's middle
 * while another's was a walk through a doorway: on K's one-level 72x72 seed 2 red owned 10 towns by day 2 against
 * blue's 3 (tools/geometry/travelweb.js; K, 2026-10-04: "a SEVERELY advantaged spawn with like 4 castles in 2-day's
 * ride"). When the seated starts' links on a level are a mix of the two, the land ones become monolith pairs too
 * (connections blocked, the link handed to the portal bridging). OFF unless VMAPGEN_EVEN_START_LINKS=1: with guards
 * passed only when a hero's army can beat them (travelweb.js --guards army), every map of 36 to 144, one and two levels,
 * already stays inside the engine's own spread through day 10 (0-1 towns, 0-4 mines), and on 72 seed 2 this rule left
 * the spread where it was; the 15 towns came from counting 36000-75000 link guards as free (2026-10-04).
 */
function evenStartLinks(tplZones, conns, connections, edgeInfo, unfulfilled, playerStarts, levelIndex) {
	if (process.env.VMAPGEN_EVEN_START_LINKS !== '1' || !playerStarts || !playerStarts.length) return 0;
	const seated = i => {
		const z = tplZones[i];
		return !!(z && (z.type === 'playerStart' || z.type === 'cpuStart') && z.owner && startOfOwner(playerStarts, z.owner));
	};
	const links = conns.filter(c => seated(c.a) !== seated(c.b));
	const portal = new Set(unfulfilled);
	if (!links.some(c => portal.has(c)) || links.every(c => portal.has(c))) return 0;
	let n = 0;
	for (const c of links) {
		if (portal.has(c)) continue;
		const k = Math.min(c.a, c.b) * 100000 + Math.max(c.a, c.b);
		connections.set(k, 'blocked');
		edgeInfo.delete(k);
		unfulfilled.push(c);
		n++;
	}
	console.error(`[gen] level ${levelIndex}: ${n} start link(s) drawn as monolith pairs like the other starts' (every seated start's way out the same kind)`);
	return n;
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
function templateConnections(edges, conns, rng, p, isStart = () => false) {
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
		let road = c.road === null || c.road === undefined ? rng() < share : c.road;
		// Passages with / without road on a template: the template's own road flags are 1x (the default share). Above the default share a no-road
		// passage gets a road with probability (share - default) / (1 - default); below it a road passage that is no start's loses it with
		// probability 1 - share / default. No random draw at the default. VMAPGEN_ROAD_SHARE=0 leaves the template's flags.
		const r0 = BIOME_DEFAULTS.openPathRoad / (BIOME_DEFAULTS.openPathNoRoad + BIOME_DEFAULTS.openPathRoad);
		if (typeof c.road === 'boolean' && process.env.VMAPGEN_ROAD_SHARE !== '0' && Number.isFinite(share) && share !== r0) {
			if (!road && share > r0 && rng() < (share - r0) / (1 - r0)) road = true;
			else if (road && share < r0 && !isStart(e.a) && !isStart(e.b) && rng() < 1 - share / r0) road = false;
		}
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
	// Each template zone's own piece is ground to fill on any level, split or not: a zone whose one passage holds its
	// doorway guard was "unreachable" from the starts, the guard being a wall to the flood, and got no towns or mines
	// (one-level Coldshadow's Fantasy seed 3, zone 5, 2026-10-02). VMAPGEN_FILL_ZONE_PIECES=0 keeps the old rule.
	const byPieces = splitLevels(p) || (plan.zoneMeta && plan.zoneMeta.some(m => m && m.spec) && process.env.VMAPGEN_FILL_ZONE_PIECES !== '0');
	const reachable = followLinks(byPieces
		? zonePieces(W, H, levelIndex, blocked, zone, playerStarts)
		: playerStarts.length
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
		// the faction of the town this biome belongs to, when it has one: a start's, or the free layout's own rolled
		// neutral town (towns phase); K's rule: a town biome's dwellings are its town's (content.js)
		const startHere = !plan.zoneMeta && playerStarts.find(s => zone[s.y * W + s.x] === b);
		const biomeFaction = plan.zoneMeta ? null : (startHere && startHere.faction) || (plan.freeFaction && plan.freeFaction.get(b)) || null;
		// K, 2026-10-08: a start's whole biome takes its town's dwellings ("HARD AND FAST RULE FOR PLAYER START TOWNS"; the far part of a split start
		// biome had none of its faction), a neutral town's biome three in four of its town's (content.js dwellOwnShare)
		const ownShare = startHere ? 1 : biomeFaction ? 0.75 : 1;
		parts.forEach(([cls, cells], i) =>
			objects.push(...fillBiome(cls, cells, blocked, W, H,
				levelIndex, rng, { ...p, dwellOwnShare: ownShare, doorGuards: i === parts.length - 1 && plan.doorGuards ? plan.doorGuards.get(b) || 0 : 0 },
				towns, alignPlayers || playerStarts, objectPools,
				biomeTerrain[b], reachable, connectivity,
				plan.zoneMeta && plan.zoneMeta[b]
					&& { ...plan.zoneMeta[b], minesDone: starterDone.get(b) || {} }, plan.openMask,
				plan.zdist && plan.zdist[b], i === 0 ? starterMines.get(b) || [] : [],
				parts.length === 1 || i === 0 || startHere ? biomeFaction : null)));
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
		// the last ground, once the ring is spent (36x36 for eight): the road. Pickups lie on roads, the engine's at
		// 0.025 a road tile, and a road tile under a pickup is still a road
		const onRoad = [];
		if (plan.roadCells) for (const c of plan.roadCells)
			if (e.dist[c] >= 2 && e.dist[c] <= RADIUS && !(blocked[levelIndex * W * H + c] & OCCUPIED)) onRoad.push(c);
		const roadSet = new Set(onRoad);
		// The kit climbs in value as the gap does: chests and piles close a
		// small shortfall, a deficit of artifact size needs an artifact to
		// move at all (a poor 8-player start can be 100k down, which is a
		// hundred resource piles of ground nobody has).
		let placed = 0, arts = 0;
		for (let tries = 0; tries < 128 && e.value < target && placed < 12;
				tries++) {
			const src = nearHome.length ? nearHome : rest.length ? rest : onRoad;
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
			if (roadSet.has(c) ? blockingCells(tpl, x, y).some(([fx, fy]) => fx < 0 || fy < 0 || fx >= W || fy >= H || (blocked[levelIndex * W * H + fy * W + fx] & OCCUPIED))
				: !footprintFits(tpl, x, y, levelIndex, W, H, blocked, true))
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
	p.linkGuardScale = linkGuardScale(p, W, H);
	p.tplAreaShare = tplAreaShare(p, W, H);     // the gate and monolith guards below (guardEnd)
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
	setPhaseLevel(0);
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
		const reachNow = () => [0, 1].map(l => splitLevels(p)
			? zonePieces(W, H, l, blocked, plans[l].zone, startsOn(l))
			: mainComponent(W, H, l, blocked, startsOn(l)));
		// How far a tile is from the skeleton of its level: the towns, the link ends and the doorway guards, capped at
		// 26 tiles. The engine puts a gate pair where the product of the two levels' distances is largest and a
		// monolith where its own is (ConnectionsPlacer::selfSideIndirectConnection, ObjectManager::createRequiredObjects
		// with OptimizeType::DISTANCE); ours took the cell nearest the zone's centre, beside its town: surface
		// monoliths 3 tiles from the town against the engine's 18 to 29, and roads a third short (2026-10-02).
		// VMAPGEN_LINK_FAR=0 keeps the old picks.
		const lateFar = process.env.VMAPGEN_LINK_FAR !== '0';
		const skeleton = l => {
			const src = [];
			for (const o of plans[l].objects)
				if ((o.l || 0) === l && /^(town$|randomTown$|subterraneanGate|monolith)/.test(o.type)) src.push([o.x, o.y]);
			for (const g of plans[l].guards || []) if (g && g.cell >= 0) src.push([g.cell % W, (g.cell / W) | 0]);
			return src;
		};
		const farFrom = (src, c) => {
			const x = c % W, y = (c / W) | 0;
			let d = 26;
			for (const [a2, b2] of src) { const e = Math.hypot(a2 - x, b2 - y); if (e < d) d = e; }
			return d;
		};
		// Whether a link end's way in opens onto its zone: from the tiles it is entered from, over ground nothing stands
		// on, at least 80 tiles of the zone (or half its open ground, if that is less). A held gate site whose way in the
		// fill had walled round left zone 5 with one link onto a pocket of 2 tiles, and the whole zone was swept away
		// (Coldshadow's Fantasy seed 4 with zone balancing, 2026-10-02). VMAPGEN_LINK_OPENS=0 skips the check.
		const zoneOpen = new Map();
		const opensInto = (l, tpl, x, y, zi) => {
			if (process.env.VMAPGEN_LINK_OPENS === '0') return true;
			const base = l * W * H, zl = plans[l].zone;
			const key = l * 100000 + zi;
			if (!zoneOpen.has(key)) { let n = 0; for (let c = 0; c < W * H; c++) if (zl[c] === zi && !(blocked[base + c] & OCCUPIED)) n++; zoneOpen.set(key, n); }
			const need = Math.min(80, Math.floor(zoneOpen.get(key) / 2));
			const own = new Set(blockingCells(tpl, x, y).map(([a2, b2]) => b2 * W + a2));
			const st = approachCells(tpl, x, y, l, W, H, blocked).filter(c => zl[c] === zi && !own.has(c));
			const seen = new Set(st);
			while (st.length && seen.size < need) {
				const c = st.pop(), cx = c % W, cy = (c / W) | 0;
				for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
					const nx = cx + dx, ny = cy + dy, m = ny * W + nx;
					if (nx < 0 || ny < 0 || nx >= W || ny >= H || seen.has(m) || own.has(m) || zl[m] !== zi || (blocked[base + m] & OCCUPIED)) continue;
					seen.add(m); st.push(m);
				}
			}
			return seen.size >= need;
		};
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
			const toCentre = c2 => (c2 % W - cx) ** 2 + (((c2 / W) | 0) - cy) ** 2;
			if (lateFar) {
				const rim = rimDistance(plans[l].zone, W, H);
				const src = skeleton(l), far = new Map(cells.map(c2 => [c2, (rim[c2] >= 3 ? 100 : 0) + farFrom(src, c2)]));
				cells.sort((a, b) => far.get(b) - far.get(a) || toCentre(a) - toCentre(b));
			} else cells.sort((a, b) => toCentre(a) - toCentre(b));
			// not within 4 tiles of another gate or monolith while a cell further out fits: nearest the centre
			// alone put a zone's monoliths side by side (0.43 of them against the engine's none, tools/mapsight
			// score 2026-10-01); VMAPGEN_PORTAL_SPACING=0 is the old pick
			const ends = process.env.VMAPGEN_PORTAL_SPACING === '0' ? [] : plans[l].objects
				.filter(o => (o.l || 0) === l && (o.type === 'monolithTwoWay' || o.type === 'subterraneanGate'));
			const crowded = (x, y) => ends.some(o => Math.abs(o.x - x) <= 6 && Math.abs(o.y - y) <= 6);
			let fallback = -1;
			for (const c of cells) {
				const x = c % W, y = (c / W) | 0;
				if (footprintFits(tpl, x, y, l, W, H, blocked)
					&& inZone(tpl, x, y, plans[l].zone, zi, W, H)
					&& entranceOpen(tpl, x, y, l, W, H, blocked, reach)
					&& opensInto(l, tpl, x, y, zi)) {
					if (!crowded(x, y)) return c;
					if (fallback < 0) fallback = c;
				}
			}
			return fallback;
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
		// Guards at portals (0 Off, 1 On, 2 Template, the default) owns the monolith ends; Guards at bottlenecks keeps the gates
		const portalState = (p.guardPortals === undefined || p.guardPortals === null || !Number.isFinite(Number(p.guardPortals))) ? 2 : Math.max(0, Math.min(2, Math.round(Number(p.guardPortals))));
		const linkGuards = ((params.zonePlan && params.zonePlan.connections) || []).map(c => Number(c.guard) || 0).filter(g => g > 0).sort((u, v) => u - v);
		const guardEnd = (l, tpl, x, y, z, strength, portal = false) => {
			if (portal) {
				if (portalState === 0 || process.env.VMAPGEN_PORTAL_GUARD === '0') return false;
				if (!(strength > 0)) { if (portalState !== 1) return false; strength = linkGuards[linkGuards.length >> 1] || 5000; }
				// On means a monster in front of every end: engineGuard places none under about 4200 at the normal strength (Nostalgia's links carry 3000,
				// and every extra pair's end stood bare at On, 8 of 40 ends on a 144x144 two-level map), so On guards with at least 5000
				if (portalState === 1) strength = Math.max(strength, 5000);
			} else if (!(strength > 0) || process.env.VMAPGEN_PORTAL_GUARD === '0' || Number(p.guardBottlenecks) === 0) return false;
			const meta = plans[l].zoneMeta;
			const concrete = !!(objectPools && objectPools.guards && meta);
			const g = engineGuard(scaledLinkGuard(strength, p), 1 + Math.round(p.monsterStrength || 0), rng, true,
				concrete ? zoneGuardPool(objectPools.guards, meta[z] && meta[z].spec) : undefined);
			if (!g) return false;
			const monster = OBJECT_TEMPLATES.randomMonster;
			const ends = otherEnds(l, x, y);
			// the approach tile whose ring covers the most of the approach first: from the middle one a guard
			// seals the gate or monolith, from an end tile the far side stays open (the engine's every gate and
			// monolith is sealed behind its guard; ours 0.28, tools/mapsight score 2026-10-01).
			// VMAPGEN_GUARD_COVER=0 keeps the approach order.
			const cells = approachCells(tpl, x, y, l, W, H, blocked);
			if (process.env.VMAPGEN_GUARD_COVER !== '0') {
				const uncovered = c => cells.filter(d => Math.abs(d % W - c % W) > 1 || Math.abs(((d / W) | 0) - ((c / W) | 0)) > 1).length;
				cells.sort((a, b) => uncovered(a) - uncovered(b));
			}
			// of the tiles that cover as much, one 3 or more from every other stack first (the guard spacing of 2026-10-08; on K's 36x36 the gate and
			// monolith guards stood beside the pile guards laid before them)
			// on a map far below its template's smallest size (under 30% of its tiles; K, 2026-10-08: "fewer guards and fewer piles is fine if absolutely
			// necessary"), an end whose every tile is within 2 of another stack is left to that stack: on a 36x36 the gate and monolith guards were 18 of
			// about 45 stacks and most of the crowding
			let crowdedOnly = false;
			const f = p.zonePlan && p.zonePlan.minTiles ? W * H * plans.length / p.zonePlan.minTiles : 1;
			{
				const mons = plans[l].objects.filter(o => (o.l || 0) === l && /^(monster|randomMonster)/.test(o.type));
				const tight = c => mons.some(m => Math.max(Math.abs(m.x - c % W), Math.abs(m.y - ((c / W) | 0))) <= 2);
				const unc = new Map(cells.map(c => [c, cells.filter(d => Math.abs(d % W - c % W) > 1 || Math.abs(((d / W) | 0) - ((c / W) | 0)) > 1).length]));
				// far below the template's size a tile clear of other stacks comes before coverage
				if (f < 0.3) cells.sort((a, b) => ((tight(a) ? 1 : 0) - (tight(b) ? 1 : 0)) || (unc.get(a) - unc.get(b)));
				else cells.sort((a, b) => (unc.get(a) - unc.get(b)) || ((tight(a) ? 1 : 0) - (tight(b) ? 1 : 0)));
				if (f < 0.3 && cells.length && cells.every(tight)) crowdedOnly = true;
			}
			if (crowdedOnly) { const sc = objectPools && (objectPools.__smallCut || (objectPools.__smallCut = { piles: 0, guards: 0, of: 0, f })); if (sc) sc.ends = (sc.ends || 0) + 1; return false; }
			// the last choice at Guards at portals On: a tile reserved only by a leftover that nothing holds any more (a road, a doorway's cells and a town's
			// forecourt still refuse): all four tiles before an end in a start zone were such, the town having moved off its first spot, and no guard fitted
			// (Nostalgia 144x144 two levels seed 2, the monolith at (140,138)). VMAPGEN_PORTAL_RESERVED_GUARD=0 off.
			const heldNow = c => !!(plans[l].roadCells && plans[l].roadCells.has(c))
					|| (plans[l].openings || []).some(o => (o.hole || []).includes(c) || (o.inner || []).includes(c))
					|| (towns || []).some(tw => (tw.l || 0) === l && (tw.gates || []).some(([tx, ty]) => Math.abs(tx - (c % W)) <= 2 && Math.abs(ty - ((c / W) | 0)) <= 2));
			const roadFit = (gx, gy) => portal && portalState === 1 && process.env.VMAPGEN_PORTAL_RESERVED_GUARD !== '0'
					&& blockingCells(monster, gx, gy).every(([fx, fy]) => fx >= 0 && fy >= 0 && fx < W && fy < H && !(blocked[l * W * H + fy * W + fx] & OCCUPIED) && !heldNow(fy * W + fx));
			for (const clear of [true, false, 'road'])
				for (const c of cells) {
					const gx = c % W, gy = (c / W) | 0;
					if (clear === true && covers(ends, monster, gx, gy)) continue;
					if (clear === 'road' ? !roadFit(gx, gy) : !footprintFits(monster, gx, gy, l, W, H, blocked, true)) continue;
					const e = objectEntry(`randomMonsterLevel${g.level}`, gx, gy, l, monster, 'object',
						{ character: 'hostile', amount: scaledAmount(g.amount, p) });
					if (concrete) e.guardCreature = g.creature;
					plans[l].objects.push(e);
					reserveCell(blocked, l, W, H, c);
					markApproach(monster, gx, gy, l, W, H, blocked);
					if (!clear && process.env.VMAPGEN_GATE_TRACE)
						console.error(`[gate] level ${l}: the guard at (${gx},${gy}) also covers another link's end`);
					// The rest of the way in closes: an approach tile the guard's ring does not reach takes a one-tile
					// obstacle, as the engine walls a guarded object's accessible ground but the guard's path. A monolith
					// with ways in on two sides stood open behind its guard (0.17 of ours, the engine's none, 2026-10-02).
					// VMAPGEN_END_SEAL=0 leaves them open.
					if (process.env.VMAPGEN_END_SEAL !== '0')
						for (const d of cells) {
							if (Math.abs(d % W - gx) <= 1 && Math.abs(((d / W) | 0) - gy) <= 1) continue;
							const why = r => { if (process.env.VMAPGEN_GATE_TRACE) console.error(`[gate] level ${l}: end at (${x},${y}) left open at (${d % W},${(d / W) | 0}): ${r}`); };
							if (blocked[l * W * H + d] & OCCUPIED) { why('occupied'); continue; }
							// reserved is fine when nothing holds it any more: a road laid early and pruned left its tiles
							// reserved; a road tile now, a doorway's cells or a town's forecourt still refuse
							if (blocked[l * W * H + d] & RESERVED) {
								const dx0 = d % W, dy0 = (d / W) | 0;
								const held = (plans[l].roadCells && plans[l].roadCells.has(d))
									|| (plans[l].openings || []).some(o => (o.hole || []).includes(d) || (o.inner || []).includes(d))
									|| (towns || []).some(tw => (tw.l || 0) === l && (tw.gates || []).some(([tx, ty]) => Math.abs(tx - dx0) <= 2 && Math.abs(ty - dy0) <= 2));
								if (held) { why('reserved'); continue; }
							}
							const terr = plans[l].biomeTerrain && plans[l].biomeTerrain[plans[l].zone[d]];
							const sg = terr && singleTemplate(terr, rng);
							if (!sg || !sg.tpl.mask || sg.tpl.mask.length !== 1 || sg.tpl.mask[0].length !== 1) { why('no one-tile art for ' + terr); continue; }
							if (!conn[l].accepts([d])) { why('would cut the level'); continue; }
							plans[l].objects.push(objectEntry(sg.type, d % W, (d / W) | 0, l, sg.tpl, sg.subtype || 'object'));
							footprintBlock(sg.tpl, d % W, (d / W) | 0, l, W, H, blocked);
							conn[l].refresh();
						}
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
		// where each link's gate pairs stand, for Gates between levels (an extra pair keeps 10 tiles from the link's first)
		const gateAt = new Map();
		const placeGate = (c, extra) => {
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
			// the pair held for this link goes first; with the engine's weighting, the common tiles farthest from both
			// levels' skeletons go first (above), the held pair among them
			const held = extra ? undefined : heldPair.get(p.zonePlan.connections.indexOf(c));
			if (lateFar) {
				const s0 = skeleton(0), s1 = skeleton(1);
				const r0 = rimDistance(plans[0].zone, W, H), r1 = rimDistance(plans[1].zone, W, H);
				if (held !== undefined && !cand.includes(held)) cand.push(held);
				const w = new Map(cand.map(c2 => [c2, (r0[c2] >= 3 && r1[c2] >= 3 ? 1e4 : 0) + farFrom(s0, c2) * farFrom(s1, c2)]));
				cand.sort((a, b) => w.get(b) - w.get(a));
				// the held site first all the same: roads were drawn to it before the fill (a gate moved elsewhere left its
				// road ending at nothing, seed 1 with the road spline layer)
				if (held !== undefined) { cand.splice(cand.indexOf(held), 1); cand.unshift(held); }
			} else if (held !== undefined) cand.unshift(held);
			const reach = reachNow();
			let done = false;
			for (const cell of cand) {
				const x = cell % W, y = (cell / W) | 0;
				if (extra && (gateAt.get(c) || []).some(([gx, gy]) => Math.max(Math.abs(gx - x), Math.abs(gy - y)) < 10)) continue;
				if (!footprintFits(surfaceTpl, x, y, 0, W, H, blocked)) continue;
				if (!footprintFits(underTpl, x, y, 1, W, H, blocked)) continue;
				if (!inZone(surfaceTpl, x, y, plans[0].zone, lo.i, W, H)
					|| !inZone(underTpl, x, y, plans[1].zone, hi.i, W, H)) continue;
				if (!entranceOpen(surfaceTpl, x, y, 0, W, H, blocked, reach[0])) continue;
				// the underground half is itself the way in, so its pocket
				// does not have to be reachable before the gate exists; on a
				// split level it does stand on its zone's own piece, or a gate
				// in a sealed chamber stranded its whole surface piece
				// (Coldshadow's Fantasy seed 7, zones 8 and 16, 2026-10-01)
				if (!entranceOpen(underTpl, x, y, 1, W, H, blocked, splitLevels(p) ? reach[1] : null)) continue;
				const wallsS = blockingCells(surfaceTpl, x, y).map(([a, b]) => b * W + a);
				const wallsU = blockingCells(underTpl, x, y).map(([a, b]) => b * W + a);
				if (!conn[0].accepts(wallsS) || !conn[1].accepts(wallsU)) continue;
				if (!opensInto(0, surfaceTpl, x, y, lo.i) || !opensInto(1, underTpl, x, y, hi.i)) continue;
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
				(gateAt.get(c) || gateAt.set(c, []).get(c)).push([x, y]);
				done = true;
				break;
			}
			return done;
		};
		for (const c of crossConns) if (!placeGate(c, false)) needPortal.push(c);
		// Gates between levels on a template (K, 2026-10-05: every lever acts on every template): 1x is the template's own gates, one pair a
		// link. Above it a share (r - 1) of the links that hold a gate pair gain a second pair in the same two zones, guarded like the link
		// (the engine adds no gate of its own; the gates of the map's own, below, stay out of a template). Below 1x the template keeps its gates:
		// a link it carries is never taken away. 2x is a second pair on every link.
		const gateRatio = Number.isFinite(Number(p.subterraneanGateRatio)) ? Number(p.subterraneanGateRatio) : 1;
		if (gateRatio > 1 && crossConns.length) {
			const gl = crossConns.filter(c => gateAt.has(c));
			for (let i = gl.length - 1; i > 0; i--) { const j = (rng() * (i + 1)) | 0; [gl[i], gl[j]] = [gl[j], gl[i]]; }
			let want = Math.round(gl.length * Math.min(1, gateRatio - 1)), extras = 0;
			for (const c of gl) { if (want <= 0) break; if (placeGate(c, true)) { want--; extras++; } }
			if (extras) console.error(`[gen] Gates between levels ${gateRatio}x: ${extras} link(s) gained a second gate pair`);
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
			// a surface zone reached only through this link has no ground a hero walks to yet: any open cell of it then,
			// the monolith being its way in (K's 36x36 two levels, seed 2102980891: the idle start zone 3, 2026-10-04)
			let ca = zoneCell(0, lo.i, reach[0], tpl);
			if (ca < 0 && process.env.VMAPGEN_PORTAL_CARVE !== '0') ca = zoneCell(0, lo.i, null, tpl);
			// and a surface zone with no free cell at all makes room over its scenery (sceneryRoom): K's s2102980891, the
			// idle start zone 3, two towns in a crowded zone
			if (ca < 0 && process.env.VMAPGEN_PORTAL_CARVE !== '0') {
				const spot = sceneryRoom(plans[0], 0, W, H, blocked, tpl, z => z === lo.i, () => 0);
				if (spot) { clearScenery(plans[0], 0, W, H, blocked, spot); ca = spot.y * W + spot.x; }
			}
			let cb = zoneCell(1, hi.i, splitLevels(p) ? reach[1] : null, tpl);
			// an underground zone with no room for the monolith gets a room carved for it, beside its open floor and near
			// its centre: a small two-level Coldshadow's underground zones were almost all rock (zone 17: 6 open tiles),
			// neither a gate nor a monolith fitted, the starts' links down were lost, and the sweep emptied every zone past
			// the starts (K's 36x36 seed 2102980891, 2026-10-04). VMAPGEN_PORTAL_CARVE=0 off.
			if (ca >= 0 && cb < 0 && plans[1].openMask && process.env.VMAPGEN_PORTAL_CARVE !== '0') {
				const open = plans[1].openMask, zone1 = plans[1].zone, base1 = W * H;
				const held = new Set();
				for (const o of plans[1].objects) if ((o.l || 0) === 1 && o.template)
					for (const [fx, fy] of blockingCells(o.template, o.x, o.y)) held.add(fy * W + fx);
				let sx = 0, sy = 0, n = 0;
				for (let i = 0; i < W * H; i++) if (zone1[i] === hi.i) { sx += i % W; sy += (i / W) | 0; n++; }
				if (n) {
					const cx = sx / n, cy = sy / n;
					let best = -1, bd = Infinity;
					for (let i = 0; i < W * H; i++) {
						if (zone1[i] !== hi.i || !open[i] || held.has(i)) continue;
						const d = (i % W - cx) ** 2 + (((i / W) | 0) - cy) ** 2;
						if (d < bd) { bd = d; best = i; }
					}
					if (best >= 0) {
						const bx = best % W, by = (best / W) | 0;
						for (let dy = -2; dy <= 1; dy++) for (let dx = -2; dx <= 2; dx++) {
							const x = bx + dx, y = by + dy;
							if (x < 2 || y < 2 || x >= W - 2 || y >= H - 2) continue;
							const c2 = y * W + x;
							if (zone1[c2] !== hi.i || held.has(c2)) continue;
							open[c2] = 1;
							blocked[base1 + c2] &= ~OCCUPIED;
						}
						cb = zoneCell(1, hi.i, splitLevels(p) ? reach[1] : null, tpl);
						if (cb >= 0) console.error(`[gen] cross-level link zone ${lo.i}<->${hi.i}: a room carved underground at (${bx},${by}) for its monolith`);
					}
				}
			}
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
			guardEnd(0, tpl, ax, ay, lo.i, c.guard, true);
			guardEnd(1, tpl, bx, by, hi.i, c.guard, true);
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
			// below the surface the largest region unless a start actually lies
			// there (mainComponent's own hasStart preference), matching the
			// surface side now that starts can be underground too (2026-09-27's
			// own undergroundStarts feature) - an empty list here always picked
			// the biggest region with no regard for which one held a start, so a
			// smaller start zone elsewhere could go ungated entirely (2026-09-29,
			// a free-layout underground start left with no way out at all).
			const reach = [0, 1].map(l => mainComponent(W, H, l, blocked, startsOn(l)));
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
				// an extra pair (no template link): guarded only under Guards at portals On
				guardEnd(0, tpl, ca % W, (ca / W) | 0, plans[0].zone[ca], 0, true);
				guardEnd(1, tpl, cb % W, (cb / W) | 0, plans[1].zone[cb], 0, true);
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

			// The loop above reaches one underground region: mainComponent returns a
			// single region, so with two underground starts in two separate
			// components every gate lands in whichever wins the hasStart/size
			// tie-break, and a start whose own ground meets no gate is shut in
			// (free layout 4p 72x72 seed 1, 2026-09-29: "tan home 200, gate none",
			// 213 of 5184 tiles reachable). Find those starts by flooding from the
			// gates' own approach cells alone, then give each one guarded way out.
			// That way out cannot keep the loop's rule of never standing inside a
			// start's zone, since a shut-in start's ground may be nothing but its
			// own zone. It is guarded at both ends, so it is no free passage past
			// the start's doorways, and its far end never lands in another start's
			// zone. (A first version tested the start's own cell, which its town
			// blocks, so it patched every underground start and left unguarded
			// gates standing in start zones; caught the same day.)
			const ugStarts = startsOn(1);
			const beside = (s, reached) => {
				for (let dy = -3; dy <= 3; dy++)
					for (let dx = -3; dx <= 3; dx++) {
						const x = s.x + dx, y = s.y + dy;
						if (x >= 0 && y >= 0 && x < W && y < H && reached[y * W + x]) return true;
					}
				return false;
			};
			const startZone = (l, c) => plans[l].classes && plans[l].classes[plans[l].zone[c]] === BIOME_CLASS.PLAYER;
			// a pile value, so it clears engineGuard's 2000 minimum strength at every monster
			// strength setting (3500 gave none at Normal); startFairness evens it with the
			// other starts' ways out afterwards
			const SHUT_IN_GUARD = 7000;
			let patched = 0;
			for (const s of ugStarts) {
				// and on through the level's own portal pairs (a template link with no shared border below)
				const reached = followLinks(reachableUnion(W, H, 1, blocked, plans[1].entrances || []), plans[1].links,
					W, H, c => !!(blocked[W * H + c] & OCCUPIED));
				if (beside(s, reached)) continue;   // its ground already meets a way in
				const zi = plans[1].zone[s.y * W + s.x];
				const reachSurface = splitLevels(p) ? zonePieces(W, H, 0, blocked, plans[0].zone, startsOn(0))
					: mainComponent(W, H, 0, blocked, startsOn(0));
				const zoneCells = [];
				let zx = 0, zy = 0;
				for (let i = 0; i < W * H; i++)
					if (plans[1].zone[i] === zi) { zoneCells.push(i); zx += i % W; zy += (i / W) | 0; }
				if (!zoneCells.length) continue;
				zx = zx / zoneCells.length | 0; zy = zy / zoneCells.length | 0;
				zoneCells.sort((a, b) => ((a % W - zx) ** 2 + (((a / W) | 0) - zy) ** 2)
					- ((b % W - zx) ** 2 + (((b / W) | 0) - zy) ** 2));
				const wallsOf = (tpl, x, y) => blockingCells(tpl, x, y).map(([a, b]) => b * W + a);
				// a gate first (the same x,y on both levels): a cell of the start's own
				// zone, nearest its centre, whose surface half is not in a start's zone
				let gate = -1;
				for (const c of zoneCells) {
					const x = c % W, y = (c / W) | 0;
					if (startZone(0, c)) continue;
					if (!footprintFits(underTpl, x, y, 1, W, H, blocked)
						|| !footprintFits(surfaceTpl, x, y, 0, W, H, blocked)) continue;
					if (!inZone(underTpl, x, y, plans[1].zone, zi, W, H)) continue;
					if (!entranceOpen(underTpl, x, y, 1, W, H, blocked, null)
						|| !entranceOpen(surfaceTpl, x, y, 0, W, H, blocked, reachSurface)) continue;
					if (!conn[0].accepts(wallsOf(surfaceTpl, x, y)) || !conn[1].accepts(wallsOf(underTpl, x, y))) continue;
					gate = c; break;
				}
				if (gate >= 0) {
					const bx = gate % W, by = (gate / W) | 0;
					const pairId = `gate_${bx}_${by}`;
					for (const l of [0, 1]) {
						const tpl = l === 0 ? surfaceTpl : underTpl;
						const entry = objectEntry('subterraneanGate', bx, by, l, tpl, STRUCTURE_SUBTYPE.subterraneanGate);
						entry.pairId = pairId;
						plans[l].objects.push(entry);
						footprintBlock(tpl, bx, by, l, W, H, blocked);
						markApproach(tpl, bx, by, l, W, H, blocked);
						conn[l].refresh();
						(plans[l].entrances = plans[l].entrances || []).push(...approachCells(tpl, bx, by, l, W, H, blocked));
						(plans[l].arrivals = plans[l].arrivals || []).push(...visitableCells(tpl, bx, by)
							.filter(([a, b]) => a >= 0 && b >= 0 && a < W && b < H).map(([a, b]) => b * W + a));
					}
					const g1 = guardEnd(1, underTpl, bx, by, zi, SHUT_IN_GUARD);
					const g0 = guardEnd(0, surfaceTpl, bx, by, plans[0].zone[gate], SHUT_IN_GUARD);
					patched++;
					console.error(`[gen] ${s.color}'s underground start met no way in; gave it a gate at (${bx},${by}), `
						+ `guarded ${g1 && g0 ? 'at both ends' : g1 || g0 ? 'at one end' : 'NOWHERE (no guard cell fit)'}`);
					continue;
				}
				// no x,y that suits both levels: a monolith pair needs no match
				const ch = book.next() || book.shared();
				const uCell = zoneCells.find(c => {
					const x = c % W, y = (c / W) | 0;
					return footprintFits(ch.tpl, x, y, 1, W, H, blocked) && inZone(ch.tpl, x, y, plans[1].zone, zi, W, H)
						&& entranceOpen(ch.tpl, x, y, 1, W, H, blocked, null)
						&& conn[1].accepts(wallsOf(ch.tpl, x, y));
				});
				let sCell = -1;
				for (const c of order) {
					const x = c % W, y = (c / W) | 0;
					if (startZone(0, c)) continue;
					if (!footprintFits(ch.tpl, x, y, 0, W, H, blocked)) continue;
					if (!entranceOpen(ch.tpl, x, y, 0, W, H, blocked, reachSurface)) continue;
					if (!conn[0].accepts(wallsOf(ch.tpl, x, y))) continue;
					sCell = c; break;
				}
				if (uCell === undefined || sCell < 0) {
					console.error(`[gen] ${s.color}'s underground start met no way in, and no gate or monolith `
						+ 'site could be found either: the map ships with this start shut in');
					continue;
				}
				book.take(ch);
				const pairId = `portal_${ch.subtype}`;
				const ends = [[sCell % W, (sCell / W) | 0], [uCell % W, (uCell / W) | 0]];
				ends.forEach(([x, y], l) => {
					const e = monolithEntry(x, y, l, ch);
					e.pairId = pairId;
					plans[l].objects.push(e);
					footprintBlock(ch.tpl, x, y, l, W, H, blocked);
					markApproach(ch.tpl, x, y, l, W, H, blocked);
					conn[l].refresh();
				});
				const [ubx, uby] = ends[1];
				(plans[1].entrances = plans[1].entrances || []).push(...approachCells(ch.tpl, ubx, uby, 1, W, H, blocked));
				(plans[1].arrivals = plans[1].arrivals || []).push(...visitableCells(ch.tpl, ubx, uby)
					.filter(([a, b]) => a >= 0 && b >= 0 && a < W && b < H).map(([a, b]) => b * W + a));
				const g1 = guardEnd(1, ch.tpl, ubx, uby, zi, SHUT_IN_GUARD, true);
				const g0 = guardEnd(0, ch.tpl, ends[0][0], ends[0][1], plans[0].zone[sCell], SHUT_IN_GUARD, true);
				patched++;
				console.error(`[gen] ${s.color}'s underground start met no way in; gave it a monolith pair, `
					+ `guarded ${g1 && g0 ? 'at both ends' : g1 || g0 ? 'at one end' : 'NOWHERE (no guard cell fit)'}`);
			}
			if (patched)
				console.error(`[gen] ${patched} shut-in underground start(s) given a guarded way out after the gate loop missed them`);

	}

	// The roads went down in planLevel, before the walls and ridges. The gates
	// and monoliths of links with a road that landed here rather than on a
	// held site join them now, over whatever ground is left (roadplan.js).
	const roadsFirst = process.env.VMAPGEN_ROADS !== 'late';
	if (roadsFirst)
		for (let l = 0; l < levels; l++) {
			if (!(plans[l].roadNodes || []).length) continue;
			const r = planRoads({ plan: { zone: plans[l].zone, openings: [], roadCells: plans[l].roadCells,
				roadNodes: plans[l].roadNodes, p: plans[l].p, openMask: plans[l].openMask }, towns: [],
				W, H, blocked, l, approach: t => roadApproach(t, W, H, blocked, l) });
			(plans[l].roadFailed = plans[l].roadFailed || []).push(...r.failedNodes);
			(plans[l].roadEdges = plans[l].roadEdges || []).push(...(r.edges || []));
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

	// A zone's pieces cut apart by the structural walls (interior ridges, rim rows) are joined before the content goes in, so the fill reaches
	// them: the fill puts content only on ground a hero reaches from the zone's ways in, and a plain walled off then and opened by the join
	// after the fill stayed bare (template maps only: the free layout's fill and its start balance were measured without it; K 10-05 21:45, "0 loot ... or a lot less than their neighbours": zone 21 of seed 7 at his water settings,
	// 264 of 1160 open tiles left out of the fill, a 24x18 plain with no pile on it). The late join stays as it was. VMAPGEN_JOIN_EARLY=0 off.
	if (p.zonePlan && process.env.VMAPGEN_JOIN_EARLY !== '0' && process.env.VMAPGEN_JOIN_WAYS !== '0')
		for (let l = 0; l < levels; l++) {
			const r = joinZoneWaysIn(plans[l], l, W, H, blocked, { early: true });
			if (r.joined) console.error(`[gen] level ${l}: before the fill, pieces of zones joined: ${r.joined} (${r.rock} rock tile(s) carved, ${r.cleared} scenery piece(s) cleared)`);
		}
	// Content fill runs last, after the gates have claimed their ground.
	phase('resources');
	plans.forEach((plan, i) => { if (i > 0) phase('resourcesBelow'); fillLevel(plan, W, H, blocked); });
	if (process.env.VMAPGEN_RING_TRACE) console.error('[ringpass] after fill ' + plans.map(pl => pl.objects.filter(o => o.__ring).length).join('/'));

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
		// a town the fill put somewhere other than its held spot (refused there) has no road yet: it joins its zone's roads
		// like any node missed before the fill (K's castle with no road, 2026-10-02)
		if (roadsFirst && process.env.VMAPGEN_ROAD_SPLINES !== '0')
			for (const o of plans[l].objects) {
				if ((o.l || 0) !== l || !o.template || !/^(town|randomTown)$/.test(o.type)) continue;
				const app = [];
				for (const [vx, vy] of visitableCells(o.template, o.x, o.y)) for (const [dx, dy] of allowedDirs(o.template)) { const x = vx + dx, y = vy + dy; if (x >= 0 && y >= 0 && x < W && y < H) app.push(y * W + x); }
				if (!app.length || app.some(c => plans[l].roadCells.has(c))) continue;
				(plans[l].roadFailed = plans[l].roadFailed || []).push({ z: plans[l].zone[app[0]], cells: app });
			}
		// a node missed before the fill is joined only if something was built there (a moved town leaves its held spot empty)
		if (roadsFirst && process.env.VMAPGEN_ROAD_SPLINES !== '0' && plans[l].roadFailed) {
			const built = new Set();
			for (const o of plans[l].objects) if ((o.l || 0) === l && o.template && /^(town$|randomTown$|subterraneanGate|monolith|mine$)/.test(o.type))
				for (const [vx, vy] of visitableCells(o.template, o.x, o.y)) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) built.add((vy + dy) * W + vx + dx);
			plans[l].roadFailed = plans[l].roadFailed.filter(f => f.cells.some(c => built.has(c)));
		}
		const added = (roadsFirst ? joinFailed(plans[l].roadFailed, plans[l].roadCells, plans[l].zone, W, H, blocked, l) : 0)
			+ (p.roadNetwork === 0 || (templateRoads && towns.filter(t => (t.l || 0) === l && t.gates).length > 1) ? 0
				: buildRoadNetwork(here, plans[l].roadCells, W, H, blocked, l));
		const orphans = pruneOrphanRoads(plans[l].roadCells, W, H);
		const pruneLate = process.env.VMAPGEN_ROAD_PRUNE_LATE !== '0';
		let tails = 0;
		const prune = () => {
		// Pruned after the thinning and the entrance stubs (VMAPGEN_ROAD_PRUNE_LATE=0 is the old order and radius): both
		// can leave a dead end or a gap behind, and a town's destination was every tile within 3 of its gate, so a road
		// running past a town's side to nothing stayed (mapsight check, Coldshadow's Fantasy 2026-10-02: 1 to 11 bad road
		// ends a map, the engine none). A destination is now the ground right at an entrance.
		// Road ends that lead to nothing go (K: "tails going nowhere"), back to
		// the last junction, unless they end at a town, a mine or a passage
		// between levels: an opening's road patch the network passed by, a spur
		// the late network left.
		if (roadsFirst) {
			const dest = new Set();
			const near = (vx, vy, r) => {
				for (let dy = -r; dy <= r; dy++)
					for (let dx = -r; dx <= r; dx++) {
						const x = vx + dx, y = vy + dy;
						if (x >= 0 && y >= 0 && x < W && y < H) dest.add(y * W + x);
					}
			};
			for (const t of here) for (const [gx, gy] of t.gates || []) near(gx, gy, process.env.VMAPGEN_ROAD_PRUNE_LATE === '0' ? 3 : 1);
			for (const o of plans[l].objects)
				if ((o.l || 0) === l && o.template && /^(mine|subterraneanGate|monolith)/.test(o.type))
					for (const [vx, vy] of visitableCells(o.template, o.x, o.y)) near(vx, vy, 1);
			// with the spline layer a tree's every leaf is a node: a town, a gate, a monolith, a mine, or a doorway's guard
			if (process.env.VMAPGEN_ROAD_SPLINES !== '0') {
				for (const o of plans[l].objects) if ((o.l || 0) === l && /^(randomMonster|monster)/.test(o.type)) near(o.x, o.y, 1);
				for (const op of plans[l].openings || []) if (op.kind === 'openRoad') for (const c of op.hole || []) near(c % W, (c / W) | 0, 1);
				for (const o of plans[l].objects) if ((o.l || 0) === l && o.template && /^(town|randomTown)$/.test(o.type)) for (const [vx, vy] of visitableCells(o.template, o.x, o.y)) near(vx, vy, 1);
			}
			tails = pruneTails(plans[l].roadCells, dest, W, H);
		}
		};
		if (!pruneLate) prune();
		// The road runs onto the entrance itself. K, 2026-09-30: "Roads still aren't touching entry points for
		// the buildings they are supposed to interface with." In the 71 real maps the road is ON the visitable
		// tile of 1076 of 1078 towns and of 72% of monolith ends and 81% of gates (tools/map_metrics.js,
		// roadAtEntrance); ours stopped one tile short on every one, on the open ground the road planner reaches
		// (roadnet.js approach). So wherever a road reached the ground beside an entrance, or within three tiles
		// of it, the entrance tile joins it (gateStubs).
		// Real roads are one tile wide: none of the 71 real maps has a 2x2 block of road, and ours had 5% of road tiles in
		// one, where the tile art draws rungs and loops between them (K: "8-looping road chunk that goes nowhere").
		const thinned = process.env.VMAPGEN_THIN_ROADS === '0' ? 0 : process.env.VMAPGEN_ROAD_SPLINES !== '0' ? require('./roadsplines').thinSafe(plans[l].roadCells, W, H) : thinRoads(plans[l].roadCells, W, H);
		if (process.env.VMAPGEN_ROAD_SPLINES !== '0') {
			const keepR = new Set();
			for (const o of plans[l].objects) if ((o.l || 0) === l && o.template && /^(town$|randomTown$|subterraneanGate|monolith)/.test(o.type)) for (const [vx, vy] of visitableCells(o.template, o.x, o.y)) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) keepR.add((vy + dy) * W + vx + dx);
			for (const t of here) for (const [gx, gy] of t.gates || []) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) keepR.add((gy + dy) * W + gx + dx);
			// doorways (where the link's guard stands) are ends too: a loop broken next to one cut its road away (seed 3)
			for (const op of plans[l].openings || []) if (op.kind === 'openRoad') for (const c of op.hole || []) keepR.add(c);
			for (const o of plans[l].objects) if ((o.l || 0) === l && /^(randomMonster|monster)/.test(o.type)) keepR.add(o.y * W + o.x);
			const lc = require('./roadsplines').breakLoops(plans[l].roadCells, W, H, keepR);
			if (lc) console.error(`[gen] level ${l}: ${lc} road tile(s) of small loops removed`);
		}
		if (thinned) console.error(`[gen] level ${l}: ${thinned} road tile(s) dropped to keep roads one tile wide`);
		const stubs = process.env.VMAPGEN_GATE_STUBS === '0' ? 0 : gateStubs(plans[l], here, l, W, H, blocked);
		if (stubs) console.error(`[gen] level ${l}: ${stubs} road tile(s) joined town gates, monoliths and gates to their entrances`);
		if (pruneLate) { prune(); pruneOrphanRoads(plans[l].roadCells, W, H); }
		// Each zone's road finished as one tree over its real nodes (towns as placed, gates, monoliths, doorway guards):
		// pieces that each reach one are joined by the same curved routing, and a town with no road joins its zone's
		// roads. Part of the spline layer: the plan moved some ends (a town refused its held spot, a gate sited late),
		// and the leaf rule then left the zone in pieces (seed 3: the central zone's gates cut off).
		if (process.env.VMAPGEN_ROAD_SPLINES !== '0') {
			const R = plans[l].roadCells, zl = plans[l].zone, base = l * W * H, D4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
			const nodeTiles = new Map();   // zone -> [ [tiles of one node] ]
			const addN = (z, tiles) => { if (z === undefined || z < 0 || !tiles.length) return; if (!nodeTiles.has(z)) nodeTiles.set(z, []); nodeTiles.get(z).push(tiles); };
			for (const o of plans[l].objects) {
				if ((o.l || 0) !== l || !o.template) continue;
				if (/^(town$|randomTown$|subterraneanGate|monolith)/.test(o.type)) {
					const t = [];
					for (const [vx, vy] of visitableCells(o.template, o.x, o.y)) for (const [dx, dy] of [[0, 0], ...D4, [1, 1], [1, -1], [-1, 1], [-1, -1]]) { const x = vx + dx, y = vy + dy; if (x >= 0 && y >= 0 && x < W && y < H) t.push(y * W + x); }
					addN(zl[t[0]], t);
				}
			}
			for (const op of plans[l].openings || []) if (op.kind === 'openRoad') for (const z of [op.a, op.b]) addN(z, (op.hole || []).slice());
			// a road may run under a guard (the engine's roads pass through the link and pile guards): a gate in a pocket
			// whose only way out is its guard is still joined
			const guardTile = new Set(plans[l].objects.filter(o => (o.l || 0) === l && /^(randomMonster|monster)/.test(o.type)).map(o => o.y * W + o.x));
			let joinedN = 0; let clearedN = 0;
			for (const [z, nodes] of nodeTiles) {
				const nodeSet = new Set(nodes.flat());
				for (let round = 0; round < 12; round++) {
					// road pieces over the whole level: two roads of this zone already joined through the zone beyond are one
					// piece (judged inside the zone only, joining them again closed a ring, 2026-10-03)
					const piece = new Map(); let np = 0;
					const mine = () => true;
					for (const c0 of R) {
						if (!mine(c0) || piece.has(c0)) continue;
						const st = [c0]; piece.set(c0, np);
						while (st.length) { const c = st.pop(), x = c % W, y = (c / W) | 0; for (const [dx, dy] of D4) { const m = (y + dy) * W + x + dx; if (x + dx >= 0 && y + dy >= 0 && x + dx < W && y + dy < H && R.has(m) && !piece.has(m) && mine(m)) { piece.set(m, np); st.push(m); } } }
						np++;
					}
					// the groups to join: each node is in the piece its tiles touch, or alone; pieces that meet at one node (a
					// town with a road at two sides) are one group, so no ring is drawn round it
					const up = new Map(), find = v => { while (up.has(v) && up.get(v) !== v) v = up.get(v); return v; };
					for (const t of nodes) { const ps = [...new Set(t.filter(c => piece.has(c)).map(c => piece.get(c)))]; for (const v of ps.slice(1)) { const a2 = find(ps[0]), b2 = find(v); if (a2 !== b2) up.set(b2, a2); } }
					for (const [c, v] of piece) piece.set(c, find(v));
					const groups = new Map(); let lone = 0;
					for (const t of nodes) {
						const ps = [...new Set(t.filter(c => piece.has(c)).map(c => piece.get(c)))];
						const k = ps.length ? 'p' + ps[0] : 'n' + (lone++);
						if (!groups.has(k)) groups.set(k, { tiles: new Set(), road: ps.length > 0 });
						const g = groups.get(k);
						if (ps.length) for (const [c, v] of piece) { if (v === ps[0]) g.tiles.add(c); } else t.forEach(c => g.tiles.add(c));
					}
					if (process.env.VMAPGEN_ROAD_TRACE && round === 0) console.error(`[roads] level ${l}: zone ${z} nodes ${nodes.map(t => (t[0] % W) + ',' + ((t[0] / W) | 0) + 'x' + t.length).join(' ')} groups ${groups.size}`);
					if (groups.size < 2) break;
					const list = [...groups.values()].sort((a2, b2) => b2.tiles.size - a2.tiles.size);
					const main = list[0], open = c => zl[c] === z && (!(blocked[base + c] & OCCUPIED) || guardTile.has(c));
					let did = false;
					for (const g of list.slice(1)) {
						let p2 = null;
						for (const st of g.tiles) { if (!open(st) && !R.has(st)) continue; p2 = require('./roadsplines').routeEdge(st, main.tiles, { W, H, open }); if (p2) break; }
						// a node in a pocket the zone's own ground does not reach (a gate opening on the zone beyond): the road the
						// pocket opens on, over any zone's open ground, a short way only
						if (!p2) {
							const openAny = c => !(blocked[base + c] & OCCUPIED) || guardTile.has(c), other = new Set([...R].filter(c => !g.tiles.has(c)));
							for (const st of g.tiles) { if (!openAny(st) && !R.has(st)) continue; const q2 = require('./roadsplines').routeEdge(st, other, { W, H, open: openAny }); if (q2 && q2.length <= 24) { p2 = q2; break; } }
						}
						// a node the fill walled in with scenery (a gate sited after it): the road clears its way through the zone's
						// scenery, which the engine never meets because it lays roads before scenery. Each object on the way goes whole.
						if (!p2 && process.env.VMAPGEN_ROAD_CLEAR !== '0') {
							const sceneryAt = new Map();
							for (const o of plans[l].objects) if ((o.l || 0) === l && o.template && o.template.mask && DECOR_TYPES_SET.has(o.type) && !o.template.mask.some(r2 => /[AT]/.test(r2)))
								for (const [fx, fy] of blockingCells(o.template, o.x, o.y)) if (fx >= 0 && fy >= 0 && fx < W && fy < H && zl[fy * W + fx] === z) sceneryAt.set(fy * W + fx, o);
							// no piece on a zone line: it goes whole, and its other cells are the wall (VMAPGEN_ROAD_JOIN_WALL=0 off)
							if (process.env.VMAPGEN_ROAD_JOIN_WALL !== '0') {
								const line = c => { const x = c % W, y = (c / W) | 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const u = x + dx, v = y + dy; if (u >= 0 && v >= 0 && u < W && v < H && zl[v * W + u] >= 0 && zl[v * W + u] !== zl[c]) return true; } return false; };
								for (const [c, o] of [...sceneryAt]) if (blockingCells(o.template, o.x, o.y).some(([fx, fy]) => fx >= 0 && fy >= 0 && fx < W && fy < H && line(fy * W + fx))) sceneryAt.delete(c);
							}
							const openS = c => open(c) || sceneryAt.has(c), costS = c => (sceneryAt.has(c) ? 8 : 1);
							for (const st of g.tiles) { if (!openS(st) && !R.has(st)) continue; p2 = require('./roadsplines').routeEdge(st, main.tiles, { W, H, open: openS, cost: costS }); if (p2) break; }
							if (p2) {
								const gone = new Set(p2.filter(c => sceneryAt.has(c)).map(c => sceneryAt.get(c)));
								const keepCells = new Set();
								for (const o of plans[l].objects) if ((o.l || 0) === l && o.template && !gone.has(o)) for (const [fx, fy] of blockingCells(o.template, o.x, o.y)) keepCells.add(fy * W + fx);
								for (const o of gone) for (const [fx, fy] of blockingCells(o.template, o.x, o.y)) { const c = fy * W + fx; if (fx >= 0 && fy >= 0 && fx < W && fy < H && !keepCells.has(c)) blocked[base + c] &= ~OCCUPIED; }
								plans[l].objects = plans[l].objects.filter(o => !gone.has(o));
								clearedN += gone.size;
							}
						}
						if (process.env.VMAPGEN_ROAD_TRACE) console.error(`[roads] level ${l}: zone ${z} join group of ${g.tiles.size} (${g.road ? 'road' : 'bare'}) at ${[...g.tiles][0] % W},${([...g.tiles][0] / W) | 0} to the tree of ${main.tiles.size}: ${p2 ? p2.length + ' tile(s)' : 'no way'}`);
						if (!p2 && process.env.VMAPGEN_ROAD_TRACE) { const s0 = [...g.tiles][0], sx = s0 % W, sy = (s0 / W) | 0; for (let y = sy - 4; y <= sy + 4; y++) { let ln = '   '; for (let x = sx - 6; x <= sx + 6; x++) { const c = y * W + x; ln += (x < 0 || y < 0 || x >= W || y >= H) ? ' ' : R.has(c) ? (g.tiles.has(c) ? 'S' : main.tiles.has(c) ? 'T' : '#') : (blocked[base + c] & OCCUPIED) ? 'x' : zl[c] === z ? '.' : String(zl[c] % 10); } console.error(ln); } }
						if (!p2) continue;
						for (const c of p2) if (!R.has(c)) { R.add(c); joinedN++; }
						did = true;
						break;
					}
					if (!did) break;
				}
			}
			if (joinedN) console.error(`[gen] level ${l}: road pieces of a zone joined into its tree, ${joinedN} tile(s)${clearedN ? `, ${clearedN} scenery object(s) cleared from the way` : ''}`);
			// the joins above can close a small loop the loop pass before them never saw: once more, last, up to 40 steps,
			// and any loop inside one zone (a zone's road is a tree; the engine's surface roads hold no loop); the template's
			// own ring of linked zones is longer and crosses zones, and stays, as the engine's does
			{
				// kept: the tiles a node is visited from and the tiles beside them a road reaches it on, guards, doorway holes;
				// a node's whole 3x3 kept a ring round a gate whole (2026-10-03)
				const keepAll = new Set(guardTile);
				for (const o of plans[l].objects) {
					if ((o.l || 0) !== l || !o.template || !/^(town$|randomTown$|subterraneanGate|monolith)/.test(o.type)) continue;
					for (const [vx, vy] of visitableCells(o.template, o.x, o.y)) { keepAll.add(vy * W + vx); const below = (vy + 1) * W + vx; if (vy + 1 < H && R.has(below)) keepAll.add(below); }
				}
				for (const op of plans[l].openings || []) if (op.kind === 'openRoad') for (const c of op.hole || []) keepAll.add(c);
				const lc = require('./roadsplines').breakLoops(R, W, H, keepAll, Number(process.env.VMAPGEN_LATE_LOOP || 40), c => zl[c]);
				if (lc) console.error(`[gen] level ${l}: small road loops the joins closed broken, ${lc} tile(s)`);
			}
			// what the loop pass leaves leading nowhere goes: every leaf not at a node is cut back, and a road piece that
			// reaches no building is dropped; the dead-end join below then closes what the cut left a tile or two apart
			{
				const keep3 = new Set(guardTile);
				for (const [, nodes] of nodeTiles) for (const t of nodes) t.forEach(c => keep3.add(c));
				const deg = c => { const x = c % W, y = (c / W) | 0; return D4.filter(([dx, dy]) => x + dx >= 0 && y + dy >= 0 && x + dx < W && y + dy < H && R.has((y + dy) * W + x + dx)).length; };
				let leaf = 0;
				for (let changed = true, g = 0; changed && g < 400; g++) { changed = false; for (const c of [...R]) if (!keep3.has(c) && deg(c) <= 1) { R.delete(c); leaf++; changed = true; } }
				pruneOrphanRoads(R, W, H);
				if (leaf) console.error(`[gen] level ${l}: road leaves at no node after the loop pass cut back, ${leaf} tile(s)`);
			}
			// A dead end a few open tiles from another road piece is the same road broken where the plan moved a door (a
			// hole recorded at one spot, the guard and passage built at another): the shortest open path joins them.
			{
				const leafOf = c => { const x = c % W, y = (c / W) | 0; return D4.filter(([dx, dy]) => x + dx >= 0 && y + dy >= 0 && x + dx < W && y + dy < H && R.has((y + dy) * W + x + dx)).length <= 1; };
				const pieceOf = () => { const pc = new Map(); let n = 0; for (const c0 of R) { if (pc.has(c0)) continue; const st = [c0]; pc.set(c0, n); while (st.length) { const c = st.pop(), x = c % W, y = (c / W) | 0; for (const [dx, dy] of D4) { const m = (y + dy) * W + x + dx; if (x + dx >= 0 && y + dy >= 0 && x + dx < W && y + dy < H && R.has(m) && !pc.has(m)) { pc.set(m, n); st.push(m); } } } n++; } return pc; };
				// the short way may cross scenery, which goes whole (as the zone join above clears it; VMAPGEN_ROAD_CLEAR=0 off)
				const sceneryAt = new Map();
				if (process.env.VMAPGEN_ROAD_CLEAR !== '0')
					for (const o of plans[l].objects) if ((o.l || 0) === l && o.template && o.template.mask && DECOR_TYPES_SET.has(o.type) && !o.template.mask.some(r2 => /[AT]/.test(r2)))
						for (const [fx, fy] of blockingCells(o.template, o.x, o.y)) if (fx >= 0 && fy >= 0 && fx < W && fy < H) sceneryAt.set(fy * W + fx, o);
				// a pickup's tile too (the engine's roads run under low loot, 0.025 a road tile; the pickup stays), and
				// underground one rock tile of the end's own zone, never beside another zone's floor (cut open; a road
				// round a town's corner meets only diagonally otherwise, as the tree builder found)
				const PICKUP = /^(resource|randomResource|treasureChest|campfire|randomArtifact|artifact|spellScroll)/;
				const pickupAt = new Set();
				for (const o of plans[l].objects) if ((o.l || 0) === l && o.template && PICKUP.test(o.type))
					for (const [fx, fy] of blockingCells(o.template, o.x, o.y)) if (fx >= 0 && fy >= 0 && fx < W && fy < H) pickupAt.add(fy * W + fx);
				const om = plans[l].openMask;
				const rockOk = (c, zoneOf) => { if (!om || om[c] || zl[c] !== zoneOf) return false; const x = c % W, y = (c / W) | 0; if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) return false; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const n = (y + dy) * W + x + dx; if (om[n] && zl[n] !== zoneOf) return false; } return true; };
				// never through a zone wall: a step into another zone only where the two are linked by a doorway, and no scenery
				// piece on a zone line goes (two zones' road ends either side of a wall had the wall's mountain cut out, a
				// passage between zones 9 and 19 the template never links: K's line, 72x72 seed 3, 2026-10-04).
				// VMAPGEN_ROAD_JOIN_WALL=0 off.
				const wallSafe = process.env.VMAPGEN_ROAD_JOIN_WALL !== '0';
				const linkedZ = new Set();
				for (const op of plans[l].openings || []) if (op.kind !== 'portal') { linkedZ.add(op.a * 100000 + op.b); linkedZ.add(op.b * 100000 + op.a); }
				const onZoneLine = c => { const x = c % W, y = (c / W) | 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const u = x + dx, v = y + dy; if (u >= 0 && v >= 0 && u < W && v < H && zl[v * W + u] >= 0 && zl[v * W + u] !== zl[c]) return true; } return false; };
				if (wallSafe) for (const [c, o] of [...sceneryAt]) if (blockingCells(o.template, o.x, o.y).some(([fx, fy]) => fx >= 0 && fy >= 0 && fx < W && fy < H && onZoneLine(fy * W + fx))) sceneryAt.delete(c);
				const crossOk = (c, m) => !wallSafe || zl[c] === zl[m] || zl[c] < 0 || zl[m] < 0 || linkedZ.has(zl[c] * 100000 + zl[m]);
				const pass = c => !(blocked[base + c] & OCCUPIED) || guardTile.has(c) || sceneryAt.has(c) || pickupAt.has(c);
				let closed = 0;
				for (let round = 0; round < 40; round++) {
					const pc = pieceOf();
					let did = false;
					for (const c0 of R) {
						if (!leafOf(c0)) continue;
						const prev = new Map([[c0, -1]]), q = [c0];
						let hit = -1;
						for (let qi = 0; qi < q.length && hit < 0; qi++) {
							const c = q[qi];
							let d = 0; for (let k = c; prev.get(k) !== -1; k = prev.get(k)) d++;
							if (d >= 4) continue;
							const x = c % W, y = (c / W) | 0;
							for (const [dx, dy] of D4) {
								const m = (y + dy) * W + x + dx;
								if (x + dx < 0 || y + dy < 0 || x + dx >= W || y + dy >= H || prev.has(m)) continue;
								if (!crossOk(c, m)) continue;
								if (R.has(m)) { if (pc.get(m) !== pc.get(c0)) { prev.set(m, c); hit = m; break; } continue; }
								if (!pass(m) && !rockOk(m, zl[c0])) continue;
								prev.set(m, c); q.push(m);
							}
						}
						if (hit < 0) continue;
						const gone = new Set();
						for (let k = prev.get(hit); k !== c0; k = prev.get(k)) { R.add(k); closed++; if (sceneryAt.has(k)) gone.add(sceneryAt.get(k)); if (om && !om[k]) { om[k] = 1; blocked[base + k] &= ~OCCUPIED; } }
						if (gone.size) {
							const keepCells = new Set();
							for (const o of plans[l].objects) if ((o.l || 0) === l && o.template && !gone.has(o)) for (const [fx, fy] of blockingCells(o.template, o.x, o.y)) keepCells.add(fy * W + fx);
							for (const o of gone) for (const [fx, fy] of blockingCells(o.template, o.x, o.y)) { const c = fy * W + fx; if (fx >= 0 && fy >= 0 && fx < W && fy < H && !keepCells.has(c)) blocked[base + c] &= ~OCCUPIED; for (const [k2, v] of sceneryAt) if (v === o) sceneryAt.delete(k2); }
							plans[l].objects = plans[l].objects.filter(o => !gone.has(o));
						}
						did = true;
						break;
					}
					if (!did) break;
				}
				if (closed) console.error(`[gen] level ${l}: road dead ends joined to the road beside them, ${closed} tile(s)`);
			}
		}
		if (added || orphans || tails)
			console.error(`[gen] level ${l}: ${plans[l].roadCells.size} road cells `
				+ `(${before} before the town net, +${added} from it) `
				+ `linking ${here.length} place(s), ${orphans} orphan tile(s) and ${tails} tail tile(s) dropped`);
	}
	for (let l = 0; l < levels; l++) leakTrace('before edges', blocked, W, H, l, plans[l].objects);
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
	for (let l = 0; l < levels; l++) leakTrace('before paths', blocked, W, H, l, plans[l].objects);
	phase('paths');
	// The content fill can close a pocket the structure-time pass opened:
	// settle fills and placed objects land after openSealedByObjects ran, so
	// a gate pocket sealed at fill time was never inspected. Sweep seals
	// once more on the finished level before the stranded sweep grades it.
	for (let l = 0; l < levels; l++) {
	if (process.env.VMAPGEN_RING_TRACE) console.error('[ringpass] before openSealedByObjects ' + plans.map(pl => pl.objects.filter(o => o.__ring).length).join('/'));
		const opened = openSealedByObjects(plans[l].objects, W, H, l, blocked,
			l > 0 ? (plans[l].entrances || []) : startsOn(l), null, plans[l].links,
			plans[l].p.water, l > 0, plans[l].zone);
		if (opened)
			console.error(`[gen] level ${l}: removed ${opened} scenery `
				+ 'object(s) that sealed part of the level off');
	}
	// The sweep needs each level's own starts. planLevel already passes none
	// for the underground, but this loop used to hand every level the surface
	// starts, so mainComponent preferred whichever underground pocket sat under
	// the surface towns instead of the largest region, and deleted everything
	// outside it as unreachable.
	for (let l = 0; l < levels; l++) leakTrace("before join and sweep", blocked, W, H, l, plans[l].objects);
	const droppedPairs = new Set();
	// Every start zone holds the same number of towns once the fill is done (K, 2026-10-06 14:57, his 36x36 seed 1750425233: "did you see how many
	// towns each side starts with?", red 2, blue 1). The plan counts the town spots a zone holds and gives the extra ones up (the start-town parity above), but a
	// town the fill then finds no room for ("a zone 2 town found no room") broke it again, now on either side. Here the neutral towns of the richer start
	// zones go until the counts are equal, the last placed first; a player's own town never. VMAPGEN_START_TOWNS_FINAL=0 off.
	if (process.env.VMAPGEN_START_TOWNS_FINAL !== '0') {
		const isTown = o => /^(town|randomTown)$/.test(o.type) && o.template;
		const seats = new Map();
		for (let l = 0; l < levels; l++) {
			const pl = plans[l];
			if (!pl.zone) continue;
			for (const o of pl.objects) {
				if ((o.l || 0) !== l || !isTown(o)) continue;
				const z = pl.zone[o.y * W + o.x];
				if (z === undefined || z < 0) continue;
				const k = l + ':' + z;
				(seats.get(k) || seats.set(k, { l, towns: [] }).get(k)).towns.push(o);
			}
		}
		const seated = [...seats.values()].filter(e => e.towns.some(o => o.options && o.options.owner));
		if (seated.length > 1) {
			const least = Math.min(...seated.map(e => e.towns.length));
			let given = 0;
			for (const e of seated) {
				const spare = e.towns.filter(o => !(o.options && o.options.owner));
				while (e.towns.length > least && spare.length) {
					const o = spare.pop(), pl = plans[e.l];
					pl.objects.splice(pl.objects.indexOf(o), 1);
					e.towns.splice(e.towns.indexOf(o), 1);
					for (const [a, b2] of blockingCells(o.template, o.x, o.y)) if (a >= 0 && b2 >= 0 && a < W && b2 < H) blocked[e.l * W * H + b2 * W + a] &= ~OCCUPIED;
					for (const [vx, vy] of visitableCells(o.template, o.x, o.y)) for (const [dx, dy] of allowedDirs(o.template)) {
						const nx = vx + dx, ny = vy + dy;
						if (nx >= 0 && ny >= 0 && nx < W && ny < H) blocked[e.l * W * H + ny * W + nx] &= ~RESERVED;
					}
					given++;
				}
			}
			if (given) console.error(`[gen] start zones kept equal after the fill at ${least} town(s) each, ${given} neutral town(s) given up`);
		}
	}
	// every way into a zone joins the zone's main body before anything is swept (joinZoneWaysIn)
	if (process.env.VMAPGEN_JOIN_WAYS !== '0')
		for (let l = 0; l < levels; l++) {
			const r = joinZoneWaysIn(plans[l], l, W, H, blocked);
			if (r.joined || r.left) console.error(`[gen] level ${l}: ways into zones joined to their zone: ${r.joined} (${r.rock} rock tile(s) carved, ${r.cleared} scenery piece(s) cleared${r.demolished ? `, ${r.demolished} building tile(s) given up` : ''}), ${r.left} left`);
		}
	// A split level (splitLevels) is reached piece by piece through the other level: a gate or cross-level
	// monolith opens once a hero reaches its other end, so the levels are swept together until nothing more opens.
	// Swept one level at a time, every surface piece but the start's was "unreachable": Coldshadow's Fantasy seed 7
	// lost 948 objects and nine towns (2026-10-01).
	let cross = null;
	if (splitLevels(p)) {
		const openPairs = new Set();
		for (let round = 0; round < 12; round++) {
			const before = openPairs.size;
			for (let l = 0; l < levels; l++)
				for (const k of sweepStranded(plans[l], W, H, l, startsOn(l), null, { openPairs, dry: true })) openPairs.add(k);
			if (openPairs.size === before) break;
		}
		cross = { openPairs };
	}
	for (let l = 0; l < levels; l++) {
		sweepStranded(plans[l], W, H, l,
			startsOn(l).length ? startsOn(l) : (plans[l].entrances || []), droppedPairs, cross);
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
		sweepStranded(plans[l], W, H, l, startsOn(l), droppedPairs, cross);
	}
	// every start has its sawmill and ore pit, over interior scenery if nothing else is left (ensureStartMines)
	if (process.env.VMAPGEN_START_MINE_ROOM !== '0')
		for (let l = 0; l < levels; l++) {
			const r = ensureStartMines(plans[l], l, W, H, blocked, plans[l].biomeTerrain);
			if (r.length) console.error(`[gen] level ${l}: starter mines placed late: ${r.join('; ')}`);
		}
	// every start walks to its own zone's nearest sawmill and ore pit past no guard (freeStartMines)
	if (process.env.VMAPGEN_FREE_START_MINES !== '0')
		for (let l = 0; l < levels; l++) {
			const r = freeStartMines(plans[l], l, W, H, blocked);
			if (r.cleared || r.unreached) console.error(`[gen] level ${l}: start mines freed: ${r.cleared} scenery object(s) cleared, ${r.unreached} still behind a guard`);
		}
	// every map keeps one of its rich zones' dwellings (ensureSignatureDwelling)
	if (process.env.VMAPGEN_SIGNATURE_DWELLING !== '0' && p.zonePlan && objectPools && (objectPools.__sigDw || (objectPools.__sigCands || []).length)) {
		const r = ensureSignatureDwelling(plans, W, H, blocked, objectPools, p, rng);
		if (r) console.error(`[gen] signature dwelling: ${r}`);
	}
	// on a one-level map with water the far junction zones' dragon dwellings move into the middle ones (gatherDragons)
	{
		const g = gatherDragons(plans, W, H, blocked, p, rng);
		if (g) console.error(`[gen] dragon dwellings gathered to the middle: ${g}`);
	}
	// every town, mine and dwelling reachable from its zone's links, roads and towns (unsealZones)
	if (process.env.VMAPGEN_UNSEAL !== '0')
		for (let l = 0; l < levels; l++) {
			const r = unsealZones(plans[l], l, W, H, blocked);
			if (r.opened || r.left || r.removed) console.error(`[gen] level ${l}: sealed objects opened: ${r.opened}, ${r.cleared} scenery piece(s) cleared, ${r.removed} removed, ${r.left} left sealed`);
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
	for (let l = 0; l < levels; l++) leakTrace('before forests', blocked, W, H, l, plans[l].objects);
	phase('forests');
	const retileOn = process.env.VMAPGEN_RETILE !== 'off';
	if (retileOn)
		for (let l = 0; l < levels; l++) {
			if (!plans[l].zone || !plans[l].biomeTerrain) continue;
			const res = retileLevel({ objects: plans[l].objects, zone: plans[l].zone,
				biomeTerrain: plans[l].biomeTerrain, W, H, l, rng,
				isScenery: o => (DECOR_TYPES_SET.has(o.type) || (o.template && require('./decor').isTerrainDecorAnimation(o.template.animation))) && o.template && o.template.mask
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

	// underground floor nothing uses becomes rock, as the engine's does (emptyrock.js)
	for (let l = 0; l < levels; l++) {
		const pl = plans[l];
		if (!pl.openMask || !(pl.p && pl.p.caveChecker)) continue;
		const r = require('./emptyrock').emptyToRock(pl, W, H, l, blocked, OCCUPIED, REMOVABLE_TYPES, blockingCells, visitableCells,
			o => DECOR_TYPES_SET.has(o.type) && o.template && o.template.mask && !o.template.mask.some(r2 => /[AT]/.test(r2)), pl.p.caveChecker);
		if (r) console.error(`[gen] level ${l}: ${r.turned} empty floor tile(s) turned to rock (${r.restored} kept to hold ways open, ${r.scenery} scenery removed)` + (r.fit ? `, art ${r.fit.before} -> ${r.fit.after}` : ''));
	}
	// small scenery hugging a cave wall becomes part of the wall, as the engine's rock does (caverock.js)
	for (let l = 0; l < levels; l++) {
		const pl = plans[l];
		if (!pl.openMask || !(pl.p && pl.p.caveChecker)) continue;
		const n = require('./caverock').sceneryToRock(pl, W, H, l,
			o => DECOR_TYPES_SET.has(o.type) && o.template && o.template.mask && !o.template.mask.some(r => /[AT]/.test(r)),
			blockingCells, pl.p.caveChecker);
		if (n) console.error(`[gen] level ${l}: ${n} small scenery piece(s) against the cave wall turned to rock`);
	}
	// no rock one tile wide (thinRockToFloor)
	if (process.env.VMAPGEN_THIN_ROCK !== '0')
		for (let l = 0; l < levels; l++) {
			const r = thinRockToFloor(plans[l], l, W, H, rng);
			if (r.turned || r.left) console.error(`[gen] level ${l}: rock one tile wide: ${r.turned} tile(s) turned to floor under an obstacle, ${r.left} left`);
		}
	// the retile, the empty floor turned to rock and the cave wall's scenery came after the last seal sweep: one more, so no
	// part of a level they closed off stays closed (K's 252 line, 2026-10-05: an alchemist's lab and a library shut in)
	for (let l = 0; l < levels; l++) {
		const opened = openSealedByObjects(plans[l].objects, W, H, l, blocked,
			l > 0 ? (plans[l].entrances || []) : startsOn(l), null, plans[l].links,
			plans[l].p.water, l > 0, plans[l].zone);
		if (opened) console.error(`[gen] level ${l}: removed ${opened} scenery object(s) that the late passes sealed part of the level off with`);
	}
	// empty ground shut in by scenery is filled with scenery (fillEmptyPockets)
	for (let l = 0; l < levels; l++) {
		const r = fillEmptyPockets(plans[l], l, W, H, blocked, rng);
		if (r.pockets) console.error(`[gen] level ${l}: ${r.pockets} empty pocket(s) shut in by scenery filled, ${r.tiles} tile(s), ${r.left} left open`);
	}
	// Dear pickups a hero walks to trade places with cheap ones only a fight reaches (lootswap.js)
	if (process.env.VMAPGEN_LOOT_SWAP !== '0')
		for (let l = 0; l < levels; l++) {
			const r = require('./lootswap').swapLoot(plans[l], W, H, l, blocked, OCCUPIED, REMOVABLE_TYPES, blockingCells, visitableCells);
			if (r.swapped || r.moved) console.error(`[gen] level ${l}: ${r.swapped} open dear pickup(s) traded places with guarded cheap ones (${r.guards} guard pair(s) traded too), ${r.moved || 0} moved into a guarded pocket`);
		}
	// no guard stands where its ring covers a town's doorstep (guardsOffDoorsteps)
	if (process.env.VMAPGEN_DOORSTEP_GUARDS !== '0')
		for (let l = 0; l < levels; l++) {
			const r = guardsOffDoorsteps(plans[l], l, W, H, blocked);
			if (r.moved || r.left || r.removed) console.error(`[gen] level ${l}: guards on a town's doorstep: ${r.moved} moved, ${r.removed || 0} removed, ${r.left} left`);
			const w = ownTownWays(plans[l], l, W, H, blocked);
			if (w.moved || w.left || w.removed) console.error(`[gen] level ${l}: guards on the way from a start to its zone's other towns: ${w.moved} moved, ${w.removed || 0} removed, ${w.left} left`);
		}
	if (process.env.VMAPGEN_RING_TRACE) console.error('[ringpass] before pileseal ' + plans.map(pl => pl.objects.filter(o => o.__ring).length).join('/'));
	// A valuable pile a hero reaches without a fight moves into a dead end of its zone with its guard at the mouth (pileseal.js;
	// the engine lays guarded piles only where they close, no switch)
	for (let l = 0; l < levels; l++) {
		const r = require('./pileseal').sealPiles(plans[l], W, H, l, blocked, {
			OCCUPIED, RESERVED, APPROACH, blockingCells, visitableCells, footprintFits, footprintBlock, markApproach,
			objectEntry, monsterTpl: require('./content').FILL_TYPES.creeps[0].tpl, monsterOptions,
			rng: xorshift(((params.seed || 1) ^ 0x51ea) + l * 977 >>> 0) });
		console.error(`[gen] level ${l}: valuable piles open to a hero: ${r.open}, ${r.moved} moved into a dead end behind a guard, ${r.left} with no dead end ${JSON.stringify(r.why)}`);
	}
	// A guard on every high-class pile a hero takes without a fight (guardhigh.js; the base game's behaviour, no switch)
	for (let l = 0; l < levels; l++) {
		const r = require('./guardhigh').guardHigh(plans[l], W, H, l, blocked, {
			OCCUPIED, RESERVED, APPROACH, blockingCells, visitableCells, allowedDirs, footprintFits, footprintBlock, markApproach,
			objectEntry, monsterTpl: require('./content').FILL_TYPES.creeps[0].tpl, monsterOptions,
			rng: xorshift(((params.seed || 1) ^ 0x6a2d) + l * 977 >>> 0) });
		console.error(`[gen] level ${l}: high loot a hero takes without a fight: ${r.open} pile(s), ${r.guarded} guarded, ${r.left} with no tile for a guard ${JSON.stringify(r.why || {})}`);
	}
	// No pickup under a monster's sprite (declip.js; VMAPGEN_DECLIP=0 skips it)
	if (process.env.VMAPGEN_DECLIP !== '0')
		for (let l = 0; l < levels; l++) {
			const r = require('./declip').declipMonsters(plans[l], W, H, l, blocked, blockingCells, require('./content').footprintCells);
			if (r.moved || r.left) console.error(`[gen] level ${l}: ${r.moved} pickup(s) moved out from under a monster's sprite, ${r.left} left`);
		}
	// every dear object with a monster beside it (guardDearLoot)
	if (process.env.VMAPGEN_DEAR_GUARD !== '0' && (params.guardTreasure === undefined || Number(params.guardTreasure) !== 0)
		&& (params.lootGuardWeight === undefined || Number(params.lootGuardWeight) > 0))
		for (let l = 0; l < levels; l++) {
			const r = guardDearLoot(plans[l], l, W, H, blocked, plans[l].p || params, rng);
			if (r.posted || r.left || r.moved) console.error(`[gen] level ${l}: dear loot and dwellings with no monster beside them: ${r.posted} guard(s) posted beside them, ${r.moved || 0} pile(s) moved into a guard's ring, ${r.left} left; gold mines guarded ${r.gold || 0}, no tile ${r.goldLeft || 0}`);
		}
	// Every tile a dwelling or a dear pile is visited from is taken, in a monster's ring or closed by a terrain blocker, so a flyer meets a guard too
	// (K, 2026-10-06: guard, loot, guard, wall; the gaps closed with blockers, not more guards)
	if (process.env.VMAPGEN_DEAR_GUARD !== '0' && (params.guardTreasure === undefined || Number(params.guardTreasure) !== 0)
		&& (params.lootGuardWeight === undefined || Number(params.lootGuardWeight) > 0))
		for (let l = 0; l < levels; l++) {
			const r = require('./approachclose').closeApproaches(plans[l], l, W, H, blocked, plans[l].p || params, {
				OCCUPIED, RESERVED, APPROACH, markApproach, blockingCells, visitableCells, allowedDirs, footprintBlock, objectEntry, singleTemplate,
				monsterTpl: OBJECT_TEMPLATES.randomMonster, monsterOptions, scaledAmount: require('./content').scaledAmount, lootGuard: require('./content').lootGuard, zoneGuardPool: require('./content').zoneGuardPool,
				rng: xorshift(((params.seed || 1) ^ 0x3c71) + l * 977 >>> 0) });
			if (r.objects) console.error(`[gen] level ${l}: dwellings and dear piles with an open approach: ${r.objects}; ${r.closed} tile(s) closed with a blocker, ${r.posted} guard(s) posted (${r.first || 0} first), ${r.left} left open ${JSON.stringify(r.why)}; into a ring ${r.intoRing || 0}, ways beside a guard closed ${r.closedBeside || 0} (guards re-sited for banks and mines ${r.resitedBeside || 0}, cheap piles into a ring ${r.cheapIntoRing || 0}), guards re-sited ${r.resited || 0}, spread ${r.spread || 0}; thinned ${r.thinned}, merged ${r.merged} (${r.moved} piles moved), pairs ${r.pairs} ${JSON.stringify(r.why3)}; flyer tiles walled ${r.flyerWalled || 0}, taken by a guard ${r.flyerShut || 0}, left ${r.flyerLeft || 0}`);
			const pg = require('./approachclose').raisePandoraGuards(plans[l], l, W, H, plans[l].p || params, { rng: xorshift(((params.seed || 1) ^ 0x7d19) + l * 977 >>> 0) });
			if (pg.raised) console.error(`[gen] level ${l}: Pandora's boxes with a guard under the engine's strength: ${pg.raised} of ${pg.boxes} raised`);
			// the guards just posted keep off the doorsteps and the ways from a start to its zone's other towns, as the earlier ones were made to
			if (r.posted) {
				const g1 = guardsOffDoorsteps(plans[l], l, W, H, blocked), g2 = ownTownWays(plans[l], l, W, H, blocked);
				if (g1.moved || g1.removed || g2.moved || g2.removed) console.error(`[gen] level ${l}: after the approach closing, guards moved or taken off a doorstep or a start's way: ${g1.moved + g2.moved} moved, ${(g1.removed || 0) + (g2.removed || 0)} removed`);
			}
		}
	// Open stretches with no loot in them get a pile of their zone (fillBareWindows)
	for (let l = 0; l < levels; l++) {
		const r = fillBareWindows(plans[l], l, W, H, blocked, plans[l].p || params);
		if (r.added || r.lifted) console.error(`[gen] level ${l}: loot-free stretches of ground given a pile: ${r.added}; sparse stretches lifted by ${r.lifted} pile(s)`);
	}
	// Guards at portals Off: nothing stands in front of a portal end, whatever placed it (portalends.js)
	if (Number(params.guardPortals) === 0)
		for (let l = 0; l < levels; l++) {
			const r = require('./portalends').clearPortalEnds(plans[l], W, H, l, blocked, { OCCUPIED, blockingCells, visitableCells, allowedDirs });
			if (r.removed) console.error(`[gen] level ${l}: guards at portals Off: ${r.removed} monster(s) beside a portal end taken away`);
		}
	if (process.env.VMAPGEN_RING_TRACE) console.error('[ringpass] before roadrepair ' + plans.map(pl => pl.objects.filter(o => o.__ring).length).join('/'));
	if (process.env.VMAPGEN_RING_TRACE) for (const pl of plans) { const hv = pl.objects.filter(o => /^(randomArtifactRelic|randomArtifactMajor|pandoraBox|artifact)$/.test(o.type)); console.error('[ringpiles] high ' + hv.length + ', walled where laid ' + hv.filter(o => o.__walled && o.__walled[0] === o.x && o.__walled[1] === o.y).length + ', walled then moved ' + hv.filter(o => o.__walled && (o.__walled[0] !== o.x || o.__walled[1] !== o.y)).length + ', never walled ' + hv.filter(o => !o.__walled).length); }
	if (process.env.VMAPGEN_RING_DUMP) require('fs').writeFileSync(process.env.VMAPGEN_RING_DUMP, JSON.stringify(plans.map((pl, l) => pl.objects.filter(o => /^(randomArtifactRelic|randomArtifactMajor|pandoraBox|artifact|spellScroll)$/.test(o.type)).map(o => ({ l, type: o.type, at: [o.x, o.y], walled: o.__walled || null, guardAt: o.__guardAt || null, ring: (o.__ringLog || []).map(([x, y, k]) => [x, y, k, pl.openMask ? pl.openMask[y * W + x] : -1]), guardThere: !!(o.__guardAt && pl.objects.some(m => /^(monster|randomMonster)/.test(m.type) && m.x === o.__guardAt[0] && m.y === o.__guardAt[1])) }))).flat()));
	// The roads' last word, on the final layout: no end at nothing (roadrepair.js)
	if (process.env.VMAPGEN_ROAD_REPAIR !== '0' && process.env.VMAPGEN_ROAD_SPLINES === '0')
		for (let l = 0; l < levels; l++) {
			const r = require('./roadrepair').roadRepair(plans[l], W, H, l, blocked, OCCUPIED, REMOVABLE_TYPES, blockingCells, visitableCells,
				o => DECOR_TYPES_SET.has(o.type) && o.template && o.template.mask && !o.template.mask.some(r => /[AT]/.test(r)));
			console.error(`[gen] level ${l}: road repair joined ${r.joined} tile(s), cut ${r.cut} dead-end tile(s); ${plans[l].roadCells.size} road tiles`);
		}
	// Every road net joined to the starts' (roadweb.js): the engine's maps have one net with every town on it
	{
		const r = process.env.VMAPGEN_ROAD_SPLINES !== '0' ? { joined: 0 } : require('./roadweb').joinRoadNets(plans, W, H, blocked, OCCUPIED, REMOVABLE_TYPES, blockingCells, visitableCells);
		if (r.joined) console.error(`[gen] road web: ${r.joined} road tile(s) joined the road nets to the starts' in ${r.rounds} round(s)`);
	}
	// The road spline layer drew an edge to every held gate site before the gates were placed; a link whose pair landed
	// elsewhere, or became monoliths, leaves that edge leading to nothing. Its own tiles (not shared with another edge)
	// go; the rest of the tree stays. Part of the layer: it only takes back what it drew (VMAPGEN_ROAD_SPLINES=1).
	if (process.env.VMAPGEN_ROAD_SPLINES !== '0' && process.env.VMAPGEN_ROAD_TAKEBACK !== '0')
		for (let l = 0; l < levels; l++) {
			const pl = plans[l], edges = pl.roadEdges || [];
			if (!edges.length || !pl.roadCells) continue;
			const ends = new Set();
			for (const o of pl.objects) {
				if ((o.l || 0) !== l || !o.template || !/^(town$|randomTown$|subterraneanGate|monolith|mine$)/.test(o.type)) continue;
				for (const [vx, vy] of visitableCells(o.template, o.x, o.y))
					for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) ends.add((vy + dy) * W + vx + dx);
			}
			const guardsAt = new Set();
			for (const o of pl.objects) if ((o.l || 0) === l && /^(randomMonster|monster)/.test(o.type))
				for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) guardsAt.add((o.y + dy) * W + o.x + dx);
			// from the dead end back to the first junction only: an edge drawn first is also the trunk later edges joined
			const R = pl.roadCells, D4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
			const nb = c => { const x = c % W, y = (c / W) | 0; return D4.map(([dx, dy]) => [x + dx, y + dy]).filter(([a, b2]) => a >= 0 && b2 >= 0 && a < W && b2 < H && R.has(b2 * W + a)).map(([a, b2]) => b2 * W + a); };
			let cut = 0;
			for (const e of edges) {
				if (ends.has(e.end) || guardsAt.has(e.end)) continue;
				let c = e.end;
				for (let k = 0; k < 400 && R.has(c) && !ends.has(c) && !guardsAt.has(c); k++) {
					const n = nb(c);
					if (n.length > 1) break;
					R.delete(c); cut++;
					if (!n.length) break;
					c = n[0];
				}
			}
			// what the trim leaves dangling (a junction whose branch went) is cut back too: every leaf is a node; a guard
			// keeps only the tile it stands on (its 3x3 kept a stub beside a pile's guard, 2026-10-03)
			const holeOn = new Set();
			for (const op of pl.openings || []) if (op.kind === 'openRoad') for (const c of op.hole || []) holeOn.add(c);
			const guardOn = new Set();
			for (const o of pl.objects) if ((o.l || 0) === l && /^(randomMonster|monster)/.test(o.type)) guardOn.add(o.y * W + o.x);
			// the tiles a town, gate, monolith or mine is entered from (its template's visitableFrom), and the tile itself: a
			// leaf beside a monolith's blocked side is no end (2026-10-03, the checker's gap at a monolith's flank)
			const realEnds = new Set();
			const endOwner = new Map();   // entrance tile -> its object
			const frontOf = new Set();   // a visiting tile and the tile straight in front of it: where a road to it ends
			for (const o of pl.objects) {
				if ((o.l || 0) !== l || !o.template || !/^(town$|randomTown$|subterraneanGate|monolith|mine$)/.test(o.type)) continue;
				const vf = o.template.visitableFrom || ['+++', '+-+', '+++'];
				for (const [vx, vy] of visitableCells(o.template, o.x, o.y)) {
					realEnds.add(vy * W + vx); endOwner.set(vy * W + vx, o); frontOf.add(vy * W + vx); if (vy + 1 < H) frontOf.add((vy + 1) * W + vx);
					for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((vf[dy + 1] || '').charAt(dx + 1) === '+' && vx + dx >= 0 && vy + dy >= 0 && vx + dx < W && vy + dy < H) { realEnds.add((vy + dy) * W + vx + dx); endOwner.set((vy + dy) * W + vx + dx, o); }
				}
			}
			for (const op of pl.openings || []) if (op.kind === 'openRoad') for (const c of op.hole || []) { const hx = c % W, hy = (c / W) | 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) ends.add((hy + dy) * W + hx + dx); }
			for (let changed = true, g = 0; changed && g < 400; g++) {
				changed = false;
				// an entrance leaf whose one neighbour is another entrance of the same object is a spur beside the way in
				const spur = c => { const n = nb(c); return n.length === 1 && !frontOf.has(c) && endOwner.has(c) && endOwner.get(n[0]) === endOwner.get(c); };
				for (const c of [...R]) if (((!realEnds.has(c) && !holeOn.has(c) && !guardOn.has(c)) || spur(c)) && nb(c).length <= 1) { R.delete(c); cut++; changed = true; }
			}
			// a piece left holding no town, gate, monolith or mine (a doorway's own road with nothing on either side
			// reaching it, 2026-10-03) goes whole
			{
				const seen = new Set();
				for (const c0 of [...R]) {
					if (seen.has(c0)) continue;
					const part = [c0]; seen.add(c0);
					for (let i = 0; i < part.length; i++) for (const m of nb(part[i])) if (!seen.has(m)) { seen.add(m); part.push(m); }
					if (!part.some(c => realEnds.has(c))) for (const c of part) { R.delete(c); cut++; }
				}
			}
			if (cut) console.error(`[gen] level ${l}: road spline edges to link ends never built taken back, ${cut} tile(s)`);
		}
	// The last road pass: the road on the visiting tile of every gate and monolith (gateroad.js; VMAPGEN_TELEPORT_ROADS=0 skips it)
	if (process.env.VMAPGEN_TELEPORT_ROADS !== '0' && process.env.VMAPGEN_ROAD_SPLINES !== '0')
		for (let l = 0; l < levels; l++) {
			const r = require('./gateroad').teleportRoads(plans[l], W, H, l, blocked, OCCUPIED, visitableCells, blockingCells);
			if (r.onto || r.joined || r.none) console.error(`[gen] level ${l}: road onto the visiting tile of gates and monoliths: ${r.onto} the tile only, ${r.joined} by a longer run, ${r.none} not reached`);
		}
	// The engine's mines stand on a road 19 to 35% of the time (tier-1 subset: road_mine_at engine 0.19, ours 0.02; its roads run to the
	// mines of a zone with fewer than two road nodes); a mine here joins the road net within 30 tiles with that chance, over free floor
	// Build Road Network Off on a template: the mines get no road of their own (the passages' roads, the gates' and monoliths', and the towns' doors stay)
	const roadsOff = Number(params.roadNetwork) === 0 && !!(params.zonePlan && params.zonePlan.connections && params.zonePlan.connections.length);
	if (process.env.VMAPGEN_ROAD_SPLINES !== '0' && !roadsOff)
		for (let l = 0; l < levels; l++) {
			const r = require('./gateroad').teleportRoads(plans[l], W, H, l, blocked, OCCUPIED, visitableCells, blockingCells,
				{ types: /^(mine|abandonedMine)$/, reach: 30, chance: 0.2, rng: xorshift(((params.seed || 1) ^ 0x31ae5) + l * 7919 >>> 0) });
			if (r.onto || r.joined) console.error(`[gen] level ${l}: mines on the road net: ${r.onto} beside it, ${r.joined} by a longer run`);
		}
	// Two road pieces with an end four steps or fewer from each other over walkable ground are joined (gateroad.js closeRoadGaps;
	// VMAPGEN_ROAD_GAPS=0 skips it)
	if (process.env.VMAPGEN_ROAD_GAPS !== '0' && process.env.VMAPGEN_ROAD_SPLINES !== '0')
		for (let l = 0; l < levels; l++) {
			const r = require('./gateroad').closeRoadGaps(plans[l], W, H, l, blocked, OCCUPIED, blockingCells);
			if (r.joined) console.error(`[gen] level ${l}: road gaps of four tiles or fewer closed: ${r.joined}`);
		}
	// A road that ends at nothing is taken back to its junction (gateroad.js trimRoadStubs; VMAPGEN_ROAD_TRIM=0 skips it)
	if (process.env.VMAPGEN_ROAD_TRIM !== '0' && process.env.VMAPGEN_ROAD_SPLINES !== '0')
		for (let l = 0; l < levels; l++) {
			const r = require('./gateroad').trimRoadStubs(plans[l], W, H, l, visitableCells, blockingCells, allowedDirs);
			if (r.cut) console.error(`[gen] level ${l}: road ends at nothing taken back: ${r.cut} tile(s)`);
		}
	// A town with no road at its door joins the road of its own zone (gateroad.js joinBareTowns)
	if (process.env.VMAPGEN_ROAD_SPLINES !== '0')
		for (let l = 0; l < levels; l++) {
			const f = require('./gateroad').openTownFronts(plans[l], W, H, l, blocked, { OCCUPIED, visitableCells, blockingCells, clearScenery,
				isDecor: o => DECOR_TYPES_SET.has(o.type) && o.template && o.template.mask && !o.template.mask.some(r2 => /[AT]/.test(r2)) });
			if (f.cleared || f.rock || f.water || f.left) console.error(`[gen] level ${l}: the tile in front of a town's entrance: ${f.cleared} scenery piece(s) cleared, ${f.rock} rock tile(s) opened, ${f.water} water tile(s) made land, ${f.left} left`);
			const r = require('./gateroad').joinBareTowns(plans[l], W, H, l, blocked, OCCUPIED, visitableCells, roadsOff, blockingCells);
			if (r.joined || r.left) console.error(`[gen] level ${l}: towns with no road at the door: ${r.joined} joined to their zone's road${r.toObject ? ` (${r.toObject} of them to an object in a zone with no road)` : ''}, ${r.left} left`);
			if (r.left) {
				const w = clearWayToRoad(plans[l], l, W, H, blocked);
				if (w.cleared) {
					console.error(`[gen] level ${l}: scenery cleared on the way from ${w.towns} town(s) to a road: ${w.cleared} piece(s)`);
					const r2 = require('./gateroad').joinBareTowns(plans[l], W, H, l, blocked, OCCUPIED, visitableCells, roadsOff, blockingCells);
					if (r2.joined) console.error(`[gen] level ${l}: towns joined to a road after the clearing: ${r2.joined}, ${r2.left} left`);
				}
			}
		}
	// The road passes after the gates' and monoliths' own (the mines' roads, the gap close, the trim, the towns' join) can leave a road within
	// reach of an end that had none when its pass ran: the gate of 144x144 two levels seed 3 (K's mods) stood 40 steps from a road laid after it.
	// Once more, for the ends still without one. VMAPGEN_TELEPORT_ROADS=0 skips it.
	if (process.env.VMAPGEN_TELEPORT_ROADS !== '0' && process.env.VMAPGEN_ROAD_SPLINES !== '0')
		for (let l = 0; l < levels; l++) {
			const r = require('./gateroad').teleportRoads(plans[l], W, H, l, blocked, OCCUPIED, visitableCells, blockingCells);
			if (r.onto || r.joined) console.error(`[gen] level ${l}: road onto the visiting tile of gates and monoliths, again after the late roads: ${r.onto} the tile only, ${r.joined} by a longer run`);
		}
	// A road passes an object and does not run through it: the road behind a monolith, a gate or a mine goes round its footprint to the tiles it is entered from
	for (let l = 0; l < levels; l++) {
		const r = require('./gateroad').roadsPastObjects(plans[l], W, H, l, blocked, { OCCUPIED, visitableCells, blockingCells, allowedDirs });
		if (r.fixed || r.left) console.error(`[gen] level ${l}: roads that ran through an object, taken round it: ${r.fixed}, ${r.left} left`);
	// the arms the bypass left hanging go back to their junction, as every road end is judged (the trim before)
	if (r.fixed && process.env.VMAPGEN_ROAD_TRIM !== '0') require('./gateroad').trimRoadStubs(plans[l], W, H, l, visitableCells, blockingCells, allowedDirs);
	// and no 2x2 block of road (roads are one tile wide)
	const th = require('./gateroad').thinRoadBlocks(plans[l], W, H, l, { visitableCells });
	if (th.thinned) console.error(`[gen] level ${l}: road tiles taken out of 2x2 blocks: ${th.thinned}`);
	}
	// The zones' pieces once more, now that everything stands: the scenery retile, the banks and the guard moves come after the join before the
	// sweep and can shut a cave chamber's mouth (K's mods, 144x144 two levels, seed 6: zone 18 on level 1, a chamber of 178 tiles with 28 objects
	// behind two scenery pieces and a bank; mapsight split zones). The same join: scenery cleared, rock carved, a building only when nothing
	// cheaper joins. VMAPGEN_JOIN_LATE=0 skips it.
	if (process.env.VMAPGEN_JOIN_LATE !== '0' && process.env.VMAPGEN_JOIN_WAYS !== '0')
		for (let l = 0; l < levels; l++) {
			const r = joinZoneWaysIn(plans[l], l, W, H, blocked);
			if (r.joined || r.left) console.error(`[gen] level ${l}: zone pieces joined again at the end: ${r.joined} (${r.rock} rock tile(s) carved, ${r.cleared} scenery piece(s) cleared${r.demolished ? `, ${r.demolished} building tile(s) given up` : ''}), ${r.left} left`);
		}
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
	// VMAPGEN_FILL_TRACE: what put() refused, by reason and kind, over the whole map
	if (objectPools && objectPools.__smallCut && !objectPools.__smallCutLogged) { const c = objectPools.__smallCut; objectPools.__smallCutLogged = true; console.error(`[gen] a map at ${(c.f * 100).toFixed(0)}% of its template's smallest size keeps fewer piles: ${c.piles} of ${c.of} cut, with ${c.guards} guard(s); ${c.ends || 0} gate or monolith end(s) left to a stack within 2`); }
	if (process.env.VMAPGEN_FILL_TRACE && objectPools && objectPools.__fillStat) console.error(`[fillstat] ${JSON.stringify(objectPools.__fillStat)}`);
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
/**
 * Every cell some object on level l blocks, by what blocks it: scenery (no visitable cell) or another object. The
 * OCCUPIED flag alone missed cells: a late starter mine went in with its only way in under a mountain the flags showed
 * as open ground (72x72 seed 1, 2026-10-03, mapsight check "sealed"), so the late passes read the objects themselves.
 */
function objectCover(pl, l, W, H) {
	const isScen = o => (DECOR_TYPES_SET.has(o.type) || (o.template && require('./decor').isTerrainDecorAnimation(o.template.animation))) && o.template && o.template.mask && !o.template.mask.some(r2 => /[AT]/.test(r2));
	const scenAt = new Map(), other = new Set();
	for (const o of pl.objects) {
		if ((o.l || 0) !== l || !o.template) continue;
		const sc = isScen(o);
		for (const [fx, fy] of blockingCells(o.template, o.x, o.y)) {
			if (fx < 0 || fy < 0 || fx >= W || fy >= H) continue;
			const c = fy * W + fx;
			if (sc) scenAt.set(c, o); else other.add(c);
		}
	}
	for (const c of other) scenAt.delete(c);
	return { scenAt, other };
}

/**
 * The cheapest way from a start town's gate through its own zone without entering a guard's ring: open ground costs 0,
 * a tile of scenery 1 (scenery can be cleared), every other object and every guard's ring is a wall. Returns
 * { cost, prev, scenAt } over the level's cells (cost -1 where nothing reaches), or null.
 */
function startWalk(plan, l, W, H, blocked, t) {
	const N = W * H, base = l * N, zone = plan.zone;
	const from = approachCells(t.template, t.x, t.y, l, W, H, blocked);
	if (!zone || !from.length) return null;
	const z = zone[from[0]];
	const D8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
	const ring = new Uint8Array(N);
	for (const o of plan.objects) if ((o.l || 0) === l && o.template && /^(monster|randomMonster)/.test(o.type))
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const x = o.x + dx, y = o.y + dy; if (x >= 0 && y >= 0 && x < W && y < H) ring[y * W + x] = 1; }
	const { scenAt, other } = objectCover(plan, l, W, H);
	const cost = new Int32Array(N).fill(-1), prev = new Int32Array(N).fill(-1);
	const front = [], dq = [];
	let head = 0;
	for (const c of from) if (!ring[c] && !other.has(c)) { cost[c] = scenAt.has(c) ? 1 : 0; (scenAt.has(c) ? dq : front).push(c); }
	while (front.length || head < dq.length) {
		const c = front.length ? front.pop() : dq[head++];
		const x = c % W, y = (c / W) | 0;
		for (const [dx, dy] of D8) {
			const u = x + dx, v = y + dy;
			if (u < 0 || v < 0 || u >= W || v >= H) continue;
			const m = v * W + u;
			if (ring[m] || zone[m] !== z || other.has(m)) continue;
			const w = scenAt.has(m) ? 1 : (blocked[base + m] & OCCUPIED) ? -1 : 0;
			if (w < 0) continue;
			const nc = cost[c] + w;
			if (cost[m] >= 0 && cost[m] <= nc) continue;
			cost[m] = nc; prev[m] = c;
			if (w === 0) front.push(m); else dq.push(m);
		}
	}
	return { cost, prev, scenAt, z };
}

/**
 * Each start walks to its own zone's nearest sawmill, its nearest ore pit and every other town of its zone without
 * crossing a guard's ring. The engine places a start's first wood and ore close to its town and never lets a guard or
 * treasure block the free paths to a required object (TreasurePlacer, zone.freePaths). Ours had a start's ore pit shut
 * in by scenery and a guard's ring on 2 of 10 Coldshadow seeds (tools/geometry/startkit.js, 2026-10-03), and a start
 * zone's second town reached only past a treasure guard whose ring covered the one corridor (K's medium Coldshadow,
 * 2026-10-03, "passability problems on my starting biome"; mapsight check "own town"). Where one cannot be reached,
 * the cheapest way through scenery is cleared, whole objects. VMAPGEN_FREE_START_MINES=0 off.
 * Returns { cleared, unreached }.
 */
function freeStartMines(plan, l, W, H, blocked) {
	const N = W * H, base = l * N, zone = plan.zone;
	const out = { cleared: 0, unreached: 0 };
	if (!zone) return out;
	const towns = plan.objects.filter(o => (o.l || 0) === l && o.template && /^(town|randomTown)$/.test(o.type) && o.options && o.options.owner);
	for (const t of towns) {
		const first = startWalk(plan, l, W, H, blocked, t);
		if (!first) continue;
		const z = first.z;
		const goals = [];
		for (const kind of ['sawmill', 'orePit']) {
			const mines = plan.objects.filter(o => (o.l || 0) === l && o.type === 'mine' && o.subtype === kind && o.template && zone[o.y * W + o.x] === z);
			if (mines.length) goals.push(mines);
		}
		for (const o of plan.objects) if (o !== t && (o.l || 0) === l && o.template && /^(town|randomTown)$/.test(o.type) && zone[o.y * W + o.x] === z) goals.push([o]);
		for (const objs of goals) {
			const goal = new Set();
			for (const m of objs) for (const c of approachCells(m.template, m.x, m.y, l, W, H, blocked)) goal.add(c);
			if (!goal.size) continue;
			const w = startWalk(plan, l, W, H, blocked, t);
			let hit = -1;
			for (const c of goal) if (w.cost[c] >= 0 && (hit < 0 || w.cost[c] < w.cost[hit])) hit = c;
			if (hit < 0) { out.unreached++; continue; }
			if (w.cost[hit] === 0) continue;
			const gone = new Set();
			for (let k = hit; k >= 0; k = w.prev[k]) if (w.scenAt.has(k)) gone.add(w.scenAt.get(k));
			out.cleared += clearScenery(plan, l, W, H, blocked, { gone });
		}
	}
	return out;
}

/**
 * Every map keeps at least one of its template's signature dwellings (content.js __sigCands: the neutral dwellings its
 * rich zones, a band from 50000, can draw, worth a quarter of the most valuable or more). That is the template's
 * signature (Coldshadow's neutral dragon dwellings). K, 2026-10-03, on a small one-level Coldshadow: "every map with
 * coldshadow's should have at least 1 such dwelling". On a small map those zones are 35 to 55 tiles and had no free
 * tile left when the dwellings were placed. If none stands anywhere on the map, one of them goes where its footprint
 * covers only open ground and scenery in a rich zone (the fewest scenery tiles; that scenery is removed whole), with a
 * level-6 guard on its way in. Since 2026-10-04 every rich zone gets one (see the body). VMAPGEN_SIGNATURE_DWELLING=0 off. Returns a line for the log, or null.
 */
/**
 * A guard for a dwelling or a dear pile on a template map, at the strength the engine's own maps give what it stands over (content.js
 * lootGuard: Pandora's boxes 21k, majors 11k, relics 65k, dwellings 8k, the neutral dragon dwellings 50k), written as the creature the engine's
 * rule picks from the zone's pool. Null where the map has no concrete guards (the free layout), which keeps its level rule.
 */
function lootGuardEntry(pl, l, W, o, p, rng, spot, tpl) {
	const meta = pl.zoneMeta && pl.zoneMeta[pl.zone && pl.zone[o.y * W + o.x]];
	if (!pl.objectPools || !pl.objectPools.guards || !meta || !meta.spec) return null;
	const C = require('./content');
	const kind = /^creatureGenerator/.test(o.type) ? (/^(frozenCliffs|crystalCavern|magicForest|sulfurousLair)$/i.test(o.subtype || '') ? 'dragonDwelling' : 'dwelling')
		: o.type === 'prison' ? 'prison' + ((o.options && o.options.experience) || 0) : o.type === 'mine' ? o.subtype : o.type;
	const g = C.lootGuard(kind, p, rng, C.zoneGuardPool(pl.objectPools.guards, meta.spec));
	if (!g) return null;
	const ge = objectEntry(`randomMonsterLevel${g.level}`, spot % W, (spot / W) | 0, l, tpl, 'object', { character: 'hostile', amount: C.scaledAmount(g.amount, p) });
	ge.guardCreature = g.creature;
	return ge;
}

/**
 * A relic, major artifact, plain artifact or Pandora's box has a monster on or beside its own tile once every other pass has
 * moved what it moves. K, 2026-10-05: "if i get fly or any artifact that lets me fly over mountains, i can just fly over tile
 * blockers and clean these biomes out without fighting". Walls stop a walker; only a guard beside the tile stops a flyer. One
 * with none gets a guard on a free tile beside it (not a road, a reserved tile or another zone), its level by what it guards.
 * Returns { posted, left }.
 */
function guardDearLoot(pl, l, W, H, blocked, p, rng) {
	const out = { posted: 0, left: 0 }, base = l * W * H;
	const DEAR = /^(randomArtifactRelic|randomArtifactMajor|pandoraBox|artifact)$/;
	const MON = /^(monster|randomMonster)/;
	const roads = pl.roadCells || new Set();
	const monsterAt = new Set();
	for (const o of pl.objects) if ((o.l || 0) === l && MON.test(o.type)) monsterAt.add(o.y * W + o.x);
	const LEVEL = { randomArtifactRelic: 6, randomArtifactMajor: 5, pandoraBox: 5, artifact: 4, prison: 6 };
	const tpl = OBJECT_TEMPLATES.randomMonster;
	// a prison of 90000 experience or more is dear loot too (K, 2026-10-07: "the highest-yielding prisons would be in high loot areas behind
	// significant guards"; its pile's guard could not always stand in its pocket's mouth, 19 to 27% of them unguarded, 2026-10-08)
	const dear = o => DEAR.test(o.type) || (o.type === 'prison' && o.options && o.options.experience >= 90000);
	// guard spacing (content.js, the guard register): a tile within 2 of another stack is the last choice; when every tile beside a
	// one-tile pile is that close to a stack, the pile moves into that stack's ring instead (the engine's piles share one guard)
	const GAP = require('./content').GUARD_GAP;
	const crowdAt = c => { const x = c % W, y = (c / W) | 0; for (const m of monsterAt) if (m !== c && Math.max(Math.abs(m % W - x), Math.abs(((m / W) | 0) - y)) < GAP) return true; return false; };
	const intoRing = (o, reach) => {
		if (!o.template || !o.template.mask || blockingCells(o.template, o.x, o.y).length !== 1) return false;
		let bestT = -1, bestD = Infinity;
		for (const m of pl.objects) {
			if ((m.l || 0) !== l || !MON.test(m.type)) continue;
			if (Math.max(Math.abs(m.x - o.x), Math.abs(m.y - o.y)) > reach) continue;
			if (pl.zone && pl.zone[m.y * W + m.x] !== pl.zone[o.y * W + o.x]) continue;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				if (!dx && !dy) continue;
				const x = m.x + dx, y = m.y + dy, c = y * W + x;
				if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
				if (blocked[base + c] & (OCCUPIED | RESERVED) || roads.has(c)) continue;
				if (pl.openMask && !pl.openMask[c]) continue;
				if (pl.p && pl.p.water && pl.p.water[c]) continue;
				if (pl.zone && pl.zone[c] !== pl.zone[o.y * W + o.x]) continue;
				if (!footprintFits(o.template, x, y, l, W, H, blocked, true)) continue;
				const d = Math.max(Math.abs(x - o.x), Math.abs(y - o.y));
				if (d < bestD) { bestD = d; bestT = c; }
			}
		}
		if (bestT < 0) return false;
		for (const [fx, fy] of blockingCells(o.template, o.x, o.y)) blocked[base + fy * W + fx] &= ~OCCUPIED;
		o.x = bestT % W; o.y = (bestT / W) | 0;
		o.instanceName = `${o.type}_${o.x}_${o.y}_${l}`;
		delete o.__walled; delete o.__guardAt;
		footprintBlock(o.template, o.x, o.y, l, W, H, blocked);
		return true;
	};
	// a tile a pile's guard may stand on: free, no road on or beside it, its zone, open ground
	const guardTile = (c, zc) => {
		const x = c % W, y = (c / W) | 0;
		if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) return false;
		if (blocked[base + c] & (OCCUPIED | RESERVED) || roads.has(c)) return false;
		if (pl.openMask && !pl.openMask[c]) return false;
		if (pl.p && pl.p.water && pl.p.water[c]) return false;
		if (pl.zone && pl.zone[c] !== zc) return false;
		for (let ey = -1; ey <= 1; ey++) for (let ex = -1; ex <= 1; ex++) if (roads.has((y + ey) * W + x + ex)) return false;
		return true;
	};
	// the last resort for a one-tile pile with no such tile beside it clear of other stacks (beside roads in a town's zone, 72x72 one level
	// seed 1: four Pandora's boxes, 2026-10-08): it moves, within 8 tiles of its zone, to a free tile with one beside it, and returns that tile
	const tightAt = c => { const x = c % W, y = (c / W) | 0; for (const m of monsterAt) if (m !== c && Math.max(Math.abs(m % W - x), Math.abs(((m / W) | 0) - y)) <= 2) return true; return false; };
	const moveToGuardable = o => {
		if (!o.template || !o.template.mask || blockingCells(o.template, o.x, o.y).length !== 1) return -1;
		for (const spaced of [crowdAt, tightAt]) {
		const zc = pl.zone ? pl.zone[o.y * W + o.x] : 0;
		for (let r = 1; r <= 8; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
			if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
			const tx = o.x + dx, ty = o.y + dy, t = ty * W + tx;
			if (!guardTile(t, zc) || !footprintFits(o.template, tx, ty, l, W, H, blocked, true)) continue;
			for (let gy = -1; gy <= 1; gy++) for (let gx = -1; gx <= 1; gx++) {
				if (!gx && !gy) continue;
				const g = (ty + gy) * W + tx + gx;
				if (!guardTile(g, zc) || spaced(g)) continue;
				for (const [fx, fy] of blockingCells(o.template, o.x, o.y)) blocked[base + fy * W + fx] &= ~OCCUPIED;
				o.x = tx; o.y = ty; o.instanceName = `${o.type}_${tx}_${ty}_${l}`;
				delete o.__walled; delete o.__guardAt;
				footprintBlock(o.template, tx, ty, l, W, H, blocked);
				out.relaid = (out.relaid || 0) + 1;
				return g;
			}
		}
		}
		return -1;
	};
	for (const o of pl.objects.slice()) {
		if ((o.l || 0) !== l || !dear(o)) continue;
		let near = false;
		for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1; dx++) if (monsterAt.has((o.y + dy) * W + o.x + dx)) { near = true; break; }
		if (process.env.VMAPGEN_DEAR_TRACE) console.error(`[dear] (${o.x},${o.y}) ${o.type} near ${near}`);
		if (near) continue;
		let spot = -1;
		const spots = [];
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
			if (!dx && !dy) continue;
			const x = o.x + dx, y = o.y + dy, c = y * W + x;
			if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
			if (blocked[base + c] & (OCCUPIED | RESERVED) || roads.has(c)) continue;
			if (pl.openMask && !pl.openMask[c]) continue;
			if (pl.p && pl.p.water && pl.p.water[c]) continue;
			if (pl.zone && pl.zone[c] !== pl.zone[o.y * W + o.x]) continue;
			// not beside a road either: the engine never posts a pile's guard there
			let byRoad = false;
			for (let ey = -1; ey <= 1 && !byRoad; ey++) for (let ex = -1; ex <= 1; ex++) if (roads.has((y + ey) * W + x + ex)) { byRoad = true; break; }
			if (byRoad) continue;
			spots.push(c);
		}
		const tight = c => { const x = c % W, y = (c / W) | 0; for (const m of monsterAt) if (m !== c && Math.max(Math.abs(m % W - x), Math.abs(((m / W) | 0) - y)) <= 2) return true; return false; };
		spot = spots.find(c => !crowdAt(c));
		if (spot === undefined) spot = spots.find(c => !tight(c));
		if (spot === undefined) {
			if (intoRing(o, 6)) { out.shared = (out.shared || 0) + 1; continue; }
			spot = moveToGuardable(o);
			if (spot < 0) spot = spots.length ? spots[0] : -1;
		}
		// no free tile beside it: a one-tile scenery piece beside it makes room (a relic walled in on every side but by loot,
		// its guard's tile taken by later scenery: 72x72 one level seed 1, DMB Dev's picture pass, 2026-10-05)
		if (spot < 0) {
			for (let dy = -1; dy <= 1 && spot < 0; dy++) for (let dx = -1; dx <= 1; dx++) {
				if (!dx && !dy) continue;
				const x = o.x + dx, y = o.y + dy, c = y * W + x;
				if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1 || roads.has(c) || (blocked[base + c] & RESERVED)) continue;
				if (pl.zone && pl.zone[c] !== pl.zone[o.y * W + o.x]) continue;
				if (pl.openMask && !pl.openMask[c]) continue;
				const on = pl.objects.filter(q => (q.l || 0) === l && q.template && blockingCells(q.template, q.x, q.y).some(([a, b2]) => a === x && b2 === y));
				if (on.length !== 1 || !DECOR_TYPES_SET.has(on[0].type) || blockingCells(on[0].template, on[0].x, on[0].y).length !== 1) continue;
				pl.objects.splice(pl.objects.indexOf(on[0]), 1);
				blocked[base + c] &= ~OCCUPIED;
				spot = c; break;
			}
		}
		// still none: a tile beside a road, then the road tile itself beside the pile, as the engine stands a guard on a road when nothing else
		// is beside its pile (Pandora's boxes in a row by a road left open to a flyer: 108 seed 406757263, Opus Reviewer 2026-10-09)
		if (spot < 0) {
			let byRoadSpot = -1, onRoad = -1;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				if (!dx && !dy) continue;
				const x = o.x + dx, y = o.y + dy, c = y * W + x;
				if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1 || (blocked[base + c] & OCCUPIED)) continue;
				if (pl.openMask && !pl.openMask[c]) continue;
				if (pl.p && pl.p.water && pl.p.water[c]) continue;
				if (pl.zone && pl.zone[c] !== pl.zone[o.y * W + o.x]) continue;
				if (roads.has(c)) { if (onRoad < 0) onRoad = c; }
				else if (!(blocked[base + c] & RESERVED) && byRoadSpot < 0) byRoadSpot = c;
			}
			spot = byRoadSpot >= 0 ? byRoadSpot : onRoad;
			if (spot >= 0) out.roadSide = (out.roadSide || 0) + 1;
		}
		// still none (walled in on every side by rock and big pieces): a one-tile pile moves to a free tile in the ring of a monster of its
		// own zone, which guards it for walker and flyer alike (72x72 one level four players seed 1: a relic at (24,19) inside solid rock)
		if (spot < 0 && o.template && o.template.mask) {
			let bestT = -1, bestD = Infinity;
			for (const m of pl.objects) {
				if ((m.l || 0) !== l || !MON.test(m.type)) continue;
				if (pl.zone && pl.zone[m.y * W + m.x] !== pl.zone[o.y * W + o.x]) continue;
				for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
					if (!dx && !dy) continue;
					const x = m.x + dx, y = m.y + dy, c = y * W + x;
					if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
					if (blocked[base + c] & (OCCUPIED | RESERVED) || roads.has(c)) continue;
					if (pl.openMask && !pl.openMask[c]) continue;
					if (pl.p && pl.p.water && pl.p.water[c]) continue;
					if (pl.zone && pl.zone[c] !== pl.zone[o.y * W + o.x]) continue;
					if (!footprintFits(o.template, x, y, l, W, H, blocked, true)) continue;
					const d = Math.max(Math.abs(x - o.x), Math.abs(y - o.y));
					if (d < bestD) { bestD = d; bestT = c; }
				}
			}
			if (bestT >= 0) {
				for (const [fx, fy] of blockingCells(o.template, o.x, o.y)) blocked[base + fy * W + fx] &= ~OCCUPIED;
				o.x = bestT % W; o.y = (bestT / W) | 0;
				o.instanceName = `${o.type}_${o.x}_${o.y}_${l}`;
				delete o.__walled; delete o.__guardAt;
				footprintBlock(o.template, o.x, o.y, l, W, H, blocked);
				out.moved = (out.moved || 0) + 1;
				continue;
			}
		}
		if (spot < 0) { out.left++; continue; }
		if (process.env.VMAPGEN_DEAR_TRACE) console.error(`[dear] (${o.x},${o.y}) guard at (${spot % W},${(spot / W) | 0})`);
		const sized = lootGuardEntry(pl, l, W, o, p, rng, spot, tpl);
		if (sized) { pl.objects.push(sized); footprintBlock(tpl, spot % W, (spot / W) | 0, l, W, H, blocked); monsterAt.add(spot); out.posted++; continue; }
		let level = Math.max(1, Math.min(7, (LEVEL[o.type] || 4) + Math.round(Number(p.monsterStrength) || 0)));
		// a template map writes its guards as the creatures its zones allow: the nearest such guard of the same zone lends its
		// creature and level, so this one is written the same way
		let lend = null, ld = Infinity;
		for (const m of pl.objects) {
			if ((m.l || 0) !== l || !MON.test(m.type) || !m.guardCreature) continue;
			if (pl.zone && pl.zone[m.y * W + m.x] !== pl.zone[o.y * W + o.x]) continue;
			const d = Math.max(Math.abs(m.x - o.x), Math.abs(m.y - o.y));
			if (d < ld) { ld = d; lend = m; }
		}
		if (lend) { const lv = /Level(\d)/.exec(lend.type); if (lv) level = +lv[1]; }
		const ge = objectEntry(`randomMonsterLevel${level}`, spot % W, (spot / W) | 0, l, tpl, 'object', lend && lend.options ? { ...lend.options } : monsterOptions(level, p, rng));
		if (lend) ge.guardCreature = lend.guardCreature;
		pl.objects.push(ge);
		footprintBlock(tpl, spot % W, (spot / W) | 0, l, W, H, blocked);
		monsterAt.add(spot);
		out.posted++;
	}
	// K, 2026-10-08: "found a completely unguarded gold mine in my start biome". The engine guards every gold mine (100% in every zone type on its 20
	// Coldshadow maps, medians 2.2k to 5.9k); ours 31 to 40% in start zones, its guard refused for a road in reach of every tile before the entrance or
	// for want of room. A gold mine with no monster within 2 of its entrance gets one beside the entrance: beside a road if it must, never on one;
	// a tile clear of other stacks first. Its sawmill and ore pit stay open, as the engine leaves them.
	const goldLoot = new Set();
	for (const q of pl.objects) if ((q.l || 0) === l && q.template && q.template.mask && /^(resource|randomResource|treasureChest|campfire|randomArtifact|artifact|spellScroll|pandoraBox)/.test(q.type))
		for (const [fx, fy] of blockingCells(q.template, q.x, q.y)) if (fx >= 0 && fy >= 0 && fx < W && fy < H) goldLoot.add(fy * W + fx);
	for (const o of pl.objects.slice()) {
		if ((o.l || 0) !== l || o.type !== 'mine' || o.subtype !== 'goldMine' || !o.template || !o.template.mask || Number(p.guardMines) === 0) continue;
		// the Mine guard weight lever acts here as on the fill's mine guards: 0 none, below 1 that share
		const mw = Number.isFinite(Number(p.mineGuardWeight)) ? Number(p.mineGuardWeight) : 1;
		if (mw <= 0 || (mw < 1 && rng() >= mw)) continue;
		const vis = visitableCells(o.template, o.x, o.y);
		// guarded when every free tile before the entrance lies in a guard's ring (a stack 2 tiles off that covers none of them guards nothing:
		// 2 of 6 open mines beside a stack on a 144x144 were gold, 2026-10-08)
		const ownM = new Set(blockingCells(o.template, o.x, o.y).map(([a, b]) => b * W + a));
		const frontFree = [];
		for (const [vx, vy] of vis) for (const [dx, dy] of allowedDirs(o.template)) {
			const c = (vy + dy) * W + vx + dx;
			if (vx + dx < 0 || vy + dy < 0 || vx + dx >= W || vy + dy >= H || ownM.has(c) || frontFree.includes(c)) continue;
			// loot before the entrance is no wall: a hero takes it and walks in (resources laid before a mine left it open to a walker)
			if ((blocked[base + c] & OCCUPIED) && !goldLoot.has(c)) continue;
			if (pl.openMask && !pl.openMask[c]) continue;
			if (pl.p && pl.p.water && pl.p.water[c]) continue;
			frontFree.push(c);
		}
		const ringed = c => [...monsterAt].some(m => Math.max(Math.abs(m % W - c % W), Math.abs(((m / W) | 0) - ((c / W) | 0))) <= 1);
		if (process.env.VMAPGEN_GOLD_TRACE) console.error(`[gold] (${o.x},${o.y}) L${l}: front free ${frontFree.length}, outside a ring ${frontFree.filter(c => !ringed(c)).length}`);
		if (!frontFree.some(c => !ringed(c))) continue;
		const zc = pl.zone ? pl.zone[vis[0][1] * W + vis[0][0]] : 0;
		// a tile before the entrance first, then any within 2 of it (behind the resources laid beside the mine), then a reserved tile that is no road
		const cands = [], rank = new Map();
		const own = new Set(blockingCells(o.template, o.x, o.y).map(([a, b]) => b * W + a));
		const front = new Set();
		for (const [vx, vy] of vis) for (const [dx, dy] of allowedDirs(o.template)) front.add((vy + dy) * W + vx + dx);
		for (const [vx, vy] of vis) for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
			const x = vx + dx, y = vy + dy, c = y * W + x;
			if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1 || own.has(c) || rank.has(c)) continue;
			// the road tile before the entrance too: the engine stands a mine's guard on its access tile, road or not, and one guard there rings every
			// tile before the entrance (a guard beside the road left the far side open: 8 of 23 gold mines on e0cfc5c, Opus Reviewer 2026-10-09)
			if ((blocked[base + c] & OCCUPIED) || (roads.has(c) && !front.has(c))) continue;
			if (pl.openMask && !pl.openMask[c]) continue;
			if (pl.p && pl.p.water && pl.p.water[c]) continue;
			if (pl.zone && pl.zone[c] !== zc) continue;
			rank.set(c, front.has(c) ? (roads.has(c) ? 0 : (blocked[base + c] & RESERVED) ? 3 : 0) : ((blocked[base + c] & RESERVED) ? 12 : 4));   // the engine's guard stands before the entrance
			cands.push(c);
		}
		const byRoad = c => { const x = c % W, y = (c / W) | 0; for (let ey = -1; ey <= 1; ey++) for (let ex = -1; ex <= 1; ex++) if (roads.has((y + ey) * W + x + ex)) return true; return false; };
		// of equal rank, the tile whose ring covers most of the open front
		const cover = c => frontFree.filter(f => !ringed(f) && Math.max(Math.abs(f % W - c % W), Math.abs(((f / W) | 0) - ((c / W) | 0))) <= 1).length;
		cands.sort((a, b) => (rank.get(a) + (crowdAt(a) ? 2 : 0) + (byRoad(a) ? 1 : 0) - cover(a) * 0.5) - (rank.get(b) + (crowdAt(b) ? 2 : 0) + (byRoad(b) ? 1 : 0) - cover(b) * 0.5));
		const spot = cands.length ? cands[0] : -1;
		if (spot < 0) { out.goldLeft = (out.goldLeft || 0) + 1; continue; }
		const sized = lootGuardEntry(pl, l, W, o, p, rng, spot, tpl);
		// no creature of the zone's pool fits the strength: the nearest concrete guard of the zone lends its creature and level, as for a dear pile
		let ge = sized;
		if (!ge) {
			let lend = null, ld = Infinity;
			for (const m of pl.objects) {
				if ((m.l || 0) !== l || !MON.test(m.type) || !m.guardCreature) continue;
				if (pl.zone && pl.zone[m.y * W + m.x] !== zc) continue;
				const dd = Math.max(Math.abs(m.x - o.x), Math.abs(m.y - o.y));
				if (dd < ld) { ld = dd; lend = m; }
			}
			const lv = lend && /Level(d)/.exec(lend.type);
			ge = objectEntry(`randomMonsterLevel${lv ? lv[1] : 4}`, spot % W, (spot / W) | 0, l, tpl, 'object', lend && lend.options ? { ...lend.options } : monsterOptions(4, p, rng));
			if (lend) ge.guardCreature = lend.guardCreature;
		}
		pl.objects.push(ge); footprintBlock(tpl, spot % W, (spot / W) | 0, l, W, H, blocked); monsterAt.add(spot);
		out.gold = (out.gold || 0) + 1;
	}
	// a creature dwelling with no monster on or beside its footprint gets one on a free tile beside its entrance, as a dear pile does
	// (DMB Dev's picture pass: the crystal cavern at (54,26), 72x72 one level four players seed 1, guard 3 tiles off)
	if (Number(p.guardDwellings) !== 0 && Number(p.lootGuardWeight) !== 0 && Number(p.guardTreasure) !== 0)
		for (const o of pl.objects.slice()) {
			if ((o.l || 0) !== l || !/^creatureGenerator/.test(o.type) || !o.template || !o.template.mask) continue;
			const foot = new Set(blockingCells(o.template, o.x, o.y).map(([x, y]) => y * W + x));
			for (const [vx, vy] of visitableCells(o.template, o.x, o.y)) foot.add(vy * W + vx);
			const ring = new Set();
			for (const c of foot) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const x = (c % W) + dx, y = ((c / W) | 0) + dy; if (x >= 0 && y >= 0 && x < W && y < H && !foot.has(y * W + x)) ring.add(y * W + x); }
			if ([...foot, ...ring].some(c => monsterAt.has(c))) continue;
			const vis = visitableCells(o.template, o.x, o.y).map(([x, y]) => [x, y]);
			let spot = -1, sd = Infinity;
			const crowdAtD = c => { const x = c % W, y = (c / W) | 0; for (const m of monsterAt) if (Math.max(Math.abs(m % W - x), Math.abs(((m / W) | 0) - y)) < GAP) return true; return false; };
			for (const c of ring) {
				const x = c % W, y = (c / W) | 0;
				if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1 || (blocked[base + c] & (OCCUPIED | RESERVED)) || roads.has(c)) continue;
				if (pl.openMask && !pl.openMask[c]) continue;
				if (pl.p && pl.p.water && pl.p.water[c]) continue;
				if (pl.zone && pl.zone[c] !== pl.zone[o.y * W + o.x]) continue;
				let byRoad = false;
				for (let ey = -1; ey <= 1 && !byRoad; ey++) for (let ex = -1; ex <= 1; ex++) if (roads.has((y + ey) * W + x + ex)) { byRoad = true; break; }
				if (byRoad) continue;
				const d = Math.min(...vis.map(([vx, vy]) => Math.max(Math.abs(vx - x), Math.abs(vy - y))), 9) + (crowdAtD(c) ? 10 : 0);
				if (d < sd) { sd = d; spot = c; }
			}
			if (spot < 0) { out.left++; continue; }
			const sized = lootGuardEntry(pl, l, W, o, p, rng, spot, tpl);
			if (sized) { pl.objects.push(sized); footprintBlock(tpl, spot % W, (spot / W) | 0, l, W, H, blocked); monsterAt.add(spot); out.posted++; continue; }
			let level = Math.max(1, Math.min(7, 4 + Math.round(Number(p.monsterStrength) || 0)));
			let lend = null, ld = Infinity;
			for (const m of pl.objects) {
				if ((m.l || 0) !== l || !MON.test(m.type) || !m.guardCreature) continue;
				if (pl.zone && pl.zone[m.y * W + m.x] !== pl.zone[o.y * W + o.x]) continue;
				const d = Math.max(Math.abs(m.x - o.x), Math.abs(m.y - o.y));
				if (d < ld) { ld = d; lend = m; }
			}
			if (lend) { const lv = /Level(\d)/.exec(lend.type); if (lv) level = +lv[1]; }
			const ge = objectEntry(`randomMonsterLevel${level}`, spot % W, (spot / W) | 0, l, tpl, 'object', lend && lend.options ? { ...lend.options } : monsterOptions(level, p, rng));
			if (lend) ge.guardCreature = lend.guardCreature;
			pl.objects.push(ge);
			footprintBlock(tpl, spot % W, (spot / W) | 0, l, W, H, blocked);
			monsterAt.add(spot);
			out.posted++;
		}
	return out;
}

/**
 * On a one-level map with water the template's forced-underground zones (Coldshadow's four junctions) lay out wherever the islands fall, and one
 * of them can hold most of the dragon dwellings on a far island (K, 2026-10-06, islands 144x144: "on water maps with no underground, we should
 * make sure that the coldshadow dwellings only spawn in the middle ... 3 crystal dragon caverns in the bottom right island"; the zone was 63 tiles
 * from the centre with 7 of the 12 dwellings). A neutral dragon dwelling in such a zone farther from the centre than 30% of the map's side moves,
 * with its guard, into the nearest of those zones that lie within that distance, onto ground that has room for it; none within it, nothing moves.
 * Returns a line for the log, or null.
 */
function gatherDragons(plans, W, H, blocked, p, rng) {
	if (process.env.VMAPGEN_GATHER_DRAGONS === '0' || plans.length !== 1) return null;
	const pl = plans[0], l = 0, base = 0, zone = pl.zone, water = pl.p && pl.p.water;
	if (!zone || !water || !p.zonePlan) return null;
	const DRAGON = /^(frozenCliffs|crystalCavern|magicForest|sulfurousLair)$/i;
	const recs = (p.zonePlan.perLevel && p.zonePlan.perLevel[0]) || [];
	const junction = new Set();
	recs.forEach((z, i) => { if (z && (z.wasUnderground || z.forcedLevel === 'underground')) junction.add(i); });
	if (junction.size < 2) return null;
	const cen = new Map();
	for (let c = 0; c < W * H; c++) {
		const z = zone[c];
		if (z < 0 || !junction.has(z) || water[c]) continue;
		const e = cen.get(z) || { n: 0, x: 0, y: 0 };
		e.n++; e.x += c % W; e.y += (c / W) | 0;
		cen.set(z, e);
	}
	const R = 0.28 * Math.min(W, H), cx = W / 2, cy = H / 2;
	const dist = z => { const e = cen.get(z); return e && e.n ? Math.hypot(e.x / e.n - cx, e.y / e.n - cy) : Infinity; };
	const near = [...junction].filter(z => dist(z) <= R).sort((a, b) => dist(a) - dist(b));
	if (!near.length) return null;
	const MON = /^(monster|randomMonster)/;
	const moved = [];
	const load = new Map(near.map(z => [z, 0]));
	for (const o of pl.objects) if (/^creatureGenerator/.test(o.type) && DRAGON.test(o.subtype || '') && load.has(zone[o.y * W + o.x])) load.set(zone[o.y * W + o.x], load.get(zone[o.y * W + o.x]) + 1);
	for (const o of pl.objects.slice()) {
		if ((o.l || 0) !== l || !/^creatureGenerator/.test(o.type) || !DRAGON.test(o.subtype || '') || !o.template) continue;
		const z0 = zone[o.y * W + o.x];
		if (!junction.has(z0) || Math.hypot(o.x - cx, o.y - cy) <= R) continue;
		// the target: the central junction zone holding the fewest dragon dwellings so far
		const targets = [...load.keys()].sort((a, b) => load.get(a) - load.get(b) || dist(a) - dist(b));
		let spot = null, tz = -1;
		for (const z of targets) { spot = sceneryRoom(pl, l, W, H, blocked, o.template, q => q === z, (x, y) => Math.hypot(x - cx, y - cy)); if (spot && Math.hypot(spot.x - cx, spot.y - cy) <= R) { tz = z; break; } spot = null; }
		if (!spot) { moved.push(`${o.subtype} (${o.x},${o.y}): no room`); continue; }
		// its guard: the stacks within a tile of its footprint or entrance go with it, the strongest one only
		const foot = blockingCells(o.template, o.x, o.y).concat(visitableCells(o.template, o.x, o.y));
		const guards = pl.objects.filter(m => (m.l || 0) === l && MON.test(m.type) && foot.some(([fx, fy]) => Math.max(Math.abs(fx - m.x), Math.abs(fy - m.y)) <= 1));
		const guard = guards.sort((a, b) => ((b.options && b.options.amount) || 0) - ((a.options && a.options.amount) || 0))[0] || null;
		clearScenery(pl, l, W, H, blocked, { gone: new Set([o, ...guards]) });
		const gone = clearScenery(pl, l, W, H, blocked, spot);
		const e = objectEntry(o.type, spot.x, spot.y, l, o.template, o.subtype, o.options ? { ...o.options } : undefined);
		pl.objects.push(e);
		footprintBlock(o.template, spot.x, spot.y, l, W, H, blocked);
		markApproach(o.template, spot.x, spot.y, l, W, H, blocked);
		if (guard) {
			const g = spot.ways[0], gx = g % W, gy = (g / W) | 0;
			const ge = objectEntry(guard.type, gx, gy, l, guard.template, 'object', guard.options ? { ...guard.options } : undefined);
			if (guard.guardCreature) ge.guardCreature = guard.guardCreature;
			pl.objects.push(ge);
			footprintBlock(guard.template, gx, gy, l, W, H, blocked);
		}
		load.set(tz, load.get(tz) + 1);
		moved.push(`${o.subtype} (${o.x},${o.y}) zone ${z0} to (${spot.x},${spot.y}) zone ${tz}, ${gone} scenery piece(s) cleared`);
	}
	return moved.length ? moved.join('; ') : null;
}


/**
 * A town with no road on the tile in front of its entrance and no free way to a road of its zone (14 of 1,097 towns on the 80-map grid; K's XL
 * map: two neutral towns in pockets of scenery) gets the scenery on its shortest way cleared: the way runs over open ground at 1 a tile and over a
 * scenery piece (not one touching a zone line) at 4, inside the town's own zone, to the nearest road tile within 130 steps (loot and monsters at 2 a tile). The pieces go whole.
 * Returns { cleared, towns }; joinBareTowns then lays the road over the way.
 */
function clearWayToRoad(pl, l, W, H, blocked) {
	const out = { cleared: 0, towns: 0 };
	const R = pl.roadCells, zone = pl.zone;
	if (!R || !R.size || !zone) return out;
	const base = l * W * H, water = pl.p && pl.p.water;
	const cover = objectCover(pl, l, W, H);
	// loot and monsters are no wall for the road (a pickup vanishes when taken, a hero fights through a monster): the way crosses them at 2 a tile, and
	// joinBareTowns lays the road over them. VMAPGEN_TOWN_ROAD_SOFT=0 keeps them walls.
	const softCells = new Set();
	const wallOk = process.env.VMAPGEN_TOWN_ROAD_WALL !== '0';
	if (process.env.VMAPGEN_TOWN_ROAD_SOFT !== '0')
		for (const q of pl.objects) if ((q.l || 0) === l && q.template && q.template.mask && (/^(resource|randomResource|treasureChest|campfire|randomArtifact|artifact|spellScroll|pandoraBox|monster|randomMonster)/.test(q.type)))
			for (const [fx, fy] of blockingCells(q.template, q.x, q.y)) if (fx >= 0 && fy >= 0 && fx < W && fy < H) softCells.add(fy * W + fx);
	const onLine = c => {
		const x = c % W, y = (c / W) | 0;
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
			const u = x + dx, v = y + dy;
			if (u >= 0 && v >= 0 && u < W && v < H && zone[v * W + u] >= 0 && zone[v * W + u] !== zone[c]) return true;
		}
		return false;
	};
	for (const o of pl.objects) {
		if ((o.l || 0) !== l || !o.template || !/^(town|randomTown)$/.test(o.type)) continue;
		const vis = visitableCells(o.template, o.x, o.y).filter(([x, y]) => x >= 0 && y >= 0 && x < W && y < H - 1).map(([x, y]) => y * W + x);
		if (!vis.length) continue;
		const front = vis.map(c => c + W);
		if (front.some(c => R.has(c)) || vis.some(c => R.has(c))) continue;
		const z = zone[vis[0]];
		// a zone with no road of its own (an island zone alone on its island): the way runs to what joinBareTowns joins there instead,
		// an object a hero visits 8 tiles off or the shore (a neutral island town in scenery, i108 seed 2, 2026-10-09)
		let zoneHasRoad = false;
		for (const c of R) if (zone[c] === z) { zoneHasRoad = true; break; }
		const goals = zoneHasRoad ? null : require('./gateroad').roadlessGoals(pl, W, H, l, blocked, OCCUPIED, visitableCells, o, vis, z);
		if (process.env.VMAPGEN_TOWNROAD_TRACE && goals) console.error(`[clearway] (${o.x},${o.y}) zone ${z}: no road in the zone, ${goals.size} goal tile(s)`);
		if (goals && !goals.size) continue;
		const isGoal = c => (goals ? goals.has(c) : R.has(c));
		const cost = c => {
			if (zone[c] !== z || (water && water[c]) || (pl.openMask && !pl.openMask[c])) return -1;
			if (!(blocked[base + c] & OCCUPIED)) return 1;
			if (softCells.has(c) && !cover.scenAt.get(c)) return 2;
			const so = cover.scenAt.get(c);
			if (!so || cover.other.has(c)) return -1;
			// a piece on or beside a zone line is the wall: it goes only as a last way (9 a tile) and its line tiles are shut again below
			return blockingCells(so.template, so.x, so.y).some(([fx, fy]) => fx >= 0 && fy >= 0 && fx < W && fy < H && onLine(fy * W + fx)) ? (wallOk ? 9 : -1) : 4;
		};
		const dist = new Map(), prev = new Map(), pq = [];
		for (const c of front) if (cost(c) > 0) { dist.set(c, cost(c)); pq.push(c); }
		let hit = -1;
		while (pq.length) {
			let bi = 0;
			for (let i = 1; i < pq.length; i++) if (dist.get(pq[i]) < dist.get(pq[bi])) bi = i;
			const c = pq[bi]; pq[bi] = pq[pq.length - 1]; pq.pop();
			if (isGoal(c)) { hit = c; break; }
			if (dist.get(c) > 130) break;
			const x = c % W, y = (c / W) | 0;
			for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
				const u = x + dx, v = y + dy;
				if (u < 1 || v < 1 || u >= W - 1 || v >= H - 1) continue;
				const n = v * W + u, k = R.has(n) ? 1 : cost(n);
				if (k < 0) continue;
				const d = dist.get(c) + k;
				if (!dist.has(n) || d < dist.get(n)) { dist.set(n, d); prev.set(n, c); if (!pq.includes(n)) pq.push(n); }
			}
		}
		if (process.env.VMAPGEN_TOWNROAD_TRACE && hit < 0) console.error(`[clearway] (${o.x},${o.y}): no way within 130`);
		if (hit < 0) continue;
		const gone = new Set();
		for (let c = hit; c !== undefined; c = prev.get(c)) { const so = cover.scenAt.get(c); if (so && (blocked[base + c] & OCCUPIED) && !cover.other.has(c)) gone.add(so); }
		const onPath = new Set(); for (let c = hit; c !== undefined; c = prev.get(c)) onPath.add(c);
		const wallCells = [];
		for (const so of gone) for (const [fx, fy] of blockingCells(so.template, so.x, so.y)) if (fx >= 0 && fy >= 0 && fx < W && fy < H && onLine(fy * W + fx) && !onPath.has(fy * W + fx)) wallCells.push(fy * W + fx);
		if (gone.size) {
			out.cleared += clearScenery(pl, l, W, H, blocked, { gone }); out.towns++;
			// the zone-line tiles the cleared pieces held, off the way, get a one-tile obstacle again (as joinZoneWaysIn does)
			if (pl.biomeTerrain) for (const c of wallCells) {
				if (blocked[base + c] & OCCUPIED) continue;
				let r = (c * 2654435761) >>> 0; const rng2 = () => ((r = (r * 1664525 + 1013904223) >>> 0) / 4294967296);
				const sg = singleTemplate(pl.biomeTerrain[zone[c]], rng2);
				if (!sg || !sg.tpl.mask || sg.tpl.mask.length !== 1 || sg.tpl.mask[0].length !== 1) continue;
				pl.objects.push(objectEntry(sg.type, c % W, (c / W) | 0, l, sg.tpl, sg.subtype || 'object'));
				footprintBlock(sg.tpl, c % W, (c / W) | 0, l, W, H, blocked);
			}
		}
	}
	return out;
}


/**
 * An 8x8 stretch of open ground with no loot, monster, mine, dwelling or bank in it gets one resource pile from its zone's own
 * (K, 2026-10-05, a brown zone with "mountain clumps and trees but almost no loot": 3.7% of 8x8 windows on 144 one level held none,
 * the engine's maps 0.7%). The pile goes on the free tile nearest the window's middle that has room around it (not a road, a
 * reserved or approach tile, nor one that would plug a passage). Returns { added }.
 */
function fillBareWindows(pl, l, W, H, blocked, p) {
	const out = { added: 0, lifted: 0 }, base = l * W * H, WIN = 8, STEP = 4;
	if (Number(p.resourceDensity) === 0 || !pl.zone) return out;
	const LOOT = /^(resource|randomResource|treasureChest|campfire|randomArtifact|artifact|spellScroll|pandoraBox|monster|randomMonster|creatureGenerator|creatureBank|mine|abandonedMine)/;
	const roads = pl.roadCells || new Set(), water = pl.p && pl.p.water;
	const has = new Uint8Array(W * H);
	const piles = new Map();
	for (const o of pl.objects) {
		if ((o.l || 0) !== l) continue;
		if (LOOT.test(o.type) && o.x >= 0 && o.y >= 0 && o.x < W && o.y < H) {
			has[o.y * W + o.x] = 1;
			// the measure counts every tile of a pile, a mine or a dwelling
			if (o.template && o.template.mask) for (const [fx, fy] of blockingCells(o.template, o.x, o.y)) if (fx >= 0 && fy >= 0 && fx < W && fy < H) has[fy * W + fx] = 1;
		}
		if ((o.type === 'resource' || o.type === 'randomResource') && o.template) {
			const z = pl.zone[o.y * W + o.x];
			if (!piles.has(z)) piles.set(z, []);
			piles.get(z).push(o);
		}
	}
	const anyPile = [].concat(...piles.values());
	const land = c => pl.zone[c] >= 0 && !(water && water[c]) && (!pl.openMask || pl.openMask[c]);
	const free = c => land(c) && !(blocked[base + c] & (OCCUPIED | RESERVED | APPROACH)) && !roads.has(c);
	// the window's loot count and open ground
	const read = (x0, y0) => {
		let open = 0, n = 0;
		for (let y = y0; y < y0 + WIN; y++) for (let x = x0; x < x0 + WIN; x++) {
			const c = y * W + x;
			if (has[c]) n++;
			if (land(c) && !(blocked[base + c] & OCCUPIED)) open++;
		}
		return { open, n };
	};
	// one pile from the zone's own, on the free tile nearest the window's middle that has room around it
	const place = (x0, y0, minRoom = 4) => {
		let best = -1, bd = Infinity;
		for (let y = y0; y < y0 + WIN; y++) for (let x = x0; x < x0 + WIN; x++) {
			const c = y * W + x;
			if (!free(c)) continue;
			let room = 0;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && free((y + dy) * W + x + dx)) room++;
			if (room < minRoom) continue;
			// the pile need not be at the window's middle: a shift of up to 2 tiles either way (from the window and the count so far) keeps a plain from showing a grid of piles
			const dx0 = ((x0 * 7 + y0 * 13 + (out.added + out.lifted) * 5) % 5) - 2, dy0 = ((x0 * 11 + y0 * 3 + (out.added + out.lifted) * 7) % 5) - 2;
			const d = (x - (x0 + WIN / 2 + dx0)) ** 2 + (y - (y0 + WIN / 2 + dy0)) ** 2;
			if (d < bd) { bd = d; best = c; }
		}
		if (best < 0) return false;
		const src = piles.get(pl.zone[best]) && piles.get(pl.zone[best]).length ? piles.get(pl.zone[best]) : anyPile;
		if (!src || !src.length) return false;
		const s = src[(out.added + out.lifted) % src.length], x = best % W, y = (best / W) | 0;
		pl.objects.push(objectEntry(s.type, x, y, l, s.template, s.subtype, s.options ? { ...s.options } : undefined));
		footprintBlock(s.template, x, y, l, W, H, blocked);
		markApproach(s.template, x, y, l, W, H, blocked);
		has[best] = 1;
		return true;
	};
	for (let y0 = 1; y0 + WIN <= H - 1; y0 += STEP) for (let x0 = 1; x0 + WIN <= W - 1; x0 += STEP) {
		const w = read(x0, y0);
		if (w.n || w.open < 32) continue;
		if (place(x0, y0)) out.added++;
	}
	// a window under a third of the median of its neighbours (K, 2026-10-05: "0 loot, or a lot less than their neighbors") is lifted to
	// about half that median, from the zone's own piles; the windows are the 8x8 tiles of the level, the neighbours the eight around
	const nx = Math.floor((W - 2) / WIN), ny = Math.floor((H - 2) / WIN);
	const grid = [];
	for (let j = 0; j < ny; j++) { grid.push([]); for (let i = 0; i < nx; i++) grid[j].push(read(1 + i * WIN, 1 + j * WIN)); }
	for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
		const w = grid[j][i];
		if (w.open < 32) continue;
		const nb = [];
		for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
			if ((!di && !dj) || j + dj < 0 || i + di < 0 || j + dj >= ny || i + di >= nx) continue;
			const q = grid[j + dj][i + di];
			if (q.open >= 32) nb.push(q.n);
		}
		if (nb.length < 4) continue;
		nb.sort((u, v) => u - v);
		const med = (nb[(nb.length - 1) >> 1] + nb[nb.length >> 1]) / 2;
		if (med < 3 || w.n >= med / 3) continue;
		const want = Math.min(4, Math.ceil(med / 2) - w.n);
		for (let k = 0; k < want; k++) if (place(1 + i * WIN, 1 + j * WIN, 2)) out.lifted++; else break;
	}
	// a window far under the median of its level (K, 2026-10-06, the empty snow plain of a start zone: its neighbours were as bare as it was, so the
	// neighbour rule above passed it, and the zone's own median was that plain; MapGen Dev's biome-density check read 16 windows, 2304 land tiles and 32 objects): windows under 0.3 of
	// the level's median are lifted to 0.6 of it, from their zone's own piles
	const byZone = new Map();
	for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
		const w = read(1 + i * WIN, 1 + j * WIN);
		if (w.open < 32) continue;
		const z = pl.zone[(1 + j * WIN + 4) * W + 1 + i * WIN + 4] >= 0 ? 0 : -1;
		if (z < 0) continue;
		if (!byZone.has(z)) byZone.set(z, []);
		byZone.get(z).push([i, j, w]);
	}
	for (const [, ws] of byZone) {
		if (ws.length < 12) continue;
		const ns = ws.map(([, , w]) => w.n).sort((u, v) => u - v);
		const med = (ns[(ns.length - 1) >> 1] + ns[ns.length >> 1]) / 2;
		if (med < 4) continue;
		for (const [i, j, w] of ws) {
			if (w.n >= 0.3 * med) continue;
			const want = Math.min(5, Math.ceil(0.6 * med) - w.n);
			for (let k = 0; k < want; k++) if (place(1 + i * WIN, 1 + j * WIN, 2)) out.lifted++; else break;
		}
	}
	return out;
}

function ensureSignatureDwelling(plans, W, H, blocked, objectPools, p, rng) {
	const cands = objectPools.__sigCands || [], rich = objectPools.__richZones || new Set();
	if (!rich.size || !(cands.length || objectPools.__sigDw)) return null;
	const sub = new Set(cands.map(c => c.subtype));
	const idOf = (l, z) => { const lz = p.zonePlan.perLevel && p.zonePlan.perLevel[l]; return lz && lz[z] ? lz[z].id : undefined; };
	// K, 2026-10-04, islands Coldshadow: "each dragon island should have at least one generation structure": every rich zone with no
	// town (a band from 50000) holds one of the signature dwellings, not only the map. The kinds go round, so a map with four dragon
	// zones shows more than one kind (his map had a single Frozen Cliffs).
	const have = new Set(), kinds = new Map(), present = new Set();
	for (let l = 0; l < plans.length; l++) {
		const zone = plans[l].zone;
		if (zone) for (let c = 0; c < W * H; c++) if (zone[c] >= 0) present.add(idOf(l, zone[c]));
		for (const o of plans[l].objects)
			if ((o.l || 0) === l && /^creatureGenerator/.test(o.type) && sub.has(o.subtype)) {
				kinds.set(o.subtype, (kinds.get(o.subtype) || 0) + 1);
				if (zone) have.add(idOf(l, zone[o.y * W + o.x]));
			}
	}
	// a dragon island is a rich zone with no town of its own (Coldshadow's four junction zones); the rich zone with the castle keeps
	// what its piles drew
	const recOf = id => (p.zonePlan.perLevel || []).flat().find(z => z && z.id === id);
	// K, 2026-10-05: "at least one dwelling per center island on island coldshadows". On an islands layout the rich zone with the
	// castle (Coldshadow's centre, zone 21) is an island of its own in the middle, and it takes one too; a start's zone never does
	const shape = require('./water').shapeOf(p);
	const islands = !!(shape && shape.islands && Number(p.waterCoverage) > 0);
	const wanted = [...rich].filter(id => present.has(id) && !have.has(id) && recOf(id) && !recOf(id).playerTowns && (islands || !recOf(id).neutralTowns));
	const lines = [];
	for (const id of wanted) {
		const pool = cands.length ? cands : [objectPools.__sigDw];
		const fewest = Math.min(...pool.map(c => kinds.get(c.subtype) || 0));
		const tied = pool.filter(c => (kinds.get(c.subtype) || 0) === fewest);
		const d = tied[(rng() * tied.length) | 0];
		if (!d || !d.tpl) continue;
		let best = null;
		for (let l = 0; l < plans.length && !(best && best.cost === 0); l++) {
			const spot = sceneryRoom(plans[l], l, W, H, blocked, d.tpl, z => idOf(l, z) === id, () => 0);
			if (spot && (!best || spot.cost < best.cost)) best = spot;
		}
		if (!best) { lines.push(`zone ${id}: no room`); continue; }
		const { l, x, y, ways } = best, pl = plans[l], base = l * W * H;
		const gone = clearScenery(pl, l, W, H, blocked, best);
		pl.objects.push(objectEntry(d.type, x, y, l, d.tpl, d.subtype));
		footprintBlock(d.tpl, x, y, l, W, H, blocked);
		markApproach(d.tpl, x, y, l, W, H, blocked);
		const g = ways[0], gx = g % W, gy = (g / W) | 0;
		pl.objects.push(objectEntry('randomMonsterLevel6', gx, gy, l, OBJECT_TEMPLATES.randomMonster, 'object', monsterOptions(6, p, rng)));
		blocked[base + g] |= OCCUPIED;
		kinds.set(d.subtype, (kinds.get(d.subtype) || 0) + 1);
		lines.push(`zone ${id}: ${d.subtype || d.type} at (${x},${y}) level ${l}, ${gone} scenery object(s) cleared, guarded`);
	}
	return lines.length ? lines.join('; ') : null;
}

/**
 * Where a template `tpl` can stand in a zone `zoneOk(z)` accepts, on open ground or over interior scenery: the spot
 * with the fewest scenery tiles under it, then the lowest `score(x, y)`. Nothing goes on a zone line (a tile beside
 * another zone), and no scenery piece that touches one is cleared, so every border stays shut; retile.js only dresses
 * cells that a scenery object covers, so a piece is removed whole or not at all. The way in needs two open tiles of
 * the same zone, and `waysOk(ways)` when given. Returns { l, x, y, cost, ways, gone } or null; clearScenery() then takes
 * the pieces out.
 */
function sceneryRoom(pl, l, W, H, blocked, tpl, zoneOk, score, waysOk = null) {
	const zone = pl.zone, base = l * W * H;
	if (!zone) return null;
	const onLine = c => {
		const x = c % W, y = (c / W) | 0;
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
			const u = x + dx, v = y + dy;
			if (u >= 0 && v >= 0 && u < W && v < H && zone[v * W + u] >= 0 && zone[v * W + u] !== zone[c]) return true;
		}
		return false;
	};
	const cover = objectCover(pl, l, W, H);
	const scenAt = new Map();
	for (const [c, o] of cover.scenAt) {
		const cells = blockingCells(o.template, o.x, o.y).filter(([fx, fy]) => fx >= 0 && fy >= 0 && fx < W && fy < H).map(([fx, fy]) => fy * W + fx);
		if (!cells.some(onLine)) scenAt.set(c, o);
	}
	const road = pl.roadCells || new Set();
	let best = null;
	for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
		const z = zone[y * W + x];
		if (z < 0 || !zoneOk(z)) continue;
		let ok = true, cost = 0;
		const gone = new Set();
		for (const [fx, fy] of blockingCells(tpl, x, y)) {
			if (fx < 1 || fy < 1 || fx >= W - 1 || fy >= H - 1) { ok = false; break; }
			const c = fy * W + fx;
			if (zone[c] !== z || road.has(c) || onLine(c)) { ok = false; break; }
			if ((blocked[base + c] & OCCUPIED) || cover.scenAt.has(c) || cover.other.has(c)) {
				const o = scenAt.get(c);
				if (!o) { ok = false; break; }
				if (!gone.has(o)) { gone.add(o); cost += blockingCells(o.template, o.x, o.y).length; }
			}
		}
		if (!ok) continue;
		// the object's own footprint is no way in (a mine entered from its sides counted its own two side tiles)
		const own = new Set(blockingCells(tpl, x, y).map(([fx, fy]) => fy * W + fx));
		const ways = approachCells(tpl, x, y, l, W, H, blocked).filter(c => zone[c] === z && !own.has(c) && !cover.scenAt.has(c) && !cover.other.has(c));
		if (ways.length < 2 || (waysOk && !waysOk(ways))) continue;
		const sc = score(x, y);
		if (!best || cost < best.cost || (cost === best.cost && sc < best.sc)) best = { l, x, y, cost, sc, ways, gone };
	}
	return best;
}

/** Take out the scenery pieces sceneryRoom() chose, freeing every cell no other object blocks. Returns how many. */
function clearScenery(pl, l, W, H, blocked, spot) {
	const gone = spot.gone, base = l * W * H;
	if (!gone.size) return 0;
	const keep = new Set();
	for (const o of pl.objects) if ((o.l || 0) === l && o.template && !gone.has(o)) for (const [fx, fy] of blockingCells(o.template, o.x, o.y)) keep.add(fy * W + fx);
	for (const o of gone) for (const [fx, fy] of blockingCells(o.template, o.x, o.y)) { const c = fy * W + fx; if (fx >= 0 && fy >= 0 && fx < W && fy < H && !keep.has(c)) blocked[base + c] &= ~OCCUPIED; }
	pl.objects = pl.objects.filter(o => !gone.has(o));
	return gone.size;
}

/**
 * Every start gets the sawmill and ore pit placeStarterMines() promises. On a map far below its template's size
 * (Coldshadow on 36x36, one level) the walls and scenery had covered nearly every tile of a start's zone by then, and
 * 5 of 8 starter mines over 4 seeds went missing (K, 2026-10-03: "small coldshadow's is scuffed"). A start with no
 * mine of a kind in its own zone that it reaches without a fight gets one over that zone's interior scenery, about 6 tiles from its town, where the
 * engine and the corpus put them. freeStartMines() then opens the walk to it. VMAPGEN_START_MINE_ROOM=0 off.
 */
function ensureStartMines(pl, l, W, H, blocked, biomeTerrain) {
	const zone = pl.zone, out = [];
	if (!zone) return out;
	const towns = pl.objects.filter(o => (o.l || 0) === l && o.template && /^(town|randomTown)$/.test(o.type) && o.options && o.options.owner);
	for (const t of towns) {
		const from = approachCells(t.template, t.x, t.y, l, W, H, blocked);
		const z = from.length ? zone[from[0]] : zone[t.y * W + t.x];
		for (const kind of STARTER_MINES) {
			// a mine of the kind counts only if the start's guard-free walk reaches it (through scenery freeStartMines will
			// clear): the zone's own guarded ore pit in a far corner left a two-player 36x36 start's first ore behind a fight
			const walk = startWalk(pl, l, W, H, blocked, t);
			if (pl.objects.some(o => (o.l || 0) === l && o.type === 'mine' && o.subtype === kind && zone[o.y * W + o.x] === z
				&& (!walk || approachCells(o.template, o.x, o.y, l, W, H, blocked).some(c => walk.cost[c] >= 0)))) continue;
			const tpl = mineTemplate(kind, biomeTerrain ? biomeTerrain[z] : undefined);
			const spot = sceneryRoom(pl, l, W, H, blocked, tpl, zz => zz === z, (x, y) => Math.abs(Math.max(Math.abs(x - t.x), Math.abs(y - t.y)) - 6),
				walk ? ways => ways.some(c => walk.cost[c] >= 0) : null);
			if (!spot) { out.push(`${t.options.owner} ${kind}: no room`); continue; }
			const cleared = clearScenery(pl, l, W, H, blocked, spot);
			// the new mine replaces one of its kind the start could only fight its way to, so the zone keeps the count its
			// template lists (Mini Nostalgia lists wood 1 and ore 1 a start zone; adding made 17 of its 16)
			const behind = pl.objects.filter(o => (o.l || 0) === l && o.type === 'mine' && o.subtype === kind && zone[o.y * W + o.x] === z);
			if (behind.length) {
				const far = behind.sort((a, b) => Math.max(Math.abs(b.x - t.x), Math.abs(b.y - t.y)) - Math.max(Math.abs(a.x - t.x), Math.abs(a.y - t.y)))[0];
				clearScenery(pl, l, W, H, blocked, { gone: new Set([far]) });
			}
			const m = objectEntry('mine', spot.x, spot.y, l, tpl, kind);
			pl.objects.push(m);
			STARTER_MINES_PLACED.add(m);
			footprintBlock(tpl, spot.x, spot.y, l, W, H, blocked);
			markApproach(tpl, spot.x, spot.y, l, W, H, blocked);
			out.push(`${t.options.owner} ${kind} at (${spot.x},${spot.y}), ${cleared} scenery piece(s) cleared${behind.length ? ', in place of a guarded one' : ''}`);
		}
	}
	return out;
}

/**
 * Every town, mine and dwelling of a zone can be walked to from the zone's ways in: its link doorways, its roads, its
 * monoliths, gates and towns. The engine joins every required object to the zone's free paths (TreasurePlacer,
 * zone.freePaths) and guarantees it; ours left whole pockets shut, e.g. an ore pit, a crystal mine, a bank and loot in
 * a scenery-walled corner of a small Coldshadow's start zone (36x36 seed 3, 2026-10-03, mapsight check "sealed"). A
 * walk crosses open ground, pickups and guards (a hero takes or fights them), never another object; where an object
 * cannot be reached, the cheapest way through interior scenery is cleared, whole pieces, never a piece on a zone line.
 * When scenery alone cannot open it, a small one-visit building (four blocked tiles or fewer: a corpse, a teacher, a
 * shrine) may go too, at four times the cost (36x36 two levels seed 2: a crystal mine shut in by two towns, a corpse,
 * an Ancient Teacher and a crater on the zone line).
 * A mine or dwelling still shut after that is removed. VMAPGEN_UNSEAL=0 off. Returns { opened, cleared, left, removed }.
 */
function unsealZones(pl, l, W, H, blocked) {
	const N = W * H, base = l * N, zone = pl.zone;
	const out = { opened: 0, cleared: 0, left: 0, removed: 0 };
	if (!zone) return out;
	const PASS = /^(resource|randomResource|treasureChest|campfire|randomArtifact|artifact|pandoraBox|spellScroll|prison|seaChest|flotsam|monster|randomMonster)/;
	const D8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
	const onLine = c => {
		const x = c % W, y = (c / W) | 0;
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
			const u = x + dx, v = y + dy;
			if (u >= 0 && v >= 0 && u < W && v < H && zone[v * W + u] >= 0 && zone[v * W + u] !== zone[c]) return true;
		}
		return false;
	};
	const want = o => o.template && (o.l || 0) === l && (o.type === 'mine' || /^creatureGenerator/.test(o.type) || /^(town|randomTown)$/.test(o.type));
	const anchors = o => o.template && (o.l || 0) === l && (/^(town|randomTown)$/.test(o.type) || /^monolith|^subterraneanGate/.test(o.type));
	for (let round = 0; round < 6; round++) {
		const isScen = o => (DECOR_TYPES_SET.has(o.type) || (o.template && require('./decor').isTerrainDecorAnimation(o.template.animation))) && o.template && o.template.mask && !o.template.mask.some(r2 => /[AT]/.test(r2));
		const KEEP = /town|mine|creatureGenerator|monolith|subterraneanGate|[Bb]ank|shipyard|garrison|borderGate|keymaster|whirlpool/;
		const small = o => !KEEP.test(o.type) && blockingCells(o.template, o.x, o.y).length <= 4;
		const scenAt = new Map(), wall = new Uint8Array(N), covered = new Set(), smallAt = new Map();
		for (const o of pl.objects) {
			if ((o.l || 0) !== l || !o.template) continue;
			const sc = isScen(o), pass = PASS.test(o.type);
			if (pass) for (const [fx, fy] of blockingCells(o.template, o.x, o.y)) covered.add(fy * W + fx);
			for (const [fx, fy] of blockingCells(o.template, o.x, o.y)) {
				if (fx < 0 || fy < 0 || fx >= W || fy >= H) continue;
				const c = fy * W + fx;
				if (sc) { if (!wall[c]) scenAt.set(c, o); } else if (!pass) { wall[c] = 1; scenAt.delete(c); if (small(o)) smallAt.set(c, o); else smallAt.set(c, null); }
			}
		}
		// rock and water: blocked with no object on it
		for (let c = 0; c < N; c++) if ((blocked[base + c] & OCCUPIED) && !scenAt.has(c) && !covered.has(c)) wall[c] = 1;
		const walk = c => !wall[c] && !scenAt.has(c);
		// the ways in, per zone
		const seeds = [];
		for (const c of pl.roadCells || []) seeds.push(c);
		for (const o of pl.openings || []) for (const c of o.hole || []) seeds.push(c);
		for (const o of pl.objects) if (anchors(o)) for (const c of approachCells(o.template, o.x, o.y, l, W, H, blocked)) seeds.push(c);
		// on a water map a shore is a way in too (a boat lands there): an island's mine is not sealed
		const wm = l === 0 && pl.p && pl.p.waterMask;
		if (wm) for (let c = 0; c < N; c++) {
			if (wm[c]) continue;
			const x = c % W, y = (c / W) | 0;
			for (const [dx, dy] of D8) { const u = x + dx, v = y + dy; if (u >= 0 && v >= 0 && u < W && v < H && wm[v * W + u]) { seeds.push(c); break; } }
		}
		// flood: open ground 0, pickups and guards 0, scenery 1 (to find the cheapest opening later)
		const reach = new Uint8Array(N), q = [];
		for (const c of seeds) if (c >= 0 && c < N && !reach[c] && walk(c)) { reach[c] = 1; q.push(c); }
		for (let h = 0; h < q.length; h++) {
			const c = q[h], x = c % W, y = (c / W) | 0;
			for (const [dx, dy] of D8) {
				const u = x + dx, v = y + dy;
				if (u < 0 || v < 0 || u >= W || v >= H) continue;
				const m = v * W + u;
				if (reach[m] || zone[m] !== zone[c] || wall[m] || scenAt.has(m)) continue;
				reach[m] = 1; q.push(m);
			}
		}
		const sealed = pl.objects.filter(o => want(o) && !(() => {
			const own = new Set(blockingCells(o.template, o.x, o.y).map(([a, b]) => b * W + a));
			for (const [vx, vy] of visitableCells(o.template, o.x, o.y)) for (const [dx, dy] of allowedDirs(o.template)) {
				const u = vx + dx, v = vy + dy;
				if (u >= 0 && v >= 0 && u < W && v < H && !own.has(v * W + u) && reach[v * W + u]) return true;
			}
			return false;
		})());
		if (!sealed.length) return out;
		let did = 0;
		for (const o of sealed) {
			const own = new Set(blockingCells(o.template, o.x, o.y).map(([a, b]) => b * W + a));
			const goal = new Set();
			for (const [vx, vy] of visitableCells(o.template, o.x, o.y)) for (const [dx, dy] of allowedDirs(o.template)) {
				const u = vx + dx, v = vy + dy;
				if (u >= 0 && v >= 0 && u < W && v < H && !own.has(v * W + u)) goal.add(v * W + u);
			}
			const z = zone[o.y * W + o.x];
			// 0-1 search from the reached ground of its zone; a scenery tile costs 1, unless its piece touches a zone line
			const cost = new Int32Array(N).fill(-1), prev = new Int32Array(N).fill(-1), front = [], dq = [];
			let head = 0, hit = -1;
			for (let c = 0; c < N; c++) if (reach[c] && zone[c] === z) { cost[c] = 0; front.push(c); }
			const lineCache = new Map();
			const pieceOk = p2 => {
				if (!lineCache.has(p2)) lineCache.set(p2, !blockingCells(p2.template, p2.x, p2.y).some(([a, b]) => a >= 0 && b >= 0 && a < W && b < H && onLine(b * W + a)));
				return lineCache.get(p2);
			};
			while (front.length || head < dq.length) {
				const c = front.length ? front.pop() : dq[head++];
				if (goal.has(c)) { hit = c; break; }
				const x = c % W, y = (c / W) | 0;
				for (const [dx, dy] of D8) {
					const u = x + dx, v = y + dy;
					if (u < 0 || v < 0 || u >= W || v >= H) continue;
					const m = v * W + u;
					if (zone[m] !== z || own.has(m)) continue;
					const bld = wall[m] ? smallAt.get(m) : undefined;
					if (wall[m] && !bld) continue;
					const sc = bld || scenAt.get(m);
					if (sc && !pieceOk(sc)) continue;
					const w = bld ? 4 : sc ? 1 : 0, nc = cost[c] + w;
					if (cost[m] >= 0 && cost[m] <= nc) continue;
					cost[m] = nc; prev[m] = c;
					(w ? dq : front).push(m);
				}
			}
			if (process.env.VMAPGEN_UNSEAL_TRACE) {
				let rz = 0, got = 0;
				for (let c = 0; c < N; c++) { if (reach[c] && zone[c] === z) rz++; if (cost[c] >= 0 && zone[c] === z) got++; }
				const st = c => (wall[c] ? (smallAt.get(c) ? 'b:' + smallAt.get(c).type : 'w:' + ((pl.objects.find(q => q.template && (q.l || 0) === l && blockingCells(q.template, q.x, q.y).some(([a2, b2]) => b2 * W + a2 === c)) || {}).type || 'flag')) : scenAt.has(c) ? 's' : '.');
				for (let yy = Math.max(0, o.y - 6); yy <= Math.min(H - 1, o.y + 7); yy++) {
					let row = '';
					for (let xx = Math.max(0, o.x - 7); xx <= Math.min(W - 1, o.x + 5); xx++) {
						const c = yy * W + xx;
						row += zone[c] !== z ? 'z' : reach[c] ? 'R' : cost[c] >= 0 ? 'c' : wall[c] ? (smallAt.get(c) ? 'b' : 'W') : scenAt.has(c) ? (pieceOk(scenAt.get(c)) ? 's' : 'L') : '.';
					}
					console.error(`[unseal]   ${String(yy).padStart(3)} ${row}`);
				}
				console.error(`[unseal] ${o.type}:${o.subtype || ''} (${o.x},${o.y}) zone ${z}: reached ${rz}, searched ${got}, hit ${hit >= 0}; goal ${[...goal].map(c => `${c % W},${(c / W) | 0}=${st(c)}`).join(' ')}`);
			}
			if (hit < 0) continue;
			const gone = new Set();
			for (let k = hit; k >= 0; k = prev[k]) { const g = wall[k] ? smallAt.get(k) : scenAt.get(k); if (g) gone.add(g); }
			if (!gone.size) continue;
			out.cleared += clearScenery(pl, l, W, H, blocked, { gone });
			out.opened++; did++;
			break;          // the reach changed: measure again
		}
		if (!did) {
			// a mine or dwelling nothing can open (its one way in boxed by towns: 36x36 two levels seed 3) is worth less than
			// none: it goes, and the floor under it opens
			const drop = sealed.filter(o => o.type === 'mine' || /^creatureGenerator/.test(o.type));
			if (drop.length) {
				clearScenery(pl, l, W, H, blocked, { gone: new Set(drop) });
				out.removed = drop.length;
			}
			out.left = sealed.length - drop.length;
			return out;
		}
	}
	return out;
}

/**
 * No guard's ring (the eight tiles around it, where a hero passing is attacked) covers a town's doorstep, the tiles a
 * hero leaves the town onto. The engine keeps a town's gate clear (TownPlacer places a town before anything else and
 * its entrance joins the free paths); ours had a treasure guard one tile below a start zone's second town, so leaving
 * that town meant a fight (XL seed 1, 2026-10-03, mapsight check "own town"). Such a guard moves to the nearest free
 * tile, within three of where it stood, that still touches something it touched before (the loot it guards) and whose
 * ring touches no town's doorstep. `extra`: more cells no ring may cover (ownTownWays). VMAPGEN_DOORSTEP_GUARDS=0 off.
 * Returns { moved, left }.
 */
function guardsOffDoorsteps(pl, l, W, H, blocked, extra = null) {
	const N = W * H, base = l * N, out = { moved: 0, left: 0 };
	const door = new Set(extra || []);
	for (const o of pl.objects) if ((o.l || 0) === l && o.template && /^(town|randomTown)$/.test(o.type))
		for (const c of approachCells(o.template, o.x, o.y, l, W, H, blocked)) door.add(c);
	if (!door.size) return out;
	const ringHits = (x, y) => {
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
			const u = x + dx, v = y + dy;
			if (u >= 0 && v >= 0 && u < W && v < H && door.has(v * W + u)) return true;
		}
		return false;
	};
	const cover = new Map();
	for (const o of pl.objects) if ((o.l || 0) === l && o.template)
		for (const [fx, fy] of blockingCells(o.template, o.x, o.y)) if (fx >= 0 && fy >= 0 && fx < W && fy < H) cover.set(fy * W + fx, o);
	const guards = pl.objects.filter(o => (o.l || 0) === l && o.template && /^(monster|randomMonster)/.test(o.type) && ringHits(o.x, o.y));
	for (const g of guards) {
		const near = new Set();
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
			const o = cover.get((g.y + dy) * W + g.x + dx);
			if (o && o !== g && !/^(monster|randomMonster)/.test(o.type)) near.add(o);
		}
		let best = null;
		// a tile still beside what it guarded first; in a corridor with none, any tile clear of the way (the way is the
		// engine's: a town's paths are laid before any guard, and no guard stands on them)
		for (const loose of [false, true]) for (let r = 1; r <= (loose ? 6 : 3) && !best; r++) for (let dy = -r; dy <= r && !best; dy++) for (let dx = -r; dx <= r; dx++) {
			if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
			const x = g.x + dx, y = g.y + dy;
			if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
			const c = y * W + x;
			if (cover.has(c) || (blocked[base + c] & (OCCUPIED | RESERVED)) || pl.zone && pl.zone[c] !== pl.zone[g.y * W + g.x]) continue;
			if (ringHits(x, y)) continue;
			let keeps = loose || !near.size;
			for (let ddy = -1; ddy <= 1 && !keeps; ddy++) for (let ddx = -1; ddx <= 1; ddx++) if (near.has(cover.get((y + ddy) * W + x + ddx))) { keeps = true; break; }
			if (!keeps) continue;
			best = [x, y];
			break;
		}
		// nowhere clear of the way within six tiles: the guard goes, as the engine never posts one there
		if (!best) { pl.objects.splice(pl.objects.indexOf(g), 1); cover.delete(g.y * W + g.x); blocked[base + g.y * W + g.x] &= ~OCCUPIED; out.removed = (out.removed || 0) + 1; continue; }
		const old = g.y * W + g.x;
		cover.delete(old);
		blocked[base + old] &= ~OCCUPIED;
		g.x = best[0]; g.y = best[1];
		if (g.instanceName) g.instanceName = `${g.type}_${g.x}_${g.y}_${l}`;
		cover.set(g.y * W + g.x, g);
		blocked[base + g.y * W + g.x] |= OCCUPIED;
		out.moved++;
	}
	return out;
}

/**
 * A start walks to every other town of its own zone without a fight (mapsight check "own town"). freeStartMines opens
 * such ways through scenery before the fill's last passes; a treasure guard can still stand beside the only corridor
 * (XL seed 1, 2026-10-03: 94 Brutes beside the one underground road between red's two towns), and the loot swap moves
 * guards after it. Here, where the start's guard-free walk does not reach the town, the shortest way that ignores guards
 * is found and the guards whose rings cover it are moved aside (guardsOffDoorsteps). Returns { moved, left }.
 */
function ownTownWays(pl, l, W, H, blocked) {
	const out = { moved: 0, left: 0 }, zone = pl.zone, N = W * H, base = l * N;
	if (!zone) return out;
	const isTown = o => (o.l || 0) === l && o.template && /^(town|randomTown)$/.test(o.type);
	const PASS = /^(resource|randomResource|treasureChest|campfire|randomArtifact|artifact|pandoraBox|spellScroll|prison|seaChest|flotsam|monster|randomMonster)/;
	for (const t of pl.objects.filter(o => isTown(o) && o.options && o.options.owner)) {
		const from = approachCells(t.template, t.x, t.y, l, W, H, blocked);
		if (!from.length) continue;
		const z = zone[from[0]];
		for (const other of pl.objects.filter(o => isTown(o) && o !== t && zone[o.y * W + o.x] === z)) {
			const goal = new Set(approachCells(other.template, other.x, other.y, l, W, H, blocked));
			const walk = startWalk(pl, l, W, H, blocked, t);
			if (!goal.size || !walk || [...goal].some(c => walk.cost[c] === 0)) continue;
			// the shortest way past guards: open ground and pickups, never another object
			const wall = new Uint8Array(N);
			for (const o of pl.objects) if ((o.l || 0) === l && o.template && !PASS.test(o.type))
				for (const [fx, fy] of blockingCells(o.template, o.x, o.y)) if (fx >= 0 && fy >= 0 && fx < W && fy < H) wall[fy * W + fx] = 1;
			// rock and water: blocked with no object on it (pickups and guards keep their OCCUPIED flag too: those pass)
			const held = new Set();
			for (const o of pl.objects) if ((o.l || 0) === l && o.template && PASS.test(o.type))
				for (const [fx, fy] of blockingCells(o.template, o.x, o.y)) held.add(fy * W + fx);
			for (let c = 0; c < N; c++) if ((blocked[base + c] & OCCUPIED) && !wall[c] && !held.has(c)) wall[c] = 1;
			const prev = new Int32Array(N).fill(-2), q = [];
			for (const c of from) if (!wall[c]) { prev[c] = -1; q.push(c); }
			let hit = -1;
			for (let h = 0; h < q.length && hit < 0; h++) {
				const c = q[h];
				if (goal.has(c)) { hit = c; break; }
				const x = c % W, y = (c / W) | 0;
				for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
					const u = x + dx, v = y + dy;
					if ((!dx && !dy) || u < 0 || v < 0 || u >= W || v >= H) continue;
					const m = v * W + u;
					if (prev[m] !== -2 || wall[m] || zone[m] !== z) continue;
					prev[m] = c; q.push(m);
				}
			}
			if (hit < 0) { out.left++; continue; }
			const path = new Set();
			for (let k = hit; k >= 0; k = prev[k]) path.add(k);
			const r = guardsOffDoorsteps(pl, l, W, H, blocked, path);
			out.moved += r.moved;
			out.left += r.left;
			out.removed = (out.removed || 0) + (r.removed || 0);
		}
	}
	return out;
}

/**
 * No rock one tile wide underground. The game draws rock's edge art on the floor around it, and rock in no 2x2 block
 * has no art that fits: K saw "two black missing texture looking squares which are in the underground layer and
 * labelled 'Rock'" (2026-10-03). The engine's Coldshadow maps have none (tools/geometry/rockspecks.js); ours had 7 to 14
 * a map, his open random map 29. Such a tile becomes cave floor under a one-tile obstacle from its zone's own sets, so
 * nothing about where a hero walks changes; repeated while new thin tiles appear (at most 4 rounds).
 * VMAPGEN_THIN_ROCK=0 off. Returns { turned, left }.
 */
/**
 * Free ground no object, road or shore touches, shut in by scenery: no hero can use it and most cannot reach it. The engine's
 * obstacle placer fills every tile off its paths, and its Coldshadow maps (K's mods, 144 and 252, 26 maps) have no such pocket
 * of ten tiles or more; ours had 25 in the 80-map grid, up to 205 tiles (K, 2026-10-04: "how the fuck are you supposed to access
 * this area? hmm?"). Each pocket of six tiles or more is filled with its zone's own obstacle sets, the largest that fit first.
 * Returns { pockets, tiles, left }.
 */
function fillEmptyPockets(pl, l, W, H, blocked, rng) {
	const out = { pockets: 0, tiles: 0, left: 0 };
	if (!pl.zone || !pl.biomeTerrain) return out;
	const N = W * H, base = l * N, open = pl.openMask, water = pl.p && pl.p.water, roads = pl.roadCells || new Set();
	const free = c => !(blocked[base + c] & OCCUPIED) && (!open || open[c]) && !(water && water[c]);
	const used = new Uint8Array(N);
	for (const o of pl.objects) {
		if ((o.l || 0) !== l || !o.template || !o.template.mask) continue;
		for (const [vx, vy] of visitableCells(o.template, o.x, o.y))
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const x = vx + dx, y = vy + dy; if (x >= 0 && y >= 0 && x < W && y < H) used[y * W + x] = 1; }
		if (/^(monster|randomMonster)/.test(o.type) || REMOVABLE_TYPES.has(o.type))
			for (const [bx, by] of blockingCells(o.template, o.x, o.y)) if (bx >= 0 && by >= 0 && bx < W && by < H) used[by * W + bx] = 1;
	}
	const { zoneTemplates, sizeGroups } = require('./retile');
	const groups = new Map();
	const groupsOf = z => { if (!groups.has(z)) groups.set(z, sizeGroups(zoneTemplates(pl.biomeTerrain[z], rng), true)); return groups.get(z); };
	const seen = new Uint8Array(N);
	for (let c0 = 0; c0 < N; c0++) {
		if (seen[c0] || !free(c0)) continue;
		const cells = [c0]; seen[c0] = 1;
		let bad = false;
		for (let h = 0; h < cells.length; h++) {
			const c = cells[h], x = c % W, y = (c / W) | 0;
			if (used[c] || roads.has(c)) bad = true;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				const u = x + dx, v = y + dy;
				if ((!dx && !dy) || u < 0 || v < 0 || u >= W || v >= H) continue;
				const k = v * W + u;
				if (water && water[k]) bad = true;
				if (!seen[k] && free(k)) { seen[k] = 1; cells.push(k); }
			}
		}
		if (bad || cells.length < 6) continue;
		const left = new Set(cells);
		const z = pl.zone[c0];
		const gs = z >= 0 ? groupsOf(z) : [];
		for (const [, temps] of gs) {
			for (const c of [...left]) {
				if (!left.has(c)) continue;
				for (let t = 0; t < 4; t++) {
					const e = temps[(rng() * temps.length) | 0];
					const [odx, ody] = e.offs[0];
					const ax = c % W - odx, ay = ((c / W) | 0) - ody;
					if (ax < 0 || ay < 0 || ax >= W || ay >= H) continue;
					const fp = e.offs.map(([dx, dy]) => (ay + dy) * W + ax + dx);
					if (!e.offs.every(([dx, dy]) => ax + dx >= 0 && ay + dy >= 0 && ax + dx < W && ay + dy < H) || !fp.every(k => left.has(k))) continue;
					pl.objects.push(objectEntry(e.type, ax, ay, l, { animation: e.animation, mask: e.mask }, e.subtype || 'object'));
					for (const k of fp) { left.delete(k); blocked[base + k] |= OCCUPIED; }
					break;
				}
			}
		}
		out.pockets++;
		out.tiles += cells.length - left.size;
		out.left += left.size;
	}
	return out;
}

function thinRockToFloor(pl, l, W, H, rng) {
	const out = { turned: 0, left: 0 };
	const open = pl.openMask;
	if (!open || !pl.zone || !pl.biomeTerrain) return out;
	const { zoneTemplates, sizeGroups } = require('./retile');
	const singles = new Map();
	const single = z => {
		if (!singles.has(z)) {
			const g = sizeGroups(zoneTemplates(pl.biomeTerrain[z], rng), true).find(([size]) => size === 1);
			singles.set(z, g ? g[1] : []);
		}
		return singles.get(z);
	};
	const rock = (x, y) => x < 0 || y < 0 || x >= W || y >= H || !open[y * W + x];
	for (let round = 0; round < 4; round++) {
		const thin = [];
		for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
			if (!rock(x, y)) continue;
			let inBlock = false;
			for (const [ox, oy] of [[0, 0], [-1, 0], [0, -1], [-1, -1]])
				if (rock(x + ox, y + oy) && rock(x + ox + 1, y + oy) && rock(x + ox, y + oy + 1) && rock(x + ox + 1, y + oy + 1)) { inBlock = true; break; }
			if (!inBlock) thin.push([x, y]);
		}
		// a pile's pocket rock (content.js sealRock), which the cave fit was not let open: where no rock art fits round it,
		// it becomes floor under an obstacle the same way, and the pocket stays closed
		if (open.sealed && pl.p && pl.p.caveChecker) {
			const rk = Uint8Array.from(open, v => (v ? 0 : 1));
			const bad = pl.p.caveChecker.full(rk, W, H);
			const seen = new Set(thin.map(([x, y]) => y * W + x));
			for (let c = 0; c < W * H; c++) {
				if (!bad[c]) continue;
				const x0 = c % W, y0 = (c / W) | 0;
				for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
					const x = x0 + dx, y = y0 + dy, k = y * W + x;
					if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1 || open[k] || !open.sealed[k] || seen.has(k)) continue;
					seen.add(k); thin.push([x, y]);
				}
			}
		}
		if (!thin.length) break;
		out.left = 0;
		for (const [x, y] of thin) {
			const c = y * W + x, z = pl.zone[c];
			const temps = z >= 0 ? single(z) : [];
			if (!temps.length) { out.left++; continue; }
			const e = temps[(rng() * temps.length) | 0];
			const [odx, ody] = e.offs[0];
			const ax = x - odx, ay = y - ody;
			if (ax < 0 || ay < 0 || ax >= W || ay >= H) { out.left++; continue; }
			open[c] = 1;
			pl.objects.push(objectEntry(e.type, ax, ay, l, { animation: e.animation, mask: e.mask }, e.subtype || 'object'));
			out.turned++;
		}
	}
	return out;
}

/**
 * A level plan's zone per tile as the template's zone ids (-1 where no zone): the final plan renumbers zones per level,
 * so a layout is checked against the map it became through this (MapGen Dev, 2026-10-03). A finished map carries the
 * same in its sidecar: VMAP.zones.json, levels[l].zone (indexes) with levels[l].templateIds.
 */
function templateZoneArray(plan) {
	const ids = (plan.zoneMeta || []).map(m => (m && m.spec ? m.spec.id : -1));
	return Int32Array.from(plan.zone || [], z => (z >= 0 && ids[z] !== undefined ? ids[z] : -1));
}

/**
 * On a one-level map, the zones a template forces underground keep together as a cluster at the map's centre, and a
 * zone (not a start) linked to two or more of them takes the centre itself. K, 2026-10-03: "coldshadows template should
 * be bent to whatever the user requests"; the lead's reading for this template: the dragon caches underground when
 * there is an underground, a central surface cluster when there is not. The rule is by role (forcedLevel underground,
 * and the hub they share), never by zone number: Coldshadow's junctions 17-20 ring its centre zone 21. Pinned seeds
 * (biomes.js layoutZoneSeeds), area shares kept by the balancing and evenZoneAreas. VMAPGEN_SURFACE_CLUSTER=0 off.
 * Returns an anchor per zone (or null), or null when the template forces nothing underground.
 */
function surfaceCluster(tplZones, tplConns, W, H, levelIndex, forcedIds) {
	if (process.env.VMAPGEN_SURFACE_CLUSTER === '0') return null;
	// a one-level plan clears forcedLevel on its zones, so the template's own list says which were forced
	const under = tplZones.map(z => z.forcedLevel === 'underground' || (forcedIds && forcedIds.has(z.id)));
	const k = under.filter(Boolean).length;
	if (k < 2) return null;
	const linked = tplZones.map(() => 0);
	for (const c of tplConns) {
		const a = c.aRef, b = c.bRef;
		if (!a || !b || a.l !== levelIndex || b.l !== levelIndex) continue;
		if (under[a.i] && !under[b.i]) linked[b.i]++;
		if (under[b.i] && !under[a.i]) linked[a.i]++;
	}
	const isStart = z => z.type === 'playerStart' || z.type === 'cpuStart';
	let hub = -1;
	tplZones.forEach((z, i) => { if (!under[i] && !isStart(z) && linked[i] >= 2 && (hub < 0 || linked[i] > linked[hub])) hub = i; });
	// the ring leaves the hub room for its share: twice the radius of a disc of the hub's tiles (the layout's size^0.8
	// shares). At a fixed 0.18 of the map the hub of a one-level 144 got about 340 tiles of its 1000 and grew arms and a
	// tail to the map edge.
	const wt = z => Math.max(1, z.size || 10) ** 0.8, total = tplZones.reduce((m, z) => m + wt(z), 0);
	const hubR = hub >= 0 ? Math.sqrt((wt(tplZones[hub]) / total) * W * H / Math.PI) : 0;
	const cx = W / 2, cy = H / 2, r = Math.min(0.35 * Math.min(W, H), Math.max(0.18 * Math.min(W, H), 2 * hubR));
	const out = tplZones.map(() => null);
	let j = 0;
	tplZones.forEach((z, i) => {
		if (!under[i]) return;
		const a = Math.PI / 4 + (j++ * 2 * Math.PI) / k;
		out[i] = { x: Math.round(cx + r * Math.cos(a)), y: Math.round(cy + r * Math.sin(a)), pin: true };
	});
	if (hub >= 0) out[hub] = { x: Math.round(cx), y: Math.round(cy), pin: true };
	return out;
}

/**
 * Zones with no land get a patch of it: the land tile nearest the zone's seed whose zone is furthest over its share,
 * and that zone's tiles within 2 of it (the giver keeps the rest). A zone of 0 tiles has no border for evenZoneAreas to
 * grow; with islands laid before the zones, a one-level islands Coldshadow lost 2 or 3 zones on every candidate layout
 * (seeds 7204, 7206; MapGen Dev, 2026-10-03), and their links, towns and content with them. Returns the zones revived.
 */
function reviveZones(zone, seeds, W, H, water, share) {
	const N = W * H, n = seeds.length;
	const land = c => zone[c] >= 0 && !(water && water[c]);
	const area = new Array(n).fill(0);
	let total = 0;
	for (let c = 0; c < N; c++) if (land(c)) { area[zone[c]]++; total++; }
	const seedAt = new Set(seeds.map(q => q.y * W + q.x));
	let revived = 0;
	for (let i = 0; i < n; i++) {
		if (area[i] > 0) continue;
		let best = -1, bs = -Infinity;
		for (let c = 0; c < N; c++) {
			if (!land(c) || seedAt.has(c)) continue;
			const g = zone[c];
			if (area[g] < 30) continue;
			const ratio = area[g] / Math.max(1, share[g] * total);
			const d = Math.hypot(c % W - seeds[i].x, ((c / W) | 0) - seeds[i].y);
			const sc = ratio * 10 - d;
			if (sc > bs) { bs = sc; best = c; }
		}
		if (best < 0) continue;
		const g = zone[best], bx = best % W, by = (best / W) | 0;
		for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
			const x = bx + dx, y = by + dy;
			if (x < 0 || y < 0 || x >= W || y >= H) continue;
			const c = y * W + x;
			if (zone[c] === g && land(c) && !seedAt.has(c)) { zone[c] = i; area[i]++; area[g]--; }
		}
		seeds[i].x = bx; seeds[i].y = by;
		revived++;
	}
	return revived;
}

/**
 * Every way into a zone (its doorway tiles, the ways in to its gates and monoliths, its town gates) lies in the same
 * piece of the zone as the rest of them. The underground carve once left zone 18's side of the 12-18 doorway a 6-tile
 * pocket behind 4 tiles of cave rock; the sweep found zone 12 unreachable, dropped its gate to zone 4, and emptied both
 * zones (two levels, two players, seed 3, 2026-10-03; medium one level the same family). Here the zone's pieces are found
 * (open ground, pickups and guards walk), the piece holding most ways in is the main one, and each other piece holding a
 * way in is joined to it along the cheapest path inside the zone: cave rock is carved (the open mask opens there) and
 * scenery cleared, whole pieces, at one each; no other object is crossed. VMAPGEN_JOIN_WAYS=0 off.
 * Returns { joined, rock, cleared, left }.
 */
function joinZoneWaysIn(pl, l, W, H, blocked, opts = {}) {
	const N = W * H, base = l * N, zone = pl.zone, open = pl.openMask;
	const out = { joined: 0, rock: 0, cleared: 0, left: 0 };
	if (!zone) return out;
	const PASS = /^(resource|randomResource|treasureChest|campfire|randomArtifact|artifact|pandoraBox|spellScroll|prison|seaChest|flotsam|monster|randomMonster)/;
	const isScen = o => (DECOR_TYPES_SET.has(o.type) || (o.template && require('./decor').isTerrainDecorAnimation(o.template.animation))) && o.template && o.template.mask && !o.template.mask.some(r2 => /[AT]/.test(r2));
	const water = l === 0 && pl.p && pl.p.waterMask;
	const D8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
	// a scenery piece on a zone line, but for a doorway's own tiles, is the wall: it goes whole when cleared, and took a
	// wall's flowers out between zones 9 and 19 (K's line, 72x72 seed 3, 2026-10-04). VMAPGEN_JOIN_WALL=0 off.
	const holes = new Set();
	for (const o of pl.openings || []) for (const c of o.hole || []) holes.add(c);
	const onLine = c => {
		const x = c % W, y = (c / W) | 0;
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
			const u = x + dx, v = y + dy;
			if (u >= 0 && v >= 0 && u < W && v < H && zone[v * W + u] >= 0 && zone[v * W + u] !== zone[c]) return true;
		}
		return false;
	};
	// true when every other zone beside c is one the template links to z by a doorway
	const linked = new Set();
	for (const o of pl.openings || []) if (o.kind !== 'portal') { linked.add(o.a * 100000 + o.b); linked.add(o.b * 100000 + o.a); }
	const onLinkedLineOnly = (c, z) => {
		const x = c % W, y = (c / W) | 0;
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
			const u = x + dx, v = y + dy;
			if (u < 0 || v < 0 || u >= W || v >= H) continue;
			const n = zone[v * W + u];
			if (n >= 0 && n !== z && !linked.has(z * 100000 + n)) return false;
		}
		return true;
	};
	// only as the first choice: a join no way round the wall reaches clears it after all, since a zone left unjoined is
	// swept empty (4 players 72x72 seed 2: zones 5 and 13 lost 32 objects with the wall rule strict, 2026-10-04)
	let strict = true;
	const wallPiece = o => strict && process.env.VMAPGEN_JOIN_WALL !== '0' && blockingCells(o.template, o.x, o.y)
		.some(([fx, fy]) => fx >= 0 && fy >= 0 && fx < W && fy < H && !holes.has(fy * W + fx) && onLine(fy * W + fx));
	const build = () => {
		const scenAt = new Map(), wall = new Uint8Array(N), held = new Uint8Array(N);
		for (const o of pl.objects) {
			if ((o.l || 0) !== l || !o.template) continue;
			const sc = isScen(o) && !wallPiece(o), pass = PASS.test(o.type);
			for (const [fx, fy] of blockingCells(o.template, o.x, o.y)) {
				if (fx < 0 || fy < 0 || fx >= W || fy >= H) continue;
				const c = fy * W + fx;
				held[c] = 1;
				if (sc) { if (!wall[c]) scenAt.set(c, o); } else if (!pass) { wall[c] = 1; scenAt.delete(c); }
			}
		}
		const rock = c => !!(open && !open[c]);
		for (let c = 0; c < N; c++) if ((blocked[base + c] & OCCUPIED) && !held[c] && !rock(c)) wall[c] = 1;
		if (water) for (let c = 0; c < N; c++) if (water[c]) wall[c] = 1;
		return { scenAt, wall, rock };
	};
	const waysOf = () => {
		const ways = new Map();
		const add = c => { if (c >= 0 && c < N && zone[c] >= 0) { if (!ways.has(zone[c])) ways.set(zone[c], new Set()); ways.get(zone[c]).add(c); } };
		for (const o of pl.openings || []) for (const c of o.hole || []) {
			add(c);
			// and the tile across the zone line from it: a hole can keep one zone's side only (the 14-19 doorway on two-level
			// seed 6, 2026-10-04: zone 19's side was a 4-tile pocket nothing counted, and zones 14 and 6 behind it emptied)
			if (process.env.VMAPGEN_JOIN_ACROSS === '0') continue;
			const x = c % W, y = (c / W) | 0;
			for (const [dx, dy] of D8.slice(0, 4)) {
				const u = x + dx, v = y + dy;
				if (u < 0 || v < 0 || u >= W || v >= H) continue;
				const m = v * W + u;
				if (zone[m] >= 0 && zone[m] !== zone[c] && (zone[m] === o.a || zone[m] === o.b)) add(m);
			}
		}
		for (const o of pl.objects) if ((o.l || 0) === l && o.template && (/^(town|randomTown)$/.test(o.type) || /^monolith|^subterraneanGate/.test(o.type))) {
			for (const c of approachCells(o.template, o.x, o.y, l, W, H, blocked)) add(c);
		}
		return ways;
	};
	for (let round = 0; round < 40; round++) {
		const { scenAt, wall, rock } = build();
		const walk = c => !wall[c] && !scenAt.has(c) && !rock(c);
		const comp = new Int32Array(N).fill(-1);
		let nComp = 0;
		for (let c = 0; c < N; c++) {
			if (comp[c] >= 0 || zone[c] < 0 || !walk(c)) continue;
			const id = nComp++, q = [c];
			comp[c] = id;
			while (q.length) {
				const k = q.pop(), x = k % W, y = (k / W) | 0;
				for (const [dx, dy] of D8) {
					const u = x + dx, v = y + dy;
					if (u < 0 || v < 0 || u >= W || v >= H) continue;
					const m = v * W + u;
					if (comp[m] >= 0 || zone[m] !== zone[c] || !walk(m)) continue;
					comp[m] = id; q.push(m);
				}
			}
		}
		if (process.env.VMAPGEN_JOIN_TRACE && round === 0) for (const o of pl.openings || []) console.error(`[join] L${l} opening ${o.kind} ${o.a}-${o.b} hole ${(o.hole || []).map(c => `${c % W},${(c / W) | 0}:${comp[c]}${walk(c) ? '' : 'X'}`).join(' ')}`);
		if (process.env.VMAPGEN_JOIN_TRACE && round === 0) { const ids = (pl.zoneMeta || []).map(m => (m && m.spec ? m.spec.id : '?')); for (const [z, set] of waysOf()) { const cs = new Map(); for (const c of set) cs.set(comp[c], (cs.get(comp[c]) || 0) + 1); console.error(`[join] L${l} zone ${ids[z]}: ways ${set.size} in pieces ${JSON.stringify([...cs])}; openings ${(pl.openings || []).length}`); } }
		let did = false;
		// the zone's largest piece counts as a way in too: a zone whose only way in is a doorway opening on a small pocket
		// had its town's gate in the body to join it; with the town gone (keptNeutralTowns) the body was never joined
		// and swept empty (3 players, 72x72 two levels, seed 4, 2026-10-04). VMAPGEN_JOIN_BODY=0 off.
		const ways = waysOf();
		if (process.env.VMAPGEN_JOIN_BODY !== '0') {
			const size = new Map(), at = new Map();
			for (let c = 0; c < N; c++) if (comp[c] >= 0) { size.set(comp[c], (size.get(comp[c]) || 0) + 1); if (!at.has(comp[c])) at.set(comp[c], c); }
			const best = new Map();
			for (const [k, n] of size) { const z = zone[at.get(k)]; if (!best.has(z) || n > size.get(best.get(z))) best.set(z, k); }
			for (const [z, k] of best) if (ways.has(z) && size.get(k) >= 20) ways.get(z).add(at.get(k));
			// and so does every other piece of 40 tiles or more: a long thin zone cut in two kept its far half apart from
			// its ways in (4 players, 72x72 one level, seed 2: zone 7, 87 and 53 tiles; mapsight split zones). Only with the
			// body rule on; VMAPGEN_JOIN_PIECES=0 off.
			if (process.env.VMAPGEN_JOIN_PIECES !== '0')
				for (const [k, n] of size) { const z = zone[at.get(k)]; if (n >= 40 && ways.has(z)) ways.get(z).add(at.get(k)); }
		}
		for (const [z, set] of ways) {
			// a way in that is not walkable itself (a doorway tile under a held flag) counts through the pieces it touches
			// and one that touches no walkable tile of its zone at all (the doorway into zone 19 on two-level seed 6, shut in
			// a 4-tile pocket by a mod decor piece, 2026-10-04: zones 14 and 6 behind it were emptied) is a target itself
			const count = new Map(), lone = [];
			for (const c of set) {
				const pieces = new Set();
				if (comp[c] >= 0) pieces.add(comp[c]);
				else {
					const x = c % W, y = (c / W) | 0;
					for (const [dx, dy] of D8) {
						const u = x + dx, v = y + dy;
						if (u >= 0 && v >= 0 && u < W && v < H && zone[v * W + u] === z && comp[v * W + u] >= 0) pieces.add(comp[v * W + u]);
					}
				}
				for (const k of pieces) count.set(k, (count.get(k) || 0) + 1);
				if (!pieces.size && process.env.VMAPGEN_JOIN_TRACE) console.error(`[join] L${l} zone ${(pl.zoneMeta && pl.zoneMeta[z] && pl.zoneMeta[z].spec) ? pl.zoneMeta[z].spec.id : z} round ${round} way in ${c % W},${(c / W) | 0} alone: wall ${wall[c]} scenery ${scenAt.has(c) ? scenAt.get(c).type : '-'} rock ${rock(c)} blocked ${blocked[base + c]}`);
				if (!pieces.size && !wall[c] && process.env.VMAPGEN_JOIN_LONE !== '0') lone.push(c);
			}
			if (!count.size || (count.size < 2 && !lone.length)) continue;
			const main = [...count].sort((a, b) => b[1] - a[1])[0][0];
			const other = count.size >= 2 ? [...count.keys()].find(k => k !== main) : null;
			const target = other === null ? lone[0] : -1;
			// 0-1 search from the main piece to the other, inside the zone
			const cost = new Int32Array(N).fill(-1), prev = new Int32Array(N).fill(-1), front = [], dq = [];
			let head = 0, hit = -1;
			for (let c = 0; c < N; c++) if (comp[c] === main) { cost[c] = 0; front.push(c); }
			while (front.length || head < dq.length) {
				const c = front.length ? front.pop() : dq[head++];
				if ((other !== null && comp[c] === other) || c === target) { hit = c; break; }
				const x = c % W, y = (c / W) | 0;
				for (const [dx, dy] of D8) {
					const u = x + dx, v = y + dy;
					if (u < 1 || v < 1 || u >= W - 1 || v >= H - 1) continue;
					const m = v * W + u;
					if (zone[m] !== z || wall[m]) continue;
					// the fallback crosses wall pieces, never a zone line (a path along it opened the wall: K's line 72x72 4p seed 6,
					// zones 21 and 11)
					// a line with a zone this one is linked to is no wall to keep (Coldshadow 72x72 two levels 2p seed 482517: the
					// 6-14 doorway's corridor ended against scenery all along that line, and zone 6 was swept empty; MapGen Dev's fuzz)
					if (!strict && m !== target && !holes.has(m) && onLine(m) && !onLinkedLineOnly(m, z)) continue;
					const w = walk(m) ? 0 : 1, nc = cost[c] + w;
					if (cost[m] >= 0 && cost[m] <= nc) continue;
					cost[m] = nc; prev[m] = c;
					(w ? dq : front).push(m);
				}
			}
			// last resort, once the wall rule is off: a neutral town, a mine, a bank or another building that plugs the only land between two pieces
			// of a zone goes (cost 6 a tile, scenery 1), where the zone would otherwise be swept empty with all it holds (one-level 144, 2 players,
			// Mediterranean water: a town on a one-tile land bridge, zones 9 and 16 of seed 3; 87 to 190 objects dropped on four maps of twelve).
			// An owned town, a monolith, a gate and a boat stay. VMAPGEN_JOIN_DEMOLISH=0 off.
			const demAt = new Map();
			if (hit < 0 && !strict && !opts.early && process.env.VMAPGEN_JOIN_DEMOLISH !== '0') {
				for (const o of pl.objects) {
					if ((o.l || 0) !== l || !o.template || !o.template.mask || isScen(o) || PASS.test(o.type)) continue;
					if (/^(monolith|subterraneanGate|whirlpool|shipyard|boat)/.test(o.type) || (/^(town|randomTown)$/.test(o.type) && o.options && o.options.owner)) continue;
					for (const [fx, fy] of blockingCells(o.template, o.x, o.y)) if (fx >= 0 && fy >= 0 && fx < W && fy < H) demAt.set(fy * W + fx, o);
				}
				cost.fill(-1); prev.fill(-1);
				const bk = [[]];
				for (let c = 0; c < N; c++) if (comp[c] === main) { cost[c] = 0; bk[0].push(c); }
				for (let d = 0; d < bk.length && hit < 0; d++) {
					const q = bk[d]; if (!q) continue;
					for (let h2 = 0; h2 < q.length && hit < 0; h2++) {
						const c = q[h2]; if (cost[c] !== d) continue;
						if ((other !== null && comp[c] === other) || c === target) { hit = c; break; }
						const x = c % W, y = (c / W) | 0;
						for (const [dx, dy] of D8) {
							const u = x + dx, v = y + dy;
							if (u < 1 || v < 1 || u >= W - 1 || v >= H - 1) continue;
							const m = v * W + u;
							if (zone[m] !== z) continue;
							const w = !wall[m] ? (walk(m) ? 0 : 1) : demAt.has(m) ? 6 : -1;
							if (w < 0) continue;
							if (m !== target && !holes.has(m) && onLine(m) && !onLinkedLineOnly(m, z)) continue;
							const nc = d + w;
							if (cost[m] >= 0 && cost[m] <= nc) continue;
							cost[m] = nc; prev[m] = c; (bk[nc] || (bk[nc] = [])).push(m);
						}
					}
				}
			}
			if (hit < 0) { out.left++; continue; }
			if (process.env.VMAPGEN_JOIN_TRACE) { const path = []; for (let k = hit; k >= 0; k = prev[k]) path.push(`${k % W},${(k / W) | 0}${scenAt.has(k) ? 's' : rock(k) ? 'r' : ''}`); console.error(`[join] L${l} zone ${z} ${target >= 0 ? 'lone way in' : 'piece'} joined by ${path.slice(0, 12).join(' ')}`); }
			const gone = new Set();
			for (let k = hit; k >= 0; k = prev[k]) {
				if (demAt.has(k) && wall[k]) { gone.add(demAt.get(k)); out.demolished = (out.demolished || 0) + 1; if (process.env.VMAPGEN_JOIN_TRACE) console.error(`[join] L${l} zone ${z} gives up ${demAt.get(k).type} at (${demAt.get(k).x},${demAt.get(k).y})`); }
				else if (scenAt.has(k)) gone.add(scenAt.get(k));
				else if (rock(k)) { open[k] = 1; blocked[base + k] &= ~OCCUPIED; out.rock++; }
			}
			if (gone.size) out.cleared += clearScenery(pl, l, W, H, blocked, { gone });
			// a wall piece cleared by the fallback leaves its zone-line tiles shut: each gets a one-tile obstacle again
			if (!strict && gone.size && pl.biomeTerrain && process.env.VMAPGEN_JOIN_RESEAL !== '0') {
				const onPath = new Set(); for (let k = hit; k >= 0; k = prev[k]) onPath.add(k);
				const { singleTemplate } = require('./decor');
				for (const o of gone) for (const [fx, fy] of blockingCells(o.template, o.x, o.y)) {
					if (fx < 0 || fy < 0 || fx >= W || fy >= H) continue;
					const c = fy * W + fx;
					if (onPath.has(c) || holes.has(c) || !onLine(c) || (blocked[base + c] & OCCUPIED)) continue;
					let r = (c * 2654435761) >>> 0; const rng = () => ((r = (r * 1664525 + 1013904223) >>> 0) / 4294967296);
					const sg = singleTemplate(pl.biomeTerrain[zone[c]], rng);
					if (!sg || !sg.tpl.mask || sg.tpl.mask.length !== 1 || sg.tpl.mask[0].length !== 1) continue;
					pl.objects.push(objectEntry(sg.type, fx, fy, l, sg.tpl, sg.subtype || 'object'));
					footprintBlock(sg.tpl, fx, fy, l, W, H, blocked);
					out.resealed = (out.resealed || 0) + 1;
				}
			}
			out.joined++;
			did = true;
			break;
		}
		if (!did) {
			// the early join (before the fill) never takes the fallback that crosses a wall piece on a zone line: that opened a gap between two zones (36x36 two players
			// seed 3 with K's mods: zone 19 swept to 2 of 222 objects)
			if (!strict || !out.left || opts.early) break;
			strict = false;
			out.left = 0;
		}
	}
	return out;
}

function sweepStranded(plan, W, H, levelIndex, playerStarts, droppedPairs, cross = null) {
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
		// on a split level (splitLevels) a gate or a cross-level monolith is a way in only once its other end is
		// reached: cross.openPairs, from the other level's sweep
		const isArrival = isPortal && (cross && o.pairId ? cross.openPairs.has(o.pairId) : m.vis.some(c => arrivals.has(c)));
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
	if (!stack.length && !pending.length && !cross)
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
			// a hero standing on a gate or monolith fights the guard beside it from there, on any level: a portal end whose
			// only way off is its guard's tile (the end's other ways are walled) is a way in, and the zone behind it is reached
			// (K 10-05: a zone swept empty because its only link was a guarded portal; 4 of 12 maps with water at 2 players
			// on 144 one level, 190 objects dropped on one)
			if (m.appr.some(c => reach[c] && (walkable(c) || exitDirs.has(c)))) {
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
							&& (!exitDirs.has(ny * W + nx) || ((exitDirs.get(ny * W + nx) || ALL_DIRS)
								.some(([ex, ey]) => ex === -dx && ey === -dy)))) touches = true;
				}
			if (touches) { reach[c] = 1; stack.push(c); }
		}
	}

	// a dry run reports the pairs whose end on this level a hero reaches, for the other level's sweep
	if (cross && cross.dry) {
		const out = new Set();
		for (const o of objs) {
			const m = meta.get(o);
			if (o.pairId && m && m.appr.some(c => reach[c] && walkable(c))) out.add(o.pairId);
		}
		return out;
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
			if (process.env.VMAPGEN_DROP_TRACE && (o.pairId || /^(subterraneanGate|monolithTwoWay|town|randomTown)$/.test(o.type)))
				console.error(`[drop] level ${levelIndex}: unreachable ${o.type} at (${o.x},${o.y})${o.pairId ? ' pair ' + o.pairId : ''}`
					+ (o.pairId && cross ? `, other end ${cross.openPairs.has(o.pairId) ? 'reached' : 'not reached'}; approach ${meta.get(o).appr.map(c => `${c % W},${(c / W) | 0}${hard[c] ? 'H' : ''}${(owners.get(c) || []).map(q => ':' + q.type).join('')}`).join(' ')}` : ''));
			if (o.type === 'town' || o.type === 'randomTown') droppedTowns.push(`(${o.x},${o.y})`);
			droppedTypes[o.type] = (droppedTypes[o.type] || 0) + 1;
			if (process.env.VMAPGEN_DROP_TRACE && o.type === 'mine')
				console.error(`[drop] unreachable mine at (${o.x},${o.y}), its approach ${meta.get(o).appr.slice(0, 3).map(c => `${c % W},${(c / W) | 0}`).join(' ')}`);
		}
	}
	if (dropped && process.env.VMAPGEN_DROP_TRACE && plan.zone) {
		const ids = (plan.zoneMeta || []).map(m => (m && m.spec ? m.spec.id : '?'));
		const t = {}, r = {};
		for (let c = 0; c < W * H; c++) { const z = plan.zone[c]; if (z < 0 || hard[c]) continue; t[z] = (t[z] || 0) + 1; if (reach[c]) r[z] = (r[z] || 0) + 1; }
		console.error(`[drop] level ${levelIndex}: open tiles reached per zone: ` + Object.keys(t).map(z => `${ids[z]}:${r[z] || 0}/${t[z]}`).join(' '));
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
	holdFreePaths, templateZoneArray, scaledMines, ensureSignatureDwelling };
