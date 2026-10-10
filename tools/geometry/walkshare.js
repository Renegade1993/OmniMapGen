// tools/geometry/walkshare.js MAP...: share of all walkable land reached from the start towns on foot and through
// subterranean gates, monoliths not counted (2026-10-04). Engine Coldshadow 144 and 72: 50-80% (it links many zones by
// monolith only); a map well under that leaves zones a hero reaches only by portal.
const sight = require('../mapsight/lib/sight');
for (const f of process.argv.slice(2)) {
const M = sight.load(f); const W = M.W, H = M.H, NL = M.NL;
const mon = new Set(); for (const o of M.objs) if (o.cls === 'monster') for (const [x, y] of o.cells) mon.add(o.l * W * H + y * W + x);
const pass = (l, x, y) => { if (!M.inb(x, y)) return false; const i = M.idx(l, x, y); return M.ground(i) && (!M.blocked[i] || mon.has(l * W * H + y * W + x)); };
const monos = M.objs.filter(o => /^monolith/i.test(o.type));
const monoKey = o => o.type.replace(/Entrance|Exit/i, '') + '|' + o.subtype;
const monoAt = new Map(); for (const m of monos) if (!/Exit/i.test(m.type)) for (const [ex, ey] of m.entr) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) monoAt.set(m.l * W * H + (ey + dy) * W + ex + dx, m);
const usedM = new Set();
const flood = withMono => {
const seen = new Uint8Array(NL * W * H), q = [];
const push = (l, x, y) => { const k = l * W * H + y * W + x; if (pass(l, x, y) && !seen[k]) { seen[k] = 1; q.push(k); } };
for (const t of M.objs.filter(o => o.cls === 'town' && o.options && o.options.owner)) for (const [x, y] of t.entr) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) push(t.l, x + dx, y + dy);
const gates = M.objs.filter(o => o.type === 'subterraneanGate');
const gateAt = new Map(); for (const g of gates) for (const [ex, ey] of g.entr) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) gateAt.set(g.l * W * H + (ey + dy) * W + ex + dx, g);
const usedG = new Set();
for (let h = 0; h < q.length; h++) { const k = q[h], l = Math.floor(k / (W * H)), r = k % (W * H), x = r % W, y = (r / W) | 0;
	const g = gateAt.get(k); if (g && !usedG.has(g)) { usedG.add(g); for (const o of gates.filter(o => o.l !== g.l && Math.abs(o.x - g.x) <= 1 && Math.abs(o.y - g.y) <= 1)) for (const [ex, ey] of o.entr) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) push(o.l, ex + dx, ey + dy); }
	const m = withMono && monoAt.get(k); if (m && !usedM.has(monoKey(m))) { usedM.add(monoKey(m)); for (const o of monos.filter(o => o !== m && monoKey(o) === monoKey(m) && !/Entrance/i.test(o.type))) for (const [ex, ey] of o.entr) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) push(o.l, ex + dx, ey + dy); }
	for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) push(l, x + dx, y + dy); }
return seen;
};
const seenAll = flood(true);
const seen = flood(false);
let tot = 0, got = 0, gotAll = 0; for (let l = 0; l < NL; l++) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (pass(l, x, y)) { tot++; if (seen[l * W * H + y * W + x]) got++; if (seenAll[l * W * H + y * W + x]) gotAll++; }
console.log(f.split(/[\/]/).pop().padEnd(26), 'walk+gates share', (100 * got / tot).toFixed(0) + '%', 'with monoliths', (100 * gotAll / tot).toFixed(0) + '%', 'monoliths', M.objs.filter(o => /monolith/.test(o.type)).length);
if (process.env.WALK_ZONES && M.zoneAt) { // WALK_ZONES=1: each zone's walkable tiles and the share reached on foot
	const zt = new Map(), zg = new Map();
	for (let l = 0; l < NL; l++) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { if (!pass(l, x, y)) continue; const z = M.zoneAt(l, x, y); if (z == null || z < 0) continue; const k = l + ':' + z; zt.set(k, (zt.get(k) || 0) + 1); if (seen[l * W * H + y * W + x]) zg.set(k, (zg.get(k) || 0) + 1); }
	console.log('   ' + [...zt].sort((a, b) => (zg.get(a[0]) || 0) / a[1] - (zg.get(b[0]) || 0) / b[1]).map(([k, t]) => `z${k.split(':')[1]}${k[0] === '1' ? 'u' : ''} ${(100 * (zg.get(k) || 0) / t).toFixed(0)}%/${t}`).join('  '));
}
}
