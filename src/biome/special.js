'use strict';
/**
 * Special buildings (S350, K 2026-11-19: "Special buildings (slider on the Treasure page)", after the S343 census of the originals): the trading posts,
 * universities, sanctuaries, hill forts, cartographers, signs and one-way monolith pairs the original scenarios have and the generator never wrote.
 *
 * Each kind is drawn per fill (one biome) at the originals' rate per 1,000 ground tiles, times the player's "Special buildings" slider (1x is the
 * originals' own rate, 0 none), and placed as a landmark with the fill's own machinery (content.js: put, the terrain art table, the owed-to-the-next-biome
 * debt). Rates are the pooled counts over the 127 original scenarios (TemplateFactory\census, S350; Arrogance and the Allied copies left out) divided by
 * their ground tiles, one for the overworld and one for the underground, so a map of any size and levels gets the originals' density.
 * The guards are the fill's own guard pass (GUARD_CHANCE in content.js: the share of each kind the originals stand a monster beside); a one-way
 * monolith end follows the Guards at portals lever like every other monolith end.
 *
 * Classic only: a template zone (zoneMeta) is left to its own rules. VMAPGEN_SPECIAL_BUILDINGS=0 writes none (the proof arm).
 */

// per 1,000 ground tiles: [overworld, underground]; oneWay is pairs a map (the mean of the entrance and exit counts, which differ by the odd unpaired one)
const RATES = {
	tradingPost: [0.235, 0.189],
	university: [0.118, 0.173],
	sanctuary: [0.115, 0.123],
	hillFort: [0.146, 0.173],
	cartographer: [0.031, 0.099],
	sign: [0.319, 0.436],
	oneWay: [0.150, 0.263],
};
// the object types and subtypes of the core config; their art is the one the original scenarios stand most often (terrainArt.js artsOf), changed to the
// art real maps put on the zone's ground when put() places it
const CLASSES = {
	tradingPost: { type: 'tradingPostDUPLICATE' },      // the trading post of every ground but snow
	tradingPostSnow: { type: 'tradingPost' },
	university: { type: 'university' },
	sanctuary: { type: 'sanctuary' },
	hillFort: { type: 'hillFort' },
	cartographerLand: { type: 'cartographer', subtype: 'cartographerLand', rewardable: true },
	cartographerSub: { type: 'cartographer', subtype: 'cartographerSubterranean', rewardable: true },
	sign: { type: 'sign' },
};
const baseTpl = (type, subtype) => {
	const a = artsOf(type, subtype);
	return a && a.length ? { animation: a[0].anim, mask: a[0].mask, visitableFrom: a[0].visitableFrom } : null;
};
// the one-way monolith colours the originals use, by the maps that have each (census: monolith1 to monolith8)
const ONE_WAY_COLOURS = [27, 30, 18, 3, 10, 7, 4, 4];

const { artsOf } = require('./terrainArt');
// the share of the originals that have each kind at all (127 scenarios, S350): the originals bunch their buildings on some maps and have none on others, so a map has a kind or
// not, drawn from its seed, and the rate above is spread over the maps that have it (rate / share), which keeps the rate per 1,000 ground tiles and the share of maps both at the originals'
const SHARE = { tradingPost: 0.62, university: 0.43, sanctuary: 0.42, hillFort: 0.44, cartographerLand: 0.13, cartographerSub: 0.08, sign: 0.42, oneWay: 0.36 };
/** A map's yes or no for one kind, from its seed alone (a hash, so the fill's own stream is not moved and every biome and level of the map agrees). */
function hasKind(seed, key) {
	let h = Math.imul((Number(seed) | 0) + 1, 2654435761);
	for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
	h = Math.imul(h ^ (h >>> 16), 2246822507) >>> 0;
	h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
	return (((h ^ (h >>> 16)) >>> 0) / 4294967296) < SHARE[key];
}
const enabled = () => process.env.VMAPGEN_SPECIAL_BUILDINGS !== '0';

// The four states of the Special buildings control (S388, K: "Template, Random, Off and On/Forced ... the player can leave it to the template, make it completely random, have it off
// always, or have it on always", with the amount slider as Water content has Amount of water). specialMode: 0 Template, 1 Random, 2 Off, 3 On.
const MODE_NAMES = ['Template', 'Random', 'Off', 'On'];
/** Whether a fill may draw special buildings: any open-layout biome (no zoneMeta), and on a named template only a neutral zone when the mode forces them (never a start zone). */
function zoneAllows(zoneMeta, force) {
	if (!zoneMeta) return true;
	if (!force) return false;
	return !/^(playerStart|cpuStart)$/.test(String((zoneMeta.spec && zoneMeta.spec.type) || '')) && !zoneMeta.ownerColor;
}
const unit = (seed, tag) => {   // a number in [0, 1) from the seed and a tag, its own hash so no stream of the map moves
	let h = Math.imul((Number(seed) | 0) + 7, 2654435761);
	for (let i = 0; i < tag.length; i++) h = Math.imul(h ^ tag.charCodeAt(i), 16777619);
	h = Math.imul(h ^ (h >>> 16), 2246822507) >>> 0;
	h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
	return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
/**
 * What the mode and the amount make of a map: { amount, force, mode }. amount is the slider's number when the player set one (0 to 3x), else undefined; lean is Classic's
 * draw for the map (classicFeel.specialLean) or undefined; template is true on a named template.
 *   Off       none, on every layout, whatever the amount says.
 *   On        the amount (1x when it was never moved), on every layout: on a named template in its neutral zones (force).
 *   Random    from the seed: none on 3 maps in 10, else the amount (an amount drawn from 0.5x to 2.0x in steps of 0.1 when it was never moved), on every layout.
 *   Template  an amount set by hand counts as On at that amount; else Classic draws the count from its feel, and a named template has none (Coldshadow's Fantasy and Jebus
 *             Cross have none of their own).
 */
function resolveMode({ mode, amount, template, lean, seed }) {
	const m = Number.isFinite(Number(mode)) ? Math.max(0, Math.min(3, Math.round(Number(mode)))) : 0;
	const set = Number.isFinite(Number(amount)) && Number(amount) >= 0 ? Math.round(Number(amount) * 100) / 100 : undefined;
	if (m === 2) return { amount: 0, force: false, mode: m };
	if (m === 3) return { amount: set !== undefined ? set : 1, force: true, mode: m };
	if (m === 1) {
		if (unit(seed, 'specialRandomOn') < 0.3) return { amount: 0, force: false, mode: m };
		return { amount: set !== undefined ? set : Math.round((0.5 + Math.floor(unit(seed, 'specialRandomAmount') * 16) / 10) * 10) / 10, force: true, mode: m };
	}
	if (set !== undefined) return { amount: set, force: true, mode: m };
	if (template) return { amount: 0, force: false, mode: m };
	return { amount: lean !== undefined ? lean : 1, force: false, mode: m };
}

/**
 * The landmarks one fill adds, as the fill's landmark list takes them: { type, subtype, tpl, special: true } and, for a one-way pair,
 * { oneWay: true, type, subtype, tpl, exit: { type, subtype, tpl } }.
 * rare(rate): the fill's stochastic count for a rate per 1,000 usable cells; lever: the Special buildings slider; underground: the level is a cave level
 * (not a mirrored one); terrain: the zone's ground by lowercase name; rng: the fill's stream.
 */
function draw({ rare, rng, lever, underground, terrain, seed, guardP }) {
	if (!enabled() || !(lever > 0)) return [];
	const out = [];
	const lvl = underground ? 1 : 0;
	const mk = (c, n) => {
		const tpl = baseTpl(c.type, c.subtype || 'object');
		if (!tpl) return;
		// guardP(type): the chance this kind stands a guard of its own; the ask is drawn here so the fill holds the guard's tile when it places the building
		for (let i = 0; i < n; i++) out.push({ type: c.type, subtype: c.subtype || 'object', tpl, special: true, ...(c.rewardable ? { rewardable: true } : {}),
			...(guardP && GUARD_SHARE[c.type] !== undefined && rng() < guardP(c.type) ? { guardAsk: true } : {}) });
	};
	// the count of one kind in this fill: none when the map does not have the kind, else the rate over the maps that do
	const count = (key, rate) => (hasKind(seed, key) ? rare(rate * lever / SHARE[key]) : 0);
	mk(terrain === 'snow' ? CLASSES.tradingPostSnow : CLASSES.tradingPost, count('tradingPost', RATES.tradingPost[lvl]));
	mk(CLASSES.university, count('university', RATES.university[lvl]));
	mk(CLASSES.sanctuary, count('sanctuary', RATES.sanctuary[lvl]));
	mk(CLASSES.hillFort, count('hillFort', RATES.hillFort[lvl]));
	mk(underground ? CLASSES.cartographerSub : CLASSES.cartographerLand, underground ? count('cartographerSub', RATES.cartographer[1]) : count('cartographerLand', RATES.cartographer[0]));
	mk(CLASSES.sign, count('sign', RATES.sign[lvl]));
	for (let n = count('oneWay', RATES.oneWay[lvl]); n > 0; n--) {
		const k = pickColour(rng), sub = 'monolith' + (k + 1), ent = baseTpl('monolithOneWayEntrance', sub), ex = baseTpl('monolithOneWayExit', sub);
		if (!ent || !ex) continue;
		out.push({ oneWay: true, type: 'monolithOneWayEntrance', subtype: sub, tpl: ent, exit: { type: 'monolithOneWayExit', subtype: sub, tpl: ex } });
	}
	return out;
}

function pickColour(rng) {
	const total = ONE_WAY_COLOURS.reduce((a, b) => a + b, 0);
	let roll = rng() * total;
	for (let i = 0; i < ONE_WAY_COLOURS.length; i++) { roll -= ONE_WAY_COLOURS[i]; if (roll <= 0) return i; }
	return 0;
}

// the chance each kind draws a guard of its own, as the top-up to the share the originals stand a monster beside (census S350: hill fort .58, university .53, cartographer
// .52, trading post .25, sanctuary .25). Stacks stand beside a special building anyway (80 Classic maps with no own guard, slider 1: hill fort 31.3 percent, university 9.2,
// cartographer 17.2, trading post 27.2, sanctuary 22.8), so the own draw asks (target - beside) / (1 - beside), over the .88 of asks that find a tile: .44, .55, .48, none for
// the trading post (already over) and .03 for the sanctuary. Used by content.js GUARD_CHANCE and the guard ask drawn with each building.
// S350 (the ring ruler, the lead 11-21: a stack on the door tile or one of its eight neighbours is what a hero meets): beside by the ring with no own guard (48 Classic maps): hill fort 12.7, university 5.8, cartographer 4.9, trading post 11.1, sanctuary 6.8 percent; the originals by the ring: 50.8, 51.5, 52.9, 17.6, 15.1; own ask (target - beside) / ((1 - beside) x .88 that find a tile): .50, .55, .57, .08, .10.
const GUARD_SHARE = { hillFort: 0.50, university: 0.55, cartographer: 0.57, tradingPost: 0.08, tradingPostDUPLICATE: 0.08, sanctuary: 0.10 };

module.exports = { draw, enabled, hasKind, resolveMode, zoneAllows, MODE_NAMES, RATES, SHARE, GUARD_SHARE, CLASSES };
