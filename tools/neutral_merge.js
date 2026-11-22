'use strict';
/**
 * neutral_merge.js - writes the lines tools/neutral_measure.js printed into mod/template-info.json (S386): templates.<name>.neutral = { "<side>": { "<players>": {...} } }.
 *   node tools/neutral_merge.js lines1.jsonl lines2.jsonl ...      a line that is not JSON (a log header) or has an error is skipped and counted
 * The file keeps its tabs and its CRLF or LF line ends: only the neutral blocks change.
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'mod', 'template-info.json');
const raw = fs.readFileSync(FILE, 'utf8');
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
const j = JSON.parse(raw);
let added = 0, skipped = 0;
const blocks = {};
for (const f of process.argv.slice(2))
	for (const l of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
		if (!l.startsWith('{')) continue;
		let m; try { m = JSON.parse(l); } catch { skipped++; continue; }
		if (m.error || !m.template || m.zoneCells === null || m.zoneCells === undefined) { skipped++; continue; }
		const b = (blocks[m.template] = blocks[m.template] || {});
		((b[String(m.size)] = b[String(m.size)] || {})[String(m.players)]) = { zoneCells: m.zoneCells, startZoneShare: m.startZoneShare, zoneCap: m.zoneCap };
		added++;
	}
for (const [name, b] of Object.entries(blocks)) {
	if (!j.templates[name]) { console.error('no template named ' + name + ' in template-info.json'); continue; }
	const sorted = {};
	for (const s of Object.keys(b).sort((x, y) => x - y)) { sorted[s] = {}; for (const p of Object.keys(b[s]).sort((x, y) => x - y)) sorted[s][p] = b[s][p]; }
	j.templates[name].neutral = sorted;
}
fs.writeFileSync(FILE, JSON.stringify(j, null, '\t').replace(/\n/g, eol) + (raw.endsWith('\n') ? '' : ''));
console.log(`merged ${added} measurements for ${Object.keys(blocks).length} templates, skipped ${skipped}`);
