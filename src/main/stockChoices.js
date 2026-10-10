/**
 * stockChoices.js - the game's own Random Map Setup choices, as the generator
 * takes them (K, 2026-09-27: DMB and its mods never do less than stock VCMI).
 *
 * The in-game tab's classic Map page offers what that screen offers, and the
 * generator reads it here: human or computer players and computer only
 * players; Random for those counts, the template, water content and monster
 * strength; and the three road types. Random rolls from the map's seed, on a
 * stream apart from the generator's own, so the same options make the same
 * map, and every roll is reported.
 */
'use strict';

const ROAD_CODES = ['pd', 'pg', 'pc'];   // dirt, gravel, cobblestone (config/roads.json)
const RANDOM = -1;                        // a count or water content left to chance
const RANDOM_STRENGTH = -9;               // monster strength left to chance

/**
 * A roller on the map's seed: next() in [0, 1), pick(list), and what it rolled.
 * The seed is mixed first (murmur3's finalizer) and the first draws dropped:
 * xorshift started straight from nearby seeds drew nearly the same first
 * number for all of them, and Random water came out "none" on 60 seeds of 60.
 */
function roller(seed) {
	let h = ((Number(seed || 1) >>> 0) ^ 0x9e3779b9) >>> 0;
	h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
	h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
	let s = ((h ^ (h >>> 16)) >>> 0) || 1;
	const next = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
	for (let i = 0; i < 4; i++) next();
	return { next, pick: list => list[Math.floor(next() * list.length)], rolled: [] };
}

/** Whether a template's player range ("2-4", "2,4,6-8") takes n; no range takes any. */
function rangeTakes(range, n) {
	if (!range) return true;
	return String(range).split(',').some(part => {
		const [a, b] = part.split('-').map(Number);
		return n >= a && n <= (Number.isNaN(b) || b === undefined ? a : b);
	});
}

/**
 * The map's players, stock's way when asked. humans is the Random Map Setup's
 * "human or computer players" and compOnly its "computer only players", and
 * the map has their sum; without compOnly, players is the total as before.
 * Any of the three may be RANDOM; a roll keeps to 2-8 players and to the
 * template's range, as the engine's CMapGenOptions picks counts the template
 * takes. Counts that fit no map are kept, and the template check says why.
 * Returns { nPlayers, humans }.
 */
function playerCounts({ players, humans, compOnly, templatePlayers }, roll) {
	const total = n => n >= 2 && n <= 8 && rangeTakes(templatePlayers, n);
	const num = v => (v === undefined || v === null || v === '' ? undefined : Math.round(Number(v)));
	let h = num(humans);
	const comp = num(compOnly);
	if (comp !== undefined) {
		const pairs = [];
		for (let hh = 1; hh <= 8; hh++)
			for (let c = 0; c <= 7; c++)
				if ((h === undefined || h < 0 || hh === h) && (comp < 0 || c === comp) && total(hh + c))
					pairs.push([hh, c]);
		if (!pairs.length) {
			const hh = h > 0 ? h : 1, c = comp >= 0 ? comp : 1;
			return { nPlayers: Math.min(8, hh + c), humans: hh };
		}
		const [hh, c] = roll.pick(pairs);
		if (h === undefined || h < 0 || comp < 0) roll.rolled.push(`human or computer players ${hh}, computer only ${c}`);
		return { nPlayers: hh + c, humans: hh };
	}
	let n = num(players === undefined ? 2 : players);
	if (n < 0) {
		const ok = [];
		for (let k = Math.max(2, h > 0 ? h : 1); k <= 8; k++) if (total(k)) ok.push(k);
		n = ok.length ? roll.pick(ok) : 2;
		roll.rolled.push(`players ${n}`);
	}
	n = Math.min(n, 8);
	if (h !== undefined && h < 0) {
		h = 1 + Math.floor(roll.next() * n);
		roll.rolled.push(`human players ${h}`);
	}
	return { nPlayers: n, humans: h };
}

/**
 * Water content, stock's four choices over the Water page's levers, applied to
 * biomes: 0 None (no water), 1 Normal (the levers as set), 2 Islands (the
 * islands layout), RANDOM one of the three. Normal and Islands at an amount of
 * 0% take defaultCoverage, so either always brings water: Normal beside 0%
 * made a dry map while the page read Normal (DMB Dev, 2026-09-27).
 */
function applyWaterContent(biomes, roll, { islandsShape, defaultCoverage }) {
	// Water layout's two extra values (K, 2026-10-05, "a option for random, and a option for template"): 7 Random picks one of the five
	// land layouts (Lakes, Coastal, Continental, Mediterranean, Highland) from the map's seed, 8 Template (the picker's default) is what
	// the template does with its water, which is Lakes' engine-style water, and the free layout's default too. Islands is one state with
	// content Islands: either one sets the other, so the stored layout and content agree.
	if (biomes.waterShape !== undefined) {
		const v = Math.round(Number(biomes.waterShape));
		if (v === 7) { biomes.waterShape = roll.pick([0, 1, 2, 3, 4]); roll.rolled.push(`water layout ${['lakes', 'coastal', 'continental', 'mediterranean', 'highland'][biomes.waterShape]}`); }
		else if (v === 8) biomes.waterShape = 0;
		if (Math.round(Number(biomes.waterShape)) === islandsShape && biomes.waterContent !== undefined && Math.round(biomes.waterContent) === 1) biomes.waterContent = 2;
		// a land layout chosen on purpose (Coastal, Continental, Mediterranean, Highland) puts content Islands back to Normal (K, 2026-10-05:
		// "setting the water layout to anything but islands should take water content back to normal"); Lakes (0, the old default) and
		// Template do not count as a choice
		if (v >= 1 && v <= 4 && biomes.waterContent !== undefined && Math.round(biomes.waterContent) === 2) biomes.waterContent = 1;
	}
	if (biomes.waterContent === undefined) return;
	let w = Math.round(biomes.waterContent);
	if (w < 0) {
		w = roll.pick([0, 1, 2]);
		roll.rolled.push(`water ${['none', 'normal', 'islands'][w]}`);
	}
	biomes.waterContentMode = w;  // what the buttons said (0 None, 1 Normal, 2 Islands): template maps make their water the engine's way from it
	if (w === 0) { biomes.waterCoverage = 0; return; }
	if (w === 2) biomes.waterShape = islandsShape;
	if (!(biomes.waterCoverage > 0)) biomes.waterCoverage = defaultCoverage;
}

/** Monster strength RANDOM_STRENGTH: stock rolls among weak, normal and strong. */
function applyMonsterStrength(biomes, roll) {
	if (!(biomes.monsterStrength <= RANDOM_STRENGTH)) return;
	biomes.monsterStrength = roll.pick([-1, 0, 1]);
	roll.rolled.push(`monster strength ${['weak', 'normal', 'strong'][biomes.monsterStrength + 1]}`);
}

/**
 * The road type from stock's three toggles (roadDirt, roadGravel,
 * roadCobblestone; one never set counts as on, stock's default): the best type
 * left on, as the engine's RoadPlacer falls back from cobblestone, or 'none'.
 * undefined when none of the three was given, so the Road type lever decides.
 */
function roadFromToggles(biomes) {
	const on = ['roadDirt', 'roadGravel', 'roadCobblestone'].map(k => biomes[k]);
	if (on.every(v => v === undefined)) return undefined;
	for (let i = 2; i >= 0; i--) if (on[i] === undefined || on[i] >= 0.5) return ROAD_CODES[i];
	return 'none';
}

/** Whether --template asks for stock's "(Random)" template. */
const isRandomTemplate = name => /^\(?random\)?$/i.test(String(name || ''));

/** One of the templates fits(name) takes, rolled, or undefined (free layout). */
function randomTemplate(names, fits, roll) {
	const ok = names.filter(name => {
		try {
			return fits(name);
		} catch (e) {
			return false;
		}
	});
	const name = ok.length ? roll.pick(ok) : undefined;
	roll.rolled.push(name ? `template ${name} (of ${ok.length} that take this map)` : 'no template takes this map: free layout');
	return name;
}

/**
 * The underground-starts control (K, 2026-10-03: "all overworld, all underground, mixed, and random", then "maybe 5: with the
 * addition being Template preference"): 0 All Overworld, 1 Mixed (the game's split: a start whose picked town is native
 * to the surface stays up, Dungeon goes down, a random town lands on either level), 2 All Underground, 3 Random (each seed
 * picks one of those three), 4 Template preference (the template's own start-level rule: a start zone it forces to a
 * level keeps it, otherwise All Overworld; with no template, the open template's preference, which is Random). The
 * default is 4. A value this build does not know (the retired Automatic, -1) reads as All Overworld. A map with one level
 * has no underground, so every start is on the surface whatever is chosen.
 * Returns {mode: 0|1|2 as assignLevels takes it, label, note: a log line when the choice could not be kept, or null}.
 */
function resolveUndergroundStarts(value, { seed = 1, hasTemplate = false, templateForcesStarts = false, levels = 2 } = {}) {
	const NAMES = ['All Overworld', 'Mixed', 'All Underground'];
	let v = Number(value);
	if (value === undefined || value === null || value === '' || !Number.isFinite(v)) v = 4;
	v = Math.round(v);
	if (v < 0 || v > 4) v = 0;
	let how = '';
	if (v === 4) {
		how = 'template preference';
		if (hasTemplate) { v = templateForcesStarts ? 1 : 0; how += templateForcesStarts ? ' (the template forces some starts to a level)' : ' (the template has no start-level rule)'; }
		else { v = 3; how += ' (open template: random)'; }
	}
	if (v === 3) {
		v = (Math.imul((seed || 1) >>> 0, 2654435761) >>> 13) % 3;
		how = how || 'random';
	}
	if (levels < 2) {
		const kept = v === 0;
		return { mode: 0, label: NAMES[0], note: kept ? null : `underground starts: the map has one level, so every start is on the surface (${NAMES[v]} was chosen)` };
	}
	return { mode: v, label: NAMES[v], note: how ? `underground starts: ${NAMES[v]}, from ${how}` : null };
}

/**
 * The map-size row's Random (K, 2026-10-04: "we need a random map size button"): --w random (or -1, the value the tab stores) picks
 * one of the sizes the row offers, S 36 to G 252 cells a side, square, from the seed and reports it. The row's sizes below what
 * the players need are left out (a baseline for K to correct: up to 2 players 36, up to 4 players 72, up to 6 players 108, more 144);
 * the template accommodates whatever is picked, as for any size. VMAPGEN_RANDOM_SIZES=36,72,... changes the offered list.
 */
const SIZE_ROW = [36, 72, 108, 144, 180, 216, 252];
function isRandomSize(v) {
	return v !== undefined && /^(random|-1|0)$/i.test(String(v).trim());
}
function randomSize(players, roll) {
	const row = process.env.VMAPGEN_RANDOM_SIZES ? process.env.VMAPGEN_RANDOM_SIZES.split(',').map(Number).filter(n => n > 0) : SIZE_ROW;
	const floor = players <= 2 ? 36 : players <= 4 ? 72 : players <= 6 ? 108 : 144;
	const ok = row.filter(n => n >= floor);
	const size = roll.pick(ok.length ? ok : row);
	roll.rolled.push(`size ${size}x${size} (of ${ok.length || row.length} that take ${players} players)`);
	return size;
}

module.exports = { isRandomSize, randomSize, resolveUndergroundStarts, roller, rangeTakes, playerCounts, applyWaterContent, applyMonsterStrength, roadFromToggles,
	isRandomTemplate, randomTemplate, ROAD_CODES, RANDOM, RANDOM_STRENGTH };
