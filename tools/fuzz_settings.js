/**
 * fuzz_settings.js - throw random MapGen tab settings at the generator and
 * validate every map it makes, so a combination that crashes, refuses for no
 * good reason or ships a broken map turns up here before a player finds it.
 *
 * A case is what the in-game tab can send (client/lobby/MapGenTab.cpp,
 * generate()): a size from the tab's size stops, 2-8 players, 1..players
 * humans, underground on or off, Free layout or a template its picker would
 * offer (the generator's constraint check stands in for the picker's; since
 * 2026-09-25 both are the engine's rule, size and players range only),
 * --preset nostalgia, and the levers the player touched, each at a
 * legal value (a third of them pinned to min or max, where edge bugs live;
 * "rivers" goes as --rivers, the rest as --bio.<key>). Half the cases touch a
 * few levers, the other half all of them.
 *
 * Outcomes, one JSON line per case in <out>/cases.jsonl with the exact
 * command line, and a summary in <out>/summary.txt:
 *   ok        generated, every validator clean
 *   refused   the generator exited with an "Error:" line (a stated refusal)
 *   crash     non-zero exit with no "Error:" line, or a JS stack trace
 *   invalid   generated, but a validator failed
 *   timeout   generation ran past --gen-timeout
 * Validators: vmap_validate.js, vmap_engine_check.js, vmap_overlap.js
 * (collisions) and check_reach.py (player pairs, unreachable objects).
 *
 * usage: node tools/fuzz_settings.js --out <dir> [--cases 60] [--seed 1]
 *        [--jobs 3] [--maxsize 144] [--gen-timeout 240] [--minutes 60]
 *        [--template-share 0.35]
 * After a fix, the same cases again (every one not ok, or those named):
 *        node tools/fuzz_settings.js --out <new dir> --rerun <old dir>/cases.jsonl
 *        [--only 10,12]
 * Bounded: every child has a timeout, no case starts after --minutes, and a
 * file named STOP in <out> stops it before the next case.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { KNOBS } = require('../src/biome/knobs');
const { listTemplates, loadTemplate, resolveZones, checkConstraints } = require('../src/rmg/template');
const { xorshift } = require('../src/wfc/solver');

const ROOT = path.join(__dirname, '..');
const TOOLS = path.join(ROOT, '..', '! LLM Files', 'Tools');
const CLI = path.join(ROOT, 'src', 'main', 'generate-cli.js');
const SIZE_STOPS = [36, 72, 108, 144, 180, 216, 252];

const arg = (name, dflt) => {
	const i = process.argv.indexOf('--' + name);
	return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
};
const OUT = path.resolve(arg('out', path.join(ROOT, 'out', 'opus', 'fuzz')));
const CASES = +arg('cases', 60);
const SEED = +arg('seed', 1);
const JOBS = Math.max(1, +arg('jobs', 3));
const MAXSIZE = +arg('maxsize', 144);
const GEN_TIMEOUT = +arg('gen-timeout', 240) * 1000;
const DEADLINE = Date.now() + (+arg('minutes', 60)) * 60000;
const TEMPLATE_SHARE = +arg('template-share', 0.35);
fs.mkdirSync(OUT, { recursive: true });
const STOP = path.join(OUT, 'STOP');

const rng = xorshift(SEED);
const pick = a => a[(rng() * a.length) | 0];
const snap = (k, v) => {
	const step = k.step || 1;
	const n = Math.round((v - k.min) / step);
	return +(k.min + n * step).toFixed(6);
};
const leverValue = k => {
	if (k.stops) return pick(k.stops)[0];
	const r = rng();
	if (r < 1 / 6) return k.min;
	if (r < 1 / 3) return k.max;
	return snap(k, k.min + rng() * (k.max - k.min));
};

// templates the tab's picker would offer for these settings
const templateCache = new Map();
const rawOf = name => {
	if (!templateCache.has(name)) {
		try {
			const raw = loadTemplate(name).raw;
			templateCache.set(name, { raw, zones: resolveZones(raw) });
		} catch (e) { templateCache.set(name, null); }
	}
	return templateCache.get(name);
};
const TEMPLATES = listTemplates();
const fittingTemplate = req => {
	const order = TEMPLATES.slice();
	for (let i = order.length - 1; i > 0; i--) { const j = (rng() * (i + 1)) | 0; [order[i], order[j]] = [order[j], order[i]]; }
	for (const name of order.slice(0, 80)) {
		const t = rawOf(name);
		if (!t) continue;
		const { violations } = checkConstraints(t.raw, t.zones, req, null);
		if (!violations.length) return name;
	}
	return null;
};

function withArgs(c) {
	const file = path.join(OUT, `case_${String(c.n).padStart(3, '0')}.vmap`);
	const args = ['--w', String(c.size), '--h', String(c.size), '--players', String(c.players),
		'--humans', String(c.humans), '--seed', String(c.seed), '--out', file];
	if (c.underground) args.push('--underground', '1');
	if (c.template) args.push('--template', c.template);
	args.push('--preset', 'nostalgia');
	for (const [key, v] of Object.entries(c.levers))
		args.push(key === 'rivers' ? '--rivers' : '--bio.' + key, String(v));
	return { ...c, args, file };
}

function makeCase(n) {
	const sizes = SIZE_STOPS.filter(s => s <= MAXSIZE);
	// the big sizes are slow; the small ones are where crowding bugs live
	const size = rng() < 0.6 ? pick(sizes.slice(0, 2)) : pick(sizes);
	const players = 2 + ((rng() * 7) | 0);
	const humans = 1 + ((rng() * players) | 0);
	const underground = rng() < 0.3;
	const seed = 1 + ((rng() * 99999) | 0);
	let template = null;
	if (rng() < TEMPLATE_SHARE)
		template = fittingTemplate({ w: size, h: size, levels: underground ? 2 : 1, players, humans });
	const levers = {};
	const touch = rng() < 0.5 ? KNOBS.filter(() => rng() < 0.12) : KNOBS;
	for (const k of touch) levers[k.key] = leverValue(k);
	return withArgs({ n, size, players, humans, underground, seed, template, levers });
}

// --rerun <cases.jsonl> [--only 10,12]: the same cases again after a fix,
// every one that did not come out ok unless --only names them
function rerunCases() {
	const only = arg('only', '') ? new Set(arg('only').split(',').map(Number)) : null;
	return fs.readFileSync(arg('rerun'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
		.filter(r => only ? only.has(r.n) : r.outcome !== 'ok')
		.sort((a, b) => a.n - b.n)
		.map(r => withArgs({ n: r.n, size: r.size, players: r.players, humans: r.humans,
			underground: r.underground, seed: r.seed, template: r.template, levers: r.levers }));
}

const run = (cmd, args, timeout) => new Promise(resolve => {
	const t0 = Date.now();
	execFile(cmd, args, { cwd: ROOT, timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
		(err, stdout, stderr) => resolve({
			code: err ? (err.killed ? 'TIMEOUT' : (err.code ?? 1)) : 0,
			stdout: String(stdout || ''), stderr: String(stderr || ''), ms: Date.now() - t0,
		}));
});

async function validate(file) {
	const v = {};
	const val = await run('node', [path.join(TOOLS, 'vmap_validate.js'), file], 120000);
	const m = val.stdout.match(/(\d+) errors?, (\d+) warnings?/);
	v.validate = m ? { errors: +m[1], warnings: +m[2] } : { errors: -1, raw: val.stdout.slice(-300) };
	const eng = await run('node', [path.join(TOOLS, 'vmap_engine_check.js'), file], 120000);
	v.engine = /the engine would accept this/.test(eng.stdout) ? 'accept' : eng.stdout.slice(-400);
	const ov = await run('node', [path.join(TOOLS, 'vmap_overlap.js'), file], 120000);
	const c = ov.stdout.match(/collisions=(\d+)/);
	v.collisions = c ? +c[1] : -1;
	const reach = await run('py', [path.join(TOOLS, 'check_reach.py'), file], 180000);
	v.pairFails = (reach.stdout.match(/^\s+FAIL /gm) || []).length;
	const un = reach.stdout.match(/none, all (\d+) of them are reachable/);
	v.unreachable = un ? 0 : ((reach.stdout.split('can never touch:')[1] || '').split('\n').filter(l => /^\s{4}\S/.test(l)).length || -1);
	v.ok = v.validate.errors === 0 && v.engine === 'accept' && v.collisions === 0
		&& v.pairFails === 0 && v.unreachable === 0;
	return v;
}

async function doCase(c) {
	const gen = await run('node', [CLI, ...c.args], GEN_TIMEOUT);
	const errLine = (gen.stderr.match(/^Error: .*$/m) || [null])[0];
	const stack = /\n\s+at .+\(.+:\d+:\d+\)/.test(gen.stderr) && !errLine;
	const rec = { n: c.n, size: c.size, players: c.players, humans: c.humans,
		underground: c.underground, template: c.template, seed: c.seed,
		levers: c.levers, genMs: gen.ms, cmd: 'node src/main/generate-cli.js ' + c.args.map(a => /\s/.test(a) ? `"${a}"` : a).join(' ') };
	// the repair passes' own reports, kept even when the map comes out ok
	const repairs = gen.stderr.split(/\r?\n/)
		.filter(l => /dug \d+ sealed|that sealed part of the level|no cell for starter|could not/.test(l))
		.map(l => l.replace(/^\[gen\] /, '')).slice(0, 12);
	if (repairs.length) rec.repairs = repairs;
	if (gen.code === 'TIMEOUT') rec.outcome = 'timeout';
	else if (gen.code !== 0) {
		rec.outcome = errLine && !stack ? 'refused' : 'crash';
		rec.error = errLine || gen.stderr.slice(-800);
	} else if (!fs.existsSync(c.file)) {
		rec.outcome = 'crash';
		rec.error = 'exit 0 but no map written: ' + gen.stderr.slice(-400);
	} else {
		rec.validators = await validate(c.file);
		rec.outcome = rec.validators.ok ? 'ok' : 'invalid';
		if (rec.outcome === 'ok') fs.rmSync(c.file, { force: true });   // keep only the failures
	}
	if (rec.outcome !== 'ok') fs.writeFileSync(c.file.replace(/\.vmap$/, '.log'), gen.stderr);
	fs.appendFileSync(path.join(OUT, 'cases.jsonl'), JSON.stringify(rec) + '\n');
	console.log(`${String(c.n).padStart(3)} ${rec.outcome.padEnd(8)} ${c.size}x${c.size} p${c.players}h${c.humans}`
		+ `${c.underground ? ' u' : ''}${c.template ? ' [' + c.template + ']' : ''} levers ${Object.keys(c.levers).length}`
		+ ` ${(gen.ms / 1000).toFixed(0)}s${rec.error ? '  ' + rec.error.split('\n')[0].slice(0, 110) : ''}`);
	return rec;
}

async function main() {
	const cases = arg('rerun') ? rerunCases() : Array.from({ length: CASES }, (_, i) => makeCase(i + 1));
	const results = [];
	let next = 0;
	const worker = async () => {
		while (next < cases.length) {
			if (fs.existsSync(STOP) || Date.now() > DEADLINE) return;
			const c = cases[next++];
			results.push(await doCase(c));
		}
	};
	await Promise.all(Array.from({ length: JOBS }, worker));
	const count = {};
	for (const r of results) count[r.outcome] = (count[r.outcome] || 0) + 1;
	const lines = [(arg('rerun') ? `rerun of ${arg('rerun')}` : `fuzz seed ${SEED}`)
		+ `: ${results.length} of ${cases.length} cases run`,
		Object.entries(count).map(([k, v]) => `${k} ${v}`).join(', '), ''];
	for (const r of results.filter(x => x.outcome !== 'ok').sort((a, b) => a.n - b.n)) {
		const why = r.error || (r.validators ? JSON.stringify(r.validators)
			: `no map after ${(r.genMs / 1000).toFixed(0)}s`);
		lines.push(`case ${r.n} ${r.outcome}: ${why.split('\n')[0].slice(0, 240)}`, `  ${r.cmd}`);
	}
	fs.writeFileSync(path.join(OUT, 'summary.txt'), lines.join('\n') + '\n');
	console.log(lines.slice(0, 2).join('\n'));
}

main().catch(e => { console.error(e); process.exit(1); });
