// crowd_origin.js MAP.vmap ORIGIN.json [...]: crowded stacks (another stack within 2 tiles on its level, playtest_checks guard-clusters'
// rule) by the pass that posted them, from the dump planMap writes when VMAPGEN_GUARD_ORIGIN names a file (src/biome/guardorigin.js).
// Prints per map and summed: stacks and crowded stacks by pass, and the close pairs by the two passes. Pairs of MAP and ORIGIN arguments.
'use strict';
const path = require('path');
const fs = require('fs');
const sight = require('../mapsight/lib/sight');

const cheb = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
const args = process.argv.slice(2);
const total = { stacks: {}, crowded: {}, pairs: {} };
const add = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };
for (let i = 0; i + 1 < args.length; i += 2) {
	const M = sight.load(args[i]);
	const by = new Map();
	for (const d of JSON.parse(fs.readFileSync(args[i + 1], 'utf8'))) by.set(`${d.l}:${d.x},${d.y}`, (d.by || '?') + (d.moved ? ' (moved)' : ''));
	const mons = M.monsters.map(m => ({ m, by: by.get(`${m.l}:${m.at[0]},${m.at[1]}`) || 'not in the dump' }));
	const cnt = new Array(mons.length).fill(0), local = { stacks: {}, crowded: {} };
	for (let a = 0; a < mons.length; a++) for (let b = a + 1; b < mons.length; b++) {
		if (mons[a].m.l !== mons[b].m.l || cheb(mons[a].m.at, mons[b].m.at) > 2) continue;
		cnt[a]++; cnt[b]++;
		add(total.pairs, [mons[a].by, mons[b].by].sort().join(' + '));
	}
	mons.forEach((s, k) => { add(local.stacks, s.by); add(total.stacks, s.by); if (cnt[k]) { add(local.crowded, s.by); add(total.crowded, s.by); } });
	const nc = Object.values(local.crowded).reduce((a, b) => a + b, 0);
	console.log(`${path.basename(args[i])}: ${nc} of ${mons.length} stacks crowded (${(100 * nc / Math.max(1, mons.length)).toFixed(1)}%)`);
}
const rows = Object.keys(total.stacks).sort((a, b) => (total.crowded[b] || 0) - (total.crowded[a] || 0));
console.log('\nby pass: crowded / stacks');
for (const k of rows) console.log(`  ${String(total.crowded[k] || 0).padStart(5)} / ${String(total.stacks[k]).padStart(5)}  ${k}`);
console.log('\nclose pairs by pass');
for (const [k, v] of Object.entries(total.pairs).sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(`  ${String(v).padStart(5)}  ${k}`);
