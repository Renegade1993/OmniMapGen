'use strict';
/**
 * water_cases.js - the water report (grid_extra.js 'water') on a set of water maps made from K's Mediterranean options (the 180x180 Coldshadow with 45% water,
 * roster\QUEUE-Opus Map Vision.md K reports 2026-10-10): the layouts Mediterranean, Continental, Coastal, Highland, Lakes on the template and on Jebus Cross,
 * Islands and Archipelago, with other seeds. Generates with the checkout in --tip and prints one line a map.
 *
 *   node tools/harness/water_cases.js --out DIR [--tip DIR] [--lanes 2] [--deadline-min 30] [--base SIDECAR.zones.json]
 *   node tools/harness/water_cases.js --eval DIR|MAP ...      the same table for maps already made (a grid, K's cases)
 *   columns body%map, centre, shore, rays: the largest water body's share of the map, its centre's distance from the map centre (0 = middle, 1 = edge), the share of land in a
 *   3-tile band along its shore, and how many of 16 rays from its centre meet land / the map edge / other water after leaving it (a Mediterranean sea: land on all 16)
 *
 * Every generation is a hidden child process with its own timeout; the run stops at the deadline or when a file STOP appears in --out.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { runChecks } = require('./playtest_checks');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const ROOT = process.env.VMAPGEN_TEST_ROOT || 'C:/AI Projects/Heroes 3/VCMI/dmbtest';
const K_USER = process.env.DMB_USER_DIR || require('path').join(require('os').homedir(), 'Documents', 'My Games', "Dead Man's Boots");
const TIP = path.resolve(arg('--tip', path.join(__dirname, '..', '..')));
const OUT = path.resolve(arg('--out', '.tmp/water_cases'));
const LANES = +arg('--lanes', 2), DEADLINE = Date.now() + 60000 * +arg('--deadline-min', 30);
const BASE_FILE = arg('--base', 'C:/AI Projects/Heroes 3/.tmp/opus-seeing/k1010/mapgen_180x180_p4_s669067840.vmap.zones.json');
const EVAL = process.argv.indexOf('--eval');
const BASE = EVAL > 0 ? {} : JSON.parse(fs.readFileSync(BASE_FILE, 'utf8')).options;
const K_SEED = BASE.seed;

const jobs = [];
const add = (id, size, shape, cov, seed, extra = {}) => jobs.push({ id, size, shape, cov, seed, ...extra });
for (const s of [K_SEED, 1]) add(`med180_s${s}`, 180, 3, 0.45, s);
for (const s of [1, 2, 3]) add(`med108_s${s}`, 108, 3, 0.45, s);
for (const s of [1, 2]) { add(`cont108_s${s}`, 108, 2, 0.45, s); add(`coast108_s${s}`, 108, 1, 0.35, s); add(`high108_s${s}`, 108, 4, 0.35, s); }
add('lakes108_s1', 108, 0, 0.25, 1);
for (const s of [1, 2]) add(`jebusmed108_s${s}`, 108, 3, 0.45, s, { template: 'Jebus Cross' });
add('jebusmed30_108_s1', 108, 3, 0.3, 1, { template: 'Jebus Cross' });
for (const s of [1, 2]) add(`islands108_s${s}`, 108, 5, 0.45, s, { content: 2 });
add('archi108_s1', 108, 6, 0.45, 1, { content: 2 });

function generate(j) {
	const file = path.join(OUT, `${j.id}.vmap`);
	const o = { ...BASE, w: j.size, h: j.size, players: 4, humans: 4, seed: j.seed, out: file, vcmiroot: ROOT, vcmiuserdir: K_USER, underground: 0, factions: 'random,random,random,random',
		'bio.waterShape': j.shape, 'bio.waterCoverage': j.cov, 'bio.waterContent': j.content || 1 };
	if (j.template) o.template = j.template;
	const a = [path.join(TIP, 'src', 'main', 'generate-cli.js')];
	for (const [k, v] of Object.entries(o)) a.push('--' + k, String(v));
	const env = { ...process.env, VCMI_ROOT: ROOT, NODE_PATH: process.env.NODE_PATH || 'C:/AI Projects/Heroes 3/VCMIMapGen/node_modules' };
	delete env.NODE_OPTIONS;
	return new Promise(r => execFile(process.execPath, a, { env, cwd: TIP, timeout: 600000, windowsHide: true, maxBuffer: 1 << 26 },
		(err, so, se) => { fs.writeFileSync(file + '.log', `${so || ''}${se || ''}`); r({ j, file, err: fs.existsSync(file) ? null : (err ? err.message.slice(0, 160) : 'no map written') }); }));
}

(async () => {
	let next = 0;
	const done = [];
	if (EVAL > 0) {
		for (const a of process.argv.slice(EVAL + 1)) for (const f of (fs.statSync(a).isDirectory() ? fs.readdirSync(a).filter(x => x.endsWith('.vmap')).map(x => path.join(a, x)) : [a]))
			done.push({ j: { id: path.basename(f, '.vmap') }, file: f, err: null });
	} else {
	fs.mkdirSync(OUT, { recursive: true });
	await Promise.all(Array.from({ length: LANES }, async () => {
		while (next < jobs.length && Date.now() < DEADLINE && !fs.existsSync(path.join(OUT, 'STOP'))) done.push(await generate(jobs[next++]));
	}));
	}
	done.sort((a, b) => a.j.id.localeCompare(b.j.id));
	const pc = x => x === null || x === undefined ? '?' : (100 * x).toFixed(0) + '%';
	console.log(`${'map'.padEnd(20)} ${'water'.padStart(6)} ${'asked'.padStart(6)}  ${'sea shape seen'.padEnd(22)} ${'low'.padStart(3)} ${'drown'.padStart(5)} ${'cut'.padStart(3)} ${'wall'.padStart(4)} ${'strand'.padStart(6)} ${'body%map'.padStart(8)} ${'centre'.padStart(6)} ${'shore'.padStart(5)} ${'rays L/E/W'.padStart(10)}  verdict`);
	for (const d of done) {
		if (d.err) { console.log(`${d.j.id.padEnd(20)} NOT GENERATED: ${d.err}`); continue; }
		const r = runChecks(d.file, ['water']).checks.water;
		if (!r || r.skipped || r.error) { console.log(`${d.j.id.padEnd(20)} ${r ? r.skipped || r.error : 'no result'}`); continue; }
		const n = r.nums;
		console.log(`${d.j.id.padEnd(20)} ${pc(n.share).padStart(6)} ${pc(n.asked).padStart(6)}  ${String(n.shapeSeen).padEnd(22)} ${String(n.lowZones).padStart(3)} ${String(n.drownedZones).padStart(5)} ${String(n.cutZones).padStart(3)} ${String(n.walledZones).padStart(4)} ${String(n.startsStranded).padStart(3)}/${n.starts} ${pc(n.bodyShareOfMap).padStart(8)} ${n.centDist === undefined ? '?' : n.centDist.toFixed(2).padStart(6)} ${pc(n.ringLand).padStart(5)} ${(n.raysLand + '/' + n.raysEdge + '/' + n.raysWater).padStart(10)}  ${r.pass ? 'ok' : 'FAIL'}`);
	}
	console.log(EVAL > 0 ? `${done.length} maps` : `${done.length} of ${jobs.length} maps`);
})();
