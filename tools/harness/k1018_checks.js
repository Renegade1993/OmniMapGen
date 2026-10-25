'use strict';
/**
 * k1018_checks.js - gate checks for K's reports of 2026-10-18 (maps he made with OmniMapGen 0.3.13, a large open layout). Standalone, so either
 * harness tree can take it: Object.assign(CHECKS, require('./k1018_checks').CHECKS).
 *   portal-pairs  a monolith pair's two ends on one level stand at least PAIR_MIN tiles apart (K: "two portals that lead to one another and are
 *                 right next to eachother, but also partially share a road"). The engine's 994 same-level pairs on 136 maps (eng0 and the
 *                 Template Factory's sets): least 11 tiles, 5th percentile 24, median 56.
 */
const verdict = (pass, value, limit, items, nums) => ({ pass, value, limit, items: items || [], nums: nums || {} });
const LIMITS = { pairMin: 10 };

function portalPairs(M) {
	const by = new Map();
	for (const o of M.objs) if (o.type === 'monolithTwoWay') { const k = String(o.subtype); if (!by.has(k)) by.set(k, []); by.get(k).push(o); }
	const close = []; let pairs = 0;
	for (const [k, v] of by) {
		if (v.length !== 2 || (v[0].l || 0) !== (v[1].l || 0)) continue;
		pairs++;
		const d = Math.max(Math.abs(v[0].at[0] - v[1].at[0]), Math.abs(v[0].at[1] - v[1].at[1]));
		if (d < LIMITS.pairMin) close.push(`${k} L${v[0].l || 0} (${v[0].at}) and (${v[1].at}) ${d} apart`);
	}
	if (!pairs) return { skipped: 'no portal pair on one level' };
	return verdict(!close.length, `${close.length} of ${pairs} portal pairs closer than ${LIMITS.pairMin} tiles`, `none under ${LIMITS.pairMin} tiles`, close, { close: close.length, pairs });
}

// orphan-guards, road-under-blocker, portal-road-pair (k1018_more.js; K, 15:36: "connected almost by road, then the map generated terrain blockers over
// that, but there were still guards there like it was a choke point"). The engine's maps: 0 of each (101 maps with portal pairs, none whose ends a
// road joins at all).
const CHECKS = { 'portal-pairs': portalPairs, ...require('./k1018_more').CHECKS };
module.exports = { CHECKS, LIMITS };
