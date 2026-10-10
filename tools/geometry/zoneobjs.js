// node zoneobjs.js FILE ZONE [cls]: object types in a template zone (both levels), counted, by class
const s = require('../mapsight/lib/sight');
const [f, Z, cls] = process.argv.slice(2);
const M = s.load(f), n = new Map();
for (const o of M.objs) { if (String(M.zoneAt(o.l, o.at[0], o.at[1])) !== Z || (cls && o.cls !== cls)) continue; const k = `${o.cls} ${o.type}${o.subtype !== undefined ? '/' + o.subtype : ''} L${o.l}`; n.set(k, (n.get(k) || 0) + 1); }
console.log(f.split(/[\/]/).pop(), [...n].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`).join(', '));
