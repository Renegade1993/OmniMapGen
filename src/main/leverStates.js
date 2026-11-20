'use strict';
/**
 * The state of a lever when it reaches the generator (S358, K 2026-11-19: "the sliders always dominate and rule. The exception is "random" or
 * "Template" those defer, and allow the template to "lean"").
 *
 * A lever is in one of three states:
 *   set       a number inside its range (or a stop that is not Random or Template): the value is law, whatever the lean, the band or a template says;
 *   deferred  absent, the word "template", a number below the lever's range (the lobby sends one less than the range for Template), the stop labelled
 *             Template on a lever the lean draws (Starting levels), or "random" on a lever the lean draws: the choice goes to the map's lean
 *             (classicBands.js, classicFeel.js) on Classic, and to the template's own value on a named template;
 *   random    "random" on a lever the lean does not draw: rolled in its range from the map's seed (stockChoices.randomLever), then set.
 * defer() takes the --bio options of a run and returns { opt, handed, rolls }: opt without the deferred levers, the names handed over, and the levers
 * left to roll (the caller rolls them, so the roll stays where it was).
 */
const WORD = v => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/**
 * @param bio     { lever: value } as given on the command line (strings)
 * @param knobs   src/biome/knobs.js KNOBS
 * @param classic true when no named template is run (the open layout, or Random, which may land on it)
 * @param leaning the set of levers the lean draws (classicFeel.leaning())
 */
function defer(bio, knobs, classic, leaning) {
	const kept = {}, handed = [], rolls = [];
	for (const [key, v] of Object.entries(bio)) {
		const knob = knobs.find(q => q.key === key && !q.cli);
		if (!knob) { kept[key] = v; continue; }
		const w = WORD(v), num = parseFloat(v);
		const leans = classic && leaning.has(key);
		const below = Number.isFinite(num) && Number.isFinite(Number(knob.min)) && num < Number(knob.min);
		const templateStop = Number.isFinite(num) && (knob.stops || []).some(([sv, label]) => /template/i.test(label) && Number(sv) === num);
		if (w === 'template' || below || (templateStop && leans)) { handed.push(key); continue; }
		if (w === 'random') {
			if (leans) { handed.push(key); continue; }
			rolls.push(key);
		}
		kept[key] = v;
	}
	return { opt: kept, handed, rolls };
}

module.exports = { defer };
