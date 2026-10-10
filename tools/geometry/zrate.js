// node zrate.js "ZONES" --engine FILES --ours FILES: per zone, guards and high loot per 100 zone tiles, engine mean (min-max) vs ours
const s = require('../mapsight/lib/sight');
const a = process.argv.slice(2), zones = a[0].split(',');
const grab = flag => { const i = a.indexOf(flag); const out = []; for (let j = i + 1; j < a.length && !a[j].startsWith('--'); j++) out.push(a[j]); return out; };
const stat = f => { const M = s.load(f); const r = {}; for (const Z of zones) r[Z] = { tiles: 0, g: 0, h: 0, lo: 0 }; for (let l = 0; l < M.NL; l++) for (let y = 0; y < M.H; y++) for (let x = 0; x < M.W; x++) { const z = String(M.zoneAt(l, x, y)); if (r[z]) r[z].tiles++; } for (const o of M.objs) { const z = String(M.zoneAt(o.l, o.at[0], o.at[1])); if (!r[z]) continue; if (o.cls === 'monster') r[z].g++; if (o.cls === 'high') r[z].h++; if (o.cls === 'low') r[z].lo++; } return r; };
const E = grab('--engine').map(stat), O = grab('--ours').map(stat);
const f = (L, Z, k) => { const v = L.filter(r => r[Z].tiles).map(r => 100 * r[Z][k] / r[Z].tiles); const m = v.reduce((x, y) => x + y, 0) / (v.length || 1); return `${m.toFixed(2)} (${Math.min(...v).toFixed(1)}-${Math.max(...v).toFixed(1)})`; };
for (const Z of zones) console.log(`zone ${Z.padStart(2)} tiles e ${Math.round(E.reduce((x, r) => x + r[Z].tiles, 0) / E.length)} o ${Math.round(O.reduce((x, r) => x + r[Z].tiles, 0) / O.length)} | guards e ${f(E, Z, 'g')} o ${f(O, Z, 'g')} | high e ${f(E, Z, 'h')} o ${f(O, Z, 'h')} | low e ${f(E, Z, 'lo')} o ${f(O, Z, 'lo')}`);
