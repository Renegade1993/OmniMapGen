'use strict';
/**
 * The overhauled monster controls (S387 step 1, K: "i give you permission to overhaul the monster sliders and menu yes. just don't make duplicative sliders"), the generator side.
 * The proposal is VCMIMapGen\! LLM Files\2026-11-19_S387-monster-set-proposal.md: the three on/off switches and the two pulls become three sliders (treasure, dwelling, mine
 * guards, 0 is none), the bottleneck switch and share one slider, the gradient and the distance one slider. The five new keys are accepted by the generator now and
 * translated to the earlier keys before anything reads them (an earlier key still works as it did, and the newer key wins when both are given); they are not on the lobby
 * pages until K has seen the page (knobs.js lists the controls the lobby shows).
 *
 *   treasureGuards            0 to 4x   guardTreasure on or off (above 0), lootGuardWeight the number          Treasure guards + Treasure guard pull
 *   dwellingGuards            0 to 4x   guardDwellings on or off, dwellingGuardWeight the number (its own pull) Guards on dwellings (+ the dwelling half of the pull)
 *   mineGuards                0 to 4x   guardMines on or off, mineGuardWeight the number                        Guards on mines + Mine guard pull
 *   bottleneckGuards          0 to 1    guardBottlenecks on or off (above 0), chokeGuardRatio the number        Guards at bottlenecks + Bottleneck guard share
 *   guardStrengthByDistance   0 to 1    guardDistance and guardGradient both the number                         Guards by distance + Guard gradient
 */
const NEW_KEYS = {
	treasureGuards: { label: 'Treasure guards', min: 0, max: 4, step: 0.1, unit: 'x', default: 1 },
	dwellingGuards: { label: 'Dwelling guards', min: 0, max: 4, step: 0.1, unit: 'x', default: 1 },
	mineGuards: { label: 'Mine guards', min: 0, max: 4, step: 0.1, unit: 'x', default: 1 },
	bottleneckGuards: { label: 'Bottleneck guards', min: 0, max: 1, step: 0.05, default: 0.7 },
	guardStrengthByDistance: { label: 'Strength by distance', min: 0, max: 1, step: 0.05, default: 0 },
};

/** The earlier keys a newer key stands for, given its number: { earlierKey: value }. */
function earlierKeysOf(key, v) {
	switch (key) {
		case 'treasureGuards': return { guardTreasure: v > 0 ? 1 : 0, ...(v > 0 ? { lootGuardWeight: v } : {}) };
		case 'dwellingGuards': return { guardDwellings: v > 0 ? 1 : 0, ...(v > 0 ? { dwellingGuardWeight: v } : {}) };
		case 'mineGuards': return { guardMines: v > 0 ? 1 : 0, ...(v > 0 ? { mineGuardWeight: v } : {}) };
		case 'bottleneckGuards': return { guardBottlenecks: v > 0 ? 1 : 0, ...(v > 0 ? { chokeGuardRatio: v } : {}) };
		case 'guardStrengthByDistance': return { guardDistance: v, guardGradient: v };
		default: return {};
	}
}

/**
 * bio: { key: value } as given on the command line (after the Template and Random states are sorted out). Returns { bio, translated }: the same object with each newer key
 * replaced by the earlier keys it stands for (the newer key wins over an earlier key given beside it), and the names that were translated.
 */
function translate(bio) {
	const out = { ...bio }, translated = [];
	for (const key of Object.keys(NEW_KEYS)) {
		if (out[key] === undefined) continue;
		const v = parseFloat(out[key]);
		delete out[key];
		if (!Number.isFinite(v) || v < 0) continue;   // below the range is Template (leverStates.js): the earlier keys keep their own reading
		for (const [k, x] of Object.entries(earlierKeysOf(key, Math.max(0, v)))) out[k] = String(x);
		translated.push(key);
	}
	return { bio: out, translated };
}

module.exports = { NEW_KEYS, earlierKeysOf, translate };
