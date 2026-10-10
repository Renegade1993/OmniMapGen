'use strict';
/**
 * profile.js - everything mapsight knows about one map, as plain data, cached on disk so a grid of hundreds of maps is
 * measured once. Cache: <project>/.tmp/mapsight/cache, keyed by the map's path, size and time and by the source of
 * sight.js, relations.js and profile.js (a change to any measure invalidates every entry).
 *
 * A profile holds: settings (size, levels, players, from the header and the zone sidecar), metrics (sight.analyse),
 * relational measures with counts and examples (relations.describe), the content census (object types per 1000 tiles,
 * dwellings by tier), and the improper road ends.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sight = require('./sight');
const { describe } = require('./relations');

const PROJECT = path.resolve(__dirname, '..', '..', '..', '..');
const CACHE = path.join(PROJECT, '.tmp', 'mapsight', 'cache');
let VERSION = null;
function version() {
	if (VERSION) return VERSION;
	const h = crypto.createHash('sha1');
	// only the files that compute measurements: a new report or command must not throw the cache away
	for (const f of ['sight.js', 'relations.js', 'profile.js']) h.update(fs.readFileSync(path.join(__dirname, f)));
	return (VERSION = h.digest('hex').slice(0, 12));
}

function build(file) {
	const A = sight.analyse(file), M = A.M;
	const d = describe(A);
	const tiles = M.W * M.H * M.NL;
	const per1000 = n => (1000 * n) / tiles;
	// content keys: what a player would count as different. Towns are one kind (ours writes start towns as randomTown and
	// lets the game pick the faction); monolith subtypes are only channel colours; seer huts differ by quest, not by kind;
	// dwellings are compared by creature tier (the building follows the zone's random faction); mines and banks keep
	// their subtype (the resource and the bank type matter).
	const tierOf = new Map(A.census.map(c => [c.o, c]));
	const keyOf = o => {
		if (o.cls === 'town') return 'town';
		if (o.cls === 'monster') return 'monster';
		if (o.cls === 'monolith' || o.type === 'seerHut') return o.type;
		if (o.cls === 'dwelling') { const c = tierOf.get(o); return c && c.dragon ? 'dwelling: neutral dragon' : `dwelling: tier ${c && c.tier ? Math.min(c.tier, 7) : '?'}`; }
		if (o.cls === 'low' || o.cls === 'high') return o.type;
		return `${o.type}${o.subtype && o.subtype !== 'object' ? ':' + o.subtype : ''}`;
	};
	const types = {};
	for (const o of M.objs) {
		if (o.cls === 'other' && !o.visitable) continue;                // scenery
		const k = keyOf(o);
		types[k] = (types[k] || 0) + 1;
	}
	const census = {};
	for (const [k, n] of Object.entries(types)) census[k] = per1000(n);
	const tiers = {};
	for (const c of A.census) tiers[c.tier || '?'] = (tiers[c.tier || '?'] || 0) + 1;
	const classes = {};
	for (const o of M.objs) if (o.cls !== 'other' || o.visitable) classes[o.cls] = (classes[o.cls] || 0) + 1;
	const z = M.zones;
	return {
		file, version: version(),
		settings: { w: M.W, h: M.H, levels: M.NL, players: A.starts.length, template: z && z.template || null },
		metrics: A.metrics,
		measures: d.measures, counts: d.counts, examples: d.examples, counter: d.counter,
		census, classes: Object.fromEntries(Object.entries(classes).map(([k, n]) => [k, per1000(n)])), tiers,
		roadBad: A.roadEnds.filter(e => e.kind !== 'proper').map(e => ({ kind: e.kind, l: e.l, at: e.at, arm: e.arm, to: e.to, gapTo: e.gapTo, touch: e.touch })),
	};
}

function profile(file) {
	const st = fs.statSync(file);
	const key = crypto.createHash('sha1').update(`${path.resolve(file)}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 20);
	const cf = path.join(CACHE, `${key}.json`);
	if (fs.existsSync(cf)) {
		try { const p = JSON.parse(fs.readFileSync(cf, 'utf8')); if (p.version === version()) return p; } catch (e) { /* rebuild */ }
	}
	const p = build(file);
	fs.mkdirSync(CACHE, { recursive: true });
	fs.writeFileSync(cf, JSON.stringify(p));
	return p;
}

module.exports = { profile, version, CACHE };
