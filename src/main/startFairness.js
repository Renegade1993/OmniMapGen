/**
 * startFairness.js - every player's start as fair as the settings allow.
 *
 * K (2026-09-27), on a stress map where one player's castle sat boxed into a
 * corner, nothing in reach, its one narrow way out held by a huge dragonfly
 * stack: "Prefer flexibility over perfect balance (but get balance as good as
 * we possibly can while meeting the player's request)." So nothing the player
 * asked for is cut. The pass only evens out, between the starts, the guards
 * standing between each start and the rest of the map.
 *
 * Measured on the finished map. A hero walks eight ways over ground no lasting
 * object blocks (a pile or a chest is picked up, so it does not), and through
 * monoliths and subterranean gates onto the ground before the far end. A tile
 * a monster guards, its own and the eight around it, is a fight, as in the
 * game, and so is a portal whose entrance, or whose far end's, a monster
 * stands beside: the hero steps onto it to go through. So the map's open ground falls into pieces with guards between them.
 * A start's home is the piece its town's gate opens on. Its way out is the
 * route to open ground bigger than a treasure niche (LEADS_TO) whose hardest
 * fight is the weakest any route offers; that fight's value is its gate. A
 * route may pass a niche and a second guard, as a link guard behind a
 * treasure guard does.
 *
 * A gate dearer than GATE_SLACK times the median gate has every guard on its
 * route cut to that. A start whose home holds under HOME_SHARE of the median
 * home is boxed in: its route is cut to the cheapest start's gate, so it
 * leaves early. A gate cheaper than the median over GATE_SLACK is raised to
 * that: every guard under it on the route, and the start measured again, until
 * its way out costs that much (a start that leaves easily is as far from even
 * as one that is shut in; on free 72x72 two-level seed 5 one start's way out
 * cost 525 where the others' cost 2,100 to 2,990). A start with no guarded way
 * out (a boat its only road) is left as it is. The median of an even count is
 * the mean of the middle two: with the upper one, two starts were never cut,
 * the dearer being the median itself.
 */
'use strict';

const GATE_SLACK = 1.5;
const HOME_SHARE = 0.5;
// how often a start's way out is raised and measured again, as each raise can
// leave the next cheapest route the way out
const RAISE_ROUNDS = 8;
// open ground past a guard that makes it a way out, not a niche it guards
const LEADS_TO = 30;

const MONSTER = /^(monster|randomMonster|randomMonsterLevel[1-7])$/;

/** The cells a template covers at (x, y) whose mask letter is in `letters`. */
function cellsOf(o, letters, W, H) {
	const out = [];
	const mask = (o.template && o.template.mask) || [];
	for (let i = 0; i < mask.length; i++) {
		const line = String(mask[i]);
		for (let j = 0; j < line.length; j++) {
			if (!letters.includes(line[j])) continue;
			const x = o.x - (line.length - 1 - j), y = o.y - (mask.length - 1 - i);
			if (x >= 0 && y >= 0 && x < W && y < H) out.push(y * W + x);
		}
	}
	return out;
}

/**
 * objects: the map's objects (guards as their creatures, or placeholders);
 * starts: [{ color, l, from: [cells] }], the ground before each town's gate;
 * levels: how many; links: [{ a, b, va, vb }], the ground before each end of
 * a monolith pair or a pair of subterranean gates and each end's own
 * visitable cells, as level * W * H + cell;
 * blockedAt(l, c): ground no hero crosses on level l (water, rock);
 * removable(o): an object a hero picks up or beats (not a wall);
 * strengthOf(o): a guard's fighting value; setStrength(o, value): its stack
 * cut to that value; zoneAt(l, c), when given: the zone a cell belongs to,
 * so a way out has to reach another zone's ground, past the start's own
 * zone, rather than a treasure ground of its own behind a guard. Returns
 * { starts: [{ color, home, gate, cut }], cuts }.
 */
function evenStarts({ objects, starts, W, H, levels = 1, links = [], blockedAt, removable, strengthOf, setStrength, zoneAt = null }) {
	const N = W * H, ALL = levels * N;
	const walls = new Uint8Array(ALL);
	for (let l = 0; l < levels; l++)
		for (let c = 0; c < N; c++) if (blockedAt(l, c)) walls[l * N + c] = 1;
	const monsters = [];
	for (const o of objects) {
		const l = o.l || 0;
		if (l >= levels) continue;
		if (MONSTER.test(o.type)) { monsters.push(o); continue; }
		if (removable(o)) continue;
		for (const c of cellsOf(o, 'BA', W, H)) walls[l * N + c] = 1;
	}
	// each guard's fight: the open cells of the nine around the tile its
	// creature stands on (its mask's visitable blocked cell, which a wide
	// sprite does not put at the anchor)
	const guardedBy = new Map();
	const fights = monsters.map((o, k) => {
		const l = o.l || 0;
		const tiles = cellsOf(o, 'A', W, H);
		const t = tiles.length ? tiles[0] : o.y * W + o.x;
		const x = t % W, y = (t / W) | 0;
		const cells = [];
		for (let dy = -1; dy <= 1; dy++)
			for (let dx = -1; dx <= 1; dx++) {
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const c = l * N + ny * W + nx;
				if (walls[c]) continue;
				cells.push(c);
				if (!guardedBy.has(c)) guardedBy.set(c, []);
				guardedBy.get(c).push(k);
			}
		return { x, y, l, cells };
	});
	// the open ground in pieces, eight ways within a level
	const piece = new Int32Array(ALL).fill(-1);
	const pieceSize = [];
	for (let c0 = 0; c0 < ALL; c0++) {
		if (piece[c0] >= 0 || walls[c0] || guardedBy.has(c0)) continue;
		const id = pieceSize.length;
		const q = [c0];
		piece[c0] = id;
		for (let h = 0; h < q.length; h++) {
			const g = q[h], l = (g / N) | 0, c = g - l * N, x = c % W, y = (c / W) | 0;
			for (let dy = -1; dy <= 1; dy++)
				for (let dx = -1; dx <= 1; dx++) {
					const nx = x + dx, ny = y + dy;
					if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
					const n = l * N + ny * W + nx;
					if (piece[n] >= 0 || walls[n] || guardedBy.has(n)) continue;
					piece[n] = id;
					q.push(n);
				}
		}
		pieceSize.push(q.length);
	}
	// each monster's reach over any ground, a portal's blocked entrance too
	const reachOf = new Map();
	fights.forEach((f, k) => {
		for (let dy = -1; dy <= 1; dy++)
			for (let dx = -1; dx <= 1; dx++) {
				const nx = f.x + dx, ny = f.y + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const c = f.l * N + ny * W + nx;
				if (!reachOf.has(c)) reachOf.set(c, []);
				reachOf.get(c).push(k);
			}
	});
	const guardsAt = cells => [...new Set((cells || []).flatMap(c => reachOf.get(c) || []))];
	const ends = links.map(({ a, b, va, vb }) => ({
		a: (a || []).filter(c => c >= 0 && c < ALL), b: (b || []).filter(c => c >= 0 && c < ALL),
		ga: guardsAt(va), gb: guardsAt(vb) }));
	// a portal no monster guards joins every piece at one end with every piece
	// at the other: a hero stepping on it comes out at the far end, and can
	// step back in
	const parent = pieceSize.map((_, i) => i);
	const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
	for (const e of ends) {
		if (e.ga.length || e.gb.length) continue;
		const ps = [...new Set([...e.a, ...e.b].map(c => piece[c]).filter(p => p >= 0))];
		for (let i = 1; i < ps.length; i++) parent[find(ps[i])] = find(ps[0]);
	}
	const region = c => (piece[c] >= 0 ? find(piece[c]) : -1);
	const regionSize = new Map();
	pieceSize.forEach((n, i) => { const r = find(i); regionSize.set(r, (regionSize.get(r) || 0) + n); });
	// each region's cells by zone (level and zone), for the way out of a start's own
	const regionZones = new Map();
	if (zoneAt)
		for (let c = 0; c < ALL; c++) {
			if (piece[c] < 0) continue;
			const r = find(piece[c]), l = (c / N) | 0, key = l + ':' + zoneAt(l, c - l * N);
			if (!regionZones.has(r)) regionZones.set(r, new Map());
			const m = regionZones.get(r);
			m.set(key, (m.get(key) || 0) + 1);
		}
	// what each guard's fight opens onto: pieces, and other guards' fights
	const opens = fights.map((f, k) => {
		const regions = new Set(), guards = new Set();
		const touch = n => {
			if (n < 0 || n >= ALL || walls[n]) return;
			const r = region(n);
			if (r >= 0) regions.add(r);
			for (const j of guardedBy.get(n) || []) if (j !== k) guards.add(j);
		};
		for (const g of f.cells) {
			const l = (g / N) | 0, c = g - l * N, x = c % W, y = (c / W) | 0;
			for (let dy = -1; dy <= 1; dy++)
				for (let dx = -1; dx <= 1; dx++) {
					const nx = x + dx, ny = y + dy;
					if (nx >= 0 && ny >= 0 && nx < W && ny < H) touch(l * N + ny * W + nx);
				}
		}
		return { regions, guards };
	});
	// a guarded portal: the guard at the near end is the fight on the way in,
	// and past it the far end's guard, or the far end's ground
	const regionsOf = cells => [...new Set(cells.map(region).filter(r => r >= 0))];
	for (const e of ends) {
		if (!e.ga.length && !e.gb.length) continue;
		const ra = regionsOf(e.a), rb = regionsOf(e.b);
		for (const [near, own, far, farGuards] of [[e.ga, ra, rb, e.gb], [e.gb, rb, ra, e.ga]]) {
			for (const k of near) {
				for (const r of own) opens[k].regions.add(r);
				if (farGuards.length) { for (const j of farGuards) if (j !== k) opens[k].guards.add(j); }
				else for (const r of far) opens[k].regions.add(r);
			}
		}
	}
	// and which guards each region meets
	const meets = new Map();
	opens.forEach((o, k) => { for (const r of o.regions) { if (!meets.has(r)) meets.set(r, []); meets.get(r).push(k); } });
	const value = monsters.map(o => strengthOf(o));

	const measure = s => {
		const from = (s.from || []).map(c => (s.l || 0) * N + c).filter(c => c >= 0 && c < ALL && !walls[c]);
		const homes = new Set(from.map(region).filter(r => r >= 0));
		// the start's own zone: its town's (the gate's ground), on its level
		const ownZone = zoneAt && from.length
			? ((from[0] / N) | 0) + ':' + zoneAt((from[0] / N) | 0, from[0] % N) : null;
		const leadsOn = id => {
			if (!ownZone) return regionSize.get(id) > LEADS_TO;
			let away = 0;
			for (const [z, n] of regionZones.get(id) || []) if (z !== ownZone) away += n;
			return away > LEADS_TO;
		};
		let home = 0;
		for (const r of homes) home += regionSize.get(r);
		// the route whose hardest fight is the weakest: nodes are regions
		// ('r' + id) and guards ('g' + index), a guard costing its value
		const best = new Map(), prev = new Map(), heap = [];
		const push = (node, cost, from0) => {
			if (best.has(node) && best.get(node) <= cost) return;
			best.set(node, cost);
			prev.set(node, from0);
			heap.push([cost, node]);
			for (let i = heap.length - 1; i > 0;) {
				const p = (i - 1) >> 1;
				if (heap[p][0] <= heap[i][0]) break;
				[heap[p], heap[i]] = [heap[i], heap[p]]; i = p;
			}
		};
		const pop = () => {
			const top = heap[0], last = heap.pop();
			if (heap.length) {
				heap[0] = last;
				for (let i = 0; ;) {
					const a = 2 * i + 1, b = a + 1;
					let m = i;
					if (a < heap.length && heap[a][0] < heap[m][0]) m = a;
					if (b < heap.length && heap[b][0] < heap[m][0]) m = b;
					if (m === i) break;
					[heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
				}
			}
			return top;
		};
		for (const r of homes) push('r' + r, 0, null);
		// a guard standing at the gate itself is the first fight
		for (const c of from) for (const k of guardedBy.get(c) || []) push('g' + k, value[k], null);
		let dest = null;
		while (heap.length) {
			const [cost, node] = pop();
			if (cost > best.get(node)) continue;
			const id = +node.slice(1);
			if (node[0] === 'r') {
				if (!homes.has(id) && leadsOn(id)) { dest = node; break; }
				for (const k of meets.get(id) || []) push('g' + k, Math.max(cost, value[k]), node);
			} else {
				for (const r of opens[id].regions) push('r' + r, cost, node);
				for (const j of opens[id].guards) push('g' + j, Math.max(cost, value[j]), node);
			}
		}
		let gate = null;
		if (dest) {
			const route = [];
			for (let n = dest; n; n = prev.get(n)) if (n[0] === 'g') route.push(+n.slice(1));
			gate = { value: best.get(dest), route };
		}
		if (process.env.VMAPGEN_FAIR_TRACE)
			console.error(`[fair] ${s.color}: home ${home}, `
				+ (gate ? `way out past ${gate.route.map(k => `${monsters[k].subtype || monsters[k].type} (${fights[k].x},${fights[k].y}) ${Math.round(value[k])}`).join(', ')}`
					: 'no guarded way out'));
		return { start: s, home, gate };
	};
	const measured = starts.map(measure);
	const median = xs => {
		const v = xs.slice().sort((a, b) => a - b), h = v.length >> 1;
		return !v.length ? 0 : v.length % 2 ? v[h] : (v[h - 1] + v[h]) / 2;
	};
	const gates = measured.filter(m => m.gate).map(m => m.gate.value);
	const medGate = median(gates), minGate = gates.length ? Math.min(...gates) : 0;
	const medHome = median(measured.map(m => m.home));
	const cuts = [];
	for (const m of measured) {
		if (!m.gate || measured.length < 2) continue;
		const boxed = m.home < HOME_SHARE * medHome;
		const target = boxed ? minGate : GATE_SLACK * medGate;
		if (m.gate.value <= target) continue;
		for (const k of m.gate.route) {
			if (value[k] <= target) continue;
			setStrength(monsters[k], target);
			value[k] = target;
		}
		cuts.push({ color: m.start.color, from: m.gate.value, to: target, boxed });
		m.cut = target;
	}
	// and a way out that costs too little raised to the floor
	const floor = medGate / GATE_SLACK;
	for (const m of measured) {
		if (!m.gate || measured.length < 2 || m.cut || m.gate.value >= floor) continue;
		const from = m.gate.value;
		for (let round = 0; round < RAISE_ROUNDS && m.gate && m.gate.value < floor; round++) {
			for (const k of m.gate.route) {
				if (value[k] >= floor) continue;
				setStrength(monsters[k], floor);
				value[k] = floor;
			}
			m.gate = measure(m.start).gate;
		}
		cuts.push({ color: m.start.color, from, to: floor, raised: true });
		m.raised = floor;
	}
	return {
		starts: measured.map(m => ({ color: m.start.color, home: m.home, gate: m.gate ? m.gate.value : null,
			cut: m.cut || null, raised: m.raised || null })),
		cuts,
	};
}

module.exports = { evenStarts, GATE_SLACK, HOME_SHARE, LEADS_TO };
