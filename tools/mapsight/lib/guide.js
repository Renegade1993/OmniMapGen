'use strict';
/**
 * guide.js - for a feature mapsight score finds outside the engine's line: how to look at it on a map, and where in
 * the generator it comes from. K, 2026-10-01: "make it systemic so the other agent can employ your methods".
 *
 * Each entry: a pattern over feature names, what to run to see the cases (mapsight commands), and the generator code
 * that decides it (src/, paths from the VCMIMapGen root) with any switch that turns a fix off for comparison.
 * Ordered most specific first; the first match wins. Written from the Coldshadow's Fantasy work on 2026-10-01, where
 * each of these was the actual cause of a failing family.
 */
const GUIDE = [
	{
		re: /^(zone graph: links the template never makes|link \d+-\d+: passages)/,
		look: 'mapsight zones OURS.vmap ENGINE.vmap (the "links the template never makes" list gives each passage\'s tile), then mapsight near OURS.vmap X Y L',
		code: 'a passage between zones the template does not link is a hole in the border wall. Generate the map with VMAPGEN_DROP_TRACE=all and VMAPGEN_WALL_TRACE=cells and find the hole\'s tile in the log: '
			+ '"[walls] ... open cells" = held clear before the walls went up (gate sites: plan.js planLevel gate sites, clearOfBorder; town aprons; doorway sides), '
			+ '"[drop] barrier pass opened" = plan.js openSealedPockets, "[drop] pocket pass removed" = plan.js openSealedByObjects (digToStarts digs to a sealed start town), '
			+ '"opened N extra biome border(s)" = biomes.js ensureConnected. A level the template joins only through the other level is in several pieces on purpose (plan.js splitLevels, zonePieces; VMAPGEN_LEVEL_LINKS=0 is the old one-piece rule).',
	},
	{
		re: /^link \d+-\d+: teleports|^content: (subterraneanGate|monolithTwoWay)|^zone \d+: (gate|monolith)/,
		look: 'mapsight zones OURS.vmap ENGINE.vmap (teleports per link); grep the generator log for "cross-level template link(s): N gate pair(s), M portal pair(s)" and "[gate]" lines with VMAPGEN_GATE_TRACE=1',
		code: 'plan.js planMap gate pass (crossConns: a gate pair on one x,y in both zones, else a monolith pair); the site held early in planLevel (gate sites, "ground held for N of M gate(s) down") and below it ("ground held below N of the M gate site(s) above": a site whose zone below is not the link\'s zone falls back to a monolith pair).',
	},
	{
		re: /^relation: (subterranean gate|monolith): /,
		look: 'mapsight near OURS.vmap X Y L at each gate and monolith (mapsight card lists them), beside the engine\'s',
		code: 'plan.js planMap gate pass: guardEnd posts the link\'s guard on an approach cell; site choice nearest the partners\' mean (planLevel gate sites); roads to them: plan.js gateStubs and roadplan.js planRoads (gate road nodes).',
	},
	{
		re: /^zone \d+: underground/,
		look: 'mapsight zones OURS.vmap ENGINE.vmap (level per zone)',
		code: 'rmg/template.js assignLevels (the engine\'s CZonePlacer::prepareZones); main/generate.js passes undergroundStarts and the accommodations.',
	},
	{
		re: /^zone \d+: (town|player town|start)/,
		look: 'grep the generator log for "town found no room" and "holds ground for"',
		code: 'content.js fillBiome towns (zoneMeta.townSpots, put/putHeld); the ground held in plan.js planLevel (townSpots). "found no room" across many zones means the fill thinks the zone is unreachable: plan.js fillLevel reachable (mainComponent, or zonePieces on a split level).',
	},
	{
		re: /^zone \d+: (mine|low loot|high loot|bank|dwelling|neutral dragon|guard)|^zone \d+: tiles/,
		look: 'mapsight zones OURS.vmap ENGINE.vmap (per-zone counts side by side); grep the log for "found no room", "no cell for"',
		code: 'content.js fillBiome (the zone\'s budget from the template: zoneMeta, its mines, treasure bands and piles via rmg/piles.js preparePile). Tiles: biomes.js partitionBiomes and the zone layout in plan.js planLevel. A count of 0 in a whole zone is usually reach (see "town" above).',
	},
	{
		re: /sealed behind a guard|lying open|walk around it|blocks the only way|^metric: (prize_open|high_open|dwelling_open|high_walkable|dwelling_walkable|high_guarded_2|dwelling_guarded_2|mine_guarded_2)|shares the guard with treasure|unattended|closes 3\+ objects/,
		look: 'mapsight guards OURS.vmap and ENGINE.vmap (what each guard seals), mapsight patches for random 20x20 views, mapsight near at an open prize',
		code: 'content.js fillBiome guard posting: postGuard (a guard on the target\'s last approach), postPileGuard (piles, rmg/piles.js preparePile), and the pocket seal (SEAL_POCKETS, POCKET_RANK: the guard and a wall of 1x1 obstacles close the pocket; VMAPGEN_SEAL_POCKETS=0 is the old posting, VMAPGEN_SEAL_TRACE=1 logs each pocket).',
	},
	{
		re: /in a town'?s area|in a town area|^relation: town: a mine within|^relation: open area/,
		look: 'mapsight render OURS.vmap and ENGINE.vmap (areas by colour), mapsight minimap side by side',
		code: 'content.js fillBiome placement: where in the zone each object may go (zoneDist, the zone\'s distance bands near content.js:2560), and the starter mines (plan.js placeStarterMines).',
	},
	{
		re: /corridor|open floor|against a wall|end of a spur|4\+ tiles from a wall|^relation: guard: stands/,
		look: 'mapsight render (walls and floor), mapsight walk OURS.vmap X Y L, mapsight motifs',
		code: 'the zone\'s floor shape: plan.js planLevel walls (border band from boundaries.js carveBoundaries, valleys and decor packs after "phase(\'valleys\')"), underground carve plan.js carveUnderground; then where content.js fillBiome puts each object on it.',
	},
	{
		re: /^metric: (road_|entrance_near_miss)|road tile|road at its entrance|road runs through|guard on a road/,
		look: 'mapsight card (road ends: proper / at nothing / at an object / gap), mapsight near at each listed end',
		code: 'roadplan.js planRoads (zone roads, joinFailed), roadnet.js route/buildRoadNetwork/pruneOrphanRoads, plan.js gateStubs (the last tiles to a town, gate or monolith entrance).',
	},
	{
		re: /^content: /,
		look: 'mapsight compare OURS.vmap ENGINE.vmap (content per 1000 tiles), mapsight outliers',
		code: 'content.js fillBiome pools (objectPools, the zone\'s treasure bands, rmg/piles.js preparePile for what a pile holds). A whole content kind low with everything else right is usually a zone that got no fill: check the zone family first.',
	},
	{
		re: /^metric: terrain/,
		look: 'mapsight card (terrain_illegal), mapsight near at a listed tile',
		code: 'terrain art fit: plan.js (fitCave, "terrain smoothed so an edge pattern fits").',
	},
];

/** The guide entry for a feature name, or null. */
function guideFor(name) {
	return GUIDE.find(g => g.re.test(name)) || null;
}

module.exports = { GUIDE, guideFor };
