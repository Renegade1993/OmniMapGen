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

/**
 * The approved-templates list (K, 2026-10-02: "ONLY THOSE THAT HAVE BEEN APPROVED GO IN"). A module carries
 * `approved-templates.json` beside its mod.json (mod/approved-templates.json in the repository, copied by make_mod),
 * outside generator/ so editing it does not change the code pin. Every template not on it, mod-shipped ones included,
 * is not offered: listTemplates() leaves it out, loadTemplate() does not find it, "random" does not roll it. The
 * file reads {"approved": {"Template name": "date K approved it", ...}} (an array of {name, date} works too); an
 * empty list offers no template (free layouts are unaffected). A generator not inside a module (the repository's own
 * runs and tests) has no such file beside it and offers every template; VMAPGEN_APPROVED_TEMPLATES=<file> names one
 * explicitly, and =off turns the filter off.
 */
function approvedFile() {
	const env = process.env.VMAPGEN_APPROVED_TEMPLATES;
	if (env) return env === 'off' ? null : env;
	const root = path.resolve(__dirname, '..', '..', '..');
	const f = path.join(root, 'approved-templates.json');
	return fs.existsSync(f) && fs.existsSync(path.join(root, 'mod.json')) ? f : null;
}
let approvedSet; // undefined: not read yet; null: no filter
function approvedTemplates() {
	if (approvedSet !== undefined) return approvedSet;
	approvedSet = null;
	const f = approvedFile();
	if (!f) return approvedSet;
	let j = {};
	try { j = JSON.parse(dropTrailingCommas(stripJsonComments(fs.readFileSync(f, 'utf8')))); } catch (e) {
		console.error(`[template] ${f} unreadable (${e.message}): no template is offered`);
	}
	const a = j && j.approved;
	const names = Array.isArray(a) ? a.map(x => (x && x.name) || x) : Object.keys(a || {});
	approvedSet = new Set(names.map(n => String(n).toLowerCase()));
	return approvedSet;
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
		const ok = approvedTemplates();
		for (const name of Object.keys(j)) {
			const key = name.toLowerCase();
			if (ok && !ok.has(key)) continue;
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
		for (const z of forced) if (!starts.includes(z)) perLevel[0].push({ ...z, forcedLevel: undefined, wasUnderground: true });
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
	if (process.env.VMAPGEN_ROAD_TRACE) console.error('[roads] template links with a road: ' + connections.map(c => `${c.a}-${c.b}:${c.road ? 'R' : '-'}`).join(' '));

	// the median zone's treasure mass is the unit loot multipliers compare to
	const masses = zones.map(zoneTreasureMass).sort((a, b) => a - b);
	const medianMass = masses.length ? masses[masses.length >> 1] : 0;

	// the template's smallest map, tiles over every level (minSize, e.g. xl+u = 144 x 144 x 2): plan.js scales the rich
	// piles of a smaller map against it
	const mn = parseSizeCode(raw.minSize);
	const minTiles = mn ? mn[0] * mn[0] * mn[1] : 0;
	return { zones, perLevel, connections, indexOf, medianMass, minTiles };
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

/**
 * A template on a map far below its own sizes keeps fewer, larger zones. The engine refuses such a map; ours makes it,
 * and Coldshadow's 21 zones on a 36x36 one-level map came to about 60 tiles each, which the zone walls nearly filled:
 * starts without their sawmill or ore pit, most towns and mines without room (K, 2026-10-03: "small coldshadow's is
 * scuffed"). Where the map's tiles over the zones come to under VMAPGEN_ZONE_MIN_TILES (default 180):
 *  - a start with a player keeps its own zone, and its size is raised so it gets at least VMAPGEN_START_MIN_TILES
 *    (default 260: a start zone holds two towns, about 20 blocked tiles each, and at 200 the towns split a 36x36 two-level
 *    map's start zone and shut a mine in) of the map;
 *  - every other zone merges with a linked one, the pair with the smallest size together first, until the rest come
 *    to the minimum; the richer zone of a pair (its richest treasure band) keeps its spec, so a template's centre and
 *    its dragon zones outlast the plain ones, and the sizes add up;
 *  - links follow the zone that kept its spec; a link inside one zone goes, and of two links between the same zones the
 *    stronger guard stays.
 * VMAPGEN_ZONE_MERGE=0 off. Returns { raw, notes }: the raw template with resolved zones (no *LikeZone left), or the
 * same raw when nothing merges.
 */
function fitZonesToMap(raw, req) {
	const notes = [];
	if (process.env.VMAPGEN_ZONE_MERGE === '0' || !raw || !raw.zones) return { raw, notes };
	const tiles = req.w * req.h * Math.max(1, req.levels || 1);
	const MIN = Number(process.env.VMAPGEN_ZONE_MIN_TILES || 180);
	const START_MIN = Number(process.env.VMAPGEN_START_MIN_TILES || 260);
	const zones = resolveZones(raw).map(z => ({ ...z }));
	// Most biomes per level on a template (K, 2026-10-05: every lever acts on every template): a cap under the template's zones a level merges them the same way
	// (the smallest linked pair first, the richer keeps its spec), the cap counted over the levels; the default 300 never binds
	const capZones = Number.isFinite(req.zoneCap) && req.zoneCap >= 1 ? Math.floor(req.zoneCap) * Math.max(1, req.levels || 1) : Infinity;
	if (!zones.length || (tiles / zones.length >= MIN && zones.length <= capZones)) return { raw, notes };
	const players = req.players || 0;
	const active = z => /^(playerStart|cpuStart)$/.test(z.type) && Number(z.owner) >= 1 && Number(z.owner) <= players;
	const richest = z => Math.max(0, ...(z.treasure || []).map(t => Number(t.max) || 0));
	const starts = zones.filter(active);
	let rest = zones.filter(z => !active(z));
	const want = Math.max(1, Math.min(Math.floor(Math.max(0, tiles - starts.length * START_MIN) / MIN), capZones - starts.length));
	let links = (raw.connections || []).map(c => ({ ...c, a: parseInt(c.a, 10), b: parseInt(c.b, 10) }));
	const byId = new Map(zones.map(z => [z.id, z]));
	const absorbed = new Map();
	while (rest.length > want) {
		let best = null;
		for (const c of links) {
			if (c.a === c.b || c.type === 'repulsive') continue;
			const A = byId.get(c.a), B = byId.get(c.b);
			if (!A || !B || active(A) || active(B)) continue;
			const sum = (A.size || 0) + (B.size || 0);
			if (!best || sum < best.sum || (sum === best.sum && Math.min(c.a, c.b) < Math.min(best.A.id, best.B.id))) best = { A, B, sum };
		}
		if (!best) break;
		const { A, B } = best;
		const [keep, gone] = richest(B) > richest(A) || (richest(B) === richest(A) && (B.size || 0) > (A.size || 0)) ? [B, A] : [A, B];
		keep.size = (keep.size || 0) + (gone.size || 0);
		absorbed.set(gone.id, keep.id);
		byId.delete(gone.id);
		rest = rest.filter(z => z !== gone);
		for (const c of links) { if (c.a === gone.id) c.a = keep.id; if (c.b === gone.id) c.b = keep.id; }
		links = links.filter(c => c.a !== c.b);
	}
	if (!absorbed.size) return { raw, notes };
	const strongest = new Map();
	for (const c of links) {
		const k = Math.min(c.a, c.b) + '-' + Math.max(c.a, c.b) + '-' + (c.type === 'forcePortal' ? 'p' : '');
		const o = strongest.get(k);
		if (!o || (Number(c.guard) || 0) > (Number(o.guard) || 0)) strongest.set(k, c);
	}
	links = [...strongest.values()];
	// the starts' floor. The layout shares a level by size to the 0.8th power (plan.js chooseTemplateLayout, the engine's
	// rule), so with X = x^0.8: X / (n X + the others' size^0.8 summed) >= START_MIN / tiles. Solved linearly the floor
	// came out short and a two-player 36x36 start zone got 118 tiles (2026-10-03).
	const E = Number(process.env.VMAPGEN_ZONE_BALANCE_EXP || 0.8);
	const f = START_MIN / tiles, others = rest.reduce((m, z) => m + Math.max(1, z.size || 10) ** E, 0);
	if (starts.length && starts.length * f < 1) {
		const x = Math.ceil((f * others / (1 - starts.length * f)) ** (1 / E));
		for (const z of starts) if ((z.size || 0) < x) z.size = x;
	}
	// an idle start that survives a merge keeps one town (the one standing in for its missing player), not its extra
	// neutral one too: with both, a two-player 36x36 two-level Coldshadow read as a four-player map (K, 2026-10-04:
	// "almost made a 4 player map out of a small with two towns for each player"). VMAPGEN_IDLE_ONE_TOWN=0 keeps both.
	let trimmed = 0;
	if (process.env.VMAPGEN_IDLE_ONE_TOWN !== '0')
		for (const z of rest) if (/^(playerStart|cpuStart)$/.test(z.type) && z.neutralTowns) { delete z.neutralTowns; trimmed++; }
	const kept = [...starts, ...rest].sort((a, b) => a.id - b.id);
	const out = { ...raw, zones: {}, connections: links.map(c => ({ ...c, a: String(c.a), b: String(c.b) })) };
	for (const z of kept) {
		const { id, ...rest2 } = z;
		out.zones[String(id)] = rest2;
	}
	const into = new Map();
	for (const [g, k] of absorbed) { let r = k; while (absorbed.has(r)) r = absorbed.get(r); (into.get(r) || into.set(r, []).get(r)).push(g); }
	notes.push(`${zones.length} zones on ${tiles} tiles are ${Math.round(tiles / zones.length)} a zone; merged to ${kept.length} `
		+ `(${[...into].map(([k, g]) => `${k} took ${g.sort((a, b) => a - b).join('+')}`).join(', ')})`
		+ (starts.length ? `, starts sized to ${starts[0].size}` : '') + (trimmed ? `, ${trimmed} idle start(s) keep one town` : ''));
	return { raw: out, notes };
}

/**
 * A map for more players than the template has start zones gets a start zone of its own for each extra player (K,
 * 2026-10-01: "it should not make players share biomes ... extra start zones yes"). Before, the extra towns went to the
 * template-blind default corners, inside whichever zone was nearest: Jebus Cross at 8 players had three players in each of
 * two zones. Each missing owner slot clones a start zone of the template, taken in turn (same type, size, towns, mines,
 * treasure and monsters), with the same links to the same neighbours, so the graph stays connected and the clone sits among
 * the neighbours its source has. Returns { raw, notes }: the same raw when no start is missing.
 */
function addStartZones(raw, req) {
	const notes = [];
	if (!raw || !raw.zones) return { raw, notes };
	const isStart = z => /^(playerStart|cpuStart)$/.test(String((z || {}).type || '')) && Number(z.owner) >= 1;
	const starts = Object.keys(raw.zones).map(Number).sort((a, b) => a - b).filter(id => isStart(raw.zones[String(id)]));
	if (!starts.length) return { raw, notes };
	const owners = new Set(starts.map(id => Number(raw.zones[String(id)].owner)));
	const slots = Math.max(...owners);
	const want = Number(req.players) || 0;
	if (want <= slots || owners.size < slots) return { raw, notes };
	const out = { ...raw, zones: { ...raw.zones }, connections: [...(raw.connections || [])] };
	let next = Math.max(...Object.keys(raw.zones).map(Number)) + 1;
	const added = [];
	const bySlot = starts.slice().sort((a, b) => Number(raw.zones[String(a)].owner) - Number(raw.zones[String(b)].owner));
	for (let owner = slots + 1; owner <= want; owner++) {
		const srcId = bySlot[(owner - slots - 1) % bySlot.length], id = next++;
		out.zones[String(id)] = { ...JSON.parse(JSON.stringify(raw.zones[String(srcId)])), owner };
		for (const c of raw.connections || []) {
			const a = parseInt(c.a, 10), b = parseInt(c.b, 10);
			if (a === srcId && b !== srcId) out.connections.push({ ...c, a: String(id), b: String(b) });
			else if (b === srcId && a !== srcId) out.connections.push({ ...c, a: String(a), b: String(id) });
		}
		added.push(`${id} for player ${owner} like ${srcId}`);
	}
	notes.push(`${want - slots} start zone(s) added for the players the template has no start for (${added.join(', ')})`);
	return { raw: out, notes };
}

module.exports = {
	loadTemplate, listTemplates, resolveZones, checkConstraints, buildZonePlan, assignLevels, addStartZones,
	guardToLevel, zoneTreasureMass, lootScale, pileRate, pileLoot, ZONE_CLASS, MONSTER_BAND,
	MINE_SUBTYPE, parseSizeCode, parseRange, fitZonesToMap,
};
