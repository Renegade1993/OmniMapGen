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
 * Whether a creature's wider picture would lie under a crater drawn after it. A HotA-styled creature (mask ["VVV","VAV"]) moves its anchor
 * one right of the placeholder's, so its picture reaches a column the planner never checked; a crater blocking a tile there and drawn
 * after the stack (a lower row, or the same row further right) covers it. Craters only: any object drawn after it over that column is
 * 455 of 906 three-wide stacks on four maps of K's settings (mountains 69, dirt hills 36, banks 30, craters 28: .tmpopus-seeingi4\
 * covertally.js), a stack beside a mountain or a tree is what every map with HotA's creatures shows, and K named the crater; MapGen Dev's
 * guard-blocked check counts craters for the same reason (0.1 a thousand stacks on the engine's maps, 0.2 to 0.4 on ours). K, 2026-10-14, his 144x144 Coldshadow map seed 2042393645:
 * "enchanter got placed behind a crater (decorative blocker) again", the Enchanter (20,46) under the crater (21,46), which blocks (20,46).
 * Built once from the objects; test(o, look) for a placeholder o and a look {tpl, shift}. VMAPGEN_GUARD_CRATER=0 never refuses a look.
 */
const COVERS = /^crater$/;
function coverTest(objects) {
	const MON = /^(monster|randomMonster)/;
	const at = new Map();
	for (const q of objects) {
		if (!q.template || !Array.isArray(q.template.mask) || MON.test(q.type) || !COVERS.test(q.type)) continue;
		for (const [x, y] of blockingCells(q.template, q.x, q.y)) at.set(`${q.l || 0}:${x}:${y}`, q);
	}
	const picture = (tpl, ax, ay) => {
		const out = [], m = tpl.mask;
		for (let i = 0; i < m.length; i++) for (let j = 0; j < m[i].length; j++)
			if (/[VBA]/.test(m[i][j])) out.push([ax - (m[i].length - 1 - j), ay - (m.length - 1 - i)]);
		return out;
	};
	return (o, look) => {
		if (process.env.VMAPGEN_GUARD_CRATER === '0' || !look || (!look.shift.dx && !look.shift.dy)) return false;
		const l = o.l || 0, ax = o.x + look.shift.dx, ay = o.y + look.shift.dy;
		const was = new Set(picture(PLACEHOLDER_TPL, o.x, o.y).map(c => c.join()));
		for (const [x, y] of picture(look.tpl, ax, ay)) {
			if (was.has(`${x},${y}`)) continue;
			const q = at.get(`${l}:${x}:${y}`);
			if (q && (q.y > ay || (q.y === ay && q.x > ax))) return true;
		}
		return false;
	};
}

/**
 * Where a creature's FIGURE stands against the tile it blocks (K, 2026-11-02, "SEVERE FAILURE": a Diamond Golem drawn in the water beside a
 * monolith on snow, seed 1320854187, the golem blocking (59,72) on land). The client draws a creature's picture with its bottom right on the
 * anchor tile and the creature blocks the mask's 'A' tile; for most HotA-styled creatures (mask ["VVV","VAV"]) the picture's feet land on the
 * 'A' tile, but a narrow sprite (a 64 or 32 wide one, e.g. RFGCA-L5U 64x48) puts them one tile east or west of it. Counted on K's 48 maps
 * (13,722 stacks): -1 for 281, 0 for 11,074, +1 for 294; the blocked tile never stands on water, the figure did 16 times, on rock 16, and on
 * another object's blocked tile 289. Neither the mask (it is what the game writes: 368 of 368 corpus kinds) nor the shift (it keeps the blocked
 * tile where the planner checked it) is wrong, so a guard is written as a creature whose figure tile is land and free (this test), as the crater
 * test does for a picture under a crater.
 *
 * The figure test of a run: figure = { legal(x, y, l, self), roots, offsetOf(look) (optional, the sprite reader's answer; tests give their
 * own) }. legal says whether a creature's feet may stand on tile (x, y) of level l: on the map, not water, not rock, not another object's
 * blocked tile (self is the stack itself). The offset of a look is read from its sprite the way pictures.js places it; a sprite the archives
 * and mods do not hold is not judged (counted in .unread). VMAPGEN_GUARD_FIGURE=0 never refuses a look.
 */
function figureTest(figure) {
	const off = !figure || typeof figure.legal !== 'function' || process.env.VMAPGEN_GUARD_FIGURE === '0';
	const memo = new Map();
	const t = { unread: 0, ok: null };
	const offsetOf = look => {
		const k = look.tpl && look.tpl.animation;
		if (memo.has(k)) return memo.get(k);
		let v = null;
		if (typeof figure.offsetOf === 'function') v = figure.offsetOf(look);
		else {
			const pics = require('./pictures'), rts = figure.roots || pics.spriteRoots();
			// a mod that ships its sprites in a content.zip (HotA's Bulwark, Pavilion, Preserve: 44 of 310 creatures a guard can be) is read there
			const s = pics.spriteOf(k, rts) || pics.spriteOfInZip(k, rts);
			if (!s) t.unread++;
			else {
				let maxY = -1;
				for (let j = 0; j < s.h; j++) for (let i = 0; i < s.w; i++) if (s.px[j * s.w + i] > 7) maxY = j;
				if (maxY >= 0) {
					let a = Infinity, b = -1;
					for (let i = 0; i < s.w; i++) if (s.px[maxY * s.w + i] > 7) { if (i < a) a = i; b = i; }
					// the anchor stands at (100 + shift) when the 'A' tile is (100, 100); tiles are 32 px
					const [OX, OY] = pics.origin(100 + look.shift.dx, 100 + look.shift.dy, s);
					v = { dx: Math.floor((OX + (a + b) / 2) / 32) - 100, dy: Math.floor((OY + maxY) / 32) - 100 };
				}
			}
		}
		memo.set(k, v);
		return v;
	};
	// o is a placeholder not yet written: its tile is the 'A' tile the creature will block
	// whether the look's figure was read (a sprite none of the archives, mods or zips hold is not): the swaps and rolls prefer a creature that was
	t.known = off ? () => true : look => !!look && offsetOf(look) !== null;
	t.ok = off ? () => true : (o, look) => {
		if (!look) return true;
		const v = offsetOf(look);
		if (!v || (!v.dx && !v.dy)) return true;
		return figure.legal(o.x + v.dx, o.y + v.dy, o.l || 0, o);
	};
	return t;
}

/**
 * Write each guard in `picked` (object -> creature id from engineGuard) as
 * that creature, in place, on a W x H map. A guard whose creature has no
 * writable template stays a placeholder of its level, as before. Returns
 * {placed, kept, mods, swapped, coveredLeft, figSwapped, figLeft}.
 */
function concretizeGuards(objects, picked, { registry, h3, useMods, W = Infinity, H = Infinity, poolAt = null, figure = null }) {
	const holders = nameHolders(registry);
	const looks = new Map();
	const lookOf = id => {
		if (!looks.has(id)) looks.set(id, creatureLook(registry.get(id), { h3, useMods, holders }));
		return looks.get(id);
	};
	const covered = coverTest(objects);
	const fig = figureTest(figure), figOk = fig.ok;
	const mods = new Set();
	let placed = 0, kept = 0, swapped = 0, coveredLeft = 0, figSwapped = 0, figLeft = 0;
	for (const o of objects) {
		const id = picked.get(o);
		if (!id || !PLACEHOLDER.test(o.type)) continue;
		lookOf(id);
		let look = looks.get(id), rec = registry.get(id), amount = o.options && o.options.amount;
		if (!look || !anchorFits(o, look.shift, W, H)) { kept++; continue; }
		// a picture a crater drawn after it would cover, or a figure that would stand in the water, on rock or on another object's blocked tile:
		// another creature of its level whose picture is clear, of its faction where one is (HotA restyles a whole faction three wide, so mostly
		// another's), nearest in value, at the same strength
		const underCrater = covered(o, look), badFigure = !figOk(o, look);
		if (underCrater || badFigure) {
			// from the creatures the guard's zone allows when the caller says (poolAt: the zone's guard pool), else every creature
			const allowed = poolAt ? new Set(poolAt(o).map(c => c.id)) : null;
			const pool = [...registry.values()].filter(c => c !== rec && !c.special && !c.noRandom && c.level === rec.level && c.aiValue > 0 && (!allowed || allowed.has(c.id)))
				.map(c => ({ c, look: lookOf(c.id) })).filter(a => a.look && anchorFits(o, a.look.shift, W, H));
			let alt = pool.filter(a => !covered(o, a.look) && figOk(o, a.look));
			// no look clear of both: a figure out of the water outranks a picture under a crater
			if (!alt.length && badFigure) alt = pool.filter(a => figOk(o, a.look));
			// a creature whose figure was read is judged; one that was not stays a last resort
			if (alt.some(a => fig.known(a.look))) alt = alt.filter(a => fig.known(a.look));
			const own = alt.filter(a => a.c.faction === rec.faction);
			if (alt.length) {
				const a = (own.length ? own : alt).reduce((x, y) => (Math.abs(y.c.aiValue - rec.aiValue) < Math.abs(x.c.aiValue - rec.aiValue) ? y : x));
				if (amount && rec.aiValue > 0) amount = Math.max(1, Math.round(amount * rec.aiValue / a.c.aiValue));
				rec = a.c; look = a.look;
				if (badFigure) figSwapped++; else swapped++;
			} else if (badFigure) figLeft++;
			else coveredLeft++;
		}
		becomeCreature(o, rec.name, look, amount);
		for (const m of look.mods) mods.add(m);
		placed++;
	}
	return { placed, kept, mods, swapped, coveredLeft, figSwapped, figLeft, figUnread: fig.unread };
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
function rollPlaceholders(objects, picked, { registry, h3, useMods, W = Infinity, H = Infinity, rng, figure = null }) {
	const holders = nameHolders(registry);
	const looks = new Map();
	const lookOf = id => {
		if (!looks.has(id)) looks.set(id, creatureLook(registry.get(id), { h3, useMods, holders }));
		return looks.get(id);
	};
	const covered = coverTest(objects);
	const fig = figureTest(figure), figOk = fig.ok;
	// per level, the creatures the roll can land on whose art the map can use
	const byLevel = new Map();
	for (const c of registry.values()) {
		if (c.special || c.noRandom || !(c.level >= 1 && c.level <= 7) || !lookOf(c.id)) continue;
		if (!byLevel.has(c.level)) byLevel.set(c.level, []);
		byLevel.get(c.level).push(c.id);
	}
	const mods = new Set();
	let placed = 0, kept = 0, figRestricted = 0, figLeft = 0;
	for (const o of objects) {
		const m = PLACEHOLDER.exec(o.type);
		if (!m || (picked && picked.has(o))) continue;
		const fit = (byLevel.get(Number(m[1])) || []).filter(id => anchorFits(o, lookOf(id).shift, W, H));
		// a look an object drawn after the stack would cover only when every look of the level is covered (coverTest); a look whose figure
		// would stand in the water, on rock or on another object's blocked tile only when every look of the level does (figureTest)
		const fitFig = fit.filter(id => figOk(o, lookOf(id)));
		const clear = fitFig.filter(id => !covered(o, lookOf(id)));
		let ids = clear.length ? clear : fitFig.length ? fitFig : fit;
		if (fitFig.length && ids.some(id => fig.known(lookOf(id)))) ids = ids.filter(id => fig.known(lookOf(id)));
		if (!ids.length) { kept++; continue; }
		if (fitFig.length < fit.length) figRestricted++;
		if (fit.length && !fitFig.length) figLeft++;
		const id = ids[(rng() * ids.length) | 0];
		const look = lookOf(id);
		becomeCreature(o, registry.get(id).name, look, o.options && o.options.amount);
		for (const mod of look.mods) mods.add(mod);
		placed++;
	}
	return { placed, kept, mods, figRestricted, figLeft, figUnread: fig.unread };
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
function applyGuardTheme(objects, { pool, share = 1, rng, W = Infinity, H = Infinity, figure = null }) {
	const strength = levelStrengths();
	const mods = new Set();
	let themed = 0, placeholders = 0, figLeft = 0;
	// a look a crater drawn after the stack would cover only when every look that fits is covered (coverTest), as rollPlaceholders; a look
	// whose figure would stand in the water, on rock or on another object's blocked tile likewise (figureTest)
	const covered = coverTest(objects);
	const ft = figureTest(figure), figOk = ft.ok;
	const nearest = (level, o) => {
		for (const gap of [0, 1]) {
			const hits = pool.filter(c => Math.abs(c.level - level) === gap && anchorFits(o, c.shift, W, H));
			const fitFig = hits.filter(c => figOk(o, c));
			const clear = fitFig.filter(c => !covered(o, c));
			let ids = clear.length ? clear : fitFig.length ? fitFig : hits;
			if (fitFig.length && ids.some(c => ft.known(c))) ids = ids.filter(c => ft.known(c));
			if (hits.length && !fitFig.length) figLeft++;
			if (ids.length) return ids[(rng() * ids.length) | 0];
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
	return { themed, placeholders, mods, figLeft };
}

module.exports = { themeNames, themePool, applyGuardTheme, concretizeGuards, rollPlaceholders, creatureRegistry,
	guardPool, creatureLook, footprintShift, levelStrengths, themeMatcher, themeDwellingPool,
	themeBankPool, figureTest };
