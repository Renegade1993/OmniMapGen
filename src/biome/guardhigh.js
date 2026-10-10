'use strict';
/**
 * guardhigh.js - a guard on every high-class pile a hero can take without a fight (K, 2026-10-04: "a shitload of loot out in the
 * open without guards being appropriately backed ... to protect their loot"; mapsight diff: high loot behind a guard 13 to 17% of
 * ours against the engine's 89 to 91%). A relic, a major artifact, a Pandora's box or a placed artifact with no monster within two
 * tiles and an approach tile open gets one monster on an approach tile: the tile whose sprite shadow misses the pile if there is one,
 * then the one with the fewest open neighbours (the narrowest way in), never a tile that cuts the open ground in two, a road,
 * a reserved or approach tile, or a tile outside the pile's zone. The tier follows the kind (relic 6, major 5, box 5, artifact 5).
 * Plain generator behaviour, no switch (K, 2026-10-04: "i don't even know or think that we would want a button or switch for that"). Returns { guarded, left, open }, where
 * open counts the piles that were open and unguarded before.
 */
const HIGH = /^(randomArtifactRelic|randomArtifactMajor|pandoraBox|artifact)$/;
const TIER = { randomArtifactRelic: 6, randomArtifactMajor: 5, pandoraBox: 5, artifact: 5 };
// what Treasure guard pull above 1x adds: cheaper piles, each with chance (pull - 1) / 3, a guard of the tier beside it
const EXTRA = /^(randomArtifactMinor|randomArtifactTreasure|treasureChest|spellScroll)$/;
const EXTRA_TIER = { randomArtifactMinor: 4, randomArtifactTreasure: 3, treasureChest: 2, spellScroll: 3 };
const MON = /^(monster|randomMonster)/;
const D8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

function guardHigh(plan, W, H, l, blocked, d) {
	const out = { guarded: 0, left: 0, open: 0 };
	// Guards on treasure Off leaves every pile open; Treasure guard pull scales the rest (below 1x each pile keeps its guard with that
	// chance, above 1x the cheaper piles join). Both were ignored here, so the settings left relics and majors guarded (A72 seed 1:
	// majors 0.41 and relics 0.37 guarded with Guards on treasure Off, 0.43 and 0.18 at pull 0).
	const P = plan.p || {}, treasureOn = !(Number(P.guardTreasure) === 0);
	if (!treasureOn) return out;
	const pull = Number.isFinite(P.lootGuardWeight) ? P.lootGuardWeight : 1;
	const extraChance = pull > 1 ? Math.min(1, (pull - 1) / 3) : 0;
	const { OCCUPIED, RESERVED, APPROACH, blockingCells, visitableCells, allowedDirs, footprintFits, footprintBlock, markApproach,
		objectEntry, monsterTpl, monsterOptions, rng } = d;
	const base = l * W * H, zone = plan.zone, om = plan.openMask, water = plan.p && plan.p.water, road = plan.roadCells;
	const mons = plan.objects.filter(o => (o.l || 0) === l && MON.test(o.type));
	const near = (x, y, r) => mons.some(m => Math.max(Math.abs(m.x - x), Math.abs(m.y - y)) <= r);
	const floor = c => !(water && water[c]) && (!om || om[c]);
	const free = c => floor(c) && !(blocked[base + c] & OCCUPIED);
	const nb = c => { const x = c % W, y = (c / W) | 0, r = []; for (const [dx, dy] of D8) { const u = x + dx, v = y + dy; if (u >= 0 && v >= 0 && u < W && v < H) r.push(v * W + u); } return r; };
	// closing t leaves the open ground beside it in one piece
	const cuts = t => {
		const around = nb(t).filter(free);
		if (around.length < 2) return false;
		const want = new Set(around.slice(1)), seen = new Set([t, around[0]]), q = [around[0]];
		for (let h = 0; h < q.length && want.size; h++)
			for (const m of nb(q[h])) if (!seen.has(m) && free(m)) { seen.add(m); want.delete(m); q.push(m); }
		return want.size > 0;
	};
	// the zone's open ground: the largest 8-connected piece of free tiles outside every monster's ring (mapsight's regions), so a
	// pile in a pocket another guard seals is not counted as open
	const ring = new Set();
	for (const m of mons) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) ring.add((m.y + dy) * W + m.x + dx);
	const lab = new Int32Array(W * H).fill(-1), size = [];
	for (let c0 = 0; c0 < W * H; c0++) {
		if (lab[c0] >= 0 || !free(c0) || ring.has(c0)) continue;
		const k = size.length, q = [c0];
		lab[c0] = k;
		for (let h = 0; h < q.length; h++) for (const m of nb(q[h])) if (lab[m] < 0 && free(m) && !ring.has(m)) { lab[m] = k; q.push(m); }
		size.push(q.length);
	}
	const mainOf = new Map();
	for (let c = 0; c < W * H; c++) if (lab[c] >= 0 && zone) { const z = zone[c]; if (!mainOf.has(z) || size[lab[c]] > size[mainOf.get(z)]) mainOf.set(z, lab[c]); }
	const isOpen = (p, approach) => approach.some(c => free(c) && lab[c] >= 0 && lab[c] === mainOf.get(zone ? zone[p.y * W + p.x] : 0));
	const piles = plan.objects.filter(o => (o.l || 0) === l && o.template && o.template.mask && (HIGH.test(o.type) || (extraChance > 0 && EXTRA.test(o.type))));
	for (const p of piles) {
		if (near(p.x, p.y, 2)) continue;
		if (pull < 1 && rng() >= pull) continue;
		if (!HIGH.test(p.type) && rng() >= extraChance) continue;
		const approach = [];
		for (const [vx, vy] of visitableCells(p.template, p.x, p.y))
			for (const [dx, dy] of allowedDirs(p.template)) {
				const x = vx + dx, y = vy + dy;
				if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
				const c = y * W + x;
				if (!approach.includes(c)) approach.push(c);
			}
		if (!approach.some(free) || (zone && !isOpen(p, approach))) continue;   // sealed already, or in a pocket another guard closes
		out.open++;
		const own = new Set(blockingCells(p.template, p.x, p.y).map(([a, b]) => b * W + a));
		const clips = c => { const x = c % W, y = (c / W) | 0; return [[0, 0], [-1, 0], [0, -1], [-1, -1]].some(([dx, dy]) => own.has((y + dy) * W + x + dx)); };
		// the pile's own approach tiles carry the APPROACH mark its landing left, so only RESERVED (doors, roads) is refused
		const why = out.why || (out.why = {});
		const bump = k => { why[k] = (why[k] || 0) + 1; return false; };
		const cands = approach.filter(c => (free(c) || bump('taken'))
			&& (!(blocked[base + c] & RESERVED) || bump('reserved')) && (!(road && road.has(c)) || bump('road'))
			&& (!zone || zone[c] === zone[p.y * W + p.x] || bump('zone')) && !own.has(c)
			&& (footprintFits(monsterTpl, c % W, (c / W) | 0, l, W, H, blocked, true) || bump('fit')) && (!cuts(c) || bump('cuts')))
			.sort((a, b) => (clips(a) - clips(b)) || (nb(a).filter(free).length - nb(b).filter(free).length));
		// not within 2 of another stack (the guard spacing of 2026-10-08): a pile with only such tiles is left to guardDearLoot and the approach
		// closing, which move it into a guard's ring
		const c = cands.find(k => !near(k % W, (k / W) | 0, 2));
		if (c === undefined) { if (cands.length) bump('crowded'); out.left++; continue; }
		const x = c % W, y = (c / W) | 0;
		const tier = TIER[p.type] || EXTRA_TIER[p.type] || 5;
		const e = objectEntry(`randomMonsterLevel${tier}`, x, y, l, monsterTpl, 'object', monsterOptions(tier, plan.p, rng));
		// a map whose guards are written as creatures (a template's) gets one here too: the nearest such guard lends its creature, level and amount
		// (a placeholder left here failed guard-creatures.test.js, 2026-10-08)
		{
			let best = null, bd = Infinity;
			for (const m of plan.objects) {
				if ((m.l || 0) !== l || !m.guardCreature || !/^randomMonsterLevel/.test(m.type)) continue;
				const d = Math.max(Math.abs(m.x - (x)), Math.abs(m.y - (y)));
				if (d < bd) { bd = d; best = m; }
			}
			if (best) { e.type = best.type; e.instanceName = `${best.type}_${e.x}_${e.y}_${l}`; e.options = { ...best.options }; e.guardCreature = best.guardCreature; }
		}
		plan.objects.push(e);
		mons.push(e);
		footprintBlock(monsterTpl, x, y, l, W, H, blocked);
		markApproach(monsterTpl, x, y, l, W, H, blocked);
		out.guarded++;
	}
	return out;
}

module.exports = { guardHigh };
