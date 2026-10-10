'use strict';
/**
 * pile_structure.js - how the engine lays a guarded pile: what surrounds each dear pile, dwelling and bank, and where its guard stands. Written for
 * the lead's decision of 2026-10-07 (option c: a dead-end pocket per pile with the guard in the mouth) so that Opus Map Vision copies a measured
 * structure, ours against the engine's.
 *
 *   node tools/harness/pile_structure.js MAP... [--examples N --out DIR]
 *
 * For each dear pile (high loot, scrolls left out), creature dwelling and creature bank:
 *  - approach tiles (the tiles it is visited from) and what blocks each: terrain (rock, water), an object (scenery, building), other loot, a guard's 3x3 ring, or nothing (open);
 *  - the pocket: the free ground reachable from its open and ringed approach tiles without crossing a blocker, flooded up to 400 tiles; a pocket under 400 is a closed one;
 *  - the guard: the nearest monster's distance, and whether its ring is the pocket's mouth (the pocket opens to the rest of the level only through the ring's tiles);
 *  - crowding: the share of guards with another monster within 2 tiles.
 * Prints one table of medians and quartiles over all the maps, and with --examples N --out DIR renders N closed pockets as crops (mapsight render).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const sight = require('../mapsight/lib/sight');

const files = process.argv.slice(2).filter((a, i, v) => !a.startsWith('--') && !(i > 0 && /^--(examples|out)$/.test(v[i - 1])));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const EXAMPLES = +arg('--examples', 0), OUT = arg('--out', null);
const CAP = 400, N8 = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 0], [-1, 1]];
const q = (a, f) => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[Math.min(b.length - 1, Math.floor(f * b.length))] : NaN; };
const rows = { pile: [], dwelling: [], bank: [] }, examples = [];
let guards = 0, crowded = 0;

for (const f of files) {
	const M = sight.load(f), W = M.W, H = M.H;
	const ring = new Set(), mon = new Set(), loot = new Map();
	for (const m of M.monsters) {
		mon.add(M.idx(m.l, m.at[0], m.at[1]));
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (M.inb(m.at[0] + dx, m.at[1] + dy)) ring.add(M.idx(m.l, m.at[0] + dx, m.at[1] + dy));
	}
	for (const o of M.objs) if (o.pickup || o.cls === 'bank' || o.cls === 'dwelling') for (const [x, y] of o.cells) if (M.inb(x, y)) loot.set(M.idx(o.l, x, y), o);
	for (const m of M.monsters) { guards++; if (M.monsters.some(n => n !== m && n.l === m.l && Math.max(Math.abs(n.at[0] - m.at[0]), Math.abs(n.at[1] - m.at[1])) <= 2)) crowded++; }
	const kind = o => (o.cls === 'high' && o.type !== 'spellScroll' ? 'pile' : o.cls === 'dwelling' ? 'dwelling' : o.cls === 'bank' ? 'bank' : null);
	for (const o of M.objs) {
		const k = kind(o);
		if (!k) continue;
		const app = M.approach(o);
		if (!app.length) continue;
		const row = { terrain: 0, object: 0, loot: 0, ringed: 0, open: 0, n: app.length };
		for (const i of app) {
			if (!M.ground(i)) row.terrain++;
			else if (M.blocked[i]) row.object++;
			else if (loot.has(i) && loot.get(i) !== o) row.loot++;
			else if (ring.has(i)) row.ringed++;
			else row.open++;
		}
		// the pocket: free ground (not blocked, not a pile) from the approach tiles that are ringed or open, ring tiles included, up to CAP tiles
		const seen = new Set(), todo = [];
		for (const i of app) if (M.ground(i) && !M.blocked[i]) { seen.add(i); todo.push(i); }
		let exceeded = false;
		while (todo.length) {
			const c = todo.pop(), l = (c / (W * H)) | 0, r = c - l * W * H, x = r % W, y = (r / W) | 0;
			for (const [dx, dy] of N8) {
				if (!M.inb(x + dx, y + dy)) continue;
				const n = M.idx(l, x + dx, y + dy);
				if (seen.has(n) || !M.ground(n) || M.blocked[n] || (loot.has(n) && loot.get(n) !== o)) continue;
				// the flood stops at a guard's own tile: a hero fights there
				if (mon.has(n)) continue;
				// and does not go past the ring: ring tiles are in the pocket, what lies beyond them is the rest of the level
				seen.add(n);
				if (!ring.has(n)) todo.push(n);
				if (seen.size > CAP) { exceeded = true; break; }
			}
			if (exceeded) break;
		}
		row.pocket = exceeded ? Infinity : seen.size;
		let g = Infinity, gm = null;
		for (const m of M.monsters) if (m.l === o.l) { const d = Math.max(Math.abs(m.at[0] - o.at[0]), Math.abs(m.at[1] - o.at[1])); if (d < g) { g = d; gm = m; } }
		row.guardDist = g;
		row.ringIsMouth = !exceeded && gm && [...seen].some(i => ring.has(i));
		rows[k].push(row);
		if (EXAMPLES && k === 'pile' && !exceeded && row.pocket >= 3 && row.pocket <= 40 && examples.length < 300 && row.ringIsMouth) examples.push({ f, o });
	}
}

const pct = (a, f) => (a.length ? (100 * a.filter(f).length / a.length).toFixed(1) + '%' : 'n/a');
const med = (a, g) => { const v = a.map(g); return `${q(v, 0.25)} / ${q(v, 0.5)} / ${q(v, 0.75)}`; };
console.log(`${files.length} maps; guards ${guards}, with another monster within 2 tiles ${(100 * crowded / Math.max(1, guards)).toFixed(1)}%`);
console.log('kind      objects  approach tiles blocked by: terrain / object / other loot / guard ring / open (mean per object)   closed pocket   pocket size 25/50/75% (closed ones)   ring is the pocket mouth   guard distance 25/50/75%   no open approach tile');
for (const k of ['pile', 'dwelling', 'bank']) {
	const a = rows[k];
	if (!a.length) continue;
	const mean = key => (a.reduce((s, r) => s + r[key], 0) / a.length).toFixed(2);
	const closed = a.filter(r => r.pocket !== Infinity);
	console.log(`${k.padEnd(9)} ${String(a.length).padStart(7)}  ${mean('terrain')} / ${mean('object')} / ${mean('loot')} / ${mean('ringed')} / ${mean('open')}   ${pct(a, r => r.pocket !== Infinity)}   ${closed.length ? med(closed, r => r.pocket) : 'n/a'}   ${pct(closed, r => r.ringIsMouth)}   ${med(a, r => r.guardDist)}   ${pct(a, r => r.open === 0)}`);
}
if (EXAMPLES && OUT) {
	fs.mkdirSync(OUT, { recursive: true });
	const chosen = [];
	for (let k = 0; k < EXAMPLES && examples.length; k++) chosen.push(examples[Math.floor((k + 0.5) * examples.length / EXAMPLES)]);
	chosen.forEach((e, i) => {
		const x0 = Math.max(0, e.o.at[0] - 9), y0 = Math.max(0, e.o.at[1] - 9);
		const out = path.join(OUT, `pile_example_${i + 1}.png`);
		execFileSync(process.execPath, [path.join(__dirname, '..', 'mapsight', 'mapsight.js'), 'render', e.f, out, '--level', String(e.o.l), '--crop', `${x0},${y0},19,19`, '--mark', `${e.o.at[0]},${e.o.at[1]}`], { windowsHide: true, stdio: 'ignore' });
		console.log(`example ${i + 1}: ${out}  (${path.basename(e.f)}, ${e.o.type} at L${e.o.l} (${e.o.at[0]},${e.o.at[1]}))`);
	});
}
