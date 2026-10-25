/**
 * colorStarts.js - which player colour starts in which start (K, 2026-10-18: "We should always randomize per-color start positions").
 *
 * The generator hands start k (a corner of the map, a template's k-th start zone) to the k-th player of the list it is given, so
 * with the players listed in colour order red always started in the first start, blue in the second, and so on. This shuffles the
 * colours over the starts, from the map's seed, on every map and every template; it is not a switch.
 *
 * What stays as it was:
 *  - the starts themselves (their cells, their zones, their order): only the colour that stands on each changes;
 *  - the observer, who is sealed in a chamber of its own, keeps its place in the list and takes no part;
 *  - teams: the colours of one team keep sharing one set of starts, the set they shared before the shuffle, so whatever
 *    neighbourhood the allies had (the CLI gives teams by colour order, which puts allies on one side of the map) is still theirs.
 *    Teams of the same size trade their sets of starts; inside a set the team's colours are shuffled. A colour in no team is a
 *    team of one and trades with the other teams of one.
 * The list is returned in start order (entry k is the colour that takes start k); a seat, a faction pick or a hero pick belongs to a
 * colour, so the caller attaches it to the colour it finds there.
 */
'use strict';

/** mulberry32 over a 32-bit seed. */
function rng(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6D2B79F5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function shuffle(a, next) {
	const b = a.slice();
	for (let i = b.length - 1; i > 0; i--) {
		const j = Math.floor(next() * (i + 1));
		[b[i], b[j]] = [b[j], b[i]];
	}
	return b;
}

/** A seed for this shuffle alone, so rolling it moves no other roll of the map. */
function startsSeed(seed, tag) {
	let h = 2166136261 >>> 0;
	for (const ch of `${seed}|${tag || 'color-starts'}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
	return h;
}

/**
 * colors: the map's colours in start order (red first in the CLI's order). observerColor: a colour kept in place, or null.
 * teams: [[colour, ...], ...] or undefined. seed: the map's seed. Returns the colours in start order after the shuffle.
 */
function colorsToStarts(colors, observerColor, teams, seed) {
	const slots = colors.map((c, i) => i).filter(i => colors[i] !== observerColor);
	if (slots.length < 2) return colors.slice();
	const next = rng(startsSeed(seed));
	const slotOf = new Map(slots.map(i => [colors[i], i]));
	const units = [];
	const seen = new Set();
	for (const t of teams || []) {
		const members = t.filter(c => slotOf.has(c) && !seen.has(c));
		if (!members.length) continue;
		members.forEach(c => seen.add(c));
		units.push({ colors: members, slots: members.map(c => slotOf.get(c)).sort((a, b) => a - b) });
	}
	for (const i of slots) if (!seen.has(colors[i])) units.push({ colors: [colors[i]], slots: [i] });
	// units of one size trade their sets of starts
	const placed = units.map(() => null);
	const sizes = [...new Set(units.map(u => u.colors.length))];
	for (const size of sizes) {
		const idx = units.map((u, k) => k).filter(k => units[k].colors.length === size);
		const sets = shuffle(idx.map(k => units[k].slots), next);
		idx.forEach((k, n) => { placed[k] = sets[n]; });
	}
	const out = colors.slice();
	units.forEach((u, k) => {
		const mine = shuffle(u.colors, next);
		placed[k].forEach((slot, n) => { out[slot] = mine[n]; });
	});
	return out;
}

/**
 * Humans on the starts made for them (the Reviewer's point 1, 2026-10-18). A template can name a start zone for a computer player (cpuStart:
 * weak monsters, a smaller treasure table) and one for a person (playerStart); the shuffle above ignores that, so a lone human could land in a
 * computer's zone. When the seats are known (players[i].canPlay: 'AIOnly' is a computer's, anything else a person's, which the lobby's humanColors
 * gives), a human standing on a cpuStart start trades colours with a computer standing on a playerStart start, in start order, as long as there
 * is such a pair. A trade is made only inside a team, or anywhere when there are no teams, so a team keeps the starts it shared. The observer
 * takes no part. typeOfStart(i) is 'playerStart', 'cpuStart' or undefined for the start list's entry i. What belongs to a colour (the colour,
 * its seat, its faction and hero picks) moves; the start's place (townPos) stays. Returns the pairs traded, [[i, j], ...].
 */
const COLOUR_FIELDS = ['color', 'canPlay', 'factions', 'chosenFaction'];
function seatHumansOnPlayerStarts(players, typeOfStart, teams, observerIndex) {
	const human = p => p && p.canPlay !== undefined && p.canPlay !== 'AIOnly';
	if (!players.some(p => p && p.canPlay !== undefined)) return [];
	const teamOf = c => (teams || []).findIndex(t => t.includes(c));
	const traded = [];
	for (let i = 0; i < players.length; i++) {
		if (i === observerIndex || !human(players[i]) || typeOfStart(i) !== 'cpuStart') continue;
		const j = players.findIndex((q, k) => q && k !== i && k !== observerIndex && !human(q) && typeOfStart(k) === 'playerStart'
			&& (!(teams && teams.length) || teamOf(q.color) === teamOf(players[i].color)));
		if (j < 0) continue;
		for (const f of COLOUR_FIELDS) { const t = players[i][f]; players[i][f] = players[j][f]; players[j][f] = t; }
		traded.push([i, j]);
	}
	return traded;
}

module.exports = { colorsToStarts, startsSeed, seatHumansOnPlayerStarts };
