'use strict';
/**
 * portalends.js - Guards at portals Off means no monster in front of any portal end (K, 2026-10-05: "with that setting off i got
 * guards in front of portals"; 59 of 60 monolith ends on a k1005c map had a monster within a tile, nearly all of them the template
 * link's own guard carried through Guards at bottlenecks). Run after every pass that places a monster: a monster whose tile or whose
 * ring touches a monolith's visiting tile or the tiles round it goes, whatever placed it (link guard, pile guard, dear-loot guard,
 * the engine's own rule); a pile whose guard stood there is left unguarded. Returns { removed }.
 */
const MON = /^(monster|randomMonster)/;

function clearPortalEnds(plan, W, H, l, blocked, d) {
	const { OCCUPIED, blockingCells, visitableCells, allowedDirs } = d;
	const out = { removed: 0 };
	const zone = new Set();
	for (const o of plan.objects) {
		if ((o.l || 0) !== l || !o.template || !/^monolith/.test(o.type)) continue;
		// the visiting tile and the tiles it is entered from, and the ring round those (the reach mapsight reads as "in front of")
		const ends = [];
		for (const [vx, vy] of visitableCells(o.template, o.x, o.y)) { ends.push([vx, vy]); for (const [dx, dy] of allowedDirs(o.template)) ends.push([vx + dx, vy + dy]); }
		for (const [ex, ey] of ends)
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				const x = ex + dx, y = ey + dy;
				if (x >= 0 && y >= 0 && x < W && y < H) zone.add(y * W + x);
			}
	}
	if (!zone.size) return out;
	const keep = [];
	for (const o of plan.objects) {
		if ((o.l || 0) === l && MON.test(o.type) && o.template && o.template.mask) {
			// the tiles it blocks go free with it; its own tile is in the test either way, and is freed alone only when it blocks nothing
			const own = new Set(blockingCells(o.template, o.x, o.y).map(([a, b]) => b * W + a));
			const anchor = o.y * W + o.x;
			if (zone.has(anchor) || [...own].some(c => zone.has(c))) {
				for (const c of own.size ? own : [anchor]) blocked[l * W * H + c] &= ~OCCUPIED;
				out.removed++;
				continue;
			}
		}
		keep.push(o);
	}
	plan.objects.length = 0;
	plan.objects.push(...keep);
	return out;
}

/**
 * The monsters of a finished object list that stand in front of a portal end (the same ring as clearPortalEnds), for the passes that run after planMap: displacePickups
 * moves a pile with its guard, and one such stack came to stand beside a monolith with Guards at portals Off (Coldshadow 72x72 four players seed 2, the portal-guards test,
 * red on v0.3.36 too; plans[0].objects had no stack there at the end of planMap). Returns the Set of monsters to take off; the caller removes them from every list.
 */
function monstersInPortalZone(objects, W, H, d) {
	const { blockingCells, visitableCells, allowedDirs } = d;
	const zone = new Map();
	for (const o of objects) {
		if (!o.template || !/^monolith/.test(o.type)) continue;
		const l = o.l || 0, z = zone.get(l) || new Set();
		zone.set(l, z);
		const ends = [];
		for (const [vx, vy] of visitableCells(o.template, o.x, o.y)) { ends.push([vx, vy]); for (const [dx, dy] of allowedDirs(o.template)) ends.push([vx + dx, vy + dy]); }
		for (const [ex, ey] of ends)
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				const x = ex + dx, y = ey + dy;
				if (x >= 0 && y >= 0 && x < W && y < H) z.add(y * W + x);
			}
	}
	const drop = new Set();
	for (const o of objects) {
		const z = zone.get(o.l || 0);
		if (!z || !MON.test(o.type) || !o.template || !o.template.mask) continue;
		if (z.has(o.y * W + o.x) || blockingCells(o.template, o.x, o.y).some(([a, b]) => z.has(b * W + a))) drop.add(o);
	}
	return drop;
}

module.exports = { clearPortalEnds, monstersInPortalZone };
