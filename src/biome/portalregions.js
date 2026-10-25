'use strict';
/**
 * portalregions.js - the ground each start holds without a fight, through gates and monolith pairs, and what stands on it (MapGen Dev, 2026-10-22;
 * the Opus Reviewer's content read of rel-0318: panel N no144x2 s8303 held 1064 tiles for red and 2822 for blue, content x2.77, because blue's region
 * ran through an unguarded portal pair to the other level and red's did not; s8313 x2.07; s8307 both starts in one region of 9016 tiles).
 *
 * A start's region is the ground a hero reaches from its town's door without entering a stack's 3x3 ring or a wall, plus, at each end of a portal pair
 * (a subterranean gate and its partner on the other level, the ends of one two-way monolith kind) it reaches, the ground at the other ends. Its content
 * is scored as the Reviewer scores it: a neutral town 10, a mine 3, a dwelling 2, a relic, major artifact or Pandora's box 2, any other pickup 1.
 *
 * Two rules, both acting by guarding portal ends (a stack on an approach tile, as the engine seals every gate and monolith behind one):
 *   shared  two starts whose regions meet only through portals (one start's door is in the other's region, and not without them): the ends are guarded,
 *           the one whose guard cuts the shared ground most first, until no start reaches another's door or no end is left;
 *   content the richest start's content is more than 2.2 times the poorest's: the end whose guard brings the ratio down most is guarded, until the
 *           ratio is within 1.8, no end improves it, or 12 ends are done.
 * A map whose starts are within 2.2 and that shares nothing through portals is never touched. The lever Biome links as portals and Guards at portals are
 * never clamped: the generator gives up the open rush lane, not the setting. VMAPGEN_PORTAL_REGIONS=0 off. Returns { shared, content, ratio0, ratio1 }.
 */
const WEIGHT = [
	[/^(town|randomTown)$/, 10, o => !(o.options && o.options.owner)],
	[/^(mine|abandonedMine)$/, 3],
	[/^creatureGenerator/, 2],
	[/^(randomArtifactRelic|randomArtifactMajor|pandoraBox)$/, 2],
	[/^(resource|randomResource|treasureChest|randomArtifactMinor|randomArtifactTreasure|spellScroll|campfire|seaChest|flotsam|artifact)$/, 1],
];
const weightOf = o => { for (const [re, w, ok] of WEIGHT) if (re.test(o.type) && (!ok || ok(o))) return w; return 0; };
const PASS = /^(resource|randomResource|treasureChest|campfire|randomArtifact|artifact|pandoraBox|spellScroll|prison|seaChest|flotsam|monster|randomMonster)/;

function balancePortalRegions(ctx) {
	const { plans, levels, W, H, blocked, params, rng, approachCells, townDoorCells, blockingCells, footprintFits, reserveCell, markApproach, objectEntry,
		engineGuard, scaledLinkGuard, scaledAmount, OBJECT_TEMPLATES, OCCUPIED } = ctx;
	const out = { shared: 0, content: 0, ratio0: 1, ratio1: 1 };
	const N = W * H;
	const owned = [];
	for (let l = 0; l < levels; l++)
		for (const o of plans[l].objects) if ((o.l || 0) === l && o.template && /^(town|randomTown)$/.test(o.type) && o.options && o.options.owner) owned.push({ l, o });
	if (owned.length < 2) return out;

	// per level: ground a hero can stand on outside every ring
	const ring = [], open = [], items = [];
	const buildLevel = l => {
		const pl = plans[l], zone = pl.zone, water = pl.p && pl.p.water;
		const wall = new Uint8Array(N), held = new Set(), rg = new Uint8Array(N);
		for (const o of pl.objects) {
			if ((o.l || 0) !== l || !o.template) continue;
			const pass = PASS.test(o.type);
			for (const [fx, fy] of blockingCells(o.template, o.x, o.y)) if (fx >= 0 && fy >= 0 && fx < W && fy < H) { if (pass) held.add(fy * W + fx); else wall[fy * W + fx] = 1; }
			if (/^(monster|randomMonster)/.test(o.type))
				for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const u = o.x + dx, v = o.y + dy; if (u >= 0 && v >= 0 && u < W && v < H) rg[v * W + u] = 1; }
		}
		for (let c = 0; c < N; c++) if ((blocked[l * N + c] & OCCUPIED) && !wall[c] && !held.has(c)) wall[c] = 1;
		const op = new Uint8Array(N);
		for (let c = 0; c < N; c++) op[c] = zone && zone[c] >= 0 && !(water && water[c]) && !wall[c] && !rg[c] ? 1 : 0;
		ring[l] = rg; open[l] = op; open[l].wall = wall;
	};
	for (let l = 0; l < levels; l++) buildLevel(l);
	const refreshOpen = l => { const op = open[l], rg = ring[l], wall = open[l].wall, zone = plans[l].zone, water = plans[l].p && plans[l].p.water; for (let c = 0; c < N; c++) op[c] = zone && zone[c] >= 0 && !(water && water[c]) && !wall[c] && !rg[c] ? 1 : 0; };

	// scored objects with their approach cells
	for (let l = 0; l < levels; l++) {
		items[l] = [];
		for (const o of plans[l].objects) {
			if ((o.l || 0) !== l || !o.template) continue;
			const w = weightOf(o);
			if (!w) continue;
			const cells = approachCells(o.template, o.x, o.y, l, W, H, blocked);
			if (cells.length) items[l].push({ w, cells });
		}
	}
	// portal ends and their groups: a gate with no pair id (the plan keeps none at this point on some maps) is paired as the engine and mapsight pair them, each
	// surface gate with the nearest unpaired underground gate
	const ends = [], groups = new Map(), endAt = new Map();
	const addEnd = (l, o, key) => {
		const e = { i: ends.length, l, o, key, cells: approachCells(o.template, o.x, o.y, l, W, H, blocked) };
		ends.push(e);
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(e);
		for (const c of e.cells) { const k = l * N + c; if (!endAt.has(k)) endAt.set(k, []); endAt.get(k).push(e); }
	};
	const loose = [];
	for (let l = 0; l < levels; l++)
		for (const o of plans[l].objects) {
			if ((o.l || 0) !== l || !o.template) continue;
			if (o.type === 'subterraneanGate') { if (o.pairId) addEnd(l, o, 'g:' + o.pairId); else loose.push({ l, o }); }
			else if (o.type === 'monolithTwoWay') addEnd(l, o, 'm:' + o.subtype);
		}
	{
		const used = new Set();
		let n = 0;
		for (const g of loose.filter(q => q.l === 0)) {
			let best = null, bd = 1e9;
			for (const h of loose) if (h.l === 1 && !used.has(h)) { const d = Math.hypot(g.o.x - h.o.x, g.o.y - h.o.y); if (d < bd) { bd = d; best = h; } }
			if (!best) continue;
			used.add(best);
			addEnd(g.l, g.o, 'gp:' + n); addEnd(best.l, best.o, 'gp:' + n); n++;
		}
	}
	if (!ends.length) return out;

	const doors = owned.map(s => [...townDoorCells(plans[s.l].objects, s.l, W, H, blocked, s.o)].map(c => ({ l: s.l, c })).filter(d => open[d.l][d.c]));
	// the region of one start: a Uint8Array per level; disabled is a Set of end indices that no hero crosses, noPortals skips every hop
	const regionOf = (si, disabled, noPortals) => {
		const seen = Array.from({ length: levels }, () => new Uint8Array(N));
		const q = [];
		const push = (l, c) => { if (open[l][c] && !seen[l][c]) { seen[l][c] = 1; q.push(l * N + c); } };
		for (const d of doors[si]) push(d.l, d.c);
		for (let h = 0; h < q.length; h++) {
			const l = (q[h] / N) | 0, c = q[h] - l * N, x = c % W, y = (c / W) | 0;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				if (!dx && !dy) continue;
				const u = x + dx, v = y + dy;
				if (u < 0 || v < 0 || u >= W || v >= H) continue;
				push(l, v * W + u);
			}
			if (noPortals) continue;
			const here = endAt.get(q[h]);
			if (here) for (const e of here) {
				if (disabled && disabled.has(e.i)) continue;
				for (const f of groups.get(e.key)) {
					if (f === e || (disabled && disabled.has(f.i))) continue;
					for (const cc of f.cells) push(f.l, cc);
				}
			}
		}
		return seen;
	};
	const scoreOf = seen => { let s = 0; for (let l = 0; l < levels; l++) for (const it of items[l]) if (it.cells.some(c => seen[l][c])) s += it.w; return s; };
	const scores = disabled => owned.map((_, si) => scoreOf(regionOf(si, disabled)));
	const ratioOf = sc => { const hi = Math.max(...sc), lo = Math.min(...sc); return hi / Math.max(1, lo); };
	const touches = (seen, e) => e.cells.some(c => seen[e.l][c]);

	// guard an end: a stack on the approach tile whose ring covers most of the approach, more on the tiles still open (at most three)
	const monster = OBJECT_TEMPLATES.randomMonster;
	const guardEnd = e => {
		const l = e.l;
		let placed = 0;
		for (let round = 0; round < 3; round++) {
			const openCells = e.cells.filter(c => open[l][c]);
			if (!openCells.length) break;
			const covers = c => openCells.filter(d => Math.abs(d % W - c % W) <= 1 && Math.abs(((d / W) | 0) - ((c / W) | 0)) <= 1).length;
			const sorted = e.cells.slice().sort((a, b) => covers(b) - covers(a));
			let done = false;
			for (const c of sorted) {
				const gx = c % W, gy = (c / W) | 0;
				if (!footprintFits(monster, gx, gy, l, W, H, blocked, true)) continue;
				const g = engineGuard(scaledLinkGuard(5000, params), 1 + Math.round(params.monsterStrength || 0), rng, true);
				if (!g) return placed;
				plans[l].objects.push(objectEntry(`randomMonsterLevel${g.level}`, gx, gy, l, monster, 'object', { character: 'hostile', amount: scaledAmount(g.amount, params) }));
				reserveCell(blocked, l, W, H, c);
				markApproach(monster, gx, gy, l, W, H, blocked);
				for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const u = gx + dx, v = gy + dy; if (u >= 0 && v >= 0 && u < W && v < H) ring[l][v * W + u] = 1; }
				// the footprint is a wall now
				for (const [fx, fy] of blockingCells(monster, gx, gy)) if (fx >= 0 && fy >= 0 && fx < W && fy < H) open[l].wall[fy * W + fx] = 1;
				refreshOpen(l);
				placed++; done = true;
				break;
			}
			if (!done) break;
		}
		return placed;
	};

	// the rules are run on a set of disabled ends first, and only the set that serves is placed: separating two starts can leave one far poorer
	const meets = disabled => {
		const pairs = [];
		for (let a = 0; a < owned.length; a++) {
			const ra = regionOf(a, disabled);
			for (let b = 0; b < owned.length; b++) if (a !== b && doors[b].some(d => ra[d.l][d.c])) pairs.push([a, b]);
		}
		return pairs;
	};
	const noPortalReach = owned.map((_, a) => regionOf(a, null, true));
	const viaPortalsOnly = pairs => pairs.filter(([a, b]) => !doors[b].some(d => noPortalReach[a][d.l][d.c]));
	out.ratio0 = ratioOf(scores(null));
	out.detail = owned.map((st, si) => { const seen = regionOf(si, null); let tiles = 0; for (let l = 0; l < levels; l++) for (let c = 0; c < N; c++) if (seen[l][c]) tiles++; return `${st.o.options.owner} (${st.o.x},${st.o.y},L${st.l}) doors ${doors[si].length} tiles ${tiles} content ${scoreOf(seen)}`; });
	const simulate = withShared => {
		const dis = new Set();
		let sharedSteps = 0;
		if (withShared)
			for (let iter = 0; iter < 12; iter++) {
				const need = viaPortalsOnly(meets(dis));
				if (!need.length) break;
				let best = null;
				for (const e of ends) {
					if (dis.has(e.i)) continue;
					const d2 = new Set([...dis, e.i]);
					const left = viaPortalsOnly(meets(d2)).length;
					if (left >= need.length) continue;
					const r = ratioOf(scores(d2));
					if (!best || left < best.left || (left === best.left && r < best.r)) best = { e, left, r };
				}
				if (!best) break;
				dis.add(best.e.i); sharedSteps++;
			}
		const sharedLeft = withShared ? viaPortalsOnly(meets(dis)).length : -1;
		let ratio = ratioOf(scores(dis)), contentSteps = 0;
		if (ratio > 2.2) {
			for (let iter = 0; iter < 12 && ratio > 1.8; iter++) {
				const sc0 = scores(dis), hi = sc0.indexOf(Math.max(...sc0));
				const seen = regionOf(hi, dis);
				let best = null;
				for (const e of ends) {
					if (dis.has(e.i) || !touches(seen, e)) continue;
					const r = ratioOf(scores(new Set([...dis, e.i])));
					if (r < ratio - 0.05 && (!best || r < best.r)) best = { e, r };
				}
				if (!best) break;
				dis.add(best.e.i); contentSteps++;
				ratio = ratioOf(scores(dis));
			}
		}
		return { dis, ratio, sharedSteps, contentSteps, sharedLeft };
	};
	const shared = simulate(true), plain = simulate(false);
	// the separation serves when it leaves no start reaching another's door through portals and the ratio within 2.2; otherwise the content rule alone, when it
	// brings the ratio down; otherwise nothing is placed (the open rush lane stays, said in the log)
	let chosen = null;
	if (shared.dis.size && shared.sharedLeft === 0 && shared.ratio <= Math.max(2.2, out.ratio0)) chosen = shared;
	else if (plain.dis.size && plain.ratio < out.ratio0 - 0.05) chosen = plain;
	out.skipped = !chosen && (shared.sharedSteps > 0 || out.ratio0 > 2.2) ? `separation would leave the ratio at ${shared.ratio.toFixed(2)} (content rule alone ${plain.ratio.toFixed(2)})` : null;
	if (chosen) {
		for (const i of chosen.dis) if (guardEnd(ends[i])) { if (chosen === shared && chosen.sharedSteps) out.shared++; else out.content++; }
		if (chosen === shared) { out.content = chosen.contentSteps; out.shared = chosen.dis.size - chosen.contentSteps; }
	}
	out.ratio1 = ratioOf(scores(null));
	return out;
}

module.exports = { balancePortalRegions, weightOf };
