#!/usr/bin/env node
'use strict';
/**
 * mapsight - see a map as structure. README.md beside this file says what each command answers and when to use it.
 *
 *   node tools/mapsight/mapsight.js card    <map> [--json out.json] [--all]
 *   node tools/mapsight/mapsight.js near    <map> <x> <y> [--r 5] [--level 0]
 *   node tools/mapsight/mapsight.js render  <map> <out.png> [--level 0] [--crop x,y,w,h] [--px 20] [--pitch 4] [--mark x,y ...]
 *   node tools/mapsight/mapsight.js convert <map.h3m> [--out dir]
 *   node tools/mapsight/mapsight.js compare ...   (Stage 2, see README)
 *   node tools/mapsight/mapsight.js gate    ...   (Stage 3, see README)
 *   node tools/mapsight/mapsight.js diff    --run DIR --match REGEX [--maps ...] (the difference finder, see README)
 *   node tools/mapsight/mapsight.js sweep   --run DIR --match REGEX [--maps ...] [--pictures DIR] (area by area)
 *   node tools/mapsight/mapsight.js report  --engine DIR --ours DIR --out DIR [--match REGEX] (one file per template)
 *   node tools/mapsight/mapsight.js patches --ours FILE... --engine DIR --match REGEX --out DIR [--n 10] (random discovery)
 *   node tools/mapsight/mapsight.js minimap --ours FILE --engine FILE --out DIR [--cell 4] (the whole map at a glance)
 *   node tools/mapsight/mapsight.js zonesheet --ours FILE --engine FILE --out DIR [--zones 1,9] [--px 3] (each zone, ours beside the engine's, one scale)
 *   node tools/mapsight/mapsight.js neighbours|motifs|outliers|walk --ours FILE... --engine FILE...   (discovery, lib/discover.js)
 *   node tools/mapsight/mapsight.js starts  --ours FILE --engine FILE --out DIR (each player's first screen)
 *
 * <map> is a .vmap, or a .h3m (converted on the fly through convert.py, cached in .tmp/mapsight/h3m).
 * Set VCMI_ROOT (and VCMI_USER_DIR for a modded game) for dwelling tiers and the terrain check.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const sight = require('./lib/sight');

const HERE = __dirname;
const PROJECT = path.resolve(HERE, '..', '..', '..');
const NO_WINDOW = { windowsHide: true };

function opt(args, name, dflt) {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : dflt;
}
const pct = v => (v === null || v === undefined ? 'n/a' : `${Math.round(100 * v)}%`);
const xy = (a, l) => `(${a[0]},${a[1]}${l ? ',L' + l : ''})`;

/** A .h3m becomes a cached .vmap through the engine's own reader (convert.py, VCMI_rmgconv.exe). */
function resolveMap(file) {
	if (!/\.h3m$/i.test(file)) return file;
	const cache = path.join(PROJECT, '.tmp', 'mapsight', 'h3m');
	const out = path.join(cache, path.basename(file).replace(/\.h3m$/i, '').replace(/[^\w.-]+/g, '_') + '.vmap');
	if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(file).mtimeMs) return out;
	const r = spawnSync('py', [path.join(HERE, 'convert.py'), file, '--out', cache], { encoding: 'utf8', timeout: 200000, ...NO_WINDOW });
	if (!fs.existsSync(out)) throw new Error(`conversion failed for ${file}: ${(r.stdout || '') + (r.stderr || '')}`.slice(0, 600));
	return out;
}

function card(file, args) {
	const A = sight.analyse(resolveMap(file));
	const m = A.metrics, all = args.includes('--all');
	const lim = n => (all ? Infinity : n);
	const L = [];
	L.push(`MAP ${path.basename(file)}  ${m.size}  levels ${m.levels}  objects ${A.M.objs.length}  monsters ${A.M.monsters.length}` +
		(A.M.zones ? `  zones from ${path.basename(A.M.zones.file)}${A.M.zones.template ? ' (' + A.M.zones.template + ')' : ''}` : '  (no zone sidecar)'));
	if (A.M.zones && A.M.zones.settings) L.push(`SETTINGS ${A.M.zones.settings}`);
	L.push(`STARTS ${A.starts.map(s => `${s.colour}${xy(s.at, s.l)}${s.zone !== undefined ? ' z' + s.zone : ''}`).join('  ')}  underground ${m.starts_underground}/${m.starts}`);
	for (let l = 0; l < A.M.NL; l++) {
		const d = A.census.filter(e => e.o.l === l);
		const tiers = {};
		for (const e of d) tiers[e.tier || '?'] = (tiers[e.tier || '?'] || 0) + 1;
		const dr = {};
		for (const e of d.filter(e => e.dragon)) dr[e.o.subtype] = (dr[e.o.subtype] || 0) + 1;
		L.push(`DWELLINGS L${l}: ${d.length}  by tier ${Object.entries(tiers).map(([k, v]) => `T${k}:${v}`).join(' ')}  neutral dragon ${d.filter(e => e.dragon).length} ${JSON.stringify(dr)}`);
	}
	if (A.zones.length) {
		const Z = A.M.zones.zones;
		L.push('ZONES (dwellings, neutral dragon dwellings by type; zone type from the sidecar):');
		for (const z of A.zones) {
			const info = Z.get(z.zone) || {};
			const towns = A.M.objs.filter(o => o.cls === 'town' && A.M.zoneAt(o.l, o.at[0], o.at[1]) === z.zone).length;
			L.push(`  z${z.zone} ${info.type || '?'}${towns ? ' town' : ''}${info.underground ? ' underground' : ''}: ${z.dwellings} dwellings ${JSON.stringify(z.dragons)}`);
		}
	} else if (A.M.zones && A.M.zones.zones.size) {
		L.push('ZONES (no tile map in the sidecar; its per-zone object list):');
		for (const [, z] of A.M.zones.zones) {
			const dr = Object.entries(z.objects || {}).filter(([k]) => sight.isDragonKey(k));
			if (dr.length || z.type === 'junction') L.push(`  z${z.id} ${z.type}${z.underground ? ' underground' : ''}: ${dr.map(([k, v]) => `${k.split(':')[1]}=${v}`).join(' ') || 'no neutral dragon dwellings'}`);
		}
	}
	if (!A.zones.length) {
		// no zone tile map: guard-bounded regions stand in for zones
		const by = new Map();
		for (const d of A.census.filter(d => d.dragon)) {
			const k = d.region;
			if (!by.has(k)) by.set(k, { l: d.o.l, types: {}, at: d.o.at });
			by.get(k).types[d.o.subtype] = (by.get(k).types[d.o.subtype] || 0) + 1;
		}
		const townR = new Set(A.M.objs.filter(o => o.cls === 'town').flatMap(o => A.M.regionsOf(o)));
		L.push(`DRAGON REGIONS (no zone tile map; guard-bounded regions instead): ${by.size} regions hold neutral dragon dwellings, ${A.metrics.dragon_zones_no_town} of them without a town`);
		for (const [k, v] of by) L.push(`  r${k} L${v.l}${townR.has(k) ? ' town' : ''} near ${xy(v.at)}: ${JSON.stringify(v.types)}`);
	}
	for (const r of A.roads) {
		L.push(`ROADS L${r.l}: ${r.tiles} tiles in ${r.pieces} pieces; ${r.orphanPieces} pieces (${r.orphanTiles} tiles) reach no building; towns ${r.towns} on ${r.townPieces} pieces; ` +
			`entrances joined ${r.joins.joined}, near misses ${r.joins.nearMiss.length}, no road ${r.joins.noRoad}; stubs ${r.stubs.length} (T arms ${r.stubs.filter(s => s.junction && s.junction.arm <= 15).length})`);
		if (r.joins.nearMiss.length) L.push(`  near misses (road within 3 tiles, not on a visiting tile): ${r.joins.nearMiss.slice(0, lim(10)).map(e => `${e.o.type}${xy(e.o.at)} road${xy(e.road)}`).join('  ')}${r.joins.nearMiss.length > lim(10) ? ' ...' : ''}`);
		if (r.stubs.length) L.push(`  stubs: ${r.stubs.slice(0, lim(12)).map(s => `${xy(s.at)}${s.junction ? ` arm ${s.junction.arm} from ${xy(s.junction.at)}` : ' no junction within 30'}`).join('  ')}${r.stubs.length > lim(12) ? ' ...' : ''}`);
	}
	{
		// road ends by the engine's rule (lib/sight.js roadEnds): every end should touch a town, mine, monolith, gate or guard
		const re = A.roadEnds, bad = re.filter(e => e.kind !== 'proper');
		const show = e => `(${e.at[0]},${e.at[1]}${e.l ? ',L1' : ''})` + (e.kind === 'gap' ? ` ${Math.max(Math.abs(e.gapTo[0] - e.at[0]), Math.abs(e.gapTo[1] - e.at[1])) - 1} tiles short of the road at (${e.gapTo})`
			: ` ${e.arm} tiles from ${e.to}${e.touch.length ? ', at ' + e.touch.join(' ') : ''}`);
		L.push(`ROAD ENDS ${re.length}: improper ${bad.length} (at nothing ${A.metrics.road_end_at_nothing}, at an object ${A.metrics.road_end_at_object}, gaps ${A.metrics.road_gap}); the engine's maps wider than 72 have none`);
		for (const k of ['at nothing', 'at an object', 'gap']) {
			const xs = bad.filter(e => e.kind === k);
			if (xs.length) L.push(`  ${k}: ${xs.slice(0, lim(10)).map(show).join('  ')}${xs.length > lim(10) ? ' ...' : ''}`);
		}
	}
	const cls = ['high', 'dwelling', 'mine', 'bank', 'low'];
	for (const c of cls) {
		const rows = A.guarding.filter(e => e.o.cls === c);
		if (!rows.length) continue;
		L.push(`GUARDS ${c.padEnd(8)} n=${String(rows.length).padStart(4)}  reachable past no guard ${pct(rows.filter(e => sight.openAccess(A.M, e.o)).length / rows.length).padStart(4)}  guard within 2 tiles ${pct(rows.filter(e => e.guardDist <= 2).length / rows.length).padStart(4)}  walkable from a start without a fight ${pct(rows.filter(e => e.walkable).length / rows.length).padStart(4)}`);
	}
	const open = A.guarding.filter(e => e.o.cls === 'high' && sight.openAccess(A.M, e.o));
	if (open.length) L.push(`  high-value reachable past no guard: ${open.slice(0, lim(12)).map(e => `${e.o.type}${xy(e.o.at, e.o.l)}${e.walkable ? ' WALKABLE' : ''}`).join('  ')}${open.length > lim(12) ? ` ... (${open.length})` : ''}`);
	if (A.terrain) {
		const vb = A.terrain.bad.filter(b => b.o.visitable);
		L.push(`TERRAIN visitable objects whose art does not belong on their ground: ${vb.length}; scenery: ${A.terrain.bad.length - vb.length} (of ${A.terrain.checked} checked)`);
		if (vb.length) L.push(`  ${vb.slice(0, lim(10)).map(b => `${b.o.type}${xy(b.o.at, b.o.l)} on ${b.terrain} (art allows ${b.allowed.join('/')})`).join('  ')}`);
	} else L.push('TERRAIN check off (set VCMI_ROOT, and VCMI_USER_DIR for a modded game)');
	L.push(`FREE REGIONS ${A.M.regions.length}, largest ${Math.max(0, ...A.M.regions.map(r => r.tiles))} tiles`);
	console.log(L.join('\n'));
	const jsonOut = opt(args, '--json');
	if (jsonOut) {
		const o = e => ({ type: e.type, subtype: e.subtype, cls: e.cls, at: e.at, l: e.l });
		fs.writeFileSync(jsonOut, JSON.stringify({
			file, metrics: m, starts: A.starts.map(s => ({ colour: s.colour, at: s.at, l: s.l, zone: s.zone })),
			zones: A.zones, roads: A.roads.map(r => ({ ...r, joins: { ...r.joins, nearMiss: r.joins.nearMiss.map(e => ({ o: o(e.o), road: e.road })) } })),
			guarding: A.guarding.map(e => ({ o: o(e.o), guardDist: e.guardDist, guard: e.guard && { subtype: e.guard.subtype, amount: e.guard.options && e.guard.options.amount, at: e.guard.at }, walkable: e.walkable })),
			terrain: A.terrain && { checked: A.terrain.checked, bad: A.terrain.bad.map(b => ({ o: o(b.o), terrain: b.terrain, allowed: b.allowed })) },
		}, null, 1));
	}
	return A;
}

function near(file, args) {
	const M = sight.load(resolveMap(file));
	const x = +args[0], y = +args[1], r = +(opt(args, '--r', 5)), l = +(opt(args, '--level', 0));
	const I = sight.index();
	console.log(`within ${r} tiles of (${x},${y}) on level ${l}, by distance (position is the visiting tile):`);
	const rows = M.objs.filter(o => o.l === l && sight.cheb(o.at, [x, y]) <= r && (o.cls !== 'other' || o.visitable))
		.sort((a, b) => sight.cheb(a.at, [x, y]) - sight.cheb(b.at, [x, y]));
	for (const o of rows) {
		let extra = '';
		if (o.cls === 'monster') {
			const c = I && I.creature(o.subtype);
			extra = ` ${o.options && o.options.amount || '?'} x ${o.subtype}${c ? ' (level ' + c.level + ')' : ''}`;
		} else if (o.cls !== 'other') {
			let gd = 99;
			for (const m of M.monsters) if (m.l === l) gd = Math.min(gd, sight.cheb(m.at, o.at));
			extra = ` nearest guard ${gd} tiles`;
		}
		const z = M.zoneAt(l, o.at[0], o.at[1]);
		console.log(`  d${sight.cheb(o.at, [x, y])} ${o.cls.padEnd(8)} ${o.type}${o.subtype && o.subtype !== 'object' ? ':' + o.subtype : ''} (${o.at[0]},${o.at[1]})${z !== undefined ? ' z' + z : ''}${extra}`);
	}
	const rows2 = [];
	for (let dy = -r; dy <= r; dy++) {
		let s = '';
		for (let dx = -r; dx <= r; dx++) {
			const X = x + dx, Y = y + dy;
			if (!M.inb(X, Y)) { s += ' '; continue; }
			const i = M.idx(l, X, Y);
			const ob = M.objs.find(o => o.l === l && o.at[0] === X && o.at[1] === Y && o.cls !== 'other');
			s += ob ? { town: 'T', monster: 'M', high: 'H', low: 'l', dwelling: 'D', mine: 'N', bank: 'K', gate: 'G', monolith: 'O' }[ob.cls]
				: !M.ground(i) ? '~' : M.road[i] ? '=' : M.blocked[i] ? '#' : M.guardOf[i] >= 0 ? '!' : '.';
		}
		rows2.push(`  ${String(y + dy).padStart(3)} ${s}`);
	}
	console.log(`map around it (x ${x - r} to ${x + r}; T town, M monster, H high loot, l low loot, D dwelling, N mine, K bank, G gate, O monolith,`);
	console.log('  = road, # blocked, ! inside a guard ring, ~ water or rock, . open ground):');
	console.log(rows2.join('\n'));
}

function render(file, out, args) {
	const map = resolveMap(file);
	const dump = out.replace(/\.png$/i, '') + '.dump.json';
	const M = sight.load(map);
	const l = +(opt(args, '--level', 0));
	const rows = [];
	for (let y = 0; y < M.H; y++) {
		let s = '';
		for (let x = 0; x < M.W; x++) {
			const i = M.idx(l, x, y);
			s += !M.ground(i) ? (M.terr[i] === 'wa' || M.terr[i] === 'wt' ? 'w' : 'r') : M.road[i] ? '=' : M.blocked[i] ? 'b' : M.guardOf[i] >= 0 ? 'g' : '.';
		}
		rows.push(s);
	}
	fs.writeFileSync(dump, JSON.stringify({ W: M.W, H: M.H, rows, objects: M.objs.filter(o => o.l === l && o.cls !== 'other').map(o => ({ cls: o.cls, at: o.at, type: o.type })) }));
	const pyArgs = [path.join(HERE, 'render.py'), dump, out];
	for (const k of ['--crop', '--px', '--pitch']) if (opt(args, k)) pyArgs.push(k, opt(args, k));
	args.forEach((a, i) => { if (a === '--mark') pyArgs.push('--mark', args[i + 1]); });
	const r = spawnSync('py', pyArgs, { encoding: 'utf8', timeout: 120000, ...NO_WINDOW });
	process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || '');
	fs.unlinkSync(dump);
}

function main() {
	const [cmd, ...args] = process.argv.slice(2);
	if (cmd === 'card') return card(args[0], args.slice(1));
	if (cmd === 'near') return near(args[0], args.slice(1));
	if (cmd === 'render') return render(args[0], args[1], args.slice(2));
	if (cmd === 'convert') { console.log(resolveMap(args[0])); return; }
	if (cmd === 'compare' || cmd === 'gate') return require('./lib/compare').main(cmd, args);
	if (cmd === 'diff') return require('./lib/diff').main(args);
	if (cmd === 'sweep') return require('./lib/sweep').main(args);
	if (cmd === 'report') return require('./lib/report').main(args);
	if (cmd === 'patches') return require('./lib/patches').main(args);
	if (cmd === 'minimap') return require('./lib/minimap').main(args);
	if (cmd === 'zonesheet') return require('./lib/zonesheet').main(args);
	if (cmd === 'discover-all') return require('./lib/discoverall').main(args);
	if (cmd === 'zones') return require('./lib/zones').main(args);
	if (cmd === 'guards') return require('./lib/guards').main(args);
	if (cmd === 'load') return require('./lib/load').main(args);
	if (cmd === 'score') return require('./lib/score').main(args);
	if (cmd === 'shape') return require('./lib/shape').main(args);
	if (cmd === 'check') return require('./lib/check').main(args);
	if (['neighbours', 'motifs', 'outliers', 'walk', 'starts'].includes(cmd)) return require('./lib/discover').main(cmd, args);
	console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(3, 14).join('\n'));
	process.exitCode = 2;
}

if (require.main === module) {
	try { main(); } catch (e) { console.error(`mapsight: ${e.stack || e.message}`); process.exitCode = 2; }
}
module.exports = { card, resolveMap };
