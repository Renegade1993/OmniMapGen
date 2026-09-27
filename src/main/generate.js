/**
 * generate.js - end-to-end pipeline: crawl mods -> index assets -> build the
 * tile dictionary -> solve 32x32 chunks in worker_threads -> POMS stitch ->
 * serialize .vmap.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');

const { locateVcmiRoots, crawlMods, resolveLoadOrder, loadActivationState } = require('../parser/modCrawler');
const { buildAssetIndex } = require('../parser/assetIndex');
const { buildCompat, xorshift } = require('../wfc/solver');
const { BitSet } = require('../wfc/bitset');
const { computeTaccl } = require('../stitch/taccl');
const { mergeChunks, mergeChunksAsync } = require('../stitch/poms');
const { planMap, chooseTemplateLayout } = require('../biome/plan');
const { registerTerrainDecor, clearTerrainDecor, TERRAINS: DECOR_TERRAINS } = require('../biome/decor');
const { registerModSet, clearModSets, coreSetTemplates } = require('../biome/retile');
const { blockingCells } = require('../biome/content');
const { themePool, applyGuardTheme, concretizeGuards, creatureRegistry, guardPool, themeDwellingPool,
	themeBankPool } = require('../biome/guardCreatures');
const { DWELLING_POOL, CORE_BANKS, bankRate, chestTemplate, registerTerrainBarriers, clearTerrainBarriers } = require('../biome/economy');
const TEMPLATE_THEMES = require('../biome/templateThemes.json');
const { h3MonsterTemplates } = require('../parser/h3data');
const { townFactions, zoneTownTypes, pickStartFaction } = require('../biome/zoneTowns');
const { OBJECT_TEMPLATES } = require('../stitch/zones');
const { serializeVmap, makeHeader, FLIP_CODES } = require('../exporter/vmapWriter');
const { solveRoadTiles, solveRiverTiles } = require('../exporter/roads');
const { buildPatterns, assignTerrainViews, smoothForPatterns } = require('../exporter/terrainView');
const { buildRiverNetwork } = require('../biome/rivernet');
const { buildWaterPlan, WATER_SHAPES } = require('../biome/water');
const { makeMaskChecker } = require('../exporter/maskcheck');
const { loadTemplate, resolveZones, checkConstraints, buildZonePlan, parseSizeCode }
	= require('../rmg/template');
const { orderStarts } = require('../rmg/startOrder');

const CHUNK = 32;

/**
 * Sprite indices that draw a terrain as PLAIN GROUND rather than a border.
 *
 * `terView` in a tile code is the frame index handed straight to the renderer
 * (`MapRenderer.cpp:162, imageIndex = mapTile.terView`); nothing recomputes it
 * at load. Which indices mean what comes from the "no transition" entry, id
 * n1, in config/terrainViewPatterns.json, whose 3x3 rule is all-native:
 *
 *     normal 49-56 plain, 57-72 decorated     dirt 21-28, 29-44
 *     sand   0-11  plain, 12-23  decorated    water 20-32   rock 0-7
 *
 * The generator emitted views 0 to 7 for every terrain. For a "normal" terrain,
 * which is grass, snow, swamp, rough, lava and subterranean, 0-3 and 4-7 are
 * sand and dirt border pieces, so **every tile of every map we have generated
 * was drawn as a transition sprite**. That is the real cause of the seam the
 * mirror tool was blamed for, and it is on every tile, not only the midline.
 *
 * Proper edge art needs the whole pattern table matched against each tile's
 * neighbourhood, which is a separate job. Plain ground everywhere is correct
 * for the interior of a biome, which is nearly all of a map, and is a great
 * deal closer than a border piece everywhere.
 *
 * 15% decorated matches `RmgMap::getDecorationsPercentage`.
 */
const TERRAIN_VIEW_RANGES = {
	normal: { plain: [49, 56], decorated: [57, 72] },
	dirt:   { plain: [21, 28], decorated: [29, 44] },
	sand:   { plain: [0, 11],  decorated: [12, 23] },
	water:  { plain: [20, 32] },
	rock:   { plain: [0, 7] },
};
const DECORATION_PERCENT = 15;

/**
 * Tile dictionary: one entry per (terrain, view) pair the generator can emit.
 *
 * Impassable and water terrain is excluded outright. Rock carries a negative
 * move cost and is the solid filler around underground passages, and water has
 * no allowed layers; a biome of either is a hole in the map. assignTerrains
 * already refuses both, but it is not the only way a tile reaches the grid: the
 * solver falls back to an unconstrained solve when biome domains deadlock, and
 * an unconstrained solve draws from the whole dictionary. Keeping them out here
 * closes that path too. `includeImpassable` exists for a caller that genuinely
 * wants to author rock, and nothing sets it today.
 */
function buildDictionary(assetIndex, viewsPerTerrain = 8, opts = {}) {
	const { includeImpassable = false, coreOnly = true } = opts;
	const tiles = []; // {shortId, terrain, moveCost, view, layers}
	for (const [shortId, t] of assetIndex.terrains) {
		if (shortId.length !== 2) continue; // vcmi codes are 2 chars
		const layers = t.allowedLayers || [];
		if (!includeImpassable && (!(t.moveCost > 0) || !layers.length)) continue;
		// A map that declares no mod requirements has to be readable by someone
		// who has none. getTerrainByCode falls back to TerrainId::NONE for a
		// code it does not know, so a modded terrain on an undeclared map is a
		// tile with no terrain at all on anybody else's install. Two-level maps
		// were picking a modded underground terrain (stardust) for whole biomes
		// while the header said mods: null.
		if (coreOnly && !String(t.name || '').startsWith('core:')) continue;

		const range = TERRAIN_VIEW_RANGES[t.viewGroup] || TERRAIN_VIEW_RANGES.normal;
		const plain = [];
		for (let v = range.plain[0]; v <= range.plain[1]; v++) plain.push(v);
		const decorated = [];
		if (range.decorated)
			for (let v = range.decorated[0]; v <= range.decorated[1]; v++) decorated.push(v);
		// Keep the dictionary bounded: the solver builds an N squared
		// compatibility matrix, so every extra view costs real time.
		const wanted = Math.max(1, viewsPerTerrain);
		const nDecor = decorated.length
			? Math.max(1, Math.round(wanted * DECORATION_PERCENT / 100)) : 0;
		const views = [];
		for (let i = 0; i < wanted - nDecor; i++)
			views.push(plain[i % plain.length]);
		for (let i = 0; i < nDecor; i++)
			views.push(decorated[Math.floor(i * decorated.length / nDecor)]);

		for (const view of views)
			tiles.push({ shortId, terrain: t.name, moveCost: t.moveCost, view, layers });
	}
	return tiles;
}

/**
 * The engine's terrain view pattern table, preferring the live install's copy
 * so a VCMI update or a mod that extends it is picked up, with the bundled
 * harvest as the fallback for a machine with no install.
 */
let cachedViewPatterns = null;
function loadTerrainViewPatterns(installDir) {
	if (cachedViewPatterns) return cachedViewPatterns;
	const stripComments = t => t.replace(/^\s*\/\/.*$/gm, '');
	const tryRead = file => {
		try { return JSON.parse(stripComments(fs.readFileSync(file, 'utf8'))); }
		catch { return null; }
	};
	const live = installDir
		? tryRead(path.join(installDir, 'config', 'terrainViewPatterns.json')) : null;
	const config = live
		|| tryRead(path.join(__dirname, '..', 'exporter', 'terrainViewPatterns.json'));
	if (!config) throw new Error('no terrainViewPatterns.json found');
	cachedViewPatterns = buildPatterns(config);
	return cachedViewPatterns;
}

/**
 * Adjacency: any land tile may neighbour any other. VCMI renders the
 * transition art itself, and a biome's own domain already keeps its terrain
 * inside its own cells, so there is nothing left for an adjacency rule to do.
 *
 * There used to be a "hazard" family here: lava and cursed ground could only
 * touch their own kind. It made the constraint set unsatisfiable the moment a
 * lava biome shared a border with anything, which is always. The solver then
 * exhausted its restarts and fell back to solving with no biome domains at all,
 * so the whole terrain plan was thrown away and the level came out as whatever
 * an unconstrained solve happened to settle on. That is how a two-level map
 * ended up with 1278 of 1296 underground tiles drawn as surface dirt.
 */
function buildAdjacency(tiles, assetIndex) {
	const pairs = [];
	for (let a = 0; a < tiles.length; a++)
		for (let b = 0; b < tiles.length; b++)
			for (let d = 0; d < 4; d++) pairs.push([a, d, b]);
	return pairs;
}

function serializeCompat(numTiles, compat) {
	return [0, 1, 2, 3].map(d => compat.map(c => Array.from(c[d].words)));
}

/**
 * Solve all chunks with a worker pool, then stitch.
 * opts.cellDomainFn(cellIdx) -> BitSet|null restricts a cell to a biome's
 * terrain tiles; null = unconstrained.
 */
async function solveChunked(tiles, compat, mapW, mapH, opts) {
	const numTiles = tiles.length;
	const compatBits = serializeCompat(numTiles, compat);
	const weights = tiles.map(t => 1.0 / (t.moveCost || 100)); // cheap tiles denser

	// largest object footprint drives K in W = 2L + K
	let maxFootprint = 1;
	for (const [, obj] of assetIndexObjects(opts.assetIndex)) {
		for (const t of obj.templates) maxFootprint = Math.max(maxFootprint, t.width);
	}
	const { L, stitchWidth } = computeTaccl(numTiles, compat, maxFootprint);

	// When the stitch band would cover the whole map, chunking is pure
	// overhead: the band re-solve costs a full solve anyway. Solve directly.
	if (stitchWidth >= Math.min(mapW, mapH) ||
		(Math.ceil(mapW / CHUNK) === 1 && Math.ceil(mapH / CHUNK) === 1)) {
		const domains = [];
		if (opts.cellDomainFn) {
			for (let i = 0; i < mapW * mapH; i++) {
				const mask = opts.cellDomainFn(i);
				if (mask) domains.push([i, Array.from(mask.words)]);
			}
		}
		const r = await runWholeMap(numTiles, weights, compatBits,
			mapW, mapH, domains.length ? domains : null, opts.seed,
			opts.levelDomainBits);
		if (r.fellBack)
			console.error('[gen] biome terrain domains could not be satisfied; '
				+ 'the level was solved from the layer-legal terrain set instead, '
				+ 'so its terrain does not follow the biome plan');
		return { grid: r.tiles, L, stitchWidth };
	}

	const chunksX = Math.ceil(mapW / CHUNK);
	const chunksY = Math.ceil(mapH / CHUNK);
	const jobs = [];
	for (let cy = 0; cy < chunksY; cy++)
		for (let cx = 0; cx < chunksX; cx++)
			jobs.push({ chunkId: cy * chunksX + cx, ox: cx * CHUNK, oy: cy * CHUNK,
				w: Math.min(CHUNK, mapW - cx * CHUNK), h: Math.min(CHUNK, mapH - cy * CHUNK) });

	// Per-chunk domain restrictions from the biome plan
	const chunkDomains = jobs.map(job => {
		if (!opts.cellDomainFn) return null;
		const list = [];
		for (let y = 0; y < job.h; y++)
			for (let x = 0; x < job.w; x++) {
				const g = (job.oy + y) * mapW + (job.ox + x);
				const mask = opts.cellDomainFn(g);
				if (mask) list.push([y * job.w + x, Array.from(mask.words)]);
			}
		return list.length ? list : null;
	});

	const poolSize = Math.max(1, (opts.threads || require('os').cpus().length - 1));
	const results = new Array(jobs.length);
	const workerPath = path.join(__dirname, '..', 'wfc', 'worker.js');

	// Pool kept alive across both phases: chunks first, then POMS band
	// repair rounds (non-overlapping bands run concurrently per round).
	const workers = [];
	const pending = new Map(); // msg.chunkId -> {resolve, reject}
	const queue = [];          // [{msg, resolve, reject}] waiting for a worker
	const dispatch = () => {
		while (queue.length) {
			const w = workers.find(x => x.idle);
			if (!w) break;
			const { msg, resolve, reject } = queue.shift();
			w.idle = false;
			pending.set(msg.chunkId, { resolve, reject });
			w.postMessage(msg);
		}
	};
	for (let i = 0; i < poolSize; i++) {
		const w = new Worker(workerPath);
		w.idle = true;
		w.on('message', m => {
			const p = pending.get(m.chunkId);
			pending.delete(m.chunkId);
			w.idle = true;
			if (p) p.resolve(m);
			dispatch();
		});
		w.on('error', err => {
			for (const [, p] of pending) p.reject(err);
			pending.clear();
			for (const q of queue.splice(0)) q.reject(err);
		});
		workers.push(w);
	}
	const runJob = msg => {
		const p = new Promise((resolve, reject) => queue.push({ msg, resolve, reject }));
		dispatch();
		return p;
	};
	const terminate = () => Promise.all(workers.map(w => w.terminate()));

	try {
		let next = 0;
		const inFlight = new Set();
		await new Promise((resolve, reject) => {
			const pump = () => {
				while (next < jobs.length) {
					const job = jobs[next++];
					const p = runJob({ ...job, numTiles, weights, compatBits, forced: [],
						domainBits: chunkDomains[job.chunkId],
						levelDomainBits: opts.levelDomainBits,
						seed: opts.seed + job.chunkId * 7919 });
					inFlight.add(p);
					p.then(m => {
						inFlight.delete(p);
						if (m.error) { reject(new Error(`chunk ${m.chunkId}: ${m.error}`)); return; }
						if (m.fellBack)
							console.error(`[gen] chunk ${m.chunkId}: biome terrain domains `
								+ 'could not be satisfied, solved from the layer-legal set instead');
						results[m.chunkId] = { ox: job.ox, oy: job.oy, w: job.w, h: job.h, tiles: Int32Array.from(m.tiles) };
						pump();
					}, reject);
				}
				if (next >= jobs.length && inFlight.size === 0) resolve();
			};
			pump();
		});

		// Phase 2: band repair through the same pool. solveBand sends a rect
		// solve with forced cells; null result keeps the original band.
		//
		// The band carries the SAME biome domains the chunks did. It used to
		// send domainBits: null, and since erosion deliberately leaves a
		// fraction of band cells unforced (pErode, 0.25 by default), every
		// chunk seam re-solved those cells from the whole dictionary. The
		// result was a scatter of unrelated terrain along every seam: about a
		// hundred cells of a 36x36 map drawn as whatever the solver picked,
		// including terrain belonging to the other layer.
		let bandId = 1 << 20;
		const bandDomains = r => {
			if (!opts.cellDomainFn) return null;
			const list = [];
			for (let y = 0; y < r.h; y++)
				for (let x = 0; x < r.w; x++) {
					const mask = opts.cellDomainFn((r.y + y) * mapW + (r.x + x));
					if (mask) list.push([y * r.w + x, Array.from(mask.words)]);
				}
			return list.length ? list : null;
		};
		const solveBand = (r, forced, bandSeed) => runJob({
			chunkId: bandId++, ox: r.x, oy: r.y, w: r.w, h: r.h,
			numTiles, weights, compatBits,
			forced: [...forced], domainBits: bandDomains(r),
			levelDomainBits: opts.levelDomainBits, seed: bandSeed,
		}).then(m => m.error ? null : Int32Array.from(m.tiles));

		const grid = await mergeChunksAsync(results, mapW, mapH, numTiles, weights,
			compat, stitchWidth, opts.pErode ?? 0.25, opts.seed, solveBand);
		return { grid, L, stitchWidth };
	} finally {
		await terminate();
	}
}

/** Single-worker solve for maps small enough that POMS adds nothing. */
function runWholeMap(numTiles, weights, compatBits, mapW, mapH, domainBits, seed,
	levelDomainBits) {
	return new Promise((resolve, reject) => {
		const w = new Worker(path.join(__dirname, '..', 'wfc', 'worker.js'));
		w.on('message', m => {
			w.terminate();
			if (m.error) reject(new Error(`whole-map solve: ${m.error}`));
			else resolve({ tiles: Int32Array.from(m.tiles), fellBack: !!m.fellBack });
		});
		w.on('error', reject);
		w.postMessage({ ox: 0, oy: 0, w: mapW, h: mapH, numTiles, weights,
			compatBits, forced: [], domainBits, levelDomainBits, seed });
	});
}

function* assetIndexObjects(assetIndex) {
	if (!assetIndex) return;
	for (const e of assetIndex.objects) yield e;
}

/**
 * Disk cache for buildAssetIndex: it walks ~2000 config files across every
 * active mod, which dominates generation runtime (~40s). The index depends
 * only on the core config dir + the resolved mod list, so we key on that.
 * The key now also folds in a cheap content signature (file count, total
 * size, newest mtime) for each mod dir / content.zip, so editing a mod
 * invalidates the cache without needing --nocache. A dir listing is
 * ~2000 statSync calls (~50ms) vs ~40s for a rebuild.
 */
function dirSignature(dir) {
	// content.zip mods: the zip's own mtime+size is the signature
	let count = 0, size = 0, newest = 0;
	const walk = d => {
		let ents;
		try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
		for (const e of ents) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) { walk(p); continue; }
			try {
				const s = fs.statSync(p);
				count++; size += s.size;
				if (s.mtimeMs > newest) newest = s.mtimeMs;
			} catch { /* transient file */ }
		}
	};
	if (dir && fs.existsSync(dir)) {
		try {
			const s = fs.statSync(dir);
			if (s.isFile()) { // content.zip mod: the archive itself
				count = 1; size = s.size; newest = s.mtimeMs;
			} else walk(dir);
		} catch { walk(dir); }
	}
	return `${count}:${size}:${Math.round(newest)}`;
}

function cachedAssetIndex(coreConfigDir, orderedMods, noCache) {
	const crypto = require('crypto');
	// bump INDEX_SCHEMA when the index shape changes so stale entries miss
	const h = crypto.createHash('sha1')
		// v2: object templates carry raw {animation,mask,visitableFrom}
		// v3: factions restricted to real town factions, scope no longer
		//     double-applied to an already-scoped key
		// v4: terrains record their terrainViewPatterns group
		// v5: terrains record their river, and the river types are indexed
		// v6: the config parser handles trailing commas, so the index is built
		//     from all 200 core files rather than the 91 that happened to parse
		// v7: schemas are skipped, so no faction called core:dependencies
		// v8: the zip reader takes the compressed size from the right offset,
		//     so the 20 mods shipping a content.zip are readable at last
		// v9: factions record their nativeTerrain for the start-biome
		//     terrain override
		// v10: a mod's types-only extension of an object type is indexed
		//     (it inherits the handler), and every type is recorded unscoped
		// v11: subtypes and templates inherit their type's "base" the way the
		//     engine does, so a mod dwelling gets core's visitableFrom
		// v12: mod manifests with comments are read (6 more active mods)
		// v13: a mod's configs are only the files its manifest lists
		// v14: creatures indexed by content category (core creatures too)
		// v15: creatures carry faction, index, map template and stack range,
		//     and overrides merge into the creature they name
		// v16: creatures record the mod their map sprite comes from and
		//     whether the engine leaves them out of random rolls
		// v17: spells are indexed (a town's mage guild list), and factions
		//     record their town sprites and underground preference
		// v18: dwellings record every creature they offer
		// v19: banks record the creatures that guard them and that they pay out
		// v20: ... read from "rewards" too, the shape every current bank uses
		// v21: spells, artifacts, skills and heroes record onlyOnWaterMap
		// v22: objects record their rmg value, rarity and limits and their
		//     templates' allowed terrains; later mods' patches merge into the
		//     object they name; submods nested at any depth are read
		// v23: a faction is its records merged in load order (native terrains
		//     split across files or patched by another mod)
		// v24: the obstacle sets (core's biomes.json and the mods'), and every
		//     template records the mod that brought it
		.update('v24')
		.update(String(coreConfigDir))
		.update(dirSignature(coreConfigDir));
	for (const m of orderedMods || []) {
		h.update(`${m.__id}@${m.__dir}`);
		h.update(dirSignature(m.__dir));
	}
	const key = h.digest('hex').slice(0, 16);
	// Where the cache may live, first match wins: VMAPGEN_CACHE_DIR; the VCMI
	// user folder the client passes; the generator's own cache folder. The
	// user folder is where VCMI keeps its own caches. The generator's folder
	// serves runs that name no user folder (the tests), except when the
	// generator is a mod's (a mod.json beside its folder): the client runs a
	// mod's program only while its files hash to the value the mod catalog
	// pins, so the mod's folder is never written, and a run naming no user
	// folder there builds its index without keeping it.
	const generatorRoot = path.join(__dirname, '..', '..');
	const inMod = fs.existsSync(path.join(generatorRoot, '..', 'mod.json'));
	const cacheDirs = [process.env.VMAPGEN_CACHE_DIR,
		process.env.VCMI_USER_DIR && path.join(process.env.VCMI_USER_DIR, 'cache', 'mapgen'),
		!inMod && path.join(generatorRoot, 'cache')].filter(Boolean);
	const cacheName = `assetIndex-${key}.json`;
	const cacheFile = cacheDirs.map(d => path.join(d, cacheName)).find(f => fs.existsSync(f));
	if (!noCache && cacheFile) {
		try {
			const j = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
			// Every map the index carries has to be rebuilt here. A field
			// added to buildAssetIndex but not to this list works on the run
			// that populates the cache and throws on every run after, which is
			// exactly how the river index arrived: seed 42 generated fine and
			// all nineteen maps of the next sweep died.
			return {
				terrains: new Map(j.terrains),
				rivers: new Map(j.rivers || []),
				objects: new Map(j.objects),
				creatures: new Map(j.creatures),
				artifacts: new Map(j.artifacts),
				factions: new Map(j.factions),
				spells: new Map(j.spells || []),
				skills: new Map(j.skills || []),
				heroes: new Map(j.heroes || []),
				obstacleSets: j.obstacleSets || [],
			};
		} catch { /* fall through to rebuild */ }
	}
	const index = buildAssetIndex(coreConfigDir, orderedMods);
	const body = JSON.stringify({
		terrains: [...index.terrains],
		rivers: [...index.rivers],
		objects: [...index.objects],
		creatures: [...index.creatures],
		artifacts: [...index.artifacts],
		factions: [...index.factions],
		spells: [...index.spells],
		skills: [...index.skills],
		heroes: [...index.heroes],
		obstacleSets: index.obstacleSets,
	});
	// best-effort: the first folder that takes the write keeps it
	for (const dir of cacheDirs) {
		try {
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, cacheName), body);
			break;
		} catch { /* not writable here; try the next */ }
	}
	return index;
}

/**
 * Observer mode: one player slot sequestered on the underground level.
 *
 * The contest is on the surface between the AI slots. The observer's town and
 * hero sit in a chamber of open floor on level 1 with solid rock in every
 * direction and NO subterranean gate, monolith or whirlpool anywhere on either
 * level, so there is no route between the two levels at all.
 *
 * Why that seals it, read off the engine rather than assumed:
 *   - Rock is impassable ground, and the level loop below writes it over every
 *     cell the openMask leaves closed.
 *   - Changing level needs a teleport object. The pathfinder's layer
 *     transitions (CPathfinder.cpp:335-370) are LAND/SAIL/AIR/WATER within one
 *     level; nothing else crosses z. Flying does cross rock - AIR returns
 *     FLYABLE for any revealed tile (PathfinderUtil.h:86) - but only inside the
 *     level the hero is already on.
 *   - Fog starts fully hidden and is opened only around each team's own objects
 *     (CGameState::initFogOfWar). The AI teams own nothing on level 1 and can
 *     never get there, so the chamber stays dark for them for the whole game.
 *
 * The one mechanism that could cross is Dimension Door: its range check bounds
 * x and y and never looks at z (AdventureSpellEffect.cpp:37), so a same-x,y
 * cast from the surface would land in the chamber. Neither contestant casts it
 * - Nullkiller and Nullkiller2 use TOWN_PORTAL only, and OmniAI casts no
 * adventure spell at all - so the spell is left enabled rather than banning it
 * and changing the rules the contest is measured under.
 *
 * Returns a plan of the shape the level loop reads: zone, biomeTerrain,
 * classes, openMask, roadCells, objects.
 */
function planObserverLevel({ W, H, color, terrainShortId, chamber }) {
	const { x0, y0, x1, y1 } = chamber;
	const openMask = new Uint8Array(W * H);
	for (let y = y0; y <= y1; y++)
		for (let x = x0; x <= x1; x++) openMask[y * W + x] = 1;

	const tpl = OBJECT_TEMPLATES.randomTown;
	const anchor = observerTownAnchor(chamber);
	const town = {
		instanceName: `randomTown_${anchor.x}_${anchor.y}_1`,
		l: 1, x: anchor.x, y: anchor.y,
		type: 'randomTown', subtype: 'object',
		template: { animation: tpl.animation, editorAnimation: '', mask: tpl.mask,
			visitableFrom: tpl.visitableFrom },
		options: { owner: color },
	};

	return {
		zone: new Int32Array(W * H),          // one biome, the whole level
		biomeTerrain: [terrainShortId],
		classes: [0],
		openMask,
		roadCells: new Set(),
		objects: [town],
		levelIndex: 1,
	};
}

/**
 * Where the observer's town sits inside its chamber.
 *
 * The anchor is the BOTTOM-RIGHT of the mask (content.js:288 subtracts from x
 * and y), and the real 6x6 town the engine swaps in at game start reaches five
 * cells further up and left than our three-row placeholder does. So the anchor
 * is kept at least five cells inside the chamber's top and left edges, and one
 * inside its bottom and right, leaving the gate row walkable.
 */
function observerTownAnchor({ x0, y0, x1, y1 }) {
	const cx = ((x0 + x1) / 2) | 0, cy = ((y0 + y1) / 2) | 0;
	return {
		x: Math.min(Math.max(cx, x0 + 5), x1 - 1),
		y: Math.min(Math.max(cy, y0 + 5), y1 - 1),
	};
}

/**
 * The chamber rectangle, in the corner furthest from where the CLI pins the
 * contestants' towns (quadrant corners, [4,4] first). Bottom-left is free on
 * every player count up to four, and keeping the observer away from the
 * contestants' x,y keeps the Dimension Door hole above out of reach even for a
 * caster that wandered into it.
 */
function observerChamber(W, H) {
	const cw = Math.max(14, Math.min(22, Math.floor(W / 3)));
	const ch = Math.max(14, Math.min(22, Math.floor(H / 3)));
	const x0 = 2, y0 = H - 2 - ch;
	return { x0, y0, x1: x0 + cw - 1, y1: y0 + ch - 1 };
}

/**
 * Full pipeline. params: {mapW, mapH, players:[{color,factions,townPos}],
 * outFile, seed, threads, pErode, density, difficulty, underground:bool,
 * factionAgnostic:bool}
 */
async function generateMap(params) {
	const t0 = Date.now();
	const stage = name => console.error(`[gen] ${name}: ${Date.now() - t0}ms`);

	const roots = locateVcmiRoots();
	if (!roots.installDir)
		throw new Error('no VCMI install named: pass --vcmiroot <folder> or set VCMI_ROOT '
			+ '(the generator never guesses one)');
	// a template that brings a theme (templateThemes.json: DMB's Golem Foundry)
	// gets it when none was asked for
	if (params.template && !params.guardTheme) {
		const own = TEMPLATE_THEMES[loadTemplate(params.template).name];
		if (own && own.theme) {
			params = { ...params, guardTheme: own.theme };
			console.error(`[gen] template brings theme ${own.theme}`);
		}
	}
	const mods = crawlMods(roots);
	stage('crawl');
	const active = loadActivationState(roots.userDir);
	const ordered = resolveLoadOrder(mods, active);
	const assetIndex = cachedAssetIndex(
		roots.installDir ? path.join(roots.installDir, 'config') : null,
		ordered, params.noCache);
	stage('assetIndex');

	// One rule for modded content, applied everywhere: a map that declares no
	// mod requirements uses no modded content. Opting in with declareMods
	// writes the requirements into the header and unlocks modded terrain and
	// modded creature banks together.
	const useMods = params.declareMods === true;
	// One entry per terrain, not one per (terrain, view). The view is decided
	// after the solve from each tile's neighbourhood, so carrying eight views
	// through the WFC multiplied the compatibility matrix by 64 to choose
	// between frames that are now overwritten anyway.
	const tiles = buildDictionary(assetIndex, params.viewsPerTerrain || 1,
		{ coreOnly: !useMods });
	const compatPairs = buildAdjacency(tiles, assetIndex);
	const compat = buildCompat(tiles.length, compatPairs);
	stage('compat');

	// tile ids grouped by terrain shortId, for biome domain masks
	const tileIdsByShort = new Map();
	for (let i = 0; i < tiles.length; i++) {
		const s = tiles[i].shortId;
		if (!tileIdsByShort.has(s)) tileIdsByShort.set(s, []);
		tileIdsByShort.get(s).push(i);
	}
	const terrainShortIds = [...tileIdsByShort.keys()];

	// Observer mode takes the LAST player slot and seals it on level 1, so it
	// owns the underground outright: --underground alongside it is ignored
	// rather than silently producing a third level the format has no room for.
	// The observer is named by COLOUR, because that is the key the engine's
	// per-seat AI override is written against: ai.playerAIOverrides is a map of
	// colour to AI library name, so which colours the contestants end up on is
	// the fact the launcher needs, and a positional "last slot" rule would make
	// it move whenever the player count changed.
	const observerIndex = params.observerColor
		? (params.players || []).findIndex(p => p.color === params.observerColor)
		: -1;
	if (params.observerColor && observerIndex < 0)
		throw new Error(`observer colour "${params.observerColor}" is not one of `
			+ `this map's players: ${(params.players || []).map(p => p.color).join(', ')}`);
	if (observerIndex >= 0 && (params.players || []).length < 2)
		throw new Error('observer mode needs at least two players: '
			+ 'the contestants plus the sequestered slot');
	const hasObserver = observerIndex >= 0;
	const levels = [{ name: 'surface', index: 0, width: params.mapW, height: params.mapH }];
	if (params.underground || hasObserver)
		levels.push({ name: 'underground', index: 1, width: params.mapW, height: params.mapH });

	// Faction-agnostic player towns: every indexed faction stays legal.
	//
	// Clamp townPos so the randomTown footprint stays on the map. The bounds
	// come from the mask itself now. They were written as 3 and 2 for a 4x3
	// placeholder that has since grown to match the real town, and an anchor at
	// x=3 puts the leftmost blocked column at -1, which JavaScript happily
	// indexes as a cell on the row above. Header mainTown and the town object
	// share these coordinates: placeStartingHero matches posOfMainTown against
	// each town's anchor and converts to the gate itself.
	const townMask = OBJECT_TEMPLATES.randomTown.mask;
	const townW = Math.max(...townMask.map(r => r.length));
	const townH = townMask.length;
	// The same core-only rule as terrain and banks applies to the faction
	// pool: a modded faction id in allowedFactions on a mods:null map is one
	// a player can roll and the engine cannot resolve, which is a townless
	// start rather than a skipped entry.
	const allFactions = [...assetIndex.factions.keys()]
		.filter(f => useMods || f.startsWith('core:'));
	const factionAgnostic = params.factionAgnostic !== false;
	// The engine's own generator pins one concrete faction per player at
	// generation time and writes that single entry into allowedFactions
	// (TownPlacer.cpp:93-128); the player's start biome then takes the
	// faction's nativeTerrain (TerrainPainter.cpp:61-73). Roll the same
	// way here. A caller-fixed faction list stays authoritative for the
	// header; when it names several, one is rolled for the terrain alone.
	// One stream per seat: a single shared xorshift fed seed^0x5fa1 put
	// red on inferno for every seed in the bench set, because the first
	// xorshift output barely diffuses the low seed bits and %9 then
	// buckets them together. Mixing the player index into the seed and
	// discarding the first two weak outputs decorrelates both.
	const factionRoll = i => {
		const r = xorshift((params.seed || 1) ^ (0x5fa1 + i * 0x9E3779B9));
		r(); r();
		return r();
	};
	const nativeOf = f => {
		const fa = assetIndex.factions.get(f);
		return fa && fa.nativeTerrain ? String(fa.nativeTerrain) : null;
	};
	const chamber = hasObserver ? observerChamber(params.mapW, params.mapH) : null;
	const observerAnchor = chamber ? observerTownAnchor(chamber) : null;
	// A template's player zone decides its start's faction the engine's way
	// (zoneTowns.js, TownPlacer::placeTowns): a roll from the factions the zone
	// allows, preferring those whose preferUndergroundPlacement matches the
	// start's level. Read before the starts are pinned, because the faction
	// picks the start's biome.
	const factionsForTowns = townFactions(allFactions, assetIndex.factions);
	const tplZonesEarly = params.template ? resolveZones(loadTemplate(params.template).raw) : null;
	const ownerZone = i => tplZonesEarly && tplZonesEarly.find(z => Number(z.owner) === i + 1
		&& /start/i.test(String(z.type || '')));
	// The template decides where its starts go. The engine lays start zones out
	// with the rest (CZonePlacer) and puts each town inside its zone; we pin
	// starts to fixed cells, so the cells have to suit the template's links.
	// First the CLI's cells, handed to the start zones the way the links
	// arrange them (startOrder.js). Then, for two to four players on the
	// surface, a few other symmetric arrangements (opposite edges, other
	// corners, triangles), each laid out and partitioned dry the way planLevel
	// will; the one whose zones realize the most template links wins, and a tie
	// keeps the CLI's cells. Two diagonal corners, the only 2-player choice
	// before, left one of Blockbuster M's links to a portal on every seed.
	// VMAPGEN_START_ORDER=0 keeps the CLI's cells (for measuring the change).
	const startCell = new Map();
	let presetSeeds0 = null;  // the free layout the start cells came from, if they did
	if (tplZonesEarly && process.env.VMAPGEN_START_ORDER !== '0') {
		const tplRawEarly = loadTemplate(params.template).raw;
		const cand = (params.players || []).map((p, i) => ({ i, zone: ownerZone(i), pos: p.townPos }))
			.filter(s => s.i !== observerIndex && s.zone && s.pos);
		for (const l of new Set(cand.map(s => s.pos.l))) {
			const onLevel = cand.filter(s => s.pos.l === l);
			const order = orderStarts(tplRawEarly, onLevel.map(s => s.zone.id), onLevel.map(s => s.pos));
			onLevel.forEach((s, k) => { if (order[k] !== k) startCell.set(s.i, onLevel[order[k]].pos); });
		}
		const n = (params.players || []).length;
		if (observerIndex < 0 && n >= 2 && n <= 4 && cand.length === n && cand.every(s => s.pos.l === 0)) {
			let plan0 = null;
			try {
				plan0 = buildZonePlan(tplRawEarly, tplZonesEarly, { w: params.mapW, h: params.mapH,
					levels: levels.length, players: n, humans: params.humans, seed: params.seed || 1 }, new Set(params.accommodate || []));
			} catch { plan0 = null; }
			if (plan0) {
				const W = params.mapW, H = params.mapH;
				const at = (x, y) => ({ l: 0, x, y });
				const TL = at(4, 4), TR = at(W - 5, 4), BL = at(4, H - 5), BR = at(W - 5, H - 5);
				const ML = at(4, H >> 1), MR = at(W - 5, H >> 1), MT = at(W >> 1, 4), MB = at(W >> 1, H - 5);
				const shapes = { 2: [[TR, BL], [ML, MR], [MT, MB]],
					3: [[TL, TR, MB], [BL, BR, MT], [TL, BL, MR], [TR, BR, ML]],
					4: [[MT, MB, ML, MR]] }[n] || [];
				const current = cand.map(s => startCell.get(s.i) || s.pos);
				const options = [current];
				for (const cells of shapes) {
					const o = orderStarts(tplRawEarly, cand.map(s => s.zone.id), cells);
					options.push(cand.map((s, k) => cells[o[k]]));
				}
				const zones0 = plan0.perLevel[0];
				const conns0 = plan0.connections.filter(c => c.aRef && c.bRef && c.aRef.l === 0 && c.bRef.l === 0)
					.map(c => ({ ...c, a: c.aRef.i, b: c.bRef.i }));
				// and the engine's own way: every zone free, starts included, the
				// start cells read off where the start zones land. 2SM4d puts its
				// two starts side by side in the middle, which no edge or corner
				// arrangement can give (7 of its 15 links were portals).
				const free = chooseTemplateLayout({ tplZones: zones0, tplConns: conns0, W, H,
					playerStarts: [], seed: params.seed || 1, p: params.biomes || {}, tries: 8 });
				const zoneAt = s => zones0.findIndex(z => z.id === s.zone.id);
				if (cand.every(s => zoneAt(s) >= 0))
					options.push(cand.map(s => at(free.seeds[zoneAt(s)].x, free.seeds[zoneAt(s)].y)));
				const freeOption = options.length - 1;
				let best = null;
				options.forEach((cells, oi) => {
					const r = chooseTemplateLayout({ tplZones: zones0, tplConns: conns0, W, H,
						playerStarts: cells, seed: params.seed || 1, p: params.biomes || {}, tries: 4,
						preset: oi === freeOption ? free.seeds : null });
					if (!best || r.missing < best.missing) best = { cells, missing: r.missing, oi };
				});
				if (best && best.oi > 0) {
					console.error(`[gen] template starts: ${best.oi === freeOption ? 'a free layout\'s start cells'
						: `arrangement ${best.oi + 1} of ${options.length}`} leave ${best.missing} link(s) `
						+ 'without a shared border in a dry layout');
					cand.forEach((s, k) => startCell.set(s.i, best.cells[k]));
					if (best.oi === freeOption) presetSeeds0 = free.seeds;
				}
			}
		}
		for (const [i, c] of [...startCell])
			if (c.x === params.players[i].townPos.x && c.y === params.players[i].townPos.y) startCell.delete(i);
		if (startCell.size)
			console.error('[gen] template starts rearranged to fit its links: ' + [...startCell]
				.map(([i, c]) => `${params.players[i].color} to (${c.x},${c.y})`).join(', '));
	}
	const players = (params.players || []).map((p, i) => {
		const isObserver = i === observerIndex;
		const pos = isObserver
			? { l: 1, x: observerAnchor.x, y: observerAnchor.y }
			: (startCell.get(i) || p.townPos);
		const given = p.factions && p.factions.length ? p.factions : allFactions;
		let factions = given, pinned = null;
		if (isObserver) factions = allFactions;
		else if (factionAgnostic && ownerZone(i)) {
			const pick = pickStartFaction(zoneTownTypes(ownerZone(i), factionsForTowns),
				pos.l > 0, factionRoll(i));
			pinned = pick ? pick.id : allFactions[(factionRoll(i) * allFactions.length) | 0];
			factions = [pinned];
		} else if (factionAgnostic) {
			pinned = allFactions[(factionRoll(i) * allFactions.length) | 0];
			factions = [pinned];
		} else pinned = given.length === 1 ? given[0]
			: given[(factionRoll(i) * given.length) | 0];
		return {
			...p,
			factions,
			pinnedFaction: pinned,
			// An observer map is not a map anyone plays a side on: the two
			// contestants are AIOnly so a human cannot take one by accident,
			// and the sequestered slot is PlayerOnly so an AI never inherits
			// a seat it could not use.
			// aiOnly without observer is the other half of the same idea: a
			// map with no seat a human can take has no human player, and
			// Client.cpp:239 then turns the spectator interface on by itself,
			// so the whole map is visible with no client flag at all.
			canPlay: isObserver ? 'PlayerOnly'
				: (hasObserver || params.aiOnly) ? 'AIOnly' : p.canPlay,
			townPos: {
				l: pos.l,
				x: Math.min(Math.max(pos.x, townW - 1), params.mapW - 1),
				y: Math.min(Math.max(pos.y, townH - 1), params.mapH - 1),
			},
		};
	});
	console.error('[gen] factions: ' + players
		.map(p => `${p.color}=${p.factions.join('|')}`).join('  '));
	// Surface water goes down before anything is planned: it can move a start
	// inland (a Continental sea takes the corners the starts were pinned to),
	// and the zones partition only the land it leaves.
	const surfaceIdx = players.map((p, i) => i)
		.filter(i => i !== observerIndex && players[i].townPos.l === 0);
	// Water and cave rock have to be drawable: each mask is checked against
	// the engine's own view patterns (maskcheck.js). The shore as water beside
	// a normal and a dirt terrain (sand fits anything), the two land groups
	// with the fewest shore sprites; the cave as rock beside subterranean.
	const coreTerrain = ident => {
		for (const [, t] of assetIndex.terrains)
			if (t.identifier === ident && String(t.name || '').startsWith('core:'))
				return { id: t.name, group: t.viewGroup || 'normal',
					transitionRequired: !!t.transitionRequired,
					passable: (t.moveCost || 0) > 0,
					isDirt: ident === 'dirt', isSand: ident === 'sand' };
		return null;
	};
	const viewPatternsEarly = loadTerrainViewPatterns(roots.installDir);
	const shoreCheck = coreTerrain('water') && coreTerrain('grass') && coreTerrain('dirt')
		? makeMaskChecker(viewPatternsEarly, coreTerrain('water'), [coreTerrain('grass'), coreTerrain('dirt')])
		: null;
	const caveChecker = coreTerrain('rock') && coreTerrain('subterra')
		&& process.env.VMAPGEN_CAVEFIT !== 'off'
		? makeMaskChecker(viewPatternsEarly, coreTerrain('rock'), [coreTerrain('subterra')])
		: null;
	const waterPlan = buildWaterPlan(params.mapW, params.mapH, params.biomes || {},
		surfaceIdx.map(i => players[i].townPos), params.seed || 1, shoreCheck);
	if (waterPlan && waterPlan.unfit)
		console.error(`[gen] water: ${waterPlan.unfit} shore tile(s) no sprite fits`);
	// where the starts stood before the water moved any (the template check
	// below lays the dry map out from these)
	const waterOrigins = new Map(surfaceIdx.map(i =>
		[players[i].color, { x: players[i].townPos.x, y: players[i].townPos.y }]));
	if (waterPlan) {
		surfaceIdx.forEach((i, k) => {
			const m = waterPlan.starts[k];
			if (!m.moved) return;
			console.error(`[gen] water: ${players[i].color}'s start moved inland from `
				+ `(${players[i].townPos.x},${players[i].townPos.y}) to (${m.x},${m.y})`);
			players[i].townPos = { ...players[i].townPos, x: m.x, y: m.y };
		});
		console.error(`[gen] water: ${waterPlan.shape}, `
			+ `${(100 * waterPlan.coverage).toFixed(1)}% of the surface`);
		// the straits between islands are water whatever the amount says
		const asked = Number((params.biomes || {}).waterCoverage) || 0;
		if (waterPlan.islands && waterPlan.coverage > asked + 0.03)
			console.error(`[gen] water: the ${waterPlan.shape} layout needs about `
				+ `${Math.round(100 * waterPlan.coverage)}% water to part the islands; `
				+ `${Math.round(100 * asked)}% was asked for`);
	}
	// The observer is not a start the surface planner knows about: it has its
	// own level and its own town, placed by hand below.
	const starts = players
		.filter((_, i) => i !== observerIndex)
		.map(p => ({ ...p.townPos, color: p.color,
			native: nativeOf(p.pinnedFaction) }));

	// Biome plan drives both the WFC domains and the object layer.
	// Object pools from the live index: creature banks have no placeholder
	// type in the engine, so concrete mod-aware ids get placed directly
	// (the "dungeon structures" of the town-dependent spec). The seven core
	// banks come from the harvested table in economy.js and are always
	// available; these are the extras a mod contributes, and they only join
	// the pool on a map that declares its mods.
	const banks = [];
	// Dwellings, the same shape as banks: DWELLING_POOL (economy.js) is a
	// static harvest of the seventy-eight core dwellings, always available;
	// these are what a mod contributes, level-resolved against the live
	// creature index (a dwelling's own JSON only names the creature it
	// produces, not the level, and the census reads a stark dwellings
	// shortfall once mod content is in play the same way banks did before
	// today's fix - fidelity lens, 2026-09-25).
	const dwellings = [];
	// A template the generator can place: art to draw and a mask saying which
	// cells it blocks. Some mods leave the mask out (the engine fills it in
	// from elsewhere); once mod banks reached this pool, one of those crashed
	// footprintCells on 70 of the lens's 71 maps (2026-09-25).
	const placeables = o => (o.templates || []).filter(t => t.raw && t.raw.animation
		&& Array.isArray(t.raw.mask) && t.raw.mask.length);
	const placeable = o => placeables(o)[0];
	// A mod bank weighs what the engine's own draw gives it, from its rmg
	// rarity and value (economy.js bankRate), on the same scale as the core
	// banks. A flat 0.42 each used to put every one of this install's 55 at
	// about 2 a map, where real maps hold 15.6 Wolf Raider Pickets and 0.1
	// Demon Towers (bank_tally.js, 2026-09-26). A bank with no rmg entry, or one
	// a mod took out of the generator ("rmg": null), is never drawn.
	// the core banks as this install weighs them: a mod's patch to one (HotA's
	// rmgTweak puts the Imp Cache at 1500) holds on a map that declares its
	// mods; the utopia keeps its measured rate
	// mods' own art for a core bank on their terrains (New Pavilion's dunes
	// crypt and utopia), from the patches that name it, with the mod each
	// template needs declared
	const patchTpls = new Map();
	for (const [id, o] of assetIndex.objects)
		if (o.overrides)
			for (const t of placeables(o))
				if (t.allowedTerrains) {
					if (!patchTpls.has(o.overrides)) patchTpls.set(o.overrides, []);
					patchTpls.get(o.overrides).push({ raw: t.raw, terrains: t.allowedTerrains, mod: id.split(':')[0] });
				}
	const coreBanks = !useMods ? CORE_BANKS : CORE_BANKS.map(b => {
		const key = `core:${b.type}.${b.subtype}`;
		const o = assetIndex.objects.get(key);
		const extra = patchTpls.get(key);
		const tpls = extra ? [...(b.tpls || [{ raw: b.tpl, terrains: b.terrains || null }]), ...extra] : b.tpls;
		return { ...b, ...(tpls ? { tpls } : {}),
			...(o && b.type !== 'dragonUtopia' ? { rmg: o.rmg, weight: bankRate(o.rmg) } : {}) };
	}).filter(b => b.weight > 0);
	// Treasure chests the engine's way: every treasureChest subtype with an rmg
	// entry is a pile object of its own (TreasurePlacer::addCommonObjects),
	// drawn by rarity. Core's chest is always there; a map that declares its
	// mods adds theirs (The Great Expansion's spell stones, two treasure piles
	// and lost wagon on K's playset, the corpus's commonest treasure since
	// April), each with the templates its mod gives it and that mod declared,
	// and core's with a mod's art for that mod's terrain. content.js sizes the
	// count by the pool's rarity.
	const chests = [];
	{
		const coreKey = 'core:treasureChest.treasureChest';
		const core = assetIndex.objects.get(coreKey);
		chests.push({ type: 'treasureChest', subtype: 'treasureChest', core: true,
			rmg: useMods && core && core.rmg ? core.rmg : { value: 1500, rarity: 1000 },
			tpls: [{ raw: chestTemplate(), terrains: null },
				...(useMods ? (patchTpls.get(coreKey) || []) : [])] });
		if (useMods)
			for (const [id, o] of assetIndex.objects) {
				if (o.type !== 'treasureChest' || String(id).startsWith('core:') || o.overrides) continue;
				if (!o.rmg || !(o.rmg.value > 0) || !(o.rmg.rarity > 0)) continue;
				const tpls = placeables(o).map(x => ({ raw: x.raw, terrains: x.allowedTerrains || null }));
				if (tpls.length)
					chests.push({ type: 'treasureChest', subtype: o.subtype, rmg: o.rmg, tpls, mod: id.split(':')[0] });
			}
	}
	// Scenery for the mod terrains, from the obstacles their mods bring
	// (decor.js registerTerrainDecor): every static object's template that
	// names the terrain, taken from the mod entry that brings it, so its mod is
	// known and declared (terrainDecorMods, read when the header is built).
	// Each type draws as often as any other, a big one (mountain, trees) at
	// full weight and a one-cell ornament at a sixth, across its templates;
	// the pieces of four cells or more also stand alone as packs for the early
	// pack pass. Core terrains keep their harvested pools.
	clearTerrainDecor();
	clearTerrainBarriers();
	const terrainDecorMods = new Map();
	if (useMods) {
		const unscopeName = s => String(s).slice(String(s).lastIndexOf(':') + 1).toLowerCase();
		for (const [shortId, t] of assetIndex.terrains) {
			if (DECOR_TERRAINS.includes(shortId) || !(t.moveCost > 0) || !(t.allowedLayers || []).length) continue;
			const name = unscopeName(t.identifier);
			const byType = new Map();
			for (const [id, o] of assetIndex.objects) {
				if (o.handler !== 'static' || String(id).startsWith('core:')) continue;
				const mod = id.split(':')[0];
				for (const tp of o.templates || []) {
					if (!tp.allowedTerrains || !tp.allowedTerrains.some(x => unscopeName(x) === name)) continue;
					if (!tp.raw || !tp.raw.animation || !Array.isArray(tp.raw.mask) || !tp.raw.mask.length) continue;
					// blocking cells in the engine's alphabet (B, H, A, T); the
					// index's footprint counts V, the drawn-only cells, as well
					const cells = blockingCells({ animation: tp.raw.animation, mask: tp.raw.mask }, 0, 0).length;
					if (!cells) continue;
					const animation = String(tp.raw.animation).replace(/\.def$/i, '');
					const e = { type: o.type, subtype: o.subtype, animation, mask: tp.raw.mask, cells, mod };
					if (!byType.has(o.type)) byType.set(o.type, []);
					byType.get(o.type).push(e);
				}
			}
			const clusters = [], single = [];
			for (const list of byType.values()) {
				const mean = list.reduce((a, e) => a + e.cells, 0) / list.length;
				const w = Math.min(1, mean / 6) / list.length;
				for (const e of list) {
					(e.cells > 1 ? clusters : single).push({ ...e, weight: w });
					terrainDecorMods.set(e.animation, e.mod);
				}
			}
			if (!clusters.length && !single.length) continue;
			const packs = clusters.filter(e => e.cells >= 4).map(e => {
				const tpl = { animation: e.animation, mask: e.mask };
				return { size: e.cells, cells: blockingCells(tpl, 0, 0).map(([x, y]) => [x, y]),
					objects: [{ type: e.type, subtype: e.subtype, animation: e.animation, mask: e.mask, dx: 0, dy: 0 }] };
			});
			registerTerrainDecor(shortId, { clusters, single, packs });
			registerTerrainBarriers(shortId, single.map(e => ({ type: e.type, subtype: e.subtype,
				animation: e.animation, mask: e.mask })));
		}
		console.error(`[gen] mod terrain scenery: ${[...new Set(terrainDecorMods.values())].length} mod(s), `
			+ `${terrainDecorMods.size} template(s)`);
	}
	// The mods' own obstacle sets (retile.js registerModSet). A zone's scenery
	// ends up as the art of the sets it draws, as the engine's prepareBiome
	// draws them (the retile pass), and mods add sets for core terrains as well
	// as their own: HotA's palms and dunes on sand, glaciers on snow. Our core
	// terrains had core art only, where the corpus's are 7-47% mods' art; with
	// this install's sets the engine's draw predicts those shares within a few
	// points (sand 44% against 47%, swamp 40 against 39). A set's template names
	// resolve as the engine resolves them (the set's own mod first, then core's,
	// then any other), H3's own through the core sets' snapshot, and every mod
	// piece is declared with its mod.
	clearModSets();
	if (useMods && (assetIndex.obstacleSets || []).length) {
		const lc = s => String(s).toLowerCase().replace(/\.def$/, '');
		const unscoped = s => lc(s).slice(lc(s).lastIndexOf(':') + 1);
		const byName = new Map();
		for (const [, o] of assetIndex.objects) {
			if (o.handler !== 'static') continue;
			for (const tp of o.templates || []) {
				if (!tp.name || !tp.raw || !tp.raw.animation || !Array.isArray(tp.raw.mask) || !tp.raw.mask.length) continue;
				const scope = tp.scope || 'core';
				if (!byName.has(lc(tp.name))) byName.set(lc(tp.name), new Map());
				byName.get(lc(tp.name)).set(scope, { type: o.type, subtype: o.subtype, scope,
					animation: String(tp.raw.animation).replace(/\.def$/i, ''), mask: tp.raw.mask });
			}
		}
		const h3 = coreSetTemplates();
		const shortOf = new Map([...assetIndex.terrains].map(([s, t]) => [unscoped(t.identifier || ''), s]));
		let sets = 0, pieces = 0;
		const from = new Set();
		for (const set of assetIndex.obstacleSets) {
			if (set.scope === 'core') continue;   // core's are in the snapshot
			const templates = [];
			for (const raw of set.templates) {
				const scoped = byName.get(unscoped(raw));
				const t = scoped && (scoped.get(set.scope) || scoped.get('core') || scoped.values().next().value);
				if (t) {
					templates.push(t);
					if (t.scope !== 'core') terrainDecorMods.set(t.animation, t.scope);
				} else if (h3.has(unscoped(raw))) templates.push(h3.get(unscoped(raw)));
			}
			const terrains = set.terrains.map(n => shortOf.get(n)).filter(Boolean);
			if (!templates.length || !terrains.length) continue;
			for (const short of terrains)
				registerModSet(short, set.type, { name: `${set.scope}:${set.name}`, factions: set.factions, templates });
			sets++; pieces += templates.length; from.add(set.scope);
		}
		console.error(`[gen] mod obstacle sets: ${sets} from ${from.size} mod(s), ${pieces} template(s)`);
	}
	// the ground a zone stands on, by the short id content.js knows it by: the
	// name a template's allowedTerrains uses, and whether an "any land"
	// template may stand there (TerrainType::isLand and isPassable)
	const terrainNames = new Map([...assetIndex.terrains].map(([shortId, t]) => [shortId, {
		name: String(t.identifier || '').toLowerCase(),
		land: !(t.types || []).some(k => /^(WATER|ROCK)$/i.test(k)),
	}]));
	// A creature named in a mod's config resolves the way the engine does it
	// (CIdentifierStorage::getPossibleIdentifiers, ModDescription.cpp:51-63):
	// a scoped name as written; an unscoped one in the mod itself, then in
	// what it depends on, which is its "depends" list plus its parent and top
	// parent for a submod, then core. Not transitive, as in the engine.
	const modById = new Map(ordered.map(m => [m.__id, m]));
	const resolveCreature = (scope, name) => {
		if (!name) return null;
		const n = String(name);
		if (n.includes(':')) return assetIndex.creatures.get(n) || null;
		const mod = modById.get(scope);
		const parts = scope.split('.');
		const scopes = [scope, ...((mod && mod.depends) || []).map(d => String(d).split('@')[0].trim().toLowerCase()),
			parts.slice(0, -1).join('.'), parts[0], 'core'];
		for (const s of scopes) {
			if (!s) continue;
			const c = assetIndex.creatures.get(`${s}:${n}`);
			if (c) return c;
		}
		return null;
	};
	if (useMods)
		for (const [id, o] of assetIndex.objects) {
			// a patch's templates and rmg already joined the object it names
			if (String(id).startsWith('core:') || o.overrides) continue;
			const t = placeable(o);
			if (!t) continue;
			const weight = o.type === 'creatureBank' ? bankRate(o.rmg) : 0;
			// every template goes along with the terrains it allows, for
			// content.js to take the one a zone's ground can carry
			if (weight > 0)
				banks.push({ subtype: o.subtype, aiValue: o.aiValue || 0, weight, rmg: o.rmg,
					tpl: t.raw, tpls: placeables(o).map(x => ({ raw: x.raw, terrains: x.allowedTerrains || null })),
					mod: id.split(':')[0], creatures: o.bankCreatures || [] });
			if (/^creatureGenerator/.test(o.type) && o.creature) {
				const scope = id.split(':')[0];
				const cre = resolveCreature(scope, o.creature);
				if (cre && cre.level >= 1)
					dwellings.push({ type: o.type, subtype: o.subtype, level: cre.level,
						weight: 1, tpl: t.raw, mod: scope, creatures: o.creatures || [o.creature] });
			}
		}
	// A creature theme (--theme): the dwellings whose creatures belong to the
	// family, core's (the Golem Factory's four golems, the gargoyle parapet)
	// and, on a map that declares its mods, theirs. content.js draws a share
	// of the map's dwellings from these (guardCreatures.js themeDwellingPool).
	const themeDwellings = params.guardTheme
		? themeDwellingPool(params.guardTheme, DWELLING_POOL, dwellings, assetIndex.objects,
			Number.isFinite(params.dwellingThemeShare) ? params.dwellingThemeShare : 0.5)
		: null;
	if (themeDwellings)
		console.error(`[gen] theme ${params.guardTheme}: ${themeDwellings.pool.length} dwelling kind(s) `
			+ `(${themeDwellings.pool.map(d => d.subtype).join(', ') || 'none'}), share ${themeDwellings.share}`);
	// and the creature banks guarded by the family or paying out in it (none in
	// core; HotA's experimental shop and The Great Expansion's sculptor's
	// monument on K's playset), a smaller share because there are so few kinds
	const themeBanks = params.guardTheme
		? themeBankPool(params.guardTheme, coreBanks, banks, assetIndex.objects,
			Number.isFinite(params.bankThemeShare) ? params.bankThemeShare : 0.3)
		: null;
	if (themeBanks)
		console.error(`[gen] theme ${params.guardTheme}: ${themeBanks.pool.length} bank kind(s) `
			+ `(${themeBanks.pool.map(b => b.subtype).join(', ') || 'none'}), share ${themeBanks.share}`);
	// RMG template mode: --template names a zone-graph preset from the
	// install's own rmg configs (or a file path). Strict constraints
	// (minSize/maxSize/players/humans/forcedLevel) fail loudly unless an
	// accommodation names them.
	let zonePlan = null;
	if (params.template) {
		const tpl = loadTemplate(params.template);
		const zones = resolveZones(tpl.raw);
		const req = { w: params.mapW, h: params.mapH, levels: levels.length,
			players: players.length, humans: params.humans, seed: params.seed || 1 };
		const acc = new Set(params.accommodate || []);
		const { violations, accommodated } = checkConstraints(tpl.raw, zones, req, acc);
		for (const a of accommodated)
			console.error(`[gen] template accommodation: ${a}`);
		if (violations.length)
			throw new Error(`template "${tpl.name}" cannot run: `
				+ violations.join('; ')
				+ ' (relax with --accommodate size,players,humans,underground)');
		zonePlan = buildZonePlan(tpl.raw, zones, req, acc);
		if (presetSeeds0) zonePlan.presetSeeds = { 0: presetSeeds0 };
		console.error(`[gen] template "${tpl.name}": ${zones.length} zones, `
			+ `${zonePlan.connections.length} connections, `
			+ `${zonePlan.perLevel.map(l => l.length).join('/')} per level`);
	}
	const biomeParams = params.biomes || {};
	// Water against a template (queue 25d). A template's zones were sized for
	// a dry map; water takes ground from them, and where it lies decides
	// whose. Lay the zones out dry and wet (layout only, no content) and
	// refuse water that crushes a zone the dry layout did not, or that leaves
	// more of the template's links without a shared border than a few. The
	// verdict is taken on three fixed layout seeds, majority rules, so it
	// belongs to the settings (template, size, players, levels, water) rather
	// than to one roll of the map seed. The refusal names the reason and what
	// does fit, so the player can choose.
	if (waterPlan && zonePlan && !process.env.VMAPGEN_WATER_FORCE) {
		const SEEDS = [101, 202, 303];
		const tplRaw = loadTemplate(params.template).raw;
		const tplName = loadTemplate(params.template).name;
		const layout = (mask, startList, plan, seed, islands = false) => planMap({
			W: params.mapW, H: params.mapH,
			levels: plan.perLevel.length, playerStarts: startList,
			params: { ...biomeParams, seed, zonePlan: plan, waterMask: mask, layoutOnly: true,
				waterIslands: islands },
			terrainShortIds, tileIdsByShort, numTiles: tiles.length,
			objectPools: { banks, dwellings, coreBanks, chests, terrainNames }, terrainInfo: assetIndex.terrains,
		}).plans[0].stats;
		const figures = st => {
			const tot = st.sizes.reduce((a, v) => a + v * v, 0) || 1;
			const ratios = st.zoneLand.map((n, i) => n / (st.landCells * st.sizes[i] ** 2 / tot));
			return { st, ratios, crushed: ratios.filter(r => r < 0.4).length };
		};
		const withMoved = moved => starts.map((s, k) => ({ ...s, x: moved[k].x, y: moved[k].y }));
		const origin = starts.map(s => waterOrigins.get(s.color) || { x: s.x, y: s.y });
		const dryCache = new Map();
		const dryFor = (plan, seed) => {
			const key = `${plan.perLevel.length}:${seed}`;
			if (!dryCache.has(key)) dryCache.set(key, figures(layout(null, withMoved(origin), plan, seed)));
			return dryCache.get(key);
		};
		const severity = (wet, dry) => 100 * (wet.crushed - dry.crushed) + wet.st.unfulfilled - dry.st.unfulfilled;
		const judge = (biomes, plan) => {
			let fails = 0, worst = null;
			for (const seed of SEEDS) {
				const dry = dryFor(plan, seed);
				const wp = buildWaterPlan(params.mapW, params.mapH, biomes, origin, seed);
				const wet = figures(layout(wp.mask, withMoved(wp.starts), plan, seed, !!wp.islands));
				const ok = wet.crushed <= dry.crushed && wet.st.unfulfilled
					<= dry.st.unfulfilled + Math.max(1, Math.round(0.15 * dry.st.links));
				if (!ok) fails++;
				if (!worst || severity(wet, dry) > severity(worst.wet, worst.dry)) worst = { wet, dry };
			}
			return { ...worst, ok: fails * 2 < SEEDS.length };
		};
		const ZONE_WORDS = { playerStart: 'player start', cpuStart: 'computer start' };
		const verdict = judge(biomeParams, zonePlan);
		if (!verdict.ok) {
			const { wet, dry } = verdict;
			const shapeOf = i => WATER_SHAPES[i].label;
			const pct = v => `${Math.round(100 * v)}%`;
			const chosen = Math.max(0, Math.min(WATER_SHAPES.length - 1, Math.round(Number(biomeParams.waterShape) || 0)));
			const cover = Number(biomeParams.waterCoverage);
			let worst = 0;
			for (let i = 1; i < wet.ratios.length; i++) if (wet.ratios[i] < wet.ratios[worst]) worst = i;
			const why = wet.crushed > dry.crushed
				? `its ${ZONE_WORDS[wet.st.types[worst]] || wet.st.types[worst]} zones would keep only ${pct(wet.ratios[worst])} of their share of the land`
				: `${wet.st.unfulfilled} of its ${wet.st.links} zone links would have no shared border (${dry.st.unfulfilled} dry)`;
			const ok = [];
			// the underground is only a way out when the template's own sizes allow
			// two levels; the Random Map tab drops a template whose sizes do not
			const twoLevels = [tplRaw.minSize, tplRaw.maxSize]
				.some(code => (parseSizeCode(code) || [0, 1])[1] >= 2);
			if (levels.length === 1 && twoLevels) {
				const plan2 = buildZonePlan(tplRaw, resolveZones(tplRaw),
					{ w: params.mapW, h: params.mapH, levels: 2, players: players.length, humans: params.humans, seed: params.seed || 1 },
					new Set(params.accommodate || []));
				if (plan2.perLevel[1].length && judge(biomeParams, plan2).ok) ok.push('turn the underground on');
			}
			const others = [];
			for (let i = 0; i < WATER_SHAPES.length; i++)
				if (i !== chosen && !WATER_SHAPES[i].islands
						&& judge({ ...biomeParams, waterShape: i }, zonePlan).ok) others.push(shapeOf(i));
			if (others.length) ok.push(`${others.join(' or ')} at ${pct(cover)}`);
			for (let c = Math.round(cover * 20) - 1; c >= 1; c--)
				if (judge({ ...biomeParams, waterCoverage: c / 20 }, zonePlan).ok) {
					ok.push(`${shapeOf(chosen)} up to ${pct(c / 20)}`);
					break;
				}
			throw new Error(`Water does not fit this template: ${shapeOf(chosen)} water at `
				+ `${pct(cover)} on ${tplName}${levels.length === 1 && twoLevels ? ' without the underground' : ''}: `
				+ `${why}. ${ok.length ? 'What fits: ' + ok.join('; ') + '.' : 'Lower the amount of water.'}`);
		}
		console.error(`[gen] water fits the template (${SEEDS.length} layout seeds): worst `
			+ `${verdict.wet.crushed} crushed zone(s) (${verdict.dry.crushed} dry), `
			+ `${verdict.wet.st.unfulfilled}/${verdict.wet.st.links} links without a border `
			+ `(${verdict.dry.st.unfulfilled} dry)`);
	}
	// Concrete guards: a template zone's guards are picked from the creatures it
	// allows and written as the creatures picked, as the engine writes them
	// (guardCreatures.js). The registry is core alone unless the map declares
	// its mods, as for every other kind of content. The default since
	// 2026-09-26: the template-mode lens put them on the corpus over 71 maps
	// (mod creatures 52.9% of guards against 52.0%, mean level 3.03 against
	// 3.03) and the game loaded every concrete-guard smoke map clean.
	// VMAPGEN_CONCRETE_GUARDS=0 writes placeholders again.
	const concreteGuards = params.concreteGuards !== undefined ? !!params.concreteGuards
		: process.env.VMAPGEN_CONCRETE_GUARDS !== '0';
	// VMAPGEN_GUARD_POOL=core keeps mod creatures out of the guard pool on a
	// map that declares mods, so a lens run can measure that one variable
	const guardMods = useMods && process.env.VMAPGEN_GUARD_POOL !== 'core';
	const registry = creatureRegistry(assetIndex.creatures, guardMods);
	const { plans, blocked } = planMap({
		W: params.mapW, H: params.mapH,
		levels: hasObserver ? levels.length - 1 : levels.length,
		playerStarts: starts,
		params: { ...biomeParams, seed: params.seed || 1, zonePlan,
			waterMask: waterPlan ? waterPlan.mask : null, caveChecker,
			waterIslands: !!(waterPlan && waterPlan.islands),
			layoutOnly: !!process.env.VMAPGEN_PLAN_ONLY },
		terrainShortIds, tileIdsByShort, numTiles: tiles.length,
		objectPools: { banks, dwellings, coreBanks, chests, terrainNames, ...(concreteGuards ? { guards: guardPool(registry) } : {}),
			...(themeDwellings ? { themeDwellings } : {}),
			...(themeBanks && themeBanks.pool.length ? { themeBanks } : {}),
			// a template zone's towns: concrete, of the factions it allows
			...(zonePlan ? { towns: { factions: factionsForTowns, useMods,
				pinned: new Map(players.filter(p => p.pinnedFaction).map(p =>
					[p.color, factionsForTowns.find(f => f.id === p.pinnedFaction)]).filter(([, f]) => f)) } } : {}) },
		terrainInfo: assetIndex.terrains,
	});
	if (hasObserver) {
		// Rock is excluded from the tile dictionary on purpose, so the chamber
		// floor is named here the same way the rock filler is named below: by
		// identifier off the live asset index, core scope only, never guessed.
		let subShortId = null;
		for (const [shortId, t] of assetIndex.terrains)
			if (t.identifier === 'subterra' && String(t.name || '').startsWith('core:'))
				subShortId = shortId;
		if (!subShortId)
			throw new Error('observer mode found no core subterranean terrain to floor the chamber with');
		plans.push(planObserverLevel({
			W: params.mapW, H: params.mapH,
			color: players[observerIndex].color,
			terrainShortId: subShortId, chamber,
		}));
		console.error(`[gen] observer: ${players[observerIndex].color} sealed in a `
			+ `${chamber.x1 - chamber.x0 + 1}x${chamber.y1 - chamber.y0 + 1} chamber at `
			+ `(${chamber.x0},${chamber.y0})-(${chamber.x1},${chamber.y1}) on level 1, `
			+ `town at (${observerAnchor.x},${observerAnchor.y})`);
	}
	stage('biomePlan');
	// VMAPGEN_PLAN_ONLY: stop after planning and report the layout figures
	// (planLevel stats) as JSON on stdout; no terrain solve, no map written.
	if (process.env.VMAPGEN_PLAN_ONLY) {
		process.stdout.write(JSON.stringify({ plan: plans.map(pl => pl.stats || null),
			water: waterPlan ? { shape: waterPlan.shape, coverage: waterPlan.coverage,
				moved: waterPlan.starts.filter(s => s.moved).length } : null }) + '\n');
		return { planOnly: true };
	}

	const levelGrids = [];
	let L = 1, stitchWidth = 3;
	for (const lv of levels) {
		const plan = plans[lv.index];
		const domainByBiome = new Map();
		const cellDomainFn = g => {
			const b = plan.zone[g];
			if (!domainByBiome.has(b)) {
				const d = new BitSet(tiles.length);
				for (const tid of tileIdsByShort.get(plan.biomeTerrain[b]) || []) d.set(tid);
				if (d.isEmpty()) { domainByBiome.set(b, null); return null; }
				domainByBiome.set(b, d);
			}
			return domainByBiome.get(b);
		};
		// Every tile legal on THIS layer. Used only when the biome domains
		// cannot be satisfied, so the fallback stays on the right layer
		// instead of putting surface dirt underground.
		const layerName = lv.index === 0 ? 'surface' : 'underground';
		const levelDomain = new BitSet(tiles.length);
		for (let i = 0; i < tiles.length; i++)
			if ((tiles[i].layers || []).includes(layerName)) levelDomain.set(i);
		if (levelDomain.isEmpty())
			for (let i = 0; i < tiles.length; i++) levelDomain.set(i);

		const r = await solveChunked(tiles, compat, lv.width, lv.height,
			{ ...params, assetIndex, cellDomainFn,
				levelDomainBits: Array.from(levelDomain.words),
				seed: (params.seed || 1) + lv.index * 31337 });
		levelGrids.push(r.grid);
		L = Math.max(L, r.L);
		stitchWidth = Math.max(stitchWidth, r.stitchWidth);
		stage(`solve:${lv.name}`);
	}

	// Collect all planned objects across levels, and the mods they came from.
	// The header declares exactly the mods whose content landed on the map -
	// every one the machine happened to have enabled was the old behaviour,
	// and it made generated maps unopenable on any other install.
	const objects = [];
	const usedMods = new Set();
	// guard -> the creature the engine's rule picked for it (concrete guards)
	const picked = new Map();
	for (const plan of plans)
		for (const o of plan.objects) {
			if (o.mod) { for (const m of [].concat(o.mod)) usedMods.add(m); delete o.mod; }
			// scenery drawn from a mod's obstacles (a mod terrain's own, or a
			// mod's obstacle sets through the retile pass) needs that mod
			else if (o.template && terrainDecorMods.has(o.template.animation))
				usedMods.add(terrainDecorMods.get(o.template.animation));
			if (o.guardCreature) { picked.set(o, o.guardCreature); delete o.guardCreature; }
			objects.push(o);
		}
	// Every piece of scenery goes out as the object its art belongs to. A mod's
	// obstacle is usually a subtype of its own (HotA's spruces::spruces), and a
	// call site that let it default to "object" wrote spruces::object, which the
	// engine cannot resolve, so it refuses the whole map (0.2.1, with mod content
	// on, on any map with a mod terrain's scenery). The same type with another
	// subtype is corrected here from the template's own object, and counted: a
	// non-zero count means a call site still drops it.
	{
		const artOf = new Map();
		for (const [, o] of assetIndex.objects) {
			if (o.handler !== 'static') continue;
			for (const t of o.templates || [])
				if (t.raw && t.raw.animation)
					artOf.set(String(t.raw.animation).replace(/\.def$/i, '').toLowerCase(), o);
		}
		let fixed = 0;
		for (const o of objects) {
			const own = o.template && artOf.get(String(o.template.animation).toLowerCase());
			if (own && own.type === o.type && own.subtype !== o.subtype) { o.subtype = own.subtype; fixed++; }
		}
		if (fixed) console.error(`[gen] WARNING: ${fixed} scenery piece(s) carried another subtype than their art's object; corrected`);
	}

	const h3 = (params.guardTheme || picked.size)
		? h3MonsterTemplates([roots.userDir, roots.installDir]) : null;
	// Themed guards (--guardtheme): a share of the guard placeholders become
	// creatures of one family, each standing for the strength it replaced.
	// The theme is the player's explicit choice, so it goes first and the
	// engine's own picks fill whatever it leaves.
	if (params.guardTheme) {
		const pool = themePool(params.guardTheme, { creatures: assetIndex.creatures, useMods, h3 });
		const share = Number.isFinite(params.guardThemeShare) ? params.guardThemeShare : 1;
		const t = applyGuardTheme(objects, { pool, share, W: params.mapW, H: params.mapH,
			rng: xorshift((params.seed || 1) + 5353) });
		for (const mod of t.mods) usedMods.add(mod);
		console.error(`[gen] guard theme ${params.guardTheme}: ${t.themed} of `
			+ `${t.placeholders} guards from ${pool.length} creatures `
			+ `(${[...new Set(pool.map(c => c.name))].join(', ') || 'none usable'})`);
	}
	if (picked.size) {
		const c = concretizeGuards(objects, picked, { registry, h3, useMods: guardMods,
			W: params.mapW, H: params.mapH });
		for (const mod of c.mods) usedMods.add(mod);
		console.error(`[gen] concrete guards: ${c.placed} written as their creature, `
			+ `${c.kept} kept as placeholders (no template the map can use)`);
	}

	// Every town lists the spells its mage guild may offer. The engine reads
	// possibleSpells from the map and from nowhere else (CGTownInstance::
	// serializeJsonOptions; CGameState.cpp:901-942 fills the guild from it), so a
	// town that lists none opens with an empty mage guild, which every town on
	// our maps did until 2026-09-26. The engine's own generator lists every
	// spell allowed by default (TownPlacer.cpp:112-113): not special and not a
	// creature ability (CSpellHandler::getDefaultAllowed), core's and, on a map
	// that declares its mods, theirs. The game still drops what the map or the
	// faction does not allow when it fills the guild.
	const townSpells = [...(assetIndex.spells || [])]
		.filter(([id, s]) => (useMods || id.startsWith('core:')) && !s.special && s.type !== 'ability')
		.map(([id]) => id);
	let spelledTowns = 0;
	for (const o of objects)
		if (o.type === 'town' || o.type === 'randomTown') {
			o.options = { ...(o.options || {}), possibleSpells: townSpells };
			spelledTowns++;
		}
	if (spelledTowns)
		console.error(`[gen] town spells: ${townSpells.length} possible in each of ${spelledTowns} towns`);

	// instanceName is the map's global object key, and a repeat is fatal:
	// CMap::addNewObject throws "Object instance name duplicated" (CMap.cpp:569)
	// and the map never loads. objectEntry builds the name from type and
	// anchor, which is not unique - two deadVegetation templates with
	// different masks may legally share an anchor, because their blocking
	// cells do not overlap and vmap_overlap is right to pass them. 36x36 seed
	// 4242 produces exactly that pair, and the only reason the sweep never saw
	// it is that the seed is not in the sweep.
	//
	// Only the later collider is renamed, so every name an options.sameAsTown
	// link already points at keeps pointing at the same object.
	const usedNames = new Set();
	let renamedObjects = 0;
	for (const o of objects) {
		if (!usedNames.has(o.instanceName)) { usedNames.add(o.instanceName); continue; }
		let n = 2, candidate;
		do { candidate = `${o.instanceName}_${n++}`; } while (usedNames.has(candidate));
		o.instanceName = candidate;
		usedNames.add(candidate);
		renamedObjects++;
	}
	if (renamedObjects)
		console.error(`[gen] ${renamedObjects} duplicate instance name(s) made unique`);

	// Tile codes: "<shortId><view><flip>" + optional road "<road><dir><flip>".
	//
	// Both indices come from the engine's own pattern tables rather than being
	// guessed. The terrain view decides whether a tile draws as plain ground or
	// as the correct edge against its neighbours, and writing a fixed low index
	// the way this used to drew every tile of every map as a border fragment.
	// The road segment index is the same idea for roads.
	//
	// Cobblestone road: measured over 30 corpus maps the road on a real surface
	// is almost always cobblestone (pc), and it costs 50 movement a tile
	// against 100 for open ground, where dirt road (pd) costs 75.
	const roadCode = params.roadShortId || 'pc';
	const viewPatterns = loadTerrainViewPatterns(roots.installDir);
	const terrainProps = new Map();
	for (const [shortId, t] of assetIndex.terrains)
		terrainProps.set(shortId, {
			id: t.name,
			group: t.viewGroup || 'normal',
			transitionRequired: !!t.transitionRequired,
			passable: (t.moveCost || 0) > 0,
			isDirt: t.identifier === 'dirt',
			isSand: t.identifier === 'sand',
			// the watercourse this ground carries, as a 2-char code
			riverCode: assetIndex.rivers.get(t.river) || null,
		});
	const FALLBACK_TERRAIN = { id: '?', group: 'normal', transitionRequired: false,
		passable: true, isDirt: false, isSand: false };
	// the impassable filler an underground level is carved out of
	let rockShortId = null, waterShortId = null;
	for (const [shortId, t] of assetIndex.terrains) {
		if (t.identifier === 'rock' && String(t.name || '').startsWith('core:'))
			rockShortId = shortId;
		if (t.identifier === 'water' && String(t.name || '').startsWith('core:'))
			waterShortId = shortId;
	}
	if (waterPlan && !waterShortId)
		throw new Error('water was asked for but the install has no core water terrain');

	const tilesByLevel = {};
	for (let li = 0; li < levels.length; li++) {
		const lv = levels[li];
		const grid = levelGrids[li];
		const roadCells = plans[li].roadCells;
		const openMask = plans[li].openMask;
		const roadRng = xorshift((params.seed || 1) + 4242 + li);
		const roadArt = solveRoadTiles(roadCells, lv.width, lv.height, roadRng);

		// the terrain grid as short codes, which smoothing may adjust
		const shorts = [];
		for (let i = 0; i < lv.width * lv.height; i++) {
			const t = tiles[grid[i]] || tiles[0];
			shorts.push(t ? t.shortId : '??');
		}
		// Solid rock around the carved chambers of an underground level. The
		// planner already marked those cells occupied so nothing was placed on
		// them; this is the ground they stand on. Rock is excluded from the
		// tile dictionary on purpose, so it is written in directly here rather
		// than being something the solver could pick by accident.
		if (openMask && rockShortId) {
			let n = 0;
			for (let i = 0; i < lv.width * lv.height; i++)
				if (!openMask[i]) { shorts[i] = rockShortId; n++; }
			console.error(`[gen] level ${li}: ${n} tiles of solid rock`);
		}
		// Surface water, painted the same way: the planner kept it occupied,
		// and the view patterns draw the shore on the water tiles.
		const water = li === 0 && waterPlan ? waterPlan.mask : null;
		if (water)
			for (let i = 0; i < lv.width * lv.height; i++)
				if (water[i]) shorts[i] = waterShortId;
		const terrainOf = code => terrainProps.get(code) || FALLBACK_TERRAIN;
		// the rock an underground level is carved out of is structure, not art:
		// the planner verified the cave against it and smoothing must not move
		// it. Water is structure too: the zones were partitioned around it.
		const frozen = openMask || water
			? (c => (openMask && !openMask[c]) || !!(water && water[c])) : null;
		// the transition terrains this layer allows, for smoothing's last pass
		const layer = li === 0 ? 'surface' : 'underground';
		const extras = [...terrainProps.keys()].filter(k => {
			const t = assetIndex.terrains.get(k);
			return (terrainProps.get(k).isDirt || terrainProps.get(k).isSand)
				&& String(t.name || '').startsWith('core:')
				&& (t.allowedLayers || []).includes(layer);
		});
		const moved = smoothForPatterns(lv.width, lv.height, shorts, terrainOf,
			viewPatterns, 6, frozen, extras);
		const terrainAt = (x, y) => terrainOf(shorts[y * lv.width + x]);
		const viewRng = xorshift((params.seed || 1) + 8484 + li);
		const art = assignTerrainViews(lv.width, lv.height, terrainAt,
			viewPatterns, viewRng);
		if (moved || art.unmatched)
			console.error(`[gen] level ${li}: ${moved} tile(s) of terrain smoothed `
				+ `so an edge pattern fits, ${art.unmatched} still unmatched`);
		// VMAPGEN_VIEW_TRACE: the unmatched tiles' neighbourhoods, grouped. Each
		// row is the centre's view group, then the 3x3 around it: o the same
		// terrain, # off the map, else the first letter of the other group.
		if (process.env.VMAPGEN_VIEW_TRACE && art.unmatched) {
			const hist = new Map();
			for (let c = 0; c < lv.width * lv.height; c++) {
				if (!art.unmatchedCells[c]) continue;
				const x = c % lv.width, y = (c / lv.width) | 0;
				let key = terrainOf(shorts[c]).group + ' ';
				for (let dy = -1; dy <= 1; dy++) {
					for (let dx = -1; dx <= 1; dx++) {
						const nx = x + dx, ny = y + dy;
						key += (nx < 0 || ny < 0 || nx >= lv.width || ny >= lv.height) ? '#'
							: shorts[ny * lv.width + nx] === shorts[c] ? 'o'
								: terrainOf(shorts[ny * lv.width + nx]).group[0];
					}
					key += dy < 1 ? '/' : '';
				}
				hist.set(key, (hist.get(key) || 0) + 1);
			}
			console.error([...hist].sort((a, b) => b[1] - a[1]).slice(0, 40)
				.map(([k, n]) => `[view] ${n} ${k}`).join('\n'));
		}
		const shortAt = (x, y) => shorts[y * lv.width + x];
		// every terrain that made it onto the grid is content the map uses;
		// the scope prefix on its indexed name is the mod to declare
		if (useMods)
			for (const code of shorts) {
				const id = terrainOf(code).id;
				const colon = String(id).indexOf(':');
				if (colon > 0) {
					const scope = id.slice(0, colon);
					if (scope !== 'core') usedMods.add(scope);
				}
			}

		// Rivers. They neither block nor cost movement, so unlike roads they can
		// run under anything, and the type comes from the ground each tile
		// stands on, which is why a real river changes colour as it crosses a
		// biome edge.
		const riverRng = xorshift((params.seed || 1) + 1717 + li);
		let riverCells = params.rivers === false ? new Set()
			: buildRiverNetwork(lv.width, lv.height, riverRng,
				params.riverShare !== undefined ? params.riverShare : 0.018);
		// a river through solid rock is not a river. Underground, keep the
		// water inside the carved chambers and tunnels.
		if (openMask)
			riverCells = new Set([...riverCells].filter(c => openMask[c]));
		// a river runs into the water and stops there
		if (water)
			riverCells = new Set([...riverCells].filter(c => !water[c]));
		const riverArt = solveRiverTiles(riverCells, lv.width, lv.height, riverRng);
		if (riverCells.size)
			console.error(`[gen] level ${li}: ${riverCells.size} river tiles `
				+ `(${(riverCells.size / (lv.width * lv.height) * 100).toFixed(1)}%)`);

		const rows = [];
		for (let y = 0; y < lv.height; y++) {
			const row = [];
			for (let x = 0; x < lv.width; x++) {
				const cell = y * lv.width + x;
				let code = `${shortAt(x, y)}${art.views[cell]}${FLIP_CODES[art.flips[cell]]}`;
				const r = roadArt.get(cell);
				if (r) code += `${roadCode}${r.dir}${FLIP_CODES[r.flip]}`;
				const w = riverArt.get(cell);
				const wCode = w && terrainOf(shortAt(x, y)).riverCode;
				if (wCode) code += `${wCode}${w.dir}${FLIP_CODES[w.flip]}`;
				row.push(code);
			}
			rows.push(row);
		}
		tilesByLevel[lv.name] = rows;
	}

	// The faction allow-list is content too: a modded faction a player can
	// roll at game start needs its mod present on load, so declare its scope.
	if (useMods)
		for (const f of allFactions) {
			const scope = String(f).split(':')[0];
			if (scope && scope !== 'core') usedMods.add(scope);
		}
	const declaredMods = useMods
		? ordered.filter(m => usedMods.has(m.__id)) : [];
	if (useMods)
		console.error(`[gen] declaring ${declaredMods.length} mod(s) the map `
			+ `actually uses: ${declaredMods.map(m => m.__id).join(', ') || 'none'}`);

	// The allow-lists the engine's own generator writes (CMapGenerator.cpp:
	// 483-499): everything allowed by default, less what CMap::banWaterContent
	// takes off a map without water (spells, artifacts, secondary skills and
	// heroes marked onlyOnWaterMap), less the template's banned lists, plus its
	// enabled ones. Ours named no lists until 2026-09-26, so the loader allowed
	// all of it: on a map with no sea a mage guild could offer Summon Boat,
	// Scuttle Boat or Water Walk, which no land map in the corpus does. The
	// engine decides water by the map's water setting, ours by the tiles, with
	// the rule the engine applies to H3M maps (CMap::calculateWaterContent: at
	// least 1% of all tiles). Written as {noneOf, allOf}: the loader starts from
	// its own default list, takes the first off and adds the second
	// (JsonDeserializer::serializeLIC). A map without mods names only core's.
	let waterTiles = 0, allTiles = 0;
	for (const rows of Object.values(tilesByLevel))
		for (const row of rows)
			for (const code of row) {
				allTiles++;
				const t = assetIndex.terrains.get(code.slice(0, 2));
				if (t && (t.types || []).includes('WATER')) waterTiles++;
			}
	const waterMap = waterTiles >= Math.floor(allTiles / 100);
	const listTpl = params.template ? loadTemplate(params.template).raw : null;
	const allowLists = {}, bannedCounts = [];
	const bareId = id => String(id).replace(/^core:/, '');
	for (const [field, kind, tplKey] of [['allowedSpells', 'spells', 'Spells'],
		['allowedArtifacts', 'artifacts', 'Artifacts'], ['allowedAbilities', 'skills', 'Skills'],
		['allowedHeroes', 'heroes', 'Heroes']]) {
		const enabled = (listTpl && listTpl[`enabled${tplKey}`]) || [];
		const on = new Set(enabled.map(bareId));
		const none = waterMap ? [] : [...(assetIndex[kind] || [])]
			.filter(([id, v]) => v.waterOnly && (useMods || id.startsWith('core:'))).map(([id]) => id);
		none.push(...((listTpl && listTpl[`banned${tplKey}`]) || []));
		const noneOf = [...new Set(none)].filter(id => !on.has(bareId(id)));
		if (noneOf.length || enabled.length)
			allowLists[field] = { ...(noneOf.length ? { noneOf } : {}), ...(enabled.length ? { allOf: [...enabled] } : {}) };
		bannedCounts.push(`${kind} ${noneOf.length}`);
	}
	console.error(`[gen] allow-lists: ${waterMap ? 'a water map' : 'no water'} (${waterTiles} of ${allTiles} tiles), `
		+ `banned ${bannedCounts.join(', ')}`);

	const header = makeHeader({
		width: params.mapW, height: params.mapH,
		players, levels,
		modIds: declaredMods,
		declareMods: params.declareMods === true,
		difficulty: params.difficulty || 'NORMAL',
		name: params.name || 'OmniGen',
		allFactions,
		teams: params.teams || null,
		allowed: allowLists,
	});

	const vmapBuf = serializeVmap({ header, tilesByLevel, objects });
	fs.mkdirSync(path.dirname(path.resolve(params.outFile)), { recursive: true });
	fs.writeFileSync(params.outFile, vmapBuf);
	// Optional zone sidecar for analysis tools: the zone partition and class
	// assignment never reach the .vmap, so value-vs-zone-distance metrics
	// (vmap_zonevalue.js) cannot compute them after the fact. Written only
	// when asked; the map file itself is unchanged.
	if (process.env.VMAPGEN_ZONE_DUMP) {
		fs.writeFileSync(params.outFile + '.zones.json', JSON.stringify({
			levels: plans.map(pl => ({
				zone: Array.from(pl.zone),
				classes: Array.from(pl.classes),
				starts: (pl.playerStarts || []).map(s => ({ x: s.x, y: s.y })),
			})),
		}));
	}
	return { outFile: params.outFile, L, stitchWidth, mods: ordered.length,
		tiles: tiles.length, objects: objects.length, levels: levels.length,
		biomes: plans.map(pl => pl.classes.length) };
}

module.exports = { generateMap, buildDictionary, buildAdjacency, solveChunked };
