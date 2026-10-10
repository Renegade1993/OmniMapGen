'use strict';
/**
 * edge_objects.js - objects whose picture crosses the top or left edge of the map (K, 2026-10-08: "can you spot the outcasts and school of
 * magic? both are placed improperly close to the top map edge"). An object is drawn up and to the left of its anchor over its template's mask
 * (every row and column of it, the visible-only 'V' cells included), so it crosses the top edge when anchor y - (mask rows - 1) < 0 and the
 * left edge when anchor x - (mask columns - 1) < 0.
 *
 *   node tools/harness/edge_objects.js MAP|DIR... [--list]
 */
const fs = require('fs');
const path = require('path');
const { readVmap } = require('../../src/preview/render');
const files = [];
for (const a of process.argv.slice(2)) {
	if (a.startsWith('--')) continue;
	if (fs.existsSync(a) && fs.statSync(a).isDirectory()) fs.readdirSync(a).filter(f => f.endsWith('.vmap')).forEach(f => files.push(path.join(a, f)));
	else files.push(a);
}
const LIST = process.argv.includes('--list');
let top = 0, left = 0, n = 0, vtop = 0, vleft = 0;
const kinds = {};
for (const f of files) {
	const { objects } = readVmap(f);
	for (const o of Array.isArray(objects) ? objects : Object.values(objects)) {
		if (!o || !o.template || !o.template.mask) continue;
		n++;
		const h = o.template.mask.length, w = Math.max(...o.template.mask.map(r => r.length));
		const t = o.y - (h - 1) < 0, lf = o.x - (w - 1) < 0;
		if (t) top++;
		if (lf) left++;
		const vis = o.template.mask.some(r => r.includes('A'));
		if (vis && t) vtop++;
		if (vis && lf) vleft++;
		if (t || lf) { const k = `${o.type}${t ? ' top' : ''}${lf ? ' left' : ''}`; kinds[k] = (kinds[k] || 0) + 1; if (LIST) console.log(path.basename(f), o.type, o.subtype, `(${o.x},${o.y}) L${o.l || 0}`, `${w}x${h}`); }
	}
}
console.log(`${files.length} maps, ${n} objects: ${top} cross the top edge, ${left} the left edge; of them visited (a tile with A): ${vtop} top, ${vleft} left`);
console.log(Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => `  ${v} ${k}`).join('\n'));
