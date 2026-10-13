'use strict';
/**
 * k_cases.js - K's playtest maps of 2026-10-06 as a regression set. For each case the map K played is measured with
 * playtest_checks.js (it must fail the checks K's words name), then the same recorded options are generated again with THIS checkout
 * on K's seed (and the next seeds) and measured the same way. A fix has landed when the new maps pass what the old one failed, on
 * every seed and not only K's own.
 *
 *   node tools/harness/k_cases.js [--seeds 3] [--lanes 2] [--out DIR] [--only small-ug,xl-p4-islands,isl1008-a,isl1008-b] [--nomods] [--deadline-min 40]
 *
 * K's maps come from the lead's read-only copies in K_REPORTS (default C:\AI Projects\Heroes 3\.tmp\k-reports\1006-*), the options from
 * each map's .zones.json. The test install is VMAPGEN_TEST_ROOT (default C:\AI Projects\Heroes 3\VCMI\dmbtest); the mods of
 * K's user folder are read (read only) as he had them, so K's own seed gives his map again (--nomods leaves them out; the dwellings then
 * are placeholders and four checks see none). Every generation is a hidden child process with its own timeout, and the whole run
 * stops at the deadline or when a file STOP appears in --out. Nothing is written outside --out.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { runChecks } = require('./playtest_checks');

const REPORTS = process.env.K_REPORTS || 'C:/AI Projects/Heroes 3/.tmp/k-reports';
const ROOT = process.env.VMAPGEN_TEST_ROOT || 'C:/AI Projects/Heroes 3/VCMI/dmbtest';
const K_USER = require('path').join(require('os').homedir(), 'Documents', 'My Games', "Dead Man's Boots");
const NODE_MODULES = 'C:/AI Projects/Heroes 3/VCMIMapGen/node_modules';

// what K said about each map (roster\PLAYTEST-NOTES-2026-10-06.md) and the checks that carry it
const CASES = [
	{ id: 'small-ug', dir: '1006-small-ug', k: ['towns-per-start', 'town-road', 'guard-clusters'], said: '14:57 "did you see how many towns each side starts with?" (red 2, blue 1); 15:03 guard clusters' },
	{ id: 'large-p2', dir: '1006-large-p2-surface', k: ['guard-clusters'], said: '15:01 "looks pretty damn good" except 15:03 guard clusters; its checks must stay as they are' },
	{ id: 'xl-p4-underground', dir: '1006-xl-p4-underground', k: ['biome-density', 'town-road', 'dwelling-reach', 'guard-clusters'], said: '15:21 empty snow biome; 15:26 pavilion town with no road, dwellings that look impassable' },
	{ id: 'xl-p4-islands', dir: '1006-xl-p4-islands', k: ['town-road', 'coast-slots', 'dragons-middle', 'guard-clusters'], said: '15:29 start with no road connection; 15:31 blocky inlets; 15:31 dragon dwellings only in the middle' },
	{ id: 'isl1008-a', dir: '1008-islands', pick: '1448536486', k: ['start-road', 'town-spacing'], said: '10-08 15:5x islands: four equal corner blobs' },
	{ id: 'isl1008-b', dir: '1008-islands', pick: '2094259453', k: ['start-road', 'town-road'], said: '10-08 15:5x "started without a road on this one" (the start at (2,4))' },
];

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const SEEDS = +arg('--seeds', 3), LANES = +arg('--lanes', 2), DEADLINE = Date.now() + 60000 * +arg('--deadline-min', 40);
const only = arg('--only', null) ? arg('--only').split(',') : null;
const out = path.resolve(arg('--out', path.join(__dirname, '..', '..', '.tmp', 'k_cases', new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12))));

function generate(opt, seed, file) {
	const o = { ...opt, seed: String(seed), out: file, vcmiroot: ROOT };
	if (!process.argv.includes('--nomods')) o.vcmiuserdir = K_USER; else delete o.vcmiuserdir;
	const a = [path.join(__dirname, '..', '..', 'src', 'main', 'generate-cli.js')];
	for (const [k, v] of Object.entries(o)) a.push('--' + k, String(v));
	const env = { ...process.env, VCMI_ROOT: ROOT };
	if (!env.NODE_PATH && fs.existsSync(NODE_MODULES)) env.NODE_PATH = NODE_MODULES;
	return new Promise(resolve => execFile(process.execPath, a, { env, cwd: path.join(__dirname, '..', '..'), timeout: 600000, windowsHide: true, maxBuffer: 1 << 26 },
		(err, so, se) => { fs.writeFileSync(file + '.log', `${so || ''}${se || ''}`); resolve(fs.existsSync(file) ? null : (err ? err.message.slice(0, 200) : 'no map written')); }));
}

function show(label, r, names) {
	const lines = [];
	for (const [n, c] of Object.entries(r.checks)) {
		if (c.error) { lines.push(`    ERROR ${n}: ${c.error}`); continue; }
		if (c.skipped) continue;
		lines.push(`    ${c.pass ? 'pass' : 'FAIL'} ${n}${names.includes(n) ? ' *' : ''}: ${c.value}`);
		if (!c.pass) for (const it of c.items.slice(0, 2)) lines.push(`         ${it}`);
	}
	console.log(`  ${label}\n${lines.join('\n')}`);
}

(async () => {
	fs.mkdirSync(out, { recursive: true });
	const jobs = [];
	for (const c of CASES) {
		if (only && !only.includes(c.id)) continue;
		const src = fs.readdirSync(path.join(REPORTS, c.dir)).find(f => f.endsWith('.vmap') && (!c.pick || f.includes(c.pick)));
		const kmap = path.join(REPORTS, c.dir, src), opt = JSON.parse(fs.readFileSync(kmap + '.zones.json', 'utf8')).options, seed0 = +opt.seed;
		console.log(`\n== ${c.id}: ${c.said}\n  (* = the checks K's words name)`);
		show(`K's map (${src}, as generated for him)`, runChecks(kmap), c.k);
		for (let s = 0; s < SEEDS; s++) jobs.push({ c, opt, seed: seed0 + s, file: path.join(out, `${c.id}_s${seed0 + s}.vmap`) });
	}
	let next = 0;
	const results = [];
	await Promise.all(Array.from({ length: LANES }, async () => {
		while (next < jobs.length && Date.now() < DEADLINE && !fs.existsSync(path.join(out, 'STOP'))) {
			const j = jobs[next++], err = await generate(j.opt, j.seed, j.file);
			results.push({ j, err, r: err ? null : runChecks(j.file) });
		}
	}));
	results.sort((a, b) => (a.j.c.id + a.j.seed).localeCompare(b.j.c.id + b.j.seed));
	console.log(`\n== this checkout (${path.basename(path.join(__dirname, '..', '..'))}), generated with K's recorded options, maps in ${out}`);
	for (const { j, err, r } of results) {
		console.log(`\n${j.c.id} seed ${j.seed}${j.seed === +j.opt.seed ? ' (K\'s seed)' : ''}`);
		if (err) console.log(`  generation failed: ${err}`); else show('new map', r, j.c.k);
	}
	if (next < jobs.length) console.log(`\nstopped at the deadline: ${jobs.length - next} of ${jobs.length} generations not run`);
})();
