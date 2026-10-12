'use strict';
/**
 * template_gap.js - the template gap finder (K 2026-10-11 16:10: "identifying gaps in the coldshadow template set, for any given set of settings").
 *
 *   node tools/harness/template_gap.js --tip DIR --out DIR [--sizes 36,72,108,144,216] [--players 2,4,8] [--levels 1,2] [--water 0,0.3] [--lanes 3] [--deadline-min 40] [--eval]
 *   node tools/harness/template_gap.js --tip DIR --ask "w=90,players=5,underground=1,bio.waterCoverage=0.3"     one given set of settings, answered from the table
 *
 * For every template the install approves (mod/approved-templates.json, facts in mod/template-info.json) and every configuration of the grid, the template is generated
 * the way the game does and read back: the generator's own log says how much of the template's zone layout survived ("zone layout X of Y kept, Z of W template links
 * without a shared border", "template link A-B has no shared border; bridged with a portal pair") and the map goes through mapsight's hard checks. A cell is
 *   fits       the template's own ranges cover the settings (size, players, levels) and the layout kept at least 75% of its zones with at most a quarter of its links bridged,
 *   stretched  the settings lie outside the template's original ranges, or half or more of the links needed a portal, but the hard checks pass,
 *   gap        the hard checks fail or the map is not written: no approved template plays these settings.
 * Template ranges come from template-info.json; what lies outside them is the gap list: sizes, player counts, levels, water that no template covers by its own design.
 */
const fs = require('fs'), path = require('path');
const { execFile } = require('child_process');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const has = n => process.argv.includes(n);
// a VMAPGEN_* switch set in the shell would change what the generator makes (297 are read in src): the children run without them, and the run says which it found
const STRIPPED = Object.keys(process.env).filter(k => /^VMAPGEN_/.test(k) && k !== 'VMAPGEN_TEST_ROOT');
console.log('environment: ' + (STRIPPED.length ? 'VMAPGEN_* found and removed from the generator runs: ' + STRIPPED.join(', ') : 'no VMAPGEN_* switch set'));
const TIP = path.resolve(arg('--tip', path.join(__dirname, '..', '..')));
const OUT = path.resolve(arg('--out', path.join(TIP, '.tmp', 'template_gap')));
const LANES = +arg('--lanes', 3), DEADLINE = Date.now() + 60000 * +arg('--deadline-min', 40);
const ROOT = process.env.VMAPGEN_TEST_ROOT || 'C:/AI Projects/Heroes 3/VCMI/dmbtest';
const K_USER = process.env.DMB_USER_DIR || path.join(require('os').homedir(), 'Documents', 'My Games', "Dead Man's Boots");
const NODE_MODULES = process.env.NODE_PATH || 'C:/AI Projects/Heroes 3/VCMIMapGen/node_modules';
process.env.VCMI_ROOT = process.env.VCMI_ROOT || ROOT;
const sizes = arg('--sizes', '36,72,108,144,216').split(',').map(Number), plist = arg('--players', '2,4,8').split(',').map(Number), levels = arg('--levels', '1,2').split(',').map(Number);
const waters = arg('--water', '0,0.3').split(',').map(Number);

const info = JSON.parse(fs.readFileSync(path.join(TIP, 'mod/template-info.json'), 'utf8')).templates || {};
const approved = Object.keys(JSON.parse(fs.readFileSync(path.join(TIP, 'mod/approved-templates.json'), 'utf8')).approved || {});
const coverage = (t, c) => {
	const i = info[t] || {}, why = [];
	if (i.originalSizeMin && (c.size < i.originalSizeMin || c.size > i.originalSizeMax)) why.push(`size ${c.size} outside the original ${i.originalSizeMin}-${i.originalSizeMax}`);
	if (i.playersMin && (c.players < i.playersMin || c.players > i.playersMax)) why.push(`${c.players} players outside ${i.playersMin}-${i.playersMax}`);
	if (i.originalLevels === 2 && c.levels === 1) why.push('one level (the original has two)');
	if (i.originalLevels === 1 && c.levels === 2) why.push('two levels (the original has one)');
	if (c.water > 0) why.push('water (no template zone is water)');
	return why;
};

const cells = [];
for (const t of approved) for (const size of sizes) for (const players of plist) for (const lv of levels) for (const water of waters) cells.push({ t, size, players, levels: lv, water, id: `${t.replace(/\W+/g, '_')}_${size}p${players}L${lv}w${water}` });

function optOf(c) {
	const o = { w: c.size, h: c.size, players: c.players, humans: 1, seed: '1', template: c.t };
	if (c.levels === 2) o.underground = 1;
	if (c.water > 0) { o['bio.waterCoverage'] = c.water; o['bio.waterContent'] = 1; o['bio.waterShape'] = 3; }
	return o;
}
function generate(c, file) {
	const o = { ...optOf(c), out: file, vcmiroot: ROOT, vcmiuserdir: K_USER };
	const a = [path.join(TIP, 'src', 'main', 'generate-cli.js')];
	for (const [k, v] of Object.entries(o)) a.push('--' + k, String(v));
	const env = { ...process.env, VCMI_ROOT: ROOT, NODE_PATH: NODE_MODULES }; delete env.NODE_OPTIONS;
	for (const k of STRIPPED) delete env[k];
	return new Promise(r => execFile(process.execPath, a, { env, cwd: TIP, timeout: 600000, windowsHide: true, maxBuffer: 1 << 26 },
		(err, so, se) => { fs.writeFileSync(file + '.log', `${so || ''}${se || ''}`); r(fs.existsSync(file) ? null : (err ? err.message.slice(0, 200) : 'no map written')); }));
}
function readLog(file) {
	let t = ''; try { t = fs.readFileSync(file + '.log', 'utf8'); } catch (e) { /* none */ }
	let kept = 0, of = 0, noShare = 0, links = 0, bridged = 0;
	for (const m of t.matchAll(/zone layout (\d+) of (\d+) kept, (\d+) of (\d+) template links without a shared border/g)) { kept += +m[1]; of += +m[2]; noShare += +m[3]; links += +m[4]; }
	bridged = (t.match(/bridged with a portal pair/g) || []).length;
	const acc = (t.match(/accommodat[^\n]*/i) || [''])[0].slice(0, 120);
	return { kept, of, noShare, links, bridged, acc };
}

function evaluate(c, file) {
	const cov = coverage(c.t, c);
	if (!fs.existsSync(file)) return { ...c, verdict: 'gap', why: ['not generated'], cov, log: readLog(file) };
	const lg = readLog(file);
	let fails = [];
	try { process.env.VCMI_ROOT = ROOT; fails = require('../mapsight/lib/check').checkMap(file).fails; } catch (e) { fails = ['check did not run: ' + String(e.message).slice(0, 80)]; }
	let verdict;
	const keptShare = lg.of ? lg.kept / lg.of : null, bridgedShare = lg.links ? lg.bridged / lg.links : 0;
	if (fails.length) verdict = 'gap';
	else if (cov.length || (keptShare !== null && keptShare < 0.75) || bridgedShare > 0.25) verdict = 'stretched';
	else verdict = 'fits';
	return { ...c, verdict, why: [...fails, ...cov], cov, log: lg, keptShare, bridgedShare };
}

(async () => {
	fs.mkdirSync(path.join(OUT, 'maps'), { recursive: true });
	const resFile = path.join(OUT, 'gap_results.json');
	const prior = fs.existsSync(resFile) ? JSON.parse(fs.readFileSync(resFile, 'utf8')) : [];
	const done = new Map(prior.map(r => [r.id, r]));
	const ask = arg('--ask');
	if (!has('--eval') && !ask) {
		const todo = cells.filter(c => !done.has(c.id)); let next = 0;
		console.log(`gap grid: ${cells.length} cells (${approved.length} template(s) x ${sizes.length} sizes x ${plist.length} player counts x ${levels.length} levels x ${waters.length} water), ${todo.length} to run, ${LANES} lanes`);
		await Promise.all(Array.from({ length: LANES }, async () => {
			while (next < todo.length && Date.now() < DEADLINE && !fs.existsSync(path.join(OUT, 'STOP'))) {
				const c = todo[next++], file = path.join(OUT, 'maps', c.id + '.vmap');
				if (!fs.existsSync(file)) await generate(c, file);
				done.set(c.id, evaluate(c, file));
				if (done.size % 10 === 0) fs.writeFileSync(resFile, JSON.stringify([...done.values()], null, 1));
			}
		}));
		fs.writeFileSync(resFile, JSON.stringify([...done.values()], null, 1));
	}
	const res = cells.map(c => done.get(c.id)).filter(Boolean);
	const md = [`# Template gap finder (tip ${path.basename(TIP)}, ${new Date().toLocaleDateString('en-CA')})`, '',
		`Approved templates: ${approved.join(', ')}. ${res.length} of ${cells.length} cells measured. fits = inside the template's own ranges and the layout survived; stretched = outside its ranges or half-broken layout, hard checks pass; gap = hard checks fail or no map.`, ''];
	const counts = {}; for (const r of res) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
	md.push(`Cells: ${Object.entries(counts).map(([k, v]) => k + ' ' + v).join(', ')}`, '');
	for (const t of approved) {
		const i = info[t] || {};
		md.push(`## ${t}`, '', `Original: size ${i.originalSizeMin}-${i.originalSizeMax}, players ${i.playersMin}-${i.playersMax}, levels ${i.originalLevels}, ${i.zones} zones (${JSON.stringify(i.zonesByKind || {})}).`, '');
		for (const lv of levels) for (const water of waters) {
			md.push(`### ${lv} level${lv > 1 ? 's' : ''}, water ${water}`, '', '| size | ' + plist.map(p => p + ' players').join(' | ') + ' |', '|---|' + plist.map(() => '---').join('|') + '|');
			for (const size of sizes) md.push(`| ${size} | ` + plist.map(p => { const r = res.find(x => x.t === t && x.size === size && x.players === p && x.levels === lv && x.water === water); return r ? `${r.verdict}${r.log && r.log.of ? ' (' + r.log.kept + '/' + r.log.of + ' zones, ' + r.log.bridged + ' portals)' : ''}` : ''; }).join(' | ') + ' |');
			md.push('');
		}
	}
	md.push('## Gaps (hard checks fail or no map)', '');
	for (const r of res.filter(x => x.verdict === 'gap')) md.push(`- ${r.id}: ${r.why.join('; ')}`);
	md.push('', '## Settings outside the original template ranges (stretched, not covered by design)', '');
	const seen = new Set(); for (const r of res.filter(x => x.cov.length)) { const k = r.cov.join('; '); if (!seen.has(k)) { seen.add(k); md.push(`- ${k}`); } }
	fs.writeFileSync(path.join(OUT, 'TEMPLATE-GAPS.md'), md.join('\n') + '\n');
	if (ask) { // one given set of settings: the nearest cell(s)
		const o = Object.fromEntries(ask.split(',').map(s => s.split('=')));
		const c = { size: +(o.w || o.size || 72), players: +(o.players || 4), levels: o.underground === '1' || o.levels === '2' ? 2 : 1, water: +(o['bio.waterCoverage'] || o.water || 0) };
		for (const t of approved) console.log(`${t}: ${coverage(t, c).join('; ') || 'inside its ranges'}`);
		const near = res.filter(x => x.levels === c.levels && (x.water > 0) === (c.water > 0)).sort((a, b) => Math.abs(a.size - c.size) + 4 * Math.abs(a.players - c.players) - Math.abs(b.size - c.size) - 4 * Math.abs(b.players - c.players))[0];
		if (near) console.log(`nearest measured cell: ${near.id} -> ${near.verdict} ${near.why.join('; ')}`);
	}
	console.log(`gap table: ${Object.entries(counts).map(([k, v]) => k + ' ' + v).join(', ')} -> ${path.join(OUT, 'TEMPLATE-GAPS.md')}`);
})();
