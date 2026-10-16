#!/usr/bin/env node
/**
 * docdrift.js - the lane documents' code references against the current source (K, 2026-10-14: "the mapgen document is a living
 * document ... it should also receive updates (carefully, emphatically)"; the lead: a drift check in every release check).
 *
 *   node tools/docdrift.js DOC.md... [--root .]
 *
 * Finds every reference of the forms `src/x/y.js:123`, `src/x/y.js:123-130`, `y.js:123` (resolved under src/, tools/ and test/ when the
 * name is unique) and `y.js 123-130` inside the documents, and the bare `:123` references that follow one in the same line (`generate-cli.js`
 * parses the options (template :95, size :164)). Each one is stale when its file is missing (a bare name found nowhere included: the Opus
 * Reviewer, pass 56, probed gone.js:12 and plan.js:9999 and both passed) or its line lies past the file's end. In a table row whose first
 * cell names a lever (LEVERS-WIRING.md only), every cited line or range must also contain that name, so a reference that drifted
 * onto other code is caught, not only one that fell off the end. Exit 1 when any reference is stale; the release report quotes the count.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const ri = args.indexOf('--root');
const root = path.resolve(ri >= 0 ? args[ri + 1] : path.join(__dirname, '..'));
const docs = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1] === '--root'));

const files = new Map();
const walk = d => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); } else if (/\.(js|json|cpp|h|py)$/.test(e.name)) { const k = e.name; if (!files.has(k)) files.set(k, []); files.get(k).push(p); } } };
walk(path.join(root, 'src')); walk(path.join(root, 'tools')); walk(path.join(root, 'test'));
const text = new Map();
const linesOf = p => { if (!text.has(p)) text.set(p, fs.readFileSync(p, 'utf8').split(/\r?\n/)); return text.get(p); };

const RE = /((?:src|tools|test)\/[\w./-]+\.(?:js|json|py)|\b[\w-]+\.(?:js|json|py))(?::| )(\d+)(?:-(\d+))?/g;
const BARE = /(^|[\s(,])(:(\d+)(?:-(\d+))?)\b/g;
let checked = 0, stale = 0;
for (const doc of docs) {
	const lines = fs.readFileSync(doc, 'utf8').split(/\r?\n/);
	lines.forEach((l, i) => {
		// a lever table row (LEVERS-WIRING.md only: other tables open with plain words, "Lakes"): its first cell, the lever's key
		const row = /LEVERS-WIRING/i.test(path.basename(doc)) && /read\(s\)/.test(l) ? /^\|\s*`?([A-Za-z]\w*)`?\s*\|/.exec(l) : null;
		const lever = row ? row[1] : null;
		const refs = [];
		for (const m of l.matchAll(RE)) refs.push({ ref: m[1], a: Number(m[2]), b: Number(m[3] || m[2]), at: m.index, what: m[0] });
		// bare ":N" after a full reference belong to the nearest reference before them in the line
		for (const m of l.matchAll(BARE)) {
			const at = m.index + m[1].length;
			if (refs.some(r => at >= r.at && at < r.at + r.what.length)) continue;
			const before = refs.filter(r => !r.bare && r.at < at).pop();
			if (before) refs.push({ ref: before.ref, a: Number(m[3]), b: Number(m[4] || m[3]), at, what: `${before.ref}${m[2]}`, bare: true });
		}
		for (const r of refs) {
			let target = null;
			if (r.ref.includes('/')) { const p = path.join(root, r.ref); if (fs.existsSync(p)) target = p; }
			else { const c = files.get(r.ref) || []; if (c.length === 1) target = c[0]; else if (c.length > 1) continue; }
			checked++;
			if (!target) { report(doc, i, r.what, 'no such file'); continue; }
			const src = linesOf(target);
			if (r.b > src.length) { report(doc, i, r.what, `line ${r.b} past the end (${src.length} lines)`); continue; }
			if (lever && !r.bare && !src.slice(r.a - 1, r.b).some(s => s.includes(lever))) report(doc, i, r.what, `line ${r.a}${r.b !== r.a ? '-' + r.b : ''} does not name ${lever}`);
		}
	});
}
function report(doc, i, what, why) { stale++; console.log(`${path.basename(doc)}:${i + 1}: ${what}: ${why}`); }
console.log(`docdrift: ${checked} reference(s) checked against ${root}, ${stale} stale`);
process.exit(stale ? 1 : 0);
