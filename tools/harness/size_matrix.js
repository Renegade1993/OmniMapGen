'use strict';
/**
 * size_matrix.js - the checks on maps K has not played: other sizes, player counts, levels, with and without Coldshadow's template, from K's recorded
 * options (small-ug) with those fields replaced. Generates with the checkout in --tip (default: this one) and prints the playtest_checks table.
 *
 *   node tools/harness/size_matrix.js --out DIR [--tip DIR] [--seed 1] [--lanes 2] [--deadline-min 20] [--set small|wide]
 *
 * Every generation is a hidden child process with its own timeout; the run stops at the deadline or when a file STOP appears in --out.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { runChecks } = require('./playtest_checks');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const REPORTS = process.env.K_REPORTS || 'C:/AI Projects/Heroes 3/.tmp/k-reports';
const ROOT = process.env.VMAPGEN_TEST_ROOT || 'C:/AI Projects/Heroes 3/VCMI/dmbtest';
const K_USER = process.env.DMB_USER_DIR || require('path').join(require('os').homedir(), 'Documents', 'My Games', "Dead Man's Boots");
const TIP = path.resolve(arg('--tip', path.join(__dirname, '..', '..')));
const OUT = path.resolve(arg('--out', '.tmp/size_matrix'));
const SEED = +arg('--seed', 1), LANES = +arg('--lanes', 2), DEADLINE = Date.now() + 60000 * +arg('--deadline-min', 20);
const src = fs.readdirSync(path.join(REPORTS, '1006-small-ug')).find(f => f.endsWith('.zones.json'));
const BASE = JSON.parse(fs.readFileSync(path.join(REPORTS, '1006-small-ug', src), 'utf8')).options;

const jobs = [];
const add = (size, p, ug, tmpl) => jobs.push({ id: `${size}x${size}_p${p}_${ug ? 'ug' : 'surf'}_${tmpl ? 'tmpl' : 'free'}`, size, p, ug, tmpl });
if (arg('--set', 'small') === 'wide') {
	for (const t of [true, false]) { for (const u of [0, 1]) for (const p of [2, 4]) add(36, p, u, t); }
	for (const t of [true, false]) for (const u of [0, 1]) for (const p of [2, 4, 8]) add(72, p, u, t);
	for (const t of [true, false]) for (const u of [0, 1]) for (const p of [2, 4, 8]) add(108, p, u, t);
	for (const t of [true, false]) for (const u of [0, 1]) for (const p of [4, 8]) add(144, p, u, t);
} else {
	for (const t of [true, false]) for (const u of [0, 1]) add(36, 2, u, t);
	for (const t of [true, false]) for (const u of [0, 1]) for (const p of [2, 8]) add(72, p, u, t);
	for (const t of [true, false]) for (const p of [4, 8]) add(144, p, 1, t);
}

function generate(j) {
	const file = path.join(OUT, `${j.id}_s${SEED}.vmap`);
	const o = { ...BASE, w: j.size, h: j.size, players: j.p, humans: j.p, seed: SEED, out: file, vcmiroot: ROOT, vcmiuserdir: K_USER, underground: j.ug, factions: Array(j.p).fill('random').join(',') };
	if (!j.tmpl) delete o.template;
	const a = [path.join(TIP, 'src', 'main', 'generate-cli.js')];
	for (const [k, v] of Object.entries(o)) a.push('--' + k, String(v));
	const env = { ...process.env, VCMI_ROOT: ROOT, NODE_PATH: process.env.NODE_PATH || 'C:/AI Projects/Heroes 3/VCMIMapGen/node_modules' };
	delete env.NODE_OPTIONS;
	return new Promise(r => execFile(process.execPath, a, { env, cwd: TIP, timeout: 600000, windowsHide: true, maxBuffer: 1 << 26 },
		(err, so, se) => { fs.writeFileSync(file + '.log', `${so || ''}${se || ''}`); r({ j, file, err: fs.existsSync(file) ? null : (err ? err.message.slice(0, 160) : 'no map written') }); }));
}

(async () => {
	fs.mkdirSync(OUT, { recursive: true });
	let next = 0;
	const done = [];
	await Promise.all(Array.from({ length: LANES }, async () => {
		while (next < jobs.length && Date.now() < DEADLINE && !fs.existsSync(path.join(OUT, 'STOP'))) done.push(await generate(jobs[next++]));
	}));
	done.sort((a, b) => a.j.id.localeCompare(b.j.id));
	const names = ['start-road', 'town-road', 'towns-per-start', 'town-spacing', 'road-breaks', 'road-ends', 'prison-tiers', 'edge-objects', 'free-standing', 'river-ends', 'dwelling-reach', 'approach-open', 'flyer-open', 'guard-clusters', 'biome-density'];
	console.log(`${'map'.padEnd(26)} ${names.map(n => n.slice(0, 8).padEnd(8)).join(' ')}`);
	const fails = {};
	for (const d of done) {
		if (d.err) { console.log(`${d.j.id.padEnd(26)} NOT GENERATED: ${d.err}`); continue; }
		const r = runChecks(d.file).checks;
		console.log(`${d.j.id.padEnd(26)} ${names.map(n => { const c = r[n]; const t = !c ? '-' : c.error ? 'ERR' : c.skipped ? '.' : c.pass ? 'ok' : 'FAIL'; if (t === 'FAIL') (fails[n] = fails[n] || []).push(d.j.id); return t.padEnd(8); }).join(' ')}`);
	}
	console.log('\nfails: ' + (Object.keys(fails).length ? Object.entries(fails).map(([n, l]) => `${n} ${l.length}`).join(', ') : 'none'));
	console.log(`${done.length} of ${jobs.length} maps (seed ${SEED})`);
})();
