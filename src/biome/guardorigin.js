'use strict';
/**
 * guardorigin.js - which pass put each stack down, for the guard-stage rewrite (MORNING ORDER item 4, the lead 2026-10-12 14:55: 43 of 80
 * grid maps over the crowding limit). planMap calls mark() before each of its passes, named by the comment that opens it: a stack seen there
 * for the first time belongs to the pass that ran since the last mark (the first: the levels' own plans, the content fill). Nothing is
 * written into the plan or the map; with VMAPGEN_GUARD_ORIGIN naming a file, dump() writes every stack's level, place, pass and whether it moved since, there
 * (tools/harness/crowd_origin.js reads it). Unset, both do nothing.
 */
const fs = require('fs');

const MON = /^(monster|randomMonster)/;
const seen = new WeakMap();
let last = 'the levels plans (content fill)';

function mark(plans, levels, label) {
	if (!process.env.VMAPGEN_GUARD_ORIGIN) return;
	for (let l = 0; l < levels; l++) {
		const pl = plans[l];
		if (!pl || !pl.objects) continue;
		for (const o of pl.objects) if (MON.test(o.type) && !seen.has(o)) seen.set(o, { by: last, x: o.x, y: o.y });
	}
	last = label;
}

function dump(plans, levels) {
	const file = process.env.VMAPGEN_GUARD_ORIGIN;
	if (!file) return;
	mark(plans, levels, 'after planMap');
	const out = [];
	for (let l = 0; l < levels; l++) {
		const pl = plans[l];
		if (!pl || !pl.objects) continue;
		for (const o of pl.objects) if (MON.test(o.type) && (o.l || 0) === l) { const s0 = seen.get(o) || {}; out.push({ l, x: o.x, y: o.y, by: s0.by, moved: s0.x !== o.x || s0.y !== o.y }); }
	}
	fs.writeFileSync(file, JSON.stringify(out));
}

module.exports = { mark, dump };
