'use strict';
/**
 * stack_effect.js - which stacks actually close something (K, 2026-10-08: "there are loads of monsters in ours that might be close to loot, but they
 * aren't affectively guarding the loot, so they are essentially freestanding").
 *
 *   node tools/harness/stack_effect.js MAP|DIR... [--pics N --out PREFIX]
 *
 * K's rule (10-05): an object is guarded when every tile it is visited from is blocked (rock, water, an object that is not a pickup), holds other
 * loot, or lies in a monster's 3x3 ring; a dear pile (relic, major, artifact, Pandora's box) or a prison of 90000+ also needs a monster beside its
 * visit tile (a flyer lands on it). Objects: pickups, prisons, dwellings, banks, mines, gates and monoliths.
 * A stack is effective when it closes something alone: an object that is guarded with it and not without it (an approach tile only its ring
 * covers, or the only monster beside a dear pile); or a passage: its ring holds tiles of two zones. Otherwise ineffective.
 * Also counted: objects with a stack within 2 of the visit tile that are still open (a walker or a flyer takes them past the stack).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const sight = require('../mapsight/lib/sight');
const cheb = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const files = [];
process.argv.slice(2).forEach((a, i, v) => {
	if (a.startsWith('--') || (i > 0 && /^--(pics|out)$/.test(v[i - 1]))) return;
	if (fs.existsSync(a) && fs.statSync(a).isDirectory()) fs.readdirSync(a).filter(f => f.endsWith('.vmap')).forEach(f => files.push(path.join(a, f)));
	else files.push(a);
});
const PICS = +arg('--pics', 0), OUT = arg('--out', null);
const DEAR = /^(randomArtifactRelic|randomArtifactMajor|artifact|pandoraBox)$/;
const kindOpen = {}, kindNear = {};
let stacks = 0, effective = 0, passage = 0, nearOpenWalk = 0, nearOpenFly = 0, nearObjs = 0;
const bad = [];
for (const f of files) {
	const M = sight.load(f), W = M.W, H = M.H, N = W * H;
	const ring = new Map();       // cell -> monsters covering it
	for (const m of M.monsters) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
		if (!M.inb(m.at[0] + dx, m.at[1] + dy)) continue;
		const i = M.idx(m.l, m.at[0] + dx, m.at[1] + dy);
		if (!ring.has(i)) ring.set(i, []);
		ring.get(i).push(m);
	}
	const monAt = new Set(M.monsters.map(m => M.idx(m.l, m.at[0], m.at[1])));
	const lootAt = new Set();
	for (const o of M.objs) if (o.pickup) for (const [x, y] of o.cells) lootAt.add(M.idx(o.l, x, y));
	const objs = M.objs.filter(o => o.visitable && (o.pickup || ['dwelling', 'bank', 'mine', 'gate', 'monolith'].includes(o.cls)));
	const need = new Map(M.monsters.map(m => [m, 0]));
	for (const o of objs) {
		const own = new Set(o.cells.map(([x, y]) => M.idx(o.l, x, y)));
		const app = M.approach(o).filter(i => !own.has(i));
		const flyer = DEAR.test(o.type) || (o.type === 'prison' && o.options && o.options.experience >= 90000);
		const beside = M.monsters.filter(m => m.l === o.l && cheb(m.at, o.at) <= 1);
		// open tiles: ground, not blocked, not loot, in no ring
		let open = false;
		const soleBy = new Set();
		for (const i of app) {
			// a monster standing on the tile closes it as its ring does (the guard in a pocket's mouth)
			if (!M.ground(i) || (M.blocked[i] && !monAt.has(i)) || lootAt.has(i)) continue;
			const r = ring.get(i) || [];
			if (!r.length) { open = true; break; }
			if (r.length === 1) soleBy.add(r[0]);
		}
		const flyOpen = flyer && !beside.length;
		const near2 = M.monsters.some(m => m.l === o.l && cheb(m.at, o.at) <= 2);
		if (near2) { const k = o.cls === 'high' || o.cls === 'low' ? o.cls + ' loot' : o.type === 'prison' ? 'prison' : o.cls; kindNear[k] = (kindNear[k] || 0) + 1; if (open) kindOpen[k] = (kindOpen[k] || 0) + 1; nearObjs++; if (open) nearOpenWalk++; else if (flyOpen) nearOpenFly++; }
		if (open || flyOpen) continue;      // not guarded: no stack closes it
		for (const m of soleBy) need.set(m, need.get(m) + 1);
		if (flyer && beside.length === 1) need.set(beside[0], need.get(beside[0]) + 1);
	}
	for (const m of M.monsters) {
		stacks++;
		const z0 = M.zoneAt(m.l, m.at[0], m.at[1]);
		let pass = false;
		for (let dy = -1; dy <= 1 && !pass; dy++) for (let dx = -1; dx <= 1; dx++) {
			if (!M.inb(m.at[0] + dx, m.at[1] + dy)) continue;
			const z = M.zoneAt(m.l, m.at[0] + dx, m.at[1] + dy);
			if (z !== undefined && z !== null && z >= 0 && z0 !== undefined && z !== z0) { pass = true; break; }
		}
		if (need.get(m) > 0) effective++;
		else if (pass) passage++;
		else { bad.push({ f, l: m.l, x: m.at[0], y: m.at[1] }); if (process.env.INEFF_NEAR) { const near = M.objs.filter(o => o.cls !== 'monster' && o.l === m.l && o.visitable && cheb(o.at, m.at) <= 2).map(o => o.cls === 'high' || o.cls === 'low' ? o.cls : o.cls); const k = near.length ? [...new Set(near)].sort().join('+') : 'nothing within 2'; global.INN = global.INN || {}; global.INN[k] = (global.INN[k] || 0) + 1; } }
	}
}
const pct = (a, b) => (b ? (100 * a / b).toFixed(1) : '-') + '%';
console.log(`${files.length} maps, ${stacks} stacks: closes an object alone ${effective} (${pct(effective, stacks)}), holds a zone passage ${passage} (${pct(passage, stacks)}), closes nothing ${bad.length} (${pct(bad.length, stacks)})`);
console.log(`objects with a stack within 2 of the visit tile: ${nearObjs}; of them open to a walker ${nearOpenWalk} (${pct(nearOpenWalk, nearObjs)}), open to a flyer only ${nearOpenFly} (${pct(nearOpenFly, nearObjs)})`);
if (global.INN) console.log('ineffective stacks beside: ' + Object.entries(global.INN).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => v + ' ' + k).join(', '));
console.log('open to a walker by kind: ' + Object.keys(kindNear).sort().map(k => k + ' ' + (kindOpen[k] || 0) + '/' + kindNear[k]).join(', '));
if (PICS && OUT) {
	const step = Math.max(1, Math.floor(bad.length / PICS));
	for (let k = 0; k < PICS && k * step < bad.length; k++) {
		const s = bad[k * step];
		const png = `${OUT}_${path.basename(s.f, '.vmap')}_L${s.l}_${s.x}_${s.y}.png`;
		spawnSync(process.execPath, [path.join(__dirname, '../mapsight/mapsight.js'), 'render', s.f, png, '--level', String(s.l), '--crop', `${Math.max(0, s.x - 6)},${Math.max(0, s.y - 6)},13,13`, '--px', '32', '--mark', `${s.x},${s.y}`], { windowsHide: true, timeout: 120000 });
		console.log('picture', png);
	}
}
