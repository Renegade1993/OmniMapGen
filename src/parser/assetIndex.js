/**
 * assetIndex.js
 *
 * Builds the generator's working dictionary from resolved VCMI config:
 *   - terrains   (shortIdentifier -> {moveCost, type[], allowedLayers})
 *   - objects    (typeId -> {handler, aiValue, templates[]}) preserving the
 *                multi-hex footprint encoded in each template's mask
 *   - creatures / artifacts / factions for header allow-lists
 *   - spells, artifacts, skills and heroes marked onlyOnWaterMap, which the
 *     engine's generator bans from a map without water
 *
 * Sources: the install's config/ tree plus each active mod's Content/config
 * directory or content.zip archive.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { safeIsDir } = require('./modCrawler');

/// Minimal zip reader for VCMI content.zip archives (store/deflate only).
function listZipEntries(buf) {
	const eocd = (() => {
		for (let i = buf.length - 22; i >= 0; i--)
			if (buf.readUInt32LE(i) === 0x06054b50) return i;
		return -1;
	})();
	if (eocd < 0) return [];
	const count = buf.readUInt16LE(eocd + 10);
	let off = buf.readUInt32LE(eocd + 16);
	const out = [];
	for (let i = 0; i < count; i++) {
		const nl = buf.readUInt16LE(off + 28);
		const xl = buf.readUInt16LE(off + 30);
		const cl = buf.readUInt16LE(off + 32);
		out.push({
			name: buf.slice(off + 46, off + 46 + nl).toString('utf8'),
			method: buf.readUInt16LE(off + 10),
			// Compressed size is at +20 in a CENTRAL DIRECTORY record. +18 is
			// where it sits in a LOCAL header, and reading it here got the last
			// two bytes of the CRC and the first two of the size, which is a
			// number far too large. A deflate stream survives being handed
			// extra trailing bytes, so zipped mods mostly limped along; a
			// STORED entry came back with the next entry's bytes glued on and
			// failed to parse. Every one of the 429 config files inside the 20
			// mods that ship a content.zip was unreadable, silently.
			csize: buf.readUInt32LE(off + 20),
			lhoff: buf.readUInt32LE(off + 42),
		});
		off += 46 + nl + xl + cl;
	}
	return out;
}

function readZipEntry(buf, e) {
	const nl = buf.readUInt16LE(e.lhoff + 26);
	const xl = buf.readUInt16LE(e.lhoff + 28);
	const raw = buf.slice(e.lhoff + 30 + nl + xl, e.lhoff + 30 + nl + xl + e.csize);
	return e.method === 8 ? zlib.inflateRawSync(raw) : raw;
}

/**
 * VCMI config is JSON with comments and trailing commas, and a lot of both.
 * A naive `//` strip also cuts through any string containing two slashes, so
 * this walks the text and only treats a comment as a comment outside a string.
 */
const BACKSLASH = String.fromCharCode(92);
const stripJsonComments = input => {
	const s = input.toString('utf8');
	if (s.indexOf('/') < 0) return s;         // nothing to strip, and most files
	// Copy in slices rather than a character at a time: building a megabyte of
	// config one `out += c` at a time took the index rebuild from 35 seconds to
	// over five minutes.
	const parts = [];
	let start = 0, inStr = false, esc = false, i = 0;
	while (i < s.length) {
		const c = s[i];
		if (inStr) {
			if (esc) esc = false;
			else if (c === BACKSLASH) esc = true;
			else if (c === '"') inStr = false;
			i++; continue;
		}
		if (c === '"') { inStr = true; i++; continue; }
		if (c === '/' && (s[i + 1] === '/' || s[i + 1] === '*')) {
			parts.push(s.slice(start, i));
			if (s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; }
			else {
				i += 2;
				while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
				i += 2;
			}
			start = i;
			continue;
		}
		i++;
	}
	parts.push(s.slice(start));
	return parts.join('');
};

/** Trailing commas before a closing brace or bracket, which JSON.parse hates. */
const dropTrailingCommas = s => s.replace(/,(\s*[}\]])/g, '$1');

/**
 * Counts what it could not read.
 *
 * The old version stripped comments with a regex, did nothing about trailing
 * commas, and returned null on failure with no sign anything had gone wrong.
 * Measured against the install that silently threw away **109 of 200 core
 * config files**, including objects/moddables.json, objects/dwellings.json,
 * every rewardable*.json and factions/tower.json. The generator's whole picture
 * of the game was built from fewer than half of it, and nothing said so.
 */
let parseFailures = 0;
function parseJsonSafe(text) {
	const stripped = stripJsonComments(text);
	try { return JSON.parse(stripped); } catch { /* try harder */ }
	try { return JSON.parse(dropTrailingCommas(stripped)); }
	catch { parseFailures++; return null; }
}

/**
 * The content categories the engine loads a mod's configs from
 * (lib/modding/ContentTypeHandler.cpp:251-273). Each is a list in mod.json of
 * config files relative to the mod's content root, ".json" implied.
 */
const CONTENT_CATEGORIES = ['heroClasses', 'artifacts', 'bonuses', 'creatures',
	'campaignRegions', 'factions', 'objects', 'heroes', 'spells', 'spellSchools', 'skills',
	'templates', 'scripts', 'battlefields', 'terrains', 'rivers', 'roads', 'obstacles',
	'biomes', 'resources', 'mapLayers'];

/**
 * The config JSON a mod contributes: exactly the files its mod.json lists
 * under the content categories, read from <mod>/Content/ or <mod>/content.zip,
 * the way the engine loads them. Returns [{name, json}] pairs.
 *
 * This used to read every JSON under the mod's config folder, listed or not.
 * A mod can ship a file its manifest never names, which the engine never
 * loads: Highlands Town carries config/highlands/banks/dwarfHighBank.json but
 * lists only its dwellings file, so ftDwarfBank reached our maps and the
 * engine refused them ("Failed to find object of type
 * creatureBank::ftDwarfBank", 4 of 5 smoke maps, 2026-09-25).
 */
function modConfigPayloads(modDir, manifest) {
	const listed = [];
	for (const key of CONTENT_CATEGORIES) {
		const list = manifest && manifest[key];
		if (!Array.isArray(list)) continue;
		for (const entry of list) {
			if (typeof entry !== 'string') continue;
			let rel = entry.replace(/\\/g, '/').replace(/^\/+/, '');
			if (!/\.json$/i.test(rel)) rel += '.json';
			listed.push({ rel, category: key });
		}
	}
	const out = [];
	let zip = null, entries = null;
	for (const { rel, category } of listed) {
		const loose = ['Content', 'content'].map(c => path.join(modDir, c, ...rel.split('/')))
			.find(f => fs.existsSync(f));
		if (loose) {
			const json = parseJsonSafe(fs.readFileSync(loose, 'utf8'));
			if (json) out.push({ name: path.relative(modDir, loose), json, category });
			continue;
		}
		if (entries === null) {
			try {
				zip = fs.readFileSync(path.join(modDir, 'content.zip'));
				entries = listZipEntries(zip);
			} catch { entries = []; }
		}
		const e = entries.find(x => x.name.toLowerCase() === rel.toLowerCase());
		if (e) {
			const json = parseJsonSafe(readZipEntry(zip, e));
			if (json) out.push({ name: `${modDir}:${e.name}`, json, category });
		}
	}
	return out;
}

/**
 * Config files, skipping `schemas/`.
 *
 * A schema describes content rather than being content, and ingesting one
 * produces nonsense: config/schemas/faction.json has a `dependencies` block
 * with a `town` property, which the faction rule read as a faction called
 * `core:dependencies` and offered to players in the header.
 */
function* walkFiles(dir) {
	for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, ent.name);
		if (ent.isDirectory()) {
			if (ent.name.toLowerCase() === 'schemas') continue;
			yield* walkFiles(p);
		} else yield p;
	}
}

/**
 * Footprint of one object template: the mask grid where 'V' marks visitable
 * tiles and 'B'/'A'/'O' mark blocked or decorative coverage. Width/height are
 * the mask row extent; visitable gives the access cells a hero can stand on.
 */
function templateFootprint(tpl) {
	const mask = tpl.mask || [];
	let w = 0;
	for (const row of mask) w = Math.max(w, String(row).length);
	const blocked = [], visitable = [];
	for (let y = 0; y < mask.length; y++) {
		const row = String(mask[y]);
		for (let x = 0; x < row.length; x++) {
			const c = row[x];
			if (c === 'V' || c === 'B') blocked.push([x, mask.length - 1 - y]);
			if (c === 'V' || c === 'A') visitable.push([x, mask.length - 1 - y]);
		}
	}
	return { width: w, height: mask.length, blocked, visitable, animation: tpl.animation || '' };
}

/**
 * VCMI's JsonUtils::inherit: every field `dest` lacks comes from `base`,
 * structs merge recursively, and anything `dest` sets (arrays included) wins
 * whole. Returns a new value; neither argument is changed.
 */
function inherit(dest, base) {
	const isStruct = v => v && typeof v === 'object' && !Array.isArray(v);
	if (dest === undefined || dest === null) return isStruct(base) ? inherit({}, base) : base;
	if (!isStruct(dest) || !isStruct(base)) return dest;
	const out = { ...dest };
	for (const [k, v] of Object.entries(base)) out[k] = inherit(dest[k], v);
	return out;
}

/**
 * Build the generator dictionary from the core config dir plus an ordered
 * list of active mod manifests (post topologic sort).
 */
function buildAssetIndex(coreConfigDir, orderedMods) {
	const index = {
		terrains: new Map(),   // shortId -> {name, moveCost, types[]}
		rivers: new Map(),     // identifier -> shortIdentifier
		objects: new Map(),    // scopedId -> {type, subtype, handler, aiValue, templates[]}
		creatures: new Map(),
		artifacts: new Map(),
		factions: new Map(),
		spells: new Map(),     // scopedId -> {type, special, waterOnly}
		skills: new Map(),     // scopedId -> {waterOnly}
		heroes: new Map(),     // scopedId -> {waterOnly}
	};
	// object type -> handler, from the groups that define one; what a mod's
	// types-only extension of that type inherits
	const typeHandlers = new Map();
	// object type -> its group's "base", which every subtype inherits (mods'
	// included), the way CObjectClassesHandler does (lines 344 and 508)
	const typeBases = new Map();
	// "type.subtype" -> the id of the entry that defined it first (core, or the
	// mod that added it), which later mods' patches merge into
	const objectOwners = new Map();
	// an rmg block as AObjectTypeHandler::init reads it: value and rarity
	// default to 0 (never placed), the limits to none
	const rmgOf = r => ({ value: Number(r.value) || 0, rarity: Number(r.rarity) || 0,
		...(r.zoneLimit !== undefined && r.zoneLimit !== null ? { zoneLimit: Number(r.zoneLimit) } : {}),
		...(r.mapLimit !== undefined && r.mapLimit !== null ? { mapLimit: Number(r.mapLimit) } : {}) });

	// category: the content category the file was loaded under ('creatures',
	// 'objects', ...), when known
	const ingest = (scope, json, hintFile, category) => {
		if (!json || typeof json !== 'object') return;
		// terrain entries: shortIdentifier + moveCost + tiles. The `tiles`
		// field distinguishes them from roads.json, which carries the same
		// two fields but no tileset.
		for (const [key, val] of Object.entries(json)) {
			if (!val || typeof val !== 'object') continue;
			if (val.shortIdentifier && val.moveCost !== undefined && val.tiles !== undefined) {
				index.terrains.set(val.shortIdentifier, {
					name: `${scope}:${key}`, moveCost: val.moveCost,
					types: val.type || [], allowedLayers: val.allowedLayers || [],
					// which group of terrainViewPatterns.json this terrain draws
					// from, and so which sprite indices are plain ground rather
					// than a border piece. Absent means "normal", matching
					// CTerrainViewPatternConfig::getTerrainViewPatterns.
					viewGroup: val.terrainViewPatterns || 'normal',
					// terrain that needs a SAND border rather than a dirt one:
					// sand itself, water and rock. Drives the sand/dirt branch
					// in CDrawTerrainOperation::validateTerrainViewInner.
					transitionRequired: !!val.transitionRequired,
					identifier: key,
					// the watercourse this ground carries, from terrains.json:
					// dirt and sand run mud, snow runs ice, lava runs lava,
					// everything else runs water
					river: val.river || null,
				});
			}
			// rivers: shortIdentifier + tilesFilename, and no `tiles` field,
			// which is what separates them from terrain
			if (val.shortIdentifier && val.tilesFilename !== undefined
				&& val.tiles === undefined && val.moveCost === undefined)
				index.rivers.set(key, val.shortIdentifier);
			// Object groups. A group with its own handler defines a type
			// ("creatureBank": { "handler": "bank", "types": {...} }); a mod
			// extends an existing type with types alone and inherits its
			// handler ("core:creatureBank": { "types": {...} }), which is how
			// the mods on this install add their banks and dwellings. Those
			// were skipped until 2026-09-25, so no mod bank or dwelling ever
			// reached the generator's pools: 0 of 5547 banks and 0 of 2015
			// dwellings across the fidelity lens's 71 maps, where the corpus
			// draws about 61% of its banks from mods. The type is recorded
			// unscoped either way, the name a map's objects.json uses
			// ("creatureBank", never "core:creatureBank").
			const baseType = key.slice(key.lastIndexOf(':') + 1);
			const handler = val.types && typeof val.types === 'object'
				&& (val.handler || typeHandlers.get(baseType));
			if (handler) {
				if (val.handler && !typeHandlers.has(baseType)) typeHandlers.set(baseType, val.handler);
				if (val.handler && val.base && !typeBases.has(baseType)) typeBases.set(baseType, val.base);
				for (const [subKey, rawSub] of Object.entries(val.types)) {
					// Inheritance as the engine does it: the subtype over its
					// group's base and its type's base, then each template over
					// the subtype's own "base". Mods lean on it: a dwelling a
					// mod adds to core:creatureGeneratorCommon names no
					// visitableFrom and gets core's ["---","+++","+++"] this
					// way, and without it every one read as enterable from
					// nowhere and failed to place (2026-09-25).
					const sub = inherit(inherit(rawSub, val.base), typeBases.get(baseType));
					const templates = [];
					for (const [tplName, rawTpl] of Object.entries(sub.templates || {})) {
						const tpl = inherit(rawTpl, sub.base);
						templates.push({ name: tplName, ...templateFootprint(tpl),
							// the terrains it may stand on; none listed is any land
							// (ObjectTemplate::readJson, canBePlacedAt)
							...(Array.isArray(tpl.allowedTerrains)
								? { allowedTerrains: tpl.allowedTerrains.map(String) } : {}),
							// raw fields needed to EMIT this template into objects.json
							raw: { animation: tpl.animation, mask: tpl.mask,
								visitableFrom: tpl.visitableFrom } });
					}
					// dwelling entries (config/objects/dwellings.json) carry a
					// "creatures" tier list (one array of creature ids per tier,
					// non-upgrading generators have a single tier); the first
					// tier's first id is the creature this dwelling actually
					// produces, which is what a level lookup against
					// index.creatures needs.
					const creatureId = sub.creatures && sub.creatures[0]
						&& sub.creatures[0][0];
					// every creature it offers, across its tiers (the Golem
					// Factory's four golems), for a theme to match on
					const allCreatures = Array.isArray(sub.creatures)
						? sub.creatures.flat().filter(c => typeof c === 'string') : [];
					// a bank's guards and the creatures it pays out, in either config
					// shape: rewardable "rewards" (1.5 on, what core and the mods
					// use) or the older "levels"
					const bankCreatures = [];
					for (const lv of [...(Array.isArray(sub.rewards) ? sub.rewards : []),
						...(Array.isArray(sub.levels) ? sub.levels : [])])
						for (const c of [...((lv && lv.guards) || []), ...((lv && lv.creatures) || []),
							...((lv && lv.reward && lv.reward.creatures) || [])])
							if (c && typeof c.type === 'string') bankCreatures.push(c.type);
					// the random map generator's entry (value, rarity, limits),
					// which is how the engine's treasure piles weigh a bank
					const rmg = sub.rmg && typeof sub.rmg === 'object' ? rmgOf(sub.rmg) : null;
					const id = `${scope}:${key}.${subKey}`;
					// A later mod naming a subtype that core or an earlier mod
					// defined patches that object, merged in load order as the
					// engine does it (JsonUtils::merge): "rmg": null takes it out
					// of the random map generator (HotA's rmgBan: the pirate
					// cavern, spit and ivory tower), a partial "rmg" changes the
					// fields it names (HotA's rmgTweak puts the Imp Cache at 1500),
					// and its templates join the object's. The patch keeps an
					// entry of its own, marked, so nothing reads it as a second
					// object.
					const ownerId = objectOwners.get(`${baseType}.${subKey}`);
					const owner = ownerId && ownerId !== id ? index.objects.get(ownerId) : null;
					if (owner) {
						if (rawSub && Object.prototype.hasOwnProperty.call(rawSub, 'rmg')) {
							if (rawSub.rmg && typeof rawSub.rmg === 'object')
								owner.rmg = rmgOf({ ...(owner.rmg || {}), ...rawSub.rmg });
							else delete owner.rmg;
						}
						for (const t of templates) {
							const at = owner.templates.findIndex(o => o.name === t.name);
							if (at >= 0) owner.templates[at] = t; else owner.templates.push(t);
						}
					} else objectOwners.set(`${baseType}.${subKey}`, id);
					index.objects.set(id, {
						type: baseType, subtype: subKey, handler,
						aiValue: sub.aiValue || 0,
						removable: !!sub.removable,
						templates,
						...(owner ? { overrides: ownerId } : rmg ? { rmg } : {}),
						...(creatureId ? { creature: creatureId, creatures: allCreatures } : {}),
						...(bankCreatures.length ? { bankCreatures: [...new Set(bankCreatures)] } : {}),
					});
				}
			}
			// Creatures: every entry of a file the engine loads as creatures
			// (a mod's "creatures" list, core's config/creatures), as the
			// engine decides it. Core entries carry a level but no fightValue
			// or aiValue (those come from the game's CRTRAITS.TXT), so the old
			// test, a level plus one of those, indexed no core creature at all,
			// and a mod dwelling of a core creature (refugee-town's rogue,
			// goldGolem) could not be levelled. An entry keyed by an already
			// scoped name overrides that creature; its level, if given, wins.
			// Outside that category the old test stays, for configs that are
			// not loaded through a manifest.
			const isCreatureFile = category === 'creatures';
			const id = key.includes(':') ? key : `${scope}:${key}`;
			const prev = index.creatures.get(id);
			if ((typeof val.level === 'number' && (isCreatureFile
					|| val.fightValue !== undefined || val.aiValue !== undefined))
					|| (prev && isCreatureFile)) {
				// A scoped key is an override merged into the creature it names,
				// later mods over earlier ones, as the engine merges configs:
				// what it sets wins, what it leaves out is kept. HotA restyles
				// core creatures this way (graphics.map).
				const g = val.graphics || {};
				const amt = val.advMapAmount || {};
				const pick = (v, old) => (v !== undefined ? v : old);
				index.creatures.set(id, {
					level: pick(typeof val.level === 'number' ? val.level : undefined, prev && prev.level),
					aiValue: val.aiValue || (prev && prev.aiValue) || 0,
					faction: pick(val.faction, prev && prev.faction),
					// core creatures carry their H3 index; OBJECTS.TXT is keyed by it
					index: pick(typeof val.index === 'number' ? val.index : undefined, prev && prev.index),
					map: pick(g.map, prev && prev.map),
					mapMask: pick(Array.isArray(g.mapMask) ? g.mapMask : undefined, prev && prev.mapMask),
					// the mod whose sprite the map template names, which a map
					// using this creature has to declare
					mapScope: g.map !== undefined ? scope : (prev && prev.mapScope),
					advMin: pick(amt.min, prev && prev.advMin),
					advMax: pick(amt.max, prev && prev.advMax),
					special: pick(val.special, prev && prev.special),
					// left out of the engine's random rolls (GameRandomizer.cpp)
					noRandom: pick(val.excludeFromRandomization, prev && prev.noRandom),
					scope: (prev && prev.scope) || scope,
				});
			}
			// Factions that a player could actually be given.
			//
			// The header's allowedFactions is what
			// CGameState::initRandomFactionsForPlayers draws from whenever a
			// player leaves their town on Random, so anything in it has to be
			// a faction with a town. The old test was `val.town ||
			// val.creatureBackground`, which let in core:neutral (a creature
			// faction with no town at all) and core:random, and a player who
			// rolled either of those started the game with no town. The
			// engine's own rule is `town != nullptr && !special`
			// (CTownHandler.cpp:986); index -1 is the random placeholder.
			//
			// The scope prefix is also conditional now. A mod that overrides
			// another mod's faction keys the entry by the already-scoped name,
			// and prefixing it again produced identifiers like
			// `highlands-town:hota.bulwark:bulwark`, which resolve to nothing.
			// Across the 71 installed VCMI random maps every allowedFactions
			// entry is a plain `scope:faction` pair, and none of them is
			// neutral or random.
			if (val.town && !val.special && val.index !== -1) {
				const id = key.includes(':') ? key : `${scope}:${key}`;
				// the town's adventure-map sprites by variant (village, fort,
				// citadel, castle, capitol), laid over the town base in
				// moddables.json; a mod restyling a faction's town (HotA's new
				// graphics) overrides them, and the map then needs that mod
				const tpls = val.town.mapObject && val.town.mapObject.templates;
				const townMap = tpls && typeof tpls === 'object'
					? Object.fromEntries(Object.entries(tpls).filter(([, t]) => t && t.animation)
						.map(([k, t]) => [k, String(t.animation).replace(/\.def$/i, '')]))
					: null;
				const prev = index.factions.get(id);
				if (!prev)
					index.factions.set(id, { name: val.name || key, nativeTerrain: val.nativeTerrain,
						// TownPlacer::getRandomTownType prefers these on underground zones
						preferUnderground: !!val.preferUndergroundPlacement,
						townMap, townMapCore: scope === 'core' ? townMap : null, townMapScope: scope });
				else if (townMap && Object.keys(townMap).length)
					index.factions.set(id, { ...prev, townMap: { ...(prev.townMap || {}), ...townMap },
						townMapScope: scope });
			}
			// Spells, for the list a town's mage guild draws from (every spell
			// the engine allows by default: not special, not a creature ability,
			// CSpellHandler::getDefaultAllowed). A scoped key overrides a spell
			// the way it does a creature.
			if (category === 'spells') {
				const id = key.includes(':') ? key : `${scope}:${key}`;
				const prev = index.spells.get(id);
				const flags = val.flags || {};
				// Core's H3 spells name no type: the engine takes it from the
				// game's SPTRAITS.TXT (CSpellHandler.cpp:574), where spells 0-69
				// are adventure and combat spells and 70 on creature abilities.
				// Those 69 non-special ones are exactly the core spells every
				// corpus town lists.
				const legacy = typeof val.index === 'number' ? (val.index >= 70 ? 'ability' : 'spell') : undefined;
				index.spells.set(id, {
					type: val.type !== undefined ? val.type : ((prev && prev.type) || legacy),
					special: flags.special !== undefined ? !!flags.special : !!(prev && prev.special),
					waterOnly: val.onlyOnWaterMap !== undefined ? !!val.onlyOnWaterMap : !!(prev && prev.waterOnly),
				});
			}
			// What the engine's generator bans from a map without water
			// (CMapGenerator.cpp:483, CMap::banWaterContent): artifacts, skills
			// and heroes marked onlyOnWaterMap, like the spells above. A scoped
			// key sets the flag on another mod's entry: HotA marks core:sylvia.
			if (category === 'artifacts' || category === 'skills' || category === 'heroes') {
				const id = key.includes(':') ? key : `${scope}:${key}`;
				const prev = index[category].get(id);
				index[category].set(id, { ...(prev || {}),
					waterOnly: val.onlyOnWaterMap !== undefined ? !!val.onlyOnWaterMap : !!(prev && prev.waterOnly) });
			}
		}
	};

	parseFailures = 0;
	// Core config
	if (coreConfigDir && safeIsDir(coreConfigDir)) {
		for (const f of walkFiles(coreConfigDir)) {
			if (!f.endsWith('.json')) continue;
			const json = parseJsonSafe(fs.readFileSync(f, 'utf8'));
			// core's category is its folder (config/creatures/*.json)
			const rel = path.relative(coreConfigDir, f).split(path.sep);
			// except the two categories core keeps in one top-level file
			const top = { 'artifacts.json': 'artifacts', 'skills.json': 'skills' }[rel[0]];
			if (json) ingest('core', json, f, rel.length > 1 ? rel[0] : (top || null));
		}
	}

	// Active mods in dependency order
	for (const m of orderedMods || []) {
		for (const { name, json, category } of modConfigPayloads(m.__dir, m)) {
			ingest(m.__id, json, name, category);
		}
	}
	if (parseFailures)
		console.error(`[gen] ${parseFailures} config file(s) could not be parsed `
			+ 'and were skipped; the index is incomplete');
	return index;
}

module.exports = { buildAssetIndex, modConfigPayloads, templateFootprint,
	listZipEntries, readZipEntry, stripJsonComments, dropTrailingCommas };
