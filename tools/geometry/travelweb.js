'use strict';
/**
 * travelweb.js MAP... [--mp 1560] [--days 6] [--guards army|pass|wall] [--json]: K's start-fairness measure, his "coalescing
 * travel web" (2026-10-04 00:40: "you can't make it specific to two days, it needs multiple checkpoints, and you need
 * to measure opportunities within each day's travel of distance").
 *
 * From each start a web grows by real hero movement: the game's own costs (VCMI CPathfinderHelper::getMovementCost and
 * getTileMovementCost): the cost of the tile left, the road's when both tiles have road, times 1.414 on a diagonal; the
 * terrain costs are the loaded mods' (terrain_costs.json, written by VMAPGEN_TERRAIN_DUMP), the day's points
 * gameConfig movementPointsLand (1560: an army of speed 4). Subterranean gates and monoliths carry a hero to every
 * other one of their kind. Pickups are walked through (taken), guards are fought through unless --guards wall.
 *
 * Opportunities: towns, mines (by resource), dwellings, banks, high loot. Each belongs to the start that reaches it
 * first; one reached within 10% of the first start's cost by another is shared. Printed per start and per day: what
 * its web reaches by that day and what it owns, then the spread (best start minus worst) of towns and mines owned.
 */
const path = require('path');
const sight = require('../mapsight/lib/sight');
const COSTS = require('./terrain_costs.json');
const ROAD = { pd: 75, pg: 65, pc: 50 };

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const MP = Number(opt('--mp', 1560)), DAYS = Number(opt('--days', 6)), GUARDS = opt('--guards', 'army');
// --guards army (the default): a guard is passed on the first day a hero's army is worth its stack (creature aiValue
// times amount, creature_values.json; a mod creature at its level's mean). The army by day is Nullkiller's, read off
// the TRUTH lines of a 59-day engine game on K's 36x36 s203860797 (2026-10-04, .tmp/opus-seeing/pathtest).
const ARMY = [[1, 4145], [2, 11673], [8, 11897], [10, 14413], [12, 16444], [20, 21489], [30, 76011]];
const armyOn = day => {
	if (day <= ARMY[0][0]) return ARMY[0][1];
	for (let k = 1; k < ARMY.length; k++) if (day <= ARMY[k][0]) {
		const [d0, a0] = ARMY[k - 1], [d1, a1] = ARMY[k];
		return a0 + (a1 - a0) * (day - d0) / (d1 - d0);
	}
	return ARMY[ARMY.length - 1][1];
};
const CV = require('../../src/biome/creature_values.json');
const LEVEL_MEAN = {};
for (const c of Object.values(CV)) (LEVEL_MEAN[c.level] = LEVEL_MEAN[c.level] || []).push(c.aiValue);
for (const k in LEVEL_MEAN) LEVEL_MEAN[k] = LEVEL_MEAN[k].reduce((a, b) => a + b, 0) / LEVEL_MEAN[k].length;
const JSONOUT = args.includes('--json');
const files = args.filter(a => !a.startsWith('--'));
const KINDS = ['town', 'mine', 'dwelling', 'bank', 'high'];

function costOf(M) {
	const N = M.NL * M.W * M.H, terrCost = new Int32Array(N), road = new Int32Array(N);
	for (let l = 0; l < M.NL; l++) for (let y = 0; y < M.H; y++) for (let x = 0; x < M.W; x++) {
		const i = M.idx(l, x, y), code = M.levels[l].rows[y][x];
		const t = COSTS[M.terr[i]];
		terrCost[i] = t && t.moveCost > 0 ? t.moveCost : 100;
		for (const c of sight.tileLayers(code)) if (ROAD[c]) road[i] = ROAD[c];
	}
	return { terrCost, road };
}

function web(M, start, C, walkable, jumps, guardVal) {
	const N = M.NL * M.W * M.H, dist = new Float64Array(N).fill(Infinity);
	const heap = [];
	const push = (d, i) => { heap.push([d, i]); let k = heap.length - 1; while (k) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
	const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let k = 0; for (;;) { const a = 2 * k + 1, b = a + 1; let m = k; if (a < heap.length && heap[a][0] < heap[m][0]) m = a; if (b < heap.length && heap[b][0] < heap[m][0]) m = b; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };
	const s = M.idx(start.l, start.at[0], start.at[1]);
	dist[s] = 0; push(0, s);
	while (heap.length) {
		const [d, i] = pop();
		if (d > dist[i] || d > MP * (DAYS + 1)) continue;
		const l = Math.floor(i / (M.W * M.H)), r = i % (M.W * M.H), x = r % M.W, y = (r / M.W) | 0;
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
			if (!dx && !dy) continue;
			const nx = x + dx, ny = y + dy;
			if (!M.inb(nx, ny)) continue;
			const j = M.idx(l, nx, ny);
			if (!walkable[j] && !jumps.has(j)) continue;
			let c = C.road[i] && C.road[j] ? C.road[i] : C.terrCost[i];
			if (dx && dy) c = Math.floor(c * Math.SQRT2);
			if (guardVal && guardVal[j] > armyOn(Math.floor((d + c) / MP) + 1)) continue;
			if (d + c < dist[j]) { dist[j] = d + c; push(d + c, j); }
		}
		// a teleport's own tile: on to every other end's approach, at no cost
		if (jumps.has(i) && !walkable[i]) for (const k of jumps.get(i)) if (d < dist[k]) { dist[k] = d; push(d, k); }
	}
	return dist;
}

function measure(file) {
	const A = sight.analyse(file), M = A.M;
	const N = M.NL * M.W * M.H, C = costOf(M);
	const walkable = new Uint8Array(N);
	for (let i = 0; i < N; i++) walkable[i] = M.ground(i) && !M.blocked[i] ? 1 : 0;
	for (const o of M.objs) if (o.pickup) for (const [x, y] of o.cells) if (M.ground(M.idx(o.l, x, y))) walkable[M.idx(o.l, x, y)] = 1;
	for (const o of M.objs) if (o.cls === 'monster') {
		for (const [x, y] of o.cells) walkable[M.idx(o.l, x, y)] = GUARDS === 'wall' ? 0 : 1;
		if (GUARDS === 'wall') for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (M.inb(o.at[0] + dx, o.at[1] + dy)) walkable[M.idx(o.l, o.at[0] + dx, o.at[1] + dy)] = 0;
	}
	// teleports: the visit tile of each gate or monolith jumps to the approach tiles of the others of its kind
	const key = o => (o.cls === 'gate' ? 'gate' : o.cls === 'monolith' ? `${o.type.replace(/(Entrance|Exit)$/, '')}:${o.subtype || ''}` : null);
	const byKey = new Map();
	for (const o of M.objs) { const k = key(o); if (k) (byKey.get(k) || byKey.set(k, []).get(k)).push(o); }
	// a subterranean gate leads to one gate only: the nearest on the other level (CGSubterraneanGate::postInit pairs
	// them that way); a monolith to the others of its subtype
	const gatePair = new Map();
	const gates = byKey.get('gate') || [];
	const d2 = (a, b) => (a.at[0] - b.at[0]) ** 2 + (a.at[1] - b.at[1]) ** 2;
	const pairs = [];
	for (const a of gates) for (const b of gates) if (a.l === 0 && b.l !== 0) pairs.push([d2(a, b), a, b]);
	pairs.sort((p, q) => p[0] - q[0]);
	for (const [, a, b] of pairs) if (!gatePair.has(a) && !gatePair.has(b)) { gatePair.set(a, b); gatePair.set(b, a); }
	const jumps = new Map();
	for (const group of byKey.values()) for (const o of group) {
		const ends = o.cls === 'gate' ? (gatePair.has(o) ? [gatePair.get(o)] : []) : group.filter(p => p !== o && !/Entrance$/.test(p.type));
		const to = ends.flatMap(p => M.approach(p).filter(j => walkable[j]));
		if (to.length && !/Exit$/.test(o.type)) jumps.set(M.idx(o.l, o.at[0], o.at[1]), to);
	}
	const starts = (A.starts || []).filter(s => s.at);
	let guardVal = null;
	if (GUARDS === 'army') {
		guardVal = new Float64Array(N);
		for (const o of M.objs) if (o.cls === 'monster') {
			const cr = CV[String(o.subtype || '').replace(/^.*:/, '')];
			const lvl = Number((/(\d)$/.exec(o.type) || [])[1]) || (cr && cr.level) || 4;
			const amount = Number(o.options && o.options.amount) || 10;
			const v = (cr ? cr.aiValue : LEVEL_MEAN[lvl] || LEVEL_MEAN[4]) * amount;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				if (!M.inb(o.at[0] + dx, o.at[1] + dy)) continue;
				const j = M.idx(o.l, o.at[0] + dx, o.at[1] + dy);
				guardVal[j] = Math.max(guardVal[j], v);
			}
		}
	}
	const dists = starts.map(s => web(M, s, C, walkable, jumps, guardVal));
	// TRAVELWEB_BLOCKERS=1: the guards each start's web stops at by the last day (a ring tile beside its reach, not reached)
	if (process.env.TRAVELWEB_BLOCKERS && guardVal) starts.forEach((s, k) => {
		const lim = DAYS * MP, seen = new Map();
		for (const o of M.objs) if (o.cls === 'monster') {
			let touch = false;
			for (let dy = -2; dy <= 2 && !touch; dy++) for (let dx = -2; dx <= 2; dx++) {
				if (!M.inb(o.at[0] + dx, o.at[1] + dy)) continue;
				if (dists[k][M.idx(o.l, o.at[0] + dx, o.at[1] + dy)] <= lim && Math.max(Math.abs(dx), Math.abs(dy)) === 2) { touch = true; break; }
			}
			if (touch && !(dists[k][M.idx(o.l, o.at[0], o.at[1])] <= lim)) seen.set(o, guardVal[M.idx(o.l, o.at[0], o.at[1])]);
		}
		console.log(`  ${s.colour} stops at: ` + [...seen].map(([o, v]) => `${o.options && o.options.amount} ${o.subtype}@${o.at}${o.l ? 'L1' : ''}=${Math.round(v / 1000)}k`).join(', '));
	});
	// an opportunity's cost from a start: its cheapest approach tile, plus the step onto it
	const opps = M.objs.filter(o => KINDS.includes(o.cls) && o.visitable).map(o => {
		const ap = M.approach(o);
		const cost = dists.map(d => Math.min(...ap.map(j => d[j]), Infinity));
		return { o, kind: o.cls, cost };
	});
	const rows = starts.map((s, k) => ({ colour: s.colour, days: [] }));
	for (let day = 1; day <= DAYS; day++) {
		const lim = day * MP;
		for (let k = 0; k < starts.length; k++) {
			const reach = {}, own = {};
			for (const K of KINDS) { reach[K] = 0; own[K] = 0; }
			const mines = {};
			for (const p of opps) {
				if (!(p.cost[k] <= lim)) continue;
				reach[p.kind]++;
				const best = Math.min(...p.cost);
				if (p.cost[k] <= best * 1.1 + 1) {
					const sharers = p.cost.filter(c => c <= best * 1.1 + 1).length;
					own[p.kind] += 1 / sharers;
					if (p.kind === 'mine') { const r = p.o.subtype || p.o.type; mines[r] = (mines[r] || 0) + 1 / sharers; }
				}
			}
			rows[k].days.push({ day, reach, own, mines });
		}
	}
	return { file: path.basename(file), mp: MP, guards: GUARDS, starts: rows };
}

const fmt = v => (Math.round(v * 10) / 10).toString().padStart(4);
for (const f of files) {
	const r = measure(f);
	if (JSONOUT) { console.log(JSON.stringify(r)); continue; }
	console.log(`${r.file}  (${r.mp} points a day, guards ${r.guards}; reach / owned, towns mines dwellings banks high loot)`);
	for (const s of r.starts) console.log('  ' + s.colour.padEnd(7) + s.days.map(d => `d${d.day} ${KINDS.map(K => `${d.reach[K]}/${fmt(d.own[K]).trim()}`).join(' ')}`).join(' | '));
	const spread = (K, day) => { const v = r.starts.map(s => s.days[day - 1].own[K]); return Math.max(...v) - Math.min(...v); };
	console.log('  spread of owned (best start minus worst): ' + r.starts[0].days.map(d => `d${d.day} towns ${fmt(spread('town', d.day)).trim()} mines ${fmt(spread('mine', d.day)).trim()}`).join(', '));
}
