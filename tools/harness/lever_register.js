'use strict';
/**
 * lever_register.js - the register of every lever the generator and the Coldshadow templates read (K 2026-10-11 16:10: "every one of those levers has a
 * verified, measured effect ... minimally playable ... identifying gaps in the coldshadow template set"). Built from the code, never typed:
 *
 *   node tools/harness/lever_register.js [--tip DIR] [--out DIR]
 *
 * Writes lever_register.json (machine readable) and LEVER-REGISTER.md (the tables a person reads) into --out.
 * Sources: src/biome/knobs.js (the in-game levers: key, page, label, range, step, stops, help), src/biome/biomes.js (BIOME_DEFAULTS), src/biome/presets.json,
 * the KNOWN list of src/main/generate-cli.js (the generator's own flags), mod/template-info.json and mod/approved-templates.json (the templates), the committed
 * widget files in mod/Content/config/widgets/mapGen (compared with knobs.js), and every process.env.VMAPGEN_* read in src (the environment switches).
 * "Read by" lists the places that read a lever: file, line, enclosing function and the line itself, so what each reader does can be read off (Opus Reviewer R8, 10-11:
 * a count of files that mention a key says nothing about what they do with it). 0 readers marks a dead lever.
 */
const fs = require('fs'), path = require('path');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const TIP = path.resolve(arg('--tip', path.join(__dirname, '..', '..')));
const OUT = path.resolve(arg('--out', path.join(TIP, '.tmp', 'lever_register')));
fs.mkdirSync(OUT, { recursive: true });

const { KNOBS, PAGES } = require(path.join(TIP, 'src/biome/knobs'));
const { BIOME_DEFAULTS } = require(path.join(TIP, 'src/biome/biomes'));
const PRESETS = require(path.join(TIP, 'src/biome/presets.json'));

// every .js under src, read once, as lines
const files = [];
(function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/\.js$/.test(f.name)) files.push(p); } })(path.join(TIP, 'src'));
const lines = new Map(files.map(f => [f, fs.readFileSync(f, 'utf8').split('\n')]));
const rel = f => path.relative(path.join(TIP, 'src'), f).replace(/\\/g, '/');
const FN = [/^\s*(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/, /^\s{0,2}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$/];
const enclosing = (ls, i) => { for (let j = i; j >= 0; j--) for (const re of FN) { const m = ls[j].match(re); if (m && !/^(if|for|while|switch|catch|return)$/.test(m[1])) return m[1]; } return '(top level)'; };

// readers of one key: lines that read it (in biomes.js only a property read counts, the defaults table does not)
function readers(key) {
	const word = new RegExp('\\b' + key + '\\b'), prop = new RegExp('\\.' + key + '\\b|\\[[\'"]' + key + '[\'"]\\]');
	const out = [];
	for (const [f, ls] of lines) {
		const base = path.basename(f); if (base === 'knobs.js') continue;
		for (let i = 0; i < ls.length; i++) {
			const l = ls[i], t = l.trim();
			if (/^\s*(\/\/|\*|\/\*)/.test(l)) continue;                     // comments
			if (!(base === 'biomes.js' ? prop.test(l) : word.test(l))) continue;
			if (base === 'biomes.js' && new RegExp('^\\s*' + key + '\\s*:').test(l)) continue;
			out.push({ file: rel(f), line: i + 1, fn: enclosing(ls, i), text: t.slice(0, 150) });
		}
	}
	return out;
}
const knobs = KNOBS.map(k => {
	const def = k.default !== undefined ? k.default : BIOME_DEFAULTS[k.key];
	const rd = readers(k.key);
	const filesRead = [...new Set(rd.map(r => r.file))];
	return { key: k.key, page: k.page, label: k.label, min: k.min, max: k.max, step: k.step, default: def, unit: k.unit || null, stops: k.stops || null, cli: !!k.cli, help: k.help, readers: rd, readFiles: filesRead, dead: rd.length === 0 && !k.cli };
});

// the generator's own flags: read as opt.name, opt['name'], share01('name', ...) or any other quoted use in src/main outside the KNOWN list and the usage text
const cliSrc = fs.readFileSync(path.join(TIP, 'src/main/generate-cli.js'), 'utf8');
const known = (cliSrc.match(/const KNOWN = new Set\(\[([\s\S]*?)\]\)/) || [, ''])[1].match(/'([^']+)'/g).map(s => s.slice(1, -1));
const mainFiles = [...lines].filter(([f]) => /src[\\/]main[\\/]/.test(f));
const cli = known.map(n => {
	const re = new RegExp('opt\\.' + n + '\\b|opt\\[[\'"]' + n + '[\'"]\\]|share01\\([\'"]' + n + '[\'"]|\\b' + n + '\\b\\s*[:=]');
	const hit = [];
	for (const [f, ls] of mainFiles) for (let i = 0; i < ls.length; i++) {
		const l = ls[i]; if (/^\s*(\/\/|\*|\/\*)/.test(l) || /new Set\(\[/.test(l) || /^\s*'[a-z,' ]+',?\s*$/.test(l)) continue;
		if (re.test(l)) hit.push({ file: rel(f), line: i + 1, fn: enclosing(ls, i), text: l.trim().slice(0, 130) });
	}
	return { flag: '--' + n, readers: hit };
});

const presets = Object.entries(PRESETS).filter(([k]) => !k.startsWith('_')).map(([k, v]) => ({ id: k, label: v.label, changes: Object.keys(v.values || {}).length, values: v.values || {} }));

let templates = [];
try {
	const info = JSON.parse(fs.readFileSync(path.join(TIP, 'mod/template-info.json'), 'utf8')).templates || {};
	const appr = JSON.parse(fs.readFileSync(path.join(TIP, 'mod/approved-templates.json'), 'utf8')).approved || {};
	templates = Object.keys(appr).map(n => ({ name: n, approved: appr[n], ...(info[n] || {}) }));
} catch (e) { templates = [{ error: e.message }]; }

// the committed widget files against knobs.js (make_mod.js regenerates them for the installed build; the committed copies can lag)
const ui = [];
{
	const dir = path.join(TIP, 'mod/Content/config/widgets/mapGen');
	const found = new Map();
	const walkJ = o => { if (Array.isArray(o)) o.forEach(walkJ); else if (o && typeof o === 'object') { if (typeof o.setting === 'string' && /mapGen\/params\//.test(o.setting)) found.set(o.setting.split('/').pop(), o); for (const v of Object.values(o)) walkJ(v); } };
	try { for (const f of fs.readdirSync(dir).filter(x => /^page_.*\.json$/.test(x))) walkJ(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch (e) { ui.push({ key: '(widgets)', problem: 'could not read: ' + e.message }); }
	for (const k of knobs) {
		const w = found.get(k.key);
		if (!w) { ui.push({ key: k.key, problem: 'no widget in the committed page files' }); continue; }
		const p = [];
		const wmin = w.valueMin, wstep = w.valueStep, wdef = w.valueDefault;
		if (wmin !== undefined && Math.abs(wmin - k.min) > 1e-9) p.push(`min ${wmin} against ${k.min}`);
		if (wstep !== undefined && k.step !== undefined && Math.abs(wstep - k.step) > 1e-9) p.push(`step ${wstep} against ${k.step}`);
		if (wdef !== undefined && Math.abs(wdef - k.default) > 1e-9 && k.default !== undefined) p.push(`default ${wdef} against ${k.default}`);
		if (Array.isArray(w.valueNames) && k.stops && w.valueNames.length !== k.stops.length) p.push(`${w.valueNames.length} named stops against ${k.stops.length}`);
		if (p.length) ui.push({ key: k.key, problem: p.join('; ') });
	}
}

// the environment switches read in src: a switch set in a shell changes what the generator makes
const sw = new Map();
for (const [f, ls] of lines) for (let i = 0; i < ls.length; i++) {
	const re = /process\.env\.(VMAPGEN_[A-Z0-9_]+)/g; let m;
	while ((m = re.exec(ls[i]))) {
		const e = sw.get(m[1]) || { name: m[1], files: new Set(), n: 0, kill: 0, optIn: 0, other: 0, sample: '' };
		e.files.add(rel(f)); e.n++;
		const l = ls[i].slice(m.index, m.index + 120);
		if (/!==\s*['"]0['"]|===\s*['"]0['"]|!==\s*['"]off['"]|=== ['"]off['"]/.test(l) && /!==/.test(l)) e.kill++;
		else if (/===\s*['"]1['"]|^\s*process\.env\.VMAPGEN_[A-Z0-9_]+\s*(&&|\)|\?|\|\|)/.test(l)) e.optIn++;
		else e.other++;
		if (!e.sample) e.sample = ls[i].trim().slice(0, 140);
		sw.set(m[1], e);
	}
}
const switches = [...sw.values()].map(e => ({ name: e.name, files: [...e.files], reads: e.n, kind: e.kill > e.optIn && e.kill >= e.other ? 'kill switch (on unless set to 0)' : /TRACE|WATCH|LOG|DEBUG|DUMP|PROBE/.test(e.name) ? 'trace or log' : e.optIn >= e.other ? 'opt-in (off unless set)' : 'value', sample: e.sample })).sort((a, b) => a.name.localeCompare(b.name));

const reg = { tip: path.basename(TIP), built: new Date().toLocaleDateString('en-CA'), pages: PAGES, knobs, cli, presets, templates, ui, switches };
fs.writeFileSync(path.join(OUT, 'lever_register.json'), JSON.stringify(reg, null, 1));

const cell = s => String(s === undefined || s === null ? '' : s).replace(/\|/g, '/').replace(/\s+/g, ' ');
const md = [];
md.push(`# Lever register (built from the code of ${reg.tip}, ${reg.built})`, '');
md.push('Built by tools/harness/lever_register.js; rebuild it on every tip. Every row is a lever a player can move in the game or the generator reads as a flag. "Read by" lists where the code reads the lever (file:line in function), up to three places; the json holds all of them. 0 places marks a dead lever.', '');
md.push(`${knobs.length} in-game levers on ${PAGES.length} pages (${knobs.filter(k => k.dead).length} with no reader), ${cli.length} generator flags (${cli.filter(c => !c.readers.length).length} with no reader), ${presets.length} preset(s), ${templates.length} approved template(s), ${switches.length} environment switches, ${ui.length} widget differences against knobs.js.`, '');
for (const pg of PAGES.concat([{ id: 'map', label: 'Map' }])) {
	const rows = knobs.filter(k => k.page === pg.id); if (!rows.length) continue;
	md.push(`## Page: ${pg.label} (${pg.id})`, '', '| key | label | min | max | step | default | stops | readers | read by | what it is for |', '|---|---|---|---|---|---|---|---|---|---|');
	for (const k of rows) {
		const by = []; const seen = new Set();
		for (const r of k.readers) { const id = r.file + ' ' + r.fn; if (seen.has(id)) continue; seen.add(id); by.push(`${r.file}:${r.line} in ${r.fn}`); if (by.length === 3) break; }
		md.push(`| ${k.key}${k.cli ? ' (flag)' : ''} | ${k.label} | ${k.min} | ${k.max} | ${k.step} | ${k.default} | ${k.stops ? k.stops.map(s => (s.value !== undefined ? s.value : s[0]) + '=' + (s.label || s[1])).join('; ') : ''} | ${k.readers.length}${k.dead ? ' DEAD' : ''} | ${cell(by.join('; '))} | ${cell(k.help)} |`);
	}
	md.push('');
}
md.push('## Generator flags (src/main/generate-cli.js)', '', '| flag | reads | read by |', '|---|---|---|');
for (const c of cli) md.push(`| ${c.flag} | ${c.readers.length}${c.readers.length ? '' : ' DEAD'} | ${cell(c.readers.slice(0, 2).map(r => `${r.file}:${r.line} in ${r.fn}: ${r.text}`).join('; '))} |`);
md.push('', '## Presets', '', '| id | label | levers changed from the defaults |', '|---|---|---|');
for (const p of presets) md.push(`| ${p.id} | ${p.label} | ${p.changes} |`);
md.push('', '## Approved templates (mod/approved-templates.json with mod/template-info.json)', '', '| template | original size | players | levels | zones | underground |', '|---|---|---|---|---|---|');
for (const t of templates) md.push(`| ${t.name || t.error} | ${t.originalSizeMin || '?'}-${t.originalSizeMax || '?'} | ${t.playersMin || '?'}-${t.playersMax || '?'} | ${t.originalLevels || '?'} | ${t.zones || '?'} | ${cell(t.underground)} |`);
md.push('', '## Committed widget files against knobs.js', '', `The files in mod/Content/config/widgets/mapGen are written from knobs.js by make_mod.js for the installed build; the committed copies can lag. ${ui.length ? 'Differences found:' : 'No difference found.'}`, '');
if (ui.length) { md.push('| lever | difference |', '|---|---|'); for (const u of ui) md.push(`| ${u.key} | ${cell(u.problem)} |`); }
const kinds = {}; for (const s of switches) kinds[s.kind] = (kinds[s.kind] || 0) + 1;
md.push('', '## Environment switches (process.env.VMAPGEN_* in src)', '', `${switches.length} switches: ${Object.entries(kinds).map(([k, v]) => v + ' ' + k).join(', ')}. A switch set in a shell changes what the generator makes, so every measure runs with these removed from the environment (lever_test.js, playable_gate.js and template_gap.js strip them and print any they find). Kind is read from the first comparison in the code; check the sample line before relying on it.`, '', '| switch | kind | reads | files | first read |', '|---|---|---|---|---|');
for (const s of switches) md.push(`| ${s.name} | ${s.kind} | ${s.reads} | ${cell(s.files.slice(0, 3).join(', '))} | ${cell(s.sample)} |`);
fs.writeFileSync(path.join(OUT, 'LEVER-REGISTER.md'), md.join('\n') + '\n');
console.log(`register: ${knobs.length} levers (${knobs.filter(k => k.dead).length} dead), ${cli.length} flags (${cli.filter(c => !c.readers.length).length} dead), ${templates.length} templates, ${switches.length} switches, ${ui.length} widget differences -> ${OUT}`);
