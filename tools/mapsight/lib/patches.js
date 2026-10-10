'use strict';
/**
 * patches.js - random discovery. K, 2026-10-01: "random discovery methods ... even if it's just a 20x20 patch, 10 or so at
 * random from any map ... especially if its also looking at a reference map beside it to try and match a zone from ours
 * to it". Catches what no named measure covers.
 *
 *   mapsight patches --ours FILE... --engine DIR [--match REGEX] [--n 10] [--size 20] [--seed 1] --out DIR
 *
 * For each map of ours: n patches at random on walkable ground, spread over levels and kinds of area (start, town,
 * dragon cache, wild). Each is paired with the engine patch (from the engine maps --match selects) whose CONTEXT is
 * closest: same level, same kind of area, similar share of walls, of walkable ground and distance to the nearest town.
 * Content is then free to differ, and the differences are what to look at. Per pair: a picture with both side by side at
 * the same scale, both as text maps, the objects of each with their relationships (what a guard closes, sealed or open,
 * against a wall or on open floor), and the content differences of the pair ranked.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const sight = require('./sight');
const { describe, walls, AREA_MIN } = require('./relations');

function opt(args, name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }
function list(args, name) {
	const out = [];
	args.forEach((a, i) => { if (a === name) for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) out.push(args[j]); });
	return out;
}
function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

/** A map ready for patching: analysis, walls, the kind of every big area. */
function prepare(file) {
	const A = sight.analyse(file), M = A.M;
	describe(A);
	const W = A._walls || walls(M);
	const areaOf = A._areaOf;
	const startAreas = new Set(A.starts.map(s => areaOf({ type: 'start', at: s.at, l: s.l })));
	const kind = new Map();
	for (const r of M.regions.filter(x => x.tiles >= AREA_MIN)) {
		const objs = M.objs.filter(o => o.cls !== 'other' && areaOf(o) === r.id);
		kind.set(r.id, startAreas.has(r.id) ? 'start' : objs.some(o => o.cls === 'town') ? 'town'
			: A.census.some(d => d.dragon && areaOf(d.o) === r.id) ? 'dragon cache' : 'wild');
	}
	const towns = M.objs.filter(o => o.cls === 'town');
	return { file, A, M, W, areaOf, kind, towns };
}

/** Context and content of one patch (x0, y0 top-left, size s, level l). */
function patchOf(P, l, x0, y0, s) {
	const { M, W, A } = P;
	let walls = 0, walk = 0, water = 0, roads = 0, openFloor = 0;
	const kinds = {};
	for (let y = y0; y < y0 + s; y++) for (let x = x0; x < x0 + s; x++) {
		const i = M.idx(l, x, y);
		if (!M.ground(i)) { water++; continue; }
		if (W.isWall(i)) walls++;
		if (W.pass(i)) { walk++; if (W.dist[i] >= 4) openFloor++; const r = M.region[i]; const k = P.kind.get(r) || (r >= 0 ? 'pocket' : 'guarded'); kinds[k] = (kinds[k] || 0) + 1; }
		if (M.road[i]) roads++;
	}
	const n = s * s;
	const inP = o => o.l === l && o.at[0] >= x0 && o.at[0] < x0 + s && o.at[1] >= y0 && o.at[1] < y0 + s;
	const objs = M.objs.filter(o => inP(o) && (o.cls !== 'other' || o.visitable));
	const cnt = c => objs.filter(o => o.cls === c).length;
	const cx = x0 + s / 2, cy = y0 + s / 2;
	let townD = 99; for (const t of P.towns) if (t.l === l) townD = Math.min(townD, Math.max(Math.abs(t.at[0] - cx), Math.abs(t.at[1] - cy)));
	const mainKind = Object.entries(kinds).filter(([k]) => k !== 'pocket' && k !== 'guarded').sort((a, b) => b[1] - a[1])[0];
	const open = o => sight.openAccess(M, o);
	const prizes = objs.filter(o => o.cls === 'high' || o.cls === 'dwelling' || o.cls === 'bank');
	return {
		l, x0, y0, s,
		context: { kind: mainKind ? mainKind[0] : 'none', wall: walls / n, walk: walk / n, water: water / n, townD: Math.min(townD, 60) },
		content: {
			'guards': cnt('monster'), 'high loot': cnt('high'), 'low loot': cnt('low'), 'dwellings': cnt('dwelling'), 'banks': cnt('bank'),
			'mines': cnt('mine'), 'small buildings': objs.filter(o => o.cls === 'other').length, 'towns': cnt('town'),
			'road tiles': roads, 'open floor tiles (4+ from a wall)': openFloor,
			'prizes sealed behind a guard': prizes.filter(o => !open(o)).length, 'prizes reachable past no guard': prizes.filter(o => open(o)).length,
		},
		objs,
	};
}

/** Random patch corners on walkable ground, spread over the map's levels and kinds of area. */
function sample(P, n, s, rand) {
	const { M, W } = P;
	const cands = [];
	for (let t = 0; t < 4000 && cands.length < n * 30; t++) {
		const l = Math.floor(rand() * M.NL), x0 = Math.floor(rand() * (M.W - s)), y0 = Math.floor(rand() * (M.H - s));
		const i = M.idx(l, x0 + (s >> 1), y0 + (s >> 1));
		if (!W.pass(i)) continue;
		cands.push(patchOf(P, l, x0, y0, s));
	}
	// spread: round-robin over (level, kind) buckets, no two patches overlapping by more than a quarter
	const buckets = new Map();
	for (const c of cands) { const k = `${c.l}|${c.context.kind}`; if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(c); }
	const out = [], keys = [...buckets.keys()];
	for (let round = 0; out.length < n && round < 200; round++) for (const k of keys) {
		if (out.length >= n) break;
		const b = buckets.get(k), c = b && b.shift();
		if (!c) continue;
		if (out.some(o => o.l === c.l && Math.abs(o.x0 - c.x0) < s * 0.75 && Math.abs(o.y0 - c.y0) < s * 0.75)) continue;
		out.push(c);
	}
	return out;
}

function ctxDistance(a, b) {
	if (a.l !== b.l) return 1e9;
	return (a.context.kind === b.context.kind ? 0 : 3) + 2 * Math.abs(a.context.wall - b.context.wall) + 2 * Math.abs(a.context.walk - b.context.walk)
		+ 2 * Math.abs(a.context.water - b.context.water) + Math.abs(a.context.townD - b.context.townD) / 30;
}

/** Text map of a patch and its objects with their relationships. */
function textOf(P, p) {
	const { M, W } = P;
	const rows = [];
	const sym = { town: 'T', monster: 'M', high: 'H', low: 'l', dwelling: 'D', mine: 'N', bank: 'K', gate: 'G', monolith: 'O', other: 's' };
	for (let y = p.y0; y < p.y0 + p.s; y++) {
		let r = '';
		for (let x = p.x0; x < p.x0 + p.s; x++) {
			const i = M.idx(p.l, x, y);
			const o = p.objs.find(q => q.at[0] === x && q.at[1] === y);
			r += o ? sym[o.cls] || '?' : !M.ground(i) ? '~' : M.road[i] ? '=' : W.isWall(i) ? '#' : M.blocked[i] ? '%' : M.guardOf[i] >= 0 ? '!' : '.';
		}
		rows.push(`${String(y).padStart(3)} ${r}`);
	}
	const lines = p.objs.filter(o => o.cls !== 'other' || o.visitable).map(o => {
		const wd = W.dist[M.idx(o.l, o.at[0], o.at[1])];
		const where = wd <= 1 ? 'against a wall' : wd >= 3 ? 'on open floor' : 'near a wall';
		if (o.cls === 'monster') {
			let gd = [];
			for (const q of p.objs) if (q !== o && q.cls !== 'monster' && sight.cheb(q.at, o.at) <= 2) gd.push(`${q.type}${sight.openAccess(M, q) ? ' (still open)' : ' (sealed)'}`);
			return `  M ${(o.options && o.options.amount) || '?'} ${o.subtype} (${o.at}) ${where}; next to: ${gd.join(', ') || 'nothing'}`;
		}
		return `  ${sym[o.cls] || '?'} ${o.type}${o.subtype && o.subtype !== 'object' ? ':' + o.subtype : ''} (${o.at}) ${where}, ${sight.openAccess(M, o) ? 'reachable past no guard' : 'sealed behind a guard'}`;
	});
	return { map: rows, objects: lines };
}

function main(args) {
	const n = +(opt(args, '--n') || 10), s = +(opt(args, '--size') || 20), out = opt(args, '--out');
	const seed = +(opt(args, '--seed') || 1);
	if (!out) { console.log('patches needs --out DIR'); process.exitCode = 2; return; }
	const match = opt(args, '--match') ? new RegExp(opt(args, '--match'), 'i') : null;
	const edir = opt(args, '--engine');
	const engine = edir ? fs.readdirSync(edir).filter(f => f.endsWith('.vmap') && (!match || match.test(f))).map(f => path.join(edir, f)) : [];
	const ours = list(args, '--ours');
	if (!engine.length || !ours.length) { console.log(`patches needs --ours maps and --engine maps (engine ${engine.length})`); process.exitCode = 2; return; }
	fs.mkdirSync(out, { recursive: true });
	const rand = rng(seed);
	const EP = engine.map(prepare);
	const pool = EP.flatMap(P => sample(P, 40, s, rand).map(p => ({ P, p })));
	const md = [`# Random patches, ours beside the closest engine patch`, '', `Engine pool: ${pool.length} patches from ${engine.length} maps. Legend for the text maps: T town, M monster, H high loot, l low loot, D dwelling, N mine, K bank, G gate, O monolith, s small building, = road, # wall, % scattered obstacle, ! guard ring, ~ water or rock, . open ground.`, ''];
	let k = 0;
	for (const f of ours) {
		const P = prepare(f);
		for (const p of sample(P, n, s, rand)) {
			k++;
			let best = null, bd = 1e9;
			for (const c of pool) { const d = ctxDistance(p, c.p); if (d < bd) { bd = d; best = c; } }
			if (!best) continue;
			const q = best.p;
			const diffs = Object.keys(p.content).map(key => ({ key, a: p.content[key], b: q.content[key] }))
				.filter(d => d.a !== d.b).sort((x, y) => Math.abs(y.a - y.b) / (1 + Math.min(x.a, y.b)) - Math.abs(x.a - x.b) / (1 + Math.min(x.a, x.b)));
			const name = `p${String(k).padStart(2, '0')}`;
			// the picture: both patches at the same scale, ours left
			const dump = path.join(out, `${name}.json`);
			const sideOf = (PP, pp) => {
				const rows = [];
				for (let y = pp.y0; y < pp.y0 + s; y++) {
					let r = '';
					for (let x = pp.x0; x < pp.x0 + s; x++) { const i = PP.M.idx(pp.l, x, y); r += !PP.M.ground(i) ? 'r' : PP.M.road[i] ? '=' : PP.M.blocked[i] ? 'b' : PP.M.guardOf[i] >= 0 ? 'g' : '.'; }
					rows.push(r);
				}
				return { x0: pp.x0, y0: pp.y0, rows, objects: pp.objs.map(o => ({ cls: o.cls, at: o.at })), title: `${path.basename(PP.file, '.vmap')} L${pp.l} x ${pp.x0}-${pp.x0 + s - 1} y ${pp.y0}-${pp.y0 + s - 1} (${pp.context.kind})` };
			};
			fs.writeFileSync(dump, JSON.stringify({ s, left: sideOf(P, p), right: sideOf(best.P, q) }));
			spawnSync('py', [path.join(__dirname, '..', 'pair.py'), dump, path.join(out, `${name}.png`)], { timeout: 60000, windowsHide: true });
			fs.unlinkSync(dump);
			const ta = textOf(P, p), tb = textOf(best.P, q);
			md.push(`## ${name}: ours ${path.basename(f)} L${p.l} (${p.x0},${p.y0}) to (${p.x0 + s - 1},${p.y0 + s - 1}), ${p.context.kind}; engine ${path.basename(best.P.file)} L${q.l} (${q.x0},${q.y0}), ${q.context.kind}`);
			md.push(`Context: walls ${Math.round(100 * p.context.wall)}% / ${Math.round(100 * q.context.wall)}%, walkable ${Math.round(100 * p.context.walk)}% / ${Math.round(100 * q.context.walk)}%, nearest town ${p.context.townD} / ${q.context.townD} tiles. Picture: ${name}.png (ours left).`);
			md.push(`Differences (ours / engine): ${diffs.slice(0, 8).map(d => `${d.key} ${d.a} / ${d.b}`).join('; ') || 'none in the counts; compare the layout'}`);
			md.push('', '```', 'ours'.padEnd(s + 5) + 'engine');
			for (let r = 0; r < s; r++) md.push(`${ta.map[r]}  ${tb.map[r]}`);
			md.push('```', 'Ours:', ...ta.objects, 'Engine:', ...tb.objects, '');
		}
	}
	fs.writeFileSync(path.join(out, 'patches.md'), md.join('\n') + '\n');
	console.log(`${k} patches written to ${out} (patches.md and p*.png)`);
}

module.exports = { main, prepare, patchOf, sample };
