'use strict';
/**
 * diff.js - the difference finder. Every relational measure (relations.js) is computed on the engine's maps and on ours;
 * the measures where ours falls furthest outside the engine's spread over its seeds come first, each with the
 * coordinates of objects in ours that have the relationship, so the agent opens those places instead of guessing.
 *
 *   mapsight diff --engine DIR|--run DIR [--match REGEX] (--ours DIR | --maps FILE ...) [--top 25] [--all] [--json out]
 *
 * Score: how far ours sits outside the engine's [min, max], in units of the engine's own spread (at least 3 points), so
 * a measure the engine holds tight and ours misses by a mile ranks above a loose one missed by a little. Measures where
 * ours lies inside the engine's range score 0 and are listed only with --all.
 */
const fs = require('fs');
const path = require('path');
const sight = require('./sight');
const { describe } = require('./relations');

function opt(args, name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }
function list(args, name) {
	const out = [];
	args.forEach((a, i) => { if (a === name) for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) out.push(args[j]); });
	return out;
}
const vmaps = dir => (dir && fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /\.vmap$/i.test(f)).map(f => path.join(dir, f)) : []);
const pct = v => `${Math.round(1000 * v) / 10}%`;

function main(args) {
	const run = opt(args, '--run');
	const match = opt(args, '--match') ? new RegExp(opt(args, '--match'), 'i') : null;
	const pick = fs => fs.filter(f => !match || match.test(path.basename(f)));
	const engine = pick([...vmaps(opt(args, '--engine') || (run && path.join(run, 'engine'))), ...list(args, '--engine-maps')]);
	const ours = [...pick(vmaps(opt(args, '--ours') || (run && !list(args, '--maps').length ? path.join(run, 'ours') : null))), ...list(args, '--maps')];
	if (engine.length < 2 || !ours.length) {
		console.log(`diff needs 2+ engine maps and 1+ of ours; found engine ${engine.length}, ours ${ours.length}`);
		process.exitCode = 2;
		return;
	}
	const read = f => { const d = describe(sight.analyse(f)); return { f, ...d }; };
	const E = engine.map(read), O = ours.map(read);
	const names = [...new Set([...E, ...O].flatMap(d => Object.keys(d.measures)))];
	const rows = [];
	for (const n of names) {
		const ev = E.map(d => d.measures[n]).filter(v => v !== undefined && v !== null);
		const ov = O.map(d => d.measures[n]).filter(v => v !== undefined && v !== null);
		if (ev.length < 2 || !ov.length) continue;
		const lo = Math.min(...ev), hi = Math.max(...ev), spread = Math.max(hi - lo, 0.03);
		const om = ov.reduce((a, b) => a + b, 0) / ov.length;
		const em = ev.reduce((a, b) => a + b, 0) / ev.length;
		const outside = om < lo ? lo - om : om > hi ? om - hi : 0;
		const exOwner = O.find(d => d.measures[n] !== undefined);
		rows.push({ n, lo, hi, em, om, ov, score: outside / spread, gap: om - em, ex: exOwner ? (om < em ? exOwner.counter[n] : exOwner.examples[n]) || [] : [], exMap: exOwner && path.basename(exOwner.f),
			exEngine: (E.find(d => (d.examples[n] || []).length) || { examples: {} }).examples[n] || [] });
	}
	rows.sort((a, b) => b.score - a.score || Math.abs(b.gap) - Math.abs(a.gap));
	const top = args.includes('--all') ? rows : rows.filter(r => r.score > 0).slice(0, +(opt(args, '--top') || 25));
	console.log(`engine ${E.length} maps, ours ${O.length}; ${rows.length} measures, ${rows.filter(r => r.score > 0).length} with ours outside the engine's range\n`);
	top.forEach((r, i) => {
		const dir = r.om > r.em ? 'MORE' : 'LESS';
		console.log(`${String(i + 1).padStart(2)}. ${r.n}`);
		console.log(`    engine ${pct(r.lo)} to ${pct(r.hi)}; ours ${r.ov.map(pct).join(', ')}  (${dir} than the engine${r.score ? `, ${r.score.toFixed(1)} spreads outside` : ''})`);
		if (r.ex.length) console.log(`    ${r.om < r.em ? 'in ours, without it' : 'in ours'} (${r.exMap}): ${r.ex.slice(0, 5).join('  ')}`);
		if (r.exEngine.length && r.om < r.em) console.log(`    in the engine's, with it: ${r.exEngine.slice(0, 3).join('  ')}`);
	});
	if (opt(args, '--json')) fs.writeFileSync(opt(args, '--json'), JSON.stringify(rows, null, 1));
}

module.exports = { main };
