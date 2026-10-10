'use strict';
/**
 * lootswap.js - the dear pickups go where the guards are: on the final layout, a relic, major artifact, Pandora's box,
 * spell scroll or artifact a hero can walk to past no guard trades places with a cheap pickup (a resource, a chest, a
 * campfire, a minor or treasure artifact) of the same zone that only a fight reaches.
 *
 * The engine builds each treasure pile round its value and puts the guard on its one way in (TreasurePlacer), so its
 * dear loot is the guarded loot. Ours lays the loot first and walls a pocket round each guard's target afterwards, and
 * about half those pockets stay open (a wall there would cut a path, or sits on a road or another object's way in):
 * Coldshadow's Fantasy, 2026-10-02, relics, majors and Pandora's boxes open 59 to 73 a map against the engine's 11 to
 * 43, high loot open 22 to 30% against 10 to 19% (mapsight gate). The pockets that did close mostly hold cheap things.
 *
 * Open and guarded are measured as mapsight measures them (tools/mapsight/lib/sight.js openAccess): ground outside
 * every monster's 3x3 ring, 8-connected, in pieces; a pickup is open when a tile it is taken from lies in a piece of
 * more than 30 tiles. When the cheap pickup's guard watches nothing but pickups and is weaker than the one beside the
 * dear pickup (if any), the two guards trade creatures too, so the strong guard stays with the dear loot.
 * VMAPGEN_LOOT_SWAP=0 skips it.
 */

const N8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const POCKET = 30;
// dearest first
const HIGH = ['randomArtifactRelic', 'randomArtifactMajor', 'pandoraBox', 'artifact', 'spellScroll'];
// cheapest first
const LOW = ['resource', 'randomResource', 'campfire', 'treasureChest', 'randomArtifactTreasure', 'randomArtifactMinor', 'randomArtifact'];
const isMonster = o => o.type === 'monster' || /^randomMonster/.test(o.type);
const tierOf = o => { const m = /^randomMonsterLevel(\d)/.exec(o.type); return m ? +m[1] : 0; };

function swapLoot(plan, W, H, l, blocked, OCCUPIED, REMOVABLE, blockingCells, visitableCells) {
	const objs = plan.objects.filter(o => (o.l || 0) === l && o.template && o.template.mask);
	const zoneOf = plan.zone;
	if (!zoneOf || !objs.length) return { swapped: 0, guards: 0, moved: 0 };
	const base = l * W * H, N = W * H;
	const inb = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
	// hard: blocked by something that stays (rock, water, a building, scenery); a pickup or a monster does not count
	const owners = new Map();
	for (const o of objs)
		for (const [x, y] of blockingCells(o.template, o.x, o.y)) {
			if (!inb(x, y)) continue;
			const c = y * W + x;
			if (!owners.has(c)) owners.set(c, []);
			owners.get(c).push(o);
		}
	const hard = new Uint8Array(N);
	for (let c = 0; c < N; c++) {
		if (!(blocked[base + c] & OCCUPIED)) continue;
		const own = owners.get(c);
		hard[c] = !own || !own.every(o => REMOVABLE.has(o.type)) ? 1 : 0;
	}
	const monsters = objs.filter(isMonster);
	const ring = new Int32Array(N).fill(-1);
	monsters.forEach((m, i) => { for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (inb(m.x + dx, m.y + dy)) ring[(m.y + dy) * W + m.x + dx] = i; });
	const piece = new Int32Array(N).fill(-1), size = [];
	for (let s = 0; s < N; s++) {
		if (hard[s] || ring[s] >= 0 || piece[s] >= 0) continue;
		const id = size.length, st = [s];
		piece[s] = id;
		let n = 0;
		while (st.length) {
			const c = st.pop(), x = c % W, y = (c / W) | 0;
			n++;
			for (const [dx, dy] of N8) {
				const nx = x + dx, ny = y + dy;
				if (!inb(nx, ny)) continue;
				const m = ny * W + nx;
				if (!hard[m] && ring[m] < 0 && piece[m] < 0) { piece[m] = id; st.push(m); }
			}
		}
		size.push(n);
	}
	const oneTile = o => { const b = blockingCells(o.template, o.x, o.y); const v = visitableCells(o.template, o.x, o.y); return b.length <= 1 && v.length === 1; };
	const approach = o => { const out = []; for (const [vx, vy] of visitableCells(o.template, o.x, o.y)) for (const [dx, dy] of N8) if (inb(vx + dx, vy + dy)) out.push((vy + dy) * W + vx + dx); return out; };
	const open = o => approach(o).some(c => piece[c] >= 0 && size[piece[c]] > POCKET);
	// the guard whose ring takes in an approach tile, nearest first
	const guardOf = o => {
		let best = null, bd = 9;
		for (const c of approach(o)) if (ring[c] >= 0) { const m = monsters[ring[c]], d = Math.max(Math.abs(m.x - o.x), Math.abs(m.y - o.y)); if (d < bd) { bd = d; best = m; } }
		return best;
	};
	const nearGuard = o => { let best = null, bd = 3; for (const m of monsters) { const d = Math.max(Math.abs(m.x - o.x), Math.abs(m.y - o.y)); if (d < bd) { bd = d; best = m; } } return best; };
	// a guard watching nothing but pickups: the tiles round its ring are no building's way in
	const pickupsOnly = m => {
		for (const o of objs) {
			if (o === m || isMonster(o) || HIGH.includes(o.type) || LOW.includes(o.type)) continue;
			if (Math.abs(o.x - m.x) > 6 || Math.abs(o.y - m.y) > 6) continue;
			if (approach(o).some(c => ring[c] >= 0 && monsters[ring[c]] === m)) return false;
		}
		return true;
	};
	const zone = o => zoneOf[o.y * W + o.x];
	const highs = objs.filter(o => HIGH.includes(o.type) && oneTile(o) && open(o)).sort((a, b) => HIGH.indexOf(a.type) - HIGH.indexOf(b.type));
	const lows = objs.filter(o => LOW.includes(o.type) && oneTile(o) && !open(o));
	// the engine leaves some of its dear loot open too (Coldshadow's Fantasy: 10 to 19% of it): swap only down to that
	// share (VMAPGEN_LOOT_OPEN, default 0.14), dearest first
	const all = objs.filter(o => HIGH.includes(o.type)).length;
	const keepOpen = Math.round(all * Number(process.env.VMAPGEN_LOOT_OPEN || 0.14));
	let stillOpen = objs.filter(o => HIGH.includes(o.type) && open(o)).length;
	const used = new Set();
	let swapped = 0, guards = 0;
	// the share left open is the engine's mix: its open dear loot is spell scrolls and plain artifacts (most in start zones);
	// its relics, majors and Pandora's boxes are almost never open (Coldshadow's Fantasy junctions 2 of 64 high loot open,
	// ours 18 of 67 with 9 Pandora's boxes, 2026-10-03). So those three always trade; the share applies to the rest.
	const DEAREST = new Set(['randomArtifactRelic', 'randomArtifactMajor', 'pandoraBox']);
	for (const h of highs) {
		if (stillOpen <= keepOpen && !DEAREST.has(h.type)) break;
		const z = zone(h);
		const cand = lows.filter(o => !used.has(o) && zone(o) === z)
			.sort((a, b) => LOW.indexOf(a.type) - LOW.indexOf(b.type) || (Math.abs(a.x - h.x) + Math.abs(a.y - h.y)) - (Math.abs(b.x - h.x) + Math.abs(b.y - h.y)));
		const lo = cand[0];
		if (!lo) continue;
		used.add(lo);
		const gl = guardOf(lo), gh = nearGuard(h);
		[h.x, h.y, lo.x, lo.y] = [lo.x, lo.y, h.x, h.y];
		swapped++; stillOpen--;
		if (gl && gh && gl !== gh && tierOf(gl) < tierOf(gh) && pickupsOnly(gl)) {
			for (const k of ['type', 'options', 'guardCreature', 'subtype', 'template'])
				[gl[k], gh[k]] = [gh[k], gl[k]];
			guards++;
		}
	}
	// A relic, major or Pandora's box still open with no guarded cheap pickup to trade with moves onto a free tile inside a
	// guarded pocket of its zone (a piece of POCKET tiles or fewer, every neighbour wall, a guard's ring or the same
	// pocket), within 12 tiles: the junctions of Coldshadow's Fantasy kept 9 open Pandora's boxes for want of a partner
	// (2026-10-03). VMAPGEN_LOOT_POCKET_MOVE=0 off.
	let moved = 0;
	if (process.env.VMAPGEN_LOOT_POCKET_MOVE !== '0') {
		const taken = new Set();
		for (const o of objs) for (const [x, y] of blockingCells(o.template, o.x, o.y)) if (inb(x, y)) taken.add(y * W + x);
		for (const o of objs) for (const [x, y] of visitableCells(o.template, o.x, o.y)) if (inb(x, y)) taken.add(y * W + x);
		const inPocket = c => piece[c] >= 0 && size[piece[c]] <= POCKET;
		for (const h of objs.filter(o => DEAREST.has(o.type) && oneTile(o) && open(o))) {
			const z = zone(h);
			let best = -1, bd = 13;
			for (let dy = -12; dy <= 12; dy++) for (let dx = -12; dx <= 12; dx++) {
				const x = h.x + dx, y = h.y + dy;
				if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
				const c = y * W + x, d = Math.max(Math.abs(dx), Math.abs(dy));
				if (d >= bd || zoneOf[c] !== z || taken.has(c) || blocked[base + c] || !inPocket(c)) continue;
				let ok = true;
				for (const [ex, ey] of N8) {
					const m = (y + ey) * W + x + ex;
					if (!(hard[m] || ring[m] >= 0 || piece[m] === piece[c])) { ok = false; break; }
				}
				if (!ok) continue;
				best = c; bd = d;
			}
			if (best < 0) continue;
			const old = h.y * W + h.x;
			blocked[base + old] &= ~OCCUPIED;
			taken.delete(old);
			h.x = best % W; h.y = (best / W) | 0;
			blocked[base + best] |= OCCUPIED;
			taken.add(best);
			moved++;
		}
	}
	return { swapped, guards, moved };
}

module.exports = { swapLoot };
