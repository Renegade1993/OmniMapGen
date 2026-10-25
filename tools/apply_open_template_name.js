// Writes the open layout's list name from mod/open-template-name.json into mod/approved-templates.json and mod/template-info.json (the entry's key, and every mention of
// the old name in the entries' texts). node tools/apply_open_template_name.js [--check]   --check only says whether the files already agree (exit 1 when not).
'use strict';
const fs = require('fs'), path = require('path');
const MOD = path.join(__dirname, '..', 'mod');
const name = JSON.parse(fs.readFileSync(path.join(MOD, 'open-template-name.json'), 'utf8')).name;
if (!name || typeof name !== 'string' || /["\\\n]/.test(name)) { console.error('open-template-name.json: "name" must be a plain one-line string'); process.exit(2); }
const infoPath = path.join(MOD, 'template-info.json'), apprPath = path.join(MOD, 'approved-templates.json');
const info = JSON.parse(fs.readFileSync(infoPath, 'utf8')).templates;
const old = Object.keys(info).find(k => info[k].openLayout === true);
if (!old) { console.error('template-info.json has no open layout entry'); process.exit(2); }
if (old === name) { console.log(`already "${name}"`); process.exit(0); }
if (process.argv.includes('--check')) { console.log(`template-info.json names the open layout "${old}", open-template-name.json says "${name}"`); process.exit(1); }
for (const p of [infoPath, apprPath]) {
	const t = fs.readFileSync(p, 'utf8');
	fs.writeFileSync(p, t.split(old).join(name));
	console.log(`${path.basename(p)}: ${t.split(old).length - 1} mention(s) of "${old}" now "${name}"`);
}
