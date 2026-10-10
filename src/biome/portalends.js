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
			const cells = blockingCells(o.template, o.x, o.y).map(([a, b]) => b * W + a);
			cells.push(o.y * W + o.x);
			if (cells.some(c => zone.has(c))) {
				for (const c of cells) if (c !== o.y * W + o.x || cells.length === 1) blocked[l * W * H + c] &= ~OCCUPIED;
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

module.exports = { clearPortalEnds };
