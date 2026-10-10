'use strict';
/**
 * roadweb.js - every road joins the starts' roads: on the final layout, a road net no start can ride to is joined to
 * the one that can, over ground no permanent object blocks, on its own level or through a gate or monolith pair.
 *
 * The engine's Coldshadow's Fantasy maps have one road net each, every town on it (12 seeds, 25 of 25 towns joined by
 * road to a start). Ours had 4 to 11 nets and 12 to 22 of 25 towns joined (MapGen Dev's look at K's route and
 * .tmp\opus-seeing\roadweb.js, 2026-10-02): roads laid zone by zone, with some links carrying none, left whole groups
 * of towns on islands of road. Each round: the nets are found and joined through link pairs whose ends both have road
 * on a way in; the start nets grow by a breadth-first search over passable ground to the nearest tile of another net
 * or the way in of a link end whose other end is not joined yet, at most 90 steps, and that path becomes road. A link
 * end reached that way gets road on its partner's way in, and that tile then joins the nearest road on its own level.
 * VMAPGEN_ROAD_WEB=0 skips it.
 */

const N8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

function joinRoadNets(plans, W, H, blocked, OCCUPIED, REMOVABLE, blockingCells, visitableCells) {
	if (process.env.VMAPGEN_ROAD_WEB === '0') return { joined: 0, rounds: 0 };
	const L = plans.length, WH = W * H;
	const inb = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
	// hard ground per level: blocked by something that stays
	const hard = [];
	const objsOf = l => plans[l].objects.filter(o => (o.l || 0) === l && o.template && o.template.mask);
	for (let l = 0; l < L; l++) {
		const owners = new Map(), h = new Uint8Array(WH);
		for (const o of objsOf(l)) for (const [x, y] of blockingCells(o.template, o.x, o.y)) {
			if (!inb(x, y)) continue;
			const c = y * W + x;
			if (!owners.has(c)) owners.set(c, []);
			owners.get(c).push(o);
		}
		for (let c = 0; c < WH; c++) {
			if (!(blocked[l * WH + c] & OCCUPIED)) continue;
			const own = owners.get(c);
			h[c] = !own || !own.every(o => REMOVABLE.has(o.type)) ? 1 : 0;
		}
		hard.push(h);
	}
	const ways = o => {
		const vf = o.template.visitableFrom || ['+++', '+-+', '+++'], out = [];
		for (const [vx, vy] of visitableCells(o.template, o.x, o.y))
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				if ((!dx && !dy) || (vf[dy + 1] || '')[dx + 1] !== '+') continue;
				if (inb(vx + dx, vy + dy) && !hard[o.l || 0][(vy + dy) * W + vx + dx]) out.push((vy + dy) * W + vx + dx);
			}
		return out;
	};
	// link pairs: gates share a pairId (or stand at one x,y on both levels), monoliths share type and subtype
	const pairs = [];
	const gates = [], monos = new Map();
	for (let l = 0; l < L; l++) for (const o of objsOf(l)) {
		if (o.type === 'subterraneanGate') gates.push(o);
		else if (/^monolith/.test(o.type)) { const k = `${o.type}|${o.subtype}|${o.pairId || ''}`; if (!monos.has(k)) monos.set(k, []); monos.get(k).push(o); }
	}
	const byGate = new Map();
	for (const g of gates) { const k = g.pairId || `${g.x},${g.y}`; if (!byGate.has(k)) byGate.set(k, []); byGate.get(k).push(g); }
	for (const list of [...byGate.values(), ...monos.values()]) if (list.length >= 2) pairs.push(list);
	const towns = [];
	for (let l = 0; l < L; l++) for (const o of objsOf(l)) if (o.type === 'town' || o.type === 'randomTown') towns.push(o);
	const starts = towns.filter(t => t.options && t.options.owner);
	if (!starts.length) return { joined: 0, rounds: 0 };
	let joined = 0, round = 0;
	for (; round < 60; round++) {
		// nets: road pieces per level, then joined through link pairs
		const comp = plans.map(() => new Int32Array(WH).fill(-1));
		let n = 0;
		for (let l = 0; l < L; l++) for (const s of plans[l].roadCells || []) {
			if (comp[l][s] >= 0) continue;
			const st = [s]; comp[l][s] = n;
			while (st.length) {
				const c = st.pop(), x = c % W, y = (c / W) | 0;
				for (const [dx, dy] of N8) { const m = (y + dy) * W + x + dx; if (inb(x + dx, y + dy) && plans[l].roadCells.has(m) && comp[l][m] < 0) { comp[l][m] = n; st.push(m); } }
			}
			n++;
		}
		const par = Array.from({ length: n }, (_, i) => i);
		const find = a => (par[a] === a ? a : (par[a] = find(par[a])));
		const pieceOf = o => { const l = o.l || 0; const v = visitableCells(o.template, o.x, o.y).filter(([x, y]) => inb(x, y)).map(([x, y]) => y * W + x); return [...new Set([...ways(o), ...v].filter(c => comp[l][c] >= 0).map(c => comp[l][c]))]; };
		for (const list of pairs) { const ps = list.flatMap(pieceOf); for (const p of ps) par[find(p)] = find(ps[0]); }
		for (const t of towns) { const ps = pieceOf(t); for (const p of ps) par[find(p)] = find(ps[0]); }
		const main = new Set(starts.flatMap(pieceOf).map(find));
		if (!main.size) break;
		const isMain = (l, c) => comp[l][c] >= 0 && main.has(find(comp[l][c]));
		let left = 0;
		for (let i = 0; i < n; i++) if (!main.has(find(i))) left++;
		// link ends whose other end is not on the main net yet
		const openEnds = [], halfEnds = [];
		for (const list of pairs) {
			const onMain = list.filter(o => pieceOf(o).some(p => main.has(find(p))));
			if (onMain.length && onMain.length < list.length) { for (const o of list) if (!onMain.includes(o)) halfEnds.push(o); continue; }
			if (!onMain.length) for (const o of list) openEnds.push(o);
		}
		// a pair with one end on the starts' net: the other end's way in gets road, joined to the nearest road on its
		// level (seed 1: zones 16 and 8 hung off a pair whose far end had none)
		let laid = 0;
		for (const o of halfEnds) laid += roadFromEnd(o);
		joined += laid;
		if (laid) continue;
		if (!left && !openEnds.length) break;
		// grow the main net by the shortest path to anything not on it, level by level
		let best = null;
		for (let l = 0; l < L; l++) {
			const goalEnd = new Map();
			for (const o of openEnds) if ((o.l || 0) === l) for (const c of ways(o)) goalEnd.set(c, o);
			const prev = new Int32Array(WH).fill(-2), front = [];
			for (const c of plans[l].roadCells || []) if (isMain(l, c)) { prev[c] = -1; front.push(c); }
			if (!front.length) continue;
			let hit = -1, cur = front, step = 0;
			for (; step < 90 && cur.length && hit < 0; step++) {
				const next = [];
				for (const c of cur) {
					const x = c % W, y = (c / W) | 0;
					for (const [dx, dy] of N8) {
						if (!inb(x + dx, y + dy)) continue;
						const m = (y + dy) * W + x + dx;
						if (prev[m] !== -2 || hard[l][m]) continue;
						prev[m] = c;
						if ((comp[l][m] >= 0 && !isMain(l, m)) || goalEnd.has(m)) { hit = m; break; }
						next.push(m);
					}
					if (hit >= 0) break;
				}
				cur = next;
			}
			if (hit >= 0 && (!best || step < best.step)) best = { l, hit, prev, step, end: goalEnd.get(hit) };
		}
		if (!best) break;
		const { l, hit, prev } = best;
		for (let k = hit; k >= 0 && !isMain(l, k); k = prev[k]) if (!plans[l].roadCells.has(k)) { plans[l].roadCells.add(k); joined++; }
		// through a link: road on each partner end's way in, joined to the nearest road on its level
		if (best.end) {
			const list = pairs.find(p => p.includes(best.end)) || [];
			for (const o of list) if (o !== best.end) joined += roadFromEnd(o);
		}
	}
	return { joined, rounds: round };

	function roadFromEnd(o) {
				let added = 0;
				const ol = o.l || 0, w = ways(o);
				if (!w.length) return 0;
				const from = w[0];
				const prev2 = new Int32Array(WH).fill(-2);
				prev2[from] = -1;
				let cur2 = [from], hit2 = plans[ol].roadCells.has(from) ? from : -1;
				for (let step = 0; step < 90 && cur2.length && hit2 < 0; step++) {
					const next = [];
					for (const c of cur2) {
						const x = c % W, y = (c / W) | 0;
						for (const [dx, dy] of N8) {
							if (!inb(x + dx, y + dy)) continue;
							const m = (y + dy) * W + x + dx;
							if (prev2[m] !== -2 || hard[ol][m]) continue;
							prev2[m] = c;
							if (plans[ol].roadCells.has(m)) { hit2 = m; break; }
							next.push(m);
						}
						if (hit2 >= 0) break;
					}
					cur2 = next;
				}
				if (!plans[ol].roadCells.has(from)) { plans[ol].roadCells.add(from); added++; }
				if (hit2 >= 0) for (let k = prev2[hit2]; k >= 0; k = prev2[k]) if (!plans[ol].roadCells.has(k)) { plans[ol].roadCells.add(k); added++; }
				return added;
	}
}

module.exports = { joinRoadNets };
