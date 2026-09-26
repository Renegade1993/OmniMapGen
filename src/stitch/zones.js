/**
 * zones.js - the shared placeholder object templates.
 *
 * Design insight (recorded in DEVELOPMENT_LOG): generated maps must be
 * faction-variable, like Nostalgia / Headquarters / Coldshadow's Fantasy.
 * Every creep, dwelling, and skill structure is emitted as a VCMI placeholder
 * object (randomDwelling, randomMonsterLevel*, randomArtifact*) that resolves
 * against whatever faction the player picks at pre-game. The header's
 * allowedFactions lists every indexed town faction so "Random" town selection
 * stays legal on modded content.
 *
 * This file used to carry a second, older placement pass as well
 * (computeZones / zoneBudget / placeZoneObjects / placeAllObjects), left over
 * from before biome/plan.js existed. Nothing imported it, its budgets scaled
 * with sqrt(area) which the 71-map corpus measurement showed to be the wrong
 * shape, and its footprint loop wrote `blocked[i] = 1` over and over instead of
 * the cell it had just computed. Deleted 2026-09-21 rather than left sitting
 * there looking usable.
 */
'use strict';

/**
 * visitableFrom is a 3x3 grid of the directions a hero may arrive from.
 * ---/+-+/+++ is the front-facing pattern nearly every real object uses: not
 * from the north row, from anywhere else. It was labelled "all sides" here,
 * which is wrong. It is also inert: the only readers of visitDir in the whole
 * engine are ObjectTemplate itself and four call sites in the RMG, so it never
 * restricts movement. These values are written to match what the engine writes.
 */
const VISIT_FRONT = ['---', '+-+', '+++'];
const OBJECT_TEMPLATES = {
	// Town footprint copied from the shape real towns actually occupy. The
	// engine throws our template away at game start (CGObjectInstance::setType
	// swaps in the handler's own template for the terrain once the faction is
	// picked), so the art here never renders. What does matter is the area we
	// reserve, because whatever we place next to the town has to survive the
	// real 6x6 town appearing there. Every town template in the installed map
	// corpus is VVVVVV/VVVVVV/VVVVVV/VVBBBV/VBBBBB/VBBABB; the three rows below
	// are every blocking cell of that, with the gate in the same place. The
	// three pure-V rows above it are art only.
	randomTown:      { animation: 'AVTOWN',  mask: ['VBBBV','BBBBB','BBABB'], visitableFrom: VISIT_FRONT },
	randomDwelling:  { animation: 'AVWrnd0', mask: ['VV','VA'], visitableFrom: VISIT_FRONT },
	randomMonster:   { animation: 'AVWmrnd0', mask: ['VV','VA'], visitableFrom: ['+++','+-+','+++'] },
	randomArtifact:  { animation: 'AVArand', mask: ['VV','VA'], visitableFrom: ['+++','+-+','+++'] },
};

module.exports = { OBJECT_TEMPLATES };
