'use strict';
// Every file under tools/harness and tools/mapsight must parse and carry no merge-conflict marker.
// The 2026-10-11 push of mapgen-harness held two "<<<<<<< ours" blocks in playtest_checks.js (comment lines only) and nothing noticed,
// because the harness tests load grid_extra.js directly and never playtest_checks.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
function walk(dir, out) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) walk(p, out); else if (/\.js$/.test(e.name)) out.push(p);
	}
	return out;
}

test('harness and mapsight files parse and hold no conflict marker', () => {
	const files = [...walk(path.join(ROOT, 'tools', 'harness'), []), ...walk(path.join(ROOT, 'tools', 'mapsight'), [])];
	assert.ok(files.length > 10);
	const bad = [];
	for (const f of files) {
		const text = fs.readFileSync(f, 'utf8');
		if (/^(<<<<<<<|>>>>>>>) /m.test(text)) { bad.push(`${path.relative(ROOT, f)}: conflict marker`); continue; }
		const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
		if (r.status !== 0) bad.push(`${path.relative(ROOT, f)}: ${String(r.stderr).split('\n').slice(0, 3).join(' ')}`);
	}
	assert.deepStrictEqual(bad, []);
});
