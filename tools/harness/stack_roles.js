'use strict';
/**
 * stack_roles.js - what each monster stack stands beside (K, 2026-10-08: "are there guards that just hangout all over the map in random places on
 * the vcmi nostalgia generator as well? ... guards all generally have a specific structure, bottleneck, or item they are guarding in the basegame").
 *
 *   node tools/harness/stack_roles.js MAP|DIR... [--free N --out PREFIX]
 *
 * Each stack takes the first role that fits: loot (a pickup or prison whose visiting tile is within 2, or an approach tile in its 3x3), a dwelling
 * or bank (the same test), a mine, a town (within 3 of its gate), a gate or monolith (within 2), a zone link (another zone's tile within 2 of it,
 * from the zone sidecar), a bottleneck (five or more of its eight neighbours blocked or rock or water), else free-standing. --free N renders N
 * free-standing stacks (14x14 crops) to PREFIX_x_y.png.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const sight = require('../mapsight/lib/sight');
const cheb = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const files = [];
process.argv.slice(2).forEach((a, i, v) => {
	if (a.startsWith('--') || (i > 0 && /^--(free|out)$/.test(v[i - 1]))) return;
	if (fs.existsSync(a) && fs.statSync(a).isDirectory()) fs.readdirSync(a).filter(f => f.endsWith('.vmap')).forEach(f => files.push(path.join(a, f)));
	else files.push(a);
});
const FREE = +arg('--free', 0), OUT = arg('--out', null);
const ROLES = ['loot', 'dwelling or bank', 'mine', 'town', 'gate or monolith', 'zone link', 'bottleneck', 'free-standing'];
const tally = Object.fromEntries(ROLES.map(r => [r, 0]));
let total = 0;
const free = [];
for (const f of files) {
	const M = sight.load(f), W = M.W, H = M.H;
	const near = (m, o) => cheb(m.at, o.at) <= 2 || M.approach(o).some(i => { const c = i % (W * H); return cheb([c % W, (c / W) | 0], m.at) <= 1; });
	const byL = M.objs.filter(o => o.cls !== 'monster');
	for (const m of M.monsters) {
		total++;
		const here = byL.filter(o => o.l === m.l && cheb(o.at, m.at) <= 4);
		let role = null;
		if (here.some(o => o.pickup && near(m, o))) role = 'loot';
		else if (here.some(o => (o.cls === 'dwelling' || o.cls === 'bank') && near(m, o))) role = 'dwelling or bank';
		else if (here.some(o => o.cls === 'mine' && near(m, o))) role = 'mine';
		else if (here.some(o => o.cls === 'town' && cheb(o.at, m.at) <= 3)) role = 'town';
		else if (here.some(o => (o.cls === 'gate' || o.cls === 'monolith') && near(m, o))) role = 'gate or monolith';
		else {
			const z = M.zoneAt(m.l, m.at[0], m.at[1]);
			let other = false;
			if (z !== undefined && z !== null) for (let dy = -2; dy <= 2 && !other; dy++) for (let dx = -2; dx <= 2; dx++) {
				const x = m.at[0] + dx, y = m.at[1] + dy;
				if (!M.inb(x, y)) continue;
				const zz = M.zoneAt(m.l, x, y);
				if (zz !== undefined && zz !== null && zz >= 0 && zz !== z) { other = true; break; }
			}
			if (other) role = 'zone link';
			else {
				let b = 0;
				for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
					if (!dx && !dy) continue;
					const x = m.at[0] + dx, y = m.at[1] + dy;
					if (!M.inb(x, y)) { b++; continue; }
					const i = M.idx(m.l, x, y);
					if (!M.ground(i) || M.blocked[i]) b++;
				}
				role = b >= 5 ? 'bottleneck' : 'free-standing';
			}
		}
		tally[role]++;
		if (role === 'free-standing') free.push({ f, l: m.l, x: m.at[0], y: m.at[1] });
	}
}
console.log(`${files.length} maps, ${total} stacks`);
for (const r of ROLES) console.log(`  ${r.padEnd(18)} ${String(tally[r]).padStart(6)}  ${(100 * tally[r] / total).toFixed(1)}%`);
if (FREE && OUT) {
	const step = Math.max(1, Math.floor(free.length / FREE));
	for (let k = 0; k < FREE && k * step < free.length; k++) {
		const s = free[k * step];
		const png = `${OUT}_${path.basename(s.f, '.vmap')}_L${s.l}_${s.x}_${s.y}.png`;
		spawnSync(process.execPath, [path.join(__dirname, '../mapsight/mapsight.js'), 'render', s.f, png, '--level', String(s.l), '--crop', `${Math.max(0, s.x - 7)},${Math.max(0, s.y - 7)},14,14`, '--px', '30', '--mark', `${s.x},${s.y}`], { windowsHide: true, timeout: 120000 });
		console.log('picture', png);
	}
}
