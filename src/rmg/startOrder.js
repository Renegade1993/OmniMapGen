/**
 * startOrder.js - which start cell each of a template's start zones gets.
 *
 * The CLI pins starts to fixed cells in player order (corners first: top left,
 * bottom right, bottom left, top right), which keeps two players on opposite
 * corners. A template's links assume their own arrangement. Golem Foundry rings
 * its four starts 1-2-3-4 through quarries, so player 2 has to sit beside
 * player 1, not across the map; pinned in CLI order the quarry between them
 * could not touch both, and 2 to 5 of its 12 links fell back to portal pairs
 * on each of five seeds (2026-09-26). The engine lays start zones out by force
 * with the rest (CZonePlacer), so they land where the links put them.
 *
 * This keeps the same cells and hands them out so that start zones the
 * template puts close together get cells close together: the assignment whose
 * pairwise distances best match the template's link distances between the
 * starts (both scaled to their largest, squared differences summed). A tie
 * keeps the CLI's order, so a template whose starts are all alike (every start
 * one link from a centre) is laid out exactly as before.
 */
'use strict';

/** Link hops between template zones, over every link but repulsive and forced-portal
 * ones, which the engine leaves out of its graph distances (CZonePlacer.cpp:87-89). */
function zoneHops(raw) {
	const adj = new Map();
	const link = (a, b) => {
		if (!adj.has(a)) adj.set(a, new Set());
		adj.get(a).add(b);
	};
	for (const c of raw.connections || []) {
		if (c.type === 'repulsive' || c.type === 'forcePortal') continue;
		const a = parseInt(c.a, 10), b = parseInt(c.b, 10);
		if (Number.isNaN(a) || Number.isNaN(b)) continue;
		link(a, b); link(b, a);
	}
	return from => {
		const d = new Map([[from, 0]]), q = [from];
		for (let qi = 0; qi < q.length; qi++)
			for (const n of adj.get(q[qi]) || [])
				if (!d.has(n)) { d.set(n, d.get(q[qi]) + 1); q.push(n); }
		return d;
	};
}

function* permutations(n) {
	const a = [...Array(n).keys()], c = new Array(n).fill(0);
	yield a.slice();
	for (let i = 0; i < n;) {
		if (c[i] < i) {
			const j = i % 2 ? c[i] : 0;
			[a[j], a[i]] = [a[i], a[j]];
			yield a.slice();
			c[i]++; i = 0;
		} else { c[i] = 0; i++; }
	}
}

/**
 * zoneIds[k]: the template zone of start k; cells[k]: the cell the CLI gave it.
 * Returns order, where start k takes cells[order[k]]. Eight starts at most
 * (40320 orders).
 */
function orderStarts(raw, zoneIds, cells) {
	const n = zoneIds.length;
	const identity = [...Array(n).keys()];
	if (n < 3 || n > 8) return identity;
	const hopsFrom = zoneHops(raw);
	const hop = zoneIds.map(a => { const d = hopsFrom(a); return zoneIds.map(b => d.get(b)); });
	const known = hop.flat().filter(v => v !== undefined && v > 0);
	if (!known.length) return identity;
	const far = Math.max(...known) + 1;
	const H = hop.map(r => r.map(v => (v === undefined ? far : v)));
	const hMax = Math.max(...H.flat());
	const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
	let dMax = 0;
	for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) dMax = Math.max(dMax, dist(cells[i], cells[j]));
	if (!dMax || !hMax) return identity;
	const cost = order => {
		let s = 0;
		for (let i = 0; i < n; i++)
			for (let j = i + 1; j < n; j++) {
				const e = H[i][j] / hMax - dist(cells[order[i]], cells[order[j]]) / dMax;
				s += e * e;
			}
		return s;
	};
	let best = identity, bestCost = cost(identity);
	for (const order of permutations(n)) {
		const c = cost(order);
		if (c < bestCost - 1e-9) { best = order; bestCost = c; }
	}
	return best;
}

module.exports = { orderStarts, zoneHops };
