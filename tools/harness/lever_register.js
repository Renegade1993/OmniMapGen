'use strict';
/**
 * lever_register.js - the register of every lever the generator and the Coldshadow templates read (K 2026-10-11 16:10: "every one of those levers has a
 * verified, measured effect ... minimally playable ... identifying gaps in the coldshadow template set"). Built from the code, never typed:
 *
 *   node tools/harness/lever_register.js [--tip DIR] [--out DIR]
 *
 * Writes lever_register.json (machine readable, read by lever_test.js) and LEVER-REGISTER.md (one table a person reads) into --out.
 * Sources: src/biome/knobs.js (the in-game levers: key, page, label, range, step, stops, help), src/biome/biomes.js (BIOME_DEFAULTS), src/biome/presets.json,
 * the KNOWN list of src/main/generate-cli.js (the generator's own flags), mod/template-info.json and mod/approved-templates.json (the templates).
 * "Read in" is the count of source files other than the definition files that mention the key: 0 means no code reads it (a dead lever, flagged).
 */
const fs = require('fs'), path = require('path');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const TIP = path.resolve(arg('--tip', path.join(__dirname, '..', '..')));
const OUT = path.resolve(arg('--out', path.join(TIP, '.tmp', 'lever_register')));
fs.mkdirSync(OUT, { recursive: true });

const { KNOBS, PAGES } = require(path.join(TIP, 'src/biome/knobs'));
const { BIOME_DEFAULTS } = require(path.join(TIP, 'src/biome/biomes'));
const PRESETS = require(path.join(TIP, 'src/biome/presets.json'));

// every .js under src, read once
const files = [];
(function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/\.js$/.test(f.name)) files.push(p); } })(path.join(TIP, 'src'));
const text = new Map(files.map(f => [f, fs.readFileSync(f, 'utf8')]));
const readers = key => {
	const re = new RegExp('\\b' + key + '\\b');
	const hit = [];
	// biomes.js holds the defaults table as well as code: there only a property read (p.key, biomes.key, x['key']) counts
	const prop = new RegExp('\\.' + key + '\\b|\\[[\'"]' + key + '[\'"]\\]');
	for (const [f, t] of text) {
		const base = path.basename(f);
		if (base === 'knobs.js') continue;
		if (base === 'biomes.js' ? !prop.test(t) : !re.test(t)) continue;
		hit.push(path.relative(path.join(TIP, 'src'), f).replace(/\\/g, '/'));
	}
	return hit;
};

const knobs = KNOBS.map(k => {
	const def = k.default !== undefined ? k.default : BIOME_DEFAULTS[k.key];
	const rd = readers(k.key);
	return { key: k.key, page: k.page, label: k.label, min: k.min, max: k.max, step: k.step, default: def, unit: k.unit || null, stops: k.stops || null, cli: !!k.cli, help: k.help, readIn: rd, readCount: rd.length, dead: rd.length === 0 && !k.cli };
});

// the generator's own flags
const cliSrc = fs.readFileSync(path.join(TIP, 'src/main/generate-cli.js'), 'utf8');
const known = (cliSrc.match(/const KNOWN = new Set\(\[([\s\S]*?)\]\)/) || [, ''])[1].match(/'([^']+)'/g).map(s => s.slice(1, -1));
const MAINTXT = [...text].filter(([f]) => /src[\\/]main[\\/]/.test(f)).map(([, t]) => t).join('\n');
const cli = known.map(n => ({ flag: '--' + n, uses: (MAINTXT.match(new RegExp('opt\\.' + n + '\\b|opt\\[[\'"]' + n + '[\'"]\\]', 'g')) || []).length }));

const presets = Object.entries(PRESETS).filter(([k]) => !k.startsWith('_')).map(([k, v]) => ({ id: k, label: v.label, changes: Object.keys(v.values || {}).length, values: v.values || {} }));

let templates = [];
try {
	const info = JSON.parse(fs.readFileSync(path.join(TIP, 'mod/template-info.json'), 'utf8')).templates || {};
	const appr = JSON.parse(fs.readFileSync(path.join(TIP, 'mod/approved-templates.json'), 'utf8')).approved || {};
	templates = Object.keys(appr).map(n => ({ name: n, approved: appr[n], ...(info[n] || {}) }));
} catch (e) { templates = [{ error: e.message }]; }

const reg = { tip: path.basename(TIP), built: new Date().toLocaleDateString('en-CA'), pages: PAGES, knobs, cli, presets, templates };
fs.writeFileSync(path.join(OUT, 'lever_register.json'), JSON.stringify(reg, null, 1));

const md = [];
md.push(`# Lever register (built from the code of ${reg.tip}, ${reg.built})`, '');
md.push('Built by tools/harness/lever_register.js; rebuild it on every tip. Every row is a lever a player can move in the game or the generator reads as a flag; "read in" counts source files outside knobs.js and biomes.js that mention the key (0 = no code reads it).', '');
md.push(`${knobs.length} in-game levers on ${PAGES.length} pages, ${knobs.filter(k => k.dead).length} with no reader, ${cli.length} generator flags, ${presets.length} preset(s), ${templates.length} approved template(s).`, '');
for (const pg of PAGES.concat([{ id: 'map', label: 'Map' }])) {
	const rows = knobs.filter(k => k.page === pg.id); if (!rows.length) continue;
	md.push(`## Page: ${pg.label} (${pg.id})`, '', '| key | label | min | max | step | default | stops | read in | what it is for |', '|---|---|---|---|---|---|---|---|---|');
	for (const k of rows) md.push(`| ${k.key}${k.cli ? ' (flag)' : ''} | ${k.label} | ${k.min} | ${k.max} | ${k.step} | ${k.default} | ${k.stops ? k.stops.map(s => (s.value !== undefined ? s.value : s[0]) + '=' + (s.label || s[1])).join('; ') : ''} | ${k.readCount}${k.dead ? ' DEAD' : ''} | ${String(k.help || '').replace(/\|/g, '/').replace(/\s+/g, ' ')} |`);
	md.push('');
}
md.push('## Generator flags (src/main/generate-cli.js)', '', '| flag | reads of opt.<name> in src/main |', '|---|---|');
for (const c of cli) md.push(`| ${c.flag} | ${c.uses} |`);
md.push('', '## Presets', '', '| id | label | levers changed from the defaults |', '|---|---|---|');
for (const p of presets) md.push(`| ${p.id} | ${p.label} | ${p.changes} |`);
md.push('', '## Approved templates (mod/approved-templates.json with mod/template-info.json)', '', '| template | original size | players | levels | underground |', '|---|---|---|---|---|');
for (const t of templates) md.push(`| ${t.name || t.error} | ${t.originalSizeMin || '?'}-${t.originalSizeMax || '?'} | ${t.playersMin || '?'}-${t.playersMax || '?'} | ${t.originalLevels || '?'} | ${t.underground === undefined ? '?' : t.underground} |`);
fs.writeFileSync(path.join(OUT, 'LEVER-REGISTER.md'), md.join('\n') + '\n');
console.log(`register: ${knobs.length} levers (${knobs.filter(k => k.dead).length} dead), ${cli.length} flags, ${templates.length} templates -> ${OUT}`);
