/**
 * guardCreatures.js - guards as the creatures they are.
 *
 * Every guard the planner posts is a randomMonsterLevelN placeholder, which
 * the engine turns into any creature of that level when the game starts
 * (GameRandomizer::rollCreature). Two passes turn placeholders into concrete
 * creatures, as the engine's own generator writes them
 * ({type "monster", subtype "<unscoped creature id>", template, options}):
 *
 *   concretizeGuards: a template-mode guard becomes the creature the
 *     engine's rule picked for it (content.js engineGuard, a copy of
 *     ObjectManager::chooseGuard), from the creatures the zone allows
 *     (allowedMonsters / bannedMonsters). The engine writes that creature;
 *     a placeholder would let any creature of the level stand there instead.
 *     The default since 2026-09-26 (VMAPGEN_CONCRETE_GUARDS=0 turns it off).
 *
 *   applyGuardTheme (--guardtheme <name>, guardThemes.json): a share of the
 *     guards become creatures of one family, every creature whose identifier
 *     contains one of the theme's terms, so a mod that adds a golem joins the
 *     golem theme without an edit here. A themed guard is at the
 *     placeholder's level, or one level either side, and stands for the
 *     strength the placeholder did; with no family member that close, the
 *     guard stays as it was.
 *
 * Each concrete creature carries the template the engine itself writes for
 * it (graphics.map and mapMask over the monster base, else the H3 template
 * OBJECTS.TXT gives its index; 368 of 368 corpus kinds reproduced), so the
 * sprite and the blocked tiles are the ones the game expects. A monster
 * blocks one tile, the one a hero attacks it on, and the planner checked
 * that tile. HotA's creatures (and the core ones HotA restyles) draw a
 * three-wide sprite over it, mask ["VVV","VAV"], so that tile is one left of
 * the anchor; the anchor moves right by one to keep it where it was. A
 * creature whose template blocks more than that one tile is not used, so no
 * pass can change the layout the planner checked.
 */
'use strict';

const THEMES = require('./guardThemes.json');
const CORE_VALUES = require('./creature_values.json');
const { OBJECT_TEMPLATES } = require('../stitch/zones');
const { blockingCells, visitableCells } = require('./content');

const PLACEHOLDER = /^randomMonsterLevel([1-7])$/;
const PLACEHOLDER_TPL = OBJECT_TEMPLATES.randomMonster;
// the monster type's base template (config/objects/moddables.json), which a
// creature's graphics.map and mapMask are laid over
const MONSTER_BASE = { mask: ['VV', 'VA'], visitableFrom: ['+++', '+-+', '+++'] };

const themeNames = () => Object.keys(THEMES).filter(k => !k.startsWith('_'));

const PLACEHOLDER_FROM = JSON.stringify(PLACEHOLDER_TPL.visitableFrom);

/**
 * How far right and down a template's anchor has to sit from the
 * placeholder's for the two to block and open the same single tile and be
 * approached from the same sides: {dx, dy}, or null when no move does it.
 * Read with the planner's own mask readers (content.js).
 */
function footprintShift(tpl) {
	if (!tpl || !Array.isArray(tpl.mask) || !tpl.mask.length) return null;
	if (JSON.stringify(tpl.visitableFrom) !== PLACEHOLDER_FROM) return null;
	const blocks = blockingCells(tpl, 0, 0), visits = visitableCells(tpl, 0, 0);
	if (blocks.length !== 1 || visits.length !== 1) return null;
	const [[bx, by]] = blocks, [[vx, vy]] = visits;
	if (bx !== vx || by !== vy) return null;
	return { dx: -bx || 0, dy: -by || 0 };
}

// the placeholder's own tile has to be where the planner put it
const PLACEHOLDER_SHIFT = footprintShift(PLACEHOLDER_TPL);
if (!PLACEHOLDER_SHIFT || PLACEHOLDER_SHIFT.dx || PLACEHOLDER_SHIFT.dy)
	throw new Error('guardCreatures: the monster placeholder no longer blocks just its anchor');

/**
 * Every creature a guard could be, keyed the way engineGuard names them: a
 * core creature by its bare id ("pikeman"), a mod's by its scoped one.
 *
 * useMods false: core alone, as the game's own data describes it
 * (creature_values.json from CRTRAITS.TXT, H3 templates), whatever the active
 * mods do to those creatures, because the map declares no mod to draw them
 * from.
 *
 * useMods true: core and every active mod, as the asset index merged them, a
 * mod's restyle of a core creature included; what a core entry leaves out
 * (its AI value, its stack range) comes from CRTRAITS, as in the engine.
 */
function creatureRegistry(creatures, useMods) {
	const reg = new Map();
	if (!useMods || !creatures || !creatures.size) {
		for (const [name, c] of Object.entries(CORE_VALUES))
			reg.set(name, { id: name, name, scope: 'core', level: c.level, aiValue: c.aiValue,
				advMin: c.advMin, advMax: c.advMax, faction: c.faction, special: !!c.special,
				index: c.index });
		return reg;
	}
	const either = (v, old) => (v !== undefined ? v : old);
	for (const [key, c] of creatures) {
		const name = key.slice(key.lastIndexOf(':') + 1);
		const scope = c.scope || key.slice(0, key.lastIndexOf(':'));
		const core = scope === 'core' ? CORE_VALUES[name] || {} : {};
		const id = scope === 'core' ? name : key;
		reg.set(id, { id, name, scope,
			level: either(c.level, core.level),
			aiValue: c.aiValue || core.aiValue || 0,
			advMin: either(c.advMin, core.advMin), advMax: either(c.advMax, core.advMax),
			faction: either(c.faction, core.faction),
			special: !!either(c.special, core.special), noRandom: !!c.noRandom,
			index: either(c.index, core.index),
			map: c.map, mapMask: c.mapMask, mapScope: c.mapScope });
	}
	return reg;
}

/**
 * engineGuard's pool: the creatures ObjectManager::chooseGuard considers (not
 * special, with an AI value), with a level to fall back on.
 */
function guardPool(registry) {
	const out = [];
	for (const c of registry.values())
		if (!c.special && c.aiValue > 0 && c.level >= 1)
			out.push({ id: c.id, level: c.level, aiValue: c.aiValue,
				advMin: c.advMin || 0, advMax: c.advMax || 0, faction: c.faction });
	return out;
}

/**
 * How the map writes a creature: {tpl, shift, mods}, or null when it cannot.
 *
 * A map names a monster by its unscoped identifier, and the engine resolves
 * that in the map scope ("game": every active mod plus core, ModScope.h) only
 * when exactly one creature has the name (CIdentifierStorage::
 * getIdentifierImpl), so a name two creatures share would make the map
 * unloadable and is never written. mods are the ones the map has to declare:
 * the creature's own, and the one whose sprite its template names.
 */
function creatureLook(rec, { h3, useMods, holders }) {
	if (!rec) return null;
	if (!useMods && rec.scope !== 'core') return null;
	if (holders && holders.get(rec.name.toLowerCase()) > 1) return null;
	const tpl = useMods && rec.map
		? { animation: String(rec.map).replace(/\.def$/i, ''),
			mask: rec.mapMask || MONSTER_BASE.mask, visitableFrom: MONSTER_BASE.visitableFrom }
		: (rec.index !== undefined && h3 ? h3.get(rec.index) : undefined);
	const shift = footprintShift(tpl);
	if (!shift) return null;
	const mods = new Set();
	if (useMods) {
		if (rec.scope !== 'core') mods.add(rec.scope);
		if (rec.map && rec.mapScope && rec.mapScope !== 'core') mods.add(rec.mapScope);
	}
	return { tpl, shift, mods: [...mods] };
}

/** How many creatures of the registry go by each (lower-cased) bare name. */
function nameHolders(registry) {
	const holders = new Map();
	for (const c of registry.values()) {
		const n = c.name.toLowerCase();
		holders.set(n, (holders.get(n) || 0) + 1);
	}
	return holders;
}

/** Make the placeholder `o` the concrete creature `name` with look {tpl, shift}. */
function becomeCreature(o, name, look, amount) {
	const options = { ...(o.options || {}), character: (o.options && o.options.character) || 'hostile' };
	if (amount !== null && amount !== undefined) options.amount = amount;
	else delete options.amount;
	o.type = 'monster';
	o.subtype = name;
	o.x += look.shift.dx;
	o.y += look.shift.dy;
	o.instanceName = `monster_${o.x}_${o.y}_${o.l}`;
	o.template = { animation: look.tpl.animation, editorAnimation: '', mask: look.tpl.mask,
		visitableFrom: look.tpl.visitableFrom };
	o.options = options;
}

/** A moved anchor has to stay on the map, as every object's does. */
const anchorFits = (o, shift, W, H) => o.x + shift.dx < W && o.y + shift.dy < H;

/**
 * Write each guard in `picked` (object -> creature id from engineGuard) as
 * that creature, in place, on a W x H map. A guard whose creature has no
 * writable template stays a placeholder of its level, as before. Returns
 * {placed, kept, mods}.
 */
function concretizeGuards(objects, picked, { registry, h3, useMods, W = Infinity, H = Infinity }) {
	const holders = nameHolders(registry);
	const looks = new Map();
	const mods = new Set();
	let placed = 0, kept = 0;
	for (const o of objects) {
		const id = picked.get(o);
		if (!id || !PLACEHOLDER.test(o.type)) continue;
		if (!looks.has(id)) looks.set(id, creatureLook(registry.get(id), { h3, useMods, holders }));
		const look = looks.get(id);
		if (!look || !anchorFits(o, look.shift, W, H)) { kept++; continue; }
		becomeCreature(o, registry.get(id).name, look, o.options && o.options.amount);
		for (const m of look.mods) mods.add(m);
		placed++;
	}
	return { placed, kept, mods };
}

/**
 * The placeholders no rule picked a creature for (the free layout's guards,
 * and any a template zone's rule left), written as the creature the game
 * itself rolls for them when the map loads (CCreatureHandler::
 * pickRandomMonster: any creature of that level that is neither special nor
 * kept out of random rolls, each as likely), so the map holds concrete guards
 * as every corpus map does and declares the mods they come from. The stack
 * stays as placed. A level with no creature the map can draw keeps its
 * placeholders.
 */
function rollPlaceholders(objects, picked, { registry, h3, useMods, W = Infinity, H = Infinity, rng }) {
	const holders = nameHolders(registry);
	const looks = new Map();
	const lookOf = id => {
		if (!looks.has(id)) looks.set(id, creatureLook(registry.get(id), { h3, useMods, holders }));
		return looks.get(id);
	};
	// per level, the creatures the roll can land on whose art the map can use
	const byLevel = new Map();
	for (const c of registry.values()) {
		if (c.special || c.noRandom || !(c.level >= 1 && c.level <= 7) || !lookOf(c.id)) continue;
		if (!byLevel.has(c.level)) byLevel.set(c.level, []);
		byLevel.get(c.level).push(c.id);
	}
	const mods = new Set();
	let placed = 0, kept = 0;
	for (const o of objects) {
		const m = PLACEHOLDER.exec(o.type);
		if (!m || (picked && picked.has(o))) continue;
		const ids = (byLevel.get(Number(m[1])) || []).filter(id => anchorFits(o, lookOf(id).shift, W, H));
		if (!ids.length) { kept++; continue; }
		const id = ids[(rng() * ids.length) | 0];
		const look = lookOf(id);
		becomeCreature(o, registry.get(id).name, look, o.options && o.options.amount);
		for (const mod of look.mods) mods.add(mod);
		placed++;
	}
	return { placed, kept, mods };
}

/**
 * The strength a placeholder of each level stands for. The engine rolls any
 * creature of that level, so it is the mean over them, taken over core the
 * way engineGuard sizes its stacks: per creature (for a stack given an
 * amount) and per typical stack (for one the engine sizes itself, from the
 * creature's own adventure-map range).
 */
function levelStrengths() {
	const sum = new Map();
	for (const c of Object.values(CORE_VALUES)) {
		if (c.special || !(c.aiValue > 0) || !(c.level >= 1 && c.level <= 7)) continue;
		const s = sum.get(c.level) || { n: 0, ai: 0, stack: 0 };
		s.n++;
		s.ai += c.aiValue;
		s.stack += c.aiValue * (c.advMin + c.advMax) / 2;
		sum.set(c.level, s);
	}
	const out = new Map();
	for (const [level, s] of sum) out.set(level, { perCreature: s.ai / s.n, perStack: s.stack / s.n });
	return out;
}

/**
 * The creatures a theme can place: the registry's (see creatureRegistry for
 * what useMods changes) whose bare id contains one of the theme's terms and
 * that the map can write. A creature a mod keeps out of the engine's own
 * random rolls (excludeFromRandomization) stays out of a theme too.
 *
 * Each entry: {name, level, aiValue, advMax, tpl, shift, mods}.
 */
/** Whether a creature id (scoped or bare) belongs to the theme's family. */
function themeMatcher(themeName) {
	const theme = THEMES[themeName];
	if (!theme || themeName.startsWith('_'))
		throw new Error(`unknown guard theme "${themeName}"; themes: ${themeNames().join(', ')}`);
	const terms = theme.match.map(t => String(t).toLowerCase());
	return id => {
		const n = String(id).toLowerCase().replace(/^.*:/, '');
		return terms.some(t => n.includes(t));
	};
}

/**
 * The dwellings a theme can place: core's (DWELLING_POOL, their creatures
 * read from the index's config objects) and the mod dwellings generate.js
 * pooled, whose creatures include one of the family. content.js draws `share`
 * of a map's dwellings from these, nearest the level it wanted.
 */
function themeDwellingPool(themeName, corePool, modPool, objects, share) {
	const inTheme = themeMatcher(themeName);
	const creaturesOf = d => {
		const o = objects.get(`core:${d.type}.${d.subtype}`);
		return (o && (o.creatures || (o.creature ? [o.creature] : []))) || [];
	};
	return {
		pool: [...corePool.filter(d => creaturesOf(d).some(inTheme)),
			...(modPool || []).filter(d => (d.creatures || []).some(inTheme))],
		share,
	};
}

/**
 * The creature banks a theme can place: core's (CORE_BANKS) and the mod banks
 * generate.js pooled, whose guards or rewards include one of the family (the
 * index's bankCreatures). content.js draws `share` of a map's banks from these.
 */
function themeBankPool(themeName, corePool, modPool, objects, share) {
	const inTheme = themeMatcher(themeName);
	const creaturesOf = b => {
		const o = objects.get(`core:${b.type || 'creatureBank'}.${b.subtype}`);
		return (o && o.bankCreatures) || [];
	};
	return {
		pool: [...corePool.filter(b => creaturesOf(b).some(inTheme)),
			...(modPool || []).filter(b => (b.creatures || []).some(inTheme))],
		share,
	};
}

function themePool(themeName, { creatures = new Map(), h3 = new Map(), useMods = false } = {}) {
	const inTheme = themeMatcher(themeName);
	const registry = creatureRegistry(creatures, useMods);
	const holders = nameHolders(registry);
	const pool = [];
	for (const c of registry.values()) {
		if (!inTheme(c.name)) continue;
		if (c.special || c.noRandom || !(c.aiValue > 0) || !(c.level >= 1 && c.level <= 7)) continue;
		const look = creatureLook(c, { h3, useMods, holders });
		if (!look) continue;
		pool.push({ name: c.name, level: c.level, aiValue: c.aiValue, advMax: c.advMax, ...look });
	}
	return pool;
}

/**
 * Swap a share of the guard placeholders in `objects` for themed creatures,
 * in place, on a W x H map. Returns {themed, placeholders, mods}: how many
 * were swapped, how many there were, and the mods the swapped ones need
 * declared.
 */
function applyGuardTheme(objects, { pool, share = 1, rng, W = Infinity, H = Infinity }) {
	const strength = levelStrengths();
	const mods = new Set();
	let themed = 0, placeholders = 0;
	const nearest = (level, o) => {
		for (const gap of [0, 1]) {
			const hits = pool.filter(c => Math.abs(c.level - level) === gap && anchorFits(o, c.shift, W, H));
			if (hits.length) return hits[(rng() * hits.length) | 0];
		}
		return null;
	};
	for (const o of objects) {
		const m = PLACEHOLDER.exec(o.type);
		if (!m) continue;
		placeholders++;
		if (!(rng() < share)) continue;
		const level = Number(m[1]);
		const c = nearest(level, o);
		if (!c) continue;
		const s = strength.get(level);
		const given = o.options && Number.isFinite(o.options.amount) ? o.options.amount : null;
		let amount = null;
		if (given !== null) {
			amount = Math.max(1, Math.round(given * s.perCreature / c.aiValue));
		} else if (c.level !== level || !(c.advMax > 0)) {
			// the engine would size a stack of this creature for its own level
			// (or not at all, with no range); size it for the placeholder's,
			// varied the way engineGuard varies a stack
			amount = Math.max(1, Math.round(s.perStack / c.aiValue));
			if (amount >= 4) amount = Math.max(1, Math.round(amount * (0.75 + rng() * 0.5)));
		}
		// otherwise the engine rolls the amount from the creature's own range,
		// as it would have had it picked this creature itself
		// (CGCreature.cpp:296-298)
		becomeCreature(o, c.name, c, amount);
		for (const mod of c.mods) mods.add(mod);
		themed++;
	}
	return { themed, placeholders, mods };
}

module.exports = { themeNames, themePool, applyGuardTheme, concretizeGuards, rollPlaceholders, creatureRegistry,
	guardPool, creatureLook, footprintShift, levelStrengths, themeMatcher, themeDwellingPool,
	themeBankPool };
