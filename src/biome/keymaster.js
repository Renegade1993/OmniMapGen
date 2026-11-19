'use strict';
/**
 * Keymaster pockets (S340, K 2026-11-19: "I would also like to have even a smattering of maps where there are keymasters like the oldschool maps").
 * 87 of the 161 original scenario files carry keymaster tents (tents 1 / 3 / 6 on those, border guards 0 / 2 / 5, colours 1 / 3 / 5: 10th, median and
 * 90th percentile), usually as a closed area whose doorway is shut by border guards of one colour and whose tent stands elsewhere on the map.
 *
 * A pocket: one zone that is not a player's, has no portal or gate, and has a few tiles where a hero can step across its border. Border guards of one
 * colour take every such tile (a monster standing on one is taken off it), so no step into or out of the zone is left; a tent of the same colour
 * stands on open ground in another zone that every start reaches without entering the pocket, and the starts reach each other without entering it.
 * Anything that fails is left out, so the map is made without the pocket (digest 38: a map is never refused for want of one, and no player is shut off
 * a tent). It runs at the end of generate.js, after every pass that judges what is reachable, on one-level maps; a map of two levels gets none yet.
 * VMAPGEN_KEYMASTERS=0 turns it off.
 */
const { blockingCells, visitableCells } = require('./content');

const COLOURS = ['lblue', 'green', 'red', 'dblue', 'brown', 'purple', 'white', 'black'];
const TENT = i => ({ animation: `AVXkey${i}0`, editorAnimation: '', mask: ['VVV', 'VBA'], visitableFrom: ['---', '+-+', '+++'] });
const GUARD = i => ({ animation: `AVXbor${i}0`, editorAnimation: '', mask: ['VV', 'VA'], visitableFrom: ['+++', '+-+', '+++'] });
const entry = (type, x, y, tpl, subtype) => ({ instanceName: `${type}_${x}_${y}_0`, l: 0, x, y, type, subtype, template: tpl });
const PASS = /^(resource|randomResource|treasureChest|campfire|randomArtifact|artifact|pandoraBox|spellScroll|prison|seaChest|flotsam|monster|randomMonster)/;
const N8 = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
const N4 = [[0, -1], [-1, 0], [1, 0], [0, 1]];

function addKeymasterPockets({ objects, plans, W, H, starts, rng, count }) {
	if (process.env.VMAPGEN_KEYMASTERS === '0' || !(count >= 1) || plans.length !== 1 || !plans[0].zone || !plans[0].classes) return null;
	const pl = plans[0], zone = pl.zone, water = pl.p && pl.p.water, openMask = pl.openMask, road = pl.roadCells || new Set();
	const colours = COLOURS.map((c, i) => i).sort(() => rng() - 0.5);
	const out = [], used = new Set();
	for (let n = 0; n < Math.min(3, count); n++) {
		const why = {};
		const occ = new Uint8Array(W * H), pass = new Uint8Array(W * H), at = new Map();
		for (const o of objects) {
			if ((o.l || 0) !== 0 || !o.template || !o.template.mask) continue;
			for (const [x, y] of blockingCells(o.template, o.x, o.y)) {
				if (x < 0 || y < 0 || x >= W || y >= H) continue;
				const c = y * W + x;
				occ[c] = 1;
				if (PASS.test(o.type)) { pass[c] = 1; at.set(c, o); }
			}
		}
		const walk = c => (!occ[c] || pass[c]) && !(water && water[c]) && (!openMask || openMask[c]);
		const inMap = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
		// zones with their tiles, objects and the tiles where a step crosses their border
		const tiles = new Map(), cross = new Map();
		for (let c = 0; c < W * H; c++) if (zone[c] >= 0) { if (!tiles.has(zone[c])) tiles.set(zone[c], []); tiles.get(zone[c]).push(c); }
		for (let c = 0; c < W * H; c++) {
			const z = zone[c];
			if (z < 0 || !walk(c)) continue;
			const x = c % W, y = (c / W) | 0;
			for (const [dx, dy] of N8) {
				const u = x + dx, v = y + dy;
				if (!inMap(u, v)) continue;
				const d = v * W + u;
				if (zone[d] >= 0 && zone[d] !== z && walk(d)) { if (!cross.has(z)) cross.set(z, new Set()); cross.get(z).add(c); break; }
			}
		}
		const startZones = new Set((starts || []).map(s => zone[s.y * W + s.x]));
		const hasLink = new Set();
		for (const o of objects) if ((o.l || 0) === 0 && /^(monolith|subterraneanGate|randomTown|town)/.test(String(o.type))) { const z = zone[o.y * W + o.x]; if (z >= 0) hasLink.add(o.type.startsWith('monolith') || o.type.startsWith('sub') ? z + ':portal' : z + ':town'); }
		const objsIn = new Map();
		for (const o of objects) if ((o.l || 0) === 0 && o.template) { const z = zone[Math.max(0, Math.min(H - 1, o.y)) * W + Math.max(0, Math.min(W - 1, o.x))]; objsIn.set(z, (objsIn.get(z) || 0) + 1); }
		const cands = [];
		for (const [z, ts] of tiles) {
			const X = cross.get(z);
			if (!X || X.size < 1 || X.size > 10) { why.border = (why.border || 0) + 1; continue; }
			if (pl.classes[z] === 'player' || startZones.has(z) || hasLink.has(z + ':portal')) { why.zone = (why.zone || 0) + 1; continue; }
			if (ts.length < 150 || ts.length > 0.35 * W * H) { why.size = (why.size || 0) + 1; continue; }
			if (used.has(z)) continue;
			// not next to a pocket already made
			let near = false;
			for (const c of X) for (const [dx, dy] of N8) { const u = (c % W) + dx, v = ((c / W) | 0) + dy; if (inMap(u, v) && used.has(zone[v * W + u])) near = true; }
			if (near) continue;
			// a crossing tile that holds anything but a monster is left alone
			let bad = false;
			for (const c of X) if (occ[c] && !(at.get(c) && /^(monster|randomMonster)/.test(at.get(c).type))) bad = true;
			if (bad) { why.occupied = (why.occupied || 0) + 1; continue; }
			cands.push({ z, X: [...X], score: (objsIn.get(z) || 0) + rng() * 5 });
		}
		cands.sort((a, b) => b.score - a.score);
		let done = false;
		for (const cd of cands.slice(0, 12)) {
			const Zt = new Set(tiles.get(cd.z));
			// the starts reach each other and one tent spot without entering the pocket (4-step moves over walkable tiles)
			const flood = (sx, sy) => {
				const seen = new Uint8Array(W * H), q = [];
				const s = sy * W + sx;
				if (!inMap(sx, sy) || !walk(s) || Zt.has(s)) return null;
				seen[s] = 1; q.push(s);
				for (let i = 0; i < q.length; i++) {
					const c = q[i], x = c % W, y = (c / W) | 0;
					for (const [dx, dy] of N8) {
						const u = x + dx, v = y + dy;
						if (!inMap(u, v)) continue;
						const d = v * W + u;
						if (seen[d] || !walk(d) || Zt.has(d)) continue;
						seen[d] = 1; q.push(d);
					}
				}
				return seen;
			};
			const reach = (starts || []).map(s => flood(s.x, s.y + 1) || flood(s.x - 1, s.y + 1) || flood(s.x + 1, s.y + 1));
			if (!reach.length || reach.some(r => !r)) { why.start = (why.start || 0) + 1; continue; }
			// the starts all in one piece with the pocket shut
			const first = reach[0];
			if ((starts || []).some(s => !(first[(s.y + 1) * W + s.x] || first[(s.y + 1) * W + s.x - 1] || first[(s.y + 1) * W + s.x + 1]))) { why.apart = (why.apart || 0) + 1; continue; }
			// a tent on open ground of another zone, a ring of free tiles round it, reached from every start
			const ci = colours[n % colours.length], tpl = TENT(ci);
			const spots = [];
			for (let y = 3; y < H - 3; y++) for (let x = 3; x < W - 3; x++) {
				const z = zone[y * W + x];
				if (z < 0 || z === cd.z || startZones.has(z) || pl.classes[z] === 'player') continue;
				// the tent's six cells and the tile in front of its door, free of objects and roads, all in the one zone
				let ok = true;
				for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -2; dx <= 0 && ok; dx++) {
					const c = (y + dy) * W + x + dx;
					if (occ[c] || road.has(c) || zone[c] !== z || (water && water[c]) || (openMask && !openMask[c])) ok = false;
				}
				if (ok && first[(y + 1) * W + x] && reach.every(r => r[(y + 1) * W + x])) spots.push([x, y]);
			}
			if (!spots.length) { why.tent = (why.tent || 0) + 1; continue; }
			const [tx, ty] = spots[(rng() * spots.length) | 0];
			// shut the pocket: a border guard on every crossing tile, the monster that stood on one taken off
			const guard = GUARD(ci), colour = COLOURS[ci];
			for (const c of cd.X) {
				const m = at.get(c);
				if (m) { const i = objects.indexOf(m); if (i >= 0) objects.splice(i, 1); const j = pl.objects ? pl.objects.indexOf(m) : -1; if (j >= 0) pl.objects.splice(j, 1); }
				const g = entry('borderGuard', c % W, (c / W) | 0, guard, colour);
				objects.push(g); if (pl.objects) pl.objects.push(g);
			}
			const t = entry('keymasterTent', tx, ty, tpl, colour);
			objects.push(t); if (pl.objects) pl.objects.push(t);
			used.add(cd.z);
			out.push(`${colour}: pocket zone ${cd.z} (${Zt.size} tiles) shut by ${cd.X.length} border guard(s), tent (${tx},${ty})`);
			done = true;
			break;
		}
		if (!done) { out.push(`pocket ${n + 1} found no place ${JSON.stringify(why)}`); break; }
	}
	return out.length ? out.join('; ') : null;
}

module.exports = { addKeymasterPockets, COLOURS };
