'use strict';
/**
 * lever_test.js - a measured effect for every lever (K 2026-10-11 16:10: "every one of those levers has a verified, measured effect on map generation").
 *
 *   node tools/harness/lever_test.js --tip DIR --out DIR [--levers key,key|page:treasure|all] [--layouts free,tpl,ug,tplug] [--seeds 3] [--lanes 3]
 *                                    [--deadline-min 60] [--eval]      (--eval: measure the maps already in --out, generate nothing)
 *
 * One lever moves at a time, over its range (the stops of a notched lever, else the minimum, the default and the maximum), on fixed seeds and four fixed
 * configurations: free = open layout 72x72 four players; tpl = Coldshadow's Fantasy 108x108 four players; ug = free layout with an underground; tplug = the
 * template with an underground. Every map gets a vector of named measures (below); SPEC names the measures a lever is meant to move and which way. Verdicts, per
 * lever and layout, on the seed means: OK (moves the named measure the intended way by 10% or more), WEAK (3 to 10%), NO EFFECT (under 3% on every named
 * measure), WRONG (against the intent by 5% or more), plus "side effects": other measures that moved by 25% or more. The generator is run exactly as the game
 * runs it (generate-cli.js with --bio.<key>), nothing else is changed.
 *
 * Results: OUT/lever_results.json (every value) and OUT/LEVER-TEST.md (the tables). Maps stay in OUT/<layout>/ for pictures. Resumable: a map that exists is kept.
 */
const fs = require('fs'), path = require('path');
const { execFile } = require('child_process');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const has = n => process.argv.includes(n);
// a VMAPGEN_* switch set in the shell would change what the generator makes (297 are read in src): the children run without them, and the run says which it found
const STRIPPED = Object.keys(process.env).filter(k => /^VMAPGEN_/.test(k) && k !== 'VMAPGEN_TEST_ROOT');
console.log('environment: ' + (STRIPPED.length ? 'VMAPGEN_* found and removed from the generator runs: ' + STRIPPED.join(', ') : 'no VMAPGEN_* switch set'));
const TIP = path.resolve(arg('--tip', path.join(__dirname, '..', '..')));
const OUT = path.resolve(arg('--out', path.join(TIP, '.tmp', 'lever_test')));
const SEEDS = +arg('--seeds', 3), LANES = +arg('--lanes', 3), DEADLINE = Date.now() + 60000 * +arg('--deadline-min', 60);
const ROOT = process.env.VMAPGEN_TEST_ROOT || 'C:/AI Projects/Heroes 3/VCMI/dmbtest';
const K_USER = process.env.DMB_USER_DIR || path.join(require('os').homedir(), 'Documents', 'My Games', "Dead Man's Boots");
const NODE_MODULES = process.env.NODE_PATH || 'C:/AI Projects/Heroes 3/VCMIMapGen/node_modules';
process.env.VCMI_ROOT = process.env.VCMI_ROOT || ROOT;
const sight = require('../mapsight/lib/sight');
const { KNOBS } = require(path.join(TIP, 'src/biome/knobs'));
const { BIOME_DEFAULTS } = require(path.join(TIP, 'src/biome/biomes'));

const LAYOUTS = {
	free: { w: 72, h: 72, players: 4, humans: 1 },
	tpl: { w: 108, h: 108, players: 4, humans: 1, template: "Coldshadow's Fantasy" },
	ug: { w: 72, h: 72, players: 4, humans: 1, underground: 1 },
	tplug: { w: 108, h: 108, players: 4, humans: 1, template: "Coldshadow's Fantasy", underground: 1 },
};
const WATER = { 'bio.waterCoverage': 0.3, 'bio.waterContent': 1, 'bio.waterShape': 3 };

// ---------------------------------------------------------------------------------------------------------------- measures
const WET = new Set(['wa', 'wt']);
const RIVER = new Set(['rw', 'ri', 'rm', 'rl', 'ra', 'lr', 'ww', 'ut', 'pw', 'sr']);
const BONUS = /shrine|school|university|library|learningStone|marletto|starAxis|arena|treeOfKnowledge|fountain|idolOfFortune|rallyFlag|stables|warriorsTomb|faerieRing|swanPond|temple|oasis|wateringHole|mysticalGarden|windmill|waterWheel|mermaid|buoy|siren|lighthouse|redwood|sanctuary|obelisk|gazebo|libraryOfEnlight|cartographer|knowledge|lean|magicWell|magicSpring|hillFort|witchHut|mercenary|trainingGround|stoneHenge/i;
const SEA = /mermaid|buoy|siren|whirlpool|lighthouse|shipwreck|derelict|survivor|flotsam|seaChest|sea/i;
const cheb = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
let CREATURES = null;
const level = n => { if (CREATURES === null) CREATURES = sight.index() || false; const c = CREATURES && CREATURES.creature(n); return c && c.level != null ? c.level : null; };

function measure(file) {
	const M = sight.load(file);
	const { W, H, NL } = M, N = W * H * NL;
	let side = null; try { side = JSON.parse(fs.readFileSync(M.zones.file, 'utf8')); } catch (e) { side = null; }
	let log = ''; try { log = fs.readFileSync(file + '.log', 'utf8'); } catch (e) { log = ''; }
	const r = {};
	const isWet = i => WET.has(M.terr[i]);
	let ground = 0, wet = 0, blocked = 0, road = 0;
	const kinds = { pc: 0, pg: 0, pd: 0 };
	let river = 0;
	for (let l = 0; l < NL; l++) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
		const i = M.idx(l, x, y);
		if (isWet(i)) { wet++; continue; }
		if (!M.ground(i)) continue;
		ground++; if (M.blocked[i]) blocked++;
		if (M.road[i]) road++;
		for (const c of sight.tileLayers(M.levels[l].rows[y][x])) { if (kinds[c] !== undefined) kinds[c]++; if (RIVER.has(c) && c !== 'pw') river++; }
	}
	r.waterShare = wet / N; r.blockedShare = ground ? blocked / ground : 0; r.roadShare = ground ? road / ground : 0;
	r.riverShare = ground ? river / ground : 0;
	r.roadCobble = kinds.pc; r.roadGravel = kinds.pg; r.roadDirt = kinds.pd;

	// zones and their classes (sidecar)
	let zc = [];
	if (side && side.levels) for (const lv of side.levels) zc = zc.concat(lv.classes || []);
	r.nZones = zc.length;
	const nonPlayer = zc.filter(c => c !== 'player').length || 1;
	r.fracHigh = zc.filter(c => c === 'highLoot').length / nonPlayer;
	r.fracLow = zc.filter(c => c === 'lowLoot').length / nonPlayer;
	r.fracTown = zc.filter(c => c === 'town').length / nonPlayer;
	if (!zc.length && M.zones) { // template maps: types of the zones
		const t = [...M.zones.zones.values()]; r.nZones = t.length;
		const np = t.filter(z => !/start/i.test(z.type || '')).length || 1;
		r.fracHigh = t.filter(z => z.type === 'treasure').length / np; r.fracLow = t.filter(z => z.type === 'junction').length / np;
	}

	// objects
	const by = (f) => M.objs.filter(f);
	const starts = sight.starts(M);
	r.startsL1 = starts.filter(s => s.l === 1).length;
	r.towns = by(o => o.cls === 'town').length; r.townsNeutral = Math.max(0, r.towns - starts.length);
	const mines = by(o => o.cls === 'mine');
	r.mines = mines.length; r.minesStarter = mines.filter(o => /sawmill|orePit/.test(String(o.subtype))).length; r.minesOther = r.mines - r.minesStarter;
	r.dwellings = by(o => o.cls === 'dwelling').length;
	r.banks = by(o => o.cls === 'bank').length;
	const art = by(o => /artifact|relic/i.test(o.type) && o.cls !== 'monster' && o.type !== 'spellScroll');
	r.artifacts = art.length;
	r.artifactMajorShare = art.length ? art.filter(o => /Major|Relic/.test(o.type)).length / art.length : 0;
	r.dear = by(o => o.cls === 'high' && o.type !== 'spellScroll').length;
	r.pickups = by(o => /treasureChest|spellScroll|campfire/.test(o.type)).length;
	r.resourcePiles = by(o => /^(resource|randomResource)$/.test(o.type)).length;
	const bonus = by(o => o.cls !== 'monster' && o.cls !== 'town' && o.cls !== 'mine' && o.cls !== 'dwelling' && o.cls !== 'bank' && BONUS.test(o.type) && !SEA.test(o.type));
	r.bonusSites = bonus.length;
	r.gates = by(o => /subterraneanGate/.test(o.type)).length;
	r.monoliths = by(o => o.cls === 'monolith').length;
	r.shipyards = by(o => /shipyard/i.test(o.type)).length;
	const onWater = o => o.cells && o.cells.some(([x, y]) => M.inb(x, y) && isWet(M.idx(o.l, x, y)));
	r.seaTreasure = by(o => onWater(o) && (o.pickup || o.cls === 'bank' || o.cls === 'high' || o.cls === 'low') && !SEA.test(o.type)).length;
	r.seaSites = by(o => (SEA.test(o.type) || onWater(o)) && o.cls !== 'monster' && o.cls !== 'town' && !o.pickup && o.cls !== 'low' && o.cls !== 'high' && o.cls !== 'bank').length;
	r.decor = by(o => o.cls === 'other' && !BONUS.test(o.type)).length;

	// monsters
	const mons = M.monsters;
	r.monsters = mons.length;
	const amounts = mons.map(m => Number(m.options && m.options.amount)).filter(Number.isFinite);
	r.stackMean = amounts.length ? amounts.reduce((a, b) => a + b, 0) / amounts.length : 0;
	const lv = mons.map(m => level(m.subtype)).filter(v => v !== null);
	r.monsterLevel = lv.length ? lv.reduce((a, b) => a + b, 0) / lv.length : 0;
	const nearMon = o => mons.some(m => m.l === o.l && cheb(m.at, o.at) <= 1);
	const share = (list) => list.length ? list.filter(nearMon).length / list.length : null;
	r.guardedHigh = share(by(o => o.cls === 'high' && o.type !== 'spellScroll')); r.guardedMines = share(mines); r.guardedDwellings = share(by(o => o.cls === 'dwelling'));
	r.guardedLow = share(by(o => o.cls === 'low'));
	const nonMonsterNear = m => M.objs.some(o => o.cls !== 'monster' && o.cls !== 'other' && o.l === m.l && o.cells && o.cells.some(c => cheb(c, m.at) <= 1));
	r.monsterGuardShare = mons.length ? mons.filter(nonMonsterNear).length / mons.length : null;
	const portals = by(o => o.cls === 'monolith' || o.cls === 'gate');
	r.guardedPortals = portals.length ? portals.filter(o => mons.some(m => m.l === o.l && cheb(m.at, o.at) <= 2)).length / portals.length : null;

	// zone links (passages), borders
	{
		const ring = new Uint8Array(N);
		for (const m of mons) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (M.inb(m.at[0] + dx, m.at[1] + dy)) ring[M.idx(m.l, m.at[0] + dx, m.at[1] + dy)] = 1;
		const open = i => M.ground(i) && !M.blocked[i];
		const pairs = new Map(); let bnd = 0, bndBlocked = 0, tot = 0;
		for (let l = 0; l < NL; l++) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
			const i = M.idx(l, x, y), z = M.zoneAt(l, x, y); if (z === undefined || z === null || z < 0) continue;
			tot++;
			let edge = false;
			for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
				if (!M.inb(x + dx, y + dy)) continue;
				const j = M.idx(l, x + dx, y + dy), z2 = M.zoneAt(l, x + dx, y + dy);
				if (z2 === undefined || z2 === null || z2 < 0 || z2 === z) continue;
				edge = true;
				if (dx > 0 || dy > 0) {
					if (!open(i) || !open(j)) continue;
					const key = `${l}:${Math.min(z, z2)}-${Math.max(z, z2)}`, p = pairs.get(key) || { tiles: 0, guarded: false, road: false };
					p.tiles++; if (ring[i] || ring[j]) p.guarded = true; if (M.road[i] || M.road[j]) p.road = true;
					pairs.set(key, p);
				}
			}
			if (edge && M.ground(i)) { bnd++; if (M.blocked[i]) bndBlocked++; }
		}
		const all = [...pairs.values()];
		r.links = all.length; r.linkGuardShare = all.length ? all.filter(p => p.guarded).length / all.length : null;
		r.linkRoadShare = all.length ? all.filter(p => p.road).length / all.length : null;
		r.borderShare = tot ? bnd / tot : 0; r.borderBlocked = bnd ? bndBlocked / bnd : 0;
	}

	// underground floor
	if (NL > 1) {
		let open = 0, tot = 0, wide = 0;
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
			const i = M.idx(1, x, y); tot++;
			if (!M.ground(i) || M.blocked[i]) continue;
			open++;
			let all = true;
			for (let dy = -1; dy <= 1 && all; dy++) for (let dx = -1; dx <= 1; dx++) { if (!M.inb(x + dx, y + dy)) { all = false; break; } const j = M.idx(1, x + dx, y + dy); if (!M.ground(j) || M.blocked[j]) { all = false; break; } }
			if (all) wide++;
		}
		r.ugOpen = open / tot; r.ugWide = open ? wide / open : 0;
	} else { r.ugOpen = null; r.ugWide = null; }

	// players and teams
	const pl = Object.values(M.header.players || {});
	r.aiOnly = pl.filter(p => p.canPlay === 'AIOnly').length;
	r.humans = pl.filter(p => p.canPlay && p.canPlay !== 'AIOnly').length;
	r.teams = Array.isArray(M.header.teams) ? M.header.teams.length : 0;
	r.failedRoadMsgs = (log.match(/not reached/g) || []).length;
	return r;
}

// ---------------------------------------------------------------------------------------------------------------- what each lever is meant to do
// [measure, direction (+1 up with the lever, -1 down)], layouts it applies to, extra fixed options. Only what the help text promises.
const SPEC = {
	zoneCells: { layouts: ['free'], expect: [['nZones', -1]], notes: 'bigger biomes, fewer of them (free layout; a template keeps its zones)' },
	zoneCap: { layouts: ['free'], points: [4, 12, 300], expect: [['nZones', +1]], notes: 'a cap below what Biome size gives holds the count down' },
	highLootRatio: { layouts: ['free', 'tpl'], expect: [['fracHigh', +1], ['dear', +1]] },
	townRatio: { layouts: ['free', 'tpl'], expect: [['townsNeutral', +1]] },
	lowLootRatio: { layouts: ['free', 'tpl'], expect: [['fracLow', +1]] },
	borderSolidity: { layouts: ['free', 'tpl'], expect: [['borderBlocked', +1]] },
	biomeWobble: { layouts: ['free'], expect: [['borderShare', +1]], notes: 'wiggling borders are longer' },
	interconnectivity: { layouts: ['free'], expect: [['links', +1]] },
	interconnectPortal: { layouts: ['free'], expect: [['monoliths', +1]] },
	openPathNoRoad: { layouts: ['free'], expect: [['linkRoadShare', -1]] },
	openPathRoad: { layouts: ['free'], expect: [['linkRoadShare', +1]] },
	roadNetwork: { layouts: ['free', 'tpl'], expect: [['roadShare', +1]] },
	roadType: { layouts: ['free'], expect: [['roadCobble', +1]], notes: '0 dirt, 1 gravel, 2 cobblestone' },
	artifactDensity: { layouts: ['free', 'tpl'], expect: [['artifacts', +1]] },
	artifactRichness: { layouts: ['free', 'tpl'], expect: [['artifactMajorShare', +1]] },
	pickupDensity: { layouts: ['free', 'tpl'], expect: [['pickups', +1]] },
	resourceDensity: { layouts: ['free', 'tpl'], expect: [['resourcePiles', +1]] },
	mineDensity: { layouts: ['free', 'tpl'], expect: [['minesOther', +1]] },
	starterMines: { layouts: ['free', 'tpl'], expect: [['minesStarter', +1]] },
	dwellingDensity: { layouts: ['free', 'tpl'], expect: [['dwellings', +1]] },
	bonusDensity: { layouts: ['free', 'tpl'], expect: [['bonusSites', +1]] },
	monsterStrength: { layouts: ['free', 'tpl'], expect: [['monsterLevel', +1]] },
	stackScale: { layouts: ['free', 'tpl'], expect: [['stackMean', +1]] },
	guardDensity: { layouts: ['free', 'tpl'], expect: [['monsters', +1]] },
	objectGuardShare: { layouts: ['free'], expect: [['monsterGuardShare', +1]] },
	guardTreasure: { layouts: ['free', 'tpl'], expect: [['guardedHigh', +1]] },
	guardMines: { layouts: ['free', 'tpl'], expect: [['guardedMines', +1]] },
	guardDwellings: { layouts: ['free', 'tpl'], expect: [['guardedDwellings', +1]] },
	guardBottlenecks: { layouts: ['free', 'tpl'], expect: [['linkGuardShare', +1]] },
	chokeGuardRatio: { layouts: ['free', 'tpl'], expect: [['linkGuardShare', +1]] },
	guardPortals: { layouts: ['free', 'tpl'], expect: [['guardedPortals', +1]] },
	lootGuardWeight: { layouts: ['free', 'tpl'], expect: [['guardedHigh', +1]] },
	mineGuardWeight: { layouts: ['free', 'tpl'], expect: [['guardedMines', +1]] },
	subterraneanGateRatio: { layouts: ['ug', 'tplug'], expect: [['gates', +1]] },
	subterraneanNarrow: { layouts: ['ug', 'tplug'], expect: [['ugWide', -1]] },
	undergroundStarts: { layouts: ['ug', 'tplug'], expect: [['startsL1', +1]], notes: '0 all overworld ... 4 default' },
	subterraneanOpen: { layouts: ['ug', 'tplug'], expect: [['ugOpen', +1]] },
	decorDensity: { layouts: ['free', 'tpl'], expect: [['decor', +1]] },
	rivers: { layouts: ['free', 'tpl'], expect: [['riverShare', +1]] },
	riverAmount: { layouts: ['free', 'tpl'], expect: [['riverShare', +1]] },
	teams: { layouts: ['free'], expect: [['teams', +1]] },
	compOnly: { layouts: ['free'], expect: [['aiOnly', +1]] },
	roadDirt: { layouts: ['free'], base: { 'bio.roadGravel': 0, 'bio.roadCobblestone': 0 }, expect: [['roadDirt', +1]], notes: 'the other two road types off, so dirt is the only one left' },
	roadGravel: { layouts: ['free'], base: { 'bio.roadDirt': 0, 'bio.roadCobblestone': 0 }, expect: [['roadGravel', +1]] },
	roadCobblestone: { layouts: ['free'], base: { 'bio.roadDirt': 0, 'bio.roadGravel': 0 }, expect: [['roadCobble', +1]] },
	waterContent: { layouts: ['free'], base: { 'bio.waterCoverage': 0.3, 'bio.waterShape': 3 }, expect: [['waterShare', +1]], notes: '-1 none, 0 normal at the amount below, 1 normal, 2 islands (stops)' },
	waterCoverage: { layouts: ['free', 'tpl'], base: { 'bio.waterContent': 1, 'bio.waterShape': 3 }, expect: [['waterShare', +1]] },
	waterShape: { layouts: ['free'], base: { 'bio.waterCoverage': 0.3, 'bio.waterContent': 1 }, expect: [], shape: true, notes: 'what each shape makes is judged against the Age of Empires reference, here only that the picture changes' },
	waterAccess: { layouts: ['free'], base: WATER, expect: [['shipyards', +1]] },
	waterTreasure: { layouts: ['free'], base: WATER, expect: [['seaTreasure', +1]] },
	waterBuildings: { layouts: ['free'], base: WATER, expect: [['seaSites', +1]] },
};

// ---------------------------------------------------------------------------------------------------------------- plan
const knobByKey = Object.fromEntries(KNOBS.map(k => [k.key, k]));
const dflt = k => (knobByKey[k].default !== undefined ? knobByKey[k].default : BIOME_DEFAULTS[k]);
const stopVal = s => (s && typeof s === 'object' ? (s.value !== undefined ? s.value : s[0]) : s);
function pointsOf(key) {
	const k = knobByKey[key], sp = SPEC[key] || {};
	if (sp.points) return sp.points;
	if (k.stops && k.stops.length) return k.stops.map(stopVal);
	const d = dflt(key); return [...new Set([k.min, d, k.max])].sort((a, b) => a - b);
}
const sel = arg('--levers', 'all');
let keys = KNOBS.map(k => k.key).filter(k => SPEC[k]);
if (sel !== 'all') {
	const want = new Set(sel.split(',').filter(Boolean));
	keys = keys.filter(k => want.has(k) || [...want].some(w => w.startsWith('page:') && knobByKey[k].page === w.slice(5)));
}
const layoutsAsked = arg('--layouts', 'free,tpl,ug,tplug').split(',');
const jobs = new Map();
const flagOf = (key, v) => (knobByKey[key].cli ? ['--' + key, String(v)] : ['--bio.' + key, String(v)]);
function jobFor(layout, id, lever, value, seed) {
	const sp = SPEC[lever] || {};
	const o = { ...LAYOUTS[layout], seed: String(seed), ...(sp.base || {}) };
	if (lever) o[knobByKey[lever].cli ? lever : 'bio.' + lever] = value;
	const file = path.join(OUT, layout, `${id}_s${seed}.vmap`);
	jobs.set(file, { file, layout, opt: o });
	return file;
}
const plan = []; // {lever, layout, value, seed, file}
for (const key of keys) {
	const sp = SPEC[key];
	for (const layout of sp.layouts.filter(l => layoutsAsked.includes(l))) for (const v of pointsOf(key)) for (let s = 1; s <= SEEDS; s++) {
		const file = jobFor(layout, `${key}=${v}`, key, v, s);
		plan.push({ lever: key, layout, value: v, seed: s, file });
	}
}

function generate(job) {
	const o = { ...job.opt, out: job.file, vcmiroot: ROOT, vcmiuserdir: K_USER };
	const a = [path.join(TIP, 'src', 'main', 'generate-cli.js')];
	for (const [k, v] of Object.entries(o)) a.push('--' + k, String(v));
	const env = { ...process.env, VCMI_ROOT: ROOT, NODE_PATH: NODE_MODULES }; delete env.NODE_OPTIONS;
	for (const k of STRIPPED) delete env[k];
	return new Promise(r => execFile(process.execPath, a, { env, cwd: TIP, timeout: 600000, windowsHide: true, maxBuffer: 1 << 26 },
		(err, so, se) => { fs.writeFileSync(job.file + '.log', `${so || ''}${se || ''}`); r(fs.existsSync(job.file) ? null : (err ? err.message.slice(0, 160) : 'no map written')); }));
}

// ---------------------------------------------------------------------------------------------------------------- report
const mean = a => { const v = a.filter(x => x !== null && x !== undefined && Number.isFinite(x)); return v.length ? v.reduce((p, q) => p + q, 0) / v.length : null; };
const fmt = x => x === null || x === undefined ? '-' : (Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 1 ? x.toFixed(2) : x.toFixed(3));
const rel = (a, b) => { if (a === null || b === null) return null; const d = Math.max(Math.abs(a), Math.abs(b), 1e-9); return (b - a) / d; };

function report() {
	const results = {}; const md = [];
	const measured = new Map();
	const get = f => { if (!measured.has(f)) { try { measured.set(f, measure(f)); } catch (e) { measured.set(f, { error: e.message }); } } return measured.get(f); };
	md.push(`# Lever test (tip ${path.basename(TIP)}, ${new Date().toLocaleDateString('en-CA')}, ${SEEDS} seeds per point)`, '',
		'One lever at a time over its range on fixed seeds; the table gives the seed mean of each named measure at each value. Verdict rules in tools/harness/lever_test.js: OK = moves the named measure the intended way by 10% or more end to end; WEAK = 3 to 10%; NO EFFECT = under 3% on every named measure; WRONG = against the intent by 5% or more. Side effects: other measures that moved by 25% or more. Layouts: free = open layout 72x72 four players, tpl = Coldshadow 108x108 four players, ug = open layout with underground, tplug = Coldshadow with underground.', '');
	const summary = [];
	for (const key of keys) {
		const sp = SPEC[key]; const k = knobByKey[key];
		for (const layout of sp.layouts.filter(l => layoutsAsked.includes(l))) {
			const pts = pointsOf(key); const rowsAll = [];
			for (const v of pts) {
				const ms = []; for (let s = 1; s <= SEEDS; s++) { const f = path.join(OUT, layout, `${key}=${v}_s${s}.vmap`); if (fs.existsSync(f)) { const m = get(f); if (!m.error) ms.push(m); } }
				rowsAll.push({ v, n: ms.length, ms });
			}
			const have = rowsAll.filter(r => r.n);
			const names = [...new Set([...sp.expect.map(e => e[0])])];
			const vals = (name) => have.map(r => mean(r.ms.map(m => m[name])));
			let verdict = 'NOT RUN'; const detail = [];
			if (have.length >= 2) {
				verdict = sp.expect.length ? 'NO EFFECT' : 'EFFECT';
				let best = null;
				for (const [name, dir] of sp.expect) {
					const v = vals(name), a = v[0], b = v[v.length - 1], rr = rel(a, b);
					const dirRel = rr === null ? null : dir * rr;
					let viol = 0; for (let i = 1; i < v.length; i++) if (v[i] !== null && v[i - 1] !== null && dir * (v[i] - v[i - 1]) < -0.05 * Math.max(Math.abs(v[0]), Math.abs(v[v.length - 1]), 1e-9)) viol++;
					detail.push(`${name} ${v.map(fmt).join(' > ')} (${dirRel === null ? '?' : (100 * dirRel).toFixed(0) + '%'} intended${viol ? ', ' + viol + ' step(s) the wrong way' : ''})`);
					if (dirRel !== null && (best === null || dirRel > best)) best = dirRel;
					if (dirRel !== null && dirRel <= -0.05) verdict = 'WRONG';
				}
				if (verdict !== 'WRONG' && sp.expect.length) verdict = best === null ? 'NO DATA' : best >= 0.10 ? 'OK' : best >= 0.03 ? 'WEAK' : 'NO EFFECT';
				if (sp.shape) {
					const shapes = have.map(r => r.ms.map(m => m.waterShare).map(x => (x === null ? '?' : (100 * x).toFixed(0) + '%')).join('/'));
					detail.push(`water share per shape ${shapes.join(' | ')}`);
					verdict = 'EFFECT';
				}
			}
			// side effects
			const side = [];
			if (have.length >= 2) {
				const all = Object.keys(have[0].ms[0] || {});
				for (const name of all) {
					if (names.includes(name)) continue;
					const v = have.map(r => mean(r.ms.map(m => m[name]))); const rr = rel(v[0], v[v.length - 1]);
					const dmax = Math.max(...v.filter(x => x !== null).map(Math.abs), 0);
					if (rr !== null && Math.abs(rr) >= 0.25 && dmax >= (name.includes('Share') || name.startsWith('guarded') || name.startsWith('frac') ? 0.05 : 5)) side.push(`${name} ${v.map(fmt).join(' > ')}`);
				}
			}
			results[`${key}|${layout}`] = { lever: key, layout, page: k.page, verdict, points: pts, detail, side, n: rowsAll.map(r => r.n) };
			summary.push({ key, layout, page: k.page, verdict });
			md.push(`### ${key} (${k.page}) on ${layout}: ${verdict}`, '', `values ${pts.join(', ')}; maps per value ${rowsAll.map(r => r.n).join('/')}; default ${dflt(key)}${sp.notes ? '; ' + sp.notes : ''}`, '');
			for (const d of detail) md.push(`- ${d}`);
			if (side.length) md.push(`- side effects (25% or more): ${side.slice(0, 8).join('; ')}`);
			md.push('');
		}
	}
	const counts = {}; for (const s of summary) counts[s.verdict] = (counts[s.verdict] || 0) + 1;
	md.splice(4, 0, `Verdict counts (lever x layout): ${Object.entries(counts).map(([k, v]) => k + ' ' + v).join(', ')}`, '');
	md.push('## Verdicts at a glance', '', '| lever | page | ' + layoutsAsked.join(' | ') + ' |', '|---|---|' + layoutsAsked.map(() => '---').join('|') + '|');
	for (const key of keys) md.push(`| ${key} | ${knobByKey[key].page} | ${layoutsAsked.map(l => (results[`${key}|${l}`] || {}).verdict || '').join(' | ')} |`);
	fs.writeFileSync(path.join(OUT, 'lever_results.json'), JSON.stringify(results, null, 1));
	fs.writeFileSync(path.join(OUT, 'LEVER-TEST.md'), md.join('\n') + '\n');
	console.log(`report: ${summary.length} lever x layout rows -> ${path.join(OUT, 'LEVER-TEST.md')}; ${Object.entries(counts).map(([k, v]) => k + ' ' + v).join(', ')}`);
}

(async () => {
	fs.mkdirSync(OUT, { recursive: true });
	for (const l of Object.keys(LAYOUTS)) fs.mkdirSync(path.join(OUT, l), { recursive: true });
	if (!has('--eval')) {
		const todo = [...jobs.values()].filter(j => !fs.existsSync(j.file));
		console.log(`plan: ${plan.length} map slots, ${jobs.size} distinct maps, ${todo.length} to make, ${LANES} lanes`);
		let next = 0, made = 0, failed = [];
		await Promise.all(Array.from({ length: LANES }, async () => {
			while (next < todo.length && Date.now() < DEADLINE && !fs.existsSync(path.join(OUT, 'STOP'))) {
				const j = todo[next++]; const e = await generate(j); made++;
				if (e) failed.push(`${path.basename(j.file)}: ${e}`);
				if (made % 25 === 0) console.log(`${made} of ${todo.length} made`);
			}
		}));
		console.log(`generation done: ${made} made, ${failed.length} failed${next < todo.length ? ', stopped at the deadline or STOP with ' + (todo.length - next) + ' left' : ''}`);
		for (const f of failed) console.log('  FAILED ' + f);
		fs.writeFileSync(path.join(OUT, 'failed.txt'), failed.join('\n'));
	}
	report();
})();
