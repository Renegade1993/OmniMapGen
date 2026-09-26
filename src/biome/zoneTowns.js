/**
 * zoneTowns.js - a template zone's towns, as the engine's generator decides
 * them (TownPlacer.cpp, CRmgTemplate.cpp).
 *
 * A zone's towns are of the factions it allows: allowedTowns, or every faction
 * with a town when the list is empty, minus bannedTowns (ZoneOptions::
 * getTownTypes). A player's start on Random rolls from that set, preferring
 * the factions whose preferUndergroundPlacement matches the zone's level
 * (getRandomTownType(true)): Dungeon, Inferno and Necropolis start
 * underground, the rest on the surface. The zone's first town is of the zone's
 * type (the owner's faction in a player zone, a roll in any other), and each
 * further town rolls again unless the zone says townsAreSameType. The engine
 * writes each as a concrete town of its faction; ours were random-town
 * placeholders that ignored the lists, so Golems Aplenty's centre could come
 * out any faction instead of Tower.
 */
'use strict';

const bare = f => String(f || '').toLowerCase().replace(/^.*:/, '');

// the town base in config/objects/moddables.json: blocks the same tiles as the
// randomTown placeholder, three rows of sprite above them
const TOWN_MASK = ['VVVVVV', 'VVVVVV', 'VVVVVV', 'VVBBBV', 'VBBBBB', 'VBBABB'];
const TOWN_VISIT = ['---', '+-+', '+++'];

/**
 * The generator's view of the factions a map may use: [{id, bare, scope,
 * preferUnderground, townMap, townMapCore, townMapScope}], from the asset
 * index's factions (already only those with a town).
 */
function townFactions(factionIds, factions) {
	return factionIds.map(id => {
		const f = factions.get(id) || {};
		const cut = id.lastIndexOf(':');
		return { id, bare: bare(id), scope: cut > 0 ? id.slice(0, cut) : 'core',
			preferUnderground: !!f.preferUnderground, townMap: f.townMap || null,
			townMapCore: f.townMapCore || null, townMapScope: f.townMapScope || null };
	});
}

/** The factions a zone's towns may be (ZoneOptions::getTownTypes). */
function zoneTownTypes(spec, factions) {
	const allowed = new Set(((spec && spec.allowedTowns) || []).map(bare));
	const banned = new Set(((spec && spec.bannedTowns) || []).map(bare));
	return factions.filter(f => (!allowed.size || allowed.has(f.bare)) && !banned.has(f.bare));
}

/** A random start's faction (TownPlacer::getRandomTownType(true)). */
function pickStartFaction(types, underground, roll) {
	const matching = types.filter(f => f.preferUnderground === !!underground);
	const pool = matching.length ? matching : types;
	return pool.length ? pool[Math.min(pool.length - 1, (roll * pool.length) | 0)] : null;
}

/**
 * The template a concrete town is written with: its faction's village sprite,
 * or its fort sprite when it starts with a fort (the engine picks the sprite
 * again from the town's buildings when the game starts). A map declaring no
 * mods takes core's sprites. null when the faction has none.
 */
function townTemplate(faction, fort, useMods) {
	const m = (useMods ? faction.townMap : faction.townMapCore) || {};
	const animation = fort ? (m.fort || m.castle || m.citadel) : (m.village || m.fort || m.castle);
	return animation ? { animation, mask: TOWN_MASK, visitableFrom: TOWN_VISIT } : null;
}

/** The mods a concrete town of this faction needs declared. */
function townMods(faction, useMods) {
	if (!useMods) return [];
	const mods = new Set();
	if (faction.scope !== 'core') mods.add(faction.scope);
	if (faction.townMapScope && faction.townMapScope !== 'core') mods.add(faction.townMapScope);
	return [...mods];
}

module.exports = { townFactions, zoneTownTypes, pickStartFaction, townTemplate, townMods, TOWN_MASK };
