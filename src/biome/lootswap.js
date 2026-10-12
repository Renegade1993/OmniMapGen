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

function swapLoot(plan, W, H, l, blocked, OCCUPIED, REMOVABLE, blockingCells, visitableCells, opts = {}) {
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
	// a piece holding a town's doorstep is open whatever its size: a hero leaves the town into it (the Opus Reviewer's R28: a Pandora's box in a
	// 29-tile piece in front of the preserve at (45,48), seed 670084743, counted as a guarded pocket)
	const atDoor = new Set();
	for (const o of objs) if (/^(town|randomTown)$/.test(o.type))
		for (const [vx, vy] of visitableCells(o.template, o.x, o.y)) for (const [dx, dy] of N8) if (inb(vx + dx, vy + dy)) { const c = (vy + dy) * W + vx + dx; if (piece[c] >= 0) atDoor.add(piece[c]); }
	const open = o => approach(o).some(c => piece[c] >= 0 && (size[piece[c]] > POCKET || atDoor.has(piece[c])));
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
	// shut as the flyer rule reads it: its own tile in a ring, or every tile it is taken from blocked or in a ring (a pocket under POCKET tiles
	// with no guard at all let a flying hero land and take a Pandora's box traded into it: 36x36 eight players f36p8, (2,13)); the late calls
	// (opts.anyZone) take only such partners
	// and, since these trades run after the pass that posts a guard beside every dear pile, a monster on or beside the tile itself: a flying hero
	// lands anywhere, and a pile shut by walls with its guard two tiles off was open to one (MapGen Dev's flyer-open on e3d7d30: xl-p4-islands
	// s802051433 relic (46,59), s802051434 Pandora's box (72,61), small-ug s1750425234 Pandora's box L1 (4,11))
	const besideMonster = (x, y) => monsters.some(m => Math.max(Math.abs(m.x - x), Math.abs(m.y - y)) <= 1);
	const shut = o => {
		if (!besideMonster(o.x, o.y)) return false;
		const at = o.y * W + o.x;
		if (inb(o.x, o.y) && ring[at] >= 0) return true;
		return approach(o).every(c => hard[c] || ring[c] >= 0);
	};
	const lows = objs.filter(o => LOW.includes(o.type) && oneTile(o) && !open(o) && (!opts.anyZone || shut(o)));
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
		const inPocket = c => piece[c] >= 0 && size[piece[c]] <= POCKET && !atDoor.has(piece[c]);
		for (const h of objs.filter(o => DEAREST.has(o.type) && oneTile(o) && open(o))) {
			const z = zone(h);
			let best = -1, bd = 13;
			for (let dy = -12; dy <= 12; dy++) for (let dx = -12; dx <= 12; dx++) {
				const x = h.x + dx, y = h.y + dy;
				if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
				const c = y * W + x, d = Math.max(Math.abs(dx), Math.abs(dy));
				if (d >= bd || zoneOf[c] !== z || taken.has(c) || blocked[base + c] || !inPocket(c)) continue;
				if (opts.anyZone && !besideMonster(x, y)) continue;
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
	// Last, a relic, major or Pandora's box still open trades with the nearest guarded cheap pickup of any zone: its own zone had no partner and no
	// pocket (the Opus Reviewer's R28: the Pandora's box at (44,51) beside the preserve at (45,48), 108x108 four players seed 670084743, where a
	// guard's ring would cover the town's doorstep). Only on the late call (opts.anyZone, after the guards left the doorsteps: an early
	// trade into a pocket a doorstep guard still shut put a second box there). VMAPGEN_LOOT_ANY_ZONE=0 off.
	if (opts.anyZone && process.env.VMAPGEN_LOOT_ANY_ZONE !== '0')
		for (const h of objs.filter(o => DEAREST.has(o.type) && oneTile(o) && open(o))) {
			// a guarded spell scroll or plain artifact is a partner too here: those may stand open (the engine's own open dear loot), a major may not
			// (36x36 eight players a36p8: every guarded cheap pickup was taken and a major stood open beside a start's road at (25,4))
			// only into a zone of the same class (the Opus Reviewer's R36: the trade moved relics, majors and Pandora's boxes out of the high-loot
			// zones and into player zones, seed 670084743 high-loot 25 to 18), and a partner whose guard is level 4 or more first (dear loot behind a
			// level 1 or 2 guard rose from 13 to 17 there)
			const cls = plan.classes, hc = cls ? cls[zone(h)] : undefined;
			const tierAt = o => { const g = guardOf(o); return g ? tierOf(g) : 0; };
			// a player zone's dear loot stays in that zone: no start gets another's (the lead, 15:20: never into a player start zone)
			const pool = lows.concat(objs.filter(o => (o.type === 'spellScroll' || o.type === 'artifact') && oneTile(o) && shut(o) && !open(o)))
				.filter(o => !cls || (cls[zone(o)] === hc && (hc !== 'player' || zone(o) === zone(h))));
			const lo = pool.filter(o => !used.has(o)).sort((a, b) => ((tierAt(a) >= 4 ? 0 : 1) - (tierAt(b) >= 4 ? 0 : 1))
				|| (Math.abs(a.x - h.x) + Math.abs(a.y - h.y)) - (Math.abs(b.x - h.x) + Math.abs(b.y - h.y)))[0];
			if (!lo) continue;
			used.add(lo);
			const gl = guardOf(lo), gh = nearGuard(h);
			[h.x, h.y, lo.x, lo.y] = [lo.x, lo.y, h.x, h.y];
			swapped++;
			// the stronger guard stays with the dear object, as in the same-zone trade above
			if (gl && gh && gl !== gh && tierOf(gl) < tierOf(gh) && pickupsOnly(gl)) {
				for (const k of ['type', 'options', 'guardCreature', 'subtype', 'template'])
					[gl[k], gh[k]] = [gh[k], gl[k]];
				guards++;
			}
		}
	return { swapped, guards, moved };
}

module.exports = { swapLoot };
