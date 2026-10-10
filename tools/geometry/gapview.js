// node gapview.js FILE L X Y [R]: ascii of roads (#), blocked (x), objects (letters), zone digits mod 10 around a tile
const s = require('../mapsight/lib/sight');
const [f, L, X, Y, R0] = process.argv.slice(2); const l = +L, X0 = +X, Y0 = +Y, R = +(R0 || 8);
const M = s.load(f);
const at = new Map();
for (const o of M.objs) if (o.l === l) for (const [x, y] of o.cells) at.set(y * M.W + x, o);
for (let y = Y0 - R; y <= Y0 + R; y++) {
	let line = String(y).padStart(4) + ' ';
	for (let x = X0 - R; x <= X0 + R; x++) {
		if (x < 0 || y < 0 || x >= M.W || y >= M.H) { line += ' '; continue; }
		const i = M.idx(l, x, y), o = at.get(y * M.W + x);
		line += M.road[i] ? (o ? '@' : '#') : o ? (o.cls === 'monster' ? 'M' : o.cls === 'gate' ? 'G' : o.cls[0]) : !M.ground(i) ? '.' : M.blocked[i] ? 'x' : String(M.zoneAt(l, x, y) % 10);
	}
	console.log(line);
}
for (const o of M.objs) if (o.l === l && Math.abs(o.at[0] - X0) <= R && Math.abs(o.at[1] - Y0) <= R && /monster|gate|town|monolith/.test(o.cls)) console.log(o.cls, o.type, o.at.join(','), 'z' + M.zoneAt(l, o.at[0], o.at[1]));
