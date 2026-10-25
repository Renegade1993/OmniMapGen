'use strict';
/**
 * guardDistance.js - Guards by distance (knob guardDistance, 0 to 1, default 0; roster\DESIGN-MapVision-LayoutFamily.md section 2).
 *
 * Once every guard stands and before the placeholders become creatures, each stack on a level is ranked by its distance to the nearest
 * start (0 the nearest of the level's stacks, 1 the farthest; stacks at the same distance share a rank) and its creature level moves by
 * round(g x 2.4 x (rank - 0.5)), within 1 to 7: at 1 the stacks nearest the starts (rank under about 0.29) are a level weaker and the
 * farthest (over about 0.71) a level stronger; the steps on each level sum to nothing (a stack at 1 or 7 that cannot move has the move
 * the other way nearest the middle rank undone for it), so the mean level holds. Every stack moves: pile, mine, dwelling,
 * link and roaming guards alike (Guard gradient moves the link guards only, and stays as it is). A guard whose creature the engine's
 * rule picked already (the template's concrete guards, `picked`) keeps its creature and has its count scaled by the mean strength of a
 * creature of the new level over the old one; one with no count of its own is left. Distance is straight-line over the map's plane,
 * starts on either level counted. No random draw; at 0 nothing runs, so a map is as it was.
 */
const PLACEHOLDER = /^randomMonsterLevel([1-7])$/;

function guardsByDistance(objects, { picked = null, starts = [], g = 0, perCreature = null } = {}) {
	const out = { stacks: 0, weaker: 0, stronger: 0 };
	if (!(g > 0) || !starts.length) return out;
	const byLevel = new Map();
	for (const o of objects) {
		const m = PLACEHOLDER.exec(o.type);
		if (!m) continue;
		const l = o.l || 0;
		if (!byLevel.has(l)) byLevel.set(l, []);
		byLevel.get(l).push({ o, level: +m[1], d: Math.min(...starts.map(t => (t.x - o.x) ** 2 + (t.y - o.y) ** 2)) });
	}
	for (const list of byLevel.values()) {
		list.sort((a, b) => a.d - b.d);
		const n = list.length;
		out.stacks += n;
		for (let i = 0; i < n;) {
			let j = i;
			while (j + 1 < n && list[j + 1].d === list[i].d) j++;
			const rank = n > 1 ? (i + j) / 2 / (n - 1) : 0.5;
			for (let k = i; k <= j; k++) list[k].rank = rank;
			i = j + 1;
		}
		for (const s of list) s.to = Math.min(7, Math.max(1, s.level + Math.round(g * 2.4 * (s.rank - 0.5))));
		// a stack at level 1 cannot go weaker (nor one at 7 stronger), which would lift the mean (48x48 four players seed 1: 3.14 to 3.35):
		// the moves the other way nearest the middle rank are undone until the level's steps sum to nothing
		let net = list.reduce((a, s) => a + s.to - s.level, 0);
		const undo = (dir, pick) => {
			const c = list.filter(s => Math.sign(s.to - s.level) === dir).sort(pick);
			for (const s of c) { if (net * dir <= 0) break; net -= s.to - s.level; s.to = s.level; }
		};
		if (net > 0) undo(1, (a, b) => a.rank - b.rank);
		else if (net < 0) undo(-1, (a, b) => b.rank - a.rank);
		for (const s of list) {
			const to = s.to;
			if (to === s.level) continue;
			const o = s.o;
			if (picked && picked.has(o)) {
				const a = o.options && o.options.amount;
				if (!(a > 0) || !perCreature) continue;
				o.options.amount = Math.max(1, Math.round(a * perCreature(to) / perCreature(s.level)));
			} else {
				const was = o.type;
				o.type = `randomMonsterLevel${to}`;
				if (typeof o.instanceName === 'string' && o.instanceName.startsWith(was + '_')) o.instanceName = o.type + o.instanceName.slice(was.length);
			}
			if (to > s.level) out.stronger++; else out.weaker++;
		}
	}
	return out;
}

module.exports = { guardsByDistance };
