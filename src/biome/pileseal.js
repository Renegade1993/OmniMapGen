'use strict';
/**
 * pileseal.js - a valuable pile a hero can reach without a fight moves into a dead end of its zone, with its guard on the dead
 * end's one open neighbour, so the pile is closed with no new wall. The engine lays a guarded pile only where the tiles round it,
 * the guard's aside, touch no free path, road or other object's way in, and blocks them (TreasurePlacer.cpp, createTreasures);
 * ours lays the loot first and walls it after, and the walls a road, a door or another object's way in needs stay open: on K's
 * 252 eight-player map 199 high piles of the underground stood open with a guard beside them, the engine's maps 3 to 24 (K,
 * 2026-10-04: "a shitload of loot out in the open without guards being appropriately backed by blocker art to protect their
 * loot"). Runs before guardhigh.js, which guards what is left. Plain generator behaviour, no switch.
 *
 * A dead end: a free tile off roads, doors and other objects' ways in, with exactly one free tile among its eight neighbours,
 * that neighbour (the guard's tile) free, in the same zone, on the zone's open ground, off roads and doors, and not the only way
 * between the open tiles round it. The pile never lands under the guard's sprite (the tiles left of, above and up-left of it).
 * The pile's own guard (the nearest monster within two tiles whose ring holds no other object's way in and lies in the pile's
 * zone) moves with it; with none, a new one is posted at the pile's tier. The nearest dead end to the pile wins.
 * Returns { open, moved, left }.
 */
const PILE = /^(randomArtifactRelic|randomArtifactMajor|randomArtifactMinor|pandoraBox|artifact)$/;
const TIER = { randomArtifactRelic: 6, randomArtifactMajor: 5, randomArtifactMinor: 4, pandoraBox: 5, artifact: 5 };
const MON = /^(monster|randomMonster)/;
const D8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

function sealPiles(plan, W, H, l, blocked, d) {
	const out = { open: 0, moved: 0, left: 0 };
	const { OCCUPIED, RESERVED, APPROACH, blockingCells, visitableCells, footprintFits, footprintBlock, markApproach,
		objectEntry, monsterTpl, monsterOptions, rng } = d;
	const base = l * W * H, zone = plan.zone, om = plan.openMask, water = plan.p && plan.p.water, road = plan.roadCells;
	if (!zone) return out;
	const floor = c => !(water && water[c]) && (!om || om[c]);
	const free = c => floor(c) && !(blocked[base + c] & OCCUPIED);
	const nb = c => { const x = c % W, y = (c / W) | 0, r = []; for (const [dx, dy] of D8) { const u = x + dx, v = y + dy; if (u >= 0 && v >= 0 && u < W && v < H) r.push(v * W + u); } return r; };
	const mons = plan.objects.filter(o => (o.l || 0) === l && MON.test(o.type));
	// every object's way in on this level, for the guard-may-move test and the dead-end test
	// tile -> the visitable cells of other objects it is a way in to
	const wayIn = new Map();
	for (const o of plan.objects) {
		if ((o.l || 0) !== l || !o.template || !o.template.mask || MON.test(o.type)) continue;
		for (const [vx, vy] of visitableCells(o.template, o.x, o.y)) {
			const v = vy * W + vx;
			for (const c of nb(v)) { if (!wayIn.has(c)) wayIn.set(c, []); wayIn.get(c).push(v); }
		}
	}
	// the open ground: 8-connected free tiles outside every monster's ring, and each zone's largest piece of it
	let lab, mainOf;
	const label = () => {
		const ring = new Set();
		for (const m of mons) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) ring.add((m.y + dy) * W + m.x + dx);
		lab = new Int32Array(W * H).fill(-1);
		const size = [];
		for (let c0 = 0; c0 < W * H; c0++) {
			if (lab[c0] >= 0 || !free(c0) || ring.has(c0)) continue;
			const k = size.length, q = [c0];
			lab[c0] = k;
			for (let h = 0; h < q.length; h++) for (const m of nb(q[h])) if (lab[m] < 0 && free(m) && !ring.has(m)) { lab[m] = k; q.push(m); }
			size.push(q.length);
		}
		mainOf = new Map();
		for (let c = 0; c < W * H; c++) if (lab[c] >= 0) { const z = zone[c]; if (!mainOf.has(z) || size[lab[c]] > size[mainOf.get(z)]) mainOf.set(z, lab[c]); }
	};
	label();
	const onMain = c => lab[c] >= 0 && lab[c] === mainOf.get(zone[c]);
	// closing t (with `also` closed too) leaves the free tiles round it in one piece
	const cuts = (t, also) => {
		const around = nb(t).filter(c => c !== also && free(c));
		if (around.length < 2) return false;
		const want = new Set(around.slice(1)), seen = new Set([t, also, around[0]]), q = [around[0]];
		for (let h = 0; h < q.length && want.size && h < 4000; h++)
			for (const m of nb(q[h])) if (!seen.has(m) && free(m)) { seen.add(m); want.delete(m); q.push(m); }
		return want.size > 0;
	};
	// c may hold a pile unless it is some object's last free way in
	const lastWayIn = c => (wayIn.get(c) || []).some(v => !nb(v).some(u => u !== c && free(u)));
	const quiet = c => !(blocked[base + c] & RESERVED) && !(road && road.has(c)) && !lastWayIn(c);
	// the dead ends of each zone, as [tile, guard tile]
	const ends = new Map();
	const why = out.why = {};
	const no = k => { why[k] = (why[k] || 0) + 1; };
	for (let c = 0; c < W * H; c++) {
		if (!free(c)) continue;
		const open = nb(c).filter(free);
		if (open.length !== 1) continue;
		if (!quiet(c)) { no(blocked[base + c] & RESERVED ? 'end reserved' : road && road.has(c) ? 'end road' : 'end way in'); continue; }
		const g = open[0], dx = c % W - g % W, dy = ((c / W) | 0) - ((g / W) | 0);
		if ((dx === -1 && dy === 0) || (dx === 0 && dy === -1) || (dx === -1 && dy === -1)) { no('under sprite'); continue; }   // under the guard's sprite
		if (zone[g] !== zone[c]) { no('other zone'); continue; }
		if (!onMain(g)) { no('mouth off the open ground'); continue; }
		if ((blocked[base + g] & RESERVED) || (road && road.has(g))) { no('mouth on a road'); continue; }
		if (mons.some(m => Math.max(Math.abs(m.x - g % W), Math.abs(m.y - ((g / W) | 0))) <= 2)) { no('monster near'); continue; }
		no('ok');
		if (!ends.has(zone[c])) ends.set(zone[c], []);
		ends.get(zone[c]).push([c, g]);
	}
	const used = new Set();
	const piles = plan.objects.filter(o => (o.l || 0) === l && o.template && o.template.mask && PILE.test(o.type)
		&& blockingCells(o.template, o.x, o.y).length <= 1 && visitableCells(o.template, o.x, o.y).length === 1);
	for (const p of piles) {
		const pc = p.y * W + p.x, z = zone[pc];
		const approach = nb(pc).filter(free);
		if (!approach.some(onMain)) continue;            // in a pocket already, or walled in
		out.open++;
		const list = (ends.get(z) || []).filter(([c, g]) => !used.has(c) && !used.has(g) && free(c) && free(g)
			&& !mons.some(m => Math.max(Math.abs(m.x - g % W), Math.abs(m.y - ((g / W) | 0))) <= 2));
		const dist = ([c]) => Math.max(Math.abs(c % W - p.x), Math.abs(((c / W) | 0) - p.y));
		list.sort((a, b) => dist(a) - dist(b));
		// the pile's own guard: within two tiles, its ring in the pile's zone and holding no other object's way in
		const own = mons.filter(m => Math.max(Math.abs(m.x - p.x), Math.abs(m.y - p.y)) <= 2).sort((a, b) =>
			Math.max(Math.abs(a.x - p.x), Math.abs(a.y - p.y)) - Math.max(Math.abs(b.x - p.x), Math.abs(b.y - p.y)))
			.find(m => {
				for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
					const c = (m.y + dy) * W + m.x + dx;
					if (c < 0 || c >= W * H || zone[c] !== z) return false;
				}
				return !plan.objects.some(o => o !== p && (o.l || 0) === l && o.template && o.template.mask && !MON.test(o.type)
					&& visitableCells(o.template, o.x, o.y).some(([vx, vy]) => Math.max(Math.abs(vx - m.x), Math.abs(vy - m.y)) <= 1));
			});
		let spot = null;
		for (const [c, g] of list) {
			if (cuts(g, c)) continue;
			if (!footprintFits(monsterTpl, g % W, (g / W) | 0, l, W, H, blocked, true)) continue;
			spot = [c, g];
			break;
		}
		if (!spot) { out.left++; continue; }
		const [c, g] = spot;
		used.add(c); used.add(g);
		// the pile moves
		for (const [a, b] of blockingCells(p.template, p.x, p.y)) blocked[base + b * W + a] &= ~OCCUPIED;
		p.x = c % W; p.y = (c / W) | 0;
		footprintBlock(p.template, p.x, p.y, l, W, H, blocked);
		// and its guard with it, or a new one
		if (own) {
			for (const [a, b] of blockingCells(own.template || monsterTpl, own.x, own.y)) blocked[base + b * W + a] &= ~OCCUPIED;
			own.x = g % W; own.y = (g / W) | 0;
			footprintBlock(own.template || monsterTpl, own.x, own.y, l, W, H, blocked);
		} else {
			const tier = TIER[p.type] || 5;
			const e = objectEntry(`randomMonsterLevel${tier}`, g % W, (g / W) | 0, l, monsterTpl, 'object', monsterOptions(tier, plan.p, rng));
			// a map whose guards are written as creatures (a template's) gets one here too: the nearest such guard lends its creature, level and amount
			// (a placeholder left here failed guard-creatures.test.js, 2026-10-08)
			{
				let best = null, bd = Infinity;
				for (const m of plan.objects) {
					if ((m.l || 0) !== l || !m.guardCreature || !/^randomMonsterLevel/.test(m.type)) continue;
					const d = Math.max(Math.abs(m.x - (g % W)), Math.abs(m.y - ((g / W) | 0)));
					if (d < bd) { bd = d; best = m; }
				}
				if (best) { e.type = best.type; e.instanceName = `${best.type}_${e.x}_${e.y}_${l}`; e.options = { ...best.options }; e.guardCreature = best.guardCreature; }
			}
			plan.objects.push(e);
			mons.push(e);
			footprintBlock(monsterTpl, g % W, (g / W) | 0, l, W, H, blocked);
			markApproach(monsterTpl, g % W, (g / W) | 0, l, W, H, blocked);
		}
		out.moved++;
	}
	return out;
}

module.exports = { sealPiles };
