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
	for (const p of objs) {
		if (!PICKUP.test(p.type) || p.__walled || !one(p) || !cellsOf(p, p.x, p.y).some(c => shadow.has(c))) continue;
		let done = false;
		for (const m of monsters) {
			if (done) break;
			const own = cellsOf(p, p.x, p.y);
			if (!own.some(c => SHADOW.some(([dx, dy]) => (m.y + dy) * W + m.x + dx === c))) continue;
			for (const [dx, dy] of CLEAR) {
				const x = m.x + dx, y = m.y + dy, c = y * W + x;
				if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
				if (blocked[base + c] & (OCCUPIED | RESERVED) || roads.has(c)) continue;
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
		if (!done) out.left++;
	}
	return out;
}

module.exports = { declipMonsters };
