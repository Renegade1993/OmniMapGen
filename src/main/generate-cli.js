/**
 * generate-cli.js - headless entry: node src/main/generate-cli.js --w 64 --h 64 --out map.vmap
 */
'use strict';

const { generateMap } = require('./generate');
const { listTemplates } = require('../rmg/template');
const { themeNames } = require('../biome/guardCreatures');

const KNOWN = new Set(['w', 'h', 'players', 'out', 'seed', 'threads', 'perode',
	'density', 'difficulty', 'underground', 'fixedfactions', 'name', 'road',
	'nocache', 'declaremods', 'rivers', 'rivershare', 'teams',
	'template', 'accommodate', 'listtemplates', 'humans', 'render', 'observer',
	'aionly', 'preset', 'listknobs', 'vcmiroot', 'vcmiuserdir', 'guardtheme',
	'guardthemeshare', 'theme', 'dwellingthemeshare', 'bankthemeshare']);

/**
 * Parse `--key value` pairs, and refuse anything else.
 *
 * `-w 36` used to be accepted silently: the key came out as `-w`, nothing ever
 * read it, and the map arrived at the default 64x64 with no complaint. That
 * cost a session once and is written up in the handoff as a trap. A trap that
 * can be made impossible should be.
 */
function parseArgs(args) {
	const opt = {};
	for (let i = 0; i < args.length; i += 2) {
		const raw = args[i];
		if (!raw.startsWith('--'))
			fail(`options need two dashes: got "${raw}"`);
		// biome knob names are camelCase and have to survive verbatim
		const name = raw.slice(2);
		const key = name.startsWith('bio.') ? name : name.toLowerCase();
		if (i + 1 >= args.length)
			fail(`"${raw}" has no value`);
		if (!KNOWN.has(key) && !key.startsWith('bio.'))
			fail(`unknown option "${raw}"`);
		opt[key] = args[i + 1];
	}
	return opt;
}

function fail(msg) {
	console.error(`generate-cli: ${msg}`);
	console.error('usage: node src/main/generate-cli.js --w 36 --h 36 --players 2 '
		+ '--out map.vmap --seed 42 [--underground 1] [--bio.<knob> <float>]');
	console.error('       --template <rmg preset name|file> [--accommodate size,players,humans,underground]');
	console.error('       --listtemplates 1 prints the presets the install offers');
	console.error('       --observer <color|1> seals that player underground and '
		+ 'makes every other slot AI-only (1 means red)');
	console.error('       --aionly 1 makes every slot AI-only, so the engine '
		+ 'turns its own spectator view on');
	console.error('       --vcmiroot <VCMI folder> --vcmiuserdir <VCMI user folder> '
		+ '(or VCMI_ROOT / VCMI_USER_DIR): nothing is guessed');
	console.error('       --theme <' + themeNames().join('|') + '> [--guardthemeshare 0..1] '
		+ '[--dwellingthemeshare 0..1] [--bankthemeshare 0..1] makes that share of the guards '
		+ '(default all), dwellings (half) and banks (0.3) one family\'s (--guardtheme: the same)');
	console.error('options: --' + [...KNOWN].join(' --') + ' --bio.<knob>');
	process.exit(2);
}

const opt = parseArgs(process.argv.slice(2));

// Where VCMI lives, named by the caller: the MapGen tab passes its own
// client's folder and user folder. These win over VCMI_ROOT and
// VCMI_USER_DIR, and everything downstream (templates, mods, object configs)
// reads them through locateVcmiRoots, which never guesses.
if (opt.vcmiroot) process.env.VCMI_ROOT = opt.vcmiroot;
if (opt.vcmiuserdir) process.env.VCMI_USER_DIR = opt.vcmiuserdir;

// Generator levers: a named preset first (default 'nostalgia', which is the
// calibrated defaults and moves nothing), then --bio.<key> <float> on top,
// e.g. --bio.interconnectivity 0.8 --bio.borderSolidity 0.35.
const PRESETS = require('../biome/presets.json');
const presetName = String(opt.preset || 'nostalgia').toLowerCase();
if (!PRESETS[presetName] || presetName.startsWith('_'))
	fail(`unknown preset "${opt.preset}"; presets: `
		+ Object.keys(PRESETS).filter(k => !k.startsWith('_')).join(', '));
const biomes = { ...PRESETS[presetName].values };
const { KNOBS } = require('../biome/knobs');
const KNOB_KEYS = new Set(KNOBS.filter(k => !k.cli).map(k => k.key));
for (const [k, v] of Object.entries(opt)) {
	if (!k.startsWith('bio.')) continue;
	const key = k.slice(4), val = parseFloat(v);
	if (!Number.isFinite(val)) fail(`--${k} needs a number, got "${v}"`);
	// unknown names still pass (older internal knobs), but say so: a typo
	// used to be silently ignored
	if (!KNOB_KEYS.has(key))
		console.error(`generate-cli: note: --bio.${key} is not in the knob list (src/biome/knobs.js)`);
	biomes[key] = val;
}

// --theme <name> themes guards and dwellings (--guardtheme is the older name)
const themeArg = opt.theme || opt.guardtheme;
const guardTheme = themeArg ? String(themeArg).toLowerCase() : null;
if (guardTheme && !themeNames().includes(guardTheme))
	fail(`unknown theme "${themeArg}"; themes: ${themeNames().join(', ')}`);
const share01 = (name, def) => {
	const v = opt[name] !== undefined ? parseFloat(opt[name]) : def;
	if (!(v >= 0 && v <= 1)) fail(`--${name} needs a number from 0 to 1, got "${opt[name]}"`);
	return v;
};
const guardThemeShare = share01('guardthemeshare', 1);
const dwellingThemeShare = share01('dwellingthemeshare', 0.5);
const bankThemeShare = share01('bankthemeshare', 0.3);

const COLORS = ['red', 'blue', 'tan', 'green', 'orange', 'purple', 'teal', 'pink'];

async function main() {
	if (opt.listtemplates) {
		console.log(listTemplates().join('\n'));
		return;
	}
	// --listknobs 1: the lever list as JSON (pages, knobs with defaults and
	// ranges, presets), for the in-game UI build and anything else that
	// needs the one true set of defaults
	if (opt.listknobs) {
		const { PAGES } = require('../biome/knobs');
		const presets = Object.fromEntries(Object.entries(PRESETS).filter(([k]) => !k.startsWith('_')));
		console.log(JSON.stringify({ pages: PAGES, knobs: KNOBS, presets }, null, 1));
		return;
	}
	const W = parseInt(opt.w || '64', 10);
	const H = parseInt(opt.h || '64', 10);
	const nPlayers = Math.min(parseInt(opt.players || '2', 10), 8);
	// Player towns pinned to quadrant corners for now.
	const corners = [[4,4],[W-5,H-5],[4,H-5],[W-5,4],[4,(H/2)|0],[W-5,(H/2)|0],[(W/2)|0,4],[(W/2)|0,H-5]];
	// --observer red (or --observer 1, which means red, the conventional human
	// colour). The observer's town is placed underground by the generator, so
	// it takes no surface corner: the corners go to the CONTESTANTS in order,
	// which is what keeps two of them on OPPOSITE corners instead of adjacent
	// ones just because a lower-numbered colour was sequestered.
	const observerColor = !opt.observer ? null
		: (opt.observer === '1' || opt.observer === 'true')
			? COLORS[0] : String(opt.observer).toLowerCase();
	if (observerColor && !COLORS.slice(0, nPlayers).includes(observerColor))
		fail(`--observer ${opt.observer}: this map's colours are `
			+ COLORS.slice(0, nPlayers).join(', '));
	let corner = 0;
	const players = COLORS.slice(0, nPlayers).map((c, i) => {
		const faction = 'core:' + ['castle','rampart','tower','inferno',
			'necropolis','dungeon','stronghold','fortress'][i];
		if (c === observerColor)
			// a placeholder; generateMap overwrites it with the chamber anchor
			return { color: c, factions: [faction], townPos: { x: 0, y: 0, l: 1 } };
		const [cx, cy] = corners[corner++];
		return { color: c, factions: [faction], townPos: { x: cx, y: cy, l: 0 } };
	});

	const res = await generateMap({
		mapW: W, mapH: H,
		players,
		outFile: opt.out || 'out.vmap',
		seed: parseInt(opt.seed || '1', 10),
		threads: parseInt(opt.threads || '0', 10) || undefined,
		pErode: opt.perode ? parseFloat(opt.perode) : 0.25,
		density: opt.density ? parseFloat(opt.density) : 0.5,
		difficulty: opt.difficulty || 'NORMAL',
		underground: opt.underground === '1' || opt.underground === 'true',
		factionAgnostic: opt.fixedfactions !== '1',
		// The VCMI scenario browser lists the header name, so every map
		// generated as 'OmniGen' shows as one identical entry. Default to
		// the output file's stem; --name still overrides.
		name: opt.name
			|| require('path').parse(opt.out || 'out.vmap').name,
		roadShortId: opt.road || 'pc',
		noCache: opt.nocache === '1' || opt.nocache === 'true',
		rivers: !(opt.rivers === '0' || opt.rivers === 'false'),
		riverShare: opt.rivershare ? parseFloat(opt.rivershare) : undefined,
		// header.mods records what a map REQUIRES, and the game refuses to
		// load a map whose requirements are missing, so this does make a map
		// unopenable by anyone whose mod set differs - correct behavior for a
		// map that actually uses that content, same as any other requirement.
		// Defaults on (queue: fidelity lens, 2026-09-25 - banks read 0.49x
		// corpus with this off, because the corpus is heavily HotA-mixed and
		// declareMods:false silently excludes every mod-sourced creature bank
		// regardless of what's actually installed): --declaremods 0 opts back
		// out for a map meant to be portable to an unknown install.
		declareMods: !(opt.declaremods === '0' || opt.declaremods === 'false'),
		biomes,
		template: opt.template,
		accommodate: opt.accommodate
			? opt.accommodate.split(',').map(s => s.trim().toLowerCase())
			: [],
		humans: opt.humans ? parseInt(opt.humans, 10) : undefined,
		// --observer 1: the LAST player slot is sealed in an underground
		// chamber with no way in or out, the rest become AI-only contestants.
		observerColor,
		// --aionly 1: every slot AIOnly, so no human can take one and VCMI
		// switches its own spectator interface on.
		aiOnly: opt.aionly === '1' || opt.aionly === 'true',
		// --teams "red,tan;blue,green" -> [["red","tan"],["blue","green"]]
		teams: opt.teams
			? opt.teams.split(';').map(g => g.split(',').map(s => s.trim()))
			: undefined,
		guardTheme,
		guardThemeShare,
		dwellingThemeShare,
		bankThemeShare,
	});
	console.log('generated:', JSON.stringify(res));
	if (opt.render) {
		const { renderVmap } = require('../preview/render');
		require('fs').writeFileSync(opt.render, renderVmap(res.outFile));
		console.log('rendered:', opt.render);
	}
	process.exit(0); // workers may linger on stdio flush; CLI is done
}

main().catch(e => { console.error(e); process.exit(1); });
