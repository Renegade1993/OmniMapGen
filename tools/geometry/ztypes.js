// node ztypes.js "ZONES" --engine FILES --ours FILES: per type, average count a map in those zones, engine vs ours (per 1000 zone tiles)
const s = require('../mapsight/lib/sight');
const a = process.argv.slice(2), zones = new Set(a[0].split(','));
const grab = flag => { const i = a.indexOf(flag); const out = []; for (let j = i + 1; j < a.length && !a[j].startsWith('--'); j++) out.push(a[j]); return out; };
const agg = files => { const n = new Map(); let tiles = 0; for (const f of files) { const M = s.load(f); for (let l = 0; l < M.NL; l++) for (let y = 0; y < M.H; y++) for (let x = 0; x < M.W; x++) if (zones.has(String(M.zoneAt(l, x, y)))) tiles++; for (const o of M.objs) { if (!zones.has(String(M.zoneAt(o.l, o.at[0], o.at[1])))) continue; if (o.cls === 'other' && !o.visitable) continue; const k = `${o.cls}:${o.type}`; n.set(k, (n.get(k) || 0) + 1); } } return { n, tiles }; };
const E = agg(grab('--engine')), O = agg(grab('--ours'));
const keys = [...new Set([...E.n.keys(), ...O.n.keys()])];
const r = (X, k) => 1000 * (X.n.get(k) || 0) / X.tiles;
keys.sort((x, y) => Math.abs(r(E, y) - r(O, y)) - Math.abs(r(E, x) - r(O, x)));
for (const k of keys.slice(0, 30)) console.log(k.padEnd(40), 'engine', r(E, k).toFixed(2).padStart(6), 'ours', r(O, k).toFixed(2).padStart(6));
