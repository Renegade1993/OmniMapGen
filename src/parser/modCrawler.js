/**
 * modCrawler.js
 *
 * Locates VCMI data roots, crawls mod directories, parses mod.json manifests,
 * topologically sorts the dependency graph, and yields the ordered active-mod
 * list. Handles hard dependencies (required), soft dependencies (load-after
 * ordering only), and conflicts (exclude).
 */
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * The VCMI install and user-data folders, exactly as the caller names them:
 * explicit arguments first, then VCMI_ROOT and VCMI_USER_DIR (generate-cli
 * sets both from --vcmiroot and --vcmiuserdir, which the MapGen tab passes
 * for its own client). Nothing is ever guessed. This used to walk a fixed
 * list of common install and Documents folders whenever VCMI_ROOT was unset,
 * so any run that forgot it read whichever real install came first, and on
 * the dev machine the first one was the owner's own, off-limits install
 * (2026-09-25).
 *
 * A named install must also be one whose client runs map generators
 * (isMapGenInstall), so a stock VCMI install is refused even when named
 * outright. A named folder that fails a check throws: a
 * mistake stops the run instead of quietly reading somewhere else. Anything
 * not named stays null.
 */
function locateVcmiRoots(explicit = {}) {
	const installDir = explicit.installDir || process.env.VCMI_ROOT || null;
	const userDir = explicit.userDir || process.env.VCMI_USER_DIR || null;
	if (installDir && !safeIsDir(installDir))
		throw new Error(`VCMI install "${installDir}" is not a folder`);
	if (installDir && !isMapGenInstall(installDir))
		throw new Error(`"${installDir}" is not a VCMI install with the MapGen tab `
			+ '(no map generator framework in config/schemas/mod.json, no config/widgets/mapGen); '
			+ 'the generator only reads the install it runs in');
	if (userDir && !safeIsDir(userDir))
		throw new Error(`VCMI user folder "${userDir}" is not a folder`);
	return { installDir, userDir };
}

/**
 * A VCMI install whose client runs map generators: its mod schema knows the
 * map generator framework's "mapGenerator" key (config/schemas/mod.json, DMB
 * once the MapGen tab became a mod, 2026-09-26), or it still carries the tab's
 * own widget configs from before that. A stock VCMI install has neither.
 */
function isMapGenInstall(dir) {
	if (safeIsDir(path.join(dir, 'config', 'widgets', 'mapGen'))) return true;
	try {
		return /"mapGenerator"\s*:/.test(fs.readFileSync(path.join(dir, 'config', 'schemas', 'mod.json'), 'utf8'));
	} catch {
		return false;
	}
}

function safeIsDir(p) {
	try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/**
 * Read a single mod.json. Returns null when absent or unparseable.
 *
 * Parsed the way VCMI parses it, comments and trailing commas allowed. A
 * strict JSON.parse used to drop 9 of the 155 manifests on this install,
 * silently, and with them 6 mods the engine loads: Tides of War and its
 * alternative creatures, HotA's template and map-support submods, and two
 * newtown terrains (2026-09-25).
 */
function readManifest(modDir) {
	const file = path.join(modDir, 'mod.json');
	try {
		const raw = fs.readFileSync(file, 'utf8');
		// required here, not at the top: assetIndex requires this module
		const { stripJsonComments, dropTrailingCommas } = require('./assetIndex');
		const manifest = JSON.parse(dropTrailingCommas(stripJsonComments(raw)));
		manifest.__dir = modDir;
		manifest.__id = path.basename(modDir).toLowerCase();
		return manifest;
	} catch {
		return null;
	}
}

/**
 * Crawl every Mods directory under the known roots.
 * Returns Map<modId, manifest>.
 */
function crawlMods(roots) {
	const mods = new Map();
	const modRoots = [];
	if (roots.installDir) {
		modRoots.push(path.join(roots.installDir, 'Mods'));
	}
	if (roots.userDir) {
		modRoots.push(path.join(roots.userDir, 'Mods'));
	}
	for (const root of modRoots) {
		if (!safeIsDir(root)) continue;
		for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const dir = path.join(root, entry.name);
			const manifest = readManifest(dir);
			if (!manifest) continue;
			mods.set(manifest.__id, manifest);
			crawlSubmods(dir, manifest.__id, mods);
		}
	}
	return mods;
}

/**
 * Submods nest under <mod>/mods/<submod>, to any depth, and each one's id is
 * its parent's plus its own folder name: hota.gamebalance.objects.rmgtweak
 * (ModsState::ModsState walks MODS/<id with dots as /MODS/>/MODS/). Only one
 * level used to be read, which lost every HotA balance submod below
 * gamebalance: its RMG ban list, the Imp Cache's value, the banned artifacts
 * (2026-09-26). A folder without a mod.json ends the walk, as in the engine.
 */
function crawlSubmods(dir, parentId, mods) {
	// lowercase on most installs; check both spellings
	for (const nestedName of ['mods', 'Mods']) {
		const nested = path.join(dir, nestedName);
		if (!safeIsDir(nested)) continue;
		for (const sub of fs.readdirSync(nested, { withFileTypes: true })) {
			if (!sub.isDirectory()) continue;
			const subDir = path.join(nested, sub.name);
			const subManifest = readManifest(subDir);
			if (!subManifest) continue;
			subManifest.__id = `${parentId}.${sub.name.toLowerCase()}`;
			subManifest.__parent = parentId;
			if (mods.has(subManifest.__id)) continue;
			mods.set(subManifest.__id, subManifest);
			crawlSubmods(subDir, subManifest.__id, mods);
		}
	}
}

/**
 * Load modSettings.json activation state. Real format:
 *   { activePreset: "<name>", presets: { name: { mods: [topLevelIds],
 *         settings: { parentId: { submodPath: bool } } } } }
 * Top-level ids come from the preset's mods array. A submod "root.a.b" is
 * wanted by its own flag, settings[root]["a.b"], as ModsPresetState::
 * getActiveMods reads it; one the preset does not list is on unless its
 * mod.json says keepDisabled (ModManager::addNewModsToPreset), and a
 * "Compatibility" submod is tried even when switched off (ModManager.cpp,
 * "Try to enable all existing compatibility patches"). Its parents are
 * dependencies (ModDescription.cpp:58-63), which resolveLoadOrder enforces.
 * Returns a predicate isActive(id, manifest); null when the file is missing.
 */
function loadActivationState(userDir) {
	if (!userDir) return null;
	const file = path.join(userDir, 'config', 'modSettings.json');
	let settings;
	try {
		settings = JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return null;
	}
	const presetName = settings.activePreset;
	const preset = presetName && settings.presets ? settings.presets[presetName] : null;
	if (!preset) {
		// fall back to the first preset, else treat everything as active
		const names = settings.presets ? Object.keys(settings.presets) : [];
		if (!names.length) return null;
		return buildPredicate(settings.presets[names[0]]);
	}
	return buildPredicate(preset);
}

function buildPredicate(preset) {
	const topLevel = new Set((preset.mods || []).map(s => String(s).toLowerCase()));
	// settings[root] is flat, keyed by the full path under the root ("a.b")
	const subFlags = new Map();
	for (const [root, flags] of Object.entries(preset.settings || {}))
		subFlags.set(root.toLowerCase(), new Map(Object.entries(flags || {})
			.map(([k, v]) => [k.toLowerCase(), v])));
	return function isActive(id, manifest) {
		id = String(id).toLowerCase();
		if (id === 'core' || id === 'vcmi') return true;
		const dot = id.indexOf('.');
		if (dot < 0) return topLevel.has(id);
		const root = id.slice(0, dot);
		if (!topLevel.has(root)) return false;
		const flags = subFlags.get(root) || new Map();
		const rest = id.slice(dot + 1);
		const m = manifest || {};
		if (flags.has(rest) ? flags.get(rest) !== false : !m.keepDisabled) return true;
		return m.modType === 'Compatibility';
	};
}

function depId(ref) {
	// vcmi dependency entries may be plain ids or "id@version"
	return String(ref).split('@')[0].trim().toLowerCase();
}

/**
 * Build the dependency graph and return mods in valid load order.
 * - hard deps (depends): must exist and be active; missing hard dep drops the
 *   mod and everything depending on it
 * - soft deps (softDepends / recommended): ordering hint only
 * - conflicts: an active conflicting mod drops this mod
 */
function resolveLoadOrder(mods, isActive) {
	if (!isActive) isActive = () => true; // no settings file: everything active

	// Filter 1: drop inactive and hard-dependency-broken mods
	const usable = new Map();
	let changed = true;
	for (const [id, m] of mods) if (isActive(id, m)) usable.set(id, m);
	while (changed) {
		changed = false;
		for (const [id, m] of usable) {
			// a submod depends on its parent and top parent (ModDescription.cpp:58-63)
			const parents = [];
			for (let d = id.lastIndexOf('.'); d > 0; d = id.lastIndexOf('.', d - 1))
				parents.push(id.slice(0, d));
			const hardDeps = [...(m.depends || []).map(depId), ...parents];
			const conflicts = (m.conflicts || []).map(depId);
			const missingHard = hardDeps.filter(d => !usable.has(d));
			const hitConflict = conflicts.filter(c => usable.has(c));
			if (missingHard.length || hitConflict.length) {
				usable.delete(id);
				changed = true;
			}
		}
	}

	// Filter 2: topological sort (Kahn). Hard deps order strictly; soft deps
	// order only when both endpoints are present.
	const edges = new Map();   // id -> Set<id> it must come after
	const indegree = new Map();
	for (const id of usable.keys()) { edges.set(id, new Set()); indegree.set(id, 0); }
	for (const [id, m] of usable) {
		// a submod loads after its parent and top parent, which the engine
		// adds to its dependencies (ModDescription.cpp:58-63)
		const dot = id.indexOf('.'), last = id.lastIndexOf('.');
		const parents = dot > 0 ? [id.slice(0, last), id.slice(0, dot)] : [];
		const deps = [...(m.depends || []), ...(m.softDepends || m.recommended || []), ...parents].map(depId);
		for (const d of deps) {
			if (!usable.has(d) || d === id) continue;
			if (!edges.get(id).has(d)) {
				edges.get(id).add(d);
				indegree.set(d, 0); // ensure present
			}
		}
	}
	// recompute indegree correctly: edge d -> id
	const out = new Map();
	for (const id of usable.keys()) out.set(id, []);
	for (const [id, deps] of edges) for (const d of deps) out.get(d).push(id);
	const deg = new Map([...usable.keys()].map(id => [id, 0]));
	for (const [id, deps] of edges) deg.set(id, deg.get(id) + deps.size);

	const queue = [...deg.entries()].filter(([, d]) => d === 0).map(([id]) => id).sort();
	const order = [];
	while (queue.length) {
		const id = queue.shift();
		order.push(usable.get(id));
		for (const next of out.get(id)) {
			deg.set(next, deg.get(next) - 1);
			if (deg.get(next) === 0) {
				queue.push(next);
				queue.sort();
			}
		}
	}
	return order; // array of manifests in dependency order
}

module.exports = { locateVcmiRoots, isMapGenInstall, crawlMods, resolveLoadOrder, loadActivationState, safeIsDir };
