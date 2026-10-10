'use strict';
/**
 * compare.js - Stage 2 and 3 of mapsight: the same checks over the engine's maps, ours and the original maps, and the
 * gate that fails a build before it is placed.
 *
 *   mapsight compare --run DIR [--match REGEX] [--orig DIR] [--maps FILE ...] [--min-seeds 3]
 *   mapsight compare --engine DIR --ours DIR ...
 *   mapsight gate    (same arguments; exit code 1 on any FAIL, 2 when there is nothing to judge)
 *
 * --run DIR reads the layout tools/harness/run_grid.py writes: DIR/engine/<id>_s<seed>.vmap (+ .zones.json) and
 * DIR/ours/<id>_s<seed>.vmap (+ .vmap.zones.json). Maps are grouped by <id> (template, size, levels, players, water,
 * monsters). Each group's engine maps give the range per check; each of ours is PASS or FAIL against it. --maps adds
 * maps from K's own route (his game's RandomMaps folder), judged against the one group --match selects. --orig adds
 * converted original maps as an extra column for reference (hand-made maps, so never pass/fail).
 */
const fs = require('fs');
const path = require('path');
const sight = require('./sight');

// name, metric, rule against the engine's [min, max]; "why" is what the check stands for
const CHECKS = [
	{ name: 'starts underground', m: 'starts_underground', fail: (v, r) => v > r.max, why: 'K: "players are spawning underground"' },
	{ name: 'neutral dragon dwellings', m: 'neutral_dragon_dwellings', fail: (v, r) => v < r.min, why: 'K: "no neutral crystal/faerie/azure/rust dragon creature generation buildings"' },
	{ name: 'dragon zones without a town', m: 'dragon_zones_no_town', fail: (v, r) => v < r.min, why: 'Coldshadow central dragon caches' },
	{ name: 'high loot reachable past no guard', m: 'high_open', fail: (v, r) => v > r.max + 0.05, pct: true, why: 'K: "the guards have to block access"' },
	{ name: 'relics, majors, Pandoras open', m: 'prize_open', fail: (v, r) => v > r.max + 2 },
	{ name: 'dwellings reachable past no guard', m: 'dwelling_open', fail: (v, r) => v > r.max + 0.05, pct: true },
	{ name: 'high loot walkable from a start', m: 'high_walkable', fail: (v, r) => v > r.max + 0.05, pct: true },
	{ name: 'road tiles reaching no building', m: 'road_orphan_tiles', fail: (v, r) => v > r.max + 10, why: 'K: roads "disconnected nearby"' },
	{ name: 'road ends short of an entrance', m: 'entrance_near_miss', fail: (v, r) => v > r.max, why: "K's broken-road-connection example" },
	{ name: 'road ends at nothing', m: 'road_end_at_nothing', fail: (v, r) => v > r.max, why: 'K: roads "T off to nowhere"' },
	{ name: 'road ends at loot, bank, dwelling', m: 'road_end_at_object', fail: (v, r) => v > r.max },
	{ name: 'road ends just short of a road', m: 'road_gap', fail: (v, r) => v > r.max, why: 'K: "hit towns, only to be disconnected nearby"' },
	{ name: 'road tiles', m: 'road_tiles', fail: (v, r) => v < 0.8 * r.min },
	{ name: 'towns with road at the entrance', m: 'town_joined', fail: (v, r) => v < r.min - 0.02, pct: true },
	{ name: 'buildings on the wrong ground', m: 'terrain_illegal', fail: (v, r) => v > r.max + 5, why: "K's wells-on-wasteland example" },
];

function opt(args, name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }
function list(args, name) {
	const out = [];
	args.forEach((a, i) => { if (a === name) for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) out.push(args[j]); });
	return out;
}
const vmaps = dir => (dir && fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /\.vmap$/i.test(f)).map(f => path.join(dir, f)) : []);
const groupOf = f => path.basename(f).replace(/\.vmap$/i, '').replace(/_s\d+$/, '');
const fmt = (v, c) => (v === null || v === undefined ? 'n/a' : c && c.pct ? `${Math.round(100 * v)}%` : String(Math.round(v * 10) / 10));

function metricsOf(file) {
	try { return sight.analyse(file).metrics; } catch (e) { return { error: e.message }; }
}

/** Template zones the engine fills with neutral dragon dwellings in at least half its seeds (from the sidecars). */
function engineDragonZones(files) {
	const count = new Map();
	let seeds = 0;
	for (const f of files) {
		const side = f.replace(/\.vmap$/i, '.zones.json');
		if (!fs.existsSync(side)) continue;
		seeds++;
		const z = JSON.parse(fs.readFileSync(side, 'utf8'));
		for (const q of z.zones || [])
			if (Object.keys(q.objects || {}).some(sight.isDragonKey))
				count.set(q.id, (count.get(q.id) || 0) + 1);
	}
	return { seeds, zones: [...count].filter(([, n]) => n * 2 >= seeds).map(([id]) => id).sort((a, b) => a - b) };
}

/** Of the engine's dragon zones, those ours leaves without a neutral dragon dwelling (needs ours' tile map). */
function missingDragonZones(file, want) {
	const A = sight.analyse(file);
	if (!A.M.zones || !A.M.zones.zoneOf) return null;
	const have = new Set(A.census.filter(d => d.dragon && d.zone !== undefined).map(d => d.zone));
	return want.filter(z => !have.has(z));
}

function main(cmd, args) {
	const run = opt(args, '--run');
	const engineDir = opt(args, '--engine') || (run && path.join(run, 'engine'));
	const oursDir = opt(args, '--ours') || (run && path.join(run, 'ours'));
	const match = opt(args, '--match') ? new RegExp(opt(args, '--match'), 'i') : null;
	const minSeeds = +(opt(args, '--min-seeds') || 3);
	const extra = list(args, '--maps');
	const orig = vmaps(opt(args, '--orig'));
	const groups = new Map();
	const add = (side, f) => {
		const g = groupOf(f);
		if (match && !match.test(g)) return;
		if (!groups.has(g)) groups.set(g, { engine: [], ours: [] });
		groups.get(g)[side].push(f);
	};
	vmaps(engineDir).forEach(f => add('engine', f));
	vmaps(oursDir).forEach(f => add('ours', f));
	const origM = orig.map(f => ({ f, m: metricsOf(f) }));
	let fails = 0, judged = 0;
	const out = [];
	const usable = [...groups].filter(([, g]) => g.engine.length >= minSeeds);
	if (extra.length && usable.length !== 1) {
		console.log(`--maps needs --match to select exactly one group with ${minSeeds}+ engine seeds; it selects ${usable.length}: ${usable.map(([k]) => k).join(', ') || 'none'}`);
		process.exitCode = 2;
		return;
	}
	for (const [g, side] of usable) {
		const em = side.engine.map(f => ({ f, m: metricsOf(f) })).filter(e => !e.m.error);
		const range = {};
		for (const c of CHECKS) {
			const vs = em.map(e => e.m[c.m]).filter(v => v !== null && v !== undefined);
			range[c.m] = vs.length ? { min: Math.min(...vs), max: Math.max(...vs) } : null;
		}
		const dz = engineDragonZones(side.engine);
		// K, 2026-10-03: compare with the engine only at the same level count; a one-level map of a template the engine
		// makes on two levels has no engine reference (one-level Coldshadow against the two-level range failed by design)
		const levelsOf = f => { try { return sight.load(f).NL; } catch { return null; } };
		const engLevels = new Set(side.engine.map(levelsOf).filter(v => v));
		const allJudged = [...side.ours.map(f => ({ f, kind: 'ours' })), ...(usable.length === 1 ? extra.map(f => ({ f, kind: 'K route' })) : [])];
		const judgedMaps = allJudged.filter(j => engLevels.has(levelsOf(j.f)));
		for (const j of allJudged.filter(j => !judgedMaps.includes(j)))
			out.push(`  ${j.kind} ${path.basename(j.f)}: no engine reference (${levelsOf(j.f)} level(s); the engine's maps here have ${[...engLevels].join('/')})`);
		out.push(`\n== ${g}: engine ${em.length} seeds, ours ${side.ours.length}${judgedMaps.length > side.ours.length ? `, K route ${judgedMaps.length - side.ours.length}` : ''}` +
			(dz.zones.length ? `; engine dragon zones ${dz.zones.join(',')} (of ${dz.seeds} sidecars)` : ''));
		const om = origM.length ? CHECKS.map(c => origM.map(o => o.m[c.m]).filter(v => v !== null && v !== undefined)) : null;
		out.push(`  ${'check'.padEnd(36)} ${'engine range'.padEnd(14)}${om ? ' ' + 'originals p25-75'.padEnd(14) : ''} ${judgedMaps.map((j, i) => `#${i + 1}`.padEnd(9)).join('')}`);
		const rowsFail = judgedMaps.map(() => []);
		const ms = judgedMaps.map(j => metricsOf(j.f));
		CHECKS.forEach((c, ci) => {
			const r = range[c.m];
			const cells = ms.map((m, i) => {
				const v = m[c.m];
				if (v === null || v === undefined || !r) return 'n/a'.padEnd(9);
				const bad = c.fail(v, r);
				if (bad) rowsFail[i].push(c.name);
				return `${fmt(v, c)}${bad ? ' FAIL' : ''}`.padEnd(9);
			});
			const q = (a, p) => { const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(p * b.length))]; };
			const o = om && om[ci].length ? `${fmt(q(om[ci], 0.25), c)}-${fmt(q(om[ci], 0.75), c)}` : '';   // middle half: hand-made maps spread wide
			out.push(`  ${c.name.padEnd(36)} ${(r ? `${fmt(r.min, c)}-${fmt(r.max, c)}` : 'n/a').padEnd(14)}${om ? ' ' + o.padEnd(14) : ''} ${cells.join('')}`);
		});
		judgedMaps.forEach((j, i) => {
			const miss = dz.zones.length ? missingDragonZones(j.f, dz.zones) : null;
			if (miss && miss.length) rowsFail[i].push(`dragon zones ${miss.join(',')} empty`);
			judged++;
			if (rowsFail[i].length) fails++;
			out.push(`  #${i + 1} ${j.kind} ${path.basename(j.f)}: ${rowsFail[i].length ? 'FAIL (' + rowsFail[i].join('; ') + ')' : 'PASS'}` +
				(miss === null && dz.zones.length ? ' [no zone tile map: per-zone dragon check not run]' : ''));
		});
	}
	const skipped = [...groups].filter(([, g]) => g.engine.length < minSeeds).map(([k, g]) => `${k} (${g.engine.length})`);
	if (skipped.length) out.push(`\nnot judged, fewer than ${minSeeds} engine seeds: ${skipped.slice(0, 8).join(', ')}${skipped.length > 8 ? ' ...' : ''}`);
	if (origM.length) out.push(`originals read: ${origM.map(o => path.basename(o.f) + (o.m.error ? ' (error)' : '')).join(', ')}`);
	console.log(out.join('\n'));
	if (cmd === 'gate') {
		if (!judged) { console.log('GATE: nothing judged (no group with ours or --maps and enough engine seeds)'); process.exitCode = 2; return; }
		console.log(fails ? `GATE FAIL: ${fails} of ${judged} maps fail` : `GATE PASS: ${judged} maps`);
		process.exitCode = fails ? 1 : 0;
	}
}

module.exports = { main, CHECKS };
