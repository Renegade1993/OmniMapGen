/**
 * rivernet.js - run a few watercourses across a level.
 *
 * Rivers were never generated at all. Measured over 26 installed VCMI random
 * maps, 25 of 26 have them and they cover 1.8% of the surface, so a map with
 * none reads as flat in a way that is hard to name and easy to notice.
 *
 * A river does not block movement and does not change its cost, so unlike a
 * road it can run anywhere, including under objects. That makes the planning
 * simple: start on one edge, wander toward the far side, stop at the other
 * edge or when it meets water already laid. The wander is what stops a river
 * looking like a ruler.
 *
 * The river TYPE is the one the ground declares. terrains.json gives each
 * terrain a `river`, so dirt and sand run mud, snow runs ice, lava runs lava
 * and everything else runs water, which is why a real map's rivers change
 * colour as they cross a biome boundary.
 */
'use strict';

/**
 * Cells for one river, four-connected so the art reads as a continuous run.
 * `budget` caps how much water this river may add, so a single wander cannot
 * blow the map's whole allowance: the first version checked the total only
 * between rivers and a 36x36 asked for 23 tiles and got 68.
 */
function traceRiver(W, H, rng, cells, budget = Infinity) {
	const horizontal = rng() < 0.5;
	// start on one edge, aim for the opposite
	const forward = rng() < 0.5;
	let x, y, dx, dy;
	if (horizontal) {
		x = forward ? 0 : W - 1;
		y = 2 + ((rng() * (H - 4)) | 0);
		dx = forward ? 1 : -1; dy = 0;
	} else {
		x = 2 + ((rng() * (W - 4)) | 0);
		y = forward ? 0 : H - 1;
		dx = 0; dy = forward ? 1 : -1;
	}

	const added = [];
	const limit = Math.min((W + H) * 2, budget);  // a wander cannot run forever
	for (let step = 0; step < limit; step++) {
		if (x < 0 || y < 0 || x >= W || y >= H) break;
		const cell = y * W + x;
		if (cells.has(cell) && added.length) break;   // joined an existing run
		cells.add(cell);
		added.push(cell);
		// advance, with a sideways wobble about a third of the time
		if (rng() < 0.34) {
			if (horizontal) y += rng() < 0.5 ? 1 : -1;
			else x += rng() < 0.5 ? 1 : -1;
		} else {
			x += dx; y += dy;
		}
	}
	return added;
}

/**
 * Lay rivers over a level until roughly `share` of it carries water.
 * Returns the set of river cells.
 */
function buildRiverNetwork(W, H, rng, share = 0.018) {
	const cells = new Set();
	const target = Math.round(W * H * share);
	if (target < 4) return cells;
	// A river wants to be long enough to read as one, so aim for a span and a
	// half each and let the total decide how many there are: one on a small
	// map, three or four on a large one.
	const each = Math.max(8, Math.round((W + H) * 0.75));
	for (let tries = 0; tries < 12 && cells.size < target; tries++)
		traceRiver(W, H, rng, cells, Math.min(each, target - cells.size + 2));
	return cells;
}

module.exports = { buildRiverNetwork, traceRiver };
