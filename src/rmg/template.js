/**
 * template.js - VCMI RMG zone-graph templates as generator input.
 *
 * A template file under the install's Mods/vcmi/Content/config/rmg holds a
 * named preset: a graph of zones (playerStart / cpuStart / treasure /
 * junction) plus the connections between them. Every field the engine reads
 * is defined by CRmgTemplate.cpp and the zone option serializer in the same
 * file:
 *
 *   template: { minSize, maxSize, players, humans?, zones, connections }
 *   zone:     { type, size, owner?, monsters, playerTowns?, neutralTowns?,
 *               mines?, treasure?, terrainTypes?, matchTerrainToTown?,
 *               allowedTowns?, bannedTowns?, forcedLevel?,
 *               *LikeZone }        // copy that field from another zone
 *   conn:     { a, b, guard?, type? ("wide"), road? ("true"/"false"/"random") }
 *
 * Size codes per serializeSize (CRmgTemplate.cpp:1082): s=36, m=72, l=108,
 * xl=144, h=180, xh=216, g=252 cells a side, "+u" = two levels. matchesSize
 * compares cells*levels against the range's x*y*z.
 *
 * Zone size is a RADIUS scale, not an area: CZonePlacer sums size^2 per level
 * and normalizes (CZonePlacer.cpp:565-585), so zone area comes out
 * proportional to size^2. The weighted Voronoi in biomes.js divides the
 * distance by the zone weight, which makes area roughly quadratic in the
 * weight, so weight = size reproduces that response.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { locateVcmiRoots, safeIsDir, crawlMods, resolveLoadOrder, loadActivationState } =
	require('../parser/modCrawler');
const { stripJsonComments, dropTrailingCommas, listZipEntries, readZipEntry } =
	require('../parser/assetIndex');

/** Map size codes to {cells, levels}; literal "WxHxL" forms parse too. */
const SIZE_CODES = {
	s: [36, 1], 's+u': [36, 2], m: [72, 1], 'm+u': [72, 2],
	l: [108, 1], 'l+u': [108, 2], xl: [144, 1], 'xl+u': [144, 2],
	h: [180, 1], 'h+u': [180, 2], xh: [216, 1], 'xh+u': [216, 2],
	g: [252, 1], 'g+u': [252, 2],
};

function parseSizeCode(code) {
	if (typeof code !== 'string') return null;
	const key = code.trim().toLowerCase();
	if (SIZE_CODES[key]) return SIZE_CODES[key];
	const m = key.match(/^(\d+)x(\d+)x(\d+)$/);
	if (m) return [+m[1], +m[3]];
	return null;
}

/** "2-4" -> [[2,4]], "2,4-6" -> [[2,2],[4,6]], "" -> [[0,0]] (unconstrained). */
function parseRange(str) {
	if (!str) return [[0, 0]];
	return String(str).split(',').map(part => {
		const [a, b] = part.split('-').map(Number);
		return [a, b === undefined || isNaN(b) ? a : b];
	});
}
const inRange = (ranges, n) => ranges.some(([a, b]) => n >= a && n <= b);
const rangeMax = ranges => Math.max(...ranges.map(r => r[1]));

/** Where template files live: the active install first, then bundled copies. */
function templateDirs() {
	const dirs = [];
	const roots = locateVcmiRoots();
	if (roots.installDir) {
		const rmg = path.join(roots.installDir, 'Mods', 'vcmi', 'Content', 'config', 'rmg');
		if (safeIsDir(rmg)) dirs.push(rmg);
	}
	if (process.env.VCMI_TEST_ROOT) {
		const rmg = path.join(process.env.VCMI_TEST_ROOT, 'Mods', 'vcmi', 'Content', 'config', 'rmg');
		if (safeIsDir(rmg)) dirs.push(rmg);
	}
	dirs.push(path.join(__dirname, 'templates'));
	return dirs;
}

/**
 * Every template source: each .json under the template dirs (one level of
 * subdirs: hdmod, symmetric, ...), then the templates each active mod lists
 * under "templates" in its mod.json, in load order. A source is
 * {label, read}, read() returning the file's text.
 *
 * The mod part is what the engine offers too: the MapGen tab lists every
 * template the engine knows, and HotA's templates submod ships 17 of them
 * ("[HotA] Kerberos" and the rest) inside its content.zip. Without it,
 * choosing one of those failed with "template not found" (2026-09-25).
 */
function* templateFiles() {
	for (const d of templateDirs()) {
		if (!safeIsDir(d)) continue;
		for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
			if (entry.isFile() && entry.name.endsWith('.json')) {
				const f = path.join(d, entry.name);
				yield { label: f, read: () => fs.readFileSync(f, 'utf8') };
			} else if (entry.isDirectory())
				for (const name of fs.readdirSync(path.join(d, entry.name)))
					if (name.endsWith('.json')) {
						const f = path.join(d, entry.name, name);
						yield { label: f, read: () => fs.readFileSync(f, 'utf8') };
					}
		}
	}
	yield* modTemplateFiles();
}

/** The templates active mods list in their mod.json, loose or in content.zip. */
function* modTemplateFiles() {
	const roots = locateVcmiRoots();
	if (!roots.installDir && !roots.userDir) return;
	const ordered = resolveLoadOrder(crawlMods(roots), loadActivationState(roots.userDir));
	for (const mod of ordered) {
		const list = Array.isArray(mod.templates) ? mod.templates : [];
		if (!list.length) continue;
		let zip = null, entries = null;
		for (const rel of list) {
			const want = String(rel).replace(/\\/g, '/');
			const loose = ['Content', 'content'].map(c => path.join(mod.__dir, c, ...want.split('/')))
				.find(f => fs.existsSync(f));
			if (loose) {
				yield { label: loose, read: () => fs.readFileSync(loose, 'utf8') };
				continue;
			}
			if (entries === null) {
				try {
					zip = fs.readFileSync(path.join(mod.__dir, 'content.zip'));
					entries = listZipEntries(zip);
				} catch { entries = []; }
			}
			const e = entries.find(x => x.name.toLowerCase() === want.toLowerCase());
			if (e) {
				const buf = zip;
				yield { label: `${mod.__id}:${want}`, read: () => readZipEntry(buf, e).toString('utf8') };
			}
		}
	}
}

let templateIndex = null;
function indexTemplates() {
	if (templateIndex) return templateIndex;
	templateIndex = new Map(); // lowercase name -> {name, source}
	for (const src of templateFiles()) {
		let j;
		try {
			j = JSON.parse(dropTrailingCommas(stripJsonComments(src.read())));
		} catch { continue; }
		for (const name of Object.keys(j)) {
			const key = name.toLowerCase();
			if (!templateIndex.has(key)) templateIndex.set(key, { name, source: src });
		}
	}
	return templateIndex;
}

function listTemplates() {
	return [...indexTemplates().values()].map(t => t.name).sort();
}

/**
 * Load a template by name (case-insensitive substring allowed) or by path.
 * Returns {name, raw} where raw is the template body.
 */
function loadTemplate(nameOrPath) {
	if (nameOrPath.endsWith('.json') && fs.existsSync(nameOrPath)) {
		const j = JSON.parse(dropTrailingCommas(stripJsonComments(fs.readFileSync(nameOrPath, 'utf8'))));
		const name = Object.keys(j)[0];
		return { name, raw: j[name] };
	}
	const idx = indexTemplates();
	const norm = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
	const needle = nameOrPath.toLowerCase();
	let hit = idx.get(needle)
		|| idx.get([...idx.keys()].find(k => norm(k) === norm(needle)));
	if (!hit)
		for (const [key, v] of idx)
			if (!hit && (key.includes(needle) || norm(key).includes(norm(needle))))
				hit = v;
	if (!hit) {
		const names = listTemplates().join(', ');
		throw new Error(`template "${nameOrPath}" not found; known templates: ${names}`);
	}
	const j = JSON.parse(dropTrailingCommas(stripJsonComments(hit.source.read())));
	return { name: hit.name, raw: j[hit.name] };
}

/**
 * Resolve *LikeZone references and return the zones as an ordered array.
 * Zone ids are strings in the file and ints in the engine (stoi at
 * CRmgTemplate.cpp:681); keep them as ints here.
 *
 * A zone may only reference a zone already read (engine resolves references
 * during serialization, so a forward reference reads an empty zone). Order is
 * numeric id order, matching the map the engine builds.
 */
function resolveZones(raw) {
	const byId = new Map();
	const ids = Object.keys(raw.zones || {}).map(s => parseInt(s, 10)).sort((a, b) => a - b);
	for (const id of ids) {
		const src = raw.zones[String(id)] || {};
		const z = { id };
		// copy concrete fields first, then apply *LikeZone pulls so an explicit
		// field always wins over the reference (same as the engine: the
		// serializer writes the real field when it exists)
		for (const [k, v] of Object.entries(src))
			if (!k.endsWith('LikeZone')) z[k] = v;
		for (const [k, v] of Object.entries(src)) {
			if (!k.endsWith('LikeZone')) continue;
			const ref = byId.get(v);
			if (!ref) continue;
			// the five zone-level refs the engine serializes
			// (CRmgTemplate.cpp:483-487). townsLikeZone copies every town
			// property of the other zone over the zone's own, as
			// inheritTownProperties does (CRmgTemplate.cpp:1064-1078): both town
			// counts, matchTerrainToTown, the hints and the allowed and banned
			// town lists.
			if (k === 'townsLikeZone') {
				for (const f of ['playerTowns', 'neutralTowns', 'matchTerrainToTown', 'townHints',
					'allowedTowns', 'bannedTowns'])
					if (ref[f] !== undefined) z[f] = ref[f];
					else delete z[f];
				continue;
			}
			const base = k.slice(0, -'LikeZone'.length);
			for (const cand of [base, base + 's']) {
				if (ref[cand] !== undefined && z[cand] === undefined) {
					z[cand] = ref[cand];
					break;
				}
			}
		}
		byId.set(id, z);
	}
	return [...byId.values()];
}

/** Zone-type -> content class mapping used by the biome layer. */
const ZONE_CLASS = {
	playerStart: 'player',
	cpuStart: 'player',     // a cpu opponent's start zone
	treasure: 'highLoot',
	junction: 'lowLoot',
	water: 'lowLoot',       // no water terrain support; degrade to open filler
};

/**
 * Check the request against the template's strict constraints.
 * req: {w, h, levels, players, humans}. accommodations: Set of keys that are
 * allowed to fail: 'size', 'players', 'humans', 'underground'.
 *
 * Returns {violations: [...], accommodated: [...]} - empty violations means
 * the template may run.
 */
function checkConstraints(raw, zones, req, accommodations) {
	const violations = [], accommodated = [];
	const acc = k => accommodations && accommodations.has(k);
	const note = (k, msg) => (acc(k) ? accommodated : violations).push(msg);

	const sq = req.w * req.h * req.levels;
	const mn = parseSizeCode(raw.minSize), mx = parseSizeCode(raw.maxSize);
	if (mn && mx) {
		const minSq = mn[0] * mn[0] * mn[1], maxSq = mx[0] * mx[0] * mx[1];
		if (sq < minSq || sq > maxSq)
			note('size', `map size ${req.w}x${req.h}x${req.levels} outside `
				+ `template range ${raw.minSize}..${raw.maxSize}`);
	}
	const pr = parseRange(raw.players);
	if (pr.length && !(pr.length === 1 && pr[0][0] === 0)) {
		if (!inRange(pr, req.players))
			note('players', `player count ${req.players} outside template `
				+ `range ${raw.players}`);
	}
	// Three more rules used to refuse here, and the engine has none of them
	// (checked in VCMI's source 2026-09-25), while the MapGen tab's picker
	// offers exactly what the engine's own list does (matchesSize and the
	// players range, MapGenTab::chooseTemplate). Headquarters (players 2-7,
	// seven start zones) at 4 players was offered and then refused with
	// "template wants 7 player zones", and the corpus has engine maps of it at
	// 4 and 6 players. The engine's answers, followed now:
	//  - a start zone past the player count gets a neutral town
	//    (TownPlacer::placeTowns, "no player - randomize town"); planLevel
	//    makes it a prize zone with a neutral town
	//  - the template's humans range is not checked by the engine
	//    (CMapGenOptions::getPossibleTemplates; RandomMapTab calls it "Unused
	//    now?"), so it is reported, not enforced
	//  - forcedLevel is ignored on a one-level map (CZonePlacer, "this step is
	//    ignored"); buildZonePlan puts those zones on the surface
	if (raw.humans !== undefined) {
		const hr = parseRange(raw.humans);
		if (!inRange(hr, req.humans === undefined ? req.players : req.humans))
			accommodated.push(`human count outside template range ${raw.humans} (the engine does not check it)`);
	}
	const ug = zones.filter(z => z.forcedLevel === 'underground').length;
	if (ug && req.levels < 2)
		accommodated.push(`${ug} zone(s) forced underground go on the surface of a one-level map`);
	const needPlayers = zones.filter(z => z.type === 'playerStart' || z.type === 'cpuStart')
		.reduce((m, z) => Math.max(m, z.owner || 0), 0);
	if (needPlayers > req.players)
		accommodated.push(`${needPlayers - req.players} of ${needPlayers} start zones have no player `
			+ 'and hold a neutral town');
	return { violations, accommodated };
}

/**
 * Each zone's level on a two-level map, the engine's way (CZonePlacer::
 * prepareZones), starts included. The zones in a random order: a forced
 * level holds; a start whose player picked a town native to the surface
 * stays up, and one native to the underground alone (Dungeon) goes down; a
 * start with a random town, and every other zone, then goes to the level
 * holding fewer zones so far, the surface on a tie. K (2026-09-27): starts
 * underground by default, as in the game, and the player's to override.
 *
 * req.starts[owner - 1]: 'surface', 'underground' or null (a random town, or
 * a start with no player); req.undergroundStarts: 0 keeps every start on the
 * surface, 1 is the game's rule (the default), 2 puts every start below.
 * Returns Map zone id -> level, or null for mode 0 (buildZonePlan's own split).
 */
function assignLevels(zones, req) {
	const mode = req.undergroundStarts === undefined || req.undergroundStarts === null
		? 1 : Math.round(Number(req.undergroundStarts));
	if (req.levels < 2 || mode === 0) return null;
	let s = ((req.seed || 1) * 2654435761 + 0x9e3779b9) >>> 0;
	const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
	rnd(); rnd();
	const order = [...zones];
	for (let i = order.length - 1; i > 0; i--) {
		const j = (rnd() * (i + 1)) | 0;
		[order[i], order[j]] = [order[j], order[i]];
	}
	const levelOf = new Map();
	const count = [0, 0];
	const put = (z, l) => { levelOf.set(z.id, l); count[l]++; };
	const isStart = z => z.type === 'playerStart' || z.type === 'cpuStart';
	const later = [];
	for (const z of order) {
		if (z.forcedLevel === 'underground') { put(z, 1); continue; }
		if (z.forcedLevel === 'surface') { put(z, 0); continue; }
		if (isStart(z) && mode === 2) { put(z, 1); continue; }
		const native = isStart(z) && z.owner ? (req.starts || [])[Number(z.owner) - 1] : null;
		if (native === 'underground') { put(z, 1); continue; }
		if (native === 'surface') { put(z, 0); continue; }
		later.push(z);
	}
	for (const z of later) put(z, count[1] < count[0] ? 1 : 0);
	return levelOf;
}

/**
 * Assign zones to levels. forcedLevel:"underground" zones go down. With two
 * levels the engine balances zone area across them (CZonePlacer.cpp:447), so
 * when a template defines no underground zones but the map has a second
 * level, the zones migrate to balance the counts, starts by the engine's
 * rule too (assignLevels).
 *
 * Returns {levels: [zoneSpec[]...], connections} with zone indices pointing
 * into each level's own array plus a global zoneById map.
 */
function buildZonePlan(raw, zones, req, accommodations) {
	const acc = accommodations || new Set();
	const perLevel = [[]];
	for (let l = 1; l < req.levels; l++) perLevel.push([]);
	const levelOf = assignLevels(zones, req);
	if (levelOf) {
		for (const z of zones) perLevel[levelOf.get(z.id)].push(z);
		return finishZonePlan(raw, zones, req, perLevel);
	}

	const forced = zones.filter(z => z.forcedLevel === 'underground');
	if (req.levels > 1) {
		for (const z of forced) perLevel[1].push(z);
	}
	const starts = zones.filter(z => z.type === 'playerStart' || z.type === 'cpuStart');
	const rest = zones.filter(z => !forced.includes(z) && !starts.includes(z));
	perLevel[0].push(...starts);
	if (req.levels > 1) {
		// The engine's level assignment (CZonePlacer::prepareZones): the zones in
		// a random order, each to the level holding fewer zones so far, the
		// surface on a tie. A start whose faction's native terrain is a surface
		// one is counted on the surface first; ours all are (the engine also
		// sends a start of a random faction through the draw, and 76 of the
		// 208 starts on the corpus's two-level maps are underground; not yet).
		// This replaced a split by zone mass, largest first, which put 24 of
		// [HotA] Nostalgia's 32 links between levels where a random draw puts
		// about half. Seeded by the map, so every plan of one map agrees.
		let s = ((req.seed || 1) * 2654435761 + 0x9e3779b9) >>> 0;
		const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
		rnd(); rnd();
		const order = [...rest];
		for (let i = order.length - 1; i > 0; i--) {
			const j = (rnd() * (i + 1)) | 0;
			[order[i], order[j]] = [order[j], order[i]];
		}
		for (const z of order) {
			const l = perLevel[1].length < perLevel[0].length ? 1 : 0;
			perLevel[l].push(z);
		}
	} else {
		for (const z of rest) perLevel[0].push(z);
		// one level: the engine ignores forcedLevel, so these go up too
		for (const z of forced) if (!starts.includes(z)) perLevel[0].push({ ...z, forcedLevel: undefined });
	}

	return finishZonePlan(raw, zones, req, perLevel);
}

function finishZonePlan(raw, zones, req, perLevel) {
	const indexOf = new Map();
	perLevel.forEach((list, l) =>
		list.forEach((z, i) => indexOf.set(z.id, { l, i })));

	// type, as the engine reads it (ZoneConnection::serializeJson): guarded (the
	// default) and wide are land links; fictive only pulls its zones together
	// while they are placed, and gets no passage; repulsive pushes them apart
	// and gets none; forcePortal is always a monolith pair and plays no part in
	// placing zones (CZonePlacer.cpp:87-89, ConnectionsPlacer.cpp:132 and 208)
	const connections = (raw.connections || []).map(c => ({
		a: parseInt(c.a, 10), b: parseInt(c.b, 10),
		guard: c.guard || 0,
		type: ['guarded', 'fictive', 'repulsive', 'wide', 'forcePortal'].includes(c.type) ? c.type : 'guarded',
		wide: c.type === 'wide',
		road: c.road === 'true' ? true : c.road === 'false' ? false : null,
	})).map(c => ({ ...c, roadOption: c.road, aRef: indexOf.get(c.a), bRef: indexOf.get(c.b) }));

	resolveRoadOptions(zones, connections, req.seed || 1);

	// the median zone's treasure mass is the unit loot multipliers compare to
	const masses = zones.map(zoneTreasureMass).sort((a, b) => a - b);
	const medianMass = masses.length ? masses[masses.length >> 1] : 0;

	return { zones, perLevel, connections, indexOf, medianMass };
}

/**
 * The links a template leaves to chance get their road the engine's way
 * (CRoadRandomizer.cpp), on the whole map at once: the links set to road join
 * their zones first; then the random ones, shuffled, take a road only where
 * they join two groups of zones not yet joined and at least one of them has a
 * town, a spanning tree over the towns; and a townless zone left with a single
 * road loses it, again and again, so no road runs into a zone to end there.
 * A coin per link used to decide, which left roads ending in townless zones
 * (K, 2026-09-27: "tails going nowhere"). A wide link never has a road
 * (CZonePlacer::RemoveRoadsForWideConnections, run before the draw). Every
 * other link takes part whatever its type, as in the engine, which does not
 * look at the type: a portal link with a road gets one to each monolith, and a
 * fictive or repulsive link can take a road that nothing then draws
 * (ConnectionsPlacer.cpp:208), joining its zones' groups all the same. A zone
 * has a town when its template counts one (playerTowns or neutralTowns): a
 * start zone that lists none does not, though its player's town stands there.
 * Sets each connection's road to true or false.
 */
function resolveRoadOptions(zones, connections, seed) {
	for (const c of connections) if (c.type === 'wide') c.road = false;
	const count = o => (o && typeof o === 'object' ? (Number(o.towns) || 0) + (Number(o.castles) || 0) : 0);
	const withTown = new Set(zones.filter(z => count(z.playerTowns) + count(z.neutralTowns) > 0).map(z => z.id));
	const random = connections.filter(c => c.road === null);
	if (!withTown.size) { for (const c of random) c.road = false; return; }
	const parent = new Map(zones.map(z => [z.id, z.id]));
	const town = new Map(zones.map(z => [z.id, withTown.has(z.id)]));
	const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
	const join = (a, b) => { const ra = find(a), rb = find(b); if (ra === rb) return false; parent.set(ra, rb); town.set(rb, town.get(ra) || town.get(rb)); return true; };
	for (const c of connections) if (c.road === true && parent.has(c.a) && parent.has(c.b)) join(c.a, c.b);
	let s = ((seed * 2246822519) ^ 0x51ed27f) >>> 0 || 1;
	const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
	rnd(); rnd();
	for (let i = random.length - 1; i > 0; i--) {
		const j = (rnd() * (i + 1)) | 0;
		[random[i], random[j]] = [random[j], random[i]];
	}
	for (const c of random) {
		const ra = parent.has(c.a) ? find(c.a) : null, rb = parent.has(c.b) ? find(c.b) : null;
		c.road = ra !== null && rb !== null && ra !== rb && (town.get(ra) || town.get(rb)) ? join(c.a, c.b) : false;
	}
	for (let changed = true; changed;) {
		changed = false;
		for (const z of zones) {
			if (withTown.has(z.id)) continue;
			const roads = connections.filter(c => c.road === true && (c.a === z.id || c.b === z.id));
			if (roads.length === 1) { roads[0].road = false; changed = true; }
		}
	}
}

/**
 * Guard strength -> monster level. RMG guard values are creature-stack
 * fighting values; our creeps are randomMonsterLevelN placeholders (1..7).
 * Bands calibrated so the common template values land sensibly: 3000 reads
 * as tier 3-4, 8000 as 4-5, 45000 as max tier. Approximation on purpose:
 * our maps cannot express a stack strength directly.
 */
function guardToLevel(guard) {
	if (!guard) return 0;
	if (guard < 2000) return 1;
	if (guard < 5000) return 2;
	if (guard < 10000) return 3;
	if (guard < 20000) return 4;
	if (guard < 30000) return 5;
	if (guard < 45000) return 6;
	return 7;
}

/**
 * Zone treasure bands -> a loot multiplier vs the STANDARD-class baseline.
 * mass = sum(density * midpoint); the template's own median zone mass is the
 * unit, clamped so a weak zone still holds something and a jackpot does not
 * fill the whole map.
 */
function zoneTreasureMass(z) {
	return (z.treasure || []).reduce((s, t) => s + t.density * (t.min + t.max) / 2, 0);
}
/**
 * Treasure piles the engine places per tile of a zone: per band it asks for
 * floor(tiles * density / 400) (TreasurePlacer::createTreasures) and keeps
 * each pile minDistance = sqrt(min(value, 30000) / 10 / density so far) from
 * the rest, richest band first, so about tiles / d^2 fit.
 */
function pileRate(bands) {
	let total = 0, rate = 0;
	for (const t of [...(bands || [])].sort((a, b) => b.max - a.max)) {
		total += t.density || 0;
		if (!total) continue;
		const d = Math.max(1, Math.sqrt(Math.min(t.min, 30000) / 10 / total));
		rate += Math.min((t.density || 0) / 400, 1 / (d * d));
	}
	return rate;
}
/**
 * A template zone's loot multiplier from how many piles the engine would put
 * in it rather than what they are worth (queue 39c, 2026-09-25): the worth
 * rides on the zone's class; the count of treasure objects follows the pile
 * count. By value, a rich zone got up to 4x the objects, and the fidelity
 * lens read template maps at 1.35-1.88x the engine's treasure objects
 * (Coldshadow's, richest by value in few zones, 0.56x). PILE_RATE_REF is the
 * pile rate that reads as 1.0, calibrated with that lens over 51 corpus-
 * matched maps: 0.028 read 0.64-0.86x of the engine's treasure objects,
 * 0.021 reads 0.83-1.10x.
 */
const PILE_RATE_REF = Number(process.env.VMAPGEN_PILE_RATE_REF) || 0.021;
function pileLoot(z) {
	return Math.max(0.3, Math.min(4, pileRate(z.treasure) / PILE_RATE_REF));
}
function lootScale(zoneMass, medianMass) {
	if (!medianMass) return 1;
	const r = zoneMass / medianMass;
	return Math.max(0.3, Math.min(4, r));
}

/** monsters field -> guard-density multiplier and tier nudge. */
const MONSTER_BAND = { none: 0, weak: 0.7, normal: 1.0, strong: 1.6 };

/** mines field: RMG resource names -> our mine subtypes. */
const MINE_SUBTYPE = {
	wood: 'sawmill', ore: 'orePit', gems: 'gemPond', crystal: 'crystalCavern',
	sulfur: 'sulfurDune', mercury: 'alchemistLab', gold: 'goldMine',
};

module.exports = {
	loadTemplate, listTemplates, resolveZones, checkConstraints, buildZonePlan, assignLevels,
	guardToLevel, zoneTreasureMass, lootScale, pileRate, pileLoot, ZONE_CLASS, MONSTER_BAND,
	MINE_SUBTYPE, parseSizeCode, parseRange,
};
