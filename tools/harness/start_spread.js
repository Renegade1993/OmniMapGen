/**
 * start_spread.js - how far apart the players' towns stand, ours against the engine's (K, 2026-10-02: all four of ours
 * sat along the left edge of an Islands map, the engine spreads them over the whole map).
 *
 * node tools/harness/start_spread.js <engine dir> <ours dir> [--match REGEX]

 * Only two-level maps of ours are compared with the engine's (a one-level map prints "no engine reference").
 * Per map (all starts, underground ones at their map position): the least distance between two starts, the mean distance between starts, and the
 * share of the map's width and height their bounding box covers. Per group (the run name without its seed):
 * the engine's range and ours, and OUTSIDE where ours' mean falls out of the engine's range.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const sight = require('../mapsight/lib/sight');
const args = process.argv.slice(2);
const [engineDir, oursDir] = args;
const mi = args.indexOf('--match');
const match = mi >= 0 ? new RegExp(args[mi + 1], 'i') : null;
const groupOf = f => f.replace(/\.vmap$/, '').replace(/_s\d+$/, '');
function measure(file) {
	const M = sight.load(file);
	const st = sight.starts(M);   // every start whatever its level: a start underground still stands somewhere on the map
	if (st.length < 2) return null;
	let min = Infinity, sum = 0, n = 0;
	for (let i = 0; i < st.length; i++) for (let j = i + 1; j < st.length; j++) {
		const d = Math.hypot(st[i].at[0] - st[j].at[0], st[i].at[1] - st[j].at[1]);
		min = Math.min(min, d); sum += d; n++;
	}
	const xs = st.map(s => s.at[0]), ys = st.map(s => s.at[1]);
	return { levels: M.NL, min: min / M.W, mean: sum / n / M.W, xspan: (Math.max(...xs) - Math.min(...xs)) / M.W, yspan: (Math.max(...ys) - Math.min(...ys)) / M.H,
		box: ((Math.max(...xs) - Math.min(...xs)) / M.W + (Math.max(...ys) - Math.min(...ys)) / M.H) / 2, n: st.length };
}
const read = dir => {
	const out = new Map();
	for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.vmap'))) {
		const g = groupOf(f);
		if (match && !match.test(g)) continue;
		const m = measure(path.join(dir, f));
		if (!m) continue;
		if (!out.has(g)) out.set(g, []);
		out.get(g).push(m);
	}
	return out;
};
const E = read(engineDir), O = read(oursDir);
const rng = (a, k) => [Math.min(...a.map(m => m[k])), Math.max(...a.map(m => m[k]))];
const f = v => v.toFixed(2);
let bad = 0;
console.log('group | starts | engine min / mean / x span / y span (range over seeds) | ours min / mean / x span / y span | verdict');
for (const [g, o] of [...O].sort()) {
	const e = E.get(g);
	if (!e) continue;
	// the engine's maps are two-level (it adds the underground to a template that has one); a one-level map of ours has the underground's
	// zones on its surface, so it is compared with nothing (K, 2026-10-03: apples to apples, same level count only)
	if (o.every(m => m.levels < 2)) {
		const q1 = k => `${f(rng(o, k)[0])}-${f(rng(o, k)[1])}`;
		console.log(`${g} | ${o[0].n} | no engine reference (one level) | ours min / mean / x span / y span ${q1('min')} / ${q1('mean')} / ${q1('xspan')} / ${q1('yspan')} | judged by K's description`);
		continue;
	}
	const r = k => `${f(rng(e, k)[0])}-${f(rng(e, k)[1])}`, q = k => `${f(rng(o, k)[0])}-${f(rng(o, k)[1])}`;
	// the engine's own range, widened by a tenth of the map: four seeds do not give the full spread
	const out = ['mean', 'xspan', 'yspan'].filter(k => rng(o, k)[1] < rng(e, k)[0] - 0.05 || rng(o, k)[0] > rng(e, k)[1] + 0.05);
	if (out.length) bad++;
	console.log(`${g} | ${o[0].n} | ${r('min')} / ${r('mean')} / ${r('xspan')} / ${r('yspan')} | ${q('min')} / ${q('mean')} / ${q('xspan')} / ${q('yspan')} | ${out.length ? 'OUTSIDE ' + out.join(', ') : 'ok'}`);
}
console.log(`${bad} of ${[...O].filter(([g]) => E.has(g)).length} groups outside the engine's range`);
process.exitCode = bad ? 1 : 0;
