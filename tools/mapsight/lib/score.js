'use strict';
/**
 * score.js - one number for "does ours match the engine on this template", from everything mapsight measures.
 * K, 2026-10-01: "I want you to be able to take a 95%+ 'one-shot, one-kill' on this coldshadows template generator".
 *
 *   mapsight score --ours FILE... --engine FILE... [--show 40]
 *
 * Features, one value per map: every relational measure and fixed metric (profile), the content per 1000 tiles, every
 * template zone's level (underground or not), size and contents (towns, dragons, dwellings, high and low loot, banks,
 * mines, guards, gates, monoliths), the zone links (open passages and teleports per pair, and links the template never
 * makes), and the guards by what they seal (count a map and median strength). For each feature ours is scored against
 * the engine's maps: distance of ours' median from the engine's median in units of the engine's spread (MAD, with a
 * floor). The line is calibrated on the engine itself: every engine map in turn is scored against the others, and the
 * 95th percentile of those scores is where a feature stops matching. Match % = features inside the line. The engine's
 * own maps score about 95% against each other by construction: that is the target.
 */
const path = require('path');
const { profile } = require('./profile');
const zones = require('./zones');
const { guideFor } = require('./guide');

function list(args, name) {
	const out = [];
	args.forEach((a, i) => { if (a === name) for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) out.push(args[j]); });
	return out;
}
const med = a => { const b = [...a].sort((x, y) => x - y); const n = b.length; return n ? (n % 2 ? b[n >> 1] : (b[n / 2 - 1] + b[n / 2]) / 2) : 0; };
const pc = (a, p) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.min(b.length - 1, Math.floor(p * b.length))] : 0; };

/** One map's features as name -> number. */
function features(file) {
	const f = {};
	const p = profile(file);
	for (const [k, v] of Object.entries(p.metrics)) if (typeof v === 'number') f[`metric: ${k}`] = v;
	for (const [k, v] of Object.entries(p.measures)) if ((p.counts[k] || 0) >= 5) f[`relation: ${k}`] = v;
	for (const [k, v] of Object.entries(p.census)) f[`content: ${k}`] = v;
	const z = zones.read(file);
	if (z) {
		for (const [id, e] of z.Z) {
			f[`zone ${id}: underground`] = (e.levels[1] || 0) > (e.levels[0] || 0) ? 1 : 0;
			f[`zone ${id}: tiles`] = e.tiles;
			for (const k of ['start', 'player town', 'town', 'neutral dragon', 'dwelling', 'high loot', 'low loot', 'bank', 'mine', 'guard', 'gate', 'monolith'])
				f[`zone ${id}: ${k}`] = e.c[k] || 0;
		}
		for (const [k, l] of z.links) { f[`link ${k}: passages`] = l.passages.length; f[`link ${k}: teleports`] = l.teleports; }
	}
	// guards by what they seal (guards.js read is heavier; the profile's relation roles are enough per map)
	return { f, file };
}

function scoreOf(oursF, engF) {
	const names = new Set([...oursF, ...engF].flatMap(x => Object.keys(x.f)));
	const out = [];
	for (const n of names) {
		// a feature missing from a map is a zero for counts (a zone link that does not exist, a content kind not there)
		const zeroOk = /^(content|zone|link)/.test(n);
		const ev = engF.map(x => x.f[n]).filter(v => v !== undefined || zeroOk).map(v => v ?? 0);
		const ov = oursF.map(x => x.f[n]).filter(v => v !== undefined || zeroOk).map(v => v ?? 0);
		if (ev.length < 3 || !ov.length) continue;
		const binary = ev.concat(ov).every(v => v === 0 || v === 1);
		let z, om, em;
		if (binary) {
			// yes/no per map (a zone underground, a link that exists): compare the shares of maps, spread at least 0.25
			om = ov.reduce((x, y) => x + y, 0) / ov.length; em = ev.reduce((x, y) => x + y, 0) / ev.length;
			z = (om - em) / Math.max(Math.sqrt(em * (1 - em)), 0.25);
		} else {
			om = med(ov); em = med(ev);
			const iqr = (pc(ev, 0.75) - pc(ev, 0.25)) / 1.35;
			const isShare = Math.max(...ev, ...ov) <= 1 && Math.min(...ev, ...ov) >= 0;
			const floor = isShare ? 0.05 : Math.max(1, 0.15 * Math.abs(em));
			z = (om - em) / Math.max(iqr, floor);
		}
		out.push({ n, z, ours: om, eng: em, lo: Math.min(...ev), hi: Math.max(...ev), binary });
	}
	return out;
}
// a feature's family: "zone 17: tiles" and "link 4-12: teleports" are families "zone" and "link"
const fam = n => n.split(':')[0].replace(/ \d+(-\d+)?$/, '');

function main(args) {
	const O = list(args, '--ours').map(features), E = list(args, '--engine').map(features);
	// the template's own zone links: the ones on at least a quarter of the engine's maps; a link outside them is a leak
	const linkKeys = x => Object.keys(x.f).filter(k => /^link .*: (passages|teleports)$/.test(k) && x.f[k] > 0).map(k => k.replace(/: .*$/, ''));
	const seen = new Map();
	for (const e of E) for (const k of new Set(linkKeys(e))) seen.set(k, (seen.get(k) || 0) + 1);
	const tpl = new Set([...seen].filter(([, n]) => n * 4 >= E.length).map(([k]) => k));
	for (const x of [...O, ...E]) x.f['zone graph: links the template never makes'] = new Set(linkKeys(x).filter(k => !tpl.has(k))).size;
	if (!O.length || E.length < 4) { console.log('score needs --ours maps and 4+ --engine maps'); process.exitCode = 2; return; }
	// calibration on the engine itself: each engine map against the others
	const loo = E.map((e, k) => scoreOf([e], E.filter((_, j) => j !== k)));
	const lines = {};
	for (const r of loo.flat()) (lines[fam(r.n)] = lines[fam(r.n)] || []).push(Math.abs(r.z));
	for (const k of Object.keys(lines)) lines[k] = Math.max(1, pc(lines[k], 0.95));
	const ok = r => Math.abs(r.z) <= (lines[fam(r.n)] || 2);
	const looMatch = loo.map(rs => rs.filter(ok).length / rs.length);
	const rows = scoreOf(O, E);
	const inside = rows.filter(ok);
	const byFam = {};
	for (const r of rows) { const k = fam(r.n); byFam[k] = byFam[k] || [0, 0]; byFam[k][1]++; if (ok(r)) byFam[k][0]++; }
	const pct = v => `${(100 * v).toFixed(1)}%`;
	const famMean = rs => { const by = {}; for (const r of rs) { const k = fam(r.n); by[k] = by[k] || [0, 0]; by[k][1]++; if (ok(r)) by[k][0]++; } const v = Object.values(by).map(([a, b]) => a / b); return v.reduce((a, b) => a + b, 0) / v.length; };
	const looFam = loo.map(famMean);
	console.log(`MATCH ${pct(famMean(rows))} (each family weighted the same); engine against engine ${pct(Math.min(...looFam))} to ${pct(Math.max(...looFam))}, median ${pct(med(looFam))}.`);
	console.log(`Features: ${pct(inside.length / rows.length)} of ${rows.length} inside the engine's own lines (per family, 95th percentile of engine against engine: ${Object.entries(lines).map(([k, v]) => k + ' ' + v.toFixed(1)).join(', ')}).`);
	console.log(`TARGET: an engine map against the other engine maps scores ${pct(Math.min(...looMatch))} to ${pct(Math.max(...looMatch))} (median ${pct(med(looMatch))}). Ours ${O.length} maps, engine ${E.length}.`);
	console.log(`By family: ${Object.entries(byFam).map(([k, [a, b]]) => `${k} ${a}/${b}`).join(', ')}`);
	const show = +(list(args, '--show')[0] || 40);
	console.log(`\nFurthest outside (feature: ours median, engine median and range, score):`);
	const out = rows.filter(r => !ok(r)).sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
	for (const r of out.slice(0, show))
		console.log(`  ${r.n}: ${+r.ours.toFixed(3)} against ${+r.eng.toFixed(3)} (${+r.lo.toFixed(3)} to ${+r.hi.toFixed(3)}), score ${r.z.toFixed(1)}`);
	// where to look: each guide entry once, ranked by the summed scores of the features it covers (lib/guide.js)
	const byGuide = new Map();
	for (const r of out) {
		const g = guideFor(r.n);
		if (!g) continue;
		const e = byGuide.get(g) || { g, sum: 0, n: 0, top: r.n };
		e.sum += Math.abs(r.z); e.n++;
		byGuide.set(g, e);
	}
	if (byGuide.size) {
		console.log(`
Where to look, the biggest first (summed score of the features outside the line; README "Fix loop"):`);
		for (const e of [...byGuide.values()].sort((a, b) => b.sum - a.sum)) {
			console.log(`  ${e.n} feature(s), summed score ${e.sum.toFixed(0)}, e.g. "${e.top}"`);
			console.log(`    see:  ${e.g.look}`);
			console.log(`    code: ${e.g.code}`);
		}
	}
}

module.exports = { main, features, scoreOf };
