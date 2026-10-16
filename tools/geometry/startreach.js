// tools/geometry/startreach.js MAP...: for each start town, the land zones its hero reaches (on foot, through subterranean gates and
// monoliths, guards counted as beaten) and whether it reaches a shipyard or a boat. A start that misses a land zone and has no shipyard
// is cut off (the Opus Reviewer's R42 on the Mediterranean ring, 2026-10-11). A land zone is one with 20 or more walkable tiles.
// Prints one row per start and PASS or FAIL per map; exit code 1 when any map fails. STARTREACH_JSON=1 prints the rows as JSON.
const sight = require('../mapsight/lib/sight');
function reach(f) {
	const M = sight.load(f), W = M.W, H = M.H, NL = M.NL, WH = W * H;
	const mon = new Set();
	for (const o of M.objs) if (o.cls === 'monster') for (const [x, y] of o.cells) mon.add(o.l * WH + y * W + x);
	const pass = (l, x, y) => { if (!M.inb(x, y)) return false; const i = M.idx(l, x, y); return M.ground(i) && (!M.blocked[i] || mon.has(l * WH + y * W + x)); };
	const ring = (o, fn) => { for (const [ex, ey] of o.entr) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) fn(o.l * WH + (ey + dy) * W + ex + dx); };
	const monos = M.objs.filter(o => /^monolith/i.test(o.type)), gates = M.objs.filter(o => o.type === 'subterraneanGate');
	const monoKey = o => o.type.replace(/Entrance|Exit|TwoWay/i, '') + '|' + o.subtype;
	const monoAt = new Map(), gateAt = new Map(), boatAt = new Map();
	for (const m of monos) if (!/Exit/i.test(m.type)) ring(m, k => monoAt.set(k, m));
	for (const g of gates) ring(g, k => gateAt.set(k, g));
	for (const o of M.objs) if (/^(shipyard|boat)$/.test(o.type) || (o.cls === 'town' && /shipyard/i.test(JSON.stringify(o.options || {})))) ring(o, k => boatAt.set(k, o));
	const land = new Map();
	for (let l = 0; l < NL; l++) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (pass(l, x, y)) { const z = M.zoneAt(l, x, y); if (z != null && z >= 0) land.set(l + ':' + z, (land.get(l + ':' + z) || 0) + 1); }
	const zonesAll = [...land].filter(([, n]) => n >= 20).map(([k]) => k);
	const rows = [];
	for (const t of M.objs.filter(o => o.cls === 'town' && o.options && o.options.owner)) {
		const seen = new Uint8Array(NL * WH), q = [];
		// a key off the grid (an entrance on the last level's bottom row: ring's ey + 1) read as ground past the arrays and, unmarkable in
		// seen, was queued without end (RangeError on a Mediterranean 144 seed 7001 map, 2026-10-15)
		const push = k => { if (!(k >= 0 && k < NL * WH)) return; const l = Math.floor(k / WH), r = k % WH; if (pass(l, r % W, (r / W) | 0) && !seen[k]) { seen[k] = 1; q.push(k); } };
		ring(t, push);
		const usedM = new Set(), usedG = new Set();
		let boat = null;
		for (let h = 0; h < q.length; h++) {
			const k = q[h], l = Math.floor(k / WH), r = k % WH, x = r % W, y = (r / W) | 0;
			if (!boat && boatAt.has(k)) boat = boatAt.get(k);
			const g = gateAt.get(k);
			if (g && !usedG.has(g)) { usedG.add(g); for (const o of gates) if (o.l !== g.l && Math.abs(o.x - g.x) <= 1 && Math.abs(o.y - g.y) <= 1) ring(o, push); }
			const m = monoAt.get(k);
			if (m && !usedM.has(monoKey(m))) { usedM.add(monoKey(m)); for (const o of monos) if (o !== m && monoKey(o) === monoKey(m) && !/Entrance/i.test(o.type)) ring(o, push); }
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && M.inb(x + dx, y + dy)) push(l * WH + (y + dy) * W + x + dx);
		}
		const got = new Set();
		for (let k = 0; k < NL * WH; k++) if (seen[k]) { const l = Math.floor(k / WH), r = k % WH, z = M.zoneAt(l, r % W, (r / W) | 0); if (z != null && z >= 0) got.add(l + ':' + z); }
		const miss = zonesAll.filter(z => !got.has(z));
		rows.push({ owner: t.options.owner, at: [t.x, t.y, t.l], zones: zonesAll.length - miss.length, of: zonesAll.length, miss,
			boat: boat ? `${boat.type} (${boat.x},${boat.y})` : null, ok: !miss.length || !!boat });
	}
	return rows;
}
module.exports = { reach };
if (require.main === module) {
let bad = 0;
for (const f of process.argv.slice(2)) {
	const rows = reach(f), ok = rows.length && rows.every(r => r.ok);
	if (!ok) bad++;
	if (process.env.STARTREACH_JSON) { console.log(JSON.stringify({ map: f, ok, rows })); continue; }
	console.log(`${ok ? 'PASS' : 'FAIL'} ${f.split(/[\\/]/).pop()}`);
	for (const r of rows) console.log(`  ${String(r.owner).padEnd(7)} (${r.at.join(',')})  zones ${r.zones} of ${r.of}  shipyard ${r.boat || 'none'}${r.miss.length ? '  missing ' + r.miss.map(z => 'z' + z.split(':')[1] + (z[0] === '1' ? 'u' : '')).join(' ') : ''}`);
}
process.exitCode = bad ? 1 : 0;
}
