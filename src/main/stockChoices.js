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
	if (biomes.waterContent === undefined) return;
	let w = Math.round(biomes.waterContent);
	if (w < 0) {
		w = roll.pick([0, 1, 2]);
		roll.rolled.push(`water ${['none', 'normal', 'islands'][w]}`);
	}
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

module.exports = { roller, rangeTakes, playerCounts, applyWaterContent, applyMonsterStrength, roadFromToggles,
	isRandomTemplate, randomTemplate, ROAD_CODES, RANDOM, RANDOM_STRENGTH };
