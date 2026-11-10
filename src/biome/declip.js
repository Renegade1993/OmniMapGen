'use strict';
/**
 * declip.js - no pickup under a monster's sprite (K, 2026-10-04: "multi-grid creatures improperly placed clipping onto loot": a fire
 * horse drawn over a chest).
 *
 * A creature's map sprite is 64x64 with its bottom-right corner on its tile (tools/harness/creature_extents.js: 130 of 141 core
 * creatures cover the tile to the left and the tile above, the rest one of them), so a monster hides what stands on its own tile, the
 * tile to its left, the tile above it and the one diagonally up and left. Placement keeps new guards off those sides of their targets
 * (content.js monsterClips), but later passes move and add loot beside guards (the pocket gather, the loot swap, relocations), and a
 * guard may stand on a pickup (footprintFits soft). This is the last word: every one-tile pickup in a monster's shadow moves to a free
 * free tile within two of the monster on the clear side (right and below), where a hero reaches it past the same guard. A pickup with no
 * such tile stays. VMAPGEN_DECLIP=0 skips it. Returns { moved, left }.
 */
const OCCUPIED = 1, RESERVED = 2;
const MON = /^(monster|randomMonster)/;
const PICKUP = /^(resource|randomResource|treasureChest|campfire|randomArtifact|artifact|spellScroll|pandoraBox|seaChest)/;
const CHEAP = /^(resource|randomResource|treasureChest|campfire)/;
const SHADOW = [[0, 0], [-1, 0], [0, -1], [-1, -1]];
// where a pickup may go: within two tiles of the monster, ahead of its sprite (right and below), nearest first
const CLEAR = [];
for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (dx > 0 || dy > 0 || (dx === -1 && dy > 0) || (dy === -1 && dx > 0)) CLEAR.push([dx, dy]);
CLEAR.sort((a, b) => Math.max(Math.abs(a[0]), Math.abs(a[1])) - Math.max(Math.abs(b[0]), Math.abs(b[1])) || (a[0] * a[0] + a[1] * a[1]) - (b[0] * b[0] + b[1] * b[1]));

function declipMonsters(plan, W, H, l, blocked, blockingCells, footprintCells) {
	const out = { moved: 0, left: 0 };
	const base = l * W * H;
	const objs = plan.objects.filter(o => (o.l || 0) === l && o.template && o.template.mask);
	const monsters = objs.filter(o => MON.test(o.type));
	const shadow = new Set();
	for (const m of monsters) for (const [dx, dy] of SHADOW) { const x = m.x + dx, y = m.y + dy; if (x >= 0 && y >= 0 && x < W && y < H) shadow.add(y * W + x); }
	const inMap = ([x, y]) => x >= 0 && y >= 0 && x < W && y < H;
	const cellsOf = (o, x, y) => footprintCells(o.template, x, y).filter(inMap).map(([cx, cy]) => cy * W + cx);
	const solid = new Set();
	for (const o of objs) for (const c of cellsOf(o, o.x, o.y)) solid.add(c);
	const roads = plan.roadCells || new Set();
	const one = o => { const b = blockingCells(o.template, o.x, o.y); return b.length === 1 && b[0][0] === o.x && b[0][1] === o.y; };
	// only where a hero reaches by fighting (lootswap.js fightMap): a tile beside the monster can be a hole walled in on every side, and a
	// mercury moved into one (pw_040, 180x180 two levels seed 1040, (160,141))
	const fought = require('./lootswap').fightMap(plan.objects, W, H, l, blocked, OCCUPIED, o => MON.test(o.type) || PICKUP.test(o.type), blockingCells);
	for (const p of objs) {
		if (!PICKUP.test(p.type) || p.__walled || !one(p) || !cellsOf(p, p.x, p.y).some(c => shadow.has(c))) continue;
		let done = false;
		// every stack whose ring holds it now still does where it goes, as declipPictures keeps it: a relic moved two tiles below its only
		// guard stood in no ring, open to a flyer (K's map seed 1479105351, (75,68) under the overseer (75,66), 2026-10-23). VMAPGEN_DECLIP_RING=0 off.
		const ring = (x, y) => monsters.filter(m => Math.max(Math.abs(m.x - x), Math.abs(m.y - y)) <= 1);
		// (artifacts, Pandora's boxes, scrolls and prisons; a resource, a chest or a campfire may still go two tiles off, as before)
		const watched = process.env.VMAPGEN_DECLIP_RING !== '0' && /^(randomArtifact|artifact|pandoraBox|spellScroll|prison)/.test(p.type) ? ring(p.x, p.y) : [];
		for (const m of monsters) {
			if (done) break;
			const own = cellsOf(p, p.x, p.y);
			if (!own.some(c => SHADOW.some(([dx, dy]) => (m.y + dy) * W + m.x + dx === c))) continue;
			for (const [dx, dy] of CLEAR) {
				const x = m.x + dx, y = m.y + dy, c = y * W + x;
				if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
				if (watched.length && !watched.every(g => Math.max(Math.abs(g.x - x), Math.abs(g.y - y)) <= 1)) continue;
				if (blocked[base + c] & (OCCUPIED | RESERVED) || roads.has(c) || !fought(c)) continue;
				if (plan.openMask && !plan.openMask[c]) continue;
				if (plan.p && plan.p.water && plan.p.water[c]) continue;
				if (plan.zone && plan.zone[c] !== plan.zone[p.y * W + p.x]) continue;
				const fp = cellsOf(p, x, y);
				if (fp.length !== footprintCells(p.template, x, y).length) continue;
				if (fp.some(f => (solid.has(f) && !own.includes(f)) || shadow.has(f))) continue;
				blocked[base + p.y * W + p.x] &= ~OCCUPIED;
				blocked[base + c] |= OCCUPIED;
				for (const f of own) solid.delete(f);
				for (const f of fp) solid.add(f);
				p.x = x; p.y = y;
				out.moved++; done = true;
				break;
			}
		}
		// no free tile for a dear one: it trades places with a cheap pickup in sight that every stack watching it also watches, so the same tiles
		// stay taken and the guards keep the same ground; the cheap one goes under the picture (K, 2026-10-22: "Hellsteed standing on a tome
		// of water"; the dear piles under a monster were 80 a map on his options). VMAPGEN_DECLIP_SWAP=0 off.
		if (!done && watched.length && process.env.VMAPGEN_DECLIP_SWAP !== '0') {
			const own = cellsOf(p, p.x, p.y);
			for (const q of objs) {
				if (q === p || !CHEAP.test(q.type) || q.__walled || !one(q)) continue;
				if (!watched.every(g => Math.max(Math.abs(g.x - q.x), Math.abs(g.y - q.y)) <= 1)) continue;
				if (plan.zone && plan.zone[q.y * W + q.x] !== plan.zone[p.y * W + p.x]) continue;
				if (cellsOf(q, q.x, q.y).some(c => shadow.has(c))) continue;
				// visited from the same sides, so neither lands where its own way in is shut (a lost wagon, visited from below only, swapped onto a
				// relic's tile whose lower side was taken sealed a Goblin Tower behind it: K's October 18th seed 1244039256)
				const vf = o => JSON.stringify(o.template.visitableFrom || ['+++', '+-+', '+++']);
				if (vf(q) !== vf(p)) continue;
				const qo = cellsOf(q, q.x, q.y);
				const [px, py] = [p.x, p.y];
				for (const f of own.concat(qo)) solid.delete(f);
				p.x = q.x; p.y = q.y; q.x = px; q.y = py;
				for (const f of cellsOf(p, p.x, p.y).concat(cellsOf(q, q.x, q.y))) solid.add(f);
				out.swapped = (out.swapped || 0) + 1; done = true;
				break;
			}
		}
		if (!done) out.left++;
	}
	return out;
}

/**
 * No pickup half hidden under another object's picture (K, 2026-10-18 via the lead: "crawling grids around instances of the shield and finding
 * cases where the art could be overlapped"). The placers leave a template's 'V' cells (drawn, walkable) free for walking (content.js
 * blockingCells), so a pickup could stand where a building, a bank, a mine, a tree or a monster drawn after it covers it: on K's map seed
 * 1244039256 a crystal (23,36) wholly under the crystal cavern (24,37), a major artifact (106,45) half under a building, 41 pickups half hidden
 * or more (tools/harness/overlap_scan.js). Judged by the pixels the game draws (pictures.js: each sprite decoded and placed as the game places
 * it, in its draw order; an object the engine draws under everything, a lake or a crater, covers nothing), not by mask cells: a 'V' cell is
 * often bare sky above a roof. This runs last. A one-tile pickup half hidden or more moves to the nearest free tile within two (two off through
 * a free tile between) where less than a quarter of it is hidden, in the same zone, inside the ring of every monster that watched it, so a
 * hero reaches it past the same guards as before; with no such tile it stays. A sprite that cannot be read moves nothing.
 * VMAPGEN_DECLIP_ART=0 skips it. Returns { moved, left }.
 */
function declipPictures(plan, W, H, l, blocked, blockingCells, footprintCells, roots = [], prio = () => 0) {
	const out = { moved: 0, left: 0 };
	const R2B = process.env.VMAPGEN_DECLIP_R2 !== '0';
	const pics = require('./pictures');
	const base = l * W * H;
	const objs = plan.objects.filter(o => (o.l || 0) === l && o.template && o.template.mask);
	if (process.env.VMAPGEN_DECLIP_TRACE) console.error('[declip-objs] L' + l + ' ' + plan.objects.filter(o => (o.l || 0) === l).map(o => o.type + ':' + o.x + ',' + o.y).join(';'));
	const order = new Map(plan.objects.map((o, k) => [o, k]));
	const monsters = objs.filter(o => MON.test(o.type));
	if (process.env.VMAPGEN_DECLIP_TRACE) for (const o of plan.objects) if ((o.l || 0) === l && PICKUP.test(o.type) && !(o.template && o.template.mask)) console.error('[declip-notpl] ' + o.type + ':' + (o.subtype || '') + ' ' + o.x + ',' + o.y + ' L' + l + ' template ' + (o.template ? 'no mask' : 'none'));
	const inMap = ([x, y]) => x >= 0 && y >= 0 && x < W && y < H;
	const zOf = o => o.template.zIndex || prio(o.template.animation) || 0;
	// every object but the pickups, with its pixels by tile and what the draw order needs
	const byTile = new Map();
	for (const o of objs) {
		if (PICKUP.test(o.type) || zOf(o)) continue;
		const s = pics.spriteOf(o.template.animation, roots);
		if (!s) continue;
		const d = { o, cov: pics.coverage(o.x, o.y, s), x: o.x, y: o.y, z: 0, k: order.get(o), hero: o.type === 'hero', cls: o.type === 'hero' ? 3 : (!MON.test(o.type) && !o.template.mask.some(r => /[AT]/.test(r))) ? 0 : 1,
			cells: new Set(blockingCells(o.template, o.x, o.y).map(([a, b]) => a + ',' + b)) };
		for (const t of d.cov.keys()) { if (!byTile.has(t)) byTile.set(t, []); byTile.get(t).push(d); }
	}
	// the share of pickup p's picture that objects drawn after it cover when it stands at (x, y)
	const hidden = (p, s, x, y) => {
		const me = { x, y, z: 0, k: order.get(p), hero: false, cells: new Set([x + ',' + y]), cls: 1 };
		let own = 0, under = 0, under2 = 0;
		for (const [t, rows] of pics.coverage(x, y, s)) {
			const u = new Uint32Array(32), u2 = new Uint32Array(32);
			for (const d of byTile.get(t) || []) {
				if (pics.drawnBefore(me, d)) { const r = d.cov.get(t); for (let i = 0; i < 32; i++) u[i] |= r[i]; }
				if (R2B && pics.drawnBeforeR2b(me, d)) { const r = d.cov.get(t); for (let i = 0; i < 32; i++) u2[i] |= r[i]; }
			}
			for (let i = 0; i < 32; i++) { own += pics.pop(rows[i]); under += pics.pop((rows[i] & u[i]) >>> 0); under2 += pics.pop((rows[i] & u2[i]) >>> 0); }
		}
		return own ? [under / own, under2 / own] : [0, 0];
	};
	const solid = new Set();
	for (const o of objs) for (const [a, b] of blockingCells(o.template, o.x, o.y)) if (inMap([a, b])) solid.add(b * W + a);
	// the ways in to every building, mine, bank and other non-pickup object: no pickup moves onto one (the APPROACH marks can not tell this,
	// a pickup's own placement marks its eight neighbours too, which left 37 of 43 half-hidden pickups unmoved on K's map seed 1244039256)
	const doors = new Set();
	for (const o of objs) {
		if (PICKUP.test(o.type) || MON.test(o.type)) continue;
		const vf = o.template.visitableFrom || [], m = o.template.mask;
		for (let i = 0; i < m.length; i++) for (let j = 0; j < m[i].length; j++) {
			if (m[i][j] !== 'A' && m[i][j] !== 'T') continue;
			const vx = o.x - (m[i].length - 1 - j), vy = o.y - (m.length - 1 - i);
			for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) if (vf[r] && vf[r][k] === '+' && inMap([vx + k - 1, vy + r - 1])) doors.add((vy + r - 1) * W + vx + k - 1);
		}
	}
	const roads = plan.roadCells || new Set();
	const one = o => { const b = blockingCells(o.template, o.x, o.y); return b.length === 1 && b[0][0] === o.x && b[0][1] === o.y; };
	const ringOf = c => monsters.filter(m => Math.max(Math.abs(m.x - (c % W)), Math.abs(m.y - ((c / W) | 0))) <= 1);
	const walk = c => !(blocked[base + c] & OCCUPIED) && (!plan.openMask || plan.openMask[c]) && !(plan.p && plan.p.water && plan.p.water[c]);
	// out to four tiles (left-widen row 2; VMAPGEN_DECLIP_WIDE=0 keeps two), nearest first
	const REACH = process.env.VMAPGEN_DECLIP_WIDE === '0' ? 2 : 4;
	const NEAR = [];
	for (let dy = -REACH; dy <= REACH; dy++) for (let dx = -REACH; dx <= REACH; dx++) if (dx || dy) NEAR.push([dx, dy]);
	NEAR.sort((a, b) => Math.max(Math.abs(a[0]), Math.abs(a[1])) - Math.max(Math.abs(b[0]), Math.abs(b[1])) || (a[0] * a[0] + a[1] * a[1]) - (b[0] * b[0] + b[1] * b[1]));
	const fought = require('./lootswap').fightMap(plan.objects, W, H, l, blocked, OCCUPIED, o => MON.test(o.type) || PICKUP.test(o.type), blockingCells);
	for (const p of objs) {
		if (!PICKUP.test(p.type)) continue;
		if (p.__walled && process.env.VMAPGEN_DECLIP_TRACE) { const s0 = pics.spriteOf(p.template.animation, roots); if (s0) { const hw = hidden(p, s0, p.x, p.y); console.error('[declip-walled-h] ' + p.type + ' ' + p.x + ',' + p.y + ' L' + l + ' ' + hw[0].toFixed(3) + ' ' + hw[1].toFixed(3)); if (Math.max(hw[0], hw[1]) >= 0.25) { const me = { x: p.x, y: p.y, z: 0, k: order.get(p), hero: false, cells: new Set([p.x + ',' + p.y]), cls: 1 }; const who = new Map(); for (const [tt, rows] of pics.coverage(p.x, p.y, s0)) for (const d of byTile.get(tt) || []) { const r = d.cov.get(tt); let n = 0; for (let i = 0; i < 32; i++) n += pics.pop((rows[i] & r[i]) >>> 0); if (n && (pics.drawnBefore(me, d) || (R2B && pics.drawnBeforeR2b(me, d)))) who.set(d, (who.get(d) || 0) + n); } console.error('[declip-walled-by] ' + p.type + ' ' + p.x + ',' + p.y + ': ' + [...who].map(([d, n]) => d.o.type + ':' + String(d.o.template.animation).split('/').pop() + '@' + d.x + ',' + d.y + ' ' + n).join('; ')); } } }
		if (p.__walled || !one(p)) { if (process.env.VMAPGEN_DECLIP_TRACE) console.error('[declip-skip] ' + p.type + ':' + (p.subtype || '') + ' ' + p.x + ',' + p.y + ' L' + l + ' ' + (p.__walled ? 'walled' : 'not one tile')); continue; }
		const s = pics.spriteOf(p.template.animation, roots);
		if (!s) { if (process.env.VMAPGEN_DECLIP_TRACE) console.error('[declip-nospr] ' + p.type + ':' + (p.subtype || '') + ' ' + p.x + ',' + p.y + ' L' + l + ' ' + p.template.animation); continue; }
		// stock: half hidden or more (0.3.30); R2b, the order the engine is to ship: a quarter or more where stock shows it (under a tenth hidden), so R2b hides nothing stock showed
		const h0 = hidden(p, s, p.x, p.y);
		if (process.env.VMAPGEN_DECLIP_TRACE) console.error('[declip-h] ' + p.type + ':' + (p.subtype || '') + ' ' + p.x + ',' + p.y + ' L' + l + ' ' + h0[0].toFixed(3) + ' ' + h0[1].toFixed(3));
		const newly = R2B && h0[1] >= 0.25 && h0[0] < 0.10;
		if (h0[0] < 0.5 && !newly) continue;
		if (newly) out.r2b = (out.r2b || 0) + 1;
		const c0 = p.y * W + p.x, guards = ringOf(c0);
		let done = false;
		for (const [dx, dy] of NEAR) {
			const x = p.x + dx, y = p.y + dy, c = y * W + x;
			if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
			if (blocked[base + c] & (OCCUPIED | RESERVED) || doors.has(c) || roads.has(c) || !walk(c) || solid.has(c) || !fought(c)) continue;
			if (plan.zone && plan.zone[c] !== plan.zone[c0]) continue;
			const ring = ringOf(c);
			if (!guards.every(g => ring.includes(g))) continue;
			// two or more tiles off: a way the hero crosses, free tiles from a neighbour of the pickup to a neighbour of the new tile (for two off, one free tile beside both)
			if (Math.max(Math.abs(dx), Math.abs(dy)) >= 2) {
				let via = false;
				const seen = new Set(), q = [];
				for (let vy = -1; vy <= 1; vy++) for (let vx = -1; vx <= 1; vx++) {
					const nx = p.x + vx, ny = p.y + vy;
					if ((vx || vy) && inMap([nx, ny]) && walk(ny * W + nx)) { seen.add(ny * W + nx); q.push([nx, ny]); }
				}
				for (let h = 0; h < q.length && !via; h++) {
					const [cx, cy] = q[h];
					if (Math.abs(cx - x) <= 1 && Math.abs(cy - y) <= 1) { via = true; break; }
					for (let vy = -1; vy <= 1; vy++) for (let vx = -1; vx <= 1; vx++) {
						const nx = cx + vx, ny = cy + vy, k = ny * W + nx;
						if ((vx || vy) && inMap([nx, ny]) && !seen.has(k) && Math.abs(nx - p.x) <= REACH && Math.abs(ny - p.y) <= REACH && walk(k)) { seen.add(k); q.push([nx, ny]); }
					}
				}
				if (!via) continue;
			}
			const h1 = hidden(p, s, x, y);
			if (h1[0] >= 0.25 || h1[1] >= 0.25) continue;
			blocked[base + c0] &= ~OCCUPIED;
			blocked[base + c] |= OCCUPIED;
			solid.delete(c0); solid.add(c);
			if (process.env.VMAPGEN_DECLIP_TRACE) console.error('[declip-move] ' + p.type + ':' + (p.subtype || '') + ' ' + p.x + ',' + p.y + ' -> ' + x + ',' + y + ' L' + l + ' ' + Math.max(Math.abs(dx), Math.abs(dy)) + ' off');
			p.x = x; p.y = y;
			out.moved++; done = true; if (newly) out.r2bMoved = (out.r2bMoved || 0) + 1;
			break;
		}
		if (!done) { out.left++; if (process.env.VMAPGEN_DECLIP_TRACE) console.error('[declip-left] ' + p.type + ' ' + p.x + ',' + p.y + ' L' + l); }
	}
	return out;
}

module.exports = { declipMonsters, declipPictures };
