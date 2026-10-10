/**
 * startSpread.js - which of a template's start zones the players get (K, 2026-10-03: "players should spawn as far from each
 * other as possible"; on most maps with two players they spawned on the same side or next to each other).
 *
 * The template numbers its start zones 1..8 (Coldshadow's Fantasy) and the players take owners 1..n, so two players got zones 1
 * and 2, which the template puts side by side. The engine fills the start zones in a random order. Here the zones are laid
 * out free (every zone placed by the layout's forces, starts not pinned), and of the start zones that lie on the surface the
 * n whose positions give the largest least distance between two of them (then the largest mean distance) take the owners 1..n,
 * the others n+1 upward. Only the owner numbers change, in a copy of the template, before the zone plan is built.
 */
'use strict';

function* combinations(items, k, start = 0, chosen = []) {
	if (chosen.length === k) { yield chosen.slice(); return; }
	for (let i = start; i <= items.length - (k - chosen.length); i++) {
		chosen.push(items[i]);
		yield* combinations(items, k, i + 1, chosen);
		chosen.pop();
	}
}

/**
 * positions: Map zone id -> {x, y} for the start zones to choose from, owners: Map zone id -> its owner number.
 * Returns the chosen zone ids (n of them, by owner) or null when there is nothing to choose.
 */
function pickSpread(positions, owners, n) {
	const ids = [...positions.keys()].sort((a, b) => owners.get(a) - owners.get(b));
	if (ids.length <= n) return null;
	let best = null;
	for (const set of combinations(ids, n)) {
		let min = Infinity, sum = 0, k = 0;
		for (let i = 0; i < set.length; i++) for (let j = i + 1; j < set.length; j++) {
			const a = positions.get(set[i]), b = positions.get(set[j]);
			const d = Math.hypot(a.x - b.x, a.y - b.y);
			min = Math.min(min, d); sum += d; k++;
		}
		const mean = k ? sum / k : 0;
		if (!best || min > best.min + 1e-9 || (Math.abs(min - best.min) <= 1e-9 && mean > best.mean + 1e-9)) best = { set, min, mean };
	}
	return best;
}

/** A copy of the template raw with the chosen zones as owners 1..n and the other start zones n+1 upward. */
function permuteOwners(raw, ownersByZone, chosen) {
	const copy = JSON.parse(JSON.stringify(raw));
	const rest = [...ownersByZone.keys()].filter(id => !chosen.includes(id)).sort((a, b) => ownersByZone.get(a) - ownersByZone.get(b));
	const order = [...chosen, ...rest];
	order.forEach((id, k) => { copy.zones[id].owner = k + 1; });
	return copy;
}

module.exports = { pickSpread, permuteOwners, combinations };
