'use strict';
/**
 * zonesheet.js - every template zone, ours beside the engine's, as pictures at one scale. K, 2026-10-02, a design
 * directive: "continue to innovate as to HOW you are determining the difference between the vcmi map and our map ...
 * be sure also not to forsake visual cohesiveness comparisons, do not only use statistical compares."
 *
 *   mapsight zonesheet --ours FILE --engine FILE --out DIR [--zones 1,9,17] [--px 3]
 *
 * Writes DIR/zonesheet.png and DIR/zonesheet.md. For each template zone found on both maps: the zone's box on the
 * level that holds most of it, ours left, the engine's right, both at the same pixels a tile (so a zone that came out
 * too big or too small shows as one), the zone outlined in white and everything outside it dimmed, in game-minimap
 * colours with towns, guards, high loot, dwellings, banks and mines marked. Under each pair, a line of counts on each
 * side: open tiles, road tiles, guards, high loot, dwellings, banks, mines, towns. Look at the pictures first: the
 * shape of the zone, where its town and links sit, how its roads run, whether its loot is piled or strewn.
 *
 * Needs a zone tile map on both sides (the engine's sidecar from rmgdump with zoneTiles, ours with templateIds).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const sight = require('./sight');
const { terrainColor } = require('../../../src/preview/palette');

function opt(args, name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }

/** One map's zones: for each, the level holding most of it, its box there and its counts. */
function zonesOf(file) {
	const A = sight.analyse(file), M = A.M;
	if (!M.zones || !M.zones.zoneOf) return null;
	const Z = new Map();
	for (let l = 0; l < M.NL; l++) for (let y = 0; y < M.H; y++) for (let x = 0; x < M.W; x++) {
		const z = M.zoneAt(l, x, y);
		if (z === undefined || z === null || z < 0) continue;
		if (!Z.has(z)) Z.set(z, { id: z, per: {} });
		const e = Z.get(z), p = e.per[l] || (e.per[l] = { n: 0, x0: 1e9, y0: 1e9, x1: -1, y1: -1, open: 0, road: 0 });
		p.n++;
		p.x0 = Math.min(p.x0, x); p.y0 = Math.min(p.y0, y); p.x1 = Math.max(p.x1, x); p.y1 = Math.max(p.y1, y);
		const i = M.idx(l, x, y);
		if (M.ground(i) && !M.blocked[i]) p.open++;
		if (M.road[i]) p.road++;
	}
	for (const e of Z.values()) {
		e.l = +Object.entries(e.per).sort((a, b) => b[1].n - a[1].n)[0][0];
		e.box = e.per[e.l];
		e.c = {};
	}
	for (const o of M.objs) {
		const z = M.zoneAt(o.l, o.at[0], o.at[1]);
		const e = Z.get(z);
		if (!e || o.l !== e.l) continue;
		const k = o.cls === 'town' ? 'towns' : o.cls === 'monster' ? 'guards' : o.cls === 'high' ? 'high loot' : o.cls === 'dwelling' ? 'dwellings'
			: o.cls === 'bank' ? 'banks' : o.cls === 'mine' ? 'mines' : o.cls === 'gate' || o.cls === 'monolith' ? 'link ends' : null;
		if (k) e.c[k] = (e.c[k] || 0) + 1;
	}
	return { A, M, Z };
}

/** The crop of one zone's box (with a margin of 2), in minimap colours, the zone outlined, the rest dimmed. */
function crop(X, e) {
	const { M } = X, l = e.l, b = e.box, m = 2;
	const x0 = Math.max(0, b.x0 - m), y0 = Math.max(0, b.y0 - m), x1 = Math.min(M.W - 1, b.x1 + m), y1 = Math.min(M.H - 1, b.y1 + m);
	const inZ = (x, y) => x >= 0 && y >= 0 && x < M.W && y < M.H && M.zoneAt(l, x, y) === e.id;
	const rows = [];
	for (let y = y0; y <= y1; y++) {
		const row = [];
		for (let x = x0; x <= x1; x++) {
			const i = M.idx(l, x, y), t = M.terr[i];
			let col = t === 'rc' || t === 'ro' ? [20, 20, 20] : terrainColor(t);
			if (M.blocked[i] && !(t === 'rc' || t === 'ro')) col = col.map(v => Math.round(v * 0.55));
			if (M.road[i]) col = [150, 105, 60];
			const z = inZ(x, y);
			if (!z) col = col.map(v => Math.round(v * 0.35 + 150 * 0.3));
			else if (!inZ(x + 1, y) || !inZ(x - 1, y) || !inZ(x, y + 1) || !inZ(x, y - 1)) col = [255, 255, 255];
			row.push(col);
		}
		rows.push(row);
	}
	const marks = M.objs.filter(o => o.l === l && o.at[0] >= x0 && o.at[0] <= x1 && o.at[1] >= y0 && o.at[1] <= y1
		&& ['town', 'monster', 'high', 'dwelling', 'bank', 'mine', 'gate', 'monolith'].includes(o.cls))
		.map(o => ({ cls: o.cls, at: [o.at[0] - x0, o.at[1] - y0], owner: o.options && o.options.owner }));
	return { rows, marks };
}

const KEYS = ['open', 'road', 'guards', 'high loot', 'dwellings', 'banks', 'mines', 'towns', 'link ends'];
const countsOf = e => ({ open: e.box.open, road: e.box.road, ...e.c });

function main(args) {
	const ours = opt(args, '--ours'), eng = opt(args, '--engine'), out = opt(args, '--out');
	if (!ours || !eng || !out) { console.log('zonesheet needs --ours FILE --engine FILE --out DIR [--zones 1,9,17] [--px 3]'); process.exitCode = 2; return; }
	const a = zonesOf(ours), b = zonesOf(eng);
	if (!a || !b) { console.log('zonesheet needs a zone tile map on both sides (sidecar zones.json)'); process.exitCode = 2; return; }
	const want = opt(args, '--zones') ? opt(args, '--zones').split(',').map(Number) : null;
	const ids = [...a.Z.keys()].filter(z => b.Z.has(z) && (!want || want.includes(z))).sort((p, q) => p - q);
	fs.mkdirSync(out, { recursive: true });
	const pairs = [], md = [`# Zone sheet: ours ${path.basename(ours)} (left) beside the engine's ${path.basename(eng)} (right)`, '',
		'Each pair is one template zone on the level that holds most of it, both at the same scale. White line: the zone\'s edge; dimmed: other zones.', '',
		`| zone | level ours/engine | ${KEYS.join(' | ')} |`, `|---|---|${KEYS.map(() => '---').join('|')}|`];
	for (const z of ids) {
		const ea = a.Z.get(z), eb = b.Z.get(z), ca = countsOf(ea), cb = countsOf(eb);
		const line = KEYS.map(k => `${ca[k] || 0}/${cb[k] || 0}`);
		md.push(`| ${z} | ${ea.l}/${eb.l} | ${line.join(' | ')} |`);
		pairs.push({ zone: z, left: crop(a, ea), right: crop(b, eb), caption: `zone ${z} (L${ea.l}/L${eb.l})  ` + KEYS.map((k, i) => `${k} ${line[i]}`).join('  ') });
	}
	const dump = path.join(out, 'zonesheet.json');
	fs.writeFileSync(dump, JSON.stringify({ pairs, px: +(opt(args, '--px') || 3) }));
	const r = spawnSync('py', [path.join(__dirname, '..', 'zonesheet.py'), dump, path.join(out, 'zonesheet.png')], { timeout: 120000, windowsHide: true, encoding: 'utf8' });
	if (r.status !== 0) console.log(r.stderr || r.stdout);
	fs.unlinkSync(dump);
	md.push('', 'Each cell: ours/engine. Picture: zonesheet.png.');
	fs.writeFileSync(path.join(out, 'zonesheet.md'), md.join('\n') + '\n');
	console.log(`zonesheet written to ${out} (${ids.length} zones)`);
}

module.exports = { main, zonesOf };
