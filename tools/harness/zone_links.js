'use strict';
/**
 * zone_links.js - K's zone links (2026-10-09: "Zone links: yes, but should respond to lever"; Opus's lever is Bottleneck guard share, bio.chokeGuardRatio):
 * how many of a map's zone links carry a guard, per tip and per lever value, on K's 36x36 case and a 108x108 control.
 *
 *   node tools/harness/zone_links.js --tips NAME=DIR[,NAME=DIR] --out DIR [--ratios default,0,1] [--seeds 3] [--lanes 2] [--deadline-min 25]
 *
 * A link is a pair of zones with at least one passage tile (an open ground tile with an open ground tile of the other zone on one of its four sides); it is
 * guarded when a stack's 3x3 ring covers a passage tile of the pair. The cases are K's recorded options of small-ug and large-p2 (K_REPORTS, as k_cases.js).
 * Every generation is a hidden child process with its own timeout; the run stops at the deadline or when a file STOP appears in --out.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const sight = require('../mapsight/lib/sight');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const REPORTS = process.env.K_REPORTS || 'C:/AI Projects/Heroes 3/.tmp/k-reports';
const ROOT = process.env.VMAPGEN_TEST_ROOT || 'C:/AI Projects/Heroes 3/VCMI/dmbtest';
const K_USER = process.env.DMB_USER_DIR || require('path').join(require('os').homedir(), 'Documents', 'My Games', "Dead Man's Boots");
const NODE_MODULES = 'C:/AI Projects/Heroes 3/VCMIMapGen/node_modules';
const tips = arg('--tips', '').split(',').filter(Boolean).map(s => { const [n, d] = s.split(/=(.*)/s); return { n, d }; });
const OUT = path.resolve(arg('--out', '.tmp/zone_links'));
const RATIOS = arg('--ratios', 'default,0,1').split(',');
const SEEDS = +arg('--seeds', 3), LANES = +arg('--lanes', 2), DEADLINE = Date.now() + 60000 * +arg('--deadline-min', 25);
const CASES = [{ id: 'small-ug', dir: '1006-small-ug' }, { id: 'large-p2', dir: '1006-large-p2-surface', only: 'default' }];

function generate(tip, opt, seed, file) {
	const o = { ...opt, seed: String(seed), out: file, vcmiroot: ROOT, vcmiuserdir: K_USER };
	const a = [path.join(tip.d, 'src', 'main', 'generate-cli.js')];
	for (const [k, v] of Object.entries(o)) a.push('--' + k, String(v));
	const env = { ...process.env, VCMI_ROOT: ROOT, NODE_PATH: process.env.NODE_PATH || NODE_MODULES };
	delete env.NODE_OPTIONS;
	return new Promise(resolve => execFile(process.execPath, a, { env, cwd: tip.d, timeout: 600000, windowsHide: true, maxBuffer: 1 << 26 },
		(err, so, se) => { fs.writeFileSync(file + '.log', `${so || ''}${se || ''}`); resolve(fs.existsSync(file) ? null : (err ? err.message.slice(0, 200) : 'no map written')); }));
}

/** Links of a loaded map and how many a stack's ring covers. */
function links(M) {
	const ring = new Uint8Array(M.NL * M.W * M.H);
	for (const m of M.monsters) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (M.inb(m.at[0] + dx, m.at[1] + dy)) ring[M.idx(m.l, m.at[0] + dx, m.at[1] + dy)] = 1;
	const open = i => M.ground(i) && !M.blocked[i];
	const pairs = new Map();
	for (let l = 0; l < M.NL; l++) for (let y = 0; y < M.H; y++) for (let x = 0; x < M.W; x++) {
		const i = M.idx(l, x, y), z = M.zoneAt(l, x, y);
		if (z === undefined || z === null || z < 0 || !open(i)) continue;
		for (const [dx, dy] of [[1, 0], [0, 1]]) {
			if (!M.inb(x + dx, y + dy)) continue;
			const j = M.idx(l, x + dx, y + dy), z2 = M.zoneAt(l, x + dx, y + dy);
			if (z2 === undefined || z2 === null || z2 < 0 || z2 === z || !open(j)) continue;
			const key = `${l}:${Math.min(z, z2)}-${Math.max(z, z2)}`, p = pairs.get(key) || { tiles: 0, guarded: false };
			p.tiles++; if (ring[i] || ring[j]) p.guarded = true;
			pairs.set(key, p);
		}
	}
	const all = [...pairs.values()];
	return { links: all.length, guarded: all.filter(p => p.guarded).length, width: all.length ? all.reduce((a, p) => a + p.tiles, 0) / all.length : 0 };
}

/** The generator's own count (Opus's log line "doorway guards N of M doorway link(s)", one per level): the link guards themselves, not every stack beside a passage tile. */
function doorway(file) {
	let n = 0, m = 0;
	try { for (const x of fs.readFileSync(file + '.log', 'utf8').matchAll(/doorway guards (\d+) of (\d+)/g)) { n += +x[1]; m += +x[2]; } } catch (e) { /* no log */ }
	return { n, m };
}

(async () => {
	fs.mkdirSync(OUT, { recursive: true });
	const jobs = [];
	for (const c of CASES) {
		const src = fs.readdirSync(path.join(REPORTS, c.dir)).find(f => f.endsWith('.vmap'));
		const opt = JSON.parse(fs.readFileSync(path.join(REPORTS, c.dir, src) + '.zones.json', 'utf8')).options;
		for (const tip of tips) for (const r of RATIOS) {
			if (c.only && c.only !== r) continue;
			for (let s = 0; s < SEEDS; s++) {
				const o = { ...opt }; if (r !== 'default') o['bio.chokeGuardRatio'] = r;
				jobs.push({ c, tip, r, opt: o, seed: +opt.seed + s, file: path.join(OUT, `${tip.n}_${c.id}_${r}_s${+opt.seed + s}.vmap`) });
			}
		}
	}
	let next = 0;
	const rows = [];
	await Promise.all(Array.from({ length: LANES }, async () => {
		while (next < jobs.length && Date.now() < DEADLINE && !fs.existsSync(path.join(OUT, 'STOP'))) {
			const j = jobs[next++], err = await generate(j.tip, j.opt, j.seed, j.file);
			rows.push({ j, err, v: err ? null : { ...links(sight.load(j.file)), door: doorway(j.file) } });
		}
	}));
	console.log('tip        case      ratio    maps  links per map  guarded per map  guarded share  passage width  doorway guards (generator count)');
	const groups = new Map();
	for (const r of rows) { const k = `${r.j.tip.n}|${r.j.c.id}|${r.j.r}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
	for (const [k, g] of [...groups].sort()) {
		const ok = g.filter(x => x.v), [t, c, r] = k.split('|');
		const sum = f => ok.reduce((a, x) => a + f(x.v), 0);
		console.log(`${t.padEnd(10)} ${c.padEnd(9)} ${r.padEnd(8)} ${String(ok.length).padStart(3)}/${g.length}  ${(sum(v => v.links) / Math.max(1, ok.length)).toFixed(1).padStart(12)}  ${(sum(v => v.guarded) / Math.max(1, ok.length)).toFixed(1).padStart(14)}  ${(100 * sum(v => v.guarded) / Math.max(1, sum(v => v.links))).toFixed(0).padStart(11)}%  ${(sum(v => v.width) / Math.max(1, ok.length)).toFixed(1).padStart(8)}  ${sum(v => v.door.n)} of ${sum(v => v.door.m)}`);
	}
	for (const r of rows) if (r.err) console.log(`FAILED ${r.j.file}: ${r.err}`);
})();
